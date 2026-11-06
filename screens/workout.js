import {
  findWorkout, putWorkout, delWorkout, getPlan, getDay, putDay, getWeek, putWeek,
  listWorkouts, getExercises, getSettings, listPlans,
} from '../store.js';
import { sessionFor, sessionsFor, trainingSessions } from '../plan.js';
import { todayISO, weekdayShort, isoWeek, weekDays, dm } from '../lib/dates.js';
import {
  fmtNum, fmtWeight, fmtDuration, fmtClock, parseNum, setAmount, prevSessionLine,
  measureText,
} from '../lib/format.js';
import { backupNote, backupSender, sendDue } from './backup-note.js';
import {
  nextSetDefaults, planReps, averageRPE, isControlSet, asksChestSignal,
  sessionMode, restForSet, restBetween, requiredPairs, workoutElapsed, cardioType,
  prescriptionFor, exerciseClosed, orderedSets, setProgress,
  bodyweightForm, restKind, setMeasure, markControl,
  firstOpen, debtNames, exerciseHistory, doneName, isHoldSet, checkSetInput,
  removeExercise, undoDelete, bonusToAppend, effectivePresc, insteadLine, listDose,
  repsPerSide, weightPerHand, fillChips, chipText, asksRPE, copiesOfLast, nextOpenAfter, nextOpen,
  REST_FEEL, SKIP_KINDS, skipAs, moveTargets, incomingMoves, insertMoved, RPE_ROWS, rpeOutline,
  shortName, roundPartner, roundMates, takePair, putPair, shownExercise,
} from './workout-logic.js';
import { MACHINES, cellHint, cellFor, cellKg } from '../lib/machines.js';
import { sessionSummary } from '../export.js';
import { etalonBlock } from './etalon.js';
import { stretchList, warmupHint, splitHint, applySplit } from './stretch-block.js';
import { chooser } from './workout-chooser.js';
import { drawOverview, exercisePicker } from './workout-overview.js';
import { makeWorkout, startWorkout } from './session-move.js';
import { navigate } from '../main.js';

let state = null;      // { workout, index, clock, warmup, guide, showInfo }

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

async function historyFor(name, exceptId, upTo = null, variant = null) {
  return exerciseHistory(await listWorkouts(), name, { exceptId, upTo, variant });
}

/**
 * Прошлая сессия этого упражнения целиком: дата и все её рабочие подходы.
 * Одного последнего подхода мало — по нему не видно, держался ли вес до конца
 * и на скольких подходах он держался.
 */
function lastSession(history) {
  if (!history.length) return null;
  const date = history[history.length - 1].date;
  return { date, sets: history.filter((s) => s.date === date) };
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
 * Номер недели в хлебных крошках. У сессии вне плана его нет вовсе
 * (`weekOf` на дате без цикла отдаёт null), и шапка печатала «НUNDEFINED».
 * Пусто честнее выдуманного номера.
 */
function weekCrumb(workout) {
  return workout.weekN ? `Н${workout.weekN} · ` : '';
}

/**
 * Уход с экрана: гасим часы и сохраняем растяжку. Часы висели осиротевшим
 * интервалом — `stopClock` смотрит на `state?.clock`, а `state` к тому
 * моменту уже null, и тик продолжал раз в секунду писать время прошлой
 * тренировки в часы следующей. Отметки растяжки при этом жили только
 * в памяти и пропадали молча, в отличие от подходов.
 */
export async function leave() {
  stopClock();
  try {
    await persistStretch();
  } catch { /* уход не должен упираться в отказ записи */ }
  state = null;
}

function stopClock() {
  if (state?.clock) {
    clearInterval(state.clock);
    state.clock = null;
  }
}

/**
 * Режим этой сессии: по ходу — только сегодняшняя (`sessionMode`).
 */
const modeOf = (workout) => sessionMode(workout, todayISO());

/**
 * Счётчик отдыха — сколько прошло с последней записи (решение атлета 05.11).
 * Он пассивный: считает вверх, без плановой длины, отсчёта и вибрации, и на
 * запись не влияет — отдых в подход пишется по меткам (`restForSet`). Метка
 * лежит в самой записи, поэтому после выгрузки PWA цифра верная. Только
 * у сегодняшней незакрытой сессии: у прошлой мерить нечего.
 */
function restCounter(workout) {
  if (modeOf(workout) !== 'live' || workout.status === 'done') return null;
  const sec = restBetween(workout.lastSetAt, Date.now());
  return sec == null ? null : `отдых ${fmtDuration(sec)}`;
}

async function save(box) {
  try {
    // Дописанный в закрытую сессию подход обязан менять средний RPE: на нём
    // стоит сигнал пересборки (правило 4, две сессии подряд с отклонением
    // ≥ 1,5), и он читал бы цифру, посчитанную до дописывания.
    if (state.workout.status === 'done') state.workout.avgRPE = averageRPE(state.workout);
    // Первое сохранение заводит запись: до первого действия её в базе нет.
    // Режим пишется тем же значением, что решает дата: его печатает журнал
    // («заполнено по ходу / после»), а поведение он больше не решает.
    if (state.workout.id == null && !state.workout.fillMode) {
      state.workout.fillMode = modeOf(state.workout);
    }
    const id = await putWorkout(state.workout);
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
      // Кнопка меняет поле так же, как палец: слушатели формы — подсказка
      // ячейки, взаимное гашение повторов и удержания — обязаны это увидеть.
      input.dispatchEvent(new Event('input', { bubbles: true }));
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
  // Раньше пустое состояние молча выходило до записи: снял все галочки,
  // нажал «Сохранить блок», кнопка написала «Записано», в дне ничего
  // не изменилось. Пишем всегда, когда блок этого дня открывали.
  if (!state.stretch) return;
  const iso = state.workout.date;
  const stored = await getDay(iso);
  // Записывать нечего и дня в базе нет — значит сессию только посмотрели.
  // Иначе просмотр плана на четверг заводил пустой день «задним числом»
  // (30.10 и 31.10 в бэкапе 29.10). Снятая галочка — это `false`, а не
  // пустота, так что «снял все и сохранил» по-прежнему пишется.
  if (!stored && !Object.keys(state.marks || {}).length
    && !Object.keys(state.secs || {}).length) return;
  const fresh = stored || { date: iso };
  fresh.stretch = { ...(fresh.stretch || {}), ...state.marks };
  fresh.stretchSec = { ...(fresh.stretchSec || {}), ...state.secs };
  if (iso !== todayISO()) fresh.backdated = true;
  await putDay(fresh);
}

/**
 * Закрытие сессии. `asIs` — «закрыть как есть» с экрана дня (решение атлета
 * 05.11): растяжку этого экрана никто не трогал, и `persistStretch` день
 * черновика не переписывает — иначе прошлый день получил бы метку «задним
 * числом» от одного касания.
 */
async function finish(box, { asIs = false } = {}) {
  const { workout } = state;
  if (!asIs) {
    try {
      await persistStretch();
    } catch (err) {
      box.prepend(el('div', {
        className: 'error',
        textContent: 'Блок растяжки не сохранён: ' + err.message,
      }));
      return;
    }
  }
  workout.avgRPE = averageRPE(workout);
  workout.status = 'done';
  // Повторное ЗАВЕРШИТЬ на переоткрытой сессии переписывало время окончания,
  // и часы печатали сутки: 1440:00 при отсчёте от первого подхода.
  // Сессия прошлой даты кончилась последним подходом, а не «сейчас»: черновик
  // 03.11, закрытый 05.11, иначе показал бы двое суток тренировки.
  if (!workout.finishedAt) {
    workout.finishedAt = workout.date < todayISO() && workout.lastSetAt
      ? workout.lastSetAt : new Date().toISOString();
  }
  if (!(await save(box))) return;
  stopClock();

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

  // Сессия только что дописана — момент, когда несохранённого больше всего.
  // Отказ чтения настроек не должен рушить экран закрытия: тренировка уже
  // в базе, а плашка здесь напоминание, а не часть записи.
  try {
    const settings = await getSettings();
    const note = backupNote({
      lastBackup: settings.lastBackup,
      hasRecords: true,
      today: todayISO(),
      onOpen: () => navigate('more', { section: 'data' }),
    });
    if (note) box.append(note);
    // Копии нет шесть дней и больше — отправка прямо здесь, одним касанием
    // (решение 29.10): данные только что дописаны, а до «Ещё → Данные» не доходят.
    if (sendDue(settings.lastBackup)) {
      // Тренировка уже в базе: файл готовится сейчас, касание сразу уходит в «Поделиться».
      const sendBackup = backupSender();
      const send = el('button', {
        className: 'go ghost', textContent: 'Отправить бэкап',
        onclick: async () => {
          try {
            const how = await sendBackup();
            send.textContent = how === 'cancelled' ? 'Не отправлено — ещё раз' : 'Бэкап отправлен';
            if (how !== 'cancelled' && note) note.remove();
          } catch (err) {
            send.textContent = 'Не отправлено: ' + err.message;
          }
        },
      });
      box.append(send);
    }
  } catch { /* без плашки, но с закрытой тренировкой */ }

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
    type: cardioType(workout),
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
      onclick: () => { if (at >= 0) return goTo(box, at); return undefined; },
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

  // Сделал блок целиком — «Завершить» встаёт сразу под ним (решение атлета
  // 05.11): блок — последний шаг, и до кнопки внизу экрана больше не листают.
  const allMarked = () => stretch.positions.every((p) => marks[p.n] === true);
  const wasAll = allMarked();
  box.append(stretchList(stretch.positions, guide, marks, secs, async () => {
    try { await persistStretch(); } catch { /* отметка остаётся в памяти */ }
    if (!wasAll && allMarked() && state) await draw(box);
  }));
  if (wasAll) finishButton(box);

  const splitInput = stretch.measureSplit
    ? el('input', { type: 'number', step: '0.5', inputMode: 'decimal', value: week.splitGap ?? '' })
    : null;
  // Неделя перечитывается перед записью: снимок, снятый при открытии сессии,
  // мог устареть, а запись объекта целиком затирала бы чужие поля молча.
  const saveSplit = async () => {
    const v = parseNum(splitInput.value);
    if (v == null) return;
    const iso = workout.date;
    const wk = (await getWeek(isoWeek(iso))) || { id: isoWeek(iso) };
    applySplit(wk, stretch, v, homeDone);
    await putWeek(wk);
    if (state) state.week = wk;
  };
  if (splitInput) {
    // Цифра пишется по вводу, как на отдельном экране растяжки (`stretch.js`):
    // здесь она уходила в базу только кнопкой «Сохранить блок», и просвет,
    // введённый перед ЗАВЕРШИТЬ, пропадал — а это объявленная цель года.
    splitInput.onchange = () => { saveSplit().catch(() => {}); };
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
        await persistStretch();
        if (splitInput) await saveSplit();
        e.target.textContent = 'Записано';
      } catch (err) {
        box.prepend(el('div', { className: 'error', textContent: 'Не сохранено: ' + err.message }));
      }
    },
  }));
}

