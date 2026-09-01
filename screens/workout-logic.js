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
export function restForSet({ mode, lastSetAt, now, manual }) {
  if (manual != null && Number.isFinite(manual) && manual >= 0) {
    return { rest: Math.round(manual), restManual: true };
  }
  if (mode !== 'live') return { rest: null, restManual: false };
  return { rest: restBetween(lastSetAt, now ?? Date.now()), restManual: false };
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
