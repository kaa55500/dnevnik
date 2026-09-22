import {
  getDay, putDay, getWeek, putWeek, getPlan, getSettings, listWorkouts, putWorkout, findWorkout, listDays, listWeeks,
  listPlans,
} from '../store.js';
import { sessionsFor, weekOf, sessionDates, planRange } from '../plan.js';
import { plannedSeconds, applySplit } from './stretch-block.js';
import { CARDIO_TYPES } from './workout-logic.js';
import { todayISO, weekdayShort, isoWeek, addDays, dm, fromISO } from '../lib/dates.js';
import { parseNum } from '../lib/format.js';
import { pendingTasks, closedTasks, debts, skipKeyOf, skipScopeOf, SIGNALS, signalsFor } from './day-logic.js';
import { makeUnplannedWorkout, KIND_TITLE } from './workout-logic.js';
import { dayRecord } from './journal-logic.js';
import { renderRecord } from './record-view.js';
import { backupNote } from './backup-note.js';
import { moveSession, swapSessions } from './session-move.js';
import { navigate } from '../main.js';


export function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

export function field(label, key, obj, step = 'any') {
  const input = el('input', {
    type: 'number', step, inputMode: 'decimal', value: obj[key] ?? '',
  });
  input.dataset.key = key;
  return el('label', {}, label, input);
}

function checkbox(label, key, obj) {
  const input = el('input', { type: 'checkbox', checked: Boolean(obj[key]) });
  input.dataset.key = key;
  input.dataset.bool = '1';
  return el('label', { className: 'check' }, input, ' ' + label);
}

export function collect(form, target) {
  for (const input of form.querySelectorAll('[data-key]')) {
    const k = input.dataset.key;
    target[k] = input.dataset.bool ? input.checked : parseNum(input.value);
  }
  return target;
}

/**
 * Перенос сессии на другую дату. Ловится он именно здесь: на вкладке дня
 * висит тренировка, которую сделал не в свой день, и до 07.09 единственная
 * дата жила внутри экрана заполнения — в обзоре сессии, куда за переносом
 * никто не заходит. Плановая дата сохраняется в записи, иначе сверка
 * «план против факта» считает перенесённую тренировку пропущенной.
 */
function moveBlock(box, date, kind, code) {
  const wrap = el('details', { className: 'move-session' });
  wrap.append(el('summary', { textContent: 'перенести на другую дату' }));
  const dateIn = el('input', { type: 'date', value: date, className: 'move-date' });
  const say = (node) => {
    const old = wrap.querySelector('.move-say');
    if (old) old.remove();
    node.classList.add('move-say');
    wrap.append(node);
  };
  const go = el('button', {
    className: 'go ghost', textContent: 'Перенести',
    onclick: async () => {
      const to = dateIn.value;
      if (!to || to === date) return;
      let r;
      try {
        r = await moveSession({ from: date, kind, code, to });
      } catch (err) {
        errorLine(box, err);
        return;
      }
      if (r.ok) {
        navigate('day', { date: to });
        return;
      }
      if (r.reason === 'no-plan') {
        say(el('p', { className: 'error', textContent: 'Этой сессии нет в плане дня.' }));
        return;
      }
      // Почему отказ, а не вторая запись, — в `session-move.js`.
      const dm = `${dm(to)}`;
      const block = el('div', { className: 'error' },
        el('p', {
          textContent: `На ${dm} уже есть ${code}`
            + ` (${r.clash.status === 'done' ? 'записана' : 'черновик'}).`,
        }),
        el('button', {
          className: 'go ghost', textContent: `открыть ${dm}`,
          onclick: () => navigate('day', { date: to }),
        }));
      // Обмен нужен ровно тогда, когда обе тренировки сделаны, но записаны
      // в чужие дни. Меняться нечему, пока эта сессия ещё не заведена.
      if (r.existing) {
        block.append(el('button', {
          className: 'go ghost', textContent: 'поменять местами',
          onclick: async () => {
            try {
              await swapSessions(r.existing, r.clash);
            } catch (err) {
              errorLine(box, err);
              return;
            }
            navigate('day', { date });
          },
        }));
      }
      say(block);
    },
  });
  wrap.append(el('div', { className: 'move-row' }, dateIn, go));
  return wrap;
}

