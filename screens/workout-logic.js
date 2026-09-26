import { parseNum } from '../lib/format.js';

/** Первое число из строки: '22 кг/рук' -> 22, 'вес тела' -> null. */
export function firstNumber(s) {
  const m = String(s ?? '').match(/-?\d+(?:[.,]\d+)?/);
  return m ? parseNum(m[0]) : null;
}

/**
 * Вес из строки плана — только килограммы или гиря. Первое число строки
 * врало: «стопка ~15 см» уезжала в базу пятнадцатью килограммами (23.09),
 * «подбор по RPE 8–9» подставлял восьмёрку, «5ПМ … далее 100 кг» — пятёрку.
 */
export function planWeight(s) {
  const t = String(s ?? '');
  const kg = t.match(/(\d+(?:[.,]\d+)?)\s*кг/);
  if (kg) return parseNum(kg[1]);
  const bell = t.match(/гир[яиею]\s+(\d+(?:[.,]\d+)?)/);
  return bell ? parseNum(bell[1]) : null;
}

/** «3×8» в плановой строке: подходы и повторы явной парой. */
const EXPLICIT_REPS = /(\d+)\s*[×x]\s*(\d+)/;

/**
 * Повторы из плановой строки. Запись «3×8» означает три подхода по восемь:
 * первое число — подходы, и подставлять его в поле повторов нельзя.
 */
export function planReps(s) {
  const m = String(s ?? '').match(EXPLICIT_REPS);
  return m ? parseNum(m[2]) : firstNumber(s);
}

/**
 * Что подставить в поля следующего подхода.
 * Приоритет: предыдущий подход этой тренировки → прошлая тренировка → план.
 *
 * RPE идёт по тому же приоритету, что вес и повторы. Раньше он всегда
 * откатывался к плановому: введёшь 8,5 при плановых 8 — и следующий подход
 * снова предлагает 8, то есть введённое не переживает даже одного подхода.
 */
export function nextSetDefaults(presc, doneSets, history, opts = {}) {
  const working = (doneSets || []).filter((s) => !s.warmup);
  if (working.length) {
    const last = working[working.length - 1];
    return {
      weight: last.weight, reps: last.reps, sec: last.sec ?? null,
      rpe: last.rpe ?? presc.rpe ?? null,
    };
  }
  const fromHistory = history && history.length ? history[history.length - 1] : null;
  // Пустой вес в истории плановый не отменяет: 17.09 под именем становой
  // записали гиперэкстензию без веса, и 24.09 форма спрятала поле веса.
  const histWeight = fromHistory ? fromHistory.weight : null;
  return {
    weight: histWeight != null ? histWeight : planWeight(presc.weight),
    // У чистого удержания повторов в плане нет: «удержание 25–35 с» даёт
    // первое число, и форма звала записать 25 повторов стойки. Подставляем
    // только явное «N×M» — у Ролика («3×6 + 2×15 с») повторы настоящие.
    reps: fromHistory ? fromHistory.reps
      : ((opts.hold && presc.holdSec == null && !EXPLICIT_REPS.test(String(presc.reps ?? '')))
        ? null : planReps(presc.reps)),
    // Секунды из плана не подставляются: «3×8 + 2×15 с» у Ролика значит,
    // что первые подходы идут в повторах, и предзаполненное поле удержания
    // звало бы записать не то, что делаешь.
    // Исключение — подход с удержанием (`holdSec` в плане): там секунды
    // часть каждого подхода, и план их задаёт числом.
    sec: fromHistory && fromHistory.sec != null ? fromHistory.sec : (presc.holdSec ?? null),
    rpe: (fromHistory && fromHistory.rpe != null) ? fromHistory.rpe : (presc.rpe ?? null),
  };
}

/**
 * Форма веса тела: поле веса прячется за кнопку «+ вес (жилет, пояс)».
 * Только когда веса нет ни в подстановке, ни в плане: число в плане держит
 * поле всегда, как бы ни выглядела история. Число здесь — любое: у «5ПМ»
 * килограммов в строке нет, а штанга есть; подставляется при этом только
 * вес в килограммах (`planWeight`).
 */