/*
 * Кнопка завершения. Бонус и внеплановое в счётчик не входят.
 *
 * Слово «плановых» стоит не для красоты: на одном экране живут четыре разных
 * знаменателя — шаг очереди (в него входит хвост сессии), число упражнений
 * в списке (в него входит бонус), плановые упражнения и подходы внутри
 * текущего. Числа получались 8, 7, 6 и 3, и одинаково безымянные читались
 * как ошибка. Считает каждое своё — значит каждое и названо.
 */
function finishButton(box) {
  const { workout } = state;
  const required = requiredPairs(workout);
  const open = required.filter(({ e, p }) => !exerciseClosed(e, p));
  box.append(el('button', {
    className: 'wk-finish',
    textContent: `ЗАВЕРШИТЬ · плановых ${required.length - open.length} из ${required.length}`,
    // Незакрытое плановое сначала показывается списком (решение атлета 29.10):
    // пустое упражнение разбор читает «забыл», а это обычно «не успел».
    onclick: () => {
      if (open.length && !state.finishCheck) {
        state.finishCheck = true;
        return draw(box);
      }
      return finish(box);
    },
  }));
  if (state.finishCheck && open.length) box.append(finishCheck(box, open));
}

/** Сверка перед ЗАВЕРШИТЬ: незакрытые плановые с причинами в одно касание. */
function finishCheck(box, open) {
  const card = el('div', { className: 'group-card finish-check' });
  for (const { e, i } of open) {
    const quick = ['time', 'fatigue', 'declined'].map((k) => el('button', {
      type: 'button', className: 'chip', textContent: SKIP_KINDS[k],
      onclick: async () => {
        const before = { skipped: e.skipped, skipKind: e.skipKind, skipReason: e.skipReason };
        skipAs(e, k);
        if (!(await save(box))) { Object.assign(e, before); return; }
        return draw(box);
      },
    }));
    card.append(el('div', { className: 'finish-row' },
      el('button', {
        className: 'group-row', onclick: () => goTo(box, i),
      },
      el('span', { className: 'row-title', textContent: e.replacedWith || e.name }),
      el('span', { className: 'chev' })),
      el('div', { className: 'wk-chips' }, ...quick)));
  }
  return el('div', { className: 'wk-queue' },
    el('div', { className: 'group-cap', textContent: `не закрыто: ${open.length}` }),
    card,
    el('button', {
      className: 'go ghost', textContent: 'закрыть как есть',
      onclick: () => finish(box),
    }),
    el('button', {
      className: 'back', textContent: 'назад к заполнению',
      onclick: () => { state.finishCheck = false; return draw(box); },
    }));
}

function tailNav(box, index, total) {
  const { workout } = state;
  box.append(el('div', { className: 'wk-rest' }));
  box.append(el('div', { className: 'wk-nav' },
    el('button', {
      textContent: '←', disabled: index === 0,
      onclick: () => goTo(box, state.index - 1),
    }),
    el('button', {
      textContent: '→', disabled: index === total - 1,
      onclick: () => goTo(box, state.index + 1),
    })));

  box.append(el('button', {
    className: 'back', textContent: '← другая сессия',
    onclick: () => { leave(); navigate('workout', {}); },
  }));

  // Блок сделан целиком — «Завершить» уже стоит под ним (`drawStretch`).
  const blockDone = state.stretch && state.stretch.positions.every((p) => state.marks[p.n] === true);
  if (!blockDone) finishButton(box);
}

/**
 * Состояние экрана и его действия для вынесенных частей — обзора сессии
 * и выбора упражнения (`workout-overview.js`). Они читают и меняют `state`,
 * поэтому получают его явно, а обнулить могут только через `drop`.
 */
function screenCtx() {
  return {
    state, draw, goTo, save, persistStretch, weekCrumb, extraSteps,
    drop: () => { state = null; },
  };
}

/**
 * Ввод текста прямо на экране. Раньше заметка, замена и причина пропуска
 * спрашивались системным `prompt()` — это одна строка без переносов, в которой
 * длинную заметку не видно целиком и не поправить середину. Поле остаётся
 * на экране, пока не сохранишь или не отменишь.
 */
function textEditor(box, ex, kind, presc) {
  const CAPS = {
    note: 'заметка к упражнению',
    replace: 'чем заменяешь',
    skip: 'причина пропуска',
  };
  const value = kind === 'note' ? (ex.note || '')
    : (kind === 'replace' ? (ex.replacedWith || '') : '');
  const area = el('textarea', { className: 'wk-text', rows: 3, value });
  const wrap = el('div', { className: 'wk-editor' },
    el('div', { className: 'group-cap', textContent: CAPS[kind] }));
  if (kind === 'replace') {
    // Замена ставится касанием: из плана — его строками, из справочника — тем же
    // списком, что вставка (решение атлета 29.10). У замены из справочника есть
    // коэффициенты объёма и своя строка в «Силе». Вариант снаряда — в шапке.
    const replaceWith = async (name) => {
      const before = { replacedWith: ex.replacedWith, variant: ex.variant };
      ex.replacedWith = name;
      ex.variant = null;
      if (!(await save(box))) { Object.assign(ex, before); return; }
      state.textEdit = null;
      return draw(box);
    };
    // Замена по ошибке снимается, пока под ней нет подходов: записанное — уже её факт.
    if (ex.replacedWith && !(ex.sets || []).length) {
      wrap.append(el('button', {
        type: 'button', className: 'back', textContent: 'вернуть плановое',
        onclick: () => replaceWith(null),
      }));
    }
    const subs = presc.subs || presc.alt || [];
    if (subs.length) {
      wrap.append(el('div', { className: 'wk-chips' }, ...subs.map((t) => el('button', {
        type: 'button', className: 'chip', textContent: t, onclick: () => replaceWith(t),
      }))));
    }
    wrap.append(exercisePicker(box, screenCtx(), {
      onPick: replaceWith, cap: 'из справочника', exclude: ex.name,
    }));
    wrap.append(el('div', { className: 'group-cap', textContent: 'или своими словами' }));
  }
  // Пропуск: причина кнопкой (решение атлета 29.10). Время, усталость и «не стал»
  // пишутся касанием; сигнал здоровья ждёт слова «где»; перенос — сессию.
  // Текст в поле добавляется к любой причине.
  let picked = null;
  const commitSkip = async (k, moveTo = null) => {
    const before = {
      skipped: ex.skipped, skipKind: ex.skipKind, skipReason: ex.skipReason, skipMoveTo: ex.skipMoveTo,
    };
    skipAs(ex, k, area.value, moveTo);
    if (!(await save(box))) { Object.assign(ex, before); return; }
    state.textEdit = null;
    return afterTextEdit(box, 'skip');
  };
  if (kind === 'skip') {
    const targets = el('div', { className: 'group-card skip-move' });
    const chips = Object.entries(SKIP_KINDS).map(([k, label]) => el('button', {
      type: 'button', className: 'chip', textContent: label,
      onclick: () => {
        picked = k;
        for (const c of chips) c.classList.toggle('on', c.textContent === label);
        if (k === 'health' && !String(area.value || '').trim()) {
          area.placeholder = 'где — одним словом: локоть, шея, колено';
          return null;
        }
        if (k === 'move') {
          targets.innerHTML = '';
          const list = moveTargets(state.sessions, state.workout);
          if (!list.length) {
            targets.append(el('p', { className: 'hint', textContent: 'В ближайшую неделю силовых и навыковых нет.' }));
          }
          for (const t of list) {
            const label2 = `${weekdayShort(t.date)} ${dm(t.date)} ${t.code}`;
            targets.append(el('button', {
              className: 'group-row',
              onclick: () => commitSkip('move', { date: t.date, kind: t.kind, code: t.code, label: label2 }),
            },
            el('span', { className: 'row-title', textContent: label2 }),
            el('span', { className: 'row-value', textContent: t.title }),
            el('span', { className: 'chev' })));
          }
          return null;
        }
        return commitSkip(k);
      },
    }));
    wrap.append(el('div', { className: 'wk-chips' }, ...chips), targets);
  }
  wrap.append(area);
  wrap.append(el('div', { className: 'wk-actions' },
    el('button', {
      className: 'save', textContent: 'Сохранить',
      onclick: async () => {
        const v = String(area.value || '').trim();
        if (kind === 'note') ex.note = v;
        if (kind === 'replace') {
          ex.replacedWith = v || null;
          // Вариант снаряда относится к плановому упражнению, а не к замене.
          if (v) ex.variant = null;
        }
        if (kind === 'skip') {
          if (picked === 'health' && !v) {
            alert('Где? Одно слово: локоть, шея, колено.');
            return;
          }
          // Перенос без выбранной сессии — просто пропуск с текстом.
          return commitSkip(picked === 'move' ? null : picked);
        }
        if (!(await save(box))) return;
        state.textEdit = null;
        await afterTextEdit(box, kind);
      },
    }),
    el('button', {
      className: 'back', textContent: 'отмена',
      onclick: () => { state.textEdit = null; return draw(box); },
    })));
  return wrap;
}

