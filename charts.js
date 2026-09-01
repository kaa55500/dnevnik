export function scale([dMin, dMax], [rMin, rMax]) {
  const span = dMax - dMin;
  if (span === 0) return () => (rMin + rMax) / 2;
  return (v) => rMin + ((v - dMin) / span) * (rMax - rMin);
}

export function linePath(points, w, h, pad = 4) {
  if (!points.length) return '';
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const sx = scale([Math.min(...xs), Math.max(...xs)], [pad, w - pad]);
  const sy = scale([Math.min(...ys), Math.max(...ys)], [h - pad, pad]);
  return points
    .map((p, i) => `${i ? 'L' : 'M'} ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`)
    .join(' ');
}

const NS = 'http://www.w3.org/2000/svg';

/** Мини-график по ряду [{date, value}]. Подписаны только крайние значения. */
export function sparkline(series, { w = 320, h = 120, className = 'chart', marks = [] } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', className);
  svg.setAttribute('preserveAspectRatio', 'none');

  const pts = series.map((p, i) => ({ x: i, y: p.value }));
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', linePath(pts, w, h, 12));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(path);

  // Границы циклов: вертикальная черта, иначе смена фазы читается как аномалия.
  for (const mark of marks) {
    const i = series.findIndex((p) => p.date >= mark.date);
    if (i <= 0) continue;
    const x = 12 + ((w - 24) * i) / Math.max(1, series.length - 1);
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', x.toFixed(1));
    line.setAttribute('x2', x.toFixed(1));
    line.setAttribute('y1', 0);
    line.setAttribute('y2', h);
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-dasharray', '3 3');
    line.setAttribute('opacity', '0.35');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(line);
  }

  if (series.length) {
    const vals = series.map((p) => p.value);
    const label = (text, x, y, anchor) => {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', x); t.setAttribute('y', y);
      t.setAttribute('text-anchor', anchor);
      t.setAttribute('font-size', '11');
      t.setAttribute('fill', 'currentColor');
      t.setAttribute('opacity', '0.6');
      t.textContent = text;
      return t;
    };
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    svg.append(label(String(Math.round(max * 10) / 10), 2, 11, 'start'));
    svg.append(label(String(Math.round(min * 10) / 10), 2, h - 2, 'start'));
  }
  return svg;
}
