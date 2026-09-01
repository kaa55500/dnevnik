import { listDays, listWeeks, listWorkouts, getPlan } from '../store.js';
import { sessionDates } from '../plan.js';
import { todayISO, toISO, fromISO } from '../lib/dates.js';
import { monthGrid, dayState, isHole } from './calendar-logic.js';
import { el } from './day.js';
import { navigate } from '../main.js';

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const DOW = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

const shiftMonth = (iso, n) => {
  const d = fromISO(iso);
  return toISO(new Date(d.getFullYear(), d.getMonth() + n, 1));
};

export async function render(box, params = {}) {
  const today = todayISO();
  const anchor = params.date || today;
  const [days, weeks, workouts, plan] = await Promise.all([
    listDays(), listWeeks(), listWorkouts(), getPlan(anchor),
  ]);
  const ctx = {
    today, days, weeks, workouts,
    plannedDates: plan ? sessionDates(plan) : [],
  };

  const { year, month, cells } = monthGrid(anchor);

  box.append(el('div', { className: 'day-head' },
    el('button', {
      className: 'nav-arrow', textContent: '←',
      onclick: () => navigate('calendar', { date: shiftMonth(anchor, -1) }),
    }),
    el('span', { className: 'day-title', textContent: `${MONTHS[month]} ${year}` }),
    el('button', {
      className: 'nav-arrow', textContent: '→',
      onclick: () => navigate('calendar', { date: shiftMonth(anchor, 1) }),
    })));

  const grid = el('div', { className: 'cal' });
  for (const d of DOW) grid.append(el('div', { className: 'cal-dow', textContent: d }));

  for (const iso of cells) {
    if (!iso) {
      grid.append(el('div', { className: 'cal-cell empty' }));
      continue;
    }
    const st = dayState(iso, ctx);
    const cell = el('button', { className: 'cal-cell' });
    if (iso === today) cell.classList.add('today');
    if (!st.planned) cell.classList.add('off');
    if (isHole(st)) cell.classList.add('hole');
    cell.append(el('span', { className: 'cal-num', textContent: String(Number(iso.slice(8))) }));
    const dots = el('span', { className: 'cal-dots' });
    if (st.workout) dots.append(el('i', { className: 'dot w' }));
    if (st.draft) dots.append(el('i', { className: 'dot d' }));
    if (st.weight) dots.append(el('i', { className: 'dot b' }));
    if (st.evening || st.stretch) dots.append(el('i', { className: 'dot e' }));
    cell.append(dots);
    cell.onclick = () => navigate('day', { date: iso });
    grid.append(cell);
  }
  box.append(grid);

  box.append(el('div', { className: 'cal-legend' },
    el('span', {}, el('i', { className: 'dot w' }), ' тренировка'),
    el('span', {}, el('i', { className: 'dot b' }), ' вес'),
    el('span', {}, el('i', { className: 'dot e' }), ' вечер'),
    el('span', { className: 'hole-key' }, 'красным — незакрытый день цикла')));
}
