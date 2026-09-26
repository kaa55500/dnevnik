import { fromISO, isoWeek } from '../lib/dates.js';

const WED = 3;
const SUN = 0;

// Недельный блок закрывают три строки: без них он не уходит с экрана
// (ЦИКЛ-4.md §8 — на них смотрят ворота ккал и веха стойки). Ходьба на руках
// стояла здесь с 02.09 как объявленная цель года; снята 22.09: до Ц9 её нет
// в программе, и строка была бы вечным долгом без дела. Цель остаётся слепой.
const WEEK_REQUIRED = ['kcalAvg', 'proteinAvg', 'handstandSec'];

/** Цифры утреннего чек-ина. */
const MORNING_FIELDS = ['weight', 'sleepHours', 'sleepQuality', 'restingHR', 'bpSys', 'bpDia'];
/** Галочки утра: вакуум и все сигналы, какие бывают в планах. */
const MORNING_MARKS = ['vacuum', 'headache', 'knee', 'chest', 'joints', 'elbowShoulder'];

/**
 * Утро закрыто, если в нём выбрано хоть что-то — цифра или поставленная
 * галочка (решение атлета 26.09). Что не заполнено, то не заполнено:
 * не взвесился — вес не придумать, и строка без веса долгом не висит.
 * Сохранённые пустые галочки (`false`) выбором не считаются.
 */
export function morningClosed(d) {
  if (!d) return false;
  return MORNING_FIELDS.some((k) => !empty(d[k])) || MORNING_MARKS.some((k) => d[k] === true);
}

/**
 * Утро перед записью. Ноль в весе — не цифра, а способ закрыть долг:
 * 22.09 так и записалось «0 кг», и ноль уехал бы в средние недели.
 */
export function cleanMorning(d) {
  if (d && d.weight === 0) d.weight = null;
  return d;
}

/**
 * Подписи сигналов самочувствия. Один словарь на чек-ин и на журнал: копий
 * было две, и новый сигнал (в профиле уже висят колено, правая грудь, суставы)
 * требовал правки обеих — забудешь вторую, и в журнале печатается сырой ключ.
 */
export const SIGNALS = {
  headache: 'головная боль',
  knee: 'колено',
  chest: 'правая грудь',
  joints: 'ноющие суставы',
  elbowShoulder: 'локоть/плечо',
};

/**
 * Какие сигналы спрашивает утренний чек-ин. Состав — решение цикла
 * (ЦИКЛ-4.md §8: голова · колено · локоть/плечо), поэтому он лежит в плане,
 * как питание и пороги; настройки телефона — запасной вариант для дат без
 * плана, экрана правки у них нет.
 */
export function signalsFor(plan, settings) {
  if (plan && Array.isArray(plan.signals) && plan.signals.length) return plan.signals;
  const own = settings && Array.isArray(settings.signals) ? settings.signals : [];
  return own.length ? own : ['headache'];
}

/** Короткая подпись вида сессии: зал, дом, навык, кардио, растяжка. */
export const KIND_RU = {
  gym: 'зал', home: 'дом', skill: 'навык', cardio: 'кардио', mobility: 'растяжка',
};

const weekday = (iso) => fromISO(iso).getDay();
const empty = (v) => v === null || v === undefined;

/**
 * Ключ сессии: вид плюс код дня. Склеивался руками в трёх местах, и ровно
 * на нём ломались два зальных дня на одной дате — приехавший Н1 закрывал
 * плановый В2. Одна форма на всех: разъехаться теперь нечему.
 */
export function sessionKey(kind, code) {
  return `${kind}|${code || ''}`;
}

/**
 * Ключ строки для прочерка. У сессий он несёт код дня: после переноса
 * на одной дате могут стоять два зальных дня, и общий ключ закрыл бы обе.
 */
export function skipKeyOf(task) {
  return task.kind ? sessionKey(task.kind, task.code) : task.key;
}

/** Где живёт отметка «не делал»: у дня или у недели. */
export function skipScopeOf(key) {
  return ['splitGap', 'waist', 'week'].includes(key) ? 'week' : 'day';
}

