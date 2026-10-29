import { daysBetween, todayISO } from '../lib/dates.js';
import { plural } from '../lib/format.js';
import { dumpAll, getSettings, putSettings } from '../store.js';
import { shareFile } from '../export.js';

/**
 * Плашка «копии данных нет». Приложение — единственный источник правды по факту
 * тренировок: markdown-журнал собирается из бэкапа и обратно не заливается,
 * а очистка данных Safari
 * уносит журнал целиком и молча. Раньше об этом говорила серая строка 14 px
 * в подвале «Ещё» — экрана, куда заходят раз в неделю, — и говорила её каждый
 * день, то есть не работала ни напоминанием, ни тревогой.
 *
 * Стоит плашка в двух местах: вверху «Дня» и на экране «Тренировка закрыта»,
 * где данные только что дописаны и цена потери максимальна.
 */

/** Копия старше этого числа дней считается устаревшей. */
export const STALE_DAYS = 7;

/** С этого возраста копии кнопка отправки стоит прямо на экране закрытой тренировки. */
export const SEND_DAYS = 6;

/**
 * Отправка бэкапа (решение атлета 29.10). Файл готовится заранее, при открытии
 * экрана, а в касании уходит в `navigator.share` без единого ожидания: Safari
 * пускает «Поделиться» только из жеста, и чтение базы перед отправкой жест
 * теряло — живая проверка 29.10 упёрлась в «Must be handling a user gesture».
 *
 * Дата копии ставится по разрешённому промису отправки, а не по нажатию:
 * закрытый лист «Поделиться» — это не копия, а прежняя кнопка отмечала бэкап
 * сделанным в любом случае.
 */
export function backupSender() {
  let ready = null;
  const preparing = dumpAll().then((dump) => {
    ready = { name: `dnevnik-${todayISO()}.json`, text: JSON.stringify(dump, null, 1) };
  });
  // Ошибка чтения базы всплывёт в касании, а не необработанным отказом сейчас.
  preparing.catch(() => {});
  return async function send() {
    // База ещё читается — касание, возможно, потеряно; тогда файл скачается.
    if (!ready) await preparing;
    const how = await shareFile(ready.name, ready.text);
    if (how === 'cancelled') return how;
    const settings = await getSettings();
    await putSettings({ ...settings, lastBackup: todayISO() });
    return how;
  };
}

/** Разовая отправка: готовит файл и сразу шлёт. В касании — `backupSender`. */
export const sendBackup = () => backupSender()();

/** Пора ли ставить кнопку отправки: копии нет или ей `SEND_DAYS` дней и больше. */
export function sendDue(lastBackup, today = todayISO()) {
  return !lastBackup || daysBetween(lastBackup, today) >= SEND_DAYS;
}

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

export function backupText(state) {
  return state.kind === 'never'
    ? 'Копии данных нет ни одной. Журнал живёт только на этом телефоне →'
    : `Копии данных нет ${state.days} ${plural(state.days, ['день', 'дня', 'дней'])}.`
      + ' Журнал живёт только на этом телефоне →';
}

/**
 * Готовый узел или `null`. Плашка не закрывается: это долг, а не уведомление,
 * и снимает его только сам бэкап. Ведёт она в «Ещё → Данные» — единственное
 * место, где выгрузка делается; второй вход в то же действие пришлось бы
 * чинить дважды.
 *
 * Переход передаётся вызывающим, а не берётся из `main.js`: так же устроен
 * `record-view.js` — общий блок экранам не навязывает, куда вести. Ребро
 * в цикл это тоже не добавляет, но причина не в нём: `navigate` через цикл
 * ходить как раз имеет право, и число рёбер в `bundle.test.js` поднимается,
 * когда для этого есть повод.
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
