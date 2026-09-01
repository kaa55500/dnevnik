import { listDays, listWorkouts, listWeeks, listPlans, getSettings } from '../store.js';
import { todayISO, weekdayShort } from '../lib/dates.js';
import { dayRecord, recordedDates } from './journal-logic.js';
import { renderRecord } from './record-view.js';
import { el } from './day.js';
import { navigate } from '../main.js';

const LIMIT = 40;

export async function render(box, params = {}) {
  const [days, workouts, weeks, plans, settings] = await Promise.all([
    listDays(), listWorkouts(), listWeeks(), listPlans(), getSettings(),
  ]);
  const ctx = { days, workouts, weeks, plans, settings };
  const dates = recordedDates(ctx);

  box.append(el('h1', { textContent: 'Журнал' }));

  if (!dates.length) {
    // Пустой журнал был тупиком: ни одной кнопки, выход только через нижнюю
    // навигацию. На чистом телефоне это первый экран, который видит человек.
    box.append(el('p', { textContent: 'Записей пока нет.' }));
    box.append(el('button', {
      className: 'go', textContent: 'Сегодняшний день →',
      onclick: () => navigate('day', { date: todayISO() }),
    }));
    box.append(el('button', {
      className: 'go ghost', textContent: 'Календарь',
      onclick: () => navigate('calendar', { date: todayISO() }),
    }));
    return;
  }

  const shown = params.all ? dates : dates.slice(0, LIMIT);

  for (const iso of shown) {
    const rec = dayRecord(iso, ctx);
    const card = el('section', { className: 'card jrec' });

    // Главная цифра дня стоит справа в строке: список читается сводкой,
    // а не оглавлением, и вес видно без открытия дня.
    card.append(el('button', {
      className: 'jrec-head',
      onclick: () => navigate('day', { date: iso }),
    },
    el('span', {
      className: 'jrec-date',
      textContent: `${weekdayShort(iso)} ${iso.slice(8)}.${iso.slice(5, 7)}.${iso.slice(2, 4)}`
        + (iso === todayISO() ? ' · сегодня' : '')
        + (rec.backdated ? ' · задним числом' : ''),
    }),
    rec.weight != null
      ? el('span', { className: 'jrec-figure', textContent: `${String(rec.weight).replace('.', ',')} кг` })
      : null));

    card.append(renderRecord(rec, {
      onOpen: (kind) => navigate('workout', { date: iso, kind }),
    }));

    box.append(card);
  }

  if (!params.all && dates.length > LIMIT) {
    box.append(el('button', {
      className: 'go', textContent: `Показать все (${dates.length})`,
      onclick: () => navigate('journal', { all: true }),
    }));
  }
}
