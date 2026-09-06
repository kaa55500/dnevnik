// Выбор сессии — отдельный экран внутри вкладки «Тренировка», и живёт он
// отдельным модулем: `state` заполнения он не читает вовсе, а правки в него
// приходят своим потоком (ближайшая — ветка «цикл кончился» к 21.09).
// Пока он лежал в `workout.js`, всякая правка списка сессий открывала файл
// на тысячу семьсот строк, где рядом таймер, форма подхода и блок растяжки.

import { getPlan, listPlans, listWorkouts } from '../store.js';
import { weekdayShort } from '../lib/dates.js';
import { KIND_RU } from './day-logic.js';
import { navigate } from '../main.js';

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

/**
 * Выбор сессии: вкладка «Тренировка» открывается без даты, и упираться
 * в «сегодня тренировки нет» нельзя — любой день цикла должен открываться.
 */
export async function chooser(box, iso) {
  const [covering, plans, workouts] = await Promise.all([
    getPlan(iso), listPlans(), listWorkouts(),
  ]);

  // Цикл кончается раньше, чем заводится следующий. Экран брал только план,
  // покрывающий сегодня, и с 21.09 сказал бы «планов нет», хотя Ц3 в базе
  // лежит: показываем последний загруженный и говорим, что он прошлый.
  const latest = [...plans].sort((a, b) => String(a.from).localeCompare(String(b.from))).pop();
  const plan = covering || latest || null;
  const stale = Boolean(plan && !covering);

  box.append(el('h1', { textContent: 'Какую сессию открыть' }));

  if (stale) {
    box.append(el('p', {
      className: 'hint',
      textContent: `Цикл ${plan.id} кончился ${String(plan.to).slice(8)}.${String(plan.to).slice(5, 7)}.`
        + ' План следующего ещё не залит — ниже прошлый, для истории.',
    }));
  }

  if (!plan) {
    box.append(el('p', { textContent: 'Загруженных планов нет — импортируй план в «Ещё».' }));
    box.append(el('button', {
      className: 'back', textContent: 'Календарь →',
      onclick: () => navigate('calendar', { date: iso }),
    }));
    return;
  }

  // Тренировка ищется и по плановой дате: перенесённая остаётся на своём
  // месте в календаре, а не пропадает из списка. Точное совпадение даты
  // главнее переноса — иначе чужая запись перехватила бы чужой слот.
  const workoutFor = (s) => {
    // Код дня отсекает чужую запись: на 04.09 могут лежать плановый В2
    // и приехавший со вторника Н1, оба «зал».
    const mine = workouts.filter((x) => (x.kind || 'gym') === s.kind
      && (x.dayCode ? x.dayCode === s.code : true));
    return mine.find((x) => x.date === s.date)
      || mine.find((x) => x.movedFrom === s.date)
      || null;
  };

  const dm = (d) => `${d.slice(8)}.${d.slice(5, 7)}`;

  const row = (s) => {
    const w = workoutFor(s);
    const status = w ? w.status : null;
    const moved = w && w.date !== s.date ? w.date : null;
    const mark = (status === 'done' ? ' · записана' : (status === 'draft' ? ' · черновик' : ''))
      + (moved ? ` · сделана ${dm(moved)}` : '');
    const tone = s.date === iso ? ' now' : (s.date > iso ? ' future' : '');
    const b = el('button', {
      className: 'pick' + tone + (status === 'done' ? ' done' : '') + (moved ? ' moved' : ''),
      // Открывается там, где тренировка лежит на самом деле.
      onclick: () => navigate('workout', { date: w ? w.date : s.date, kind: s.kind, code: s.code }),
    });
    b.append(
      el('span', {
        className: 'pick-date',
        textContent: `${weekdayShort(s.date)} ${dm(s.date)}`,
      }),
      el('span', {
        className: 'pick-name',
        textContent: `${s.code} · ${KIND_RU[s.kind] || s.kind}${mark}`,
      }),
      el('span', { className: 'pick-count', textContent: `${s.count} упр.` }),
    );
    return b;
  };

  // Календарный порядок и группировка по неделям. Прежние «Сегодня» /
  // «Пропущенное и прошлое» / «Впереди» ломали хронологию: прошлое висело
  // между сегодняшним днём и ближайшими сессиями, и найти нужную дату
  // приходилось глазами по всему экрану.
  const weeks = [...(plan.weeks || [])].sort((a, b) => a.n - b.n);
  for (const week of weeks) {
    const rows = [];
    for (const day of week.days || []) {
      for (const s of day.sessions || []) {
        if (s.kind === 'mobility') continue;
        rows.push({
          date: day.date, kind: s.kind, code: s.code,
          count: (s.exercises || []).length,
        });
      }
    }
    if (!rows.length) continue;
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));

    const dates = rows.map((r) => r.date).sort();
    const from = dates[0];
    const to = dates[dates.length - 1];
    const current = iso >= from && iso <= to;
    const title = `Н${week.n} · ${dm(from)}–${dm(to)}`
      + (week.kind === 'deload' ? ' · разгрузка' : '')
      + (current ? ' · эта неделя' : '');

    const head = el('h2', { className: current ? 'wk-now' : '', textContent: title });
    box.append(head);
    for (const s of rows) box.append(row(s));
    // Список открывается на текущей неделе, а не на первой: иначе каждый раз
    // приходится проматывать два месяца прошлого, чтобы дойти до сегодня.
    if (current && typeof head.scrollIntoView === 'function') {
      setTimeout(() => head.scrollIntoView({ block: 'start' }), 0);
    }
  }

  box.append(el('button', {
    className: 'back', textContent: 'Календарь →',
    onclick: () => navigate('calendar', { date: iso }),
  }));
}
