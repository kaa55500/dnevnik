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
 */
export function nextSetDefaults(presc, doneSets, history) {
  const working = (doneSets || []).filter((s) => !s.warmup);
  if (working.length) {
    const last = working[working.length - 1];
    return { weight: last.weight, reps: last.reps, rpe: presc.rpe ?? null };
  }
  const fromHistory = history && history.length ? history[history.length - 1] : null;
  return {
    weight: fromHistory ? fromHistory.weight : firstNumber(presc.weight),
    reps: fromHistory ? fromHistory.reps : planReps(presc.reps),
    rpe: presc.rpe ?? null,
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