export function bodyweightForm(presc, defaults, cardio) {
  if (cardio || presc.perSide) return false;
  return defaults.weight == null && firstNumber(presc.weight) == null;
}

/**
 * Какую паузу пишет подход (решение атлета 26.09). Первый подход упражнения
 * несёт переход — время от последнего подхода прошлого упражнения; остальные —
 * отдых между подходами. Две меры в одном поле не смешиваются: правила
 * читают отдых, переход — длину сессии. У первого упражнения перехода нет.
 */
export function restKind(exIndex, setIndex) {
  if (setIndex > 0) return 'rest';
  return exIndex > 0 ? 'transition' : null;
}

/**
 * Мера подхода. Обычно она одна: удержание гасит повторы, иначе стойка
 * уехала бы в базу ещё и повторами из плановой строки. Подход с удержанием
 * (ролик Ц4: 6 повторов и 15 с внизу) хранит обе цифры.
 */
export function setMeasure({ reps, sec, combined }) {
  if (combined) return { reps: reps ?? null, sec: sec ?? null };
  return sec != null ? { reps: null, sec } : { reps: reps ?? null, sec: null };
}

/**
 * Метка контроля в упражнении одна. Поставленная на подход, она снимается
 * с остальных; снятая — снимается только со своего.
 */
export function markControl(sets, index, on) {
  sets.forEach((s, i) => {
    if (i === index) s.control = Boolean(on);
    else if (on && s.control) s.control = false;
  });
  return sets;
}

/**
 * Контрольный подход — первый рабочий в упражнении с меткой плана.
 * Он же 5ПМ на Н4: в тренировочную линию не смешивается (правило 5).
 */
export function isControlSet(presc, doneSets, warmup) {
  if (!presc || !presc.control || warmup) return false;
  return (doneSets || []).filter((s) => !s.warmup && s.control).length === 0;
}

/** Средний RPE по всем рабочим подходам тренировки. */
export function averageRPE(workout) {
  const rpes = (workout.exercises || [])
    .flatMap((e) => e.sets || [])
    .filter((s) => !s.warmup)
    .map((s) => s.rpe)
    .filter((v) => v != null);
  return rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : null;
}

/**
 * Жимовый день: только после него спрашивается строка правой груди.
 *
 * До 07.09 спрашивалось и на В2, а В2 — «верх, тяга-акцент»: жима там нет
 * ни одного. Вопрос без основания обесценивает ответ: строка ведётся ради
 * симптома, который появляется под жимом, и лишние нули в ней означают
 * не «чисто», а «спросили не по делу».
 */
export function asksChestSignal(workout) {
  return workout.kind === 'gym' && workout.dayCode === 'В1';
}

/**
 * Фактический отдых: разница временных меток, а не накопленные тики.
 * Свёрнутое приложение усыпляет интервалы, метки не врут.
 */
export function restBetween(prevAtISO, nowMs) {
  if (!prevAtISO) return null;
  const prev = Date.parse(prevAtISO);
  if (!Number.isFinite(prev)) return null;
  const sec = Math.round((nowMs - prev) / 1000);
  return sec >= 0 ? sec : null;
}

/**
 * Режим заполнения сессии. Записи, созданные до 01.09, поля не несут —
 * для них считаем `live`: они и заполнялись по ходу.
 */
export function fillModeOf(workout) {
  return (workout && workout.fillMode) === 'later' ? 'later' : 'live';
}

/**
 * Отдых подхода. Метки времени годятся, только когда заполняешь по ходу
 * тренировки: 01.09 сессия вносилась целиком после зала, метки легли одна
 * к другой, и в журнал ушли «отдыхи» по 1–3 секунды. Прежняя защита стояла
 * на `backdated`, то есть на дате, а не на способе заполнения, и этот случай
 * пропустила — день-то был сегодняшний.
 *
 * Введённое руками побеждает измеренное всегда: атлет знает, что делал.
 * Возвращается пара: сама цифра и признак, что она вспомнена, а не измерена.
 * Смешивать их в одном столбце нельзя — через месяц не отличить.
 */
