import { fmtNum, fmtWeight } from '../lib/format.js';
import { pickPlan, sessionsFor } from '../plan.js';
import { isoWeek, fromISO } from '../lib/dates.js';

const SIGNALS = {
  headache: 'головная боль',
  knee: 'колено',
  chest: 'правая грудь',
  joints: 'ноющие суставы',
};

const KIND_RU = { gym: 'зал', home: 'дом', skill: 'навык', cardio: 'кардио', mobility: 'растяжка' };

const has = (v) => v !== null && v !== undefined;
const same = (list) => list.every((v) => v === list[0]);

/**
 * Подходы сворачиваются в группы: подряд идущие с одним весом, RPE и типом —
 * одна строка. Четыре одинаковых подхода несут одну мысль, а не четыре,
 * и повторять их в журнале значит прятать в шуме то, что менялось.
 */
export function foldSets(sets) {
  const groups = [];
  for (const s of sets || []) {
    const key = [s.weight, s.rpe, Boolean(s.warmup), Boolean(s.control),
      s.minutes, s.km, s.hr].join('|');
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(s);
    else groups.push({ key, items: [s] });
  }

  return groups.map(({ items }) => {
    const s = items[0];
    // Кардио меряется временем и дистанцией — колонок веса и повторов у него нет.
    if (has(s.minutes) || has(s.km)) {
      const parts = [];
      if (has(s.minutes)) parts.push(`${fmtWeight(s.minutes)} мин`);
      if (has(s.km)) parts.push(`${fmtWeight(s.km)} км`);
      if (has(s.hr)) parts.push(`пульс ${s.hr}`);
      return { cardio: parts.join(' · '), mark: null };
    }

    const reps = items.map((x) => x.reps);
    const repText = same(reps)
      ? (items.length > 1 ? `${items.length}×${reps[0]}` : String(reps[0] ?? '—'))
      : reps.map((r) => (has(r) ? r : '—')).join(',');

    return {
      weight: has(s.weight) ? fmtWeight(s.weight) : '—',
      reps: repText,
      rpe: has(s.rpe) ? fmtNum(s.rpe, 1) : '',
      mark: s.warmup ? 'разм.' : (s.control ? 'контроль' : null),
    };
  });
}

/** Строка упражнения для журнала: название плюс свёрнутые группы подходов. */
export function exerciseRow(ex) {
  // При замене показывается то, что делалось. Плановое название уходит
  // в подпись: пара «план → факт» в одну строку не влезает и обрезается
  // ровно там, где начинается смысл.
  const name = ex.replacedWith || ex.name;
  const replaced = ex.replacedWith ? (ex.planName || ex.name) : null;
  if (ex.skipped) {
    return {
      name, replaced, skipped: true, groups: [],
      reason: ex.skipReason || 'без причины', note: ex.note || null,
    };
  }
  const groups = foldSets(ex.sets);
  if (!groups.length) return null;
  return { name, replaced, skipped: false, groups, note: ex.note || null };
}

/** Отметки утреннего чек-ина, каждая с подписью. Пустые поля молчат. */
function morningRows(day, settings) {
  const out = [];
  if (!day) return out;
  if (has(day.sleepHours)) out.push({ label: 'сон', value: `${fmtWeight(day.sleepHours)} ч` });
  if (has(day.sleepQuality)) out.push({ label: 'качество сна', value: `${day.sleepQuality} из 5` });
  if (has(day.restingHR)) out.push({ label: 'пульс покоя', value: String(day.restingHR) });
  if (has(day.wellbeing)) out.push({ label: 'самочувствие', value: `${day.wellbeing} из 5` });
  if (has(day.bpSys) && has(day.bpDia)) {
    out.push({ label: 'давление', value: `${day.bpSys}/${day.bpDia}` });
  }
  if (day.vacuum) out.push({ label: 'вакуум', value: 'да' });
  for (const key of settings?.signals || ['headache']) {
    if (day[key]) out.push({ label: SIGNALS[key] || key, value: 'да', alert: true });
  }
  return out;
}

/** Вечер: ходьба, процедуры, кардио-сессии. */
function eveningRows(day) {
  const out = [];
  if (!day) return out;
  if (has(day.walkKm)) out.push({ label: 'ходьба', value: `${fmtWeight(day.walkKm)} км` });
  if (day.tke) out.push({ label: 'TKE', value: 'да' });
  if (day.mfr) out.push({ label: 'МФР', value: 'да' });
  for (const c of day.cardio || []) {
    out.push({
      label: c.type,
      value: `${has(c.minutes) ? `${fmtWeight(c.minutes)} мин` : '—'}`
        + (has(c.hr) ? ` · пульс ${c.hr}` : '')
        + (has(c.km) ? ` · ${fmtWeight(c.km)} км` : ''),
    });
  }
  return out;
}

/**
 * Недельные замеры показываются в тот день, когда их снимают: талия в среду,
 * просвет шпагата во вторник. Иначе цифра либо теряется, либо дублируется
 * все семь дней подряд.
 */
