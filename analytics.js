import { addDays, daysBetween, isoWeek, todayISO } from './lib/dates.js';

/**
 * Скользящее среднее по календарному окну: в точку идут записи за `window`
 * дней, заканчивая её датой. Окно в записях растягивалось на две-три недели:
 * вес вносится примерно в трети дней, и «среднее за 7 дней» на деле сводило
 * семь взвешиваний за восемнадцать дней. Первая точка — там, где ряд уже
 * накрывает окно целиком; на ежедневном ряду счёт прежний.
 */
export function movingAverage(series, window = 7) {
  const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length) return [];
  const first = sorted[0].date;
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const from = addDays(sorted[i].date, -(window - 1));
    if (from < first) continue;
    let sum = 0;
    let n = 0;
    for (let j = i; j >= 0 && sorted[j].date >= from; j--) {
      sum += sorted[j].value;
      n += 1;
    }
    out.push({ date: sorted[i].date, value: sum / n });
  }
  return out;
}

/**
 * Вес ниже порога — не взвешивание, а пустое поле, сохранённое нулём (22.09),
 * или опечатка. Новые нули гасит чек-ин (`cleanMorning`), старые лежат в базе
 * и прижимали шкалу спарклайна к нулю, поэтому отсекаются на чтении.
 */
export const MIN_BODY_WEIGHT = 30;

