import { listDays, listWorkouts, getExercises, getSettings, listWeeks, listPlans } from '../store.js';
import {
  pickPlan, planRange, mevFor, targetsFor, volumeMethod, groupLabel, volumeTarget,
} from '../plan.js';
import {
  movingAverage, trendPerWeek, forecastDate, weeklyBest, detectPlateau, weightSeries,
  weeklyVolume, readinessFlags, paceAdvice,
} from '../analytics.js';
import { sparkline } from '../charts.js';
import { fmtNum, fmtSigned, fmtWeight } from '../lib/format.js';
import { todayISO, isoWeek, weekDays } from '../lib/dates.js';
import { navigate } from '../main.js';

const TABS = [
  ['body', 'Тело'], ['strength', 'Сила'], ['volume', 'Объём'], ['ready', 'Готовность'],
];

const PHASE_RU = { deficit: 'дефицит', bulk: 'набор', cut: 'сушка' };
let active = 'body';

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

function table(rows) {
  const t = el('table');
  for (const [a, b, cls] of rows) {
    const tr = el('tr', cls ? { className: cls } : {});
    tr.append(el('td', { textContent: a }), el('td', { textContent: b }));
    t.append(tr);
  }
  return t;
}

function bodyPane(pane, { days, weeks, settings, plan, plans }) {
  const series = weightSeries(days);

  if (series.length === 0) {
    pane.append(el('p', { textContent: 'Веса ещё нет. Заполни утренний чек-ин.' }));
    return;
  }

  const avg = movingAverage(series, 7);
  const trend = trendPerWeek(series);
  const last = avg.length ? avg[avg.length - 1].value : series[series.length - 1].value;
  const targets = targetsFor(plan, settings);
  const goal = targets.weight ? targets.weight.value : settings.goalWeight;
  const phase = plan ? plan.phase : null;

  if (plan) {
    pane.append(el('p', {
      className: 'phase',
      textContent: `${plan.title} · фаза: ${PHASE_RU[plan.phase] || plan.phase}`,
    }));
  }

  // Среднее считается по календарной неделе, а не по семи записям: подсказка
  // ждёт, пока ряд накроет неделю, а не седьмого взвешивания.
  if (!avg.length) {
    pane.append(el('p', {
      className: 'hint',
      textContent: `Точек веса: ${series.length}. Среднее за 7 дней появится, когда ряд накроет неделю.`,
    }));
  }

  // Границы циклов размечаются, иначе смена фазы читается как аномалия данных.
  const marks = (plans || [])
    .map((p) => planRange(p))
    .filter(Boolean)
    .map((r) => ({ date: r.from }));
  pane.append(sparkline(avg.length ? avg : series, { marks }));

  const rows = [
    [avg.length ? 'среднее за 7 дней' : 'последний вес', fmtNum(last, 1) + ' кг'],
    ['темп', trend != null ? fmtSigned(trend, 2) + ' кг/нед' : 'мало данных'],
    ['цель', fmtNum(goal, 1) + ' кг' + (targets.weight && targets.weight.overridden ? ' (своё)' : '')],
    ['осталось', fmtSigned(goal - last, 1) + ' кг'],
    ['прогноз', trend != null
      ? (forecastDate(last, goal, trend, todayISO()) || 'движение не к цели')
      : '—'],
  ];

  const lastWeek = [...weeks].sort((a, b) => a.id.localeCompare(b.id)).at(-1);
  if (lastWeek) {
    const labels = [['waist', 'талия', 'см'], ['arm', 'рука', 'см'], ['calf', 'голень', 'см'],
      ['chest', 'грудь', 'см'], ['splitGap', 'шпагат', 'см'],
      ['handstandSec', 'стойка на руках', 'с'], ['handstandWalk', 'ходьба на руках', 'м'],
      ['kcalAvg', 'ккал ср.', ''], ['proteinAvg', 'белок ср.', 'г']];
    for (const [k, label, unit] of labels) {
      if (lastWeek[k] != null) {
        // Просвет, снятый по разным протоколам, — разные величины. Пометка
        // обязательна: без неё несравнимые цифры молча встают в один ряд.
        const mark = k !== 'splitGap' ? ''
          : (lastWeek.splitProtocol === 'post' ? ' · после тренировки'
            : (lastWeek.splitNoHome ? ' · без домашней' : ''));
        rows.push([label, (fmtWeight(lastWeek[k]) + ' ' + unit).trim() + mark]);
      }
    }
  }
  pane.append(table(rows));

  const advice = paceAdvice(trend, phase, plan && plan.pacePerWeek);
  if (advice) pane.append(el('p', { className: 'hint', textContent: advice.text }));
  if (!plan) {
    pane.append(el('p', {
      className: 'hint',
      textContent: 'Активного цикла нет — советы по темпу молчат, чтобы не врать фазой.',
    }));
  }
}

/**
 * Строка о черновиках с подходами: «Сила» и «Объём» считают только закрытые
 * сессии и раньше молчали о выпавших — W43 показывала «сессий 0» при двух
 * начатых тренировках (20.10, 22.10). Тап открывает самый ранний черновик.
 */
function draftLine(drafts) {
  const open = drafts.filter((w) => w.status === 'draft'
    && (w.exercises || []).some((e) => (e.sets || []).length))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!open.length) return null;
  const first = open[0];
  return el('button', {
    className: 'debt-row',
    textContent: `не закрыто черновиков: ${open.length} — в счёт не идут →`,
    onclick: () => navigate('workout', { date: first.date, kind: first.kind, code: first.dayCode }),
  });
}