/**
 * Что делать после сохранения текста. Пропуск закрывает упражнение — значит
 * уводит дальше сам: причина введена, а экран оставался на пропущенном,
 * и следующий шаг всё равно делался стрелкой.
 */
async function afterTextEdit(box, kind) {
  if (kind !== 'skip') return draw(box);
  return advance(box);
}

/**
 * Дальше — ближайшее незакрытое; всё закрыто — следующий шаг, а с последнего
 * никуда, чтобы «закрыл последнее» не выбрасывало на чужой шаг.
 */
function advance(box) {
  const { workout, index, extras } = state;
  const total = workout.exercises.length + (extras || []).length;
  const next = nextOpenAfter(workout, index);
  return goTo(box, next != null ? next : Math.min(index + 1, total - 1));
}

/**
 * Переход на другое упражнение. Режимы формы обязаны сбрасываться здесь,
 * а не «сами»: `editSet` и `warmup` переживали переход и относились уже
 * к чужому упражнению. Тап по подходу в тяге, стрелка на жим — и сохранение
 * переписывало первый подход жима вместо записи нового. Разминочный тумблер
 * тем же путём метил рабочий подход разминкой, а такой подход выпадает
 * из объёма, из среднего RPE и из записи дня целиком.
 */
/**
 * Отдых на контрольном лифте — выбор на упражнение (решение атлета 29.10):
 * «по плану · дольше · короче». Отклонение нужно, чтобы читать RPE, а секунды
 * по памяти в режиме «потом» не точны. Без касания — «по плану».
 */
function restFeelRow(box, ex) {
  const now = ex.restFeel || 'plan';
  return el('div', { className: 'rest-feel' },
    el('span', { className: 'rest-feel-cap', textContent: 'отдых' }),
    ...Object.entries(REST_FEEL).map(([k, label]) => el('button', {
      type: 'button', className: 'chip' + (k === now ? ' on' : ''), textContent: label,
      onclick: async () => {
        const before = ex.restFeel;
        ex.restFeel = k;
        if (!(await save(box))) { ex.restFeel = before; return; }
        return draw(box);
      },
    })));
}

/**
 * Вариант снаряда — кнопками в один тап (решение атлета 29.10). Для объёма,
 * «план закрыт» и целей это то же упражнение, веса и расчётный максимум —
 * своим рядом. «Основной» — снаряд из строки плана.
 */
function variantRow(box, ex, variants) {
  const now = ex.variant || null;
  return el('div', { className: 'rest-feel variant-row' },
    el('span', { className: 'rest-feel-cap', textContent: 'снаряд' }),
    ...[null, ...variants].map((v) => el('button', {
      type: 'button', className: 'chip' + (v === now ? ' on' : ''), textContent: v || 'основной',
      onclick: async () => {
        const before = ex.variant;
        ex.variant = v;
        if (!(await save(box))) { ex.variant = before; return; }
        return draw(box);
      },
    })));
}

/**
 * «Дальше» панели: ближайшее незакрытое, вперёд, а потом сверху (`nextOpen`).
 * Закрыто всё — к растяжке, если она хвостом сессии, иначе завершить:
 * тем же путём, что ЗАВЕРШИТЬ внизу экрана.
 */
function nextButton(box) {
  const { workout, index, extras } = state;
  // В круге закрылось одно, а у других ещё подходы: «дальше» — к ним, по кольцу
  // (06.11: планка закрылась, а «дальше» увело на разворот гири, махам
  // оставалось два подхода). Весь круг закрыт — как обычно.
  const open = roundMates(workout, index)
    .filter((j) => !exerciseClosed(workout.exercises[j], workout.prescription[j] || {}));
  const to = open.length ? (open.find((j) => j > index) ?? open[0]) : nextOpen(workout, index);
  const tail = (extras || []).length ? workout.exercises.length : null;
  const go = (text, onclick) => el('button', { className: 'wk-next', textContent: text, onclick });
  if (to != null) return go(`дальше: ${doneName(workout.exercises[to])}`, () => goTo(box, to));
  if (tail != null) return go('к растяжке', () => goTo(box, tail));
  // «Завершить» встаёт на место ✓ сразу после записи последнего подхода, и
  // второе касание двойного тапа закрывало сессию (решение атлета 06.11).
  return go('завершить', () => {
    if (Date.now() - (state.recordedAt || 0) < DOUBLE_TAP_MS) return;
    return finish(box);
  });
}

/**
 * Круг под именем — кнопками со счётом «Махи 2/4» (замечание атлета 06.11):
 * видно, кто в круге и сколько у каждого осталось, а прыжок к любому — одно
 * касание в любом порядке, без стрелок «назад, назад». Текущее подсвечено.
 */
function roundLine(box, workout, index) {
  const mates = roundMates(workout, index);
  if (!mates.length) return null;
  const members = [index, ...mates].sort((a, b) => a - b);
  return el('div', { className: 'wk-round' },
    el('span', { className: 'wk-round-cap', textContent: 'круг' }),
    ...members.map((j) => {
      const e = workout.exercises[j];
      const p = workout.prescription[j] || {};
      const done = (e.sets || []).filter((x) => !x.warmup).length;
      const closed = exerciseClosed(e, p);
      return el('button', {
        type: 'button',
        className: 'chip' + (j === index ? ' on' : '') + (closed ? ' closed' : ''),
        textContent: `${shortName(doneName(e)).short} ${done}/${p.sets || '—'}`,
        onclick: j === index ? null : () => goTo(box, j),
      });
    }));
}

/** Окно двойного касания: столько «завершить» не слышит после записи. */
const DOUBLE_TAP_MS = 600;

function goTo(box, index) {
  state.index = index;
  state.editSet = null;
  state.warmup = false;
  state.control = null;
  state.failure = false;
  state.finishCheck = false;
  state.insertAt = null;
  state.textEdit = null;
  state.showInfo = false;
  // Метка начала подхода принадлежит упражнению, с которого уходишь: иначе
  // отдых первого подхода на новом упражнении закрылся бы касанием, сделанным
  // на прошлом, и оказался бы короче настоящего.
  state.setStartedAt = null;
  return draw(box);
}

