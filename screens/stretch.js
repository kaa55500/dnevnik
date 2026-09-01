import {
  getDay, putDay, getWeek, putWeek, getPlan, listWorkouts, getExercises,
} from '../store.js';
import { sessionFor } from '../plan.js';
import { todayISO, isoWeek, weekdayShort } from '../lib/dates.js';
import { parseNum } from '../lib/format.js';
import { el } from './day.js';
import { stretchList, warmupHint, splitHint, applySplit } from './stretch-block.js';
import { navigate } from '../main.js';

export async function render(box, params = {}) {
  const date = params.date || todayISO();
  const [dayRaw, weekRaw, plan, workouts, exercises] = await Promise.all([
    getDay(date), getWeek(isoWeek(date)), getPlan(date), listWorkouts(), getExercises(),
  ]);
  const guide = new Map(exercises.map((e) => [e.name, e]));
  const day = dayRaw || { date };
  const week = weekRaw || { id: isoWeek(date) };
  const hit = sessionFor(plan, date, 'mobility');

  box.append(el('h1', {
    textContent: `Растяжка · ${weekdayShort(date)} ${date.slice(8)}.${date.slice(5, 7)}`,
  }));

  if (!hit) {
    box.append(el('p', { textContent: 'В этот день блока растяжки в плане нет.' }));
    return;
  }

  const session = hit.session;
  const homeDone = workouts.some(
    (w) => w.date === date && w.kind === 'home' && w.status === 'done');
  const marks = { ...(day.stretch || {}) };
  const secs = { ...(day.stretchSec || {}) };

  const hint = warmupHint(session, homeDone);
  if (hint) box.append(el('p', { className: 'hint', textContent: hint }));

  box.append(stretchList(session.positions, guide, marks, secs));

  const splitInput = session.measureSplit
    ? el('input', { type: 'number', step: '0.5', inputMode: 'decimal', value: week.splitGap ?? '' })
    : null;

  if (splitInput) {
    box.append(el('div', { className: 'split-measure' },
      el('label', {}, 'просвет шпагата, см', splitInput),
      el('p', { className: 'hint', textContent: splitHint(session, homeDone) })));
  }

  const err = (e) => box.prepend(el('div', {
    className: 'error', textContent: 'Не сохранено: ' + e.message,
  }));

  box.append(el('button', {
    className: 'save', textContent: 'Сохранить блок',
    onclick: async () => {
      try {
        // Перечитываем день перед записью: экран тренировки мог сохранить
        // свой блок, а утренний чек-ин — вес и сон. Снимок затёр бы их.
        const fresh = (await getDay(date)) || { date };
        fresh.stretch = { ...(fresh.stretch || {}), ...marks };
        fresh.stretchSec = { ...(fresh.stretchSec || {}), ...secs };
        if (date !== todayISO()) fresh.backdated = true;
        await putDay(fresh);
        if (splitInput) {
          const v = parseNum(splitInput.value);
          if (v != null) {
            const wk = (await getWeek(isoWeek(date))) || { id: isoWeek(date) };
            applySplit(wk, session, v, homeDone);
            await putWeek(wk);
          }
        }
        await navigate('day', { date });
      } catch (e) {
        err(e);
      }
    },
  }));

  box.append(el('button', {
    className: 'back', textContent: '← к дню',
    onclick: () => navigate('day', { date }),
  }));
}
