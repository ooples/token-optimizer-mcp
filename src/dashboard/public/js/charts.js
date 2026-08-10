/*
 * Charts, drawn here rather than fetched from a CDN.
 *
 * The dashboard used to pull chart.js@4.4.0 from cdn.jsdelivr.net with no
 * integrity attribute -- which broke every chart offline or air-gapped, and
 * made a third-party request from a page displaying the user's own project
 * data. For two proportion charts that was a poor trade.
 *
 * These are plain SVG. Every slice and bar also carries a text label, so
 * identity never depends on colour alone, and each has a <title> for the
 * accessibility tree.
 *
 * chart.js is still vendored into the package for the time-series work to come
 * (see ensureChartLibrary) -- but it is loaded on demand, so a page that only
 * shows proportions never pays for it.
 */

const NS = 'http://www.w3.org/2000/svg';

const el = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

export const fmt = (n) => Number(n || 0).toLocaleString();

export function compact(n) {
  const v = Number(n || 0);
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(v));
}

/**
 * A doughnut, with the total in the middle and every slice directly labelled.
 *
 * `slices` is [{ label, value, color }]. Slices too thin to label are folded
 * into the legend only, rather than being drawn with text on top of text.
 */
export function donut(
  host,
  slices,
  { centerLabel = '', centerValue = '' } = {}
) {
  host.innerHTML = '';
  const data = slices.filter((s) => Number(s.value) > 0);
  const total = data.reduce((sum, s) => sum + Number(s.value), 0);

  if (!total) {
    host.appendChild(emptyRing());
    return;
  }

  const size = 210;
  const r = 88;
  const stroke = 26;
  const svg = el('svg', {
    viewBox: `0 0 ${size} ${size}`,
    width: '100%',
    role: 'img',
    'aria-label': `${centerLabel}: ${data.map((s) => `${s.label} ${fmt(s.value)}`).join(', ')}`,
  });

  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  let offset = 0;

  // Track, so a single-slice chart still reads as a proportion of a whole.
  svg.appendChild(
    el('circle', {
      cx,
      cy,
      r,
      fill: 'none',
      stroke: 'var(--surface-3)',
      'stroke-width': stroke,
    })
  );

  for (const slice of data) {
    const portion = Number(slice.value) / total;
    const arc = el('circle', {
      cx,
      cy,
      r,
      fill: 'none',
      stroke: slice.color,
      'stroke-width': stroke,
      // A 2px gap of ground between neighbouring segments, so they read as
      // separate quantities rather than one continuous band.
      'stroke-dasharray': `${Math.max(0, portion * circumference - 2)} ${circumference}`,
      'stroke-dashoffset': -offset,
      transform: `rotate(-90 ${cx} ${cy})`,
    });
    const title = el('title');
    title.textContent = `${slice.label}: ${fmt(slice.value)} (${(portion * 100).toFixed(1)}%)`;
    arc.appendChild(title);
    svg.appendChild(arc);
    offset += portion * circumference;
  }

  if (centerValue) {
    const v = el('text', {
      x: cx,
      y: cy - 2,
      'text-anchor': 'middle',
      fill: 'var(--ink)',
      'font-size': 27,
      'font-weight': 640,
    });
    v.setAttribute('class', 'num');
    v.textContent = centerValue;
    svg.appendChild(v);

    const l = el('text', {
      x: cx,
      y: cy + 19,
      'text-anchor': 'middle',
      fill: 'var(--ink-3)',
      'font-size': 11.5,
    });
    l.textContent = centerLabel;
    svg.appendChild(l);
  }

  host.appendChild(svg);
  host.appendChild(legend(data, total));
}

function emptyRing() {
  const wrap = document.createElement('div');
  wrap.className = 'chart-blank';
  wrap.innerHTML =
    '<div class="ring"></div><p>Nothing measured yet. This fills in as your coding agents work.</p>';
  return wrap;
}

function legend(data, total) {
  const list = document.createElement('ul');
  list.className = 'legend';
  for (const s of data) {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="swatch" style="background:${s.color}"></span>` +
      `<span class="name">${escapeHtml(s.label)}</span>` +
      `<span class="val num">${fmt(s.value)}</span>` +
      `<span class="pct num">${((s.value / total) * 100).toFixed(0)}%</span>`;
    list.appendChild(li);
  }
  return list;
}

/**
 * The before/after comparison that carries the whole point of the product.
 *
 * Two bars on ONE scale -- never two scales -- so the difference between them
 * is the difference in the numbers and nothing else.
 */
export function comparison(
  host,
  { withoutValue, withValue, withoutLabel, withLabel }
) {
  host.innerHTML = '';
  const max = Math.max(Number(withoutValue) || 0, Number(withValue) || 0, 1);

  const row = (label, value, cls) => {
    const wrap = document.createElement('div');
    wrap.className = `cmp-row ${cls}`;
    const pct = Math.max(0.8, (Number(value) / max) * 100);
    wrap.innerHTML =
      `<span class="cmp-label">${escapeHtml(label)}</span>` +
      `<span class="cmp-track"><span class="cmp-fill" style="width:${pct}%"></span></span>` +
      `<span class="cmp-value num">${compact(value)}</span>`;
    return wrap;
  };

  host.appendChild(row(withoutLabel, withoutValue, 'is-without'));
  host.appendChild(row(withLabel, withValue, 'is-with'));
}

/** A sparkline for a series of values. Endpoint emphasised, as the eye lands there. */
export function sparkline(host, values, color = 'var(--saved)') {
  host.innerHTML = '';
  const data = (values || []).map(Number).filter((n) => Number.isFinite(n));
  if (data.length < 2) return;

  const w = 120;
  const h = 32;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const x = (i) => (i / (data.length - 1)) * w;
  const y = (v) => h - ((v - min) / span) * (h - 4) - 2;

  const svg = el('svg', {
    viewBox: `0 0 ${w} ${h}`,
    width: w,
    height: h,
    'aria-hidden': 'true',
  });
  const d = data
    .map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(' ');

  svg.appendChild(
    el('path', {
      d: `${d} L${w} ${h} L0 ${h} Z`,
      fill: 'var(--saved-dim)',
      stroke: 'none',
    })
  );
  svg.appendChild(
    el('path', { d, fill: 'none', stroke: color, 'stroke-width': 2 })
  );
  svg.appendChild(
    el('circle', { cx: w, cy: y(data[data.length - 1]), r: 3, fill: color })
  );
  host.appendChild(svg);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]
  );
}

/**
 * Loads the vendored chart.js, once, on demand.
 *
 * It ships inside the package rather than being fetched from a CDN, so it works
 * offline and cannot change under us. Nothing calls this yet -- the current
 * charts are the SVG above -- but the time-series views planned next (tokens
 * saved over time, per-session trend, hit-rate) want real axes and scales, and
 * this is the one line they need.
 */
let chartLibrary = null;

export function ensureChartLibrary() {
  if (chartLibrary) return chartLibrary;
  chartLibrary = new Promise((resolve, reject) => {
    if (window.Chart) return resolve(window.Chart);
    const tag = document.createElement('script');
    tag.src = '/vendor/chart.umd.min.js';
    tag.onload = () => resolve(window.Chart);
    tag.onerror = () => reject(new Error('vendored chart.js failed to load'));
    document.head.appendChild(tag);
  });
  return chartLibrary;
}
