import { parseNum } from '../lib/format.js';

/** Первое число из строки: '22 кг/рук' -> 22, 'вес тела' -> null. */
export function firstNumber(s) {
  const m = String(s ?? '').match(/-?\d+(?:[.,]\d+)?/);
  return m ? parseNum(m[0]) : null;
}

/**
 * Повторы из плановой строки. Запись «3×8» означает три подхода по восемь:
 * первое число — подходы, и подставлять его в поле повторов нельзя.
 */
export function planReps(s) {
  const m = String(s ?? '').match(/(\d+)\s*[×x]\s*(\d+)/);
  return m ? parseNum(m[2]) : firstNumber(s);
}

/**
 * Что подставить в поля следующего подхода.
 * Приоритет: предыдущий подход этой тренировки → прошлая тренировка → план.
 *
 * RPE идёт по тому же приоритету, что вес и повторы. Раньше он всегда
 * откатывался к плановому: введёшь 8,5 при плановых 8 — и следующий подход
 * снова предлагает 8, то есть введённое не переживает даже одного подхода.
 */
export function nextSetDefaults(presc, doneSets, history) {
  const working = (doneSets || []).filter((s) => !s.warmup);
  if (working.length) {
    const last = working[working.length - 1];
    return { weight: last.weight, reps: last.reps, rpe: last.rpe ?? presc.rpe ?? null };
  }
  const fromHistory = history && history.length ? history[history.length - 1] : null;
  return {
    weight: fromHistory ? fromHistory.weight : firstNumber(presc.weight),
    reps: fromHistory ? fromHistory.reps : planReps(presc.reps),
    rpe: (fromHistory && fromHistory.rpe != null) ? fromHistory.rpe : (presc.rpe ?? null),
  };
}

/**
 * Контрольный подход — первый рабочий в упражнении с меткой плана.
 * Он же 5ПМ на Н4: в тренировочную линию не смешивается (правило 5).
 */
export function isControlSet(presc, doneSets, warmup) {
  if (!presc || !presc.control || warmup) return false;
  return (doneSets || []).filter((s) => !s.warmup && s.control).length === 0;
}

/** Средний RPE по всем рабочим подходам тренировки. */
export function averageRPE(workout) {
  const rpes = (workout.exercises || [])
    .flatMap((e) => e.sets || [])
    .filter((s) => !s.warmup)
    .map((s) => s.rpe)
    .filter((v) => v != null);
  return rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : null;
}

/** Жимовые дни: только после них спрашивается строка правой груди. */
export function asksChestSignal(workout) {
  return workout.kind === 'gym' && ['В1', 'В2'].includes(workout.dayCode);
}

/**
 * Фактический отдых: разница временных меток, а не накопленные тики.
 * Свёрнутое приложение усыпляет интервалы, метки не врут.
 */
export function restBetween(prevAtISO, nowMs) {
  if (!prevAtISO) return null;
  const prev = Date.parse(prevAtISO);
  if (!Number.isFinite(prev)) return null;
  const sec = Math.round((nowMs - prev) / 1000);
  return sec >= 0 ? sec : null;
}

/**
 * Режим заполнения сессии. Записи, созданные до 01.09, поля не несут —
 * для них считаем `live`: они и заполнялись по ходу.
 */
export function fillModeOf(workout) {
  return (workout && workout.fillMode) === 'later' ? 'later' : 'live';
}

/**
 * Отдых подхода. Метки времени годятся, только когда заполняешь по ходу
 * тренировки: 01.09 сессия вносилась целиком после зала, метки легли одна
 * к другой, и в журнал ушли «отдыхи» по 1–3 секунды. Прежняя защита стояла
 * на `backdated`, то есть на дате, а не на способе заполнения, и этот случай
 * пропустила — день-то был сегодняшний.
 *
 * Введённое руками побеждает измеренное всегда: атлет знает, что делал.
 * Возвращается пара: сама цифра и признак, что она вспомнена, а не измерена.
 * Смешивать их в одном столбце нельзя — через месяц не отличить.
 */
