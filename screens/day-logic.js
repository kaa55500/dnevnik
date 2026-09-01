import { fromISO, isoWeek } from '../lib/dates.js';

const TUE = 2;
const WED = 3;
const SUN = 0;

// Недельный блок закрывают три строки: без них он не уходит с экрана (ЦИКЛ-3.md §8).
const WEEK_REQUIRED = ['kcalAvg', 'proteinAvg', 'handstandSec'];

const weekday = (iso) => fromISO(iso).getDay();
const empty = (v) => v === null || v === undefined;

/**
 * Ключ строки для прочерка. У сессий он несёт код дня: после переноса
 * на одной дате могут стоять два зальных дня, и общий ключ закрыл бы обе.
 */
export function skipKeyOf(task) {
  return task.kind ? `${task.kind}|${task.code || ''}` : task.key;
}

/** Где живёт отметка «не делал»: у дня или у недели. */
export function skipScopeOf(key) {
  return ['splitGap', 'waist', 'week'].includes(key) ? 'week' : 'day';
}

/**
 * Все строки дня с пометкой, закрыта ли каждая. Обязательные строки с цифрой
 * помечены required: они висят долгом. Фоновые уходят молча, без вины (R10).
 */
function allTasks(ctx) {
  const d = ctx.day || {};
  const w = ctx.week || {};
  // «Не делал» — законный ответ: строка закрывается, долг снимается,
  // а «не бегал» перестаёт быть неотличимым от «забыл записать».
  const daySkip = d.skipped || {};
  const weekSkip = w.skipped || {};
  const isSkipped = (key, k = null) => {
    const kk = k ? `${k.kind}|${k.code || ''}` : key;
    return Boolean(skipScopeOf(key) === 'week' ? weekSkip[kk] : daySkip[kk]);
  };
  const sessions = ctx.sessions || [];
  // Ключ сессии — вид плюс код дня. После переноса на одной дате могут
  // лежать два зальных дня, и по одному виду закрытость читалась ложно:
  // приехавший Н1 закрывал плановый В2.
  const doneKeys = new Set((ctx.doneKinds || []).map(
    (x) => (typeof x === 'string' ? x : `${x.kind}|${x.code || ''}`)));
  const closedSession = (s) => doneKeys.has(`${s.kind}|${s.code || ''}`)
    || doneKeys.has(s.kind);
  const tasks = [];

  tasks.push({
    key: 'morning', title: 'Утренний чек-ин', required: true,
    done: !empty(d.weight) || isSkipped('morning'),
    skipped: isSkipped('morning'),
  });

  // Тренировка, перенесённая на другой день, в этот день долгом не висит:
  // она сделана, просто не здесь. Без этого плановая дата копила бы вечный
  // долг по сессии, которая уже в журнале.
  const movedAway = new Map((ctx.movedAway || []).map((m) => [m.kind, m.date]));

  for (const s of sessions) {
    if (s.kind === 'mobility') continue;
    const movedTo = movedAway.get(s.kind) || null;
    tasks.push({
      key: s.kind,
      title: s.kind === 'home' ? 'Домашняя сессия' : s.title || s.code,
      kind: s.kind,
      code: s.code,
      required: true,
      done: closedSession(s) || Boolean(movedTo) || isSkipped(s.kind, s),
      skipped: isSkipped(s.kind, s),
      movedTo,
    });
  }

  const mobility = sessions.find((s) => s.kind === 'mobility');
  if (mobility) {
    // Растяжка стала обязательной строкой: за Н2 явка была 3 из 7, а шпагат —
    // объявленная цель. Молчаливый пропуск скрывал именно это (правило 9).
    tasks.push({
      key: 'mobility', title: mobility.title || 'Блок растяжки', required: true,
      done: stretchDone(d, mobility) || isSkipped('mobility'),
      skipped: isSkipped('mobility'),
    });
  }

  if (weekday(ctx.date) === TUE && mobility) {
    tasks.push({
      key: 'splitGap', title: 'Просвет шпагата', required: true,
      done: !empty(w.splitGap) || isSkipped('splitGap'),
      skipped: isSkipped('splitGap'),
    });
  }

  if (weekday(ctx.date) === WED) {
    tasks.push({
      key: 'waist', title: 'Талия', required: true,
      done: !empty(w.waist) || isSkipped('waist'),
      skipped: isSkipped('waist'),
    });
  }

  tasks.push({
    key: 'evening', title: 'Вечер: ходьба и кардио', required: false,
    done: !empty(d.walkKm) || (d.cardio || []).length > 0 || isSkipped('evening'),
    skipped: isSkipped('evening'),
  });

  if (weekday(ctx.date) === SUN) {
    tasks.push({
      key: 'week', title: 'Недельные замеры', required: true,
      done: !WEEK_REQUIRED.some((k) => empty(w[k])) || isSkipped('week'),
      skipped: isSkipped('week'),
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
  // Прочерк должен сниматься: строка, закрытая «не делал», обязана остаться
  // доступной, иначе ошибочный прочерк не отменить ничем.
  return allTasks(ctx).filter((t) => t.done && (EDITABLE.has(t.key) || t.skipped));
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

    const ds = d.skipped || {};
    const ws = w.skipped || {};
    if (empty(d.weight) && !ds.morning) out.push({ date, key: 'morning', title: 'вес' });
    if (weekday(date) === TUE && empty(w.splitGap) && !ws.splitGap) {
      out.push({ date, key: 'splitGap', title: 'просвет шпагата' });
    }
    if (weekday(date) === WED && empty(w.waist) && !ws.waist) {
      out.push({ date, key: 'waist', title: 'талия' });
    }
  }
  return out;
}
