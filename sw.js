// VERSION и ASSETS генерируются: node tools/build-sw.mjs. Руками не править.
const VERSION = 'v77bfc618f5ba';
const ASSETS = [
  '.',
  'analytics.js',
  'charts.js',
  'data/exercises.json',
  'data/goals-finish.json',
  'data/plan-current.json',
  'export.js',
  'icon-192.png',
  'icon-512.png',
  'index.html',
  'lib/dates.js',
  'lib/format.js',
  'main.js',
  'manifest.json',
  'plan.js',
  'robots.txt',
  'screens/calendar-logic.js',
  'screens/calendar.js',
  'screens/day-logic.js',
  'screens/day.js',
  'screens/etalon.js',
  'screens/goals-logic.js',
  'screens/goals.js',
  'screens/journal-logic.js',
  'screens/journal.js',
  'screens/more.js',
  'screens/record-view.js',
  'screens/stats.js',
  'screens/stretch-block.js',
  'screens/stretch.js',
  'screens/workout-logic.js',
  'screens/workout.js',
  'store.js',
  'style.css',
];

// Данные грузятся сетью-первой: план правится чаще, чем код, и приложение,
// работающее по старому плану, выглядит нормально — это худший вид ошибки.
const NETWORK_FIRST = /\/data\/(plan-current|exercises|goals-finish)\.json$/;
const NETWORK_TIMEOUT = 2000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); });
  });
}

// Ответ кладётся в кэш только если он годный. Иначе страница ошибки хостинга
// затирала бы рабочий план, и офлайн отдавал бы её же.
async function networkFirst(request) {
  try {
    const res = await withTimeout(fetch(request), NETWORK_TIMEOUT);
    if (!res.ok) throw new Error(`ответ ${res.status}`);
    const cache = await caches.open(VERSION);
    cache.put(request, res.clone());
    return res;
  } catch {
    const hit = await caches.match(request);
    if (hit) return hit;
    throw new Error('нет ни сети, ни кэша');
  }
}

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(VERSION);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    const shell = await caches.match('index.html');
    if (shell) return shell;
    throw new Error('офлайн и файла нет в кэше');
  }
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(NETWORK_FIRST.test(url.pathname)
    ? networkFirst(e.request)
    : cacheFirst(e.request));
});

self.addEventListener('message', (e) => {
  if (e.data === 'version' && e.source) e.source.postMessage({ version: VERSION });
});
