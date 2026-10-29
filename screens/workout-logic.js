import { parseNum, fmtWeight } from '../lib/format.js';

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
 * Подход с удержанием (CONTEXT.md): повторы и секунды — факт одного подхода.
 * Ролик Ц4 нёс число секунд (`holdSec`), ролик Ц5 — только признак `hold`:
 * доза удержания в плане не названа, а поля без признака гасили друг друга.
 */
export const isHoldSet = (presc) => presc.holdSec != null || presc.hold === true;

/**
 * Единицы подхода. Флаг справочника `perSide` склеивал два смысла: «вес на руку»
 * (гантели, махи) и «повторы на сторону» (выпад голеностопа, казачий, косые).
 * Форма подписывала «вес на сторону» выпаду с весом тела, а 01.10 косые
 * записаны «20» при плане «10/ст» — цифра вдвое больше плановой единицы.
 * Повторы на сторону читаются из строки плана, вес на руку — из флага,
 * кроме веса тела и одного снаряда на двоих (гоблет).
 */
export const repsPerSide = (presc) => /\/\s*(ст|ногу|сторону|руку)(?!\p{L})/u
  .test(String((presc && presc.reps) ?? ''));
export const weightPerHand = (presc) => Boolean(presc && presc.perSide)
  && !/вес тела|гоблет/.test(String(presc.weight ?? ''));

/** Что сделано на деле: замена, если она есть, иначе плановое имя. */
export const doneName = (ex) => ex.replacedWith || ex.name;

/** Вариант снаряда упражнения совпадает с искомым; «основной» — `null`. */
export const sameVariant = (ex, variant) => (ex.variant || null) === (variant || null);

/**
 * Рабочие подходы упражнения за прошлые тренировки, в порядке дат, — источник
 * подстановки и строки «прошлый раз».
 *
 * Ищется то, что сделано на деле, а не плановое имя: 27.10 вертикальная тяга
 * предложила 16×12, потому что 20.10 под её именем записан жим гири заменой,
 * а 29.10 становая — 31,7×15 от сгибания ног. Черновики не в счёт: брошенная
 * сессия 20.10 подставила в жим 90 при плане 100.
 */
export function exerciseHistory(workouts, name, { exceptId = null, upTo = null, variant = null } = {}) {
  const rows = [];
  for (const w of [...(workouts || [])].sort((a, b) => a.date.localeCompare(b.date))) {
    if (w.id === exceptId || w.status !== 'done') continue;
    // Открытая заранее сессия не должна тянуть вес из более поздней:
    // история — то, что было до неё, а не то, что уже введено после.
    if (upTo && w.date > upTo) continue;
    const ex = (w.exercises || []).find((e) => doneName(e) === name);
    // Вариант снаряда ведёт свой ряд (решение 29.10): веса кроссовера
    // и гантелей в одну подстановку не смешиваются.
    if (ex && !ex.skipped && sameVariant(ex, variant)) {
      for (const s of ex.sets || []) if (!s.warmup) rows.push({ ...s, date: w.date });
    }
  }
  return rows;
}

/**
 * Повторы плана, которые можно подставить в поле. У чистого удержания
 * повторов в плане нет: «удержание 25–35 с» даёт первое число, и форма звала
 * записать 25 повторов стойки. Тогда берётся только явное «N×M» — у Ролика
 * («3×6 + 2×15 с») повторы настоящие.
 */
function planRepsFor(presc, hold) {
  if (hold && !isHoldSet(presc) && !EXPLICIT_REPS.test(String(presc.reps ?? ''))) return null;
  return planReps(presc.reps);
}

/**
 * Что подставить в поля следующего подхода.
 * Приоритет: предыдущий подход этой тренировки → план → прошлая тренировка.
 *
 * План стоит выше истории (решение атлета 29.10): прогрессию задаёт план,
 * и неделя с новым весом начиналась с прошлонедельного числа. История
 * заполняет только то, чего в плане числом нет: «подбор», «макс», вес тела.
 * Оба источника видны чипами над формой и ставятся касанием.
 *
 * RPE первого подхода не подставляется (решение 29.10): подставленное число
 * сохранялось нетронутым, и датчик правила 4 читал план вместо оценки.
 * План или прошлое идут подсказкой `rpeHint`. Внутри сессии RPE переносится
 * с прошлого подхода: введёшь 8,5 при плановых 8 — следующий не откатывает к 8.
 */
