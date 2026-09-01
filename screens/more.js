import {
  getWeek, putWeek, getSettings, putSettings, putPlan, listPlans,
  getExercises, dumpAll, restoreAll, listWorkouts, listDays, listWeeks,
} from '../store.js';
import { pickPlan } from '../plan.js';
import { validatePlan } from '../plan.js';
import { toCSV, weeklySummary, parseBackup, download } from '../export.js';
import { todayISO, isoWeek } from '../lib/dates.js';
import { parseNum } from '../lib/format.js';
import { etalonBlock } from './etalon.js';
import { navigate } from '../main.js';

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

// Иконки рисуются кодом: внешних файлов у приложения нет и не будет.
const ICONS = {
  week: 'M4 5h16v15H4zM4 9h16M8 3v4M16 3v4',
  guide: 'M5 4h11l3 3v13H5zM8 9h8M8 13h8M8 17h5',
  data: 'M12 3v11M8 10l4 4 4-4M4 18v3h16v-3',
  goals: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 8a4 4 0 100 8 4 4 0 000-8zM12 11.5v1',
  journal: 'M4 4h16v16H4zM8 8h8M8 12h8M8 16h5',
  calendar: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
};

function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ico');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name] || ICONS.data);
  svg.append(path);
  return svg;
}

/** Крупная плитка меню: иконка, название, шеврон. */
function tile(name, title, note, onclick, { wide = false } = {}) {
  return el('button', { className: 'tile' + (wide ? ' wide' : ''), onclick },
    el('span', { className: 'tile-top' }, icon(name), el('span', { className: 'chev' })),
    el('span', { className: 'tile-title', textContent: title }),
    note ? el('span', { className: 'tile-note', textContent: note }) : null);
}

/** Группа строк с подписью над ней — как в списках iOS. */
function group(caption, rows) {
  const wrap = el('div', { className: 'group' });
  if (caption) wrap.append(el('div', { className: 'group-cap', textContent: caption }));
  const card = el('div', { className: 'group-card' });
  for (const r of rows) {
    card.append(el('button', { className: 'group-row', onclick: r.onclick },
      r.icon ? icon(r.icon) : null,
      el('span', { className: 'row-title', textContent: r.title }),
      r.value ? el('span', { className: 'row-value', textContent: r.value }) : null,
      el('span', { className: 'chev' })));
  }
  wrap.append(card);
  return wrap;
}

/** Файловый вход прячется за кнопку: родной вид у него нечитаемый. */
function filePick(label, onFile) {
  const inp = el('input', { type: 'file', accept: '.json', className: 'file-hidden' });
  inp.onchange = () => { if (inp.files[0]) onFile(inp.files[0], inp); };
  const btn = el('button', { textContent: label, onclick: () => inp.click() });
  return el('div', { className: 'row' }, btn, inp);
}

/** Шапка раздела: название по центру, возврат слева. */
function head(title, back) {
  return el('div', { className: 'scr-head' },
    back ? el('button', { className: 'scr-back', textContent: '‹', onclick: back }) : el('span'),
    el('h1', { className: 'scr-title', textContent: title }),
    el('span'));
}

function numField(label, key, obj, step = 'any') {
  const i = el('input', { type: 'number', step, inputMode: 'decimal', value: obj[key] ?? '' });
  i.dataset.key = key;
  return el('label', {}, label, i);
}

function checkField(label, key, obj) {
  const i = el('input', { type: 'checkbox', checked: Boolean(obj[key]) });
  i.dataset.key = key;
  i.dataset.bool = '1';
  return el('label', { className: 'check' }, i, ' ' + label);
}

function collect(form, target) {
  for (const i of form.querySelectorAll('[data-key]')) {
    target[i.dataset.key] = i.dataset.bool ? i.checked : parseNum(i.value);
  }
  return target;
}

function flash(button, text = 'Сохранено') {
  const was = button.textContent;
  button.textContent = text;
  setTimeout(() => { button.textContent = was; }, 1500);
}

const SECTIONS = {
  week: 'Замеры недели',
  guide: 'Справочник',
  data: 'Данные',
  goals: 'Цели и нормы',
};

export async function render(box, params = {}) {
  const section = SECTIONS[params.section] ? params.section : null;
  const weekId = params.week || isoWeek(todayISO());
  const [week, settings, plans] = await Promise.all([
    getWeek(weekId), getSettings(), listPlans(),
  ]);
  const plan = pickPlan(plans, todayISO());
  const w = week || { id: weekId };
  const back = () => navigate('more');

  box.append(head(section ? SECTIONS[section] : 'Ещё', section ? back : null));

  if (!section) {
    menu(box, { weekId, settings, plan, plans });
    return;
  }
  if (section === 'week') return sectionWeek(box, w, weekId);
  if (section === 'data') return sectionData(box, { settings, plan, plans, weekId });
  if (section === 'goals') return sectionGoals(box, settings);
  return sectionGuide(box);
}

