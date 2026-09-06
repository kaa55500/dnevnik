// Видео-эталон одной строкой. Один и тот же блок стоит на экране тренировки,
// в растяжке и в справочнике: эталон нужен там, где делаешь движение,
// а не за двумя переходами в отдельном разделе.

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

// Окно записано как «01:22–02:00 выкат сбоку, поясница читается»:
// на чип идёт таймкод, остальное — подпись под раскрытием.
//
// Начало окна и полный диапазон разделены намеренно. Все 43 окна справочника
// записаны диапазонами, и чип «▶ 01:22–02:00» стоял на экране заполнения
// в паре сантиметров от секундомера отдыха: моноширинный акцентный интервал
// времени рядом с крупными цифрами читается окном отдыха, а не таймкодом
// ролика. На чип уходит одно число — точка, куда ведёт ссылка, — а диапазон
// целиком не теряется: он уходит в подпись источника.
function splitWindow(w) {
  const s = String(w || '').trim();
  const m = s.match(/^(\d{1,2}:\d{2}(?:[–—-]\d{1,2}:\d{2})?)\s*(.*)$/);
  if (!m) return { time: null, span: null, rest: s };
  const time = m[1];
  const start = time.split(/[–—-]/)[0];
  return { time: start, span: start === time ? null : time, rest: m[2] };
}

/**
 * @param guide запись справочника; null и записи без видео дают null.
 * @param open раскрыть признак сверки сразу — там, где форма и есть задача.
 */
export function etalonBlock(guide, { open = false } = {}) {
  if (!guide || (!guide.video && !guide.videoCue)) return null;
  const { time, span, rest } = splitWindow(guide.videoWindow);

  const box = el('div', { className: 'etalon' });

  if (guide.video) {
    box.append(el('a', {
      className: 'etalon-link',
      href: guide.video,
      target: '_blank',
      rel: 'noopener',
      // Ссылка ведёт на таймкод: одним тапом попадаешь в окно, а не в начало.
      textContent: time ? `▶ видео ${time}` : '▶ эталон',
    }));
  }

  if (!guide.videoCue && !rest && !span) return box;

  const d = el('details', { className: 'etalon-cue', open });
  d.append(el('summary', { textContent: 'что сверять' }));
  if (guide.videoCue) d.append(el('p', { textContent: guide.videoCue }));

  const source = [guide.videoChannel, span, rest].filter(Boolean).join(' · ');
  if (source) d.append(el('p', { className: 'etalon-src', textContent: source }));
  box.append(d);

  return box;
}