export function nextSetDefaults(presc, doneSets, history, opts = {}) {
  const working = (doneSets || []).filter((s) => !s.warmup);
  const fromHistory = history && history.length ? history[history.length - 1] : null;
  const rpeHint = presc.rpe ?? (fromHistory ? fromHistory.rpe ?? null : null);
  if (working.length) {
    const last = working[working.length - 1];
    return {
      weight: last.weight, reps: last.reps, sec: last.sec ?? null, cell: last.cell ?? null,
      measure: last.measure ?? null, rpe: last.rpe ?? null, rpeHint,
    };
  }
  // Пустой вес в истории плановый не отменяет: 17.09 под именем становой
  // записали гиперэкстензию без веса, и 24.09 форма спрятала поле веса.
  // Ноль в записях до 29.10 — вес тела, а не «0» в поле веса.
  const planW = planWeight(presc.weight);
  const planR = planRepsFor(presc, opts.hold);
  return {
    weight: planW != null ? planW : ((fromHistory && fromHistory.weight) || null),
    reps: planR != null ? planR : (fromHistory ? fromHistory.reps : null),
    // Секунды из плана не подставляются: «3×8 + 2×15 с» у Ролика значит,
    // что первые подходы идут в повторах, и предзаполненное поле удержания
    // звало бы записать не то, что делаешь.
    // Исключение — подход с удержанием (`holdSec` в плане): там секунды
    // часть каждого подхода, и план их задаёт числом.
    sec: fromHistory && fromHistory.sec != null ? fromHistory.sec : (presc.holdSec ?? null),
    // Ячейка идёт вместе с весом, из которого взята: при плановом весе
    // она считается по шкале, а не тянется из прошлого раза.
    cell: planW == null && fromHistory ? fromHistory.cell ?? null : null,
    // Своя мера (стена, стопка) идёт с прошлого раза: план её числом не задаёт.
    measure: fromHistory ? fromHistory.measure ?? null : null,
    rpe: null,
    rpeHint,
  };
}

/**
 * Чипы над формой: «план 100×5 @7» и «прошлый 90×6 @8». Касание ставит вес
 * и повторы, RPE не трогает — это оценка подхода, а не цифра для копирования.
 * Чип без единого числа не показывается: «план подбор» полей не заполнит.
 */
export function fillChips(presc, history, opts = {}) {
  const out = [];
  const planW = planWeight(presc.weight);
  const planR = planRepsFor(presc, opts.hold);
  if (planW != null || planR != null) {
    out.push({ kind: 'plan', weight: planW, reps: planR, sec: null, cell: null, rpe: presc.rpe ?? null });
  }
  const last = history && history.length ? history[history.length - 1] : null;
  if (last && (last.weight != null || last.reps != null || last.sec != null)) {
    out.push({
      kind: 'last', weight: last.weight || null, reps: last.reps ?? null,
      sec: last.sec ?? null, cell: last.cell ?? null, rpe: last.rpe ?? null,
    });
  }
  return out;
}

/** Подпись чипа: «план 100×5 @7», «прошлый в/т×12», «прошлый 102,1 (яч. 10)×15». */
export function chipText(chip) {
  const word = chip.kind === 'plan' ? 'план' : 'прошлый';
  const amount = chip.sec != null
    ? (chip.reps != null ? `${chip.reps}+${fmtWeight(chip.sec)} с` : `${fmtWeight(chip.sec)} с`)
    : (chip.reps != null ? String(chip.reps) : '');
  // Вес тела в прошлом подходе — «в/т»; у плана без числа веса это «подбор»
  // или «вес тела», и чип просто молчит о весе.
  const weight = chip.weight
    ? fmtWeight(chip.weight) + (chip.cell != null ? ` (яч. ${chip.cell})` : '')
    : (chip.kind === 'last' ? 'в/т' : '');
  const body = weight && amount ? `${weight}×${amount}` : (weight || amount);
  return `${word} ${body}` + (chip.rpe != null ? ` @${fmtWeight(chip.rpe)}` : '');
}

/**
 * Где спрашивать RPE (решение атлета 29.10): у всех силовых, а не только
 * там, где в плане есть число. Навыку RPE не ставится — критерий там распад
 * техники; класс навыка план Ц4–Ц5 несёт в `zoneClass`. У Ц3 класса нет,
 * там действует прежнее правило: число RPE в плане.
 *
 * Внеплановое упражнение и контрольный подход спрашивают RPE всегда: доделанный
 * жим без класса записывался как навык, а 5ПМ при RPE 10 и при 8 — разные базы.
 * Кардио вместо RPE пишет пульс тем же полем.
 */
