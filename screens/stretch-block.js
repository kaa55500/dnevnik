// Общий блок растяжки: один и тот же вид на отдельном экране и в конце
// заполнения тренировки. Две копии разошлись бы на первой же правке — ровно
// так уже разъезжались справочник в приложении и таблица в документе цикла.
import { etalonBlock } from './etalon.js';

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

/**
 * Почему разогрева нет. Причина живёт в плане (`session.note`), а не в коде:
 * иначе подпись на экране и раскладка в плане разъедутся при следующей правке.
 */
export function warmupHint(session, homeDone) {
  if (session.positions.some((p) => p.n === 0)) return null;
  if (session.note) return session.note;
  return homeDone
    ? 'Разогрев не нужен: домашняя сессия стоит перед блоком и служит им.'
    : 'Разогрев в плане снят под домашнюю сессию. Её сегодня не было — сделай разогрев в полном виде.';
}

/** Подпись под полем просвета: протокол замера и его сравнимость. */
export function splitHint(session, homeDone) {
  if (session.splitAfterSession) {
    return 'Протокол с 31.08: замер сразу после блока, разогрев не делается. '
      + 'С цифрами до 31.08 в один ряд не встаёт — база переставлена.';
  }
  return homeDone
    ? 'Протокол соблюдён: домашняя сессия была разогревом.'
    : 'Домашней сессии сегодня не было — замер пометится «без домашней» и в один ряд с остальными не встанет.';
}

/**
 * Плановые секунды удержания из строки дозы — **суммарные за позицию**,
 * а не за один заход: «1 × 60 с» → 60, «2 × 60 с» → 120,
 * «1 × 60 с на сторону» → 120, «1 × 45 с на сторону» → 90.
 *
 * Раньше бралось одно число, и по всему приведению сумма выходила вдвое
 * меньше реальной — 285 секунд вместо 450. Именно эта цифра сравнивается
 * с потолком 10 мин в неделю (ИССЛЕДОВАНИЯ.md, запись 36), то есть занижение
 * прямо влияло бы на решение о дозе.
 */
export function plannedSeconds(dose) {
  const text = String(dose || '');
  const m = text.match(/(?:(\d+)\s*×\s*)?(\d+)\s*с(?!\p{L})/u);
  if (!m) return null;
  const sets = m[1] ? Number(m[1]) : 1;
  const sides = /на сторону/.test(text) ? 2 : 1;
  return sets * Number(m[2]) * sides;
}

/**
 * Список позиций с чекбоксами и фактическими секундами. `marks` и `secs`
 * мутируются на месте — вызывающий сохраняет их, когда сочтёт нужным.
 *
 * Секунды пишутся, потому что галочка отвечает на «делал ли», а вопрос
 * стоит «сколько простоял». Без цифры недельная доза удержаний неизвестна,
 * а её потолок — 10 минут на группу (Ingram 2025, запись 36).
 */
export function stretchList(positions, guide, marks, secs = {}) {
  const list = el('ol', { className: 'stretch' });
  for (const p of positions) {
    const planned = plannedSeconds(p.dose);
    const input = el('input', { type: 'checkbox', checked: marks[p.n] === true });
    const sec = planned == null ? null : el('input', {
      type: 'number', inputMode: 'numeric', step: '5', className: 'pos-sec',
      value: secs[p.n] ?? '', placeholder: String(planned),
    });
    input.onchange = () => {
      marks[p.n] = input.checked;
      // Отмеченная позиция без цифры — это план: подставляем его молча,
      // иначе честная запись стоила бы тапа на каждой из пяти позиций.
      if (input.checked && sec && sec.value === '') sec.value = String(planned);
      if (!input.checked && sec) sec.value = '';
      if (sec) secs[p.n] = sec.value === '' ? null : Number(sec.value);
    };
    if (sec) sec.onchange = () => { secs[p.n] = sec.value === '' ? null : Number(sec.value); };

    // Признак сверки раскрыт сразу: в блоке растяжки форма и есть вся задача,
    // прятать её за тапом значит прятать смысл позиции.
    list.append(el('li', {},
      el('label', { className: 'check' }, input,
        el('span', { className: 'pos-name', textContent: p.name }),
        el('span', { className: 'pos-dose', textContent: p.dose }),
        p.what ? el('span', { className: 'pos-what', textContent: p.what }) : null),
      sec ? el('div', { className: 'pos-secline' },
        sec, el('span', { className: 'pos-secunit', textContent: 'с фактически' })) : null,
      etalonBlock(guide.get(p.name), { open: true })));
  }
  return list;
}

/** Запись просвета в неделю вместе с протоколом, которым он снят. */
export function applySplit(week, session, value, homeDone) {
  week.splitGap = value;
  if (session.splitAfterSession) {
    week.splitProtocol = 'post';
    // Старый флаг снимается, иначе в записи недели остаётся противоречивая
    // пара и первый же читатель, проверивший его первым, покажет не тот протокол.
    delete week.splitNoHome;
  } else {
    week.splitProtocol = 'cold';
    week.splitNoHome = !homeDone;
  }
}