/**
 * Потолок правдоподобного отдыха между подходами. Сессия идёт 46–62 минуты,
 * и получасовая пауза внутри неё означает не отдых, а разрыв: телефон убрали
 * в карман, приложение выгрузили, вернулись после зала. Такая цифра хуже
 * пустоты — пустое поле видно, а «отдых 47 минут» уедет в свод как факт.
 */
export const REST_CEILING = 1800;

export function restForSet({ mode, lastSetAt, now, manual }) {
  if (manual != null && Number.isFinite(manual) && manual >= 0) {
    return { rest: Math.round(manual), restManual: true };
  }
  if (mode !== 'live') return { rest: null, restManual: false };
  const rest = restBetween(lastSetAt, now ?? Date.now());
  if (rest != null && rest > REST_CEILING) return { rest: null, restManual: false };
  return { rest, restManual: false };
}

/**
 * Пустое упражнение вне плана. Живёт в обоих массивах записи, чтобы сверка
 * «план против факта» шла по индексу, как раньше, и помечено `unplanned`:
 * в знаменатель «план закрыт» не входит, в недельный объём входит —
 * это настоящая работа, а не приписка.
 *
 * 01.09 атлет сделал три выхода силой, которых в силовом дне нет с пересборки
 * 31.08, и записать их было некуда: дописывать умел только бонус.
 */
export function insertExercise(workout, index, name) {
  const at = Math.max(0, Math.min(Number(index) ?? 0, workout.exercises.length));
  workout.prescription = workout.prescription || [];
  workout.prescription.splice(at, 0, { name, unplanned: true, sets: 0, reps: '—' });
  workout.exercises.splice(at, 0, {
    name, planName: null, replacedWith: null, unplanned: true,
    skipped: false, skipReason: null, note: '', sets: [],
  });
  return at;
}

/** Упражнения, по которым считается «план закрыт»: без бонуса и внеплановых. */
export function requiredPairs(workout) {
  return (workout.exercises || [])
    .map((e, i) => ({ e, p: (workout.prescription || [])[i] || {}, i }))
    .filter((x) => !x.p.optional && !x.p.unplanned && !x.e.unplanned);
}

/** Подписи видов активности — общие для экранов дня и тренировки. */
export const KIND_TITLE = {
  gym: 'Силовая',
  skill: 'Навыки',
  home: 'Домашняя',
  cardio: 'Кардио',
};

/**
 * Пустая сессия вне плана. Побегал в субботу, размялся в выходной, доделал
 * навыки — записать это было некуда: экран упирался в «на эту дату сессии
 * в плане нет», и активность не попадала в журнал вообще.
 */
export function makeUnplannedWorkout(date, kind, week, todayIso) {
  return {
    date,
    kind,
    status: 'draft',
    weekN: week ? week.n : null,
    weekKind: week ? (week.kind || 'work') : 'work',
    dayCode: KIND_TITLE[kind] || kind,
    title: `${KIND_TITLE[kind] || kind} вне плана`,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    backdated: date !== todayIso,
    movedFrom: null,
    unplannedSession: true,
    plannedRPE: null,
    avgRPE: null,
    chestSignal: null,
    prescription: [],
    exercises: [],
  };
}

/**
 * Часы тренировки. Отсчёт от первого записанного подхода, а не от открытия
 * экрана: заглянуть в план накануне — обычное дело, и от этого в журнал
 * ушли бы десять часов. В закрытой сессии показывают время до завершения.
 */
export function workoutElapsed(workout, nowMs = Date.now()) {
  if (!workout || !workout.firstSetAt) return null;
  const from = Date.parse(workout.firstSetAt);
  if (!Number.isFinite(from)) return null;
  const to = workout.finishedAt ? Date.parse(workout.finishedAt) : nowMs;
  const sec = Math.round((to - from) / 1000);
  return sec >= 0 ? sec : null;
}

/**
 * Виды кардио, которые понимает приложение. Список один на два места: он
 * наполняет выпадающий список ручного ввода на экране дня и распознаёт тип
 * по названию упражнения. Разойдись они — «эллипс», добавленный в список,
 * лёг бы в день как безымянное «кардио», и разбор по типам (правило 7:
 * бег в наборе запрещён) читал бы разные словари в зависимости от того,
 * как строку внесли.
 */