export function asksRPE(presc, ex, kind) {
  if (kind === 'cardio') return true;
  if (presc.control || presc.unplanned || (ex && ex.unplanned)) return true;
  if (kind === 'skill' && !presc.zoneClass) return false;
  if (presc.zoneClass) return presc.zoneClass !== 'skill';
  return presc.rpe != null;
}

/**
 * «+ ещё N таких» в режиме «потом» (решение атлета 29.10): копии последнего
 * рабочего подхода — вес, повторы, секунды, ячейка. Отдыха и перехода
 * у копий нет: их никто не мерил. RPE не размножается — оценка была одна,
 * и четыре одинаковые цифры выдали бы её за четыре. Метки контроля и отказа
 * принадлежат своему подходу и тоже не копируются.
 */
export function copiesOfLast(sets, n) {
  const working = (sets || []).filter((s) => !s.warmup);
  const last = working[working.length - 1];
  if (!last || !(n > 0)) return [];
  return Array.from({ length: n }, () => ({
    weight: last.weight ?? null,
    reps: last.reps ?? null,
    sec: last.sec ?? null,
    ...(last.cell != null ? { cell: last.cell } : {}),
    ...(last.measure != null ? { measure: last.measure } : {}),
    rpe: null,
    rest: null,
    warmup: false,
    control: false,
  }));
}

/**
 * Отдых на контрольном лифте — выбором на упражнение (решение атлета 29.10).
 * «По плану» — значение по умолчанию и не печатается: в записи видно только
 * отклонение, ради которого отметка заведена — по нему читается RPE.
 */
export const REST_FEEL = { plan: 'по плану', longer: 'дольше', shorter: 'короче' };
export const restFeelText = (v) => (v === 'longer' || v === 'shorter'
  ? `отдых ${REST_FEEL[v]} плана` : null);

/**
 * Причина пропуска — кнопкой (решение атлета 29.10): разбор план-факт читает
 * её числом случаев, а текст «не успел»/«нет времени»/«время» склеивался
 * только глазами. Текст остаётся по желанию; у сигнала здоровья он обязателен —
 * одно слово, где, — и запись идёт в разбор эпизодом здоровья.
 */
export const SKIP_KINDS = {
  time: 'время', fatigue: 'усталость', health: 'сигнал здоровья', move: 'перенос →', declined: 'не стал',
};

/** Пропуск с причиной. `moveTo` — сессия переноса: `{ date, kind, code }`. */
export function skipAs(ex, kind, text = '', moveTo = null) {
  const t = String(text || '').trim();
  ex.skipped = true;
  // Без кнопки — прежний путь: причина одним текстом.
  if (!SKIP_KINDS[kind]) {
    delete ex.skipKind;
    delete ex.skipMoveTo;
    ex.skipReason = t || 'без причины';
    return ex;
  }
  const head = kind === 'move' && moveTo
    ? `перенос → ${moveTo.label || `${moveTo.date} ${moveTo.code}`}`
    : SKIP_KINDS[kind];
  ex.skipKind = kind;
  ex.skipReason = t ? `${head}: ${t}` : head;
  if (kind === 'move' && moveTo) ex.skipMoveTo = { date: moveTo.date, kind: moveTo.kind, code: moveTo.code };
  else delete ex.skipMoveTo;
  return ex;
}

/**
 * Куда перенести: ближайшие силовые и навыковые сессии плана в течение недели
 * после этой (`trainingSessions` из `plan.js`). Кардио — не место для подхода.
 */
export function moveTargets(sessions, workout, limit = 3) {
  const to = new Date(Date.parse(workout.date) + 7 * 86400000).toISOString().slice(0, 10);
  return (sessions || [])
    .filter((s) => s.date > workout.date && s.date <= to && (s.kind === 'gym' || s.kind === 'skill'))
    .slice(0, limit);
}

/**
 * Перенесённое в эту сессию и ещё не вставленное: упражнения других
 * тренировок с `skipMoveTo` на эту дату, вид и код. Вставляется руками —
 * «плановые в начатую сессию не дописываются», перенос идёт «вне плана».
 */
