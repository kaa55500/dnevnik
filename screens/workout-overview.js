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
  TRASH_W, settleMoved, undoRemove, draftEdits, takePair,
} from './workout-logic.js';
import { applyMove, swapSessions } from './session-move.js';
import { navigate } from '../main.js';

/** Корзина: крышка с ручкой, бак с двумя прорезями — линиями, как иконки «Ещё». */
function trashIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'trash-ico');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M3.5 6.5h17M9 6.5V4.2c0-.4.3-.7.7-.7h4.6c.4 0 .7.3.7.7v2.3'
    + 'M5.8 6.5l1 13.1c.1.8.7 1.4 1.5 1.4h7.4c.8 0 1.4-.6 1.5-1.4l1-13.1M10 10.5v6.5M14 10.5v6.5');
  svg.append(path);
  return svg;
}

/** Сколько живёт плашка «Убрано: X · вернуть». */
const UNDO_MS = 5000;

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

/**
 * Весь план сессии: список-конструктор, дата тренировки и выход.
 *
 * До 05.11 здесь стояла развилка «заполняю сейчас / потом», и её обходили:
 * 20 из 20 сессий в бэкапе 05.11 заведены «потом», хотя вносились в зале.
 * Теперь режим решает дата (`sessionMode`), а случай 01.09 — сегодняшняя
 * тренировка, внесённая целиком после зала, — закрывает окно отдыха
 * `restForSet`: записи пачкой отдыха не получают.
 */