// ---------------------------------------------------------------
// Меню: входы плитками, второстепенное — строками с шевроном.
// ---------------------------------------------------------------
function menu(box, { weekId, settings, plan, plans }) {
  const grid = el('div', { className: 'tiles' },
    tile('week', 'Замеры недели', weekId, () => navigate('more', { section: 'week' })),
    tile('goals', 'Цели и нормы', `${settings.goalWeight} кг · ${settings.goalKcal} ккал`,
      () => navigate('more', { section: 'goals' })),
    tile('guide', 'Справочник', 'техника и эталоны',
      () => navigate('more', { section: 'guide' })),
    tile('data', 'Данные', settings.lastBackup ? `бэкап ${settings.lastBackup}` : 'бэкапа не было',
      () => navigate('more', { section: 'data' })),
  );
  box.append(grid);

  box.append(group('Записи', [
    { icon: 'journal', title: 'Журнал', onclick: () => navigate('journal') },
    { icon: 'calendar', title: 'Календарь', onclick: () => navigate('calendar') },
    { icon: 'chart', title: 'Цели цикла', onclick: () => navigate('goals') },
  ]));

  box.append(group('Цикл', [
    {
      icon: 'week',
      // Полное название не влезает рядом со значением — режем по первому «·».
      title: plan ? plan.title.split('·').slice(0, 2).join('·').trim() : 'Активного цикла нет',
      value: plan ? `до ${plan.to.slice(8)}.${plan.to.slice(5, 7)}` : '',
      onclick: () => navigate('more', { section: 'data' }),
    },
  ]));

  if (settings.lastBackup !== todayISO()) {
    box.append(el('p', {
      className: 'hint',
      textContent: `Последний бэкап: ${settings.lastBackup || 'не делался'}. Данные живут только на этом телефоне.`,
    }));
  }
  void plans;
}

// ---------------------------------------------------------------
function sectionWeek(box, w, weekId) {
  box.append(el('p', { className: 'hint', textContent: `Неделя ${weekId}` }));
  const form = el('div', { className: 'grid' },
    numField('талия, см', 'waist', w, '0.5'),
    numField('рука, см', 'arm', w, '0.5'),
    numField('голень, см', 'calf', w, '0.5'),
    numField('грудь, см', 'chest', w, '0.5'),
    numField('бёдра, см', 'hips', w, '0.5'),
    numField('шея, см', 'neck', w, '0.5'),
    numField('шпагат, см', 'splitGap', w, '0.5'),
    numField('стойка на руках, с', 'handstandSec', w, '1'),
    numField('ходьба на руках, м', 'handstandWalk', w, '0.5'),
    numField('ккал ср. (FatSecret)', 'kcalAvg', w, '10'),
    numField('белок ср., г', 'proteinAvg', w, '5'),
    checkField('фото снято', 'photo', w),
    checkField('шпагат мерен без домашней', 'splitNoHome', w),
  );
  box.append(form);
  const saveWeek = el('button', {
    className: 'save', textContent: 'Сохранить неделю',
    onclick: async () => {
      collect(form, w);
      try {
        await putWeek(w);
        flash(saveWeek);
      } catch (err) {
        box.prepend(el('div', { className: 'error', textContent: 'Не сохранено: ' + err.message }));
      }
    },
  });
  box.append(saveWeek);
}

// ---------------------------------------------------------------
function sectionGoals(box, settings) {
  const sForm = el('div', { className: 'grid' },
    numField('целевой вес, кг', 'goalWeight', settings, '0.5'),
    numField('ккал', 'goalKcal', settings, '10'),
    numField('белок, г', 'goalProtein', settings, '5'),
    numField('норма сна, ч', 'sleepNorm', settings, '0.5'),
  );
  box.append(sForm);
  const saveGoals = el('button', {
    className: 'save', textContent: 'Сохранить',
    onclick: async () => {
      collect(sForm, settings);
      try {
        await putSettings(settings);
        flash(saveGoals);
      } catch (err) {
        box.prepend(el('div', { className: 'error', textContent: 'Не сохранено: ' + err.message }));
      }
    },
  });
  box.append(saveGoals);
  box.append(el('p', {
    className: 'hint',
    textContent: 'Это нормы для датчиков. Пороги текущего цикла живут на экране «Цели».',
  }));
}

// ---------------------------------------------------------------
async function sectionGuide(box) {
  const list = el('div', { className: 'guide' });
  for (const e of await getExercises()) {
    const d = el('details');
    d.append(el('summary', { textContent: e.name }));
    if (e.technique) d.append(el('p', { textContent: e.technique }));
    if (e.keyPoints) d.append(el('p', { className: 'hint', textContent: e.keyPoints }));
    if (e.mistakes) d.append(el('p', { className: 'hint', textContent: 'Ошибки: ' + e.mistakes }));
    d.append(etalonBlock(e, { open: true }));
    list.append(d);
  }
  box.append(list);
}

