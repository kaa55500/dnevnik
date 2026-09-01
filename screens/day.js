import {
  getDay, putDay, getWeek, putWeek, getPlan, getSettings, listWorkouts, putWorkout, listDays, listWeeks,
} from '../store.js';
import { sessionsFor, weekOf, sessionDates, planRange } from '../plan.js';
import { plannedSeconds } from './stretch-block.js';
import { todayISO, weekdayShort, isoWeek, addDays } from '../lib/dates.js';
import { parseNum } from '../lib/format.js';
import { pendingTasks, closedTasks, debts, skipKeyOf, skipScopeOf } from './day-logic.js';
import { makeUnplannedWorkout, KIND_TITLE } from './workout-logic.js';
import { dayRecord } from './journal-logic.js';
import { renderRecord } from './record-view.js';
import { navigate } from '../main.js';

const SIGNALS = {
  headache: 'головная боль',
  knee: 'колено',
  chest: 'правая грудь',
  joints: 'ноющие суставы',
};

const CARDIO_TYPES = ['ходьба', 'гребля', 'ски-эрг', 'бег', 'air bike', 'велосипед'];

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

function errorLine(box, err) {
  box.prepend(el('div', { className: 'error', textContent: 'Не сохранено: ' + err.message }));
}

export async function render(box, params = {}) {
  const date = params.date || todayISO();
  const today = todayISO();
  const backdated = date !== today;

  const [dayRaw, weekRaw, plan, settings, workouts, days, weeks] = await Promise.all([
    getDay(date), getWeek(isoWeek(date)), getPlan(date), getSettings(),
    listWorkouts(), listDays(), listWeeks(),
  ]);
  const day = dayRaw || { date };
  const week = weekRaw || { id: isoWeek(date) };
  const sessions = sessionsFor(plan, date).map((x) => x.session);
  const doneKinds = workouts
    .filter((w) => w.date === date && w.status === 'done')
    .map((w) => ({ kind: w.kind || 'gym', code: w.dayCode || '' }));
  // Сессии, уехавшие с этой даты на другую: план их здесь ждёт, а сделаны
  // они не здесь — долгом такое висеть не должно.
  const movedAway = workouts
    .filter((w) => w.movedFrom === date)
    .map((w) => ({ kind: w.kind || 'gym', code: w.dayCode || '', date: w.date }));

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
      textContent: `${weekdayShort(date)} ${date.slice(8)}.${date.slice(5, 7)}`,
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
  if (!backdated && plan) {
    const owed = debts({ today, dates: sessionDates(plan), days, weeks });
    if (owed.length) {
      const card = el('section', { className: 'card debts' },
        el('h2', { textContent: `Не закрыто: ${owed.length}` }));
      // Заголовок и список обязаны сходиться. Раньше в шапке стояло 13,
      // а строк показывалось шесть — остальные семь пропадали молча.
      const HEAD = 3;
      const row = (o) => el('button', {
        className: 'debt-row',
        textContent: `${o.date.slice(8)}.${o.date.slice(5, 7)} — ${o.title}`,
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
      return card;
    }

    if (t.key === 'morning') {
      const form = el('div', { className: 'grid' },
        field('вес, кг', 'weight', day, '0.1'),
        field('сон, ч', 'sleepHours', day, '0.1'),
        field('качество сна 1–5', 'sleepQuality', day, '1'),
        field('пульс покоя', 'restingHR', day, '1'),
        field('самочувствие 1–5', 'wellbeing', day, '1'),
        field('давление верх', 'bpSys', day, '1'),
        field('давление низ', 'bpDia', day, '1'),
        checkbox('вакуум', 'vacuum', day),
      );
      for (const key of settings.signals || []) {
        form.append(checkbox(SIGNALS[key] || key, key, day));
      }
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
            const mob = sessions.find((s) => s.kind === 'mobility');
            if (mob && mob.splitAfterSession) {
              week.splitProtocol = 'post';
            } else {
              week.splitProtocol = 'cold';
              week.splitNoHome = !doneKinds.some((x) => x.kind === 'home');
            }
          }
          try {
            await save(week, putWeek);
          } catch (err) { errorLine(box, err); }
        },
      }));
    }

    if (t.key === 'evening') {
      const form = el('div', { className: 'grid' },
        field('ходьба, км', 'walkKm', day, '0.1'),
        checkbox('TKE', 'tke', day),
        checkbox('МФР', 'mfr', day),
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
        el('p', { textContent: 'Ккал и белок за неделю, стойка, ходьба на руках, обхваты.' }),
        el('button', {
          className: 'go', textContent: 'Открыть',
          onclick: () => navigate('more', { week: isoWeek(date) }),
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
        textContent: `сделана ${weekdayShort(m.date)} ${m.date.slice(8)}.${m.date.slice(5, 7)}`,
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
      onclick: async () => {
        try {
          const w = makeUnplannedWorkout(date, kind, weekOf(plan, date), today);
          w.id = await putWorkout(w);
          navigate('workout', { date, kind, code: w.dayCode });
        } catch (err) {
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
