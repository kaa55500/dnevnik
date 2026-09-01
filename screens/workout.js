import {
  findWorkout, putWorkout, delWorkout, getPlan, getDay, putDay, getWeek, putWeek,
  listWorkouts, getExercises, listPlans,
} from '../store.js';
import { sessionFor, sessionsFor, sessionsAround } from '../plan.js';
import { todayISO, weekdayShort, isoWeek, weekDays } from '../lib/dates.js';
import { fmtNum, fmtWeight, fmtDuration, fmtClock, parseNum } from '../lib/format.js';
import {
  nextSetDefaults, planReps, averageRPE, isControlSet, asksChestSignal,
  fillModeOf, restForSet, insertExercise, requiredPairs,
} from './workout-logic.js';
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

/**
 * Объект тренировки без записи в базу. Открыть сессию посмотреть должно быть
 * бесплатно: до 01.09 сам факт открытия заводил черновик, и он навсегда
 * оставался в журнале как «пропущенное», даже если атлет просто заглянул
 * в план. Запись появляется в момент выбора режима заполнения.
 */
function makeWorkout(date, hit, moved = null) {
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
  return workout;
}

async function startWorkout(date, kind, moved = null) {
  const plan = await getPlan(date);
  const hit = moved || sessionFor(plan, date, kind);
  if (!hit) return null;
  const workout = makeWorkout(date, hit, moved);
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
    const id = await putWorkout(state.workout);
    // Первое сохранение заводит запись: до выбора режима её в базе нет.
    if (state.workout.id == null) state.workout.id = id;
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
    onclick: () => navigate('workout', { date: workout.date, kind: workout.kind, code: workout.dayCode }),
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
/** Кнопка завершения. Бонус и внеплановое в счётчик не входят. */
function finishButton(box) {
  const { workout } = state;
  const required = requiredPairs(workout).map((x) => x.e);
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

/**
 * Обзор перед заполнением: весь план сессии целиком, ниже развилка режима.
 *
 * Режим спрашивается явно, потому что автоопределение уже сломалось: отдых
 * писался, если дата сессии сегодняшняя, а 01.09 атлет внёс сегодняшнюю
 * тренировку целиком после зала — метки времени легли одна к другой,
 * и в журнал ушли «отдыхи» по 1–3 секунды.
 */
async function drawOverview(box) {
  const { workout } = state;
  const d = workout.date;

  box.append(el('div', { className: 'wk-head' },
    el('div', {
      className: 'wk-crumbs',
      textContent: `Н${workout.weekN} · ${workout.dayCode} · ${weekdayShort(d)} ${d.slice(8)}.${d.slice(5, 7)}`
        + (workout.movedFrom ? ` · перенос с ${workout.movedFrom.slice(8)}.${workout.movedFrom.slice(5, 7)}` : ''),
    }),
    el('h2', { textContent: workout.title || workout.dayCode })));

  const list = el('ol', { className: 'plan-list overview' });
  workout.exercises.forEach((e, i) => {
    const p = workout.prescription[i] || {};
    list.append(el('li', {}, el('div', { className: 'plan-row' },
      el('span', { className: 'plan-name', textContent: e.name }),
      el('span', {
        className: 'plan-dose',
        textContent: `${p.sets}×${p.reps}`
          + (p.rpe != null ? ` @${fmtNum(p.rpe, 1)}` : '')
          + (p.weight ? ` · ${p.weight}` : ''),
      }))));
  });
  box.append(list);

  if (state.stretch) {
    box.append(el('p', { className: 'hint', textContent:
      `Хвостом сессии — растяжка, ${state.stretch.positions.length} позиций.` }));
  }

  if (workout.fillMode) {
    box.append(el('button', {
      className: 'go',
      textContent: 'продолжить заполнение →',
      onclick: () => { state.showOverview = false; return draw(box); },
    }));
  }

  box.append(el('div', { className: 'group-cap', textContent: 'как заполняешь' }));
  const card = el('div', { className: 'group-card' });
  const pick = (title, hint, mode) => el('button', {
    className: 'group-row',
    onclick: async () => {
      workout.fillMode = mode;
      state.showOverview = false;
      if (!(await save(box))) return;
      // Дату могли сменить прямо здесь — тогда экран открывается заново
      // на новой дате, иначе адрес и запись разъедутся.
      if (workout.date !== state.paramDate) {
        const kind = workout.kind;
        const to = workout.date;
        stopTimer();
        state = null;
        navigate('workout', { date: to, kind, code: workout.dayCode });
        return;
      }
      state.index = 0;
      await draw(box);
    },
  },
  el('span', { className: 'row-title', textContent: title }),
  el('span', { className: 'row-value', textContent: hint }),
  el('span', { className: 'chev' }));

  card.append(pick('Заполняю сейчас', 'секундомер, отдых по меткам', 'live'));
  card.append(pick('Заполняю потом', 'без секундомера, отдых руками', 'later'));
  box.append(card);

  // Перенос — это просто другая дата у этой же тренировки. Режим он не
  // выбирает: можно прийти второго и провести тренировку за первое,
  // с секундомером и по меткам времени.
  box.append(el('div', { className: 'group-cap', textContent: 'дата тренировки' }));
  const dateIn = el('input', { type: 'date', value: workout.date, className: 'move-date' });
  dateIn.onchange = async () => {
    const v = dateIn.value;
    if (!v || v === workout.date) return;
    // Плановая дата — та, что стояла в плане, а не предыдущая правка.
    const planned = workout.movedFrom || workout.date;
    workout.movedFrom = v === planned ? null : planned;
    workout.date = v;
    workout.backdated = v !== todayISO();
    if (workout.id != null && !(await save(box))) return;
    await draw(box);
  };
  box.append(el('div', { className: 'move-row' }, dateIn));
  box.append(el('p', {
    className: 'hint',
    textContent: workout.movedFrom
      ? `По плану это ${workout.movedFrom.slice(8)}.${workout.movedFrom.slice(5, 7)} — плановая дата сохранится в записи.`
      : 'Поменяй, если делаешь эту тренировку в другой день. Режим выбирается выше.',
  }));

  // Отмена: заглянул посмотреть — уходишь без следа. Пустой черновик,
  // заведённый прошлой версией, при этом удаляется.
  box.append(el('button', {
    className: 'back', textContent: '← не заполняю, просто смотрел',
    onclick: async () => {
      stopTimer();
      const w = workout;
      const empty = (w.exercises || []).every((e) => !(e.sets || []).length && !e.skipped);
      if (w.id != null && w.status === 'draft' && empty) {
        try { await delWorkout(w.id); } catch { /* не удалилось — не беда */ }
      }
      state = null;
      navigate('workout', {});
    },
  }));
}

const MODE_RU = { live: 'сейчас', later: 'потом' };

/**
 * Выбор упражнения вне плана. Имя берётся из справочника, а не набирается:
 * своды объёма и цели ключуются по имени, и опечатка тихо выносит упражнение
 * из аналитики. Свободный ввод остаётся запасным путём.
 */
function exercisePicker(box) {
  const { workout, guide } = state;
  const wrap = el('div', { className: 'picker' });
  const at = state.insertAt;
  const have = new Set(workout.exercises.map((e) => e.name));
  const names = [...guide.keys()].filter((n) => !have.has(n)).sort((a, b) => a.localeCompare(b, 'ru'));

  const search = el('input', { type: 'search', placeholder: 'упражнение', className: 'picker-search' });
  const list = el('div', { className: 'group-card picker-list' });

  const add = async (name) => {
    const i = insertExercise(workout, at, name);
    if (!(await save(box))) {
      workout.exercises.splice(i, 1);
      workout.prescription.splice(i, 1);
      return;
    }
    state.insertAt = null;
    state.showPlan = false;
    state.index = i;
    draw(box);
  };

  const typed = () => String(search.value || '').trim();
  const fill = () => {
    list.innerHTML = '';
    const raw = typed();
    const q = raw.toLowerCase();
    const hits = (q ? names.filter((n) => n.toLowerCase().includes(q)) : names).slice(0, 12);
    for (const n of hits) {
      list.append(el('button', { className: 'group-row', onclick: () => add(n) },
        el('span', { className: 'row-title', textContent: n }),
        el('span', { className: 'chev' })));
    }
    // Свободный ввод — запасной путь: имя не совпадёт со справочником,
    // и упражнение выпадет из сводов по объёму и из целей.
    if (raw && !hits.includes(raw)) {
      list.append(el('button', {
        className: 'group-row free', onclick: () => add(raw),
      },
      el('span', { className: 'row-title', textContent: `записать как есть: «${raw}»` }),
      el('span', { className: 'row-value', textContent: 'без эталона' })));
    }
  };
  search.oninput = fill;
  fill();

  wrap.append(el('div', { className: 'group-cap', textContent: `упражнение вне плана · позиция ${at + 1}` }));
  wrap.append(search, list);
  wrap.append(el('button', {
    className: 'back', textContent: 'отмена',
    onclick: () => { state.insertAt = null; return draw(box); },
  }));
  return wrap;
}

async function draw(box) {
  box.innerHTML = '';
  if (!state) return;

  // Обзор: до выбора режима — сам собой, дальше — по кнопке «к плану сессии».
  // Посмотреть весь план посреди тренировки нужно постоянно, а единственным
  // входом туда был чип режима, который заодно сбрасывал сам режим.
  if (state.showOverview
      || (state.workout.fillMode == null && state.workout.status !== 'done')) {
    await drawOverview(box);
    return;
  }

  const { workout, index } = state;
  box.dataset.day = workout.dayCode;
  const extras = state.extras || [];
  const total = workout.exercises.length + extras.length;

  // Сессия вне плана начинается пустой: её содержание — то, что реально
  // сделал. Побегал в субботу, доделал навыки — записать это было некуда.
  if (!workout.exercises.length) {
    const dd = workout.date;
    box.append(el('div', { className: 'wk-head' },
      el('div', {
        className: 'wk-crumbs',
        textContent: `${weekdayShort(dd)} ${dd.slice(8)}.${dd.slice(5, 7)}`
          + (workout.weekN ? ` · Н${workout.weekN}` : '')
          + ' · вне плана',
      }),
      el('h2', { textContent: workout.title || 'Вне плана' })));

    box.append(el('p', {
      className: 'hint',
      textContent: 'Пока пусто. Добавь упражнение — оно и станет содержанием этой сессии.',
    }));
    box.append(el('button', {
      className: 'go', textContent: '+ упражнение',
      onclick: () => { state.insertAt = 0; return draw(box); },
    }));
    if (state.insertAt != null) box.append(exercisePicker(box));

    box.append(el('button', {
      className: 'back', textContent: '← другая сессия',
      onclick: () => { stopTimer(); state = null; navigate('workout', {}); },
    }));
    box.append(el('button', {
      className: 'back danger', textContent: 'отменить заполнение',
      onclick: async () => {
        if (!confirm('Удалить пустую сессию?')) return;
        stopTimer();
        if (workout.id != null) {
          try { await delWorkout(workout.id); } catch { /* остаётся как есть */ }
        }
        state = null;
        navigate('workout', {});
      },
    }));
    return;
  }

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
  // Бонус и внеплановое в знаменатель не идут: сессия закрыта и без них.
  const required = requiredPairs(workout);
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
    // Режим виден всё время и переспрашивается тапом: заполнение начинают
    // онлайн, а дописывают вечером, и цифра отдыха от этого зависит.
    el('button', {
      className: 'wk-mode',
      textContent: `заполняю ${MODE_RU[fillModeOf(workout)]}`,
      onclick: async () => {
        stopTimer();
        workout.fillMode = null;
        if (await save(box)) draw(box);
      },
    }),
    el('h2', { textContent: ex.replacedWith || ex.name }),
    presc.unplanned || ex.unplanned
      ? el('div', { className: 'wk-plan', textContent: 'вне плана' })
      : el('div', { className: 'wk-plan', textContent: planLine }),
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
    onclick: () => { state.showPlan = !state.showPlan; return draw(box); },
  }));

  if (state.showPlan) {
    const list = el('ol', { className: 'plan-list' });
    // Вставка между строками: упражнение вне плана встаёт туда, где его
    // реально сделали, а не в конец. 01.09 три выхода силой записать было
    // некуда — дописывать умел только бонус.
    const inserter = (at) => el('li', { className: 'plan-insert' }, el('button', {
      className: 'insert-here', textContent: '+ упражнение сюда',
      onclick: () => { state.insertAt = at; return draw(box); },
    }));

    workout.exercises.forEach((e, i) => {
      list.append(inserter(i));
      const p = workout.prescription[i] || {};
      const sets = (e.sets || []).filter((x) => !x.warmup).length;
      const mark = e.skipped ? 'пропуск' : (sets ? `${sets} из ${p.sets || '—'}` : '');
      const li = el('li', { className: i === index ? 'now' : (sets || e.skipped ? 'done' : '') });
      li.append(el('button', {
        className: 'plan-row',
        onclick: () => { stopTimer(); state.index = i; state.showPlan = false; return draw(box); },
      },
      el('span', { className: 'plan-name', textContent: e.replacedWith || e.name }),
      el('span', {
        className: 'plan-dose',
        textContent: (p.unplanned || e.unplanned) ? 'вне плана'
          : `${p.sets}×${p.reps}`
            + (p.rpe != null ? ` @${fmtNum(p.rpe, 1)}` : '')
            + (p.weight ? ` · ${p.weight}` : ''),
      }),
      mark ? el('span', { className: 'plan-mark', textContent: mark }) : null));
      list.append(li);
    });
    list.append(inserter(workout.exercises.length));
    box.append(list);
  }

  if (state.insertAt != null) box.append(exercisePicker(box));

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
    // Разминочные показываются сверху независимо от порядка записи: их часто
    // вносят после рабочих, вспомнив. В базе порядок остаётся хронологическим —
    // на нём стоит расчёт отдыха по меткам времени.
    const ordered = ex.sets
      .map((s, i) => ({ s, i }))
      .sort((a, b) => Number(Boolean(b.s.warmup)) - Number(Boolean(a.s.warmup)));

    ordered.forEach(({ s, i }, pos) => {
      const marks = [s.warmup ? 'разм.' : null, s.control ? 'контроль' : null]
        .filter(Boolean).join(' · ');
      const line = s.minutes != null
        ? `${fmtWeight(s.minutes)} мин · ${fmtWeight(s.km)} км`
          + (s.hr != null ? ` · пульс ${s.hr}` : '')
        : null;
      const text = line || `${fmtWeight(s.weight)} × ${s.reps}`
        + (s.rpe != null ? `   RPE ${fmtNum(s.rpe, 1)}` : '')
        + (s.rest != null ? `   отдых ${s.restManual ? '~' : ''}${fmtDuration(s.rest)}` : '')
        + (marks ? `   ${marks}` : '');
      const li = el('li', {
        className: (s.warmup ? 'warm' : '') + (state.editSet === i ? ' editing' : ''),
      },
      el('span', { className: 'set-n', textContent: String(pos + 1) }),
      // Тап по строке открывает подход на правку: ошибся в весе — поправил,
      // а не удалил и записал заново.
      el('button', {
        className: 'set-body', textContent: text,
        onclick: () => {
          state.editSet = state.editSet === i ? null : i;
          if (state.editSet == null) state.warmup = false;
          return draw(box);
        },
      }),
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
            // Правился удалённый подход — режим правки снимается,
            // иначе форма осталась бы привязанной к чужому индексу.
            if (state.editSet != null && state.editSet >= i) state.editSet = null;
            draw(box);
          },
        }));
      li.style.setProperty('--load', share(loads[i]).toFixed(3));
      list.append(li);
    });
    if (ex.sets.length) box.append(list);

    const cardio = workout.kind === 'cardio';
    const mode = fillModeOf(workout);
    // Правка записанного: тап по строке подхода подставляет его в форму.
    // Раньше ошибку можно было только удалить и записать заново.
    const editing = state.editSet != null && ex.sets[state.editSet] ? ex.sets[state.editSet] : null;
    const d = editing || nextSetDefaults(presc, ex.sets, history);
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
      value: cardio ? (d.hr ?? '') : (d.rpe ?? ''), className: 'wk-rpe',
    }) : null;
    // Отдых руками: в режиме «потом» он единственный источник цифры,
    // в режиме «сейчас» — способ поправить измеренное.
    const restInput = cardio ? null : el('input', {
      type: 'number', step: '5', inputMode: 'numeric', className: 'wk-restin',
      value: editing && editing.rest != null ? editing.rest : '',
      placeholder: mode === 'live' ? 'по секундомеру' : 'не записан',
    });

    const weightRow = el('label', {}, weightLabel,
      stepper(wInput, cardio ? -0.5 : -1.25), wInput, stepper(wInput, cardio ? 0.5 : 1.25));
    const form = el('div', { className: 'wk-form' },
      bodyweight ? null : weightRow,
      el('label', {}, repsLabel,
        stepper(rInput, cardio ? -0.1 : -1), rInput, stepper(rInput, cardio ? 0.1 : 1)),
      asksRPE ? el('label', {}, cardio ? 'пульс' : 'RPE',
        stepper(rpeInput, cardio ? -1 : -0.5), rpeInput, stepper(rpeInput, cardio ? 1 : 0.5)) : null,
      restInput ? el('label', { className: 'rest-row' }, 'отдых, с', restInput) : null,
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
    // При правке тумблер показывает тип правимого подхода, а не прошлый выбор.
    if (editing) {
      state.warmup = Boolean(editing.warmup);
      warmToggle.classList.toggle('on', state.warmup);
    }

    box.append(el('div', { className: 'wk-actions' }, warmToggle, el('button', {
      className: 'wk-add' + (editing ? ' editing' : ''),
      textContent: editing
        ? `СОХРАНИТЬ ПОДХОД ${state.editSet + 1}`
        : (workingSets >= planned && planned > 0
          ? `ЗАПИСАТЬ ЛИШНИЙ ПОДХОД (${workingSets + 1})`
          : `ЗАПИСАТЬ ПОДХОД ${ex.sets.length + 1}`),
      onclick: async () => {
        const warmup = state.warmup;
        const manual = restInput ? parseNum(restInput.value) : null;
        const { rest, restManual } = restForSet({
          mode, lastSetAt: state.lastSetAt, now: Date.now(), manual,
        });
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
          rest,
          restManual: restManual || undefined,
          warmup,
          control: isControlSet(presc, ex.sets, warmup),
        };

        if (editing) {
          const i = state.editSet;
          const before = ex.sets[i];
          // Правка не трогает измеренный отдых и метку контрольного подхода:
          // они относятся к моменту записи, а не к введённым цифрам.
          ex.sets[i] = {
            ...before,
            weight: set.weight, reps: set.reps, rpe: set.rpe,
            minutes: set.minutes, km: set.km, hr: set.hr,
            warmup: set.warmup,
            ...(manual != null ? { rest: set.rest, restManual: true } : {}),
          };
          if (!(await save(box))) {
            ex.sets[i] = before;
            return;
          }
          state.editSet = null;
          state.warmup = false;
          await draw(box);
          return;
        }

        ex.sets.push(set);
        if (!(await save(box))) {
          ex.sets.pop();
          return;
        }
        // Тумблер залипал: включённый однажды, он метил разминочными все
        // следующие подходы, пока это не замечали глазами.
        state.warmup = false;
        state.lastSetAt = new Date().toISOString();
        const seconds = presc.rest || 90;
        await draw(box);
        if (mode === 'live') {
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

    if (editing) {
      box.append(el('button', {
        className: 'back', textContent: 'отменить правку',
        onclick: () => { state.editSet = null; state.warmup = false; return draw(box); },
      }));
    }
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
        onclick: () => { stopTimer(); state.index = a.i; return draw(box); },
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
    className: 'back', textContent: '← весь план сессии и дата',
    onclick: () => { stopTimer(); state.showOverview = true; return draw(box); },
  }));

  box.append(el('button', {
    className: 'back', textContent: '← другая сессия',
    onclick: () => { stopTimer(); state = null; navigate('workout', {}); },
  }));

  // Обратный путь из начатого заполнения. До этого выйти было некуда:
  // единственная дверь вела через ЗАВЕРШИТЬ, то есть закрыть тренировку,
  // которой не было.
  if (workout.status === 'draft') {
    const written = workout.exercises.reduce((n, e) => n + (e.sets || []).length, 0);
    box.append(el('button', {
      className: 'back danger',
      textContent: 'отменить заполнение',
      onclick: async () => {
        const what = written
          ? `Удалить черновик? Записанное пропадёт: подходов ${written}.`
          : 'Удалить пустой черновик?';
        if (!confirm(what)) return;
        stopTimer();
        if (workout.id != null) {
          try {
            await delWorkout(workout.id);
          } catch (err) {
            box.prepend(el('div', { className: 'error', textContent: 'Не удалось удалить: ' + err.message }));
            return;
          }
        }
        state = null;
        navigate('workout', {});
      },
    }));
  }

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
  const [plan, workouts] = await Promise.all([getPlan(iso), listWorkouts()]);

  box.append(el('h1', { textContent: 'Какую сессию открыть' }));

  if (!plan) {
    box.append(el('p', { textContent: 'Загруженных планов нет — импортируй план в «Ещё».' }));
    box.append(el('button', {
      className: 'back', textContent: 'Календарь →',
      onclick: () => navigate('calendar', { date: iso }),
    }));
    return;
  }

  // Тренировка ищется и по плановой дате: перенесённая остаётся на своём
  // месте в календаре, а не пропадает из списка. Точное совпадение даты
  // главнее переноса — иначе чужая запись перехватила бы чужой слот.
  const workoutFor = (s) => {
    // Код дня отсекает чужую запись: на 04.09 могут лежать плановый В2
    // и приехавший со вторника Н1, оба «зал».
    const mine = workouts.filter((x) => (x.kind || 'gym') === s.kind
      && (x.dayCode ? x.dayCode === s.code : true));
    return mine.find((x) => x.date === s.date)
      || mine.find((x) => x.movedFrom === s.date)
      || null;
  };

  const dm = (d) => `${d.slice(8)}.${d.slice(5, 7)}`;

  const row = (s) => {
    const w = workoutFor(s);
    const status = w ? w.status : null;
    const moved = w && w.date !== s.date ? w.date : null;
    const mark = (status === 'done' ? ' · записана' : (status === 'draft' ? ' · черновик' : ''))
      + (moved ? ` · сделана ${dm(moved)}` : '');
    const tone = s.date === iso ? ' now' : (s.date > iso ? ' future' : '');
    const b = el('button', {
      className: 'pick' + tone + (status === 'done' ? ' done' : '') + (moved ? ' moved' : ''),
      // Открывается там, где тренировка лежит на самом деле.
      onclick: () => navigate('workout', { date: w ? w.date : s.date, kind: s.kind, code: s.code }),
    });
    b.append(
      el('span', {
        className: 'pick-date',
        textContent: `${weekdayShort(s.date)} ${dm(s.date)}`,
      }),
      el('span', {
        className: 'pick-name',
        textContent: `${s.code} · ${KIND_RU[s.kind] || s.kind}${mark}`,
      }),
      el('span', { className: 'pick-count', textContent: `${s.count} упр.` }),
    );
    return b;
  };

  // Календарный порядок и группировка по неделям. Прежние «Сегодня» /
  // «Пропущенное и прошлое» / «Впереди» ломали хронологию: прошлое висело
  // между сегодняшним днём и ближайшими сессиями, и найти нужную дату
  // приходилось глазами по всему экрану.
  const weeks = [...(plan.weeks || [])].sort((a, b) => a.n - b.n);
  for (const week of weeks) {
    const rows = [];
    for (const day of week.days || []) {
      for (const s of day.sessions || []) {
        if (s.kind === 'mobility') continue;
        rows.push({
          date: day.date, kind: s.kind, code: s.code,
          count: (s.exercises || []).length,
        });
      }
    }
    if (!rows.length) continue;
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));

    const dates = rows.map((r) => r.date).sort();
    const from = dates[0];
    const to = dates[dates.length - 1];
    const current = iso >= from && iso <= to;
    const title = `Н${week.n} · ${dm(from)}–${dm(to)}`
      + (week.kind === 'deload' ? ' · разгрузка' : '')
      + (current ? ' · эта неделя' : '');

    const head = el('h2', { className: current ? 'wk-now' : '', textContent: title });
    box.append(head);
    for (const s of rows) box.append(row(s));
    // Список открывается на текущей неделе, а не на первой: иначе каждый раз
    // приходится проматывать два месяца прошлого, чтобы дойти до сегодня.
    if (current && typeof head.scrollIntoView === 'function') {
      setTimeout(() => head.scrollIntoView({ block: 'start' }), 0);
    }
  }

  box.append(el('button', {
    className: 'back', textContent: 'Календарь →',
    onclick: () => navigate('calendar', { date: iso }),
  }));
}

