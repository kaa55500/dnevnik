import { seedIfEmpty } from './store.js';
import { render as renderWorkout } from './screens/workout.js';
import { render as renderDay } from './screens/day.js';
import { render as renderStretch } from './screens/stretch.js';
import { render as renderCalendar } from './screens/calendar.js';
import { render as renderJournal } from './screens/journal.js';
import { render as renderStats } from './screens/stats.js';
import { render as renderGoals } from './screens/goals.js';
import { render as renderMore } from './screens/more.js';

const screens = new Map();
let current = null;
let currentParams = {};

export function registerScreen(name, render) {
  screens.set(name, render);
}

export async function navigate(name, params = {}) {
  const render = screens.get(name);
  if (!render) return;
  current = name;
  currentParams = params;
  const box = document.getElementById('screen');
  box.innerHTML = '';
  delete box.dataset.day;
  box.scrollTop = 0;
  // Вкладка подсвечивается по семейству экранов: растяжка и календарь живут
  // внутри «Дня», цели — внутри «Динамики».
  const family = { day: 'day', stretch: 'day', calendar: 'day', journal: 'day', goals: 'stats' };
  const tab = family[name] || name;
  for (const b of document.querySelectorAll('#tabs button')) {
    b.classList.toggle('active', b.dataset.screen === tab);
  }
  await render(box, params);
}

export function currentScreen() {
  return { name: current, params: currentParams };
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) navigate(b.dataset.screen);
});

registerScreen('day', renderDay);
registerScreen('stretch', renderStretch);
registerScreen('calendar', renderCalendar);
registerScreen('journal', renderJournal);
registerScreen('workout', renderWorkout);
registerScreen('stats', renderStats);
registerScreen('goals', renderGoals);
registerScreen('more', renderMore);

if ('serviceWorker' in navigator) {
  // Отказ регистрации не должен уходить необработанным. На хостинге это
  // строка в консоли, а в собранном одним файлом дневнике — обычное дело:
  // по локальной схеме service worker недоступен, и приложение обязано
  // открыться всё равно.
  try {
    // updateViaCache: 'none' — сам файл worker никогда не берётся из HTTP-кэша.
    // Иначе телефон мог сутки не замечать, что вышла новая версия.
    const reg = navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
    if (reg && typeof reg.then === 'function') {
      reg.then((r) => {
        if (!r || typeof r.update !== 'function') return;
        // Проверка на старте и при каждом возврате в приложение, не чаще
        // раза в полминуты: телефон открывают в зале, и обновление должно
        // подхватываться тогда же, а не «когда-нибудь».
        let last = 0;
        const check = () => {
          const now = Date.now();
          if (now - last < 30_000) return;
          last = now;
          r.update().catch(() => {});
        };
        check();
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') check();
        });
      }).catch(() => {});
    }
  } catch { /* нет так нет: офлайн в собранном файле обеспечен самим файлом */ }

  // Новый worker забирает управление сразу (skipWaiting), но страница уже
  // нарисована старым кодом — правки было видно только со следующего запуска.
  // Поэтому плашка не сообщение, а кнопка: тап перезагружает страницу.
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    if (document.querySelector('.updated')) return;
    // Плашка закрывается: она `position: fixed` над таб-баром, то есть ровно
    // там, где ЗАВЕРШИТЬ и «отменить заполнение». Висеть до конца тренировки
    // и ловить случайный тап (а тап — это перезагрузка) она не должна.
    const note = document.createElement('div');
    note.className = 'updated';
    const go = document.createElement('button');
    go.className = 'updated-go';
    go.textContent = 'Новая версия готова — открыть';
    go.onclick = () => location.reload();
    const hide = document.createElement('button');
    hide.className = 'updated-hide';
    hide.textContent = '×';
    hide.title = 'скрыть';
    hide.onclick = () => note.remove();
    note.append(go, hide);
    document.body.append(note);
  });
}

// Посев не должен уносить с собой весь экран: сеть в зале рвётся, и падение
// на fetch справочника раньше оставляло чёрный лист без единого слова.
let bootError = null;
try {
  await seedIfEmpty();
} catch (err) {
  bootError = err;
}
await navigate('day');
if (bootError) {
  const bar = document.createElement('div');
  bar.className = 'boot-error';
  bar.textContent = 'Данные загрузились не полностью: ' + bootError.message + '. ';
  const again = document.createElement('button');
  again.className = 'link';
  again.textContent = 'повторить';
  again.onclick = () => location.reload();
  bar.append(again);
  document.getElementById('screen').prepend(bar);
}
