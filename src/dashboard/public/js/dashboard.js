/*
 * The overview page.
 *
 * Two rules shape everything here.
 *
 * 1. LEAD WITH WHAT THEY GAINED. The old page opened with "Total Tokens",
 *    which is consumption -- the thing the product exists to reduce. The
 *    headline is now what was saved, with what it would otherwise have cost
 *    beside it, on one shared scale.
 *
 * 2. NEVER MAKE THE READER INTERPRET. Every number carries a plain-language
 *    label and can explain itself; a verdict at the top says in words whether
 *    this is working; and an empty panel teaches instead of apologising.
 */

import { donut, comparison, compact, fmt, escapeHtml } from './charts.js';

const API = '/api';

/** Published Claude input rate. Shown as a scale, never as an invoice. */
const USD_PER_MILLION_TOKENS = 3;

const CATEGORY_COLORS = {
  tools: 'var(--graph)',
  hooks: 'var(--saved)',
  system_reminders: 'var(--graph-2)',
  responses: 'var(--spent)',
};

const CATEGORY_LABELS = {
  tools: 'Tools Claude ran',
  hooks: 'Automatic checks',
  system_reminders: 'Background notes',
  responses: 'Claude’s replies',
};

const SERVER_COLORS = [
  'var(--graph)',
  'var(--saved)',
  'var(--graph-2)',
  'var(--spent)',
  'var(--bad)',
  '#06b6d4',
  '#ec4899',
  '#8b5cf6',
];

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  $('refresh-btn').addEventListener('click', load);
  load();
  setInterval(load, 30_000);
});

async function get(path) {
  try {
    const res = await fetch(`${API}${path}`);
    const body = await res.json().catch(() => null);
    return { ok: res.ok, body };
  } catch {
    return { ok: false, body: null };
  }
}

async function load() {
  // Every panel is independent: the graph is worth showing even when there is
  // no active session, and vice versa. One missing answer must not blank the
  // whole page.
  const [summary, events, balance, status, constellation] = await Promise.all([
    get('/session-summary'),
    get('/session-events?limit=100'),
    get('/wiki/balance'),
    get('/wiki/status'),
    get('/wiki/constellation?cap=90'),
  ]);

  renderSavings(balance.body, status.body);
  renderVerdict(balance.body, status.body);
  renderGraph(constellation.body, status.body);

  const session = summary.ok && summary.body?.success ? summary.body : null;
  renderKpis(session);
  renderCategories(session);
  renderServers(session);
  renderTimeline(events.ok ? events.body?.events : null);
  renderBreakdown(session);

  $('last-updated').textContent = new Date().toLocaleTimeString();
}

/* ------------------------------------------------------------- the hero -- */

function renderSavings(balance, status) {
  const saved = Number(balance?.estimatedTokensAvoided);
  const foot = $('saved-foot');

  if (!balance?.sufficientData || !Number.isFinite(saved) || saved <= 0) {
    // Before there is a measurement, say what will appear and why -- and do
    // NOT show a zero, which reads as failure rather than as "not yet".
    $('saved-tokens').textContent = '—';
    $('saved-money').textContent = '—';
    $('saved-percent').textContent = '—';
    $('comparison').innerHTML = '';

    const learned = Number(status?.nodes) || 0;
    foot.innerHTML = learned
      ? `Still measuring. ${fmt(learned)} things learned so far — the savings ` +
        `figure appears once there is enough of a comparison to be honest about.`
      : `Nothing measured yet. Work normally in Claude Code for a few minutes ` +
        `and this fills itself in.`;
    return;
  }

  const spentAnyway = Number(balance.injectedTokens || 0) + Number(balance.harvestTokens || 0);
  const wouldHave = saved + spentAnyway;
  const percent = wouldHave > 0 ? (saved / wouldHave) * 100 : 0;

  countUp($('saved-tokens'), saved);
  $('saved-money').textContent = `$${((saved / 1e6) * USD_PER_MILLION_TOKENS).toFixed(2)}`;
  $('saved-percent').textContent = `${percent.toFixed(0)}%`;

  comparison($('comparison'), {
    withoutLabel: 'without this',
    withoutValue: wouldHave,
    withLabel: 'with it',
    withValue: spentAnyway,
  });

  foot.textContent =
    `Measured against ${fmt(balance.holdouts)} reads deliberately left alone, ` +
    `so this is a comparison rather than a guess.`;
}