function errorLine(box, err) {
  box.prepend(el('div', { className: 'error', textContent: 'Не сохранено: ' + err.message }));
}

export async function render(box, params = {}) {
  const date = params.date || todayISO();
  const today = todayISO();
  const backdated = date !== today;

  const [dayRaw, weekRaw, plan, settings, workouts, days, weeks, plans] = await Promise.all([
    getDay(date), getWeek(isoWeek(date)), getPlan(date), getSettings(),
    listWorkouts(), listDays(), listWeeks(), listPlans(),
  ]);
  const day = dayRaw || { date };
  const week = weekRaw || { id: isoWeek(date) };
  // Приехавшая переносом сессия становится задачей этого дня, а не строкой
  // в «Сделано»: долг переехал вместе с датой, и на новой дате он обязан
  // выглядеть долгом. Без этого список дел о ней не знал вовсе и мог
  // сказать «Всё закрыто» при незакрытой тренировке.
  const arrived = workouts.filter(
    (w) => w.date === date && w.movedFrom && w.movedFrom !== date);
  const planned = sessionsFor(plan, date).map((x) => x.session);
  const sessions = [...planned];
  for (const w of arrived) {
    const kind = w.kind || 'gym';
    if (planned.some((s) => s.kind === kind && (s.code || '') === (w.dayCode || ''))) continue;
    sessions.push({
      kind,
      code: w.dayCode || '',
      title: w.title || w.dayCode || KIND_TITLE[kind],
      exercises: w.prescription || w.exercises || [],
      movedFrom: w.movedFrom,
    });
  }
  const doneKinds = workouts
    .filter((w) => w.date === date && w.status === 'done')
    .map((w) => ({ kind: w.kind || 'gym', code: w.dayCode || '' }));
  // Сессии, уехавшие с этой даты на другую: план их здесь ждёт, а сделаны
  // они не здесь — долгом такое висеть не должно.
  // Считается и черновик: с 07.09 запись с плановой датой заводится только
  // явным «Перенести», а не открытием экрана — то есть дата у сессии сменена
  // осознанно, и на прежней она долгом висеть не должна. Долг при этом
  // не исчезает, а переезжает: на новой дате сессия ждёт незакрытой.
  const movedAway = workouts
    .filter((w) => w.movedFrom === date)
    .map((w) => ({
      kind: w.kind || 'gym', code: w.dayCode || '', date: w.date, status: w.status,
    }));

  // Пометка «задним числом» относится к дню, а не к неделе: у недельной
  // записи своей даты нет, и флаг там ничего не значил бы.
  const save = async (target, put) => {
    if (backdated && put === putDay) target.backdated = true;
    await put(target);
    await navigate('day', { date });
  };

  // ---------- Шапка с навигацией ----------
  const head = el('div', { className: 'day-head' });
  head.append(
    el('button', {
      className: 'nav-arrow', textContent: '←', title: 'предыдущий день',
      onclick: () => navigate('day', { date: addDays(date, -1) }),
    }),
    el('button', {
      className: 'day-title',
      textContent: `${weekdayShort(date)} ${dm(date)}`,
      onclick: () => navigate('calendar', { date }),
    }),
    el('button', {
      className: 'nav-arrow', textContent: '→', title: 'следующий день',
      // Вперёд — до конца цикла, а не до сегодня. Посмотреть вечером, что
      // завтра в зале, — обычное дело; запрет тут ничего не защищал,
      // а запись задним числом помечается отдельно и от этого не зависит.
      disabled: date >= (planRange(plan)?.to > today ? planRange(plan).to : today),
      onclick: () => navigate('day', { date: addDays(date, 1) }),
    }),
  );
  box.append(head);

  box.append(el('div', { className: 'day-links' },
    el('button', { className: 'link', textContent: 'календарь', onclick: () => navigate('calendar', { date }) }),
    el('button', { className: 'link', textContent: 'журнал', onclick: () => navigate('journal') })));

  // Долг по копии данных стоит выше всего остального: на этом экране
  // собирается день целиком, и терять его нечем, кроме бэкапа.
  const note = backupNote({
    lastBackup: settings.lastBackup,
    hasRecords: Boolean(workouts.length || days.length),
    today,
    onOpen: () => navigate('more', { section: 'data' }),
  });
  if (note) box.append(note);

  if (backdated) {
    box.append(el('div', {
      className: 'badge-back',
      textContent: date > today ? 'Будущий день' : 'Задним числом — записи помечаются',
    }));
    box.append(el('button', {
      className: 'today-link', textContent: 'вернуться к сегодня',
      onclick: () => navigate('day', { date: today }),
    }));
  }

  if (!plan) {
    box.append(el('p', { className: 'hint', textContent: 'Плана на эту дату нет.' }));
  }

  // ---------- Долги ----------
  // Даты берутся из всех циклов, а не только из текущего. 21.09 стартует Ц4,
  // и до заливки его плана `getPlan` на этой дате вернёт null: раньше вместе
  // с ним молча гас весь блок, и несданные вес и сон за Ц3 просто исчезали
  // с экрана — не закрытые, а невидимые.
  if (!backdated) {
    const allDates = plans.flatMap((p) => sessionDates(p));
    const owed = debts({ today, dates: [...new Set(allDates)].sort(), days, weeks });
    if (owed.length) {
      const card = el('section', { className: 'card debts' },
        el('h2', { textContent: `Не закрыто: ${owed.length}` }));
      // Заголовок и список обязаны сходиться. Раньше в шапке стояло 13,
      // а строк показывалось шесть — остальные семь пропадали молча.
      const HEAD = 3;
      const row = (o) => el('button', {
        className: 'debt-row',
        textContent: `${dm(o.date)} — ${o.title}`,
        onclick: () => navigate('day', { date: o.date }),
      });
      const fresh = [...owed].reverse();
      for (const o of fresh.slice(0, HEAD)) card.append(row(o));
      if (fresh.length > HEAD) {
        const rest = el('div', { className: 'debt-rest' });
        for (const o of fresh.slice(HEAD)) rest.append(row(o));
        rest.hidden = true;
        const more = el('button', {
          className: 'debt-more',
          textContent: `ещё ${fresh.length - HEAD} →`,
          onclick: () => {
            rest.hidden = !rest.hidden;
            more.textContent = rest.hidden ? `ещё ${fresh.length - HEAD} →` : 'свернуть';
          },
        });
        card.append(rest, more);
      }
      box.append(card);
    }
  }

  // Что уже записано в этот день — иначе закрытый день выглядит пустым
  // и посмотреть, что делал, негде.
  const rec = dayRecord(date, { days, workouts, weeks, plans: plan ? [plan] : [], settings });
  if (!rec.empty) {
    const card = el('section', { className: 'card done-card' },
      el('h2', { textContent: 'Сделано' }));
    card.append(renderRecord(rec, {
      onOpen: (kind, code) => navigate('workout', { date, kind, code }),
      // Правка открывается тут же, на экране дня: строка, которую читаешь,
      // должна править себя сама, а не отправлять искать форму заново.
      onEdit: (key) => navigate('day', { date, edit: key }),
    }));
    box.append(card);
  }

  const tasks = pendingTasks({ date, day, week, sessions, doneKinds, movedAway, settings });
  if (!tasks.length) {
    box.append(el('p', { className: 'done-all', textContent: 'Всё закрыто.' }));
  }

  /**
   * Кнопка «не делал». Прочерк — законный ответ: строка закрывается, долг
   * снимается, и «не бегал» перестаёт быть неотличимым от «забыл записать».
   */
  const skipButton = (t) => {
    const scope = skipScopeOf(t.key);
    const target = scope === 'week' ? week : day;
    const put = scope === 'week' ? putWeek : putDay;
    const key = skipKeyOf(t);
    return el('button', {
      className: 'skip-row' + (t.skipped ? ' on' : ''),
      textContent: t.skipped ? '✓ не делал — вернуть в работу' : 'не делал',
      onclick: async () => {
        const next = { ...(target.skipped || {}) };
        if (t.skipped) delete next[key];
        else next[key] = true;
        target.skipped = next;
        try {
          await save(target, put);
        } catch (err) {
          errorLine(box, err);
        }
      },
    });
  };

  const buildCard = (t) => {
    const card = el('section', { className: 'card' + (t.required ? ' req' : '')
      + (t.skipped ? ' skipped' : '') },
    el('h2', { textContent: t.title }));

    if (t.skipped) {
      card.append(el('p', { className: 'hint', textContent: 'Отмечено «не делал».' }));
      card.append(skipButton(t));
      // Прочерк поверх записанной цифры прятал её: вес оставался в базе
      // и печатался в журнале, а на экране дня его было не видно и не поправить.
      return card;
    }

    if (t.key === 'morning') {
      // Состав полей — ЦИКЛ-4.md §8 «Логируется»: остаётся то, на что смотрит
      // предохранитель или ворота. Самочувствие снято — его не читало ни одно
      // правило. Пульс покоя — только понедельник (справочно), АД — только
      // при сигнале «голова»: ежедневное давление — шум, а в день сигнала
      // строка обязательна (§9), поэтому поля появляются по самой галочке.
      const monday = fromISO(date).getDay() === 1;
      const bp = () => el('div', { className: 'grid bp' },
        field('давление верх', 'bpSys', day, '1'),
        field('давление низ', 'bpDia', day, '1'));
      const bpSlot = el('div', {}, (day.headache || day.bpSys != null) ? bp() : null);
      const form = el('div', { className: 'grid' },
        field('вес, кг', 'weight', day, '0.1'),
        field('сон, ч', 'sleepHours', day, '0.1'),
        field('качество сна 1–5', 'sleepQuality', day, '1'),
        monday ? field('пульс покоя', 'restingHR', day, '1') : null,
        checkbox('вакуум', 'vacuum', day),
      );
      for (const key of signalsFor(plan, settings)) {
        const box_ = checkbox(SIGNALS[key] || key, key, day);
        if (key === 'headache') {
          const input = box_.querySelector('input');
          input.onchange = () => {
            bpSlot.innerHTML = '';
            if (input.checked || day.bpSys != null) bpSlot.append(bp());
          };
        }
        form.append(box_);
      }
      form.append(bpSlot);
      card.append(form, el('button', {
        className: 'save', textContent: 'Сохранить',
        onclick: async () => {
          collect(form, day);
          try {
            await save(day, putDay);
          } catch (err) { errorLine(box, err); }
        },
      }));
    }

    if (t.key === 'gym' || t.key === 'home' || t.key === 'skill' || t.key === 'cardio') {
      const session = sessions.find((s) => s.kind === t.key);
      card.append(
        el('p', {
          textContent: `${session.code} · ${session.exercises.length} упражнений`,
        }),
        el('button', {
          className: 'go', textContent: 'Начать',
          onclick: () => navigate('workout', { date, kind: t.key, code: t.code }),
        }),
        // Код дня — из задачи, а не из первой сессии своего вида: на одной
        // дате лежат плановый В2 и приехавший Н1, и `find` по виду вернул бы
        // чужую. Кнопка «Начать» рядом берёт его оттуда же.
        moveBlock(box, date, t.key, t.code),
      );
    }

    if (t.key === 'mobility') {
      const session = sessions.find((s) => s.kind === 'mobility');
      card.append(
        // Минуты берутся из доз плана, а не прибиваются: прибитые 12/9 врали
        // на полторы-две минуты и разъехались бы при первой правке доз.
        el('p', {
          textContent: `${session.positions.length} позиций, ~${Math.round(
            session.positions.reduce((a, p) => a + (plannedSeconds(p.dose) || 0), 0) / 60
            + (session.positions.some((p) => p.n === 0) ? 2.5 : 0))} минут`,
        }),
        el('button', {
          className: 'go', textContent: 'Открыть блок',
          onclick: () => navigate('stretch', { date }),
        }),
      );
    }

    if (t.key === 'splitGap' || t.key === 'waist') {
      const key = t.key;
      const form = el('div', { className: 'grid' },
        field(key === 'waist' ? 'талия, см' : 'просвет, см', key, week, '0.5'));
      if (key === 'splitGap') {
        // Протокол замера живёт в плане, а не в коде: с Н3 блок стоит в конце
        // тренировки и разогрев в него не входит, до Н3 разогрев был частью
        // протокола. Две разные величины, и подпись должна это говорить.
        const mob = sessions.find((s) => s.kind === 'mobility');
        const hadHome = sessions.some((s) => s.kind === 'home');
        card.append(el('p', {
          className: 'hint',
          textContent: mob && mob.note ? mob.note : (hadHome
            ? 'Замер после блока. Домашняя сессия служит разогревом.'
            : 'Домашней сессии в плане нет — разогрев делается в полном виде.'),
        }));
      }
      card.append(form, el('button', {
        className: 'save', textContent: 'Сохранить',
        onclick: async () => {
          collect(form, week);
          if (key === 'splitGap') {
            // Через общий `applySplit`, а не своей копией: копия не снимала
            // старый `splitNoHome`, и в записи недели оставалась противоречивая
            // пара. Цифры до и после 31.08 несравнимы, и различает их только
            // эта метка — одна запись без протокола ломает весь ряд.
            const mob = sessions.find((s) => s.kind === 'mobility');
            applySplit(week, mob || {}, week.splitGap,
              doneKinds.some((x) => x.kind === 'home'));
          }
          try {
            await save(week, putWeek);
          } catch (err) { errorLine(box, err); }
        },
      }));
    }

    if (t.key === 'evening') {
      // TKE и МФР сняты 22.09 (ЦИКЛ-4.md §8): колено чисто с августа,
      // профилактика живёт в разминке и растяжке, галочки не читал никто.
      const form = el('div', { className: 'grid' },
        field('ходьба, км', 'walkKm', day, '0.1'),
      );
      card.append(form, cardioBlock(day, box, save), el('button', {
        className: 'save', textContent: 'Сохранить',
        onclick: async () => {
          collect(form, day);
          try {
            await save(day, putDay);
          } catch (err) { errorLine(box, err); }
        },
      }));
    }

    if (t.key === 'week') {
      card.append(
        el('p', { textContent: 'Ккал и белок за неделю, стойка, талия, шпагат.' }),
        el('button', {
          className: 'go', textContent: 'Открыть',
          // Раздел называется явно: без него «Ещё» открывалось корневым
          // экраном, и до замеров недели надо было тапать второй раз.
          onclick: () => navigate('more', { section: 'week', week: isoWeek(date) }),
        }),
      );
    }

    card.append(skipButton(t));
    return card;
  };

  for (const t of tasks) box.append(buildCard(t));

  // Уехавшая сессия не исчезает с плановой даты молча: видно, что она сделана
  // и где именно. Иначе день выглядит так, будто тренировки не было вовсе.
  if (movedAway.length) {
    const card = el('section', { className: 'card moved' },
      el('h2', { textContent: 'Перенесено' }));
    for (const m of movedAway) {
      const w = workouts.find((x) => x.movedFrom === date && (x.kind || 'gym') === m.kind);
      card.append(el('button', {
        className: 'group-row',
        onclick: () => navigate('day', { date: m.date }),
      },
      el('span', { className: 'row-title', textContent: w ? (w.dayCode || m.kind) : m.kind }),
      el('span', {
        className: 'row-value',
        // Перенесённая и уже сделанная — разные состояния: первое ждёт работы
        // на новой дате, второе закрыто. Одно слово на оба врало бы про факт.
        textContent: `${m.status === 'done' ? 'сделана' : 'перенесена на'}`
          + ` ${weekdayShort(m.date)} ${dm(m.date)}`,
      }),
      el('span', { className: 'chev' })));
    }
    box.append(card);
  }

  // Активность вне плана. Побегал в субботу, размялся в выходной, доделал
  // навыки — записать это было некуда: экран упирался в «сессии в плане нет».
  const extra = el('details', { className: 'card add-extra' });
  extra.append(el('summary', { textContent: '+ активность вне плана' }));
  const kinds = el('div', { className: 'group-card' });
  for (const kind of ['gym', 'skill', 'home', 'cardio']) {
    kinds.append(el('button', {
      className: 'group-row',
      onclick: async (e) => {
        // Двойной тап заводил вторую запись с тем же ключом: `findWorkout`
        // возвращает первую, вторую нельзя ни открыть, ни удалить — она висит
        // в журнале пустой сессией «Нnull · черновик».
        const btn = e && e.target;
        if (btn && btn.disabled) return;
        if (btn) btn.disabled = true;
        try {
          const w = makeUnplannedWorkout(date, kind, weekOf(plan, date), today);
          const clash = await findWorkout(date, kind, w.dayCode);
          if (clash) {
            navigate('workout', { date, kind, code: w.dayCode });
            return;
          }
          w.id = await putWorkout(w);
          navigate('workout', { date, kind, code: w.dayCode });
        } catch (err) {
          if (btn) btn.disabled = false;
          errorLine(box, err);
        }
      },
    },
    el('span', { className: 'row-title', textContent: KIND_TITLE[kind] }),
    el('span', { className: 'chev' })));
  }
  kinds.append(el('button', {
    className: 'group-row',
    onclick: () => navigate('stretch', { date }),
  },
  el('span', { className: 'row-title', textContent: 'Растяжка' }),
  el('span', { className: 'row-value', textContent: 'блок цикла' }),
  el('span', { className: 'chev' })));
  extra.append(kinds);
  box.append(extra);

  // Закрытая строка не исчезает насовсем: форма складывается сюда, иначе
  // ошибку в утреннем весе уже никак не поправить (находка #4).
  const closed = closedTasks({ date, day, week, sessions, doneKinds, movedAway, settings });

  // Строка, по которой тапнули в «Сделано», открывается формой сразу,
  // а не прячется внутри свёрнутого блока.
  const wanted = params.edit ? closed.find((t) => t.key === params.edit) : null;
  if (wanted) box.append(buildCard(wanted));

  if (closed.length) {
    const det = el('details', { className: 'card edit-closed' });
    det.append(el('summary', { textContent: `Править записанное · ${closed.length}` }));
    for (const t of closed) if (t !== wanted) det.append(buildCard(t));
    box.append(det);
  }
}

