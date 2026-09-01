const DAY = 86400000;

export function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function fromISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayISO() {
  return toISO(new Date());
}

export function addDays(iso, n) {
  const d = fromISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

export function daysBetween(a, b) {
  return Math.round((fromISO(b) - fromISO(a)) / DAY);
}

// ISO-8601: неделя принадлежит году, в котором лежит её четверг.
export function isoWeek(iso) {
  const d = fromISO(iso);
  const shift = (d.getDay() + 6) % 7;        // Пн = 0
  d.setDate(d.getDate() - shift + 3);        // четверг этой недели
  const year = d.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const jan4shift = (jan4.getDay() + 6) % 7;
  const week1Mon = new Date(year, 0, 4 - jan4shift);
  const n = Math.round((d - week1Mon) / DAY / 7) + 1;
  return `${year}-W${String(n).padStart(2, '0')}`;
}

export function weekDays(weekId) {
  const [y, w] = weekId.split('-W').map(Number);
  const jan4 = new Date(y, 0, 4);
  const jan4shift = (jan4.getDay() + 6) % 7;
  const mon = new Date(y, 0, 4 - jan4shift + (w - 1) * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon);
    d.setDate(d.getDate() + i);
    return toISO(d);
  });
}

const SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export function weekdayShort(iso) {
  return SHORT[fromISO(iso).getDay()];
}
