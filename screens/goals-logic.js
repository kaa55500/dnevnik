import { movingAverage } from '../analytics.js';

/**
 * Текущее значение цели по её источнику данных.
 * Источники: day.<поле> — среднее за 7 дней, week.<поле> — последняя запись,
 * exercise:<название> — лучший рабочий подход за всю историю, а также
 * exercise-weight:, exercise-minutes:, exercise-km: для остальных полей подхода.
 * «Лучший» зависит от направления цели: вверх — максимум, вниз — минимум.
 * Ничего не нашлось — null: цель показывается прочерком, а не нулём (R24).
 */
export function currentValue(source, ctx, dir = 'up') {
  if (!source) return null;

  if (source.startsWith('day.')) {
    const key = source.slice(4);
    const series = (ctx.days || [])
      .filter((d) => d[key] != null)
      .map((d) => ({ date: d.date, value: d[key] }))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!series.length) return null;
    const avg = movingAverage(series, 7);
    return avg.length ? avg[avg.length - 1].value : series[series.length - 1].value;
  }

  if (source.startsWith('week.')) {
    const key = source.slice(5);
    const rows = (ctx.weeks || [])
      .filter((w) => w[key] != null)
      .sort((a, b) => a.id.localeCompare(b.id));
    return rows.length ? rows[rows.length - 1][key] : null;
  }

  // Имя упражнения в плане несёт пометки цикла: «Уголок с пола — КОНТРОЛЬ
  // (только Н4)». Цели финиша живут до июня 2027 и переживают все циклы,
  // поэтому сравнение идёт по основе имени — до тире с пометкой. Иначе 21.09,
  // со стартом Ц4, четыре цели кора ослепли бы разом и молча: экран печатал бы
  // их без данных, а причина «имя сменилось» ниоткуда не видна.
  const stem = (n) => String(n || '').split(' — ')[0].trim().toLowerCase();
  const sameExercise = (ex, name) => {
    const want = stem(name);
    return stem(ex.name) === want || stem(ex.replacedWith) === want;
  };

  // Лучший подход за историю. Кардио пишет минуты и километры, а не повторы:
  // без своих источников цель «перезамер 5 км» была недостижима (#9).
  const FIELD = {
    'exercise:': 'reps',
    'exercise-weight:': 'weight',
    'exercise-minutes:': 'minutes',
    'exercise-km:': 'km',
  };
  const prefix = Object.keys(FIELD).find((p) => source.startsWith(p));
  if (prefix) {
    const field = FIELD[prefix];
    const name = source.slice(prefix.length);
    const better = (v, b) => (dir === 'down' ? v < b : v > b);
    let best = null;
    for (const w of ctx.workouts || []) {
      for (const ex of w.exercises || []) {
        if (!sameExercise(ex, name)) continue;
        for (const s of ex.sets || []) {
          if (s.warmup) continue;
          const v = s[field];
          if (v != null && (best == null || better(v, best))) best = v;
        }
      }
    }
    return best;
  }

  return null;
}

/** Состояние цели: значение, дельта со знаком и признак «в графике». */
export function goalState(goal, ctx) {
  const value = currentValue(goal.source, ctx, goal.dir);
  if (value == null) {
    return { ...goal, value: null, delta: null, onTrack: null, hasData: false };
  }
  const delta = goal.value - value;              // сколько осталось до цели
  const onTrack = goal.dir === 'down' ? value <= goal.value : value >= goal.value;
  return { ...goal, current: value, delta, onTrack, hasData: true };
}

/** Цели без источника данных — честный прочерк, а не скрытая строка. */
export function splitByData(states) {
  return {
    tracked: states.filter((s) => s.hasData),
    blind: states.filter((s) => !s.hasData),
  };
}