function strengthPane(pane, { workouts: all }) {
  // Только закрытые сессии — так же, как в своде недели и на вкладке объёма.
  // Черновик с опечаткой в повторах («105 × 40» вместо «× 4») давал 245 кг
  // расчётного максимума, а `detectPlateau` дальше объявлял плато навсегда:
  // все следующие недели заведомо ниже. И это на контрольном лифте, по
  // которому меряется цель 140 кг.
  const workouts = all.filter((w) => w.status === 'done');
  const drafts = draftLine(all);
  if (drafts) pane.append(drafts);
  // Строка — то, что делалось: замена своей строкой (у плановой её подходов нет),
  // вариант снаряда — своей строкой рядом с основным (решение 29.10).
  const keys = new Map();
  for (const w of workouts) {
    for (const e of w.exercises || []) {
      if (e.skipped || !(e.sets || []).length) continue;
      const name = e.replacedWith || e.name;
      const variant = e.replacedWith ? null : (e.variant || null);
      keys.set(`${name}|${variant || ''}`, { name, variant });
    }
  }
  const rows = [...keys.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru')
    || String(a.variant || '').localeCompare(String(b.variant || ''), 'ru'));

  if (!rows.length) {
    pane.append(el('p', { textContent: 'Ещё нет записанных подходов.' }));
    return;
  }

  for (const { name, variant } of rows) {
    const best = weeklyBest(workouts, name, variant);
    if (!best.length) continue;
    const plateau = detectPlateau(best);
    const row = el('div', { className: 'strength-row' });
    row.append(el('h3', {
      textContent: name + (variant ? ` · ${variant}` : '') + (plateau ? '  · плато' : ''),
      className: plateau ? 'plateau' : '',
    }));
    row.append(el('div', {
      className: 'strength-weeks',
      textContent: best.map((b) => `${b.week.slice(-3)}: ${fmtWeight(b.weight)}×${b.reps}`).join('  ·  '),
    }));
    pane.append(row);
  }
}

function volumePane(pane, { workouts, exercises, settings, plan }) {
  const week = isoWeek(todayISO());
  const dates = weekDays(week);
  const wk = workouts.filter((w) => dates.includes(w.date) && w.status === 'done');
  const method = volumeMethod(plan);
  const { volume, unknown } = weeklyVolume(wk, exercises, { method });
  const mev = mevFor(plan, settings);

  pane.append(el('p', {
    textContent: `Неделя ${week} · сессий ${wk.length}`
      + (plan ? ` · пороги фазы «${PHASE_RU[plan.phase] || plan.phase}»` : ' · пороги по умолчанию'),
  }));
  const drafts = draftLine(workouts.filter((w) => dates.includes(w.date)));
  if (drafts) pane.append(drafts);

  // Цель ★★★ — рядом с порогом: порог урезан до плана и недобор, заложенный
  // в план, не видит; цель видит (п. 17 очереди).
  const rows = Object.entries(mev).map(([g, threshold]) => {
    const v = volume[g] || 0;
    const target = volumeTarget(plan, g);
    return [groupLabel(plan, g),
      `${fmtNum(v, 1)} / MEV ${threshold}` + (target != null ? ` · цель ${target}` : ''),
      v < threshold ? 'low' : ''];
  });
  pane.append(table(rows));

  if (unknown.length) {
    pane.append(el('div', { className: 'banner' },
      el('p', { textContent: 'Нет коэффициентов вклада, объём по ним не считается:' }),
      el('p', { textContent: unknown.join(', ') })));
  }

  pane.append(el('p', {
    className: 'hint',
    textContent: method === 'audit'
      ? 'Подходы — как в аудите цикла: целевая группа 1, существенная 0,5;'
        + ' косвенная 0,25, стойка и голеностоп не считаются. Цель — доза групп ★★★.'
      : 'Эффективные подходы: целевая группа 1, вторичная 0,5, косвенная 0,25.',
  }));
}

function readyPane(pane, { days, workouts, settings }) {
  const flags = readinessFlags(days, settings, workouts);

  if (flags.length >= 2) {
    pane.append(el('div', {
      className: 'banner',
      textContent: 'Два сигнала усталости — следующую неделю лёгкой.',
    }));
  }
  if (!flags.length) pane.append(el('p', { textContent: 'Сигналов нет.' }));
  for (const f of flags) pane.append(el('p', { textContent: '• ' + f.text }));

  const sleep = days.filter((d) => d.sleepHours != null)
    .map((d) => ({ date: d.date, value: d.sleepHours }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (sleep.length > 1) {
    pane.append(el('h3', { textContent: 'Сон, ч' }), sparkline(sleep));
  }

  const hr = days.filter((d) => d.restingHR != null)
    .map((d) => ({ date: d.date, value: d.restingHR }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (hr.length > 1) {
    pane.append(el('h3', { textContent: 'Пульс покоя' }), sparkline(hr));
  }
}

export async function render(box) {
  const [days, workouts, exercises, settings, weeks, plans] = await Promise.all([
    listDays(), listWorkouts(), getExercises(), getSettings(), listWeeks(), listPlans(),
  ]);
  const plan = pickPlan(plans, todayISO());
  const ctx = { days, workouts, exercises, settings, weeks, plans, plan };

  const bar = el('div', { className: 'tabs2' });
  for (const [key, label] of TABS) {
    bar.append(el('button', {
      textContent: label,
      className: key === active ? 'active' : '',
      onclick: () => { active = key; box.innerHTML = ''; render(box); },
    }));
  }
  box.append(bar);

  const pane = el('div', { className: 'pane' });
  box.append(pane);

  if (active === 'body') bodyPane(pane, ctx);
  if (active === 'strength') strengthPane(pane, ctx);
  if (active === 'volume') volumePane(pane, ctx);
  if (active === 'ready') readyPane(pane, ctx);

  box.append(el('button', {
    className: 'go goals-link', textContent: 'Цели →',
    onclick: () => navigate('goals'),
  }));
}
