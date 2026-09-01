import {
  findWorkout, putWorkout, getPlan, getDay, putDay, getWeek, putWeek,
  listWorkouts, getExercises, listPlans,
} from '../store.js';
import { sessionFor, sessionsFor, sessionsAround } from '../plan.js';
import { todayISO, weekdayShort, isoWeek, weekDays } from '../lib/dates.js';
import { fmtNum, fmtWeight, fmtDuration, fmtClock, parseNum } from '../lib/format.js';
import { nextSetDefaults, planReps, averageRPE, isControlSet, asksChestSignal, restBetween } from './workout-logic.js';
import { sessionSummary } from '../export.js';
import { etalonBlock } from './etalon.js';
import { stretchList, warmupHint, splitHint, applySplit } from './stretch-block.js';
import { navigate } from '../main.js';

let state = null;      // { workout, index, timer, restLeft, warmup, guide, showPlan }

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

async function historyFor(name, exceptId, upTo = null) {
  const all = await listWorkouts();
  const rows = [];
  for (const w of all.sort((a, b) => a.date.localeCompare(b.date))) {
    if (w.id === exceptId) continue;
    // Открытая заранее сессия не должна тянуть вес из более поздней:
    // история — то, что было до неё, а не то, что уже введено после.
    if (upTo && w.date > upTo) continue;
    const ex = (w.exercises || []).find((e) => e.name === name);
    if (ex && !ex.skipped) {
      for (const s of ex.sets || []) if (!s.warmup) rows.push(s);
    }
  }
  return rows;
}

/**
 * Сессии недели, которые в плане есть, а в базе ещё не записаны. Нужны, когда
 * тренировка переехала на другой день: за две недели такое случилось трижды,
 * а завести её было нечем — на пустой дате приложение упиралось в «сессии
 * в плане нет», и факт не попадал в журнал вообще.
 */
async function movableSessions(date) {
  const [plan, workouts] = await Promise.all([getPlan(date), listWorkouts()]);
  if (!plan) return [];
  const out = [];
  for (const d of weekDays(isoWeek(date))) {
    for (const { week, session } of sessionsFor(plan, d)) {
      if (session.kind === 'mobility') continue;
      const done = workouts.some((w) => w.date === d && (w.kind || 'gym') === session.kind);
      if (done || d === date) continue;
      out.push({ date: d, week, session });
    }
  }
  return out;
}

async function startWorkout(date, kind, moved = null) {
  const plan = await getPlan(date);
  const hit = moved || sessionFor(plan, date, kind);
  if (!hit) return null;
  const { week, session } = hit;
  const rpes = session.exercises.map((e) => e.rpe).filter((v) => v != null);
  const workout = {
    date,
    kind: session.kind,
    status: 'draft',
    weekN: week.n,
    weekKind: week.kind || 'work',
    dayCode: session.code,
    title: session.title || session.code,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    backdated: date !== todayISO(),
    // Дата плана сохраняется рядом с фактической: без неё сверка «план против
    // факта» теряет, что тренировка не пропущена, а перенесена.
    movedFrom: moved ? moved.date : null,
    plannedRPE: rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : null,
    avgRPE: null,
    chestSignal: null,
    prescription: session.exercises,
    exercises: session.exercises.map((e) => ({
      name: e.name, planName: e.name, replacedWith: null,
      skipped: false, skipReason: null, note: '', sets: [],
    })),
  };
  workout.id = await putWorkout(workout);
  return workout;
}