export const CARDIO_TYPES = ['ходьба', 'гребля', 'ски-эрг', 'бег', 'air bike', 'велосипед'];

/**
 * Вид кардио по названию упражнения. Раньше в день жёстко писался «бег»,
 * и гребля попадала в журнал бегом — а бег в наборе запрещён правилом 7,
 * то есть метрика читалась бы как нарушение.
 */
export function cardioType(workout) {
  const hay = [
    ((workout.exercises || [])[0] || {}).name,
    workout.title,
    workout.dayCode,
  ].filter(Boolean).join(' ').toLowerCase();
  return CARDIO_TYPES.find((t) => hay.includes(t)) || 'кардио';
}

/**
 * План сессии, разложенный под фактические упражнения записи.
 *
 * Раньше при отсутствии `prescription` в записи брался план целиком и
 * использовался по индексу. Порядок и число упражнений в факте с планом
 * не совпадают: в журнале Ц3 четыре импортированные записи Н1–Н2 идут без
 * `prescription`, и у 19.08 в факте шестнадцать упражнений против одиннадцати
 * в плане. Экран печатал над становой дозу Палов-пресса, таймер ставил 60 с
 * вместо 180, а `nextSetDefaults` подставлял чужой вес. Хуже другое: `asksRPE`
 * читается из того же места — на выходе силой, встретившем плановую стойку,
 * поле RPE не показывалось и в базу уходил `null`, а на приседе на одной ноге
 * RPE, наоборот, спрашивался, хотя навыкам он не ставится (решение 24.08).
 * С первой же дописанной строки кривой план уходил в базу навсегда.
 *
 * Сопоставление идёт по имени. Несопоставленному упражнению достаётся пустой
 * объект — «плана на него нет» честнее, чем чужая доза. Повторяющиеся имена
 * разбираются по порядку: каждая плановая строка тратится один раз.
 */
export function prescriptionFor(exercises, planned) {
  const pool = new Map();
  (planned || []).forEach((p, i) => {
    const key = p.name;
    if (!pool.has(key)) pool.set(key, []);
    pool.get(key).push(i);
  });
  // Длина результата равна числу упражнений записи, ни на один больше:
  // `prescription` адресуется индексом упражнения, и лишний хвост означал бы
  // фантомные строки в арифметике «план закрыт».
  return (exercises || []).map((e) => {
    const queue = pool.get(e.planName || e.name);
    if (queue && queue.length) return planned[queue.shift()];
    return {};
  });
}

/**
 * Закрыто ли упражнение: набран план или проставлен осознанный прочерк.
 *
 * Считалось на одном экране четырьмя разными способами. Кнопка ЗАВЕРШИТЬ
 * принимала ЛЮБОЙ подход, включая разминочный, — записал одну разминку
 * в трёх упражнениях, и она пишет «3 из 8», пока полоса прогресса показывает
 * ноль. У внепланового упражнения плана нет вовсе, и `p.sets` там ноль:
 * закрытым оно считается по факту работы, иначе очередь «дальше» звала бы его
 * до конца сессии и печатала «0×—».
 *
 * Место одно, потому что «план закрыт» — объявленная арифметика цикла, а не
 * косметика: правило пропуска или бонуса меняется в одной строке, а не в
 * четырёх, из которых четвёртую забудут и ничего не упадёт.
 */
export function exerciseClosed(e, p = {}) {
  if (!e) return false;
  if (e.skipped) return true;
  const done = (e.sets || []).filter((s) => !s.warmup).length;
  if (p.unplanned || e.unplanned) return done > 0;
  return Number(p.sets) > 0 && done >= Number(p.sets);
}

/**
 * Подходы в порядке показа: разминочные наверх, внутри группы — хронология.
 *
 * Возвращает пары «подход и его индекс в базе»: номер на экране и индекс
 * в записи — разные числа, и на их несовпадении уже ловили диалог удаления
 * и подпись кнопки «СОХРАНИТЬ ПОДХОД N». Компаратор был написан дважды.
 */
export function orderedSets(sets) {
  return (sets || []).map((s, i) => ({ s, i }))
    .sort((a, b) => Number(Boolean(b.s.warmup)) - Number(Boolean(a.s.warmup)));
}