/**
 * Все строки дня с пометкой, закрыта ли каждая. Обязательные строки с цифрой
 * помечены required: они висят долгом. Фоновые уходят молча, без вины (R10).
 */
function allTasks(ctx) {
  const d = ctx.day || {};
  const w = ctx.week || {};
  // «Не делал» — законный ответ: строка закрывается, долг снимается,
  // а «не бегал» перестаёт быть неотличимым от «забыл записать».
  const daySkip = d.skipped || {};
  const weekSkip = w.skipped || {};
  const isSkipped = (key, k = null) => {
    const kk = k ? sessionKey(k.kind, k.code) : key;
    return Boolean(skipScopeOf(key) === 'week' ? weekSkip[kk] : daySkip[kk]);
  };
  const sessions = ctx.sessions || [];
  // Ключ сессии — вид плюс код дня. После переноса на одной дате могут
  // лежать два зальных дня, и по одному виду закрытость читалась ложно:
  // приехавший Н1 закрывал плановый В2.
  const doneKeys = new Set();
  for (const x of ctx.doneKinds || []) {
    if (typeof x === 'string') { doneKeys.add(x); continue; }
    doneKeys.add(sessionKey(x.kind, x.code));
    // Запись без кода дня (создана до 01.09 или приехала чужим бэкапом)
    // обязана закрывать сессию своего вида: иначе уже сделанная тренировка
    // копит вечный долг.
    if (!x.code) doneKeys.add(x.kind);
  }
  const closedSession = (s) => doneKeys.has(sessionKey(s.kind, s.code))
    || doneKeys.has(s.kind);
  const tasks = [];

  // Карточка закрывается любой записанной строкой утра (решение 23.09):
  // требование «вес и сон вместе» заставляло забывшего взвеситься жать
  // «не делал» — и прочерк снимал из долгов уже записанный сон. Пустые
  // вес и сон не теряются: за прошедшие дни их по-прежнему ловит `debts`.
  tasks.push({
    key: 'morning', title: 'Утренний чек-ин', required: true,
    done: morningClosed(d) || isSkipped('morning'),
    skipped: isSkipped('morning'),
  });

  // АД в день сигнала «голова» (CLAUDE.md). 25.09 галочка стояла, давления
  // нет. Строка живёт только сегодня: вчерашнее давление уже не измерить,
  // поэтому в долги она не уходит.
  const isToday = !ctx.today || ctx.date >= ctx.today;
  if (d.headache === true && isToday && (empty(d.bpSys) || empty(d.bpDia))) {
    tasks.push({
      key: 'bp', title: 'АД — сигнал «голова»', required: true,
      done: isSkipped('bp'),
      skipped: isSkipped('bp'),
    });
  }

  // Тренировка, перенесённая на другой день, в этот день долгом не висит:
  // она сделана, просто не здесь. Без этого плановая дата копила бы вечный
  // долг по сессии, которая уже в журнале.
  // Ключ с кодом дня: два зальных дня на одной дате иначе схлопнутся,
  // и перенос одного закрыл бы второй.
  const movedAway = new Map(
    (ctx.movedAway || []).map((m) => [sessionKey(m.kind, m.code), m.date]));

  for (const s of sessions) {
    if (s.kind === 'mobility') continue;
    const movedTo = movedAway.get(sessionKey(s.kind, s.code))
      || movedAway.get(sessionKey(s.kind, '')) || null;
    tasks.push({
      key: s.kind,
      title: s.kind === 'home' ? 'Домашняя сессия' : s.title || s.code,
      kind: s.kind,
      code: s.code,
      required: true,
      done: closedSession(s) || Boolean(movedTo) || isSkipped(s.kind, s),
      skipped: isSkipped(s.kind, s),
      movedTo,
    });
  }

  const mobility = sessions.find((s) => s.kind === 'mobility');
  if (mobility) {
    // Растяжка стала обязательной строкой: за Н2 явка была 3 из 7, а шпагат —
    // объявленная цель. Молчаливый пропуск скрывал именно это (правило 9).
    tasks.push({
      key: 'mobility', title: mobility.title || 'Блок растяжки', required: true,
      done: stretchDone(d, mobility) || isSkipped('mobility'),
      skipped: isSkipped('mobility'),
    });
  }

  // Просвет — в день замера, который называет план (26.09: навыковый день
  // переехал на среду, и привязка ко вторнику ставила бы замер в силовой).
  if (mobility && mobility.measureSplit) {
    tasks.push({
      key: 'splitGap', title: 'Просвет шпагата', required: true,
      done: !empty(w.splitGap) || isSkipped('splitGap'),
      skipped: isSkipped('splitGap'),
    });
  }

  if (weekday(ctx.date) === WED) {
    tasks.push({
      key: 'waist', title: 'Талия', required: true,
      done: !empty(w.waist) || isSkipped('waist'),
      skipped: isSkipped('waist'),
    });
  }

  tasks.push({
    key: 'evening', title: 'Вечер: ходьба и кардио', required: false,
    done: !empty(d.walkKm) || (d.cardio || []).length > 0 || isSkipped('evening'),
    skipped: isSkipped('evening'),
  });

  if (weekday(ctx.date) === SUN) {
    tasks.push({
      key: 'week', title: 'Недельные замеры', required: true,
      done: !WEEK_REQUIRED.some((k) => empty(w[k])) || isSkipped('week'),
      skipped: isSkipped('week'),
    });
  }

  return tasks;
}

