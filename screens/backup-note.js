import { daysBetween, todayISO } from '../lib/dates.js';

/**
 * Плашка «копии данных нет». Приложение — единственный источник правды по факту
 * тренировок: `ЖУРНАЛ_Ц3.md` заморожен срезом Н1–Н3, а очистка данных Safari
 * уносит журнал целиком и молча. Раньше об этом говорила серая строка 14 px
 * в подвале «Ещё» — экрана, куда заходят раз в неделю, — и говорила её каждый
 * день, то есть не работала ни напоминанием, ни тревогой.
 *
 * Стоит плашка в двух местах: вверху «Дня» и на экране «Тренировка закрыта»,
 * где данные только что дописаны и цена потери максимальна.
 */

/** Копия старше этого числа дней считается устаревшей. */
export const STALE_DAYS = 7;

/**
 * Два разных состояния с разной ценой, а не один порог.
 *
 * «Копии не было ни разу» — это долг: порог ему не нужен, потому что ждать
 * нечего, под угрозой уже всё накопленное. Считать семь дней от первой записи
 * бессмысленно — журнал импортирован срезом с 17.08, и порог был бы пройден
 * в тот же миг, только окольно.
 *
 * «Копия есть, но устарела» — напоминание, и порог его дело.
 *
 * Пустому приложению терять нечего: без единой записи плашка молчит.
 */
export function backupState({ lastBackup, hasRecords, today = todayISO() }) {
  if (!hasRecords) return null;
  if (!lastBackup) return { kind: 'never', days: null };
  const days = daysBetween(lastBackup, today);
  return days > STALE_DAYS ? { kind: 'stale', days } : null;
}

/** Склонение дней: 1 день · 2 дня · 5 дней. */
function plural(n) {
  const ten = n % 100;
  if (ten >= 11 && ten <= 14) return 'дней';
  const one = n % 10;
  if (one === 1) return 'день';
  if (one >= 2 && one <= 4) return 'дня';
  return 'дней';
}

export function backupText(state) {
  return state.kind === 'never'
    ? 'Копии данных нет ни одной. Журнал живёт только на этом телефоне →'
    : `Копии данных нет ${state.days} ${plural(state.days)}.`
      + ' Журнал живёт только на этом телефоне →';
}

/**
 * Готовый узел или `null`. Плашка не закрывается: это долг, а не уведомление,
 * и снимает его только сам бэкап. Ведёт она в «Ещё → Данные» — единственное
 * место, где выгрузка делается; второй вход в то же действие пришлось бы
 * чинить дважды.
 *
 * Переход передаётся вызывающим, а не берётся из `main.js`: общий блок,
 * как и `record-view.js`, не должен добавлять ребро в цикл экранов ради
 * одной кнопки.
 */
export function backupNote({ lastBackup, hasRecords, today = todayISO(), onOpen }) {
  const state = backupState({ lastBackup, hasRecords, today });
  if (!state) return null;
  const node = document.createElement('button');
  node.className = 'backup-note';
  node.textContent = backupText(state);
  node.onclick = onOpen;
  return node;
}
