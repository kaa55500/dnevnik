// Обзор сессии перед заполнением и выбор упражнения из справочника.
// Вынесены из `workout.js` 29.10 (п. 7 очереди): файл перевалил за 1900 строк,
// а пачка 3 разбора 29.10 растит именно выбор упражнения — замена берётся
// из справочника тем же списком. Оба читают и меняют состояние заполнения,
// поэтому получают его явно: `ctx` собирает `screenCtx()` в `workout.js`.

import {
  findWorkout, delWorkout, getPlan, getDay, getWeek, listWorkouts,
} from '../store.js';
import { sessionFor } from '../plan.js';
import { weekdayShort, isoWeek, dm } from '../lib/dates.js';
import {
  insertExercise, listDose, doneName, moveExercise, removeExercise,
  restoreRemoved, undoDelete, snapshotOrder, restoreOrder, gestureAxis, swipeVerdict, dropIndex,
} from './workout-logic.js';
import { applyMove, swapSessions } from './session-move.js';
import { navigate } from '../main.js';

/** Сколько живёт плашка «Убрано: X · вернуть». */
const UNDO_MS = 5000;

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

/**
 * Обзор перед заполнением: весь план сессии целиком, ниже развилка режима.
 *
 * Режим спрашивается явно, потому что автоопределение уже сломалось: отдых
 * писался, если дата сессии сегодняшняя, а 01.09 атлет внёс сегодняшнюю
 * тренировку целиком после зала — метки времени легли одна к другой,
 * и в журнал ушли «отдыхи» по 1–3 секунды.
 */
