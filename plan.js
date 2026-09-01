const SCHEMA = 2;

export const PHASES = ['deficit', 'bulk', 'cut'];
const WEEK_KINDS = ['work', 'deload'];
// `skill` появился с Н3: навыковый день идёт в зале, но железа в нём нет,
// и сводить его с силовым в одну строку своду по объёму нельзя.
const DAY_KINDS = ['gym', 'home', 'skill', 'mobility', 'cardio'];

const isISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

export function validatePlan(obj) {
  const errors = [];
  const bad = (m) => errors.push(m);

  if (!obj || typeof obj !== 'object') {
    return { ok: false, errors: ['файл не содержит объекта'] };
  }
  if (obj.schema !== SCHEMA) {
    bad(`неизвестная версия схемы: ${obj.schema} (ожидается ${SCHEMA})`);
  }
  if (!obj.id) bad('нет поля id — по нему цикл отличается от соседнего');
  if (!PHASES.includes(obj.phase)) {
    bad(`неизвестная фаза: ${JSON.stringify(obj.phase)} (допустимы ${PHASES.join(', ')})`);
  }
  if (!isISO(obj.from)) bad(`некорректное поле from: ${obj.from}`);
  if (!isISO(obj.to)) bad(`некорректное поле to: ${obj.to}`);
  if (isISO(obj.from) && isISO(obj.to) && obj.from > obj.to) {
    bad(`from ${obj.from} позже to ${obj.to}`);
  }
  if (!Array.isArray(obj.weeks) || obj.weeks.length === 0) {
    bad('нет недель (weeks)');
    return { ok: false, errors };
  }

  const seenDates = new Set();
  obj.weeks.forEach((w, wi) => {
    const at = `неделя ${wi + 1}`;
    if (typeof w.n !== 'number') bad(`${at}: поле n должно быть числом`);
    if (w.kind !== undefined && !WEEK_KINDS.includes(w.kind)) {
      bad(`${at}: неизвестный тип недели ${JSON.stringify(w.kind)}`);
    }
    if (!Array.isArray(w.days) || w.days.length === 0) {
      bad(`${at}: нет дней (days)`);
      return;
    }
    w.days.forEach((d, di) => {
      const dat = `${at}, день ${di + 1}`;
      if (!isISO(d.date)) {
        bad(`${dat}: некорректное поле date: ${d.date}`);
      } else if (seenDates.has(d.date)) {
        bad(`${dat}: дата ${d.date} встречается дважды`);
      } else {
        seenDates.add(d.date);
        if (isISO(obj.from) && isISO(obj.to) && (d.date < obj.from || d.date > obj.to)) {
          bad(`${dat}: дата ${d.date} вне диапазона цикла ${obj.from}—${obj.to}`);
        }
      }
      if (!Array.isArray(d.sessions) || d.sessions.length === 0) {
        bad(`${dat}: нет сессий (sessions)`);
        return;
      }
      const seenKinds = new Set();
      d.sessions.forEach((s, si) => {
        const sat = `${dat}, сессия ${si + 1}`;
        if (!s.code) bad(`${sat}: нет code`);
        if (!DAY_KINDS.includes(s.kind)) {
          bad(`${sat}: неизвестный вид сессии ${JSON.stringify(s.kind)}`);
          return;
        }
        if (seenKinds.has(s.kind)) bad(`${sat}: вид ${s.kind} в этом дне уже есть`);
        seenKinds.add(s.kind);

        if (s.kind === 'mobility') {
          if (!Array.isArray(s.positions) || s.positions.length === 0) {
            bad(`${sat}: день растяжки без позиций (positions)`);
            return;
          }
          s.positions.forEach((pos, pi) => {
            if (!pos.name) bad(`${sat}, позиция ${pi + 1}: нет name`);
            if (!pos.dose) bad(`${sat}, позиция ${pi + 1}: нет дозы (dose)`);
          });
          return;
        }

        if (!Array.isArray(s.exercises) || s.exercises.length === 0) {
          bad(`${sat}: нет упражнений`);
          return;
        }
        s.exercises.forEach((e, ei) => {
          const eat = `${sat}, упражнение ${ei + 1}`;
          if (!e.name) bad(`${eat}: нет name`);
          if (!Number.isFinite(e.sets) || e.sets < 1) {
            bad(`${eat}: поле sets должно быть числом ≥ 1, получено ${JSON.stringify(e.sets)}`);
          }
          if (e.reps === undefined || e.reps === '') bad(`${eat}: нет reps`);
          if (e.rest !== undefined && !Number.isFinite(e.rest)) {
            bad(`${eat}: поле rest должно быть числом секунд`);
          }
          if (e.rpe !== undefined && !Number.isFinite(e.rpe)) {
            bad(`${eat}: поле rpe должно быть числом`);
          }
        });
      });
    });
  });

  return { ok: errors.length === 0, errors };
}