export async function drawOverview(box, ctx) {
  const {
    state, draw, goTo, save, persistStretch, weekCrumb, extraSteps,
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

  // Сессия открывается отсюда прыжком на нужное упражнение: вернуться
  // дописать забытое значило пролистать стрелкой весь день.
  //
  // Тот же список — конструктор сессии (решения атлета 05.11): порядок в зале
  // часто расходится с планом, и запись должна показывать, что и в каком
  // порядке сделано. Строка перетаскивается за ручку ≡, свайп влево открывает
  // корзину для упражнения без подходов. Работает всегда: правка — намеренное
  // действие, и незаведённую запись заводит она. Просмотр без действий
  // записи не заводит.
  // Всё убрано: упражнений нет, и вести «к заполнению» некуда — экран
  // «Пока пусто» строки «убрано» не знает. Обзор остаётся экраном сессии,
  // а сноска с убранным и так внизу.
  const allRemoved = !workout.exercises.length && (workout.removed || []).length > 0;
  // Отметки «перетащено» сверяются с планом при каждом показе: запись могла
  // пережить версию, где возврат на место отметку не снимал. В базу уйдёт
  // со следующей правкой.
  settleMoved(workout);

  // Открытая корзина — только у строки, что ещё в списке и без подходов:
  // после ухода и записи подхода она висела бы под строкой с подходом.
  if (state.openRow && (!workout.exercises.includes(state.openRow)
      || (state.openRow.sets || []).length)) state.openRow = null;

  // Перед уходом с обзора плашка снимается и корзина закрывается: они про этот экран.
  const leave = () => {
    clearTimeout(state.undoTimer);
    state.undoBar = null;
    state.undoTimer = null;
    state.openRow = null;
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

  // Плашка одна на экран: новая заменяет прежнюю и живёт свои 5 с. Подсказка
  // без «вернуть» не затирает плашку с «вернуть» (решение атлета 05.11):
  // удалённое внеплановое иначе терялось бы от случайного свайпа.
  const showBar = (text, undo) => {
    if (!undo && state.undoBar && state.undoBar.undo) return false;
    clearTimeout(state.undoTimer);
    state.undoBar = { text, undo };
    state.undoTimer = setTimeout(() => {
      state.undoBar = null;
      state.undoTimer = null;
      const bar = box.querySelector('.undo-bar');
      if (bar) bar.remove();
    }, UNDO_MS);
    return true;
  };

  const rowEls = [];
  let drag = null;

  // Свайп влево открывает красную корзину под строкой, как в Telegram
  // (решение атлета 05.11); убирает касание корзины. Открыта одна строка
  // за раз. Вертикаль, выбранная первой, — скролл браузера (`touch-action:
  // pan-y`), строка его не трогает. Сдвинутое касание переходом не кончается.
  // Корзина видна, только пока строка сдвинута: иначе она просвечивала бы
  // из-под строки при перетаскивании и по скруглённым краям.
  const setOffset = (row, x, reveal = true) => {
    row.style.transform = x ? `translateX(${x}px)` : '';
    clearTimeout(row.hideBin);
    if (x && reveal) row.cell.classList.add('reveal');
    else row.hideBin = setTimeout(() => row.cell.classList.remove('reveal'), 160);
  };
  const closeOpen = () => {
    const open = rowEls.find((r) => r.ex === state.openRow);
    state.openRow = null;
    if (open) setOffset(open, 0);
  };
  // Строка с подходами корзины не даёт: тянется на пару пальцев и упирается,
  // красное под ней не показывается.
  const BLOCKED_PULL = 24;
  const wireSwipe = (row, i) => {
    let g = null;
    row.addEventListener('pointerdown', (e) => {
      row.moved = false;
      if (drag) return;
      g = { x: e.clientX, y: e.clientY, axis: null, open: state.openRow === row.ex };
    });
    row.addEventListener('pointermove', (e) => {
      if (!g || drag) return;
      const dx = e.clientX - g.x;
      if (!g.axis) g.axis = gestureAxis(dx, e.clientY - g.y);
      if (g.axis) row.moved = true;
      if (g.axis === 'x') {
        // Во время свайпа строка идёт за пальцем без анимации.
        row.classList.add('swiping');
        if ((row.ex.sets || []).length) {
          setOffset(row, Math.max(-BLOCKED_PULL, Math.min(0, dx) / 3), false);
          return;
        }
        // Дальше кнопки строка тянется вполсилы — упирается, как в Telegram.
        const at = Math.min(0, (g.open ? -TRASH_W : 0) + dx);
        setOffset(row, at < -TRASH_W ? -TRASH_W + (at + TRASH_W) / 2 : at);
      }
    });
    const end = (e, cancelled) => {
      if (!g || drag) return;
      const cur = g;
      g = null;
      row.classList.remove('swiping');
      const ex = workout.exercises[i];
      const { verdict, sets } = cancelled ? { verdict: cur.open ? 'open' : 'close' } : swipeVerdict({
        axis: cur.axis, dx: e.clientX - cur.x, open: cur.open, sets: (ex.sets || []).length,
      });
      if (verdict === 'open') {
        if (state.openRow !== ex) closeOpen();
        state.openRow = ex;
        setOffset(row, -TRASH_W);
        return;
      }
      setOffset(row, 0);
      if (state.openRow === ex) state.openRow = null;
      if (verdict === 'blocked' && showBar(`сначала сотри подходы: ${sets}`, null)) draw(box);
    };
    row.addEventListener('pointerup', (e) => end(e, false));
    row.addEventListener('pointercancel', (e) => end(e, true));
  };

  // Корзина: плановое уходит в «убрано», внеплановое удаляется насовсем.
  // Упражнение берётся по строке, а не по индексу: при двойном касании второе
  // его уже не находит (уборка синхронна, до сохранения) — а по индексу
  // убирался сосед. Под строкой успел появиться подход — корзина закрывается.
  const trash = (row) => async () => {
    const i = workout.exercises.indexOf(row.ex);
    if (i < 0 || (row.ex.sets || []).length) { closeOpen(); return; }
    state.openRow = null;
    let gone = null;
    const ok = await commit(() => { gone = removeExercise(workout, i); });
    // Не сохранилось — строка закрывается, ошибка `save` остаётся на экране.
    if (!ok) { setOffset(row, 0); return; }
    // Плашка — отмена: упражнение встаёт туда, где было (решение атлета 05.11).
    showBar(`Убрано: ${doneName(gone.ex)}`, () => (gone.outcome === 'removed'
      ? undoRemove(workout, gone)
      : undoDelete(workout, gone)));
    await draw(box);
  };

  // Перетаскивание за ручку. Что начинается с ручки, решает первое движение
  // пальца: вверх-вниз — перетаскивание, вбок — свайп строки (правый большой
  // палец начинает свайп как раз у ручки). Место сброса — по серединам строк,
  // снятым в момент начала перетаскивания.
  const wireDrag = (handle, row, i) => {
    let hd = null;
    handle.addEventListener('pointerdown', (e) => {
      if (drag) return;
      hd = { x: e.clientX, y: e.clientY, id: e.pointerId };
    });
    handle.addEventListener('pointermove', (e) => {
      if (!hd) return;
      if (!drag) {
        const axis = gestureAxis(e.clientX - hd.x, e.clientY - hd.y);
        if (!axis) return;
        if (axis === 'x') { hd = null; return; }
        closeOpen();
        handle.setPointerCapture(hd.id);
        drag = { from: i, y: hd.y, rects: rowEls.map((r) => r.getBoundingClientRect()) };
        row.classList.add('dragging');
        row.cell.classList.add('drag-cell');
      }
      row.style.transform = `translateY(${e.clientY - drag.y}px)`;
    });
    const end = async (e, cancelled) => {
      hd = null;
      if (!drag) return;
      const d = drag;
      drag = null;
      handle.releasePointerCapture(e.pointerId);
      row.moved = true;
      row.classList.remove('dragging');
      row.cell.classList.remove('drag-cell');
      row.style.transform = '';
      if (cancelled) return;
      const to = dropIndex(d.rects, d.from, e.clientY);
      if (to === d.from) return;
      if (await commit(() => { moveExercise(workout, d.from, to); })) await draw(box);
    };
    handle.addEventListener('pointerup', (e) => end(e, false));
    handle.addEventListener('pointercancel', (e) => end(e, true));
  };

  const list = el('ol', { className: 'plan-list overview constructor' });
  workout.exercises.forEach((e, i) => {
    const p = workout.prescription[i] || {};
    const sets = (e.sets || []).filter((x) => !x.warmup).length;
    const dose = el('span', {
      className: 'plan-dose',
      textContent: listDose(p, e),
    });
    const name = el('span', { className: 'plan-name', textContent: doneName(e) });
    const mark = e.skipped ? 'пропуск' : (sets ? `${sets} из ${p.sets || '—'}` : '');
    const handle = el('span', { className: 'plan-handle', textContent: '≡' });
    const row = el('button', {
      className: 'plan-row',
      onclick: () => {
        if (row.moved) { row.moved = false; return null; }
        // Касание открытой строки (или любой, пока открыта другая) закрывает корзину.
        if (state.openRow) { closeOpen(); return null; }
        leave();
        state.showOverview = false;
        return goTo(box, i);
      },
    }, name, dose, mark ? el('span', { className: 'plan-mark', textContent: mark }) : null, handle);
    row.ex = e;
    rowEls.push(row);
    wireSwipe(row, i);
    wireDrag(handle, row, i);
    const bin = el('button', {
      className: 'row-trash', type: 'button', ariaLabel: 'убрать', onclick: trash(row),
    }, trashIcon(), el('span', { textContent: 'убрать' }));
    // Перетащенное обведено тонким светящимся контуром — порядок правился руками.
    const cls = [sets || e.skipped ? 'done' : '', 'swipe-cell', e.moved ? 'moved' : ''].filter(Boolean).join(' ');
    row.cell = el('li', { className: cls }, bin, row);
    if (state.openRow === e) setOffset(row, -TRASH_W);
    list.append(row.cell);
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

  // Новое встаёт в конец, место задаётся перетаскиванием.
  box.append(el('button', {
    className: 'insert-here plan-add', textContent: '+ упражнение',
    onclick: () => { state.insertAt = workout.exercises.length; return draw(box); },
  }));
  if (state.insertAt != null) box.append(exercisePicker(box, ctx));

  // Убранное плановое — сноской под списком (решения атлета 05.11): свёрнута
  // в «убрано · N ›», касание раскрывает имена с «вернуть». Когда убрано всё,
  // раскрыта сразу — возвращать больше неоткуда. Внеплановое удаляется
  // насовсем и сюда не попадает — вернуть его можно только плашкой.
  const removed = workout.removed || [];
  if (removed.length) {
    const open = state.showRemoved || allRemoved;
    const note = el('div', { className: 'removed-note' },
      el('button', {
        className: 'removed-cap', type: 'button',
        textContent: `убрано · ${removed.length} ${open ? '⌄' : '›'}`,
        // Когда убрано всё, сноска раскрыта и сворачивать её некуда.
        onclick: allRemoved ? null
          : () => { state.showRemoved = !state.showRemoved; return draw(box); },
      }));
    if (open) {
      for (const r of removed) {
        note.append(el('button', {
          className: 'removed-row',
          onclick: async () => {
            if (await commit(() => { restoreRemoved(workout, r.ex); })) await draw(box);
          },
        },
        el('span', { className: 'removed-name', textContent: doneName(r.ex) }),
        el('span', { className: 'removed-go', textContent: 'вернуть' })));
      }
    }
    box.append(note);
  }

  // Растяжка хвостом — строкой плана с прыжком (замечание атлета 06.11):
  // сделал два упражнения и иду тянуться — раньше к ней листали «дальше».
  // Строка не перетаскивается и не убирается: блок обязателен.
  if (state.stretch && (state.extras || []).length) {
    const n = state.stretch.positions.length;
    const marked = Object.values(state.marks || {}).filter(Boolean).length;
    box.append(el('ol', { className: 'plan-list overview stretch-tail' },
      el('li', { className: marked >= n ? 'done' : '' },
        el('button', {
          className: 'plan-row',
          onclick: () => {
            leave();
            state.showOverview = false;
            return goTo(box, workout.exercises.length);
          },
        },
        el('span', { className: 'plan-name', textContent: 'Растяжка' }),
        el('span', { className: 'plan-dose', textContent: `${n} позиций` }),
        marked ? el('span', { className: 'plan-mark', textContent: `${marked} из ${n}` }) : null))));
  }

  // К упражнениям — с того места, где бросил (`firstOpen` при открытии);
  // всё убрано — вести некуда, экран «Пока пусто» строки «убрано» не знает.
  if (!allRemoved) {
    box.append(el('button', {
      className: 'go',
      textContent: workout.id != null ? 'продолжить заполнение →' : 'к упражнениям →',
      onclick: () => { leave(); state.showOverview = false; return draw(box); },
    }));
  }

  // Перенос — это просто другая дата у этой же тренировки. Режим по ходу
  // идёт за датой: перенесённая на сегодня сессия ведётся по меткам времени.
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
    // Смена даты — правка, и незаведённую запись заводит она, как конструктор.
    if (!(await save(box))) return;

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
      : 'Поменяй, если делаешь эту тренировку в другой день.',
  }));

  // Отмена: заглянул посмотреть — уходишь без следа. Пустой черновик,
  // заведённый прошлой версией, при этом удаляется.
  box.append(el('button', {
    className: 'back', textContent: '← не заполняю, просто смотрел',
    onclick: async () => {
      const w = workout;
      const empty = (w.exercises || []).every((e) => !(e.sets || []).length && !e.skipped);
      // Правки конструктора без подходов — тоже работа: молча не удаляются
      // (решение атлета 05.11). «Отмена» — выйти, черновик остаётся. Спрашивает
      // только когда удаление вообще возможно: с подходами и у закрытой — просто выход.
      if (w.id != null && w.status === 'draft' && empty) {
        const edits = draftEdits(w);
        const drop = !edits.length || confirm(`В черновике правки: ${edits.join(', ')}.`
          + ' Удалить черновик? «Отмена» — выйти, черновик останется.');
        if (drop) {
          try { await delWorkout(w.id); } catch { /* не удалилось — не беда */ }
        }
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
      takePair(workout, i);
      return;
    }
    state.insertAt = null;
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
