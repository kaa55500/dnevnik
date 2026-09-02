import { pickPlan, validatePlan } from './plan.js';

const DB_NAME = 'dnevnik';
const DB_VERSION = 2;

export const SCHEMA = 2;

export const DEFAULT_SETTINGS = {
  id: 'main',
  schema: SCHEMA,
  goalWeight: 85,
  goalKcal: 2380,
  goalProtein: 200,
  sleepNorm: 7,
  signals: ['headache'],          // включённые сигналы утреннего чек-ина
  // Запасные пороги объёма: используются, только если план цикла своих не несёт.
  // Фазовые пороги живут в плане (plan.mev) и переключаются вместе с циклом.
  mev: {
    'Перед. дельта': 6,
    'Средняя дельта ★★★': 8,
    'Задняя дельта': 6,
    'Верх груди ★★★': 6,
    'Грудь низ/средн.': 8,
    'Широчайшие ★★★': 10,
    'Середина спины': 8,
    'Разгибатели спины': 6,
    'Бицепс': 8,
    'Трицепс': 6,
    'Предплечье/хват ★★': 6,
    'Квадрицепс': 8,
    'ЗПБ (бицепс бедра)': 6,
    'Ягодицы': 4,
    'Икры ★★': 8,
    'Пресс/кор': 6,
  },
  // Ручные перекрытия плановых порогов: { ключ: число }. Действуют, пока
  // overrideCycle совпадает с id активного плана (правило R25).
  goalOverrides: {},
  overrideCycle: null,
  lastBackup: null,
};

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const need = (name, options) => {
        if (!db.objectStoreNames.contains(name)) return db.createObjectStore(name, options);
        return null;
      };
      need('days', { keyPath: 'date' });
      need('weeks', { keyPath: 'id' });
      const w = need('workouts', { keyPath: 'id', autoIncrement: true });
      if (w) {
        w.createIndex('date', 'date');
        w.createIndex('status', 'status');
      }
      need('plan', { keyPath: 'id' });
      need('exercises', { keyPath: 'name' });
      need('settings', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function get(store, key) {
  const db = await openDB();
  return wrap(tx(db, store, 'readonly').get(key));
}

async function put(store, value) {
  const db = await openDB();
  return wrap(tx(db, store, 'readwrite').put(value));
}

async function all(store) {
  const db = await openDB();
  return wrap(tx(db, store, 'readonly').getAll());
}

export const getDay = (iso) => get('days', iso);
export const putDay = (day) => put('days', day);
export const getWeek = (id) => get('weeks', id);
export const putWeek = (week) => put('weeks', week);
export const getWorkout = (id) => get('workouts', id);
export const putWorkout = (w) => put('workouts', w);
export const listWorkouts = () => all('workouts');
export const listDays = () => all('days');
export const listWeeks = () => all('weeks');
export const getExercises = () => all('exercises');
export const listPlans = () => all('plan');

/** Черновик именно этой даты: два незакрытых дня больше не путаются. */
export async function getDraft(iso) {
  const list = await listWorkouts();
  return list.find((w) => w.status === 'draft' && w.date === iso) || null;
}

/**
 * Тренировка этой даты и вида — черновик или уже завершённая.
 * Без этого повторное открытие закрытой сессии заводило вторую, пустую.
 */
export async function findWorkout(iso, kind, code = null) {
  const list = await listWorkouts();
  let mine = list.filter((w) => w.date === iso && (w.kind || 'gym') === kind);
  // После переноса на одной дате может лежать два зальных дня: Н1, приехавший
  // со вторника, и плановый В2. По виду они неразличимы, и «Начать» на В2
  // открывало чужую запись. Код дня разводит их.
  if (code) {
    const exact = mine.filter((w) => w.dayCode === code);
    // У записей без кода (созданы до этой правки) отбирать нечего.
    mine = exact.length ? exact : mine.filter((w) => !w.dayCode);
  }
  return mine.find((w) => w.status === 'draft') || mine.find((w) => w.status === 'done') || null;
}

/**
 * Удалить тренировку. Нужна ровно для одного случая: открыл сессию посмотреть,
 * ничего не записал и ушёл — пустой черновик не должен оставаться в журнале
 * и мозолить глаза в списке «пропущенное».
 */
export async function delWorkout(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('workouts', 'readwrite');
    t.objectStore('workouts').delete(id);
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}

/**
 * Справочник целиком заменяется присланным: он не пользовательские данные,
 * а часть поставки, и снятая позиция должна уходить из базы, а не оставаться
 * висеть. Бэкап его не несёт, терять нечего.
 */
export async function putExercises(list) {
  const db = await openDB();
  const t = db.transaction('exercises', 'readwrite');
  t.objectStore('exercises').clear();
  for (const e of list) t.objectStore('exercises').put(e);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(list.length);
    t.onerror = () => reject(t.error);
  });
}