function weekRows(iso, week) {
  if (!week) return [];
  const dow = fromISO(iso).getDay();
  const out = [];
  const push = (label, v, unit) => { if (has(v)) out.push({ label, value: `${fmtWeight(v)} ${unit}` }); };
  if (dow === 3) push('талия', week.waist, 'см');
  if (dow === 2 && has(week.splitGap)) {
    // Протокол замера идёт вместе с цифрой: с 31.08 просвет снимается после
    // тренировки, и с цифрами до этой даты в один ряд он не встаёт.
    const mark = week.splitProtocol === 'post' ? ' · после тренировки'
      : (week.splitNoHome ? ' · без домашней' : '');
    out.push({ label: 'просвет шпагата', value: `${fmtWeight(week.splitGap)} см${mark}` });
  }
  if (dow === 0) {
    push('ккал ср.', week.kcalAvg, '');
    push('белок ср.', week.proteinAvg, 'г');
    push('стойка на руках', week.handstandSec, 'с');
    push('ходьба на руках', week.handstandWalk, 'м');
    push('рука', week.arm, 'см');
    push('грудь', week.chest, 'см');
    push('бёдра', week.hips, 'см');
    push('голень', week.calf, 'см');
    push('шея', week.neck, 'см');
    if (week.photo) out.push({ label: 'фото', value: 'снято' });
  }
  return out;
}

/** Блок растяжки: отмеченные позиции этого дня по плану. */
function mobilitySession(iso, day, plans) {
  const plan = pickPlan(plans || [], iso);
  const planned = sessionsFor(plan, iso)
    .map((x) => x.session).find((x) => x.kind === 'mobility');
  const marks = (day && day.stretch) || {};
  const done = Object.entries(marks).filter(([, v]) => v).map(([n]) => Number(n));
  if (!done.length) return null;

  const secs = (day && day.stretchSec) || {};
  const names = (planned?.positions || [])
    .filter((p) => marks[p.n])
    .map((p) => (has(secs[p.n]) ? `${p.name} · ${secs[p.n]} с` : p.name));

  // Сумма удержаний — то, ради чего секунды и пишутся: недельная доза
  // сравнивается с потолком 10 минут на группу (ИССЛЕДОВАНИЯ.md, запись 36).
  const total = done.reduce((a, n) => a + (has(secs[n]) ? secs[n] : 0), 0);

  return {
    kind: 'mobility',
    title: KIND_RU.mobility,
    code: planned?.code || 'Растяжка',
    done: done.length,
    total: planned?.positions?.length ?? null,
    seconds: total || null,
    names: names.length ? names : done.map((n) => `позиция ${n}`),
  };
}

/**
 * Всё, что записано за день: утро, сессии, вечер, недельные замеры.
 * Растяжка — такая же сессия, как зал: раньше она сводилась к строчке
 * «растяжка: 5 позиций» внизу и в журнале была неотличима от заметки.
 */
export function dayRecord(iso, ctx) {
  const day = (ctx.days || []).find((d) => d.date === iso) || null;
  const week = (ctx.weeks || []).find((w) => w.id === isoWeek(iso)) || null;

  const workouts = (ctx.workouts || [])
    .filter((w) => w.date === iso)
    .sort((a, b) => (a.kind || '').localeCompare(b.kind || ''));

  const sessions = workouts.map((w) => ({
    id: w.id,
    kind: w.kind || 'gym',
    title: KIND_RU[w.kind || 'gym'] || w.kind,
    code: w.dayCode,
    weekN: w.weekN,
    status: w.status,
    avgRPE: w.avgRPE,
    chestSignal: w.chestSignal,
    rows: (w.exercises || []).map(exerciseRow).filter(Boolean),
  }));

  const mob = mobilitySession(iso, day, ctx.plans);
  if (mob) sessions.push(mob);

  const morning = morningRows(day, ctx.settings);
  const evening = eveningRows(day);
  const weekly = weekRows(iso, week);

  return {
    date: iso,
    backdated: Boolean(day && day.backdated),
    weight: day && has(day.weight) ? day.weight : null,
    note: (day && day.note) || null,
    morning,
    sessions,
    evening,
    weekly,
    empty: !sessions.length && !morning.length && !evening.length
      && !weekly.length && !(day && has(day.weight)) && !(day && day.note),
  };
}

/** Даты с любой записью, свежие первыми — основа экрана журнала. */
export function recordedDates(ctx) {
  const dates = new Set();
  for (const d of ctx.days || []) {
    const anyField = ['weight', 'walkKm', 'sleepHours', 'restingHR', 'wellbeing',
      'sleepQuality', 'bpSys', 'vacuum', 'tke', 'mfr', 'note']
      .some((k) => has(d[k]) && d[k] !== false);
    if (anyField || (d.cardio || []).length
        || Object.values(d.stretch || {}).some(Boolean)) dates.add(d.date);
  }
  for (const w of ctx.workouts || []) dates.add(w.date);
  return [...dates].sort((a, b) => b.localeCompare(a));
}
