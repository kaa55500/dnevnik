import { movingAverage, weightSeries, e1rm, E1RM_MAX_REPS } from '../analytics.js';

/**
 * Текущее значение цели по её источнику данных.
 * Источники: day.<поле> — среднее за 7 дней, week.<поле> — последняя запись,
 * exercise:<название> — лучший рабочий подход за всю историю, а также
 * exercise-weight:, exercise-minutes:, exercise-km:, exercise-sec: для остальных
 * полей подхода, exercise-reps-at:<название>@<кг> — повторы с весом не ниже
 * порога, exercise-e1rm: — расчётный максимум.
 * «Лучший» зависит от направления цели: вверх — максимум, вниз — минимум.
 * Ничего не нашлось — null: цель показывается прочерком, а не нулём (R24).
 */
export function currentValue(source, ctx, dir = 'up') {
  if (!source) return null;

  if (source.startsWith('day.')) {
    const key = source.slice(4);
    // Вес читается тем же рядом, что на «Динамике»: ноль 22.09 тянул среднее вниз.
    const series = key === 'weight' ? weightSeries(ctx.days) : (ctx.days || [])
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
  // Сравнивается сделанное, а не плановое: подходы замены засчитывались
  // в цель упражнения, которое в тот день не делали.
  const sameExercise = (ex, name) => stem(ex.replacedWith || ex.name) === stem(name);

  // Лучший подход за историю. Кардио пишет минуты и километры, а не повторы:
  // без своих источников цель «перезамер 5 км» была недостижима (#9).
  const FIELD = {
    'exercise:': (s) => s.reps,
    'exercise-weight:': (s) => s.weight,
    'exercise-minutes:': (s) => s.minutes,
    'exercise-km:': (s) => s.km,
    // Удержания переехали из повторов в своё поле 07.09. Цели «уголок 30 с»
    // и «флажок» читали `reps` — то есть считали секундами то, что секундами
    // не было: у флажка в базе лежат два полных повтора за 29.08, а вовсе
    // не две секунды. История не переписывается, счёт идёт с первого замера
    // в новом поле: прочерк честнее чужого числа (R24).
    'exercise-sec:': (s) => s.sec,
    // Цель с весом читает повторы только с этим весом и выше: «+50×5»
    // показывалась взятой по разгрузочному подходу 0 кг × 16 от 19.09.
    'exercise-reps-at:': (s, kg) => (s.weight != null && s.weight >= kg ? s.reps : null),
    // Силовая цель — расчётный максимум, а не поднятый вес: «жим 140»
    // читается по Бжицки, 124,5×5 (правило 5), а не по штанге на 140.
    'exercise-e1rm:': (s) => (s.weight != null && s.reps > 0 && s.reps <= E1RM_MAX_REPS
      ? Math.round(e1rm(s.weight, s.reps, s.rpe) * 10) / 10 : null),
  };
  const prefix = Object.keys(FIELD).find((p) => source.startsWith(p));
  if (prefix) {
    const read = FIELD[prefix];
    // «Подтягивания с весом@50»: после @ — порог веса для `exercise-reps-at:`.
    const [name, at] = source.slice(prefix.length).split('@');
    const kg = at != null ? parseFloat(at) : null;
    const better = (v, b) => (dir === 'down' ? v < b : v > b);
    let best = null;
    for (const w of ctx.workouts || []) {
      for (const ex of w.exercises || []) {
        if (!sameExercise(ex, name)) continue;
        // Расчётный максимум ведётся по паре «имя + вариант» (29.10): жим в раме
        // в «жим 140» не засчитывается. Остальные цели вариант считают тем же.
        if (prefix === 'exercise-e1rm:' && ex.variant) continue;
        for (const s of ex.sets || []) {
          if (s.warmup) continue;
          const v = read(s, kg);
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
