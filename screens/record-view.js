// Единый вид записи дня. Один и тот же блок рисуется в «Сделано» на экране дня
// и в журнале: расхождение между ними означало бы, что одна и та же тренировка
// в двух местах выглядит по-разному.

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

/**
 * Заметка к упражнению. Разборы бывают в пять строк и вытесняют собой
 * цифры, ради которых открыт журнал, — длинные сворачиваются.
 */
const NOTE_LIMIT = 58;

function note(text) {
  if (text.length <= NOTE_LIMIT) {
    return el('div', { className: 'rec-note', textContent: text });
  }
  const d = el('details', { className: 'rec-note' });
  d.append(el('summary', { textContent: text.slice(0, NOTE_LIMIT).trimEnd() + '…' }));
  d.append(el('div', { className: 'rec-note-full', textContent: text }));
  return d;
}

/** Подпись раздела: серым вразрядку, как над группами в меню. */
function caption(text, meta) {
  return el('div', { className: 'rec-cap' },
    el('span', { textContent: text }),
    meta ? el('span', { className: 'rec-cap-note', textContent: meta }) : null);
}

/** Строки «подпись — значение» одной колонкой: утро, вечер, неделя. */
function facts(rows) {
  const box = el('div', { className: 'rec-facts' });
  for (const r of rows) {
    box.append(el('div', { className: 'rec-fact' + (r.alert ? ' alert' : '') },
      el('span', { className: 'rec-fact-label', textContent: r.label }),
      el('span', { className: 'rec-fact-value', textContent: r.value })));
  }
  return box;
}

/**
 * Таблица упражнений: вес, повторы и RPE стоят колонками и выровнены
 * по правому краю — взгляд бежит по столбцу, а не разбирает строку заново.
 */
function exerciseTable(rows) {
  const table = el('div', { className: 'rec-table' });
  table.append(el('div', { className: 'rec-th' },
    el('span', {}),
    el('span', { textContent: 'вес' }),
    el('span', { textContent: 'повт' }),
    el('span', { textContent: 'RPE' })));

  for (const ex of rows) {
    if (ex.skipped) {
      table.append(el('div', { className: 'rec-row skip' },
        el('span', { className: 'rec-name', textContent: ex.name }),
        el('span', { className: 'rec-skip', textContent: `пропуск — ${ex.reason}` })));
      if (ex.note) table.append(note(ex.note));
      continue;
    }

    ex.groups.forEach((g, i) => {
      // Название стоит только у первой группы: второй строкой идёт тот же
      // снаряд с другим весом, и повторять имя значит сбивать чтение столбца.
      const name = i === 0 ? ex.name : '';
      if (g.cardio) {
        table.append(el('div', { className: 'rec-row' },
          el('span', { className: 'rec-name', textContent: name }),
          el('span', { className: 'rec-cardio', textContent: g.cardio })));
        return;
      }
      table.append(el('div', { className: 'rec-row' },
        el('span', { className: 'rec-name', textContent: name }),
        el('span', { className: 'rec-num', textContent: g.weight }),
        el('span', { className: 'rec-num', textContent: g.reps }),
        el('span', { className: 'rec-num rpe', textContent: g.rpe }),
        g.mark ? el('span', { className: 'rec-mark', textContent: g.mark }) : null));
    });

    // Что заменено — отдельной строкой: в колонку названия пара не влезает,
    // а обрезанное «вместо …» не несёт вообще ничего.
    if (ex.replaced) {
      table.append(el('div', { className: 'rec-swap', textContent: `вместо: ${ex.replaced}` }));
    }
    if (ex.note) table.append(note(ex.note));
  }
  return table;
}

/**
 * Запись дня целиком. onOpen(kind) — переход в сессию, если она открываема.
 */
export function renderRecord(rec, { onOpen } = {}) {
  const box = el('div', { className: 'rec' });

  if (rec.morning.length) {
    box.append(caption('Утро'));
    box.append(facts(rec.morning));
  }

  for (const s of rec.sessions) {
    if (s.kind === 'mobility') {
      const dose = s.seconds ? ` · ${Math.round(s.seconds / 6) / 10} мин` : '';
      box.append(caption('Растяжка',
        (s.total != null ? `${s.done} из ${s.total}` : `${s.done} позиций`) + dose));
      const list = el('div', { className: 'rec-stretch' });
      for (const n of s.names) list.append(el('span', { className: 'rec-chip', textContent: n }));
      box.append(list);
      continue;
    }

    const meta = [`${s.rows.length} упр`]
      .concat(s.avgRPE != null ? [`RPE ${s.avgRPE.toFixed(1).replace('.', ',')}`] : [])
      .concat(s.status === 'draft' ? ['черновик'] : [])
      .concat(s.movedFrom
        ? [`перенос с ${s.movedFrom.slice(8)}.${s.movedFrom.slice(5, 7)}`] : [])
      .join(' · ');

    const cap = caption(`${s.title} · Н${s.weekN} · ${s.code}`, meta);
    if (onOpen) {
      cap.classList.add('tap');
      cap.onclick = () => onOpen(s.kind, s.code);
    }
    box.append(cap);
    box.append(exerciseTable(s.rows));
    if (s.chestSignal != null) {
      box.append(facts([{ label: 'правая грудь', value: String(s.chestSignal), alert: s.chestSignal >= 2 }]));
    }
  }

  if (rec.evening.length) {
    box.append(caption('Вечер'));
    box.append(facts(rec.evening));
  }

  if (rec.weekly.length) {
    box.append(caption('Замеры недели'));
    box.append(facts(rec.weekly));
  }

  // Заметка дня писалась в базу и не показывалась нигде.
  if (rec.note) {
    box.append(caption('Заметка'));
    box.append(note(rec.note));
  }

  return box;
}