/**
 * Потолок правдоподобного отдыха между подходами. Сессия идёт 46–62 минуты,
 * и получасовая пауза внутри неё означает не отдых, а разрыв: телефон убрали
 * в карман, приложение выгрузили, вернулись после зала. Такая цифра хуже
 * пустоты — пустое поле видно, а «отдых 47 минут» уедет в свод как факт.
 */
export const REST_CEILING = 1800;

/**
 * Момент, которым закрывается отдых. До 07.09 им была запись следующего
 * подхода, то есть в «отдых» входило само выполнение: подход на 8 повторов —
 * это ещё 30–40 секунд сверху, и ряд отдыха на якорных лифтах был завышен
 * ровно на длительность подхода.
 *
 * Теперь отдых закрывает первое касание формы следующего подхода: перед
 * подходом атлет и так лезет выставить вес. Не тронул — пишем прежний
 * интервал, но помечаем его `restToStart: false`, чтобы две меры не слиплись
 * в одном столбце. Ряд Н1–Н3 остаётся несравнимым с последующими; переписывать
 * прошлое нечем — метки начала подхода в тех записях нет.
 */
export function restForSet({ mode, lastSetAt, now, manual, startedAt }) {
  if (manual != null && Number.isFinite(manual) && manual >= 0) {
    return { rest: Math.round(manual), restManual: true, restToStart: false };
  }
  if (mode !== 'live') return { rest: null, restManual: false, restToStart: false };
  const until = startedAt ? Date.parse(startedAt) : (now ?? Date.now());
  const clean = Boolean(startedAt) && Number.isFinite(until);
  const rest = restBetween(lastSetAt, clean ? until : (now ?? Date.now()));
  if (rest != null && rest > REST_CEILING) {
    return { rest: null, restManual: false, restToStart: false };
  }
  return { rest, restManual: false, restToStart: rest != null && clean };
}

/**
 * Пустое упражнение вне плана. Живёт в обоих массивах записи, чтобы сверка
 * «план против факта» шла по индексу, как раньше, и помечено `unplanned`:
 * в знаменатель «план закрыт» не входит, в недельный объём входит —
 * это настоящая работа, а не приписка.
 *
 * 01.09 атлет сделал три выхода силой, которых в силовом дне нет с пересборки
 * 31.08, и записать их было некуда: дописывать умел только бонус.
 */
export function insertExercise(workout, index, name) {
  const at = Math.max(0, Math.min(Number(index) ?? 0, workout.exercises.length));
  workout.prescription = workout.prescription || [];
  workout.prescription.splice(at, 0, { name, unplanned: true, sets: 0, reps: '—' });
  workout.exercises.splice(at, 0, {
    name, planName: null, replacedWith: null, unplanned: true,
    skipped: false, skipReason: null, note: '', sets: [],
  });
  return at;
}

/** Упражнения, по которым считается «план закрыт»: без бонуса и внеплановых. */
export function requiredPairs(workout) {
  return (workout.exercises || [])
    .map((e, i) => ({ e, p: (workout.prescription || [])[i] || {}, i }))
    .filter((x) => !x.p.optional && !x.p.unplanned && !x.e.unplanned);
}

/** Подписи видов активности — общие для экранов дня и тренировки. */
export const KIND_TITLE = {
  gym: 'Силовая',
  skill: 'Навыки',
  home: 'Домашняя',
  cardio: 'Кардио',
};

/**
 * Пустая сессия вне плана. Побегал в субботу, размялся в выходной, доделал
 * навыки — записать это было некуда: экран упирался в «на эту дату сессии
 * в плане нет», и активность не попадала в журнал вообще.
 */
export function makeUnplannedWorkout(date, kind, week, todayIso) {
  return {
    date,
    kind,
    status: 'draft',
    weekN: week ? week.n : null,
    weekKind: week ? (week.kind || 'work') : 'work',
    dayCode: KIND_TITLE[kind] || kind,
    title: `${KIND_TITLE[kind] || kind} вне плана`,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    backdated: date !== todayIso,
    movedFrom: null,
    unplannedSession: true,
    plannedRPE: null,
    avgRPE: null,
    chestSignal: null,
    prescription: [],
    exercises: [],
  };
}

