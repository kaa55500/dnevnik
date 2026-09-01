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

export function parseNum(s) {
  if (typeof s === 'number') return s;
  const t = String(s ?? '').trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