/** A number that lands rather than appearing. Skipped when motion is reduced. */
function countUp(node, target) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    node.textContent = fmt(target);
    return;
  }
  const started = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - started) / 900);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = fmt(Math.round(target * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderVerdict(balance, status) {
  const box = $('verdict');
  const title = $('verdict-title');
  const detail = $('verdict-detail');
  box.hidden = false;
  box.classList.remove('is-ok', 'is-warn', 'is-bad');

  if (!balance?.sufficientData) {
    box.classList.add('is-warn');
    title.textContent = 'Still learning';
    const need = balance
      ? `${balance.injections || 0} of 20 measured reads, ${balance.holdouts || 0} of 5 comparisons`
      : 'no measurements yet';
    detail.textContent = `Not enough evidence to claim a number yet (${need}). Keep working — it gets there on its own.`;
    return;
  }

  const net = Number(balance.netTokens || 0);
  const cost = Number(balance.injectedTokens || 0) + Number(balance.harvestTokens || 0);
  const ratio = cost > 0 ? (net + cost) / cost : Infinity;

  if (net > 0) {
    box.classList.add('is-ok');
    title.textContent = 'Working well';
    detail.textContent = Number.isFinite(ratio)
      ? `Saving about ${ratio.toFixed(0)}× what it costs to run, across ${fmt(status?.nodes || 0)} things it has learned.`
      : `Saving context at no measurable cost.`;
  } else {
    box.classList.add('is-bad');
    title.textContent = 'Not paying off here';
    detail.textContent =
      `Costing more than it saves on this project so far. Small codebases with ` +
      `few repeat reads are the usual reason.`;
  }
}

function renderGraph(constellation, status) {
  const host = $('constellation');
  const stats = $('graph-stats');
  const nodes = constellation?.nodes || [];
  const remembered = Number(status?.nodes) || 0;

  if (!nodes.length) {
    // TWO DIFFERENT EMPTIES, and conflating them produced a page that
    // contradicted itself: the verdict said "across 475 things it has learned"
    // while this panel said "Nothing learned yet". The constellation surfaces
    // findings; the count of remembered files is a different question, and when
    // files exist the honest message is that nothing has been CONCLUDED yet.
    host.innerHTML = remembered
      ? '<div class="empty is-compact"><div class="mark">◍</div>' +
        `<h3>${fmt(remembered)} files remembered</h3>` +
        '<p>Nothing has been concluded about them yet. Findings appear here as ' +
        'Claude works out how the pieces fit together.</p></div>'
      : '<div class="empty is-compact"><div class="mark">◌</div>' +
        '<h3>Nothing learned yet</h3>' +
        '<p>As Claude reads your code, each file is remembered here so it never ' +
        'has to be read twice.</p>' +
        '<p class="next">Open a file in Claude Code, then refresh.</p></div>';

    // The counts are still true and still worth showing.
    stats.innerHTML = remembered ? statRows(status) : '';
    return;
  }

  host.innerHTML = '';
  host.appendChild(nodeField(nodes));
  stats.innerHTML = statRows(status);
}

function statRows(status) {
  const rows = [
    ['files remembered', status?.nodes],
    ['connections', status?.edges],
    ['things discovered', status?.findings],
  ];
  return rows
    .map(
      ([label, value]) =>
        `<div><span class="gs-value num">${compact(value || 0)}</span>` +
        `<span class="gs-label">${label}</span></div>`
    )
    .join('');
}

/**
 * A calm, deterministic constellation.
 *
 * Deterministic on purpose: positions are derived from each node's id, so the
 * picture is stable between refreshes. A layout that reshuffles every 30
 * seconds reads as noise rather than as a map of something real.
 */
function nodeField(nodes) {
  const NS = 'http://www.w3.org/2000/svg';
  const w = 320;
  const h = 190;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${nodes.length} things this project has learned`);

  const hash = (s) => {
    let x = 0;
    for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
    return x;
  };

  const placed = nodes.slice(0, 60).map((n) => {
    const key = String(n.id || n.key || '');
    const a = hash(key);
    const b = hash(`${key}~`);
    return {
      x: 18 + (a % 1000) / 1000 * (w - 36),
      y: 16 + (b % 1000) / 1000 * (h - 32),
      kind: n.kind,
    };
  });

  // Short links between near neighbours, so it reads as a structure rather
  // than as scattered dots.
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const dx = placed[i].x - placed[j].x;
      const dy = placed[i].y - placed[j].y;
      if (Math.hypot(dx, dy) < 36) {
        const line = document.createElementNS(NS, 'line');
        line.setAttribute('x1', placed[i].x);
        line.setAttribute('y1', placed[i].y);
        line.setAttribute('x2', placed[j].x);
        line.setAttribute('y2', placed[j].y);
        line.setAttribute('stroke', 'var(--graph-dim)');
        line.setAttribute('stroke-width', '1');
        svg.appendChild(line);
      }
    }
  }

  placed.forEach((p, i) => {
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', p.x);
    dot.setAttribute('cy', p.y);
    dot.setAttribute('r', p.kind === 'finding' ? 3.6 : 2.4);
    dot.setAttribute('fill', p.kind === 'finding' ? 'var(--saved)' : 'var(--graph)');
    dot.setAttribute('class', 'node-dot');
    dot.style.setProperty('--i', String(i % 12));
    svg.appendChild(dot);
  });

  return svg;
}

/* ------------------------------------------------------------- the rest -- */

function renderKpis(s) {
  const host = $('kpis');
  if (!s) {
    host.innerHTML =
      '<div class="card empty-span"><div class="empty is-compact"><div class="mark">◔</div>' +
      '<h3>No active session</h3>' +
      '<p>These fill in while you are working in Claude Code. The savings above ' +
      'are kept per project, so they stay accurate between sessions.</p>' +
      '<p class="next">Start a session, then refresh.</p></div></div>';
    return;
  }

  const cards = [
    {
      label: 'Context used',
      value: compact(s.totalTokens),
      tip:
        'How much of Claude’s limited workspace this session has taken up. ' +
        'The smaller this is for the same work, the better.',
    },
    {
      label: 'Messages exchanged',
      value: fmt(s.totalTurns),
      tip: 'How many back-and-forth turns you have had in this session.',
    },
    {
      label: 'Actions taken',
      value: fmt(s.totalTools),
      tip:
        'Reads, edits, searches and commands Claude ran on your behalf. ' +
        'Each one is a chance to save context.',
    },
    {
      label: 'Session length',
      value: s.duration || '—',
      tip: 'How long this session has been going.',
    },
  ];

  host.innerHTML = cards
    .map(
      (c) => `
      <div class="card kpi">
        <p class="kpi-label">${escapeHtml(c.label)}
          <button class="explain" type="button" aria-label="What is ${escapeHtml(c.label)}?">?
            <span class="tip" role="tooltip">${escapeHtml(c.tip)}</span>
          </button>
        </p>
        <div class="kpi-value num">${escapeHtml(c.value)}</div>
      </div>`
    )
    .join('');
}

function renderCategories(s) {
  const host = $('category-chart');
  if (!s?.tokensByCategory) {
    host.innerHTML = teach(
      'Nothing to break down yet',
      'Once Claude runs a few actions, this shows which kinds of thing filled the workspace.'
    );
    return;
  }
  const slices = Object.entries(s.tokensByCategory).map(([key, v]) => ({
    label: CATEGORY_LABELS[key] || key,
    value: v?.tokens || 0,
    color: CATEGORY_COLORS[key] || 'var(--graph)',
  }));
  donut(host, slices, { centerLabel: 'context used', centerValue: compact(s.totalTokens) });
}

function renderServers(s) {
  const host = $('server-chart');
  const entries = Object.entries(s?.tokensByServer || {}).filter(([, v]) => (v?.tokens || v) > 0);
  if (!entries.length) {
    host.innerHTML = teach(
      'No tool servers yet',
      'When Claude uses a connected tool, its share of the workspace shows up here.'
    );
    return;
  }
  const slices = entries
    .map(([name, v], i) => ({
      label: name,
      value: v?.tokens ?? v,
      color: SERVER_COLORS[i % SERVER_COLORS.length],
    }))
    .sort((a, b) => b.value - a.value);
  donut(host, slices, {
    centerLabel: 'across tools',
    centerValue: compact(slices.reduce((t, x) => t + x.value, 0)),
  });
}

function renderTimeline(events) {
  const host = $('timeline-container');
  if (!events?.length) {
    host.innerHTML = teach(
      'Nothing has happened yet',
      'Every read, edit and command Claude runs will appear here in order, newest first.'
    );
    return;
  }
  host.innerHTML = events
    .slice(0, 40)
    .map(
      (e) => `
      <div class="event">
        <span class="ev-dot"></span>
        <span class="ev-name">${escapeHtml(e.name || e.tool || 'action')}</span>
        <span class="ev-meta num">${e.tokens ? `${compact(e.tokens)} tokens` : ''}</span>
        <span class="ev-time">${e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : ''}</span>
      </div>`
    )
    .join('');
}

function renderBreakdown(s) {
  const body = $('tool-breakdown-body');
  const rows = s?.toolBreakdown || s?.tools || [];
  if (!rows.length) {
    body.innerHTML =
      '<tr><td colspan="3">' +
      teach(
        'No actions counted yet',
        'Each kind of action Claude takes gets a row here, so repeat costs are easy to spot.'
      ) +
      '</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map(
      (t) => `
      <tr>
        <td>${escapeHtml(t.name || t.tool)}</td>
        <td class="right num">${fmt(t.count)}</td>
        <td class="right num">${fmt(t.tokens)}</td>
      </tr>`
    )
    .join('');
}

/** An empty state that teaches. Never "No data available". */
function teach(title, body) {
  return (
    `<div class="empty is-compact"><div class="mark">◌</div>` +
    `<h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p></div>`
  );
}