/**
 * Часы тренировки. Отсчёт от первого записанного подхода, а не от открытия
 * экрана: заглянуть в план накануне — обычное дело, и от этого в журнал
 * ушли бы десять часов. В закрытой сессии показывают время до завершения.
 */
export function workoutElapsed(workout, nowMs = Date.now()) {
  if (!workout || !workout.firstSetAt) return null;
  const from = Date.parse(workout.firstSetAt);
  if (!Number.isFinite(from)) return null;
  const to = workout.finishedAt ? Date.parse(workout.finishedAt) : nowMs;
  const sec = Math.round((to - from) / 1000);
  return sec >= 0 ? sec : null;
}

/**
 * Виды кардио, которые понимает приложение. Список один на два места: он
 * наполняет выпадающий список ручного ввода на экране дня и распознаёт тип
 * по названию упражнения. Разойдись они — «эллипс», добавленный в список,
 * лёг бы в день как безымянное «кардио», и разбор по типам (правило 7:
 * бег в наборе запрещён) читал бы разные словари в зависимости от того,
 * как строку внесли.
 */
export const CARDIO_TYPES = ['ходьба', 'гребля', 'ски-эрг', 'бег', 'air bike', 'велосипед'];

/**
 * Вид кардио по названию упражнения. Раньше в день жёстко писался «бег»,
 * и гребля попадала в журнал бегом — а бег в наборе запрещён правилом 7,
 * то есть метрика читалась бы как нарушение.
 */
export function cardioType(workout) {
  const hay = [
    ((workout.exercises || [])[0] || {}).name,
    workout.title,
    workout.dayCode,
  ].filter(Boolean).join(' ').toLowerCase();
  return CARDIO_TYPES.find((t) => hay.includes(t)) || 'кардио';
}

/**
 * План сессии, разложенный под фактические упражнения записи.
 *
 * Раньше при отсутствии `prescription` в записи брался план целиком и
 * использовался по индексу. Порядок и число упражнений в факте с планом
 * не совпадают: в журнале Ц3 четыре импортированные записи Н1–Н2 идут без
 * `prescription`, и у 19.08 в факте шестнадцать упражнений против одиннадцати
 * в плане. Экран печатал над становой дозу Палов-пресса, таймер ставил 60 с
 * вместо 180, а `nextSetDefaults` подставлял чужой вес. Хуже другое: `asksRPE`
 * читается из того же места — на выходе силой, встретившем плановую стойку,
 * поле RPE не показывалось и в базу уходил `null`, а на приседе на одной ноге
 * RPE, наоборот, спрашивался, хотя навыкам он не ставится (решение 24.08).
 * С первой же дописанной строки кривой план уходил в базу навсегда.
 *
 * Сопоставление идёт по имени. Несопоставленному упражнению достаётся пустой
 * объект — «плана на него нет» честнее, чем чужая доза. Повторяющиеся имена
 * разбираются по порядку: каждая плановая строка тратится один раз.
 */
export function prescriptionFor(exercises, planned) {
  const pool = new Map();
  (planned || []).forEach((p, i) => {
    const key = p.name;
    if (!pool.has(key)) pool.set(key, []);
    pool.get(key).push(i);
  });
  // Длина результата равна числу упражнений записи, ни на один больше:
  // `prescription` адресуется индексом упражнения, и лишний хвост означал бы
  // фантомные строки в арифметике «план закрыт».
  return (exercises || []).map((e) => {
    const queue = pool.get(e.planName || e.name);
    if (queue && queue.length) return planned[queue.shift()];
    return {};
  });
}