/** Границы цикла: поля from/to, а при их отсутствии — крайние даты дней. */
export function planRange(plan) {
  if (!plan) return null;
  if (isISO(plan.from) && isISO(plan.to)) return { from: plan.from, to: plan.to };
  const dates = sessionDates(plan);
  if (!dates.length) return null;
  return { from: dates[0], to: dates[dates.length - 1] };
}

/**
 * План, покрывающий дату. При пересечении диапазонов выигрывает тот,
 * что начался позже: новый цикл вытесняет старый, а не наоборот.
 */
export function pickPlan(plans, iso) {
  const hits = (plans || []).filter((p) => {
    const r = planRange(p);
    return r && iso >= r.from && iso <= r.to;
  });
  if (!hits.length) return null;
  return hits.sort((a, b) => planRange(a).from.localeCompare(planRange(b).from)).at(-1);
}

export function dayForDate(plan, iso) {
  if (!plan) return null;
  for (const week of plan.weeks) {
    for (const day of week.days) {
      if (day.date === iso) return { week, day };
    }
  }
  return null;
}

/** Сессия нужного вида в этот день: зал, дом, растяжка или кардио. */
export function sessionFor(plan, iso, kind) {
  const hit = dayForDate(plan, iso);
  if (!hit) return null;
  const s = (hit.day.sessions || []).find((x) => x.kind === kind);
  return s ? { week: hit.week, day: hit.day, session: s } : null;
}

/** Все сессии дня в порядке плана. */
export function sessionsFor(plan, iso) {
  const hit = dayForDate(plan, iso);
  return hit ? (hit.day.sessions || []).map((s) => ({ week: hit.week, day: hit.day, session: s })) : [];
}

/**
 * Силовые и кардио-сессии всех циклов, отсортированные по дате.
 * Растяжка сюда не идёт — у неё свой экран.
 */
export function trainingSessions(plans) {
  const out = [];
  for (const plan of plans || []) {
    for (const week of plan.weeks || []) {
      for (const day of week.days || []) {
        for (const s of day.sessions || []) {
          if (s.kind === 'mobility') continue;
          out.push({
            date: day.date,
            weekN: week.n,
            weekKind: week.kind || 'work',
            planId: plan.id,
            kind: s.kind,
            code: s.code,
            title: s.title || s.code,
            count: (s.exercises || []).length,
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}

/**
 * Окно сессий вокруг даты: прошлые нужны, чтобы дописать пропущенное,
 * будущие — чтобы посмотреть, что предстоит.
 */
export function sessionsAround(plans, iso, { back = 10, forward = 4 } = {}) {
  const all = trainingSessions(plans);
  const past = all.filter((s) => s.date < iso).slice(-back);
  const today = all.filter((s) => s.date === iso);
  const next = all.filter((s) => s.date > iso).slice(0, forward);
  return { past, today, next };
}

export function sessionDates(plan) {
  const out = [];
  for (const w of plan.weeks) for (const d of w.days) out.push(d.date);
  return out.sort();
}

/** Пороги объёма текущей фазы: план главнее настроек. */
export function mevFor(plan, settings) {
  return (plan && plan.mev) || (settings && settings.mev) || {};
}

/**
 * Целевые пороги цикла с учётом ручного перекрытия. Перекрытие живёт,
 * пока активен тот же цикл: новый план забирает пороги себе (R25).
 */
export function targetsFor(plan, settings) {
  const base = { ...((plan && plan.targets) || {}) };
  if (!plan || !settings) return base;
  if (settings.overrideCycle !== plan.id) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(settings.goalOverrides || {})) {
    // Порога, которого нет в плане, перекрытие не создаёт: иначе на экране
    // появлялась строка без подписи, единиц и источника данных.
    if (v != null && out[k]) out[k] = { ...out[k], value: v, overridden: true };
  }
  return out;
}
