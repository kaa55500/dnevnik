import { weekDays } from './lib/dates.js';
import { fmtNum, fmtSigned, fmtWeight } from './lib/format.js';
import { weeklyVolume, trendPerWeek } from './analytics.js';

const SCHEMA = 2;

const cell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCSV(workouts) {
  const head = 'дата;неделя;день;упражнение;подход;вес;повторы;RPE;отдых;'
    + 'минуты;км;пульс;замена;пропуск;причина';
  const rows = [head];
  for (const w of [...workouts].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const ex of w.exercises || []) {
      if (ex.skipped) {
        rows.push([w.date, w.weekN, w.dayCode, ex.name, '', '', '', '', '',
          '', '', '',
          ex.replacedWith || '', 'да', ex.skipReason || ''].map(cell).join(';'));
        continue;
      }
      (ex.sets || []).forEach((s, i) => {
        rows.push([w.date, w.weekN, w.dayCode, ex.name, i + 1,
          s.weight, s.reps, s.rpe, s.rest,
          s.minutes, s.km, s.hr,
          ex.replacedWith || '', '', ''].map(cell).join(';'));
      });
    }
  }
  return rows.join('\n') + '\n';
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const short = (g) => g.replace(/\s*★+/g, '');

export function weeklySummary({ weekId, days, week, workouts, exercises, settings, plan }) {
  const dates = weekDays(weekId);
  const inWeek = (days || []).filter((d) => dates.includes(d.date));
  const avg = mean(inWeek.map((d) => d.weight).filter((v) => v != null));

  const series = (days || []).filter((d) => d.weight != null)
    .map((d) => ({ date: d.date, value: d.weight }));
  const trend = trendPerWeek(series);

  const wk = (workouts || []).filter((w) => dates.includes(w.date) && w.status === 'done');
  const { volume: vol, unknown } = weeklyVolume(wk, exercises || []);

  const rpes = wk.flatMap((w) => (w.exercises || [])
    .flatMap((e) => (e.sets || []).map((s) => s.rpe))).filter((v) => v != null);
  const avgRPE = mean(rpes);

  const sleeps = inWeek.map((d) => d.sleepHours).filter((v) => v != null);
  const hrs = inWeek.map((d) => d.restingHR).filter((v) => v != null);

  const lines = [`${weekId} · ${dates[0]} — ${dates[6]}`];

  if (avg != null) {
    lines.push(`вес ${fmtNum(avg, 1)}`
      + (trend != null ? ` (${fmtSigned(trend, 2)} кг/нед)` : '')
      + (week?.waist != null ? ` · талия ${week.waist}` : ''));
  }

  lines.push(`трен ${wk.length}` + (avgRPE != null ? ` · RPE ср ${fmtNum(avgRPE, 1)}` : ''));

  if (sleeps.length || hrs.length) {
    lines.push(`сон ${fmtNum(mean(sleeps), 1)} ч · пульс ${fmtNum(mean(hrs), 0)}`);
  }

  if (week?.kcalAvg != null || week?.proteinAvg != null) {
    lines.push(`еда ${week.kcalAvg ?? '—'} ккал · белок ${week.proteinAvg ?? '—'} г`);
  }

  // Растяжка и просвет — объявленная цель года, а в своде их не было вовсе.
  // Секунды удержаний пишутся ради недельной дозы: её потолок 10 минут
  // на группу (ИССЛЕДОВАНИЯ.md, запись 36), и сравнивать надо здесь.
  const stretchDays = inWeek.filter((d) => Object.values(d.stretch || {}).some(Boolean));
  const holdSec = inWeek.reduce(
    (a, d) => a + Object.values(d.stretchSec || {}).reduce((x, v) => x + (v || 0), 0), 0);
  if (stretchDays.length || holdSec) {
    lines.push(`растяжка ${stretchDays.length} дн`
      + (holdSec ? ` · удержаний ${fmtNum(holdSec / 60, 1)} мин` : ''));
  }

  if (week?.splitGap != null) {
    const mark = week.splitProtocol === 'post' ? ' (после тренировки)'
      : (week.splitNoHome ? ' (без домашней)' : '');
    lines.push(`просвет ${fmtNum(week.splitGap, 1)} см${mark}`);
  }

  const volLine = Object.entries(vol)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([g, v]) => `${short(g)} ${fmtNum(v, 0)}`).join(', ');
  if (volLine) lines.push('объём: ' + volLine);

  if (unknown.length) lines.push('! нет коэффициентов: ' + unknown.join(', '));

  // На разгрузочной неделе объём падает на 40 % по замыслу: тревога там
  // сработала бы почти по всем группам и обесценила бы сам сигнал.
  const week5 = (plan?.weeks || []).find((w) => w.kind === 'deload');
  const deload = week5 ? week5.days.some((d) => dates.includes(d.date)) : false;
  const mev = (plan && plan.mev) || settings?.mev || {};
  if (!deload) {
    for (const [g, v] of Object.entries(vol)) {
      if (mev[g] != null && v < mev[g]) {
        lines.push(`! ${short(g)} ниже MEV: ${fmtNum(v, 0)} из ${mev[g]}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Свод одной сессии для вставки в чат: подходы, замены, пропуски, заметки.
 * Разминочные помечены и в средний RPE не идут.
 */
export function sessionSummary(workout) {
  const head = `${workout.date} · Н${workout.weekN} · ${workout.dayCode}`
    + (workout.backdated ? ' · записано задним числом' : '');
  const lines = [head];

  for (const ex of workout.exercises || []) {
    const name = ex.replacedWith ? `${ex.planName} → ${ex.replacedWith}` : ex.name;
    if (ex.skipped) {
      lines.push(`${name}: пропуск — ${ex.skipReason || 'без причины'}`);
      continue;
    }
    const sets = ex.sets || [];
    if (!sets.length) continue;
    const body = sets.map((s) => {
      const rpe = s.rpe != null ? ` @${fmtNum(s.rpe, 1)}` : '';
      const mark = s.warmup ? ' разм.' : (s.control ? ' контроль' : '');
      // Кардио меряется минутами и километрами: «в/т×null» здесь врало.
      if (s.minutes != null || s.km != null) {
        const parts = [];
        if (s.minutes != null) parts.push(`${fmtWeight(s.minutes)} мин`);
        if (s.km != null) parts.push(`${fmtWeight(s.km)} км`);
        if (s.hr != null) parts.push(`пульс ${s.hr}`);
        return parts.join(' · ') + rpe + mark;
      }
      const w = s.weight == null ? 'в/т' : fmtWeight(s.weight);
      const rest = s.rest != null ? ` /${Math.round(s.rest)}с` : '';
      return `${w}×${s.reps}${rpe}${rest}${mark}`;
    }).join(' · ');
    lines.push(`${name}: ${body}`);
    if (ex.note) lines.push(`  ! ${ex.note}`);
  }

  if (workout.avgRPE != null) lines.push(`RPE ср ${fmtNum(workout.avgRPE, 1)}`);
  if (workout.chestSignal != null) lines.push(`правая грудь: ${workout.chestSignal}`);
  return lines.join('\n');
}

/**
 * Гейт импорта. Схемы мало: план цикла тоже несёт schema 2 и раньше проходил
 * сюда, после чего restoreAll стирал дни, недели и тренировки. Поэтому
 * проверяется форма дампа — три массива и отсутствие признаков плана.
 */
export function parseBackup(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('Не удалось разобрать файл: это не JSON');
  }
  if (!obj || typeof obj !== 'object') {
    throw new Error('Файл пустой или не объект');
  }
  if (obj.schema !== SCHEMA) {
    throw new Error(
      `Файл другой версии схемы: ${obj?.schema ?? 'нет поля'}, ожидается ${SCHEMA}`);
  }
  // Признаки плана цикла: он про недели с днями, а не про журнал.
  if (Array.isArray(obj.weeks) && obj.weeks.some((w) => Array.isArray(w?.days))) {
    throw new Error('Это план цикла, а не бэкап журнала: у недель есть дни');
  }
  if (obj.from && obj.to && !Array.isArray(obj.days)) {
    throw new Error('Это план цикла, а не бэкап журнала');
  }
  for (const key of ['days', 'weeks', 'workouts', 'plans']) {
    if (!Array.isArray(obj[key])) {
      throw new Error(`Не похоже на бэкап журнала: поле ${key} не массив`);
    }
  }
  return obj;
}

export function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
