// Заведение и перенос сессии — отдельный модуль: этим занимаются два экрана,
// «Тренировка» и «День», и держать перенос в одном из них значило бы, что
// второму до него не дотянуться. Экран дня — то место, где перенос и ловится:
// там висит вчерашняя сессия, которую сделал не в свой день.
//
// Правило переноса одно и живёт здесь целиком: плановая дата сохраняется
// в записи (`movedFrom`), иначе сверка «план против факта» считает
// перенесённую тренировку пропущенной.
import { findWorkout, putWorkout, getPlan } from '../store.js';
import { sessionFor } from '../plan.js';
import { todayISO } from '../lib/dates.js';

/**
 * Объект тренировки без записи в базу. Открыть сессию посмотреть должно быть
 * бесплатно: до 01.09 сам факт открытия заводил черновик, и он навсегда
 * оставался в журнале как «пропущенное», даже если атлет просто заглянул
 * в план. Запись появляется в момент выбора режима заполнения.
 */
export function makeWorkout(date, hit, moved = null) {
  const { week, session } = hit;
  // Плановый RPE взвешивается подходами, а не упражнениями, и бонус в него
  // не входит. Иначе сравнение с фактическим — среднее по подходам — считает
  // разными мерами: на В1 это пять плановых чисел против пятнадцати
  // фактических подходов, и один длинный ряд махов двигает разность, на
  // которой стоит единственный автоматический сигнал к пересборке (правило 4).
  // Бонус необязателен: включать его дозу в план значит занижать плановый RPE
  // в те дни, когда бонус не брали.
  const rpes = session.exercises.flatMap((e) => (e.optional || e.rpe == null
    ? []
    : Array.from({ length: Number(e.sets) || 1 }, () => e.rpe)));
  const workout = {
    date,
    kind: session.kind,
    status: 'draft',
    weekN: week.n,
    weekKind: week.kind || 'work',
    dayCode: session.code,
    title: session.title || session.code,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    backdated: date !== todayISO(),
    // Дата плана сохраняется рядом с фактической: без неё сверка «план против
    // факта» теряет, что тренировка не пропущена, а перенесена.
    movedFrom: moved ? moved.date : null,
    plannedRPE: rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : null,
    avgRPE: null,
    chestSignal: null,
    prescription: session.exercises,
    exercises: session.exercises.map((e) => ({
      name: e.name, planName: e.name, replacedWith: null,
      skipped: false, skipReason: null, note: '', sets: [],
    })),
  };
  return workout;
}

export async function startWorkout(date, kind, moved = null) {
  const plan = await getPlan(date);
  const hit = moved || sessionFor(plan, date, kind);
  if (!hit) return null;
  const workout = makeWorkout(date, hit, moved);
  workout.id = await putWorkout(workout);
  return workout;
}

/**
 * Перенос сессии на другую дату. Запись может ещё не существовать — тогда
 * она заводится сразу на новой дате с плановой в `movedFrom`: перенос
 * объявляется до тренировки, а не после неё.
 *
 * Занятая дата — отказ, а не вторая запись с тем же ключом: `findWorkout`
 * отдаёт первую, и вторая становится недоступна навсегда. Это уже случалось.
 */
export async function moveSession({ from, kind, code, to }) {
  if (!to || to === from) return { ok: false, reason: 'same' };
  const existing = await findWorkout(from, kind, code);
  const clash = await findWorkout(to, kind, code);
  if (clash && (!existing || clash.id !== existing.id)) {
    return { ok: false, reason: 'clash', clash, existing };
  }
  if (existing) {
    applyMove(existing, to);
    await putWorkout(existing);
    return { ok: true, workout: existing };
  }
  const plan = await getPlan(from);
  const hit = sessionFor(plan, from, kind, code);
  if (!hit) return { ok: false, reason: 'no-plan' };
  const workout = makeWorkout(to, hit, { date: from, week: hit.week, session: hit.session });
  workout.id = await putWorkout(workout);
  return { ok: true, workout };
}

/**
 * Дата у записи меняется вместе с плановой пометкой. У сессии вне плана
 * плановой даты нет вовсе: писать «перенос с» значило бы рисовать карточку
 * о тренировке, которая на той дате никогда не планировалась.
 */
export function applyMove(workout, to) {
  const planned = workout.movedFrom || workout.date;
  workout.movedFrom = (workout.unplannedSession || to === planned) ? null : planned;
  workout.date = to;
  workout.backdated = to !== todayISO();
  return workout;
}

/**
 * Обмен датами двух сессий. Нужен ровно тогда, когда обе тренировки сделаны,
 * но записаны в чужие дни: отказ «на этой дате уже есть» без обмена оставлял
 * бы их так навсегда.
 */
export async function swapSessions(a, b) {
  const aDate = a.date;
  const bDate = b.date;
  applyMove(a, bDate);
  applyMove(b, aDate);
  await putWorkout(a);
  await putWorkout(b);
  return { a, b };
}