function stopTimer() {
  if (state?.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function startTimer(seconds, onTick) {
  stopTimer();
  const started = Date.now();
  state.restLeft = seconds;
  onTick(seconds);
  state.timer = setInterval(() => {
    const left = Math.max(0, seconds - Math.round((Date.now() - started) / 1000));
    state.restLeft = left;
    onTick(left);
    if (left === 0) {
      stopTimer();
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    }
  }, 250);
}

async function save(box) {
  try {
    await putWorkout(state.workout);
    return true;
  } catch (err) {
    box.prepend(el('div', {
      className: 'error',
      textContent: 'Не сохранено, попробуй ещё раз: ' + err.message,
    }));
    return false;
  }
}

function stepper(input, delta) {
  return el('button', {
    type: 'button', className: 'step',
    textContent: (delta > 0 ? '+' : '−') + String(Math.abs(delta)).replace('.', ','),
    onclick: () => {
      const v = (parseNum(input.value) ?? 0) + delta;
      input.value = String(Math.round(v * 100) / 100);
    },
  });
}

/**
 * Отметки растяжки живут в памяти до явного сохранения. «ЗАВЕРШИТЬ» стоит
 * на том же экране и обнуляло состояние — пять отмеченных позиций и введённые
 * секунды исчезали без единого сообщения. Теперь блок дописывается сам.
 */
async function persistStretch() {
  if (!state || !state.stretch) return;
  const marked = Object.values(state.marks || {}).some(Boolean);
  const timed = Object.values(state.secs || {}).some((v) => v != null);
  if (!marked && !timed) return;
  const iso = state.workout.date;
  const fresh = (await getDay(iso)) || { date: iso };
  fresh.stretch = { ...(fresh.stretch || {}), ...state.marks };
  fresh.stretchSec = { ...(fresh.stretchSec || {}), ...state.secs };
  if (iso !== todayISO()) fresh.backdated = true;
  await putDay(fresh);
}

async function finish(box) {
  const { workout } = state;
  try {
    await persistStretch();
  } catch (err) {
    box.prepend(el('div', {
      className: 'error',
      textContent: 'Блок растяжки не сохранён: ' + err.message,
    }));
    return;
  }
  workout.avgRPE = averageRPE(workout);
  workout.status = 'done';
  workout.finishedAt = new Date().toISOString();
  if (!(await save(box))) return;
  stopTimer();

  // Кардио-день заводит сессию дня сам: забег — и тест, и нагрузка (R5).
  // Тренировка к этому моменту уже сохранена как закрытая, поэтому сбой
  // записи в день не отменяет её и не оставляет на старой форме.
  let cardioError = null;
  if (workout.kind === 'cardio') {
    try {
      await logCardioFromWorkout(workout);
    } catch (err) {
      cardioError = err;
    }
  }

  const summary = sessionSummary(workout);
  state = null;
  box.innerHTML = '';
  box.append(el('h2', { textContent: 'Тренировка закрыта' }));
  if (cardioError) {
    box.append(el('div', {
      className: 'error',
      textContent: 'Кардио не попало в день: ' + cardioError.message
        + '. Тренировка сохранена, сессию можно внести на экране дня.',
    }));
  }

  if (asksChestSignal(workout)) {
    box.append(chestBlock(workout, box));
  }

  // Точка контроля: тренировка закрыта — значит всё уже лежит в записи дня.
  // Она и есть свод, куда сходятся утро, сессии, растяжка, вечер и замеры
  // недели. Поэтому переход туда — главная кнопка, а не последняя строка.
  box.append(el('button', {
    className: 'go', textContent: 'Запись дня — всё зафиксировано →',
    onclick: () => navigate('day', { date: workout.date }),
  }));
  box.append(el('button', {
    className: 'go ghost', textContent: 'Свод в буфер',
    onclick: async (e) => {
      try {
        await navigator.clipboard.writeText(summary);
        e.target.textContent = 'Скопировано';
      } catch {
        box.append(el('pre', { className: 'summary', textContent: summary }));
      }
    },
  }));
  box.append(el('button', {
    className: 'go ghost', textContent: '← вернуться к заполнению',
    onclick: () => navigate('workout', { date: workout.date, kind: workout.kind }),
  }));
}

/** Строка правой груди 0–3 — один раз за жимовую сессию (решение 24.08). */
function chestBlock(workout, box) {
  const wrap = el('div', { className: 'chest' },
    el('h3', { textContent: 'Правая грудь' }),
    el('p', { className: 'hint', textContent: '0 нет ощущения · 1 память · 2 дискомфорт · 3 боль' }));
  const row = el('div', { className: 'chest-row' });
  for (const v of [0, 1, 2, 3]) {
    row.append(el('button', {
      className: 'chest-btn' + (workout.chestSignal === v ? ' on' : ''),
      textContent: String(v),
      onclick: async () => {
        workout.chestSignal = v;
        try {
          await putWorkout(workout);
          for (const b of row.querySelectorAll('button')) b.classList.remove('on');
          row.children[v].classList.add('on');
        } catch (err) {
          box.prepend(el('div', { className: 'error', textContent: err.message }));
        }
      },
    }));
  }
  wrap.append(row);
  return wrap;
}

async function logCardioFromWorkout(workout) {
  const day = (await getDay(workout.date)) || { date: workout.date };
  day.cardio = day.cardio || [];
  if (day.cardio.some((c) => c.fromWorkout === workout.id)) return;
  const ex = (workout.exercises || [])[0] || {};
  const set = (ex.sets || [])[0];
  if (!set) return;
  day.cardio.push({
    type: 'бег',
    minutes: set.minutes ?? null,
    hr: set.hr ?? null,
    km: set.km ?? null,
    fromWorkout: workout.id,
  });
  if (workout.backdated) day.backdated = true;
  await putDay(day);
}

/**
 * Хвост сессии: растяжка идёт последним шагом очереди. Отдельный экран
 * оставался, но на телефоне два экрана вместо одного означали, что блок
 * делают «потом», а потом не наступает.
 */
function extraSteps(stretch) {
  return stretch ? [{ key: 'stretch', title: 'Растяжка' }] : [];
}

/**
 * Плашка бонуса вверху экрана. Раньше люфт был чипом под формой ввода —
 * на седьмом экране подряд его не читал никто. Теперь он загорается в шапке
 * на каждом шаге сессии, а не открывается в конце.
 */
function bonusBanner(box) {
  const { workout, bonus, index } = state;
  const presc = workout.prescription[index] || {};

  // Силовой день: бонус — отдельное упражнение в конце, тап прыгает на него.
  if (bonus) {
    const at = workout.exercises.findIndex((e) => e.name === bonus.name);
    // На самом бонусном упражнении плашка не нужна: она указывала бы на то,
    // что уже открыто, и занимала бы место над формой ввода.
    if (at === index) return;
    const done = at >= 0 ? (workout.exercises[at].sets || []).filter((x) => !x.warmup).length : 0;
    const b = el('button', {
      className: 'bonus-banner' + (done ? ' taken' : ''),
      disabled: at < 0,
      onclick: () => { if (at >= 0) { stopTimer(); state.index = at; draw(box); } },
    },
    el('span', { className: 'plus-badge', textContent: 'БОНУС 120 %' }),
    el('span', { className: 'bonus-name', textContent: bonus.name }),
    el('span', {
      className: 'bonus-dose',
      textContent: done ? `сделано ${done}` : bonus.dose,
    }));
    box.append(b);
    return;
  }

  // Навыковый день: люфт — лишний подход, он написан у самих упражнений.
  if (presc.plus) {
    box.append(el('div', { className: 'bonus-banner static' },
      el('span', { className: 'plus-badge', textContent: 'БОНУС 120 %' }),
      el('span', { className: 'bonus-name', textContent: presc.plus }),
      el('span', { className: 'bonus-dose', textContent: 'по состоянию' })));
  }
}

async function drawStretch(box) {
  const { workout, stretch, week, marks, secs, guide, homeDone } = state;

  const hint = warmupHint(stretch, homeDone);
  if (hint) box.append(el('p', { className: 'hint', textContent: hint }));

  box.append(stretchList(stretch.positions, guide, marks, secs));

  const splitInput = stretch.measureSplit
    ? el('input', { type: 'number', step: '0.5', inputMode: 'decimal', value: week.splitGap ?? '' })
    : null;
  if (splitInput) {
    box.append(el('div', { className: 'split-measure' },
      el('label', {}, 'просвет шпагата, см', splitInput),
      el('p', { className: 'hint', textContent: splitHint(stretch, homeDone) })));
  }

  box.append(el('button', {
    className: 'save', textContent: 'Сохранить блок',
    onclick: async (e) => {
      try {
        // День и неделя перечитываются перед записью. Снимок, снятый при
        // открытии сессии, устаревает: утренний вес, ходьба, отметки
        // с отдельного экрана растяжки могли попасть туда позже, а запись
        // объекта целиком затирала их молча.
        const iso = workout.date;
        await persistStretch();

        if (splitInput) {
          const v = parseNum(splitInput.value);
          if (v != null) {
            const wk = (await getWeek(isoWeek(iso))) || { id: isoWeek(iso) };
            applySplit(wk, stretch, v, homeDone);
            await putWeek(wk);
            state.week = wk;
          }
        }
        e.target.textContent = 'Записано';
      } catch (err) {
        box.prepend(el('div', { className: 'error', textContent: 'Не сохранено: ' + err.message }));
      }
    },
  }));
}

/** Стрелки и завершение для шагов хвоста — без заметки, замены и пропуска. */
/** Кнопка завершения. Бонус в счётчик не входит: план закрыт и без него. */
function finishButton(box) {
  const { workout } = state;
  const required = workout.exercises
    .filter((e, i) => !(workout.prescription[i] || {}).optional);
  const touched = required.filter((e) => e.skipped || e.sets.length).length;
  box.append(el('button', {
    className: 'wk-finish',
    textContent: `ЗАВЕРШИТЬ (${touched} из ${required.length})`,
    onclick: () => finish(box),
  }));
}

function tailNav(box, index, total) {
  const { workout } = state;
  box.append(el('div', { className: 'wk-nav' },
    el('button', {
      textContent: '←', disabled: index === 0,
      onclick: () => { stopTimer(); state.index -= 1; draw(box); },
    }),
    el('span', { className: 'wk-rest' }),
    el('button', {
      textContent: '→', disabled: index === total - 1,
      onclick: () => { stopTimer(); state.index += 1; draw(box); },
    })));

  box.append(el('button', {
    className: 'back', textContent: '← другая сессия',
    onclick: () => { stopTimer(); state = null; navigate('workout', {}); },
  }));

  finishButton(box);
}

async function draw(box) {
  box.innerHTML = '';
  if (!state) return;

  const { workout, index } = state;
  box.dataset.day = workout.dayCode;
  const extras = state.extras || [];
  const total = workout.exercises.length + extras.length;

  // Хвост сессии рисуется своей веткой: у него нет ни плана подходов,
  // ни истории, ни таймера отдыха — общий вид упражнения тут только мешал бы.
  if (index >= workout.exercises.length) {
    const step = extras[index - workout.exercises.length];
    box.append(el('div', { className: 'wk-head' },
      el('div', {
        className: 'wk-crumbs',
        textContent: `Н${workout.weekN} · ${workout.dayCode} · ${index + 1}/${total}`,
      }),
      el('h2', { textContent: step.title })));
    bonusBanner(box);
    await drawStretch(box);
    tailNav(box, index, total);
    return;
  }

  const presc = workout.prescription[index] || {};
  const ex = workout.exercises[index];
  // Подходов набрано столько, сколько в плане — значит пора дальше,
  // и кнопка перехода это показывает.
  const workingSets = (ex.sets || []).filter((x) => !x.warmup).length;
  const planned = Number(presc.sets) || 0;
  const ready = !ex.skipped && planned > 0 && workingSets >= planned;
  const last = index === total - 1;
  const history = await historyFor(ex.name, workout.id, workout.date);
  const prev = history.length ? history[history.length - 1] : null;
  const guide = state.guide.get(ex.name);

  // «5×удержание 25–35 с» слипается в нечитаемое: множитель без пробелов
  // годится только для коротких числовых повторов вроде «4×5».
  const shortReps = /^[\d\s–—-]+$/.test(String(presc.reps ?? ''));
  const planLine = `план ${presc.sets}${shortReps ? '×' : ' × '}${presc.reps}`
    + (presc.rpe != null ? ` · RPE ${fmtNum(presc.rpe, 1)}` : '')
    + (presc.weight ? ` · ${presc.weight}` : '');

  // Закрытым считается упражнение, набравшее план или пропущенное осознанно.
  // Бонус в знаменатель не идёт: он опционален, и сессия без него закрыта.
  const required = workout.exercises
    .map((e, i) => ({ e, p: workout.prescription[i] || {} }))
    .filter((x) => !x.p.optional);
  const closedCount = required.filter(({ e, p }) => {
    const done = (e.sets || []).filter((x) => !x.warmup).length;
    return e.skipped || (p.sets > 0 && done >= p.sets);
  }).length;
  const progress = required.length
    ? Math.round((closedCount / required.length) * 100) : 0;

  // Дата стоит первой строкой: в зале открывают несколько дней подряд,
  // и без неё непонятно, какой именно заполняешь.
  const d = workout.date;
  const dateText = `${weekdayShort(d)} ${d.slice(8)}.${d.slice(5, 7)}`
    + (d === todayISO() ? ' · сегодня' : '');

  box.append(el('div', { className: 'wk-head' },
    el('button', {
      className: 'wk-date',
      textContent: dateText,
      onclick: () => navigate('day', { date: d }),
    }),
    el('div', {
      className: 'wk-crumbs',
      textContent: `Н${workout.weekN} · ${workout.dayCode} · ${index + 1}/${total}`
        + (workout.movedFrom ? ` · перенос с ${workout.movedFrom.slice(8)}.${workout.movedFrom.slice(5, 7)}` : '')
        + (workout.backdated ? ' · задним числом' : '')
        + (workout.status === 'done' ? ' · записана' : ''),
    }),
    el('h2', { textContent: ex.replacedWith || ex.name }),
    el('div', { className: 'wk-plan', textContent: planLine }),
    el('div', {
      className: 'wk-prev',
      textContent: prev ? `прошлый раз ${fmtWeight(prev.weight)} × ${prev.reps}` : 'первый раз',
    }),
    presc.control ? el('div', { className: 'wk-control', textContent: 'контрольный подход' }) : null,
    presc.plus ? el('div', { className: 'wk-gate', textContent: PLUS_GATE }) : null,
    // Эталон стоит там, где делаешь движение. Раньше он лежал за двумя
    // переходами в справочнике, и в зале его не открывал никто.
    etalonBlock(guide),
  ));

  bonusBanner(box);

  // Полоса прогресса сессии: между подходами читается боковым зрением,
  // когда на «5 из 8» смотреть некогда.
  const bar = el('div', { className: 'wk-bar' });
  const fill = el('span', { className: 'wk-bar-fill' });
  fill.style.width = progress + '%';
  bar.append(fill);
  box.append(bar);


  // Весь план сессии: видно, что впереди, и можно прыгнуть на любое упражнение.
  box.append(el('button', {
    className: 'plan-toggle',
    // Считаются упражнения, а не шаги: в очереди их больше на хвост,
    // и одинаковое слово при разных числах читается как ошибка.
    textContent: state.showPlan
      ? 'скрыть список упражнений'
      : `все упражнения сессии (${workout.exercises.length})`,
    onclick: () => { state.showPlan = !state.showPlan; draw(box); },
  }));

  if (state.showPlan) {
    const list = el('ol', { className: 'plan-list' });
    workout.exercises.forEach((e, i) => {
      const p = workout.prescription[i] || {};
      const sets = (e.sets || []).filter((x) => !x.warmup).length;
      const mark = e.skipped ? 'пропуск' : (sets ? `${sets} из ${p.sets}` : '');
      const li = el('li', { className: i === index ? 'now' : (sets || e.skipped ? 'done' : '') });
      li.append(el('button', {
        className: 'plan-row',
        onclick: () => { stopTimer(); state.index = i; state.showPlan = false; draw(box); },
      },
      el('span', { className: 'plan-name', textContent: e.replacedWith || e.name }),
      el('span', {
        className: 'plan-dose',
        textContent: `${p.sets}×${p.reps}`
          + (p.rpe != null ? ` @${fmtNum(p.rpe, 1)}` : '')
          + (p.weight ? ` · ${p.weight}` : ''),
      }),
      mark ? el('span', { className: 'plan-mark', textContent: mark }) : null));
      list.append(li);
    });
    box.append(list);
  }

  if (ex.note) box.append(el('div', { className: 'wk-note', textContent: ex.note }));

  if (ex.skipped) {
    box.append(el('p', { className: 'skipped', textContent: `Пропущено: ${ex.skipReason}` }));
    box.append(el('button', {
      textContent: 'Вернуть в работу',
      onclick: async () => {
        ex.skipped = false; ex.skipReason = null;
        if (await save(box)) draw(box);
      },
    }));
  } else {
    const list = el('ol', { className: 'wk-sets' });
    // Полоса под подходом сравнивает нагрузку внутри упражнения: самый лёгкий
    // подход — 40 % ширины, самый тяжёлый — вся ширина.
    const loads = ex.sets.map((s) => s.weight ?? s.reps ?? 0);
    const lo = Math.min(...loads);
    const hi = Math.max(...loads);
    const share = (v) => (hi === lo ? 1 : 0.4 + 0.6 * ((v - lo) / (hi - lo)));
    ex.sets.forEach((s, i) => {
      const marks = [s.warmup ? 'разм.' : null, s.control ? 'контроль' : null]
        .filter(Boolean).join(' · ');
      const line = s.minutes != null
        ? `${fmtWeight(s.minutes)} мин · ${fmtWeight(s.km)} км`
          + (s.hr != null ? ` · пульс ${s.hr}` : '')
        : null;
      const text = line || `${fmtWeight(s.weight)} × ${s.reps}`
        + (s.rpe != null ? `   RPE ${fmtNum(s.rpe, 1)}` : '')
        + (s.rest != null ? `   отдых ${fmtDuration(s.rest)}` : '')
        + (marks ? `   ${marks}` : '');
      const li = el('li', { className: s.warmup ? 'warm' : '' },
        el('span', { className: 'set-n', textContent: String(i + 1) }),
        el('span', { className: 'set-body', textContent: text }),
        // Ошибся подходом — убрать его должно быть можно на месте,
        // а не «потом поправлю в чате».
        el('button', {
          className: 'set-del',
          textContent: '×',
          title: 'удалить подход',
          onclick: async () => {
            if (!confirm(`Удалить подход ${i + 1}: ${text}?`)) return;
            const removed = ex.sets.splice(i, 1)[0];
            if (!(await save(box))) {
              ex.sets.splice(i, 0, removed);
              return;
            }
            draw(box);
          },
        }));
      li.style.setProperty('--load', share(loads[i]).toFixed(3));
      list.append(li);
    });
    if (ex.sets.length) box.append(list);

    const cardio = workout.kind === 'cardio';
    const d = nextSetDefaults(presc, ex.sets, history);
    const weightLabel = cardio ? 'минуты' : (presc.perSide ? 'вес на сторону' : 'вес');
    const repsLabel = cardio ? 'км' : 'повт';
    // У упражнений с весом тела поле веса пустует и мешает: шаг ±1,25 к нему
    // не относится. Показываем по требованию — жилет и пояс никуда не делись.
    const bodyweight = !cardio && d.weight == null && !presc.perSide;
    const wInput = el('input', {
      type: 'number', step: cardio ? '0.5' : '1.25', inputMode: 'decimal',
      value: d.weight ?? '', className: 'wk-w',
    });
    const rInput = el('input', {
      type: 'number', step: cardio ? '0.1' : '1', inputMode: 'decimal',
      value: d.reps ?? '', className: 'wk-r',
    });
    // Навыкам RPE не ставится: критерий — распад техники, а не усилие.
    // Кардио вместо RPE пишет средний пульс — правило «каждая сессия: тип,
    // время, средний пульс».
    const asksRPE = cardio || presc.rpe != null;
    const rpeInput = asksRPE ? el('input', {
      type: 'number', step: cardio ? '1' : '0.5', inputMode: 'decimal',
      value: cardio ? '' : (d.rpe ?? ''), className: 'wk-rpe',
    }) : null;

    const weightRow = el('label', {}, weightLabel,
      stepper(wInput, cardio ? -0.5 : -1.25), wInput, stepper(wInput, cardio ? 0.5 : 1.25));
    const form = el('div', { className: 'wk-form' },
      bodyweight ? null : weightRow,
      el('label', {}, repsLabel,
        stepper(rInput, cardio ? -0.1 : -1), rInput, stepper(rInput, cardio ? 0.1 : 1)),
      asksRPE ? el('label', {}, cardio ? 'пульс' : 'RPE',
        stepper(rpeInput, cardio ? -1 : -0.5), rpeInput, stepper(rpeInput, cardio ? 1 : 0.5)) : null,
    );
    box.append(form);

    if (bodyweight) {
      const addWeight = el('button', {
        className: 'add-weight', textContent: '+ вес (жилет, пояс)',
        onclick: () => { form.prepend(weightRow); addWeight.remove(); },
      });
      box.append(addWeight);
    }

    if (presc.machine && guide && guide.machine) {
      box.append(el('p', {
        className: 'machine-hint',
        textContent: `${guide.machine.model}: ${guide.machine.hint}`,
      }));
    }

    const warmToggle = el('button', {
      className: 'warm-toggle' + (state.warmup ? ' on' : ''),
      textContent: 'разминочный',
      onclick: () => {
        state.warmup = !state.warmup;
        warmToggle.classList.toggle('on', state.warmup);
      },
    });

    box.append(el('div', { className: 'wk-actions' }, warmToggle, el('button', {
      className: 'wk-add',
      textContent: workingSets >= planned && planned > 0
        ? `ЗАПИСАТЬ ЛИШНИЙ ПОДХОД (${workingSets + 1})`
        : `ЗАПИСАТЬ ПОДХОД ${ex.sets.length + 1}`,
      onclick: async () => {
        const warmup = state.warmup;
        const set = cardio ? {
          minutes: parseNum(wInput.value),
          km: parseNum(rInput.value),
          hr: parseNum(rpeInput.value),
          weight: null,
          reps: null,
          rpe: null,
          rest: null,
          warmup: false,
          control: Boolean(presc.control),
        } : {
          weight: parseNum(wInput.value),
          reps: parseNum(rInput.value),
          rpe: asksRPE ? parseNum(rpeInput.value) : null,
          rest: workout.backdated ? null : restBetween(state.lastSetAt, Date.now()),
          warmup,
          control: isControlSet(presc, ex.sets, warmup),
        };
        ex.sets.push(set);
        if (!(await save(box))) {
          ex.sets.pop();
          return;
        }
        state.lastSetAt = new Date().toISOString();
        const seconds = presc.rest || 90;
        await draw(box);
        if (!workout.backdated) {
          // Метка ищется на каждом тике: после перерисовки ссылка в замыкании
          // указывала на оторванный узел, и таймер замирал на экране.
          startTimer(seconds, (left) => {
            const label = box.querySelector('.wk-rest');
            if (!label) return;
            label.textContent = fmtClock(left);
            label.classList.toggle('over', left === 0);
          });
        }
      },
    })));
  }

  // Очередь: три ближайших невзятых упражнения. Видно, сколько осталось,
  // без разворачивания всего плана.
  const ahead = [];
  for (let i = index + 1; i < workout.exercises.length && ahead.length < 3; i++) {
    const e = workout.exercises[i];
    const p = workout.prescription[i] || {};
    const done = (e.sets || []).filter((x) => !x.warmup).length;
    if (e.skipped || (p.sets > 0 && done >= p.sets)) continue;
    ahead.push({ i, name: e.replacedWith || e.name, dose: `${p.sets}×${p.reps}` });
  }
  // Хвост попадает в очередь наравне с упражнениями: иначе блок 120 %
  // и растяжка не видны до самого конца и делаются «когда вспомнишь».
  for (let k = 0; k < extras.length && ahead.length < 3; k += 1) {
    // Закрытый блок из очереди уходит: иначе она продолжает звать на него же.
    const closed = Object.values(state.marks || {}).filter(Boolean).length
      >= (state.stretch ? state.stretch.positions.length : 0);
    if (closed) continue;
    ahead.push({
      i: workout.exercises.length + k,
      name: extras[k].title,
      dose: `${state.stretch.positions.length} позиций`,
    });
  }

  if (ahead.length) {
    const queue = el('div', { className: 'wk-queue' });
    queue.append(el('div', { className: 'group-cap', textContent: 'дальше' }));
    const card = el('div', { className: 'group-card' });
    for (const a of ahead) {
      card.append(el('button', {
        className: 'group-row',
        onclick: () => { stopTimer(); state.index = a.i; draw(box); },
      },
      el('span', { className: 'row-title', textContent: a.name }),
      el('span', { className: 'row-value', textContent: a.dose }),
      el('span', { className: 'chev' })));
    }
    queue.append(card);
    box.append(queue);
  }

  const restLabel = el('span', {
    className: 'wk-rest',
    textContent: state.restLeft ? fmtClock(state.restLeft) : '',
  });

  box.append(el('div', { className: 'wk-nav' },
    el('button', {
      textContent: '←', disabled: index === 0,
      onclick: () => { stopTimer(); state.index--; draw(box); },
    }),
    restLabel,
    el('button', {
      textContent: 'заметка',
      onclick: async () => {
        const v = prompt('Заметка к упражнению', ex.note || '');
        if (v === null) return;
        ex.note = v.trim();
        if (await save(box)) draw(box);
      },
    }),
    el('button', {
      textContent: 'замена',
      onclick: async () => {
        const alt = (presc.alt || []).join(' / ') || 'свободный ввод';
        const v = prompt(`Чем заменяешь? (${alt})`, ex.replacedWith || '');
        if (v === null) return;
        ex.replacedWith = v.trim() || null;
        if (await save(box)) draw(box);
      },
    }),
    el('button', {
      textContent: 'пропуск',
      onclick: async () => {
        const reason = prompt('Причина пропуска?');
        if (reason === null) return;
        ex.skipped = true;
        ex.skipReason = reason.trim() || 'без причины';
        if (await save(box)) draw(box);
      },
    }),
    el('button', {
      textContent: '→',
      className: ready && !last ? 'ready' : '',
      disabled: last,
      onclick: () => { stopTimer(); state.index++; draw(box); },
    }),
  ));

  if (ready) {
    box.append(el('div', {
      className: 'ready-hint',
      textContent: last
        ? `План закрыт: ${workingSets} из ${planned}. Это последний шаг — можно завершать.`
        : `План закрыт: ${workingSets} из ${planned}. Дальше →`,
    }));
  }

  box.append(el('button', {
    className: 'back', textContent: '← другая сессия',
    onclick: () => { stopTimer(); state = null; navigate('workout', {}); },
  }));

  finishButton(box);
}

const KIND_RU = { gym: 'зал', home: 'дом', skill: 'навык', cardio: 'кардио' };

// Условия добора печатаются памяткой. Проверяет их атлет, а не приложение:
// вычислять «можно ли» значило бы запрещать, а решение остаётся за ним.
const PLUS_GATE = 'сон ≥ 7 ч · RPE в коридоре · сигналы по нулям · не два дня подряд';

/**
 * Выбор сессии: вкладка «Тренировка» открывается без даты, и упираться
 * в «сегодня тренировки нет» нельзя — любой день цикла должен открываться.
 */
async function chooser(box, iso) {
  const [plans, workouts] = await Promise.all([listPlans(), listWorkouts()]);
  const { past, today, next } = sessionsAround(plans, iso);
  const statusOf = (s) => {
    const w = workouts.find((x) => x.date === s.date && (x.kind || 'gym') === s.kind);
    return w ? w.status : null;
  };

  box.append(el('h1', { textContent: 'Какую сессию открыть' }));

  if (!past.length && !today.length && !next.length) {
    box.append(el('p', { textContent: 'Загруженных планов нет — импортируй план в «Ещё».' }));
    return;
  }

  const row = (s, tone) => {
    const status = statusOf(s);
    const mark = status === 'done' ? ' · записана' : (status === 'draft' ? ' · черновик' : '');
    const b = el('button', {
      className: 'pick' + (tone ? ' ' + tone : '') + (status === 'done' ? ' done' : ''),
      onclick: () => navigate('workout', { date: s.date, kind: s.kind }),
    });
    b.append(
      el('span', {
        className: 'pick-date',
        textContent: `${weekdayShort(s.date)} ${s.date.slice(8)}.${s.date.slice(5, 7)}`,
      }),
      el('span', {
        className: 'pick-name',
        textContent: `Н${s.weekN} · ${s.code} · ${KIND_RU[s.kind] || s.kind}${mark}`,
      }),
      el('span', { className: 'pick-count', textContent: `${s.count} упр.` }),
    );
    return b;
  };

  const group = (title, items, tone) => {
    if (!items.length) return;
    box.append(el('h2', { textContent: title }));
    for (const s of items) box.append(row(s, tone));
  };

  group('Сегодня', today, 'now');
  group('Пропущенное и прошлое', [...past].reverse());
  group('Впереди', next, 'future');

  box.append(el('button', {
    className: 'back', textContent: 'Календарь →',
    onclick: () => navigate('calendar', { date: iso }),
  }));
}

export async function render(box, params = {}) {
  const iso = params.date || todayISO();

  // Без явного выбора вкладка показывает список, а не молча берёт зал сегодня.
  if (!params.kind) {
    stopTimer();
    state = null;
    await chooser(box, iso);
    return;
  }

  const date = iso;
  const kind = params.kind;

  if (!state || state.workout.date !== date || state.workout.kind !== kind) {
    stopTimer();
    let workout = await findWorkout(date, kind);
    if (!workout) workout = await startWorkout(date, kind);
    if (!workout) {
      box.append(el('h2', { textContent: 'На эту дату сессии в плане нет' }));
      const movable = await movableSessions(date);
      if (movable.length) {
        box.append(el('p', {
          className: 'hint',
          textContent: 'Тренировка переехала? Перенеси сюда незаписанную сессию недели —'
            + ' плановая дата сохранится в записи, и сверка «план против факта» уцелеет.',
        }));
        const card = el('div', { className: 'group-card' });
        for (const m of movable) {
          card.append(el('button', {
            className: 'group-row',
            onclick: async () => {
              const w = await startWorkout(date, m.session.kind, m);
              if (w) navigate('workout', { date, kind: m.session.kind });
            },
          },
          el('span', { className: 'row-title', textContent: m.session.code }),
          el('span', {
            className: 'row-value',
            textContent: `${weekdayShort(m.date)} ${m.date.slice(8)}.${m.date.slice(5, 7)}`,
          }),
          el('span', { className: 'chev' })));
        }
        box.append(el('div', { className: 'group-cap', textContent: 'перенести сюда' }));
        box.append(card);
      }
      box.append(el('button', {
        className: 'go ghost', textContent: 'Выбрать другую',
        onclick: () => navigate('workout', {}),
      }));
      box.append(el('button', {
        className: 'back', textContent: '← к дню',
        onclick: () => navigate('day', { date }),
      }));
      return;
    }
    if (!workout.prescription) {
      const plan = await getPlan(workout.date);
      const hit = sessionFor(plan, workout.date, workout.kind || 'gym');
      workout.prescription = hit ? hit.session.exercises : [];
    }
    const guide = new Map((await getExercises()).map((e) => [e.name, e]));

    // Растяжка живёт в плане отдельной сессией той же даты. Внутри тренировки
    // она становится последним шагом — на телефоне два экрана вместо одного
    // означали, что блок делают «потом», а потом не наступает.
    const plan = await getPlan(date);
    const mob = sessionFor(plan, date, 'mobility');
    const stretch = mob ? mob.session : null;
    const own = sessionFor(plan, date, kind);
    const bonus = own && own.session.bonus ? own.session.bonus : null;

    // Сессия живёт с тем планом, с которым стартовала, — иначе сверка «план
    // против факта» становится ложью. Но у необязательных упражнений этой цены
    // нет: бонус стоит последним, индексы записанного не двигает и обязательной
    // часть сессии не делает. Появился в плане позже старта — дописываем,
    // а не показываем тупик «не в этой сессии».
    if (own) {
      const have = new Set(workout.exercises.map((e) => e.planName || e.name));
      const missing = (own.session.exercises || [])
        .filter((e) => e.optional && !have.has(e.name));
      if (missing.length) {
        workout.prescription = [...(workout.prescription || []), ...missing];
        workout.exercises = [...workout.exercises, ...missing.map((e) => ({
          name: e.name, planName: e.name, replacedWith: null,
          skipped: false, skipReason: null, note: '', sets: [],
        }))];
        await putWorkout(workout);
      }
    }
    const [dayRaw, weekRaw, allWorkouts] = await Promise.all([
      getDay(date), getWeek(isoWeek(date)), listWorkouts(),
    ]);
    const day = dayRaw || { date };
    const week = weekRaw || { id: isoWeek(date) };

    state = {
      workout, index: 0, timer: null, restLeft: 0,
      warmup: false, lastSetAt: null, guide, showPlan: false,
      stretch, bonus, day, week,
      marks: { ...(day.stretch || {}) }, secs: { ...(day.stretchSec || {}) },
      homeDone: allWorkouts.some(
        (w) => w.date === date && w.kind === 'home' && w.status === 'done'),
      extras: extraSteps(stretch),
    };
  }
  await draw(box);
}
