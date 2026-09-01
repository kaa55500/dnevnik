import { listDays, listWeeks, listWorkouts, listPlans, getSettings, putSettings } from '../store.js';
import { pickPlan, targetsFor } from '../plan.js';
import { todayISO } from '../lib/dates.js';
import { fmtNum, fmtSigned, fmtWeight, parseNum } from '../lib/format.js';
import { goalState, splitByData } from './goals-logic.js';
import { el } from './day.js';
import { navigate } from '../main.js';

let finishCache = null;

async function finishGoals() {
  if (finishCache) return finishCache;
  try {
    finishCache = await fetch('data/goals-finish.json').then((r) => r.json());
  } catch {
    return null;                 // экран остаётся, финишный блок молчит
  }
  return finishCache;
}

function goalRow(st, onEdit) {
  const row = el('div', { className: 'goal-row' + (st.onTrack ? ' ok' : '') });
  row.append(el('span', { className: 'goal-label', textContent: st.label }));

  if (!st.hasData) {
    row.append(el('span', { className: 'goal-value dash', textContent: '—' }));
    row.append(el('span', { className: 'goal-note', textContent: 'нет базы' }));
    return row;
  }

  row.append(el('span', {
    className: 'goal-value',
    textContent: `${fmtWeight(st.current)} → ${fmtWeight(st.value)} ${st.unit}`,
  }));
  row.append(el('span', {
    className: 'goal-delta',
    textContent: st.onTrack ? 'взято' : `${fmtSigned(-st.delta, 1)}`,
  }));
  if (st.overridden) row.append(el('span', { className: 'goal-note', textContent: 'своё' }));
  if (onEdit) {
    row.append(el('button', {
      className: 'goal-edit', textContent: 'правка', onclick: () => onEdit(st),
    }));
  }
  return row;
}

export async function render(box) {
  const today = todayISO();
  const [days, weeks, workouts, plans, settings] = await Promise.all([
    listDays(), listWeeks(), listWorkouts(), listPlans(), getSettings(),
  ]);
  const plan = pickPlan(plans, today);
  const ctx = { days, weeks, workouts };

  box.append(el('h1', { textContent: 'Цели' }));

  // ---------- Пороги текущего цикла ----------
  if (!plan) {
    box.append(el('p', { className: 'hint', textContent: 'Активного цикла нет — порогов тоже.' }));
  } else {
    const targets = targetsFor(plan, settings);
    box.append(el('h2', { textContent: `${plan.title} · до ${plan.to}` }));

    const edit = async (st) => {
      const raw = prompt(`Свой порог для «${st.label}» (${st.unit})`, String(st.value));
      if (raw === null) return;
      const v = parseNum(raw);
      const next = { ...settings };
      // Порог живёт ровно один цикл (R25): чужие перекрытия не переносятся,
      // иначе первая правка в новом цикле воскрешала прошлые.
      const carry = settings.overrideCycle === plan.id ? (settings.goalOverrides || {}) : {};
      next.goalOverrides = { ...carry };
      if (v == null) delete next.goalOverrides[st.key];
      else next.goalOverrides[st.key] = v;
      next.overrideCycle = plan.id;
      try {
        await putSettings(next);           // #13: молча терять порог нельзя
      } catch (err) {
        alert('Порог не сохранился: ' + err.message);
        return;
      }
      await navigate('goals');
    };

    for (const [key, t] of Object.entries(targets)) {
      const st = goalState({ ...t, key }, ctx);
      box.append(goalRow(st, edit));
    }
    if (settings.overrideCycle === plan.id
        && Object.keys(settings.goalOverrides || {}).length) {
      box.append(el('p', {
        className: 'hint',
        textContent: 'Свои пороги действуют до конца цикла — следующий план забирает их себе.',
      }));
    }
  }

  // ---------- Финиш ----------
  const finish = await finishGoals();
  if (!finish) {
    box.append(el('p', {
      className: 'hint',
      textContent: 'Цели финиша не загрузились — нет сети. Пороги цикла выше считаны из базы.',
    }));
    box.append(el('button', {
      className: 'back', textContent: '← к динамике', onclick: () => navigate('stats'),
    }));
    return;
  }
  box.append(el('h2', { textContent: finish.title }));

  const states = finish.goals.map((g) => goalState(g, ctx));
  const { tracked, blind } = splitByData(states);
  for (const st of tracked) box.append(goalRow(st, null));

  if (blind.length) {
    box.append(el('h3', { textContent: 'Без базы' }));
    box.append(el('p', {
      className: 'hint',
      textContent: 'Ноль тоже логируется: пока по этим целям нет ни одной записи, они остаются прочерком.',
    }));
    for (const st of blind) box.append(goalRow(st, null));
  }

  box.append(el('button', {
    className: 'back', textContent: '← к динамике',
    onclick: () => navigate('stats'),
  }));
}