async function draw(box) {
  box.innerHTML = '';
  if (!state) return;

  // Обзор — по кнопке «весь план»: сессия открывается сразу упражнением,
  // развилки режима на входе больше нет (решение атлета 05.11).
  // Всё убрано — тоже обзор: вернуть убранное можно только оттуда, а ветка
  // «Пока пусто» ниже — для сессии вне плана, и её «отменить заполнение»
  // удаляет запись целиком, закрытую тоже.
  const allRemoved = !state.workout.exercises.length && (state.workout.removed || []).length > 0;
  // Обзор держится и после возврата первого убранного: иначе экран
  // перескакивал на вернувшееся упражнение, и остальные возвращать — заново.
  if (allRemoved) state.showOverview = true;
  if (state.showOverview) {
    await drawOverview(box, screenCtx());
    return;
  }

  const { workout, index } = state;
  const mode = modeOf(workout);
  const extras = state.extras || [];
  const total = workout.exercises.length + extras.length;

  // Сессия вне плана начинается пустой: её содержание — то, что реально
  // сделал. Побегал в субботу, доделал навыки — записать это было некуда.
  if (!workout.exercises.length) {
    const dd = workout.date;
    box.append(el('div', { className: 'wk-head' },
      el('div', {
        className: 'wk-crumbs',
        textContent: `${weekdayShort(dd)} ${dm(dd)}`
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
    if (state.insertAt != null) box.append(exercisePicker(box, screenCtx()));

    box.append(el('button', {
      className: 'back', textContent: '← другая сессия',
      onclick: () => { leave(); navigate('workout', {}); },
    }));
    box.append(el('button', {
      className: 'back danger', textContent: 'отменить заполнение',
      onclick: async () => {
        if (!confirm('Удалить пустую сессию?')) return;
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
        textContent: `${weekCrumb(workout)}${workout.dayCode} · шаг ${index + 1}/${total}`,
      }),
      el('h2', { textContent: step.title })));
    bonusBanner(box);
    await drawStretch(box);
    tailNav(box, index, total);
    return;
  }

  // Строка плана слота: по ней считается «план закрыт», из неё форма замены
  // берёт варианты. Доза того, что делается сейчас, — `dose` ниже.
  const plan = workout.prescription[index] || {};
  const ex = workout.exercises[index];
  // Подходов набрано столько, сколько в плане — значит пора дальше,
  // и кнопка перехода это показывает.
  const workingSets = (ex.sets || []).filter((x) => !x.warmup).length;
  const planned = Number(plan.sets) || 0;
  const ready = !ex.skipped && exerciseClosed(ex, plan);
  const last = index === total - 1;
  // История — того, что делается сейчас: у заменённого упражнения это замена.
  const history = await historyFor(doneName(ex), workout.id, workout.date,
    ex.replacedWith ? null : ex.variant);
  const prev = history.length ? history[history.length - 1] : null;
  // Справочник — того, что делается: у замены свой эталон, тренажёр и мера.
  const guide = state.guide.get(doneName(ex));
  // У замены своя доза: из плана — только число подходов (`effectivePresc`).
  const dose = effectivePresc(plan, ex, guide);
  // Модель тренажёра — из строки плана, а без неё — из справочника: скручивания
  // делаются в Hoist, хотя план называет блок стоя.
  const machineModel = dose.machine
    || (guide && guide.machine ? guide.machine.model : null);
  const past = lastSession(history);

  // «5×удержание 25–35 с» слипается в нечитаемое: множитель без пробелов
  // годится только для коротких числовых повторов вроде «4×5».
  const shortReps = /^[\d\s–—-]+$/.test(String(dose.reps ?? ''));
  const planLine = dose.replaced ? insteadLine(dose)
    : `план ${dose.sets}${shortReps ? '×' : ' × '}${dose.reps}`
    + (dose.rpe != null ? ` · RPE ${fmtNum(dose.rpe, 1)}` : '')
    + (dose.weight ? ` · ${dose.weight}` : '')
    // Плановый отдых виден до подхода, а не только таймером после него.
    + (dose.rest > 0 ? ` · отдых ${fmtDuration(dose.rest)}` : '');

  // Полоса меряется подходами, а не упражнениями: по упражнениям она стояла
  // на нуле всё первое из них, и пустой трек читался разделителем, а не шкалой.
  // Сама арифметика живёт рядом с `exerciseClosed` — там, где объявлено,
  // что значит «план закрыт».
  const { percent: progress } = setProgress(workout);

  // Шапка одной строкой (решение атлета 05.11): весь план, дата, день, шаг —
  // поля ввода видны на первом экране. Дата стоит в ней всегда: в зале
  // открывают несколько дней подряд, и без неё непонятно, какой заполняешь.
  const d = workout.date;
  box.append(el('div', { className: 'wk-top' },
    el('button', {
      className: 'wk-overview', textContent: '‹ весь план',
      onclick: () => { state.showOverview = true; return draw(box); },
    }),
    el('button', {
      className: 'wk-date',
      textContent: `${weekdayShort(d)} ${dm(d)}` + (d === todayISO() ? ' · сегодня' : ''),
      onclick: () => navigate('day', { date: d }),
    }),
    el('span', {
      className: 'wk-crumbs',
      textContent: `${weekCrumb(workout)}${workout.dayCode} · ${index + 1}/${total}`
        + (workout.movedFrom ? ` · перенос с ${dm(workout.movedFrom)}` : '')
        + (workout.backdated ? ' · задним числом' : '')
        + (workout.status === 'done' ? ' · записана' : ''),
    }),
    // Часы тренировки — только у сегодняшней сессии: у прошлой они считали бы
    // от первого подхода до «сейчас».
    workoutElapsed(workout) != null && mode === 'live'
      ? el('span', { className: 'wk-clock', textContent: fmtClock(workoutElapsed(workout)) })
      : null));

  // Имя — короткое: уточнения плана («разминка без лямок…») уходят под
  // «снаряд, видео». Под именем одна строка: план и прошлый раз. У варианта
  // снаряда имя, эталон и тренажёр — его собственные (`shownExercise`).
  const shown = shownExercise(ex, state.guide);
  const { name } = shown;
  const planText = dose.unplanned || ex.unplanned
    // Перенесённое из другой сессии — «вне плана», но со своей плановой дозой.
    ? (dose.movedFrom
      ? `перенос с ${weekdayShort(dose.movedFrom)} ${dm(dose.movedFrom)} · ${planLine}` : 'вне плана')
    : planLine;
  box.append(el('div', { className: 'wk-head' },
    el('h2', { textContent: name.short }),
    el('div', { className: 'wk-line' },
      el('span', { className: 'wk-plan', textContent: planText }),
      el('span', { className: 'wk-sep', textContent: ' · ' }),
      el('span', {
        className: 'wk-prev',
        textContent: past ? prevSessionLine({
          date: past.date,
          sets: past.sets,
          perSide: weightPerHand(dose),
          repsSide: repsPerSide(dose),
          cellOf: (v, s) => cellHint(machineModel, v, s && s.cell),
          measure: dose.measure,
        }) : 'первый раз',
      }),
      dose.control ? el('span', { className: 'wk-control', textContent: ' · контрольный подход' }) : null),
    // Выбор «по плану · дольше · короче» — только у прошлой даты: сегодня
    // отдых якорного лифта меряется метками (решение атлета 05.11).
    dose.anchor && workout.kind !== 'cardio' && mode === 'later' ? restFeelRow(box, ex) : null,
    roundLine(box, workout, index),
  ));

  // Строка действий под именем: справочное свёрнуто, заметка, замена и «не делал»
  // открывают поле на экране (`textEditor`).
  const toggleEdit = (kind) => () => {
    state.textEdit = state.textEdit === kind ? null : kind;
    return draw(box);
  };
  box.append(el('div', { className: 'wk-acts' },
    el('button', {
      className: 'wk-info' + (state.showInfo ? ' on' : ''),
      textContent: state.showInfo ? 'снаряд, видео ▴' : 'снаряд, видео ▾',
      onclick: () => { state.showInfo = !state.showInfo; return draw(box); },
    }),
    el('button', {
      className: state.textEdit === 'note' ? 'on' : '', textContent: 'заметка', onclick: toggleEdit('note'),
    }),
    el('button', {
      className: state.textEdit === 'replace' ? 'on' : '', textContent: 'замена', onclick: toggleEdit('replace'),
    }),
    el('button', {
      className: state.textEdit === 'skip' ? 'on' : '',
      textContent: 'не делал',
      // У бонуса причина всегда одна — «это доп», и спрашивать её — пустой
      // шаг (решение 23.09). На основных причину читает разбор план-факт.
      onclick: async () => {
        if (plan.optional) {
          ex.skipped = true;
          ex.skipReason = 'доп';
          if (!(await save(box))) return;
          state.textEdit = null;
          return afterTextEdit(box, 'skip');
        }
        return toggleEdit('skip')();
      },
    })));

  // Справочное — по касанию: уточнение имени, зона, снаряд, тренажёр, эталон.
  // Зона усилия — из плана (пишет генератор цикла): класс упражнения меняется
  // вместе с циклом, в коде его нет. Эталон стоит там, где делаешь движение:
  // за двумя переходами в справочнике его не открывал никто.
  if (state.showInfo) {
    box.append(el('div', { className: 'wk-info-box' },
      name.detail ? el('div', { className: 'wk-detail', textContent: name.detail }) : null,
      dose.zone ? el('div', { className: 'wk-zone', textContent: dose.zone }) : null,
      (dose.variants || []).length && !ex.replacedWith ? variantRow(box, ex, dose.variants) : null,
      shown.guide && shown.guide.machine && (machineModel || shown.guide !== guide)
        ? el('p', { className: 'machine-hint', textContent: `${shown.guide.machine.model}: ${shown.guide.machine.hint}` })
        : null,
      dose.plus ? el('div', { className: 'wk-gate', textContent: PLUS_GATE }) : null,
      shown.guide ? etalonBlock(shown.guide)
        : (ex.variant && !ex.replacedWith
          ? el('p', { className: 'hint', textContent: 'У этого снаряда своего эталона в справочнике нет.' })
          : null)));
  }

  if (state.textEdit) box.append(textEditor(box, ex, state.textEdit, plan));

  bonusBanner(box);

  // Полоса прогресса сессии: между подходами читается боковым зрением,
  // когда на «5 из 8» смотреть некогда.
  const bar = el('div', { className: 'wk-bar' });
  const fill = el('span', { className: 'wk-bar-fill' });
  fill.style.width = progress + '%';
  bar.append(fill);
  box.append(bar);

  if (ex.note) box.append(el('div', { className: 'wk-note', textContent: ex.note }));

  // Нижняя панель (решение атлета 05.11): главная кнопка и вторая по состоянию.
  let dockMain = null;
  let dockAlt = null;
  let dockMore = null;

  if (ex.skipped) {
    box.append(el('p', { className: 'skipped', textContent: `Пропущено: ${ex.skipReason}` }));
    box.append(el('button', {
      textContent: 'Вернуть в работу',
      onclick: async () => {
        ex.skipped = false; ex.skipReason = null;
        delete ex.skipKind;
        delete ex.skipMoveTo;
        if (await save(box)) draw(box);
      },
    }));
  } else {
    const list = el('ol', { className: 'wk-sets' });
    // Полоса под подходом сравнивает нагрузку внутри упражнения: самый лёгкий
    // подход — 40 % ширины, самый тяжёлый — вся ширина.
    const loads = ex.sets.map((s) => s.weight ?? s.reps ?? s.sec ?? 0);
    const lo = Math.min(...loads);
    const hi = Math.max(...loads);
    const share = (v) => (hi === lo ? 1 : 0.4 + 0.6 * ((v - lo) / (hi - lo)));
    // Разминочные показываются сверху независимо от порядка записи: их часто
    // вносят после рабочих, вспомнив. В базе порядок остаётся хронологическим —
    // на нём стоит расчёт отдыха по меткам времени.
    const ordered = orderedSets(ex.sets);

    ordered.forEach(({ s, i }, pos) => {
      const marks = [s.warmup ? 'разм.' : null, s.control ? 'контроль' : null,
        s.failure ? 'отказ' : null].filter(Boolean).join(' · ');
      const line = s.minutes != null
        ? `${fmtWeight(s.minutes)} мин · ${fmtWeight(s.km)} км`
          + (s.hr != null ? ` · пульс ${s.hr}` : '')
        : null;
      const cellMark = cellHint(machineModel, s.weight, s.cell);
      // Вес тела — «в/т», как в журнале и своде: прочерк на месте веса
      // читается пропуском данных, а не отсутствием отягощения.
      // Ноль в записях до 29.10 — тот же вес тела.
      const wText = !s.weight ? 'в/т' : fmtWeight(s.weight);
      const text = line || `${wText}${cellMark ? ` ${cellMark}` : ''} × ${setAmount(s)}`
        + (s.measure != null ? `   ${measureText(dose.measure, s.measure)}` : '')
        + (s.rpe != null ? `   RPE ${fmtNum(s.rpe, 1)}` : '')
        + (s.rest != null ? `   отдых ${s.restManual ? '~' : ''}${fmtDuration(s.rest)}` : '')
        + (s.transition != null ? `   переход ${s.transitionManual ? '~' : ''}${fmtDuration(s.transition)}` : '')
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
          state.control = null;
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
            // Номер берётся с экрана: после сортировки разминочных наверх
            // индекс в базе и строка в списке — разные числа, и диалог
            // называл чужой подход.
            if (!confirm(`Удалить подход ${pos + 1}: ${text}?`)) return;
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
    // Правка записанного: тап по строке подхода подставляет его в форму.
    // Раньше ошибку можно было только удалить и записать заново.
    const editing = state.editSet != null && ex.sets[state.editSet] ? ex.sets[state.editSet] : null;
    // Позиция правимого подхода на экране: список отсортирован разминочными
    // наверх, и номер в базе с номером в списке не совпадает.
    // Тем же порядком, что и список выше: два компаратора разъехались бы
    // на первой же правке, и кнопка называла бы чужой номер подхода.
    const editingPos = editing
      ? orderedSets(ex.sets).findIndex(({ i }) => i === state.editSet)
      : -1;
    // Удержание живёт своим полем, а не повторами: у Ролика в одном упражнении
    // и то, и другое («3×8 + 2×15 с»), и признак стоит у подхода, не у плана.
    // Подход с удержанием (`holdSec` или `hold` в плане, ролик Ц4 и Ц5) — обе цифры сразу.
    const combined = isHoldSet(dose);
    const holds = workout.kind !== 'cardio' && (Boolean(guide && guide.sec) || combined);
    // У замены доза своя (`effectivePresc`): плановые 54,4 кг тяги в жим гири
    // не идут. У варианта снаряда доза плановая, а вес — нет: 13,6 кг
    // кроссовера гантелям не подходят.
    const own = ex.variant && !ex.replacedWith ? { ...dose, weight: null } : dose;
    const d = editing || nextSetDefaults(own, ex.sets, history, { hold: holds });
    // Стопка в фунтах по номеру плиты (Hoist): вводится ячейка, в подход
    // пишутся ячейка и вес по шкале (решение атлета 29.10). Kraft и Хаммер
    // подписаны в килограммах — у них поле веса обычное.
    const scale = !cardio && machineModel ? MACHINES[machineModel] || null : null;
    const cellOfSet = (s) => (s.cell != null ? s.cell : (cellFor(machineModel, s.weight) || {}).cell ?? null);
    const weightLabel = cardio ? 'минуты'
      : (scale ? 'ячейка' : (weightPerHand(dose) ? 'вес на руку' : 'вес'));
    const repsLabel = cardio ? 'км' : (repsPerSide(dose) ? 'повт на сторону' : 'повт');
    // У упражнений с весом тела поле веса пустует и мешает: шаг ±1,25 к нему
    // не относится. Показываем по требованию — жилет и пояс никуда не делись.
    // Число в плане держит поле всегда: 24.09 становую пришлось вносить через
    // жилет, потому что в истории лежала гиперэкстензия без веса.
    const bodyweight = !scale && bodyweightForm(dose, d, cardio, history);
    // У кардио время и дистанция лежат в minutes/km, а не в weight/reps.
    // Правка забега открывалась с пустыми полями и сохраняла в них null —
    // время и километры стирались, а logCardioFromWorkout разносил нули в день.
    const wStep = cardio ? 0.5 : (scale ? 1 : 1.25);
    const wInput = el('input', {
      type: 'number', step: String(wStep), inputMode: scale ? 'numeric' : 'decimal',
      value: (cardio ? d.minutes : (scale ? cellOfSet(d) : d.weight)) ?? '', className: 'wk-w',
    });
    const rInput = el('input', {
      type: 'number', step: cardio ? '0.1' : '1', inputMode: 'decimal',
      value: (cardio ? d.km : d.reps) ?? '', className: 'wk-r',
    });
    const sInput = holds ? el('input', {
      type: 'number', step: '1', inputMode: 'decimal',
      value: d.sec ?? '', className: 'wk-sec',
    }) : null;
    // Своя мера из плана (решение атлета 29.10): ролик — «стена, см», отжимания
    // у стены — «стопка, см». Прогрессия навыка идёт ею, когда повторы стоят.
    const ownMeasure = !cardio && own.measure ? own.measure : null;
    const mInput = ownMeasure ? el('input', {
      type: 'number', step: '1', inputMode: 'decimal',
      value: d.measure ?? '', className: 'wk-measure',
    }) : null;
    // RPE — у всех силовых, навыкам нет, кардио пишет пульс (`asksRPE`).
    const rpeOn = asksRPE(dose, ex, workout.kind);
    const hrInput = rpeOn && cardio ? el('input', {
      type: 'number', step: '1', inputMode: 'decimal', value: d.hr ?? '', className: 'wk-rpe',
    }) : null;
    // RPE силовых — кнопками, одним касанием без клавиатуры (решение атлета
    // 05.11). Выбор — состояние экрана: он переживает перерисовку (заметка,
    // замена) и заводится заново на каждом новом подходе — с прошлого подхода
    // этой тренировки, а у первого пусто (`nextSetDefaults`, решение 29.10:
    // подставленное число сохранялось нетронутым и выдавало план за оценку).
    // План — контуром, а не выбором.
    const rpeGrid = rpeOn && !cardio;
    const formKey = `${index}:${state.editSet}:${ex.sets.length}`;
    if (rpeGrid && state.rpeKey !== formKey) {
      state.rpeKey = formKey;
      state.rpePick = d.rpe ?? null;
    }
    const rpeBtns = [];
    const paintRpe = () => {
      for (const [v, b] of rpeBtns) b.classList.toggle('on', v === state.rpePick);
    };
    const outline = rpeGrid ? rpeOutline(dose.rpe) : [];
    const rpeBlock = rpeGrid ? el('div', { className: 'wk-rpe-grid' },
      el('span', { className: 'rpe-cap', textContent: 'RPE' }),
      ...RPE_ROWS.map((row) => el('div', { className: 'rpe-row' }, ...row.map((v) => {
        const b = el('button', {
          type: 'button',
          className: 'rpe-btn' + (outline.includes(v) ? ' plan' : ''),
          textContent: fmtWeight(v),
          // Повторное касание выбранной снимает выбор: ошибся — не «перебивай».
          onclick: () => { state.rpePick = state.rpePick === v ? null : v; paintRpe(); },
        });
        rpeBtns.push([v, b]);
        return b;
      })))) : null;
    paintRpe();
    // Пауза подхода: первый подход упражнения несёт переход от прошлого
    // упражнения, остальные — отдых (решение атлета 26.09). У кардио паузы нет.
    const pause = cardio ? null : restKind(index, editing ? state.editSet : ex.sets.length);
    const pauseKey = pause === 'transition' ? 'transition' : 'rest';
    // Поле отдыха — только там, где его нечем измерить (решение атлета 05.11).
    // Сегодня отдых пишут метки, и ошибочная цифра правится правкой записанного
    // подхода. У прошлой даты поле — единственный источник цифры, кроме
    // контрольных лифтов: у них отдых выбором на упражнение (`restFeelRow`),
    // по памяти секунды не точны.
    const restField = Boolean(pause) && !(dose.anchor && mode === 'later')
      && (Boolean(editing) || mode === 'later');
    const restWas = editing && editing[pauseKey] != null ? String(editing[pauseKey]) : '';
    const restInput = !restField ? null : el('input', {
      type: 'number', step: '5', inputMode: 'numeric', className: 'wk-restin',
      value: restWas,
      // Плейсхолдер живёт в поле с кеглем 34 px: длинная фраза обрывалась
      // на середине. Слово короткое, мелкий кегль ему задан отдельным правилом.
      placeholder: 'не записан',
    });

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

    // Метка контроля — переключателем (решение атлета 26.09). Сама она встаёт
    // на первый рабочий подход, но 26.09 первый подход подтягиваний облегчён
    // до 24 кг, и тестом Н4 стал бы он, а не подход с +32. Выключил — метка
    // ждёт подхода, на котором её включат; в упражнении она одна.
    if (state.control == null) {
      state.control = editing ? Boolean(editing.control) : isControlSet(dose, ex.sets, state.warmup);
    }
    const ctlToggle = dose.control ? el('button', {
      className: 'ctl-toggle' + (state.control ? ' on' : ''),
      textContent: 'контрольный',
      onclick: () => {
        state.control = !state.control;
        ctlToggle.classList.toggle('on', state.control);
      },
    }) : null;

    // «До отказа» (решение атлета 29.10) — калибровочный отказ правила 4:
    // раз в цикл один подход изоляции до истинного отказа. Пишется признаком
    // `failure` и RPE 10; выключил — возвращается прежний выбор.
    if (editing) state.failure = Boolean(editing.failure);
    let rpeBefore = state.rpePick;
    const failToggle = rpeGrid ? el('button', {
      className: 'fail-toggle' + (state.failure ? ' on' : ''),
      textContent: 'до отказа',
      onclick: () => {
        state.failure = !state.failure;
        failToggle.classList.toggle('on', state.failure);
        if (state.failure) { rpeBefore = state.rpePick; state.rpePick = 10; } else state.rpePick = rpeBefore;
        paintRpe();
      },
    }) : null;

    const weightRow = el('label', {}, weightLabel,
      stepper(wInput, -wStep), wInput, stepper(wInput, wStep));
    const form = el('div', { className: 'wk-form' },
      bodyweight ? null : weightRow,
      el('label', {}, repsLabel,
        stepper(rInput, cardio ? -0.1 : -1), rInput, stepper(rInput, cardio ? 0.1 : 1)),
      sInput ? el('label', {}, 'удержание, с',
        stepper(sInput, -5), sInput, stepper(sInput, 5)) : null,
      mInput ? el('label', {}, `${ownMeasure.label}, ${ownMeasure.unit}`,
        stepper(mInput, -1), mInput, stepper(mInput, 1)) : null,
      hrInput ? el('label', {}, 'пульс', stepper(hrInput, -1), hrInput, stepper(hrInput, 1)) : null,
      // «Разминочный», «до отказа», «контрольный» — над RPE (решение 05.11):
      // это свойства подхода, который сейчас оцениваешь.
      el('div', { className: 'wk-actions' }, warmToggle, ctlToggle, failToggle),
      rpeBlock,
      restInput ? el('label', { className: 'rest-row' },
        pause === 'transition' ? 'переход, с' : 'отдых, с', restInput) : null,
    );
    // Меры взаимно исключают друг друга, и видно это должно быть в форме,
    // а не при записи. Секунды переносятся с прошлого подхода, как вес
    // и повторы; у Ролика следом идут подходы в повторах — набранные поверх
    // непустого удержания они молча пропадали бы, потому что удержание
    // побеждает. Теперь одно поле гасит другое на глазах.
    if (sInput && !combined) {
      rInput.addEventListener('input', () => { if (rInput.value !== '') sInput.value = ''; });
      sInput.addEventListener('input', () => { if (sInput.value !== '') rInput.value = ''; });
    }

    // Отдых закрывается первым касанием формы, а не записью подхода: между
    // ними лежит сам подход, и раньше он попадал в «отдых» целиком. Метка
    // ставится один раз и только при заполнении по ходу — правка записанного
    // задним числом ничего закрывать не должна.
    if (mode === 'live' && !editing) {
      const touch = () => {
        if (state.setStartedAt) return;
        state.setStartedAt = new Date().toISOString();
      };
      for (const sel of ['input', 'button']) {
        for (const node of form.querySelectorAll(sel)) {
          node.addEventListener('focus', touch);
          node.addEventListener('pointerdown', touch);
        }
      }
    }
    // Чипы «план» и «прошлый» (решение атлета 29.10): подстановка берёт план,
    // прошлый раз ставится одним касанием. RPE чип не трогает — это оценка.
    const chips = editing || cardio ? [] : fillChips(own, history, { hold: holds });
    if (chips.length) {
      const put = (input, v) => {
        if (!input) return;
        input.value = v == null ? '' : String(v);
        // Как степпер: подсказка ячейки и гашение повторов удержанием слушают ввод.
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      box.append(el('div', { className: 'wk-chips' }, ...chips.map((c) => {
        const hit = scale && c.cell == null ? cellFor(machineModel, c.weight) : null;
        const shown = hit && hit.exact ? { ...c, cell: hit.cell } : c;
        return el('button', {
          type: 'button', className: 'chip', textContent: chipText(shown),
          onclick: () => {
            // Вес тела в прошлом подходе очищает поле, план без числа его не трогает.
            if (c.weight != null) put(wInput, scale ? (c.cell ?? (hit ? hit.cell : null)) : c.weight);
            else if (c.kind === 'last') put(wInput, null);
            if (c.reps != null) put(rInput, c.reps);
            if (c.sec != null) put(sInput, c.sec);
          },
        });
      })));
    }
    box.append(form);

    if (bodyweight) {
      const addWeight = el('button', {
        className: 'add-weight', textContent: '+ вес (жилет, пояс)',
        onclick: () => { form.prepend(weightRow); addWeight.remove(); },
      });
      box.append(addWeight);
    }

    if (scale) {
      // Под ячейкой — вес, который уйдёт в базу: опечатку в номере видно
      // до записи, а не в своде.
      const kgNow = () => {
        const n = parseNum(wInput.value);
        if (n == null) return '';
        const kg = cellKg(machineModel, n);
        return kg != null ? `= ${fmtWeight(kg)} кг` : `ячейки ${fmtWeight(n)} нет: 1–${scale.length}`;
      };
      const cellLine = el('p', { className: 'machine-cell', textContent: kgNow() });
      wInput.addEventListener('input', () => { cellLine.textContent = kgNow(); });
      box.append(cellLine);
    }

    // План закрыт — запись уходит во вторую кнопку панели «+ подход»: она стояла
    // на месте кнопки, по которой только что стучали N раз (решение 29.10),
    // а главной становится «дальше» (решение атлета 05.11).
    const closedNow = !editing && exerciseClosed(ex, plan);
    const recordBtn = el('button', {
      className: 'wk-add' + (editing ? ' editing' : (closedNow ? ' extra' : '')),
      onclick: async (e) => {
        // Двойной тап писал второй подход: `push` идёт синхронно до `await
        // save`, а кнопка не блокировалась. В журнале это выглядит не ошибкой,
        // а честными двумя подходами — `foldSets` их склеит, — и тихо смещает
        // недельный объём, средний RPE и точку «план закрыт».
        const btn = e && e.target;
        if (btn && btn.disabled) return;
        if (btn) btn.disabled = true;
        const warmup = state.warmup;
        // Ручным отдых считается, только когда поле реально тронули. Раньше
        // оно предзаполнялось измеренным значением, поэтому `manual` был
        // непустым всегда, и любая правка повторов помечала измеренный отдых
        // вспомненным — ровно то разделение, ради которого он и заводился.
        const restNow = restInput ? String(restInput.value ?? '') : '';
        const restTouched = Boolean(restInput) && restNow !== restWas;
        const manual = restTouched ? parseNum(restNow) : null;
        const measured = restForSet({
          mode, lastSetAt: state.lastSetAt, now: Date.now(), manual,
          startedAt: state.setStartedAt,
        });
        // У первого упражнения сессии паузы нет вовсе; у первого подхода
        // остальных цифра уходит в переход, а не в отдых.
        const none = { rest: null, restManual: false, restToStart: false };
        const { rest, restManual, restToStart } = pause === 'rest' ? measured : none;
        const trans = pause === 'transition' ? measured : none;
        const measure = setMeasure({
          reps: parseNum(rInput.value),
          sec: sInput ? parseNum(sInput.value) : null,
          combined,
        });
        const control = Boolean(dose.control) && !warmup && Boolean(state.control);
        const failure = Boolean(failToggle) && Boolean(state.failure) && !warmup;
        // На стопке Hoist в поле — номер ячейки; в базу идут он и вес по шкале.
        let weight = cardio ? null : parseNum(wInput.value);
        let cell = null;
        if (scale && weight != null) {
          cell = weight;
          weight = cellKg(machineModel, cell);
          if (weight == null) {
            alert(`Ячейки ${fmtWeight(cell)} нет: у ${machineModel} их ${scale.length}.`);
            if (btn) btn.disabled = false;
            return;
          }
        }
        const set = cardio ? {
          minutes: parseNum(wInput.value),
          km: parseNum(rInput.value),
          hr: parseNum(hrInput.value),
          weight: null,
          reps: null,
          rpe: null,
          rest: null,
          warmup: false,
          control: Boolean(dose.control),
        } : {
          weight,
          ...(cell != null ? { cell } : {}),
          ...(mInput && parseNum(mInput.value) != null ? { measure: parseNum(mInput.value) } : {}),
          // Мера у подхода одна: заполненное удержание отменяет повторы.
          // Иначе стойка на 30 секунд уехала бы в базу ещё и «25 повторами»,
          // подставленными из плановой строки «удержание 25–35 с».
          // Подход с удержанием хранит обе цифры (`setMeasure`).
          reps: measure.reps,
          sec: measure.sec,
          rpe: failure ? 10 : (rpeGrid ? state.rpePick : null),
          ...(failure ? { failure: true } : {}),
          rest,
          restManual: restManual || undefined,
          // Признак меры отдыха: `true` — чистый отдых до начала подхода,
          // отсутствует — прежний интервал между записями. Ряды Н1–Н3
          // и последующих недель по нему и различаются.
          restToStart: restToStart || undefined,
          transition: trans.rest ?? undefined,
          transitionManual: trans.restManual || undefined,
          warmup,
          control,
        };

        // Невозможное не пишется, похожее на опечатку переспрашивается.
        const checked = checkSetInput(set, { cardio });
        if (checked.block) {
          alert(checked.block);
          if (btn) btn.disabled = false;
          return;
        }
        for (const q of checked.ask) if (confirm(q.msg)) Object.assign(checked.set, q.fix);
        Object.assign(set, checked.set);

        if (editing) {
          const i = state.editSet;
          const before = ex.sets[i];
          // Правка не трогает ни измеренный отдых, ни метку контрольного
          // подхода: они относятся к моменту записи, а не к введённым цифрам.
          // Тронутое поле отдыха при этом слушается в обе стороны — очищенное
          // стирает цифру, иначе ошибочные 900 секунд было не убрать.
          const manualKey = pauseKey === 'transition' ? 'transitionManual' : 'restManual';
          const restPatch = !restTouched || !restField ? {}
            : (manual == null
              ? { [pauseKey]: null, [manualKey]: undefined }
              : { [pauseKey]: Math.round(manual), [manualKey]: true });
          ex.sets[i] = {
            ...before,
            weight: set.weight, reps: set.reps, sec: set.sec, rpe: set.rpe,
            minutes: set.minutes, km: set.km, hr: set.hr,
            warmup: set.warmup,
            ...(scale ? { cell: set.cell } : {}),
            ...(mInput ? { measure: set.measure } : {}),
            ...(failToggle ? { failure: set.failure } : {}),
            ...restPatch,
          };
          if (dose.control) markControl(ex.sets, i, set.control);
          if (!(await save(box))) {
            ex.sets[i] = before;
            // Без перерисовки кнопка осталась бы заблокированной навсегда,
            // и отказ записи превратился бы в невозможность записать.
            if (btn) btn.disabled = false;
            return;
          }
          state.editSet = null;
          state.warmup = false;
          state.control = null;
          state.failure = false;
          await draw(box);
          return;
        }

        ex.sets.push(set);
        if (set.control) markControl(ex.sets, ex.sets.length - 1, true);
        // Метка первого подхода — единственная точка отсчёта тренировки,
        // которая переживает закрытие приложения.
        const hadFirst = Boolean(workout.firstSetAt);
        if (!hadFirst) workout.firstSetAt = new Date().toISOString();
        // Метка последнего подхода живёт в самой записи, а не только в памяти
        // экрана, и пишется до сохранения — иначе она не доедет до базы.
        // Раньше её держал один `state`: экран погас, iOS выгрузил PWA — и
        // следующий подход уходил в журнал без отдыха, при том что экран
        // по-прежнему обещал мерить. Фактический отдых на якорных лифтах —
        // обязательная строка данных, а дыра была беззвучной.
        const prevLastAt = workout.lastSetAt || null;
        workout.lastSetAt = new Date().toISOString();
        if (!(await save(box))) {
          ex.sets.pop();
          if (!hadFirst) workout.firstSetAt = null;
          workout.lastSetAt = prevLastAt;
          if (btn) btn.disabled = false;
          return;
        }
        // Тумблер залипал: включённый однажды, он метил разминочными все
        // следующие подходы, пока это не замечали глазами.
        state.warmup = false;
        state.control = null;
        state.failure = false;
        state.lastSetAt = workout.lastSetAt;
        state.recordedAt = Date.now();
        // Отдых закрыт — следующая метка начала подхода ставится заново.
        state.setStartedAt = null;
        await draw(box);
      },
    });

    // Подпись главной — то, что уйдёт в базу: «✓ 150 × 5». Следит за полями,
    // поэтому степпер и чип меняют её на глазах, до касания.
    const num = (input) => (input ? parseNum(input.value) : null);
    const show = (v) => (v == null ? '—' : fmtWeight(v));
    const doseNow = () => {
      if (cardio) return `${show(num(wInput))} мин · ${show(num(rInput))} км`;
      const w = num(wInput);
      const weight = w == null ? '' : (scale ? `яч. ${fmtWeight(w)}` : fmtWeight(w));
      const r = num(rInput);
      const sec = num(sInput);
      const amount = sec != null
        ? (combined && r != null ? `${r} + ${fmtWeight(sec)} с` : `${fmtWeight(sec)} с`)
        : (r != null ? fmtWeight(r) : '—');
      const m = num(mInput);
      return (weight ? `${weight} × ${amount}` : amount)
        + (m != null ? ` · ${fmtWeight(m)} ${ownMeasure.unit}` : '');
    };
    const paintRecord = () => {
      recordBtn.textContent = editing ? `сохранить подход ${editingPos + 1}`
        : (closedNow ? '+ подход' : `✓ ${doseNow()}`);
    };
    paintRecord();
    for (const input of [wInput, rInput, sInput, mInput]) {
      if (input) input.addEventListener('input', paintRecord);
    }

    // «+N таких» (решения атлета 29.10 и 05.11): подсобку вносят пачкой,
    // и одинаковые 4×5 стоили четырёх записей. Пишет копии последнего рабочего
    // (`copiesOfLast`) без отдыха — их никто не мерил, — но двигает метку
    // последней записи: переход к следующему упражнению меряется от них.
    // Автоперехода нет, дальше зовёт панель. При одном оставшемся главная
    // кнопка делает то же.
    const more = planned - workingSets;
    if (closedNow) {
      dockMain = nextButton(box);
      dockAlt = recordBtn;
    } else {
      dockMain = recordBtn;
      if (!editing && !cardio && workingSets > 0 && more >= 2) {
        dockMore = el('button', {
          className: 'wk-more',
          textContent: `+${more} таких`,
          onclick: async (e) => {
            const btn = e && e.target;
            if (btn && btn.disabled) return;
            if (btn) btn.disabled = true;
            const copies = copiesOfLast(ex.sets, more);
            ex.sets.push(...copies);
            const prevLastAt = workout.lastSetAt || null;
            workout.lastSetAt = new Date().toISOString();
            if (!(await save(box))) {
              ex.sets.splice(ex.sets.length - copies.length, copies.length);
              workout.lastSetAt = prevLastAt;
              if (btn) btn.disabled = false;
              return;
            }
            state.warmup = false;
            state.control = null;
            state.failure = false;
            state.lastSetAt = workout.lastSetAt;
            state.recordedAt = Date.now();
            state.setStartedAt = null;
            return draw(box);
          },
        });
      }
    }

    if (editing) {
      box.append(el('button', {
        className: 'back', textContent: 'отменить правку',
        onclick: () => {
          state.editSet = null; state.warmup = false; state.control = null; state.failure = false;
          return draw(box);
        },
      }));
    }
  }

  if (ex.skipped) dockMain = nextButton(box);

  // Круг «раунд через раунд» (решение атлета 05.11): после подхода в круге
  // вторая кнопка зовёт партнёра одним касанием. «+N таких» остаётся рядом
  // коротким «+N» (замечание атлета 06.11): подсобку круга тоже вносят пачкой
  // после зала. Закрытое упражнение партнёра не зовёт: туда ведёт «дальше»,
  // а вторая кнопка остаётся «+ подход» — иначе лишний подход записать нечем.
  const partner = !ex.skipped && state.editSet == null && workingSets > 0
    && !exerciseClosed(ex, workout.prescription[index] || {})
    ? roundPartner(workout, index) : null;
  if (partner != null) {
    dockAlt = el('button', {
      className: 'wk-partner',
      textContent: `↔ ${shortName(doneName(workout.exercises[partner])).short}`,
      onclick: () => goTo(box, partner),
    });
    if (dockMore) {
      dockMore.textContent = dockMore.textContent.replace(/ таких$/, '');
      dockMore.ariaLabel = `ещё ${planned - workingSets} таких`;
    }
  } else if (dockMore) {
    dockAlt = dockMore;
    dockMore = null;
  }

  // Очередь: три ближайших невзятых упражнения. Видно, сколько осталось,
  // без разворачивания всего плана.
  const ahead = [];
  for (let i = index + 1; i < workout.exercises.length && ahead.length < 3; i++) {
    const e = workout.exercises[i];
    const p = workout.prescription[i] || {};
    if (exerciseClosed(e, p)) continue;
    ahead.push({
      i,
      name: doneName(e),
      dose: listDose(p, e, { short: true }),
    });
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

  // Кнопка добавления стоит на виду, а не внутри развёрнутого списка плана:
  // там её не нашли ни разу, и доделанная работа записывалась «потом в чат».
  // Место — сразу после текущего упражнения: порядок в записи повторяет
  // порядок, в котором делал.
  const addHere = el('button', {
    className: 'go ghost add-exercise',
    textContent: '+ упражнение сюда',
    onclick: () => { state.insertAt = index + 1; return draw(box); },
  });

  // Перенесённое сюда из других сессий (решение атлета 29.10) — касанием,
  // «вне плана», следом за текущим упражнением.
  if ((state.incoming || []).length && workout.status !== 'done') {
    const card = el('div', { className: 'group-card' });
    for (const m of state.incoming) {
      card.append(el('button', {
        className: 'group-row',
        onclick: async () => {
          const i = insertMoved(workout, index + 1, m);
          if (!(await save(box))) {
            takePair(workout, i);
            return;
          }
          state.incoming = state.incoming.filter((x) => x !== m);
          return goTo(box, i);
        },
      },
      el('span', { className: 'row-title', textContent: m.name }),
      el('span', { className: 'row-value', textContent: `с ${weekdayShort(m.from)} ${dm(m.from)} · вставить` }),
      el('span', { className: 'chev' })));
    }
    box.append(el('div', { className: 'wk-queue' },
      el('div', { className: 'group-cap', textContent: 'перенесено сюда' }), card));
  }

  // Под очередью — «весь план ›»: обзор с конструктором и прыжком на любое
  // упражнение, в том числе закрытое. Стрелки «← →» сняты (решение 05.11).
  const queue = el('div', { className: 'wk-queue wk-ahead' });
  queue.append(el('div', { className: 'group-cap', textContent: 'дальше' }));
  if (ahead.length) {
    const card = el('div', { className: 'group-card' });
    for (const a of ahead) {
      card.append(el('button', {
        className: 'group-row',
        onclick: () => goTo(box, a.i),
      },
      el('span', { className: 'row-title', textContent: a.name }),
      el('span', { className: 'row-value', textContent: a.dose }),
      el('span', { className: 'chev' })));
    }
    queue.append(card);
  }
  queue.append(el('button', {
    className: 'back wk-all', textContent: 'весь план ›',
    onclick: () => { state.showOverview = true; return draw(box); },
  }));
  box.append(queue);
  box.append(addHere);
  if (state.insertAt != null) box.append(exercisePicker(box, screenCtx()));

  // Вставленное по ошибке убирается, пока под ним нет подходов (п. 14 очереди).
  if (ex.unplanned && !(ex.sets || []).length) {
    box.append(el('button', {
      className: 'back danger', textContent: 'убрать — добавлено по ошибке',
      onclick: async () => {
        if (!confirm(`Убрать «${ex.name}» из сессии?`)) return;
        const gone = removeExercise(workout, state.index);
        if (!gone || gone.outcome !== 'deleted') return;
        if (!(await save(box))) {
          undoDelete(workout, gone);
          return;
        }
        return goTo(box, Math.max(0, Math.min(gone.index, workout.exercises.length - 1)));
      },
    }));
  }

  if (ready) {
    box.append(el('div', {
      className: 'ready-hint',
      textContent: last
        ? `План закрыт: подходов ${workingSets} из ${planned}. Это последний шаг — можно завершать.`
        : `План закрыт: подходов ${workingSets} из ${planned}.`,
    }));
  }

  // Ссылка ухода живёт в своём контейнере, как `.day-links` на экране дня:
  // строчные кнопки слипались в одну строку без пробела. Весь план — в шапке
  // и под очередью.
  box.append(el('div', { className: 'wk-links' },
    // Вкладкой «Тренировка» это не заменяется. На любую другую вкладку уборка
    // отрабатывает, но тап по своей же вкладке уходом не считается
    // (`main.js`, условие `current !== name`): экран перерисуется в выбор
    // сессии, не погасив часы и не дописав растяжку. Ссылка зовёт `leave()`
    // явно и потому остаётся единственным безопасным выходом к выбору.
    el('button', {
      className: 'back', textContent: '← другая сессия',
      onclick: () => { leave(); navigate('workout', {}); },
    })));

  finishButton(box);

  // Обратный путь есть у любой записи, не только у черновика. Ошибочно
  // закрытую тренировку удалить было нечем вовсе: единственная дверь вела
  // через ЗАВЕРШИТЬ, а после него дверей не оставалось.
  //
  // Стоит он последним и своей строкой: разрушительное действие не встаёт
  // в один ряд с навигацией. В строке ссылок его `margin-top` не работал
  // вовсе — соседи держали его на общей базовой линии.
  {
    const written = workout.exercises.reduce((n, e) => n + (e.sets || []).length, 0);
    const done = workout.status === 'done';
    box.append(el('button', {
      className: 'back danger',
      textContent: done ? 'удалить запись тренировки' : 'отменить заполнение',
      onclick: async () => {
        const what = done
          ? `Удалить записанную тренировку? Подходов: ${written}. Вернуть будет нечем.`
          : (written
            ? `Удалить черновик? Записанное пропадёт: подходов ${written}.`
            : 'Удалить пустой черновик?');
        if (!confirm(what)) return;
        stopClock();
        if (workout.id != null) {
          try {
            await delWorkout(workout.id);
            // Кардио-день заводит сессию дня сам: без чистки в дне осталась бы
            // строка ходьбы или бега от удалённой тренировки.
            const dayRow = await getDay(workout.date);
            if (dayRow && (dayRow.cardio || []).some((c) => c.fromWorkout === workout.id)) {
              dayRow.cardio = dayRow.cardio.filter((c) => c.fromWorkout !== workout.id);
              await putDay(dayRow);
            }
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

  // Нижняя панель над навигацией — в зоне большого пальца (решение атлета
  // 05.11): запись, копии и «дальше» не уезжают вниз по мере роста списка
  // подходов. Счётчик отдыха — слева, только у сегодняшней незакрытой сессии;
  // место держится и пустым, чтобы кнопки не прыгали, когда цифра появится.
  // Распорка в конце потока не даёт панели закрыть последнюю строку экрана.
  if (dockMain) {
    const live = mode === 'live' && workout.status !== 'done';
    box.append(el('div', { className: 'wk-dock-space' }));
    box.append(el('div', { className: 'wk-dock' },
      live ? el('div', { className: 'wk-rest', textContent: restCounter(workout) || '' }) : null,
      dockMain, dockMore, dockAlt));
  }

  // Часы тренировки и счётчик отдыха идут одним тиком и читают метки записи
  // на каждом тике, а не копят секунды: свёрнутое приложение усыпляет
  // интервалы, метки не врут.
  stopClock();
  if (mode === 'live' && workout.firstSetAt && workout.status !== 'done') {
    state.clock = setInterval(() => {
      const label = box.querySelector('.wk-clock');
      if (!label) { stopClock(); return; }
      label.textContent = fmtClock(workoutElapsed(workout));
      const rest = box.querySelector('.wk-rest');
      if (rest) rest.textContent = restCounter(workout) || '';
    }, 1000);
    // В браузере метода нет, в Node он держит процесс живым: без этого
    // прогон тестов не завершается вовсе.
    if (state.clock && typeof state.clock.unref === 'function') state.clock.unref();
  }
}


// Условия добора печатаются памяткой. Проверяет их атлет, а не приложение:
// вычислять «можно ли» значило бы запрещать, а решение остаётся за ним.
// Условий допуска у бонуса нет (решение атлета 26.09): делается по времени
// и самочувствию в моменте.
const PLUS_GATE = 'по времени и самочувствию';


export async function render(box, params = {}) {
  const iso = params.date || todayISO();
  const code = params.code || null;

  // Без явного выбора вкладка показывает список, а не молча берёт зал сегодня.
  if (!params.kind) {
    stopClock();
    state = null;
    await chooser(box, iso);
    return;
  }

  const date = iso;
  const kind = params.kind;

  if (!state || state.workout.date !== date || state.workout.kind !== kind
      || (code && state.workout.dayCode !== code)) {
    stopClock();
    let workout = await findWorkout(date, kind, code);
    if (!workout) {
      const planNow = await getPlan(date);
      const hit = sessionFor(planNow, date, kind, code);
      // Запись не заводится до первого действия: заглянуть в план бесплатно.
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
            textContent: `${weekdayShort(m.date)} ${dm(m.date)}`,
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
      // По имени, а не по позиции: см. `prescriptionFor`. Порядок и число
      // упражнений в факте с планом не совпадают, и раньше сюда клался план
      // целиком, а адресовался он индексом упражнения.
      workout.prescription = prescriptionFor(
        workout.exercises, hit ? hit.session.exercises : []);
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
    // а не показываем тупик «не в этой сессии». Убранный бонус не воскресает.
    if (own) {
      const missing = bonusToAppend(workout, own.session.exercises);
      if (missing.length) {
        for (const e of missing) {
          putPair(workout, workout.exercises.length, {
            ex: {
              name: e.name, planName: e.name, replacedWith: null,
              skipped: false, skipReason: null, note: '', sets: [],
            },
            presc: e,
          });
        }
        // Незаписанную сессию не создаём этим побочно: её заведёт первая правка.
        if (workout.id != null) await putWorkout(workout);
      }
    }
    const [dayRaw, weekRaw, allWorkouts] = await Promise.all([
      getDay(date), getWeek(isoWeek(date)), listWorkouts(),
    ]);
    const day = dayRaw || { date };
    const week = weekRaw || { id: isoWeek(date) };

    state = {
      // Сессия открывается там, где её бросили. Ноль означал, что вернувшись
      // дописать забытое, ты каждый раз листаешь стрелкой весь день с начала.
      workout, index: firstOpen(workout), clock: null,
      showOverview: false,
      warmup: false, lastSetAt: workout.lastSetAt || null, guide, showInfo: false,
      editSet: null, insertAt: null, textEdit: null, setStartedAt: null, control: null,
      debts: debtNames(allWorkouts, date),
      // Сессии плана — для «перенос →», входящие переносы — для очереди.
      sessions: trainingSessions(await listPlans()),
      incoming: incomingMoves(allWorkouts, workout),
      stretch, bonus, day, week,
      marks: { ...(day.stretch || {}) }, secs: { ...(day.stretchSec || {}) },
      homeDone: allWorkouts.some(
        (w) => w.date === date && w.kind === 'home' && w.status === 'done'),
      extras: extraSteps(stretch),
    };
  }
  // «Закрыть как есть» с экрана дня — тем же `finish`, без сверки незакрытого.
  if (params.close && state.workout.status !== 'done' && state.workout.id != null) {
    await finish(box, { asIs: true });
    return;
  }
  await draw(box);
}