/** Что осталось закрыть в этот день. */
export function pendingTasks(ctx) {
  return allTasks(ctx).filter((t) => !t.done);
}

// Сессии открываются через карточку «Сделано», у остальных строк формы больше нет:
// без этого списка первая же записанная цифра прятала форму навсегда.
const EDITABLE = new Set(['morning', 'bp', 'mobility', 'splitGap', 'waist', 'evening', 'week']);

/** Закрытые строки, которые ещё можно открыть и поправить. */
export function closedTasks(ctx) {
  // Прочерк должен сниматься: строка, закрытая «не делал», обязана остаться
  // доступной, иначе ошибочный прочерк не отменить ничем.
  return allTasks(ctx).filter((t) => t.done && (EDITABLE.has(t.key) || t.skipped));
}

/** Блок растяжки закрыт, когда отмечены все позиции этого дня. */
export function stretchDone(day, session) {
  const marks = (day && day.stretch) || {};
  const positions = (session && session.positions) || [];
  if (!positions.length) return false;
  return positions.every((p) => marks[p.n] === true);
}

/**
 * Незакрытые обязательные строки за прошедшие дни. Показываются отдельно
 * от сегодняшнего списка: вчерашнюю ходьбу уже не переиграть, а вчерашний
 * вес — это цифра, которую атлет помнит и может внести.
 */
export function debts(ctx) {
  const days = new Map((ctx.days || []).map((d) => [d.date, d]));
  const weeks = new Map((ctx.weeks || []).map((w) => [w.id, w]));
  const splitDates = new Set(ctx.splitDates || []);
  const out = [];

  for (const date of ctx.dates || []) {
    if (date >= ctx.today) continue;
    // Границы активного цикла: долги закрытого не висят — данных за них
    // уже не будет, а его ведение разобрано в итоге цикла (22.09).
    if (ctx.from && date < ctx.from) continue;
    if (ctx.to && date > ctx.to) continue;
    const d = days.get(date) || {};
    const w = weeks.get(isoWeek(date)) || {};

    const ds = d.skipped || {};
    const ws = w.skipped || {};
    // Долг — только пустое утро целиком (26.09): закрытое утро без веса
    // или сна — не долг, а «не заполнено».
    if (!ds.morning && !morningClosed(d)) out.push({ date, key: 'morning', title: 'утро' });
    if (splitDates.has(date) && empty(w.splitGap) && !ws.splitGap) {
      out.push({ date, key: 'splitGap', title: 'просвет шпагата' });
    }
    if (weekday(date) === WED && empty(w.waist) && !ws.waist) {
      out.push({ date, key: 'waist', title: 'талия' });
    }
  }
  return out;
}