export async function drawOverview(box, ctx) {
  const {
    state, draw, goTo, save, stopTimer, persistStretch, weekCrumb, extraSteps,
  } = ctx;
  const { workout } = state;
  const d = workout.date;

  box.append(el('div', { className: 'wk-head' },
    el('div', {
      className: 'wk-crumbs',
      textContent: `${weekCrumb(workout)}${workout.dayCode} · ${weekdayShort(d)} ${dm(d)}`
        + (workout.movedFrom ? ` · перенос с ${dm(workout.movedFrom)}` : ''),
    }),
    el('h2', { textContent: workout.title || workout.dayCode })));

  // Начатая сессия открывается отсюда прыжком на нужное упражнение: вернуться
  // дописать забытое значило пролистать стрелкой весь день. До выбора режима
  // прыгать некуда — там это просто список.
  //
  // Тот же список — конструктор сессии (решения атлета 05.11): порядок в зале
  // часто расходится с планом, и запись должна показывать, что и в каком
  // порядке сделано. Строка перетаскивается за ручку ≡, свайп вправо убирает
  // упражнение без подходов. Работает, когда запись заведена: после выбора
  // режима, а у закрытой тренировки — всегда. До выбора режима план смотрят
  // бесплатно, и правка создала бы запись побочно.
  const built = Boolean(workout.fillMode) || workout.status === 'done';
  // Всё убрано: упражнений нет, и вести «к заполнению» некуда — экран
  // «Пока пусто» строки «убрано» не знает. Обзор остаётся экраном сессии,
  // а список убранного открыт сразу.
  const allRemoved = !workout.exercises.length && (workout.removed || []).length > 0;

  // Перед уходом с обзора плашка снимается: она про этот экран.
  const leave = () => {
    clearTimeout(state.undoTimer);
    state.undoBar = null;
    state.undoTimer = null;
  };

  // Правка с откатом: не сохранилось — запись возвращается к снимку, экран
  // не перерисовывается и показывает прежний порядок рядом с ошибкой `save`.
  const commit = async (change) => {
    const snap = snapshotOrder(workout);
    const cur = workout.exercises[state.index];
    change();
    if (!(await save(box))) {
      restoreOrder(workout, snap);
      return false;
    }
    // Открытое упражнение остаётся тем же, на каком бы месте оно ни оказалось.
    const at = workout.exercises.indexOf(cur);
    state.index = at >= 0 ? at : Math.max(0, Math.min(state.index, workout.exercises.length - 1));
    return true;
  };

  // Плашка одна на экран: новая заменяет прежнюю и живёт свои 5 с.
  const showBar = (text, undo) => {
    clearTimeout(state.undoTimer);
    state.undoBar = { text, undo };
    state.undoTimer = setTimeout(() => {
      state.undoBar = null;
      state.undoTimer = null;
      const bar = box.querySelector('.undo-bar');
      if (bar) bar.remove();
    }, UNDO_MS);
  };

  const rowEls = [];
  let drag = null;

  // Свайп вправо по строке. Вертикаль, выбранная первой, — скролл браузера
  // (`touch-action: pan-y`), строка его не трогает. Сдвинутое касание
  // переходом к упражнению не кончается.
  const wireSwipe = (row, i) => {
    let g = null;
    row.addEventListener('pointerdown', (e) => {
      row.moved = false;
      if (drag) return;
      g = { x: e.clientX, y: e.clientY, axis: null };
    });
    row.addEventListener('pointermove', (e) => {
      if (!g || drag) return;
      const dx = e.clientX - g.x;
      if (!g.axis) g.axis = gestureAxis(dx, e.clientY - g.y);
      if (g.axis) row.moved = true;
      if (g.axis === 'x') row.style.transform = `translateX(${Math.max(0, dx)}px)`;
    });
    const end = async (e, cancelled) => {
      if (!g || drag) return;
      const cur = g;
      g = null;
      row.style.transform = '';
      if (cancelled) return;
      const ex = workout.exercises[i];
      const { verdict, sets } = swipeVerdict({
        axis: cur.axis,
        dx: e.clientX - cur.x,
        width: row.getBoundingClientRect().width,
        sets: (ex.sets || []).length,
      });
      if (verdict === 'blocked') {
        showBar(`сначала сотри подходы: ${sets}`, null);
        await draw(box);
        return;
      }
      if (verdict !== 'remove') return;
      let gone = null;
      if (!(await commit(() => { gone = removeExercise(workout, i); }))) return;
      // Плановое возвращается на своё плановое место, внеплановое — на прежнее.
      showBar(`Убрано: ${doneName(gone.ex)}`, () => (gone.outcome === 'removed'
        ? restoreRemoved(workout, gone.ex)
        : undoDelete(workout, gone)));
      await draw(box);
    };
    row.addEventListener('pointerup', (e) => end(e, false));
    row.addEventListener('pointercancel', (e) => end(e, true));
  };

  // Перетаскивание за ручку: место сброса — по серединам строк, снятым
  // в момент касания.
  const wireDrag = (handle, row, i) => {
    handle.addEventListener('pointerdown', (e) => {
      if (e.stopPropagation) e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      drag = { from: i, y: e.clientY, rects: rowEls.map((r) => r.getBoundingClientRect()) };
      row.classList.add('dragging');
    });
    handle.addEventListener('pointermove', (e) => {
      if (drag) row.style.transform = `translateY(${e.clientY - drag.y}px)`;
    });
    const end = async (e, cancelled) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      handle.releasePointerCapture(e.pointerId);
      row.moved = true;
      row.classList.remove('dragging');
      row.style.transform = '';
      if (cancelled) return;
      const to = dropIndex(d.rects, d.from, e.clientY);
      if (to === d.from) return;
      if (await commit(() => { moveExercise(workout, d.from, to); })) await draw(box);
    };
    handle.addEventListener('pointerup', (e) => end(e, false));
    handle.addEventListener('pointercancel', (e) => end(e, true));
  };

  const list = el('ol', { className: built ? 'plan-list overview constructor' : 'plan-list overview' });
  workout.exercises.forEach((e, i) => {
    const p = workout.prescription[i] || {};
    const sets = (e.sets || []).filter((x) => !x.warmup).length;
    const dose = el('span', {
      className: 'plan-dose',
      textContent: listDose(p, e),
    });
    const name = el('span', { className: 'plan-name', textContent: doneName(e) });
    const mark = e.skipped ? 'пропуск' : (sets ? `${sets} из ${p.sets || '—'}` : '');
    if (!built) {
      list.append(el('li', { className: sets || e.skipped ? 'done' : '' },
        el('div', { className: 'plan-row' }, name, dose)));
      return;
    }
    const handle = el('span', { className: 'plan-handle', textContent: '≡' });
    const row = el('button', {
      className: 'plan-row',
      onclick: () => {
        if (row.moved) { row.moved = false; return null; }
        leave();
        state.showOverview = false;
        return goTo(box, i);
      },
    }, name, dose, mark ? el('span', { className: 'plan-mark', textContent: mark }) : null, handle);
    rowEls.push(row);
    wireSwipe(row, i);
    wireDrag(handle, row, i);
    list.append(el('li', { className: sets || e.skipped ? 'done' : '' }, row));
  });
  box.append(list);

  if (state.undoBar) {
    const { text, undo } = state.undoBar;
    box.append(el('div', { className: 'undo-bar' },
      el('span', { textContent: text }),
      undo ? el('button', {
        className: 'undo-go', textContent: 'вернуть',
        onclick: async () => {
          if (!(await commit(undo))) return;
          leave();
          await draw(box);
        },
      }) : null));
  }

  if (built) {
    // Новое встаёт в конец, место задаётся перетаскиванием.
    box.append(el('button', {
      className: 'insert-here plan-add', textContent: '+ упражнение',
      onclick: () => { state.insertAt = workout.exercises.length; return draw(box); },
    }));
    if (state.insertAt != null) box.append(exercisePicker(box, ctx));

    // Убранное плановое видно только здесь — одной приглушённой строкой.
    const removed = workout.removed || [];
    if (removed.length) {
      box.append(el('button', {
        className: 'removed-strip', textContent: `убрано: ${removed.length} ›`,
        onclick: () => { state.showRemoved = !state.showRemoved; return draw(box); },
      }));
      if (state.showRemoved || allRemoved) {
        const card = el('div', { className: 'group-card removed-list' });
        for (const r of removed) {
          card.append(el('button', {
            className: 'group-row',
            onclick: async () => {
              if (await commit(() => { restoreRemoved(workout, r.ex); })) await draw(box);
            },
          },
          el('span', { className: 'row-title', textContent: doneName(r.ex) }),
          el('span', { className: 'row-value', textContent: 'вернуть' })));
        }
        box.append(card);
      }
    }
  }

  if (state.stretch) {
    box.append(el('p', { className: 'hint', textContent:
      `Хвостом сессии — растяжка, ${state.stretch.positions.length} позиций.` }));
  }

  if (workout.fillMode && !allRemoved) {
    box.append(el('button', {
      className: 'go',
      textContent: 'продолжить заполнение →',
      onclick: () => { leave(); state.showOverview = false; return draw(box); },
    }));
  }

  box.append(el('div', { className: 'group-cap', textContent: 'как заполняешь' }));
  const card = el('div', { className: 'group-card' });
  const pick = (title, hint, mode) => el('button', {
    className: 'group-row',
    onclick: async (e) => {
      // Двойной тап заводил две записи: `id` присваивается только после
      // `await putWorkout`, и второй вызов уходил с объектом без него.
      const btn = e && e.target;
      if (btn && btn.disabled) return;
      if (btn) btn.disabled = true;
      workout.fillMode = mode;
      state.showOverview = false;
      if (!(await save(box))) return;
      // Дату могли сменить прямо здесь — тогда экран открывается заново
      // на новой дате, иначе адрес и запись разъедутся.
      if (workout.date !== state.paramDate) {
        const kind = workout.kind;
        const to = workout.date;
        stopTimer();
        ctx.drop();
        navigate('workout', { date: to, kind, code: workout.dayCode });
        return;
      }
      state.index = 0;
      await draw(box);
    },
  },
  el('span', { className: 'row-title', textContent: title }),
  el('span', { className: 'row-value', textContent: hint }),
  el('span', { className: 'chev' }));

  card.append(pick('Заполняю сейчас', 'секундомер, отдых по меткам', 'live'));
  card.append(pick('Заполняю потом', 'без секундомера, отдых руками', 'later'));
  box.append(card);

  // Перенос — это просто другая дата у этой же тренировки. Режим он не
  // выбирает: можно прийти второго и провести тренировку за первое,
  // с секундомером и по меткам времени.
  box.append(el('div', { className: 'group-cap', textContent: 'дата тренировки' }));
  const dateIn = el('input', { type: 'date', value: workout.date, className: 'move-date' });
  dateIn.onchange = async () => {
    const v = dateIn.value;
    if (!v || v === workout.date) return;

    // На новой дате уже может лежать эта же сессия. Вторая запись с тем же
    // ключом не создаёт конфликта на экране, но `findWorkout` отдаёт черновик
    // раньше закрытой, и закрытая тренировка становится недоступна навсегда.
    const clash = await findWorkout(v, workout.kind, workout.dayCode);
    if (clash && clash.id !== workout.id) {
      dateIn.value = workout.date;
      const box2 = el('div', { className: 'error' },
        el('p', {
          textContent: `На ${dm(v)} уже есть ${workout.dayCode}`
            + ` (${clash.status === 'done' ? 'записана' : 'черновик'}).`
            + ' Открой её и удали, если она лишняя.',
        }));
      // Обмен живёт здесь, потому что закрытой сессии карточки на вкладке дня
      // нет вовсе (`EDITABLE` не держит зал и навык), а перенести её можно
      // только отсюда. Меняться есть чему, лишь когда обе записи в базе.
      if (workout.id != null) {
        box2.append(el('button', {
          className: 'go ghost', textContent: 'поменять местами',
          onclick: async (e) => {
            const btn = e && e.target;
            if (btn && btn.disabled) return;
            if (btn) btn.disabled = true;
            try {
              await persistStretch();
              await swapSessions(workout, clash);
            } catch (err) {
              if (btn) btn.disabled = false;
              box.prepend(el('div', { className: 'error', textContent: 'Не обменялись: ' + err.message }));
              return;
            }
            const to = workout.date;
            const kind = workout.kind;
            const code = workout.dayCode;
            stopTimer();
            ctx.drop();
            navigate('workout', { date: to, kind, code });
          },
        }));
      }
      box.prepend(box2);
      return;
    }

    // Отметки растяжки принадлежат прежнему дню. Сохранить их надо до смены
    // даты: `persistStretch` пишет в `state.workout.date`, и после смены они
    // уехали бы в новый день — растяжка, которой там не было, появлялась
    // из ниоткуда, а недельная доза удержаний завышалась.
    try {
      await persistStretch();
    } catch (err) {
      box.prepend(el('div', { className: 'error', textContent: 'Блок растяжки не сохранён: ' + err.message }));
      return;
    }

    // Правило переноса одно на оба экрана и живёт в `session-move.js`.
    applyMove(workout, v);
    if (workout.id != null && !(await save(box))) return;

    // Состояние, привязанное к дню, пересобирается целиком: блок растяжки,
    // отметки, секунды, неделя и признак домашней сессии были снимком старой
    // даты, а `state` при смене даты не пересоздаётся — navigate не делается.
    const [planNow, dayRaw, weekRaw, allW] = await Promise.all([
      getPlan(v), getDay(v), getWeek(isoWeek(v)), listWorkouts(),
    ]);
    const mob = sessionFor(planNow, v, 'mobility');
    state.stretch = mob ? mob.session : null;
    state.extras = extraSteps(state.stretch);
    state.day = dayRaw || { date: v };
    state.week = weekRaw || { id: isoWeek(v) };
    state.marks = { ...(state.day.stretch || {}) };
    state.secs = { ...(state.day.stretchSec || {}) };
    state.homeDone = allW.some(
      (w) => w.date === v && w.kind === 'home' && w.status === 'done');
    state.index = Math.min(state.index, workout.exercises.length + state.extras.length - 1);
    if (state.index < 0) state.index = 0;

    await draw(box);
  };
  box.append(el('div', { className: 'move-row' }, dateIn));
  box.append(el('p', {
    className: 'hint',
    textContent: workout.movedFrom
      ? `По плану это ${dm(workout.movedFrom)} — плановая дата сохранится в записи.`
      : 'Поменяй, если делаешь эту тренировку в другой день. Режим выбирается выше.',
  }));

  // Отмена: заглянул посмотреть — уходишь без следа. Пустой черновик,
  // заведённый прошлой версией, при этом удаляется.
  box.append(el('button', {
    className: 'back', textContent: '← не заполняю, просто смотрел',
    onclick: async () => {
      stopTimer();
      const w = workout;
      const empty = (w.exercises || []).every((e) => !(e.sets || []).length && !e.skipped);
      if (w.id != null && w.status === 'draft' && empty) {
        try { await delWorkout(w.id); } catch { /* не удалилось — не беда */ }
      }
      ctx.drop();
      navigate('workout', {});
    },
  }));
}

