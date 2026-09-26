import { toISO, fromISO, isoWeek } from '../lib/dates.js';
import { morningClosed } from './day-logic.js';

/**
 * Сетка месяца с состоянием каждого дня. Неделя начинается с понедельника,
 * ведущие и хвостовые пустые ячейки — null, чтобы вёрстка не гадала.
 */
export function monthGrid(anchorISO) {
  const d = fromISO(anchorISO);
  const year = d.getFullYear();
  const month = d.getMonth();
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;             // Пн = 0
  const length = new Date(year, month + 1, 0).getDate();

  const cells = Array.from({ length: lead }, () => null);
  for (let i = 1; i <= length; i += 1) cells.push(toISO(new Date(year, month, i)));
  while (cells.length % 7 !== 0) cells.push(null);
  return { year, month, cells };
}

/**
 * Что закрыто в дне: тренировка, вес, вечер. Плюс признаки «есть план»
 * и «вне цикла» — по ним видно, дыра это или выходной.
 */
export function dayState(iso, ctx) {
  const day = (ctx.days || []).find((x) => x.date === iso) || null;
  const week = (ctx.weeks || []).find((x) => x.id === isoWeek(iso)) || null;
  const planned = (ctx.plannedDates || []).includes(iso);
  const done = (ctx.workouts || []).filter((w) => w.date === iso && w.status === 'done');
  const draft = (ctx.workouts || []).some((w) => w.date === iso && w.status === 'draft');

  return {
    date: iso,
    planned,
    future: iso > ctx.today,
    workout: done.length > 0,
    draft: draft && done.length === 0,
    // Утро — по тому же правилу, что долги (`morningClosed`, 26.09): закрыто,
    // если в нём выбрано хоть что-то. Одно правило на два экрана.
    morning: morningClosed(day),
    weight: day != null && day.weight != null,
    evening: day != null && (day.walkKm != null || (day.cardio || []).length > 0),
    stretch: day != null && Object.values(day.stretch || {}).some(Boolean),
    waist: week != null && week.waist != null,
  };
}

/**
 * Пустой день внутри цикла, который уже прошёл, — это дыра, а не выходной.
 *
 * Правило утра берётся из `day-logic`, а не пишется здесь заново: календарь
 * однажды уже разошёлся с экраном дня, и «красным незакрытый день»
 * и «не закрыто» переставали быть одним понятием.
 */
export function isHole(state) {
  if (state.future) return false;
  if (!state.planned) return false;
  if (!state.morning) return true;
  return !state.workout && !state.evening;
}