export function incomingMoves(workouts, workout) {
  const out = [];
  for (const w of workouts || []) {
    if (w.id != null && w.id === workout.id) continue;
    (w.exercises || []).forEach((e, i) => {
      const m = e.skipMoveTo;
      if (!e.skipped || !m || m.date !== workout.date || m.kind !== workout.kind
          || m.code !== workout.dayCode) return;
      const name = doneName(e);
      const placed = (workout.exercises || []).some((x) => x.movedFrom === w.date && x.name === name);
      if (!placed) out.push({ name, from: w.date, fromCode: w.dayCode, presc: (w.prescription || [])[i] || {} });
    });
  }
  return out;
}

/**
 * Вставка перенесённого: «вне плана», но с плановой дозой исходной сессии —
 * подстановка и «+ ещё N таких» работают как на своём месте.
 */
export function insertMoved(workout, at, move) {
  const i = insertExercise(workout, at, move.name);
  const { name, sets, reps, weight, rpe, rest, zoneClass, measure, machine, perSide } = move.presc;
  workout.prescription[i] = {
    ...Object.fromEntries(Object.entries({
      name, sets, reps, weight, rpe, rest, zoneClass, measure, machine, perSide,
    }).filter(([, v]) => v !== undefined)),
    name: move.name, unplanned: true, movedFrom: move.from,
  };
  workout.exercises[i].movedFrom = move.from;
  return i;
}

/**
 * Следующее незакрытое упражнение после `index` или `null`. Им уводят пропуск
 * и «+ ещё N таких»: следующий шаг всё равно делался стрелкой.
 */
export function nextOpenAfter(workout, index) {
  const list = workout.exercises || [];
  for (let i = index + 1; i < list.length; i += 1) {
    if (!exerciseClosed(list[i], (workout.prescription || [])[i] || {})) return i;
  }
  return null;
}

/**
 * Форма веса тела: поле веса прячется за кнопку «+ вес (жилет, пояс)».
 * Только когда веса нет ни в подстановке, ни в плане: число в плане держит
 * поле всегда, как бы ни выглядела история. Число здесь — любое: у «5ПМ»
 * килограммов в строке нет, а штанга есть; подставляется при этом только
 * вес в килограммах (`planWeight`).
 */
export function bodyweightForm(presc, defaults, cardio) {
  if (cardio || weightPerHand(presc)) return false;
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

/**
 * Убирает упражнение, вставленное по ошибке (заметка атлета 18.10: обратная
 * бабочка «хочу удалить, но не могу» осталась пропуском в записи дня).
 * Только вне плана и только без подходов: плановое живёт с тренировкой, с
 * которой она стартовала, а записанное — факт. Возвращает убранное или null.
 */
export function removeUnplanned(workout, index) {
  const ex = (workout.exercises || [])[index];
  if (!ex || !ex.unplanned || (ex.sets || []).length) return null;
  const [removed] = workout.exercises.splice(index, 1);
  const [presc] = (workout.prescription || []).splice(index, 1);
  return { ex: removed, presc, index };
}

/**
 * Проверка подхода перед записью. Отвергает то, чего не бывает, и спрашивает
 * о том, что похоже на опечатку, — молча не правит ничего, кроме веса 0.
 * Из бэкапа 29.10: гребля дважды записана метрами в поле «км» (2000 и 3200),
 * у 11 подходов с весом тела стоит 0 вместо «в/т».
 * Возвращает `{ set, ask: [{ msg, fix }], block }`.
 */
export function checkSetInput(set, { cardio = false } = {}) {
  const out = { set: { ...set }, ask: [], block: null };
  if (cardio) {
    if (set.km != null && set.km > 50) {
      out.ask.push({
        msg: `${fmtWeight(set.km)} км — похоже на метры. Записать ${fmtWeight(set.km / 1000)} км?`,
        fix: { km: Math.round(set.km) / 1000 },
      });
    }
    if (set.hr != null && (set.hr < 40 || set.hr > 220)) out.block = `Пульс ${set.hr} — вне 40–220.`;
    return out;
  }
  // Ноль килограммов значит «без отягощения»: так он и пишется — `null`,
  // «в/т», а не число, которое потом сравнивается с настоящими весами.
  if (set.weight === 0) out.set.weight = null;
  if (set.rpe != null && (set.rpe < 1 || set.rpe > 10)) {
    out.block = `RPE ${fmtWeight(set.rpe)} — вне шкалы 1–10.`;
  }
  return out;
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