/** Кардио-сессии дня: тип, минуты, средний пульс, дистанция. */
function cardioBlock(day, box, save) {
  const wrap = el('div', { className: 'cardio' });
  const list = el('div', { className: 'cardio-list' });
  const draw = () => {
    list.innerHTML = '';
    for (const [i, c] of (day.cardio || []).entries()) {
      list.append(el('div', { className: 'cardio-row' },
        el('span', {
          textContent: `${c.type} · ${c.minutes} мин`
            + (c.hr ? ` · пульс ${c.hr}` : '')
            + (c.km ? ` · ${c.km} км` : ''),
        }),
        el('button', {
          className: 'del', textContent: '×',
          onclick: async () => {
            // Строка возвращается на место, если запись не прошла: иначе
            // экран показывал удаление, которого в базе не случилось.
            const [removed] = day.cardio.splice(i, 1);
            draw();
            try {
              await save(day, putDay);
            } catch (err) {
              day.cardio.splice(i, 0, removed);
              draw();
              box.prepend(el('div', { className: 'error', textContent: err.message }));
            }
          },
        })));
    }
  };
  draw();

  const type = el('select');
  for (const t of CARDIO_TYPES) type.append(el('option', { value: t, textContent: t }));
  const minutes = el('input', { type: 'number', step: '1', inputMode: 'numeric', placeholder: 'мин' });
  const hr = el('input', { type: 'number', step: '1', inputMode: 'numeric', placeholder: 'пульс' });
  const km = el('input', { type: 'number', step: '0.1', inputMode: 'decimal', placeholder: 'км' });

  wrap.append(
    el('h3', { textContent: 'Кардио' }),
    list,
    el('div', { className: 'cardio-form' }, type, minutes, hr, km,
      el('button', {
        className: 'add', textContent: '+',
        onclick: () => {
          const m = parseNum(minutes.value);
          if (m == null) return;
          day.cardio = day.cardio || [];
          day.cardio.push({
            type: type.value, minutes: m, hr: parseNum(hr.value), km: parseNum(km.value),
          });
          minutes.value = ''; hr.value = ''; km.value = '';
          draw();
        },
      })),
    el('p', { className: 'hint', textContent: 'Сессия попадёт в журнал после «Сохранить».' }),
  );
  return wrap;
}