export async function render(box, params = {}) {
  const iso = params.date || todayISO();
  const code = params.code || null;

  // Без явного выбора вкладка показывает список, а не молча берёт зал сегодня.
  if (!params.kind) {
    stopTimer();
    state = null;
    await chooser(box, iso);
    return;
  }

  const date = iso;
  const kind = params.kind;

  if (!state || state.workout.date !== date || state.workout.kind !== kind
      || (code && state.workout.dayCode !== code)) {
    stopTimer();
    let workout = await findWorkout(date, kind, code);
    if (!workout) {
      const planNow = await getPlan(date);
      const hit = sessionFor(planNow, date, kind, code);
      // Запись не заводится, пока не выбран режим: заглянуть в план бесплатно.
      if (hit) workout = makeWorkout(date, hit);
    }
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
              if (w) navigate('workout', { date, kind: m.session.kind, code: m.session.code });
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
      const hit = sessionFor(plan, workout.date, workout.kind || 'gym', workout.dayCode);
      workout.prescription = hit ? hit.session.exercises : [];
    }
    const guide = new Map((await getExercises()).map((e) => [e.name, e]));

    // Растяжка живёт в плане отдельной сессией той же даты. Внутри тренировки
    // она становится последним шагом — на телефоне два экрана вместо одного
    // означали, что блок делают «потом», а потом не наступает.
    const plan = await getPlan(date);
    const mob = sessionFor(plan, date, 'mobility');
    const stretch = mob ? mob.session : null;
    const own = sessionFor(plan, date, kind, workout.dayCode);
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
        // Незаписанную сессию не создаём этим побочно: её заведёт выбор режима.
        if (workout.id != null) await putWorkout(workout);
      }
    }
    const [dayRaw, weekRaw, allWorkouts] = await Promise.all([
      getDay(date), getWeek(isoWeek(date)), listWorkouts(),
    ]);
    const day = dayRaw || { date };
    const week = weekRaw || { id: isoWeek(date) };

    state = {
      workout, index: 0, timer: null, restLeft: 0, paramDate: date, showOverview: false,
      warmup: false, lastSetAt: null, guide, showPlan: false,
      editSet: null, insertAt: null,
      stretch, bonus, day, week,
      marks: { ...(day.stretch || {}) }, secs: { ...(day.stretchSec || {}) },
      homeDone: allWorkouts.some(
        (w) => w.date === date && w.kind === 'home' && w.status === 'done'),
      extras: extraSteps(stretch),
    };
  }
  await draw(box);
}