/** Ряд веса тела по дням, по возрастанию даты, без нулей и опечаток. */
export function weightSeries(days) {
  return (days || [])
    .filter((d) => d.weight != null && d.weight >= MIN_BODY_WEIGHT)
    .map((d) => ({ date: d.date, value: d.weight }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function trendPerWeek(series, days = 21) {
  // Окно считается назад от последней прошедшей точки, а не от последней
  // введённой: один вес, записанный на будущую дату, сдвигал всё окно вперёд
  // и выбрасывал из расчёта настоящие последние недели. Темп веса и прогноз
  // выхода на целевой — то, ради чего этот расчёт и существует.
  const today = todayISO();
  const sorted = [...series].filter((p) => p.date <= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 3) return null;
  const last = sorted[sorted.length - 1].date;
  const from = addDays(last, -(days - 1));
  const pts = sorted.filter((p) => p.date >= from);
  if (pts.length < 3) return null;

  const base = pts[0].date;
  const xs = pts.map((p) => daysBetween(base, p.date));
  const ys = pts.map((p) => p.value);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) return null;
  return (num / den) * 7;               // из «за день» в «за неделю»
}

export function forecastDate(lastAvg, goal, perWeek, fromISO) {
  if (!perWeek) return null;
  const remaining = goal - lastAvg;
  if (Math.sign(remaining) !== Math.sign(perWeek)) return null;
  const weeks = remaining / perWeek;
  return addDays(fromISO, Math.round(weeks * 7));
}

/**
 * Расчётный максимум по Бжицки — той же формулой читается цель «жим 140»
 * (124,5×5, `ЗАМЕРЫ.md`). При RPE ≥ 8 к повторам прибавляется запас
 * (10 − RPE): тройка 110×3 @8 стоит 123,8, а Эпли без RPE давал 121,
 * и ряд силы «падал» на каждой неделе троек. Ниже восьми запас оценивается
 * плохо (Refalo 2024), и подход считается как доведённый до отказа —
 * оценка снизу, а не догадка сверху.
 */
export function e1rm(weight, reps, rpe = null) {
  const rir = rpe != null && rpe >= 8 ? 10 - rpe : 0;
  const d = 37 - reps - rir;
  return d > 0 ? (weight * 36) / d : null;
}

/**
 * Потолок повторов для расчётного максимума. Формула Эпли на двадцати повторах
 * даёт цифру, которой неоткуда взяться, а правило 4 прямо говорит: выше
 * двенадцати повторов ошибка оценки доходит до пяти. Опечатка «40» вместо «4»
 * иначе становится вечным рекордом — детектор плато после неё не сработает
 * больше никогда.
 */
export const E1RM_MAX_REPS = 12;

function workingSets(workout, name, variant = null) {
  // Замена ищется по фактическому имени: `ex.name` при замене не меняется,
  // и «жим в раме», сделанный вместо жима лёжа, ложился в максимум жима лёжа.
  // Вариант снаряда (с 29.10) — свой ряд: штанга и рама в один максимум не идут.
  const ex = (workout.exercises || []).find((e) => (e.replacedWith || e.name) === name
    && (e.variant || null) === (variant || null));
  // Пропуск больше не съедает записанные подходы: сделанное сделано, а метка
  // говорит лишь о том, что упражнение не доведено до планового числа.
  if (!ex) return [];
  return (ex.sets || []).filter((s) => !s.warmup && s.weight != null && s.reps != null
    && s.reps > 0 && s.reps <= E1RM_MAX_REPS);
}

export function weeklyBest(workouts, name, variant = null) {
  const byWeek = new Map();
  for (const w of workouts) {
    for (const s of workingSets(w, name, variant)) {
      const week = isoWeek(w.date);
      const value = e1rm(s.weight, s.reps, s.rpe);
      const cur = byWeek.get(week);
      if (!cur || value > cur.e1rm) {
        byWeek.set(week, { week, e1rm: value, weight: s.weight, reps: s.reps });
      }
    }
  }
  return [...byWeek.values()].sort((a, b) => a.week.localeCompare(b.week));
}

export function detectPlateau(weeklyBestList, weeks = 3) {
  if (weeklyBestList.length < weeks) return false;
  const tail = weeklyBestList.slice(-weeks);
  const peak = tail[0].e1rm;
  return tail.slice(1).every((r) => r.e1rm <= peak);
}

/**
 * Счёт объёма. `matrix` — справочник целиком: целевая группа 1, вторичная 0,5,
 * косвенная 0,25. `audit` — как аудит Ц5 (решение атлета 29.10, ЦИКЛ-5.md §6):
 * прямой 1, существенный косвенный 0,5, ярус 0,25 не считается; стойка,
 * голеностоп и скакалка — не объём. Счёт объявляет план (`plan.volume.method`),
 * у прошлых циклов его нет — матрица, и их таблицы не переписываются.
 * Без смены счёта колонка «цель 12» показывала бы недобор лучше, чем он есть.
 */
export const NOT_VOLUME = /^(Стойка|Голеностоп|Скакалка)/;

export function volumeCoef(name, k, method = 'matrix') {
  if (method !== 'audit') return k;
  return NOT_VOLUME.test(name) || k < 0.5 ? 0 : k;
}

/**
 * Недельный объём по группам. Второе значение — упражнения без коэффициентов:
 * молчаливый ноль хуже пустой строки, поэтому они возвращаются наружу (R32).
 */
export function weeklyVolume(workouts, exercises, { method = 'matrix' } = {}) {
  const coefs = new Map(exercises.map((e) => [e.name, e.groups || {}]));
  const out = {};
  const unknown = new Set();
  for (const w of workouts) {
    for (const ex of w.exercises || []) {
      // Пропуск не обнуляет сделанное: два подхода становой перед тем, как
      // сесть, — это два подхода объёма, а не ноль.
      const n = (ex.sets || []).filter((s) => !s.warmup).length;
      if (!n) continue;
      // Считается фактически сделанное, а не плановое имя. Скамья занята,
      // атлет пишет замену «жим в раме» — раньше подходы начислялись группам
      // жима лёжа по его коэффициентам, а само «жим в раме» в `unknown`
      // не попадало, то есть тревога «нет коэффициентов» молчала.
      const done = ex.replacedWith || ex.name;
      const groups = coefs.get(done);
      if (!groups) {
        unknown.add(done);
        continue;
      }
      if (Object.keys(groups).length === 0) continue;   // кардио вклада не даёт
      for (const [g, k] of Object.entries(groups)) {
        const kk = volumeCoef(done, k, method);
        if (kk) out[g] = (out[g] || 0) + n * kk;
      }
    }
  }
  for (const g of Object.keys(out)) out[g] = Math.round(out[g] * 100) / 100;
  return { volume: out, unknown: [...unknown] };
}

/**
 * Совет по темпу веса. Знак цели задаёт фаза: в дефиците и на сушке вес падает,
 * в наборе растёт. Без этого код требовал бы резать калории на наборе.
 */
export function paceAdvice(trend, phase, targetPerWeek) {
  if (trend == null) return null;
  const goal = targetPerWeek != null ? targetPerWeek : DEFAULT_PACE[phase];
  if (goal == null) return null;
  const gap = trend - goal;                        // >0 — вес идёт выше плана
  // Допуск не может быть грубее самой цели: на наборе она всего 0,15 кг/нед,
  // и порог в 0,1 съедал бы две трети сигнала.
  const tol = Math.max(0.05, Math.abs(goal) * 0.3);
  if (Math.abs(gap) <= tol) return null;
  const losing = goal < 0;
  if (losing) {
    return gap > 0
      ? { dir: 'down', text: 'Темп медленнее целевого: минус 150–200 ккал.' }
      : { dir: 'up', text: 'Темп быстрее безопасного: плюс 100–150 ккал.' };
  }
  return gap < 0
    ? { dir: 'up', text: 'Набор идёт медленнее плана: плюс 150–200 ккал.' }
    : { dir: 'down', text: 'Набор быстрее плана — лишний жир: минус 100–150 ккал.' };
}

const DEFAULT_PACE = { deficit: -0.5, cut: -0.5, bulk: 0.15 };

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function readinessFlags(days, settings, workouts) {
  // Будущие дни отбрасываются. Стрелка вперёд на экране дня открыта до конца
  // цикла — посмотреть, что завтра в зале, — и там же рисуется утренний
  // чек-ин с пустыми полями. Внесённые по привычке вес и сон становились
  // «последним днём», и сегодняшняя строка не читалась вовсе: готовность
  // показывала завтрашние цифры. `debts` будущее уже отсекает, готовность — нет.
  const today = todayISO();
  const sorted = [...days].filter((d) => d.date <= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) return [];
  const last = sorted[sorted.length - 1];
  const flags = [];

  if (last.sleepHours != null && last.sleepHours < settings.sleepNorm) {
    flags.push({ key: 'sleep', text: `сон ${last.sleepHours} ч при норме ${settings.sleepNorm}` });
  }

  const hrs = sorted.slice(-15, -1).map((d) => d.restingHR).filter((v) => v != null);
  if (last.restingHR != null && hrs.length >= 2) {
    const base = median(hrs);
    if (last.restingHR - base >= 5) {
      flags.push({ key: 'hr', text: `пульс покоя ${last.restingHR} против базы ${base}` });
    }
  }

  if (last.wellbeing != null && last.wellbeing <= 2) {
    flags.push({ key: 'wellbeing', text: `самочувствие ${last.wellbeing} из 5` });
  }

  // Правило 4: две сессии подряд с отклонением ≥ 1,5 — сигнал к пересборке.
  // Мягче этого порога RPE работает предохранителем, а не тревогой.
  // Сортировка по дате обязательна: запись задним числом ложится в конец
  // хранилища и без неё считалась бы последней тренировкой.
  // Сессия после ночи короче 6 ч в счёт не идёт (запись 50): острый недосып
  // поднимает RPE ожидаемо, и это не довод пересобирать план. Сон без записи
  // сессию не исключает — пропуск строки не должен гасить сигнал.
  const shortNight = new Set(days.filter((d) => d.sleepHours != null && d.sleepHours < 6)
    .map((d) => d.date));
  const done = (workouts || [])
    .filter((w) => w.status === 'done' && w.plannedRPE != null && w.avgRPE != null)
    .filter((w) => !shortNight.has(w.date))
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  // Правило 4 говорит «отклонение ≥1,5 от плана», а не «превышение»: сессия,
  // прошедшая на полтора ниже плана, — тот же признак, что план пора
  // пересобрать, просто в другую сторону. Код ловил только превышение, и одна
  // из двух половин сигнала молчала. Направление называется в тексте, чтобы
  // флаг не читался одинаково в противоположных случаях.
  const recent = done.slice(-2);
  const off = (w) => w.avgRPE - w.plannedRPE;
  if (recent.length === 2 && recent.every((w) => Math.abs(off(w)) >= 1.5)) {
    const up = off(recent[recent.length - 1]) > 0;
    flags.push({
      key: 'rpe',
      text: `RPE ${up ? 'выше' : 'ниже'} планового на 1,5 две тренировки подряд`,
    });
  }

  return flags;
}