export async function getSettings() {
  const s = await get('settings', 'main');
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

export const putSettings = (s) => put('settings', { ...s, id: 'main' });

/** План, покрывающий дату. Циклы лежат рядом и не затирают друг друга. */
export async function getPlan(iso) {
  const list = await listPlans();
  return pickPlan(list, iso);
}

/** Записывает план, не трогая остальные циклы (правило R20). */
export const putPlan = (p) => put('plan', p);

export async function seedIfEmpty() {
  await syncExercises();
  await syncPlan();
  // Счётчик запусков — единственный дешёвый способ отличить «хранилище живёт»
  // от «хранилище чистится, а вклеенный журнал засевается заново». Во втором
  // случае картина обманчива: журнал всегда на месте, а внесённое исчезает,
  // и число открытий навсегда остаётся единицей.
  const s = await get('settings', 'main');
  const now = new Date().toISOString();
  if (!s) await putSettings({ ...DEFAULT_SETTINGS, createdAt: now, opens: 1, openedAt: now });
  // Дамп несёт свои настройки, и после засева база уже не пуста: дата
  // создания проставляется здесь, иначе у восстановленной базы её нет вовсе.
  else await putSettings({ ...s, createdAt: s.createdAt || now, opens: (s.opens || 0) + 1, openedAt: now });
}

/**
 * Справочник тянется с хостинга на каждом старте по той же причине, что и план:
 * заливка «только в пустое хранилище» означала, что исправленный эталон
 * до телефона не доедет никогда. Нет сети или файл битый — молча остаёмся
 * на том, что уже лежит.
 */
export async function syncExercises() {
  let fresh = null;
  try {
    fresh = await fetch('data/exercises.json').then((r) => r.json());
  } catch {
    fresh = null;
  }
  const ok = Array.isArray(fresh) && fresh.length > 0
    && fresh.every((e) => e && typeof e.name === 'string' && e.name.length > 2);
  if (!ok) return null;
  // IndexedDB отдаёт записи в своём порядке ключей, а файл лежит в своём:
  // сравнивать надо содержимое, иначе справочник переписывался бы каждый старт.
  const key = (list) => JSON.stringify(
    [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
  const saved = await getExercises();
  if (key(saved) === key(fresh)) return null;
  await putExercises(fresh);
  return fresh.length;
}

/**
 * План тянется с хостинга на каждом старте, а не только в пустое хранилище:
 * иначе правка плана до телефона не доезжала никогда. Записывается, только
 * если пришедший объект валиден и отличается от сохранённого. Нет сети —
 * молча остаёмся на том, что уже лежит.
 */
/** Пересекаются ли диапазоны дат двух планов хотя бы одним днём. */
function rangesOverlap(a, b) {
  if (!a.from || !a.to || !b.from || !b.to) return true;   // старым записям не мешаем
  return a.from <= b.to && b.from <= a.to;
}

export async function syncPlan() {
  let fresh = null;
  try {
    fresh = await fetch('data/plan-current.json').then((r) => r.json());
  } catch {
    fresh = null;
  }
  if (!fresh || !validatePlan(fresh).ok) return null;
  const saved = await listPlans();
  const old = saved.find((p) => p.id === fresh.id);
  if (old && JSON.stringify(old) === JSON.stringify(fresh)) return null;
  // Под одним `id` не должны оказаться два разных цикла. `id` в генераторе
  // прибит строкой, и менять его при сборке следующего цикла — ручной шаг,
  // ничем не подстрахованный. Забыть его значило бы: план Ц4 приезжает
  // под именем `cycle-3`, `putPlan` заменяет запись, и цикл 3 исчезает из базы
  // целиком. Тренировки уцелели бы (`prescription` лежит внутри записи),
  // но для всех дат 17.08–20.09 `pickPlan` вернул бы null — а с ним пропали бы
  // названия позиций растяжки в журнале, признак разгрузочной недели и долги.
  if (old && !rangesOverlap(old, fresh)) {
    console.warn(`план ${fresh.id} пришёл с другим диапазоном (${fresh.from}—${fresh.to}`
      + ` против ${old.from}—${old.to}) — не записан: у нового цикла обязан быть свой id`);
    return null;
  }
  await putPlan(fresh);
  return fresh.id;
}

export async function dumpAll() {
  return {
    schema: SCHEMA,
    exportedAt: new Date().toISOString(),
    days: await listDays(),
    weeks: await listWeeks(),
    workouts: await listWorkouts(),
    plans: await listPlans(),
    settings: await getSettings(),
  };
}

/**
 * Восстановление из бэкапа. Порядок важен: всё проверяется до первого clear(),
 * иначе кривая строка в середине оставляет базу с пустыми днями и без замены.
 * Планы не заменяются набором, а дописываются по `id`: циклы живут дольше
 * журнала, и план цикла, которого в бэкапе нет, стирать нечем — восстановить
 * его потом будет неоткуда.
 */
export async function restoreAll(dump) {
  const bad = [];
  // Три строки проверяются одним правилом, а не тремя копиями: копии разъезжаются.
  // Мутационная проба 02.09 показала, что отсев тренировок можно было снять
  // и набор оставался зелёным, хотя та же мутация на соседней строке `days`
  // падала — то есть самая ценная часть журнала была защищена слабее всех.
  const REQUIRED = {
    days: { key: 'date', what: 'день без даты' },
    weeks: { key: 'id', what: 'неделя без id' },
    workouts: { key: 'date', what: 'тренировка без даты' },
  };
  const rows = {};
  for (const [name, { key, what }] of Object.entries(REQUIRED)) {
    rows[name] = (dump[name] || []).filter(
      (r) => (r && typeof r[key] === 'string') || bad.push(what));
  }
  const plans = (dump.plans || []).filter((p) => (p && typeof p.id === 'string') || bad.push('план без id'));
  if (bad.length) {
    throw new Error('Импорт отклонён, база не тронута: ' + [...new Set(bad)].join(', '));
  }

  const db = await openDB();
  const names = ['days', 'weeks', 'workouts', 'plan'];
  const t = db.transaction([...names, 'settings'], 'readwrite');
  for (const n of ['days', 'weeks', 'workouts']) {
    t.objectStore(n).clear();
    for (const row of rows[n]) t.objectStore(n).put(row);
  }
  // Планы сливаются по `id`, а не заменяются набором. Сентябрьский бэкап,
  // восстановленный в октябре, снёс бы Ц4 целиком — а вместе с ним из журнала
  // ушли бы предписания, названия позиций растяжки, признак разгрузочной недели
  // и весь блок долгов. Ц4 с хостинга вернётся, а вот план завершённого цикла
  // не вернётся ниоткуда: `plan-cycle*.json` в публикуемый набор не входят.
  // Комментарий над функцией это правило и объявлял, но код делал обратное.
  for (const p of plans) t.objectStore('plan').put(p);
  if (dump.settings) t.objectStore('settings').put({ ...dump.settings, id: 'main' });
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
