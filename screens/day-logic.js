import { fromISO, isoWeek } from '../lib/dates.js';

const TUE = 2;
const WED = 3;
const SUN = 0;

// Недельный блок закрывают три строки: без них он не уходит с экрана (ЦИКЛ-3.md §8).
const WEEK_REQUIRED = ['kcalAvg', 'proteinAvg', 'handstandSec'];

const weekday = (iso) => fromISO(iso).getDay();
const empty = (v) => v === null || v === undefined;

/**
 * Все строки дня с пометкой, закрыта ли каждая. Обязательные строки с цифрой
 * помечены required: они висят долгом. Фоновые уходят молча, без вины (R10).
 */
function allTasks(ctx) {
  const d = ctx.day || {};
  const w = ctx.week || {};
  const sessions = ctx.sessions || [];
  const doneKinds = new Set(ctx.doneKinds || []);
  const tasks = [];

  tasks.push({
    key: 'morning', title: 'Утренний чек-ин', required: true, done: !empty(d.weight),
  });

  for (const s of sessions) {
    if (s.kind === 'mobility') continue;
    tasks.push({
      key: s.kind,
      title: s.kind === 'home' ? 'Домашняя сессия' : s.title || s.code,
      kind: s.kind,
      code: s.code,
      required: true,
      done: doneKinds.has(s.kind),
    });
  }

  const mobility = sessions.find((s) => s.kind === 'mobility');
  if (mobility) {
    tasks.push({
      key: 'mobility', title: mobility.title || 'Блок растяжки', required: false,
      done: stretchDone(d, mobility),
    });
  }

  if (weekday(ctx.date) === TUE && mobility) {
    tasks.push({
      key: 'splitGap', title: 'Просвет шпагата', required: true, done: !empty(w.splitGap),
    });
  }

  if (weekday(ctx.date) === WED) {
    tasks.push({ key: 'waist', title: 'Талия', required: true, done: !empty(w.waist) });
  }

  tasks.push({
    key: 'evening', title: 'Вечер: ходьба и кардио', required: false,
    done: !empty(d.walkKm) || (d.cardio || []).length > 0,
  });

  if (weekday(ctx.date) === SUN) {
    tasks.push({
      key: 'week', title: 'Недельные замеры', required: true,
      done: !WEEK_REQUIRED.some((k) => empty(w[k])),
    });
  }

  return tasks;
}

/** Что осталось закрыть в этот день. */
export function pendingTasks(ctx) {
  return allTasks(ctx).filter((t) => !t.done);
}

// Сессии открываются через карточку «Сделано», у остальных строк формы больше нет:
// без этого списка первая же записанная цифра прятала форму навсегда.
const EDITABLE = new Set(['morning', 'mobility', 'splitGap', 'waist', 'evening', 'week']);

/** Закрытые строки, которые ещё можно открыть и поправить. */
export function closedTasks(ctx) {
  return allTasks(ctx).filter((t) => t.done && EDITABLE.has(t.key));
}

/** Блок растяжки закрыт, когда отмечены все позиции этого дня. */
export function stretchDone(day, session) {
  const marks = (day && day.stretch) || {};
  const positions = (session && session.positions) || [];
  if (!positions.length) return false;
  return positions.every((p) => marks[p.n] === true);
}

/**
 * Незакрытые обязательные строки за прошедшие дни. Показываются отдельно
 * от сегодняшнего списка: вчерашнюю ходьбу уже не переиграть, а вчерашний
 * вес — это цифра, которую атлет помнит и может внести.
 */
export function debts(ctx) {
  const days = new Map((ctx.days || []).map((d) => [d.date, d]));
  const weeks = new Map((ctx.weeks || []).map((w) => [w.id, w]));
  const out = [];

  for (const date of ctx.dates || []) {
    if (date >= ctx.today) continue;
    const d = days.get(date) || {};
    const w = weeks.get(isoWeek(date)) || {};

    if (empty(d.weight)) out.push({ date, key: 'morning', title: 'вес' });
    if (weekday(date) === TUE && empty(w.splitGap)) {
      out.push({ date, key: 'splitGap', title: 'просвет шпагата' });
    }
    if (weekday(date) === WED && empty(w.waist)) {
      out.push({ date, key: 'waist', title: 'талия' });
    }
  }
  return out;
}
