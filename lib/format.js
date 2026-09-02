export function fmtNum(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toFixed(digits).replace('.', ',');
}

export function fmtSigned(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const s = Math.abs(n).toFixed(digits).replace('.', ',');
  if (Number(n.toFixed(digits)) === 0) return '0';
  return (n < 0 ? '−' : '+') + s;
}

/** Вес без лишних нулей: 65 -> «65», 66.25 -> «66,25», 22.5 -> «22,5». */
export function fmtWeight(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return String(Math.round(n * 100) / 100).replace('.', ',');
}

/** Часы таймера: 00:30, 01:47 — ведущий ноль, как на табло. */
export function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * Число из поля ввода. Точка и запятая равноправны — на телефоне набирается
 * то, что даёт клавиатура.
 *
 * Через `Number` сюда проходило всё, что тот умеет разбирать: `-5` давало
 * отрицательный вес и уезжало в расчётный максимум, `1e3` — тысячу килограммов,
 * `0x10` — шестнадцать, а строка из трёхсот цифр — 1.11e+299. Ни одна
 * величина в этом дневнике отрицательной не бывает: вес, повторы, секунды,
 * сантиметры, часы сна, отдых. Поэтому форма проверяется явно, а не отдаётся
 * на откуп `Number`, который принимает больше, чем нужно.
 */
const DECIMAL = /^\d+(?:\.\d+)?$/;

export function parseNum(s) {
  if (typeof s === 'number') return Number.isFinite(s) && s >= 0 ? s : null;
  const t = String(s ?? '').trim().replace(',', '.');
  if (t === '') return null;
  if (!DECIMAL.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