// ---------------------------------------------------------------
async function sectionData(box, { settings, plan, plans, weekId }) {
  const bBackup = el('button', {
    textContent: 'Бэкап .json',
    onclick: async () => {
      const dump = await dumpAll();
      download(`dnevnik-${todayISO()}.json`, JSON.stringify(dump, null, 1));
      await putSettings({ ...settings, lastBackup: todayISO() });
      flash(bBackup, 'Скачано');
    },
  });

  const bCsv = el('button', {
    textContent: 'Журнал .csv',
    onclick: async () => {
      download(`journal-${todayISO()}.csv`, toCSV(await listWorkouts()), 'text/csv');
      flash(bCsv, 'Скачано');
    },
  });

  const bSum = el('button', {
    textContent: 'Свод недели в буфер',
    onclick: async () => {
      const [days, workouts, exercises, weeks] = await Promise.all([
        listDays(), listWorkouts(), getExercises(), listWeeks(),
      ]);
      const text = weeklySummary({
        weekId, days, week: weeks.find((x) => x.id === weekId),
        workouts, exercises, settings, plan,
      });
      try {
        await navigator.clipboard.writeText(text);
        flash(bSum, 'Скопировано');
      } catch {
        box.prepend(el('pre', { className: 'summary', textContent: text }));
      }
    },
  });

  box.append(el('h2', { textContent: 'Экспорт' }));
  box.append(el('div', { className: 'row' }, bBackup, bCsv, bSum));
  box.append(el('p', {
    className: 'hint',
    textContent: `Последний бэкап: ${settings.lastBackup || 'не делался'}.`
      + ' Очистка данных Safari без бэкапа уничтожит журнал.',
  }));

  // Блок хранилища. Нужен потому, что «журнал на месте» ничего не доказывает:
  // вклеенный дамп засевается в пустую базу при каждом запуске, и хранилище,
  // которое чистится, выглядит точно так же, как живое. Число открытий,
  // застрявшее на единице, — прямая улика.
  box.append(el('h2', { textContent: 'Хранилище' }));
  const [dDays, dWeeks, dWorkouts] = await Promise.all([listDays(), listWeeks(), listWorkouts()]);
  const line = (k, v) => el('div', { className: 'cardio-row' },
    el('span', { textContent: k }), el('span', { textContent: String(v) }));
  box.append(el('div', { className: 'card' },
    line('открытий базы', settings.opens || '—'),
    line('база создана', (settings.createdAt || '—').slice(0, 16).replace('T', ' ')),
    line('записей', `${dDays.length} дн · ${dWeeks.length} нед · ${dWorkouts.length} трен`),
    line('источник', String(globalThis.location?.origin || '—').slice(0, 34))));
  box.append(el('p', {
    className: 'hint',
    textContent: 'Если «открытий базы» после перезапуска браузера остаётся 1 — '
      + 'хранилище не переживает закрытие, и всё внесённое теряется.',
  }));

  box.append(el('h2', { textContent: 'Импорт' }));

  const importBackup = async (file) => {
    try {
      const dump = parseBackup(await file.text());
      const what = `дней ${dump.days.length} · недель ${dump.weeks.length}`
        + ` · тренировок ${dump.workouts.length} · циклов ${dump.plans.length}`;
      if (!confirm(`Импорт заменит все текущие данные.\n\nВ файле: ${what}\n\nПродолжить?`)) return;
      await restoreAll(dump);
      alert('Импортировано. Перезагрузи страницу.');
    } catch (err) {
      alert('Импорт отклонён: ' + err.message);
    }
  };
  box.append(filePick('Восстановить из бэкапа', importBackup));

  const importPlan = async (file) => {
    let obj;
    try {
      obj = JSON.parse(await file.text());
    } catch {
      alert('Это не JSON');
      return;
    }
    const v = validatePlan(obj);
    if (!v.ok) {
      alert('План отклонён, остальные циклы не тронуты:\n\n' + v.errors.slice(0, 8).join('\n'));
      return;
    }
    await putPlan(obj);
    alert(`План «${obj.title}» загружен. Остальные циклы на месте.`);
  };

  const planList = plans.length
    ? plans.map((p) => `${p.title} (${p.from}—${p.to})`).join('; ')
    : 'нет';
  box.append(
    el('h2', { textContent: 'Циклы' }),
    el('p', { textContent: `Активный: ${plan ? plan.title : 'нет на сегодня'}` }),
    el('p', { className: 'hint', textContent: `Загружено: ${planList}` }),
    filePick('Загрузить план цикла', importPlan),
  );
}