/**
 * Выбор упражнения вне плана. Имя берётся из справочника, а не набирается:
 * своды объёма и цели ключуются по имени, и опечатка тихо выносит упражнение
 * из аналитики. Свободный ввод остаётся запасным путём.
 */
export function exercisePicker(box, ctx, { onPick = null, cap = null, exclude = null } = {}) {
  const { state, draw, save } = ctx;
  const { workout, guide } = state;
  const wrap = el('div', { className: 'picker' });
  const at = state.insertAt;
  // Замена (`onPick`) выбирает из всего справочника, кроме самого упражнения;
  // вставка — из того, чего в сессии ещё нет.
  const have = onPick ? new Set([exclude]) : new Set(workout.exercises.map((e) => e.name));
  // Долги первыми — почему именно так, сказано у `debtNames`.
  const debts = state.debts || new Set();
  const names = [...guide.keys()].filter((n) => !have.has(n)).sort((a, b) => {
    const d = Number(debts.has(b)) - Number(debts.has(a));
    return d || a.localeCompare(b, 'ru');
  });

  const search = el('input', { type: 'search', placeholder: 'упражнение', className: 'picker-search' });
  const list = el('div', { className: 'group-card picker-list' });

  const add = async (name) => {
    if (onPick) return onPick(name);
    const i = insertExercise(workout, at, name);
    if (!(await save(box))) {
      workout.exercises.splice(i, 1);
      workout.prescription.splice(i, 1);
      return;
    }
    state.insertAt = null;
    state.showPlan = false;
    state.index = i;
    return draw(box);
  };

  const typed = () => String(search.value || '').trim();
  const fill = () => {
    list.innerHTML = '';
    const raw = typed();
    const q = raw.toLowerCase();
    const hits = (q ? names.filter((n) => n.toLowerCase().includes(q)) : names).slice(0, 12);
    for (const n of hits) {
      list.append(el('button', { className: 'group-row', onclick: () => add(n) },
        el('span', { className: 'row-title', textContent: n }),
        debts.has(n) ? el('span', { className: 'row-value debt', textContent: 'долг' }) : null,
        el('span', { className: 'chev' })));
    }
    // Свободный ввод — запасной путь: имя не совпадёт со справочником,
    // и упражнение выпадет из сводов по объёму и из целей.
    if (raw && !hits.includes(raw)) {
      list.append(el('button', {
        className: 'group-row free', onclick: () => add(raw),
      },
      el('span', { className: 'row-title', textContent: `записать как есть: «${raw}»` }),
      el('span', { className: 'row-value', textContent: 'без эталона' })));
    }
  };
  search.oninput = fill;
  fill();

  wrap.append(el('div', {
    className: 'group-cap', textContent: cap || `упражнение вне плана · позиция ${at + 1}`,
  }));
  wrap.append(search, list);
  // У замены своя «отмена» — в форме под списком.
  if (!onPick) {
    wrap.append(el('button', {
      className: 'back', textContent: 'отмена',
      onclick: () => { state.insertAt = null; return draw(box); },
    }));
  }
  return wrap;
}