/**
 * Закрыто ли упражнение: набран план или проставлен осознанный прочерк.
 *
 * Считалось на одном экране четырьмя разными способами. Кнопка ЗАВЕРШИТЬ
 * принимала ЛЮБОЙ подход, включая разминочный, — записал одну разминку
 * в трёх упражнениях, и она пишет «3 из 8», пока полоса прогресса показывает
 * ноль. У внепланового упражнения плана нет вовсе, и `p.sets` там ноль:
 * закрытым оно считается по факту работы, иначе очередь «дальше» звала бы его
 * до конца сессии и печатала «0×—».
 *
 * Место одно, потому что «план закрыт» — объявленная арифметика цикла, а не
 * косметика: правило пропуска или бонуса меняется в одной строке, а не в
 * четырёх, из которых четвёртую забудут и ничего не упадёт.
 */
export function exerciseClosed(e, p = {}) {
  if (!e) return false;
  if (e.skipped) return true;
  const done = (e.sets || []).filter((s) => !s.warmup).length;
  if (p.unplanned || e.unplanned) return done > 0;
  return Number(p.sets) > 0 && done >= Number(p.sets);
}

/**
 * Доля сессии, взятая подходами: числитель — рабочие подходы, знаменатель —
 * сумма плановых по тем же упражнениям, что считает ЗАВЕРШИТЬ.
 *
 * Место здесь, рядом с `exerciseClosed`, по той же причине: «план закрыт» —
 * объявленная арифметика цикла. Пока подсчёт лежал в разметке экрана, правило
 * пропуска было записано дважды, и полоса разошлась бы с кнопкой молча —
 * ровно тот четвёртый экземпляр, о котором предупреждает соседний комментарий.
 *
 * Пропущенное упражнение отдаёт свои плановые подходы целиком: осознанный
 * пропуск закрывает план (`exerciseClosed`), и полоса обязана доходить до
 * конца там же, где кнопка говорит «6 из 6». Разминочные не считаются нигде,
 * лишние сверх плана не переливают полосу за край.
 */
export function setProgress(workout) {
  const required = requiredPairs(workout);
  const planned = required.reduce((n, { p }) => n + (Number(p.sets) || 0), 0);
  const taken = required.reduce((n, { e, p }) => {
    const need = Number(p.sets) || 0;
    if (e.skipped) return n + need;
    const done = (e.sets || []).filter((x) => !x.warmup).length;
    return n + Math.min(done, need);
  }, 0);
  return { taken, planned, percent: planned ? Math.round((taken / planned) * 100) : 0 };
}

/**
 * Подходы в порядке показа: разминочные наверх, внутри группы — хронология.
 *
 * Возвращает пары «подход и его индекс в базе»: номер на экране и индекс
 * в записи — разные числа, и на их несовпадении уже ловили диалог удаления
 * и подпись кнопки «СОХРАНИТЬ ПОДХОД N». Компаратор был написан дважды.
 */
export function orderedSets(sets) {
  return (sets || []).map((s, i) => ({ s, i }))
    .sort((a, b) => Number(Boolean(b.s.warmup)) - Number(Boolean(a.s.warmup)));
}

/**
 * Первое незакрытое упражнение сессии. Открывать всегда с нуля было честно
 * ровно один раз — в начале тренировки; на любом возврате это означало
 * пролистать стрелкой весь день, чтобы дописать один забытый подход.
 */
export function firstOpen(workout) {
  const list = workout.exercises || [];
  const at = list.findIndex(
    (e, i) => !exerciseClosed(e, (workout.prescription || [])[i] || {}));
  return at < 0 ? 0 : at;
}

/**
 * Долги: упражнения, пропущенные за последнюю неделю. В списке выбора они
 * идут первыми — «доп. упражнение» чаще всего и есть вчерашний пропуск,
 * а искать его в справочнике из полутора сотен имён приходилось руками.
 */
export function debtNames(workouts, date, days = 7) {
  const from = new Date(Date.parse(date) - days * 86400000).toISOString().slice(0, 10);
  const out = new Set();
  for (const w of workouts || []) {
    if (w.date > date || w.date < from) continue;
    for (const e of w.exercises || []) if (e.skipped) out.add(e.name);
  }
  return out;
}
