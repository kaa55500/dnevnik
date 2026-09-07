import { dm } from './dates.js';

export function fmtNum(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toFixed(digits).replace('.', ',');
}

export function fmtSigned(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const s = Math.abs(n).toFixed(digits).replace('.', ',');
  if (Number(n.toFixed(digits)) === 0) return '0';
  return (n < 0 ? '−' : '+') + s;
}

/** Вес без лишних нулей: 65 -> «65», 66.25 -> «66,25», 22.5 -> «22,5». */
export function fmtWeight(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return String(Math.round(n * 100) / 100).replace('.', ',');
}

/**
 * Секунды удержания. Считает то же, что `fmtWeight`, но называет намерение
 * в точке использования: «15 с» — это не вес, и весовой форматтер на секундах
 * читался ошибкой копипасты.
 */
export function fmtSec(n) {
  return fmtWeight(n);
}

/**
 * Раскладка табло: минуты и секунды с ведущим нулём. Живёт отдельно, потому
 * что счётчиков на экране два — часы тренировки и секундомер отдыха, — и
 * записанная дважды раскладка разъезжается при первой же правке одного из них.
 * Знак и границы решает вызывающий: это раскладка, а не смысл.
 */
function mmss(sec) {
  const s = Math.round(sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Часы таймера: 00:30, 01:47 — ведущий ноль, как на табло. Минуса не знают. */
export function fmtClock(sec) {
  return mmss(Math.max(0, sec));
}

export function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * Число из поля ввода. Точка и запятая равноправны — на телефоне набирается
 * то, что даёт клавиатура.
 *
 * Через `Number` сюда проходило всё, что тот умеет разбирать: `-5` давало
 * отрицательный вес и уезжало в расчётный максимум, `1e3` — тысячу килограммов,
 * `0x10` — шестнадцать, а строка из трёхсот цифр — 1.11e+299. Ни одна
 * величина в этом дневнике отрицательной не бывает: вес, повторы, секунды,
 * сантиметры, часы сна, отдых. Поэтому форма проверяется явно, а не отдаётся
 * на откуп `Number`, который принимает больше, чем нужно.
 */
const DECIMAL = /^\d+(?:\.\d+)?$/;

export function parseNum(s) {
  if (typeof s === 'number') return Number.isFinite(s) && s >= 0 ? s : null;
  const t = String(s ?? '').trim().replace(',', '.');
  if (t === '') return null;
  if (!DECIMAL.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Счётчик отдыха. В отличие от `fmtClock` он умеет минус: после нуля таймер
 * не замирает, а считает перебор, и «−01:20» отвечает на вопрос «сколько
 * я уже стою», на который остановленные 00:00 не отвечали ничем.
 */
export function fmtRest(sec) {
  const n = Math.round(sec);
  return (n < 0 ? '−' : '') + mmss(Math.abs(n));
}

/**
 * Русское склонение при числе: `plural(2, ['день', 'дня', 'дней'])`.
 * Форма выбирается по последним цифрам, поэтому 11–14 разбираются отдельно
 * от 1–4: «21 день», но «11 дней».
 */
export function plural(n, [one, few, many]) {
  const ten = Math.abs(n) % 100;
  if (ten >= 11 && ten <= 14) return many;
  const last = ten % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/*
 * Ниже — вёрстка строк подхода: единственное в приложении место, где цифры
 * подхода клеятся в текст для глаза. Жили они в `workout-logic.js`, который
 * от этого менялся по двум причинам сразу — считал правила и рисовал строки.
 */
/** Тело подхода без веса: «10» или «15 с». */
export function setAmount(s) {
  if (!s) return '—';
  if (s.sec != null) return `${fmtSec(s.sec)} с`;
  return s.reps == null ? '—' : String(s.reps);
}

/**
 * Строка «прошлый раз». До 07.09 она печатала один последний подход и без
 * единиц: «12 × 10» одинаково читалось как «12 кг на 10 повторов» и как
 * что угодно ещё, а у Болгарского сплит-приседа 12 — это вес **на сторону**,
 * то есть две гантели. Дата важна не меньше цифр: прошлый раз мог быть
 * три недели назад, и тогда вес объясняется перерывом, а не слабостью.
 */
export function prevSessionLine({ date, sets, perSide, cellOf }) {
  const working = (sets || []).filter((s) => !s.warmup);
  if (!working.length) return 'первый раз';
  const day = date ? dm(date) : null;
  // Ячейка стопки идёт при каждом весе, а не только при первом: в разновесной
  // сессии она пропадала целиком — а именно там она и нужна, чтобы повторить
  // ступеньку. Функция, а не готовая строка: весов в ряду столько же,
  // сколько подходов.
  const cell = (v) => {
    const hit = cellOf ? cellOf(v) : '';
    return hit ? ` ${hit}` : '';
  };
  const weight = (v) => (v == null ? 'в/т' : `${fmtWeight(v)} кг${perSide ? '/ст' : ''}${cell(v)}`);
  const w = working[0].weight;
  const sameWeight = working.every((s) => s.weight === w);
  const amount = sameWeight
    ? `${weight(w)} × ${working.map((s) => setAmount(s)).join(', ')}`
    : working.map((s) => `${weight(s.weight)} × ${setAmount(s)}`).join(', ');
  return `прошлый раз${day ? ` ${day}` : ''} · ${amount}`;
}
