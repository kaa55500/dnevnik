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
    const reg = navigator.serviceWorker.register('sw.js');
    if (reg && typeof reg.catch === 'function') reg.catch(() => {});
  } catch { /* нет так нет: офлайн в собранном файле обеспечен самим файлом */ }
  // Плашка об обновлении: новая версия применяется при следующем запуске,
  // и молчать об этом нельзя — иначе непонятно, почему поменялся план.
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    const note = document.createElement('div');
    note.className = 'updated';
    note.textContent = 'Приложение обновлено';
    document.body.append(note);
    setTimeout(() => note.remove(), 4000);
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
