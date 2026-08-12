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
import { createKnowledgeGraph3D } from './graph3d.js';

const API = '/api';

/** Reference rate for scale only. Provider and model prices vary. */
const USD_PER_MILLION_TOKENS = 3;

const CATEGORY_COLORS = {
  tools: 'var(--graph)',
  hooks: 'var(--saved)',
  system_reminders: 'var(--graph-2)',
  responses: 'var(--spent)',
};

const CATEGORY_LABELS = {
  tools: 'Agent tool calls',
  hooks: 'Automatic checks',
  system_reminders: 'Background notes',
  responses: 'Agent responses',
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
let overviewGraph = null;
let loadGeneration = 0;

document.addEventListener('DOMContentLoaded', () => {
  $('refresh-btn').addEventListener('click', load);
  load();
  setInterval(load, 30_000);
});

async function get(path, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}${path}`, { signal: controller.signal });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, body };
  } catch {
    return { ok: false, body: null };
  } finally {
    clearTimeout(timeout);
  }
}

async function load() {
  // Optimizer accounting is the primary product answer. Render it as soon as
  // its small local ledger returns; a cold all-project graph can take seconds
  // and must never hold Saved so far, agent attribution, or action cost blank.
  const generation = ++loadGeneration;
  const analytics = await get('/analytics/overview?limit=40');
  if (generation !== loadGeneration) return;
  const measuredAnalytics =
    analytics.ok && analytics.body?.available ? analytics.body : null;

  // First meaningful paint: MCP measurements do not depend on graph APIs.
  renderSavings(measuredAnalytics, null, null);
  renderAccounting(measuredAnalytics, null);
  renderVerdict(measuredAnalytics, null, null);
  if (measuredAnalytics) {
    const optimizerOnly = joinActivity(
      null,
      measuredAnalytics,
      null,
      null,
      null
    );
    renderClientLedger(optimizerOnly, null);
    renderServers(optimizerOnly);
    renderTimeline(optimizerOnly.events);
    renderBreakdown(optimizerOnly);
  }

  // Do not even start the synchronous graph work until the browser has the
  // primary accounting response. Starting these requests earlier can let a
  // cold graph route monopolize the local Node process before analytics is
  // delivered, recreating the same blank hero through server-side contention.
  const diagnosticsPromise = get('/diagnostics/hooks?hours=24&limit=100');
  const balancePromise = get('/wiki/balance?scope=all');
  const statusPromise = get('/wiki/status?scope=all');
  const constellationPromise = get('/wiki/constellation?cap=90&scope=all');

  const diagnostics = await diagnosticsPromise;
  if (generation !== loadGeneration) return;
  const needsLegacy =
    !(diagnostics.ok && diagnostics.body?.summary?.available) &&
    !measuredAnalytics;
  const [summary, events] = needsLegacy
    ? await Promise.all([
        get('/session-summary'),
        get('/session-events?limit=100'),
      ])
    : [null, null];

  let session = joinActivity(
    diagnostics.ok && diagnostics.body?.summary?.available
      ? activityFromDiagnostics(diagnostics.body)
      : null,
    measuredAnalytics,
    summary?.ok && summary.body?.success ? summary.body : null,
    events?.ok ? events.body?.events : null,
    null
  );
  renderKpis(session);
  renderClientLedger(session, null);
  renderCategories(session);
  renderServers(session);
  renderTimeline(session?.events);
  renderBreakdown(session);

  // Graph data enriches the already-visible optimizer ledger when ready. Each
  // request is bounded, so a damaged graph cannot leave a refresh pending
  // forever or accumulate overlapping 30-second refreshes.
  const [balance, status, constellation] = await Promise.all([
    balancePromise,
    statusPromise,
    constellationPromise,
  ]);
  if (generation !== loadGeneration) return;
  const graphBalance = balance.ok ? balance.body : null;
  const graphStatus = status.ok ? status.body : null;
  renderSavings(measuredAnalytics, graphBalance, graphStatus);
  renderAccounting(measuredAnalytics, graphBalance);
  renderVerdict(measuredAnalytics, graphBalance, graphStatus);
  renderGraph(constellation.ok ? constellation.body : null, graphStatus);

  session = joinActivity(
    diagnostics.ok && diagnostics.body?.summary?.available
      ? activityFromDiagnostics(diagnostics.body)
      : null,
    measuredAnalytics,
    summary?.ok && summary.body?.success ? summary.body : null,
    events?.ok ? events.body?.events : null,
    graphBalance
  );
  renderClientLedger(session, graphBalance);
  renderServers(session);
  renderTimeline(session?.events);
  renderBreakdown(session);

  $('last-updated').textContent = new Date().toLocaleTimeString();
}

function joinActivity(hooks, analytics, legacy, legacyEvents, balance) {
  if (!hooks && !analytics && !legacy) return null;
  if (!hooks && !analytics) return { ...legacy, events: legacyEvents || [] };

  const measuredRows = analytics?.byAction || [];
  const measuredByName = new Map(measuredRows.map((row) => [row.name, row]));
  const hookRows = toolRows(hooks);
  const names = new Set([
    ...measuredByName.keys(),
    ...hookRows.map((row) => row.name),
  ]);
  const toolBreakdown = [...names].map((name) => {
    const measured = measuredByName.get(name);
    const observed = hookRows.find((row) => row.name === name);
    return {
      name,
      count: observed?.count ?? measured?.totalOperations ?? 0,
      observedCalls: observed?.count ?? null,
      measuredOperations: measured?.totalOperations ?? 0,
      tokens: measured?.totalOptimizedTokens ?? null,
      totalOriginalTokens: measured?.totalOriginalTokens ?? null,
      tokensSaved: measured?.totalTokensSaved ?? null,
      contextUsd: measured?.contextUsd ?? null,
      savedUsd: measured?.savedUsd ?? null,
    };
  });
  const native = balance?.nativeOptimizer;
  if (native?.substitutions) {
    toolBreakdown.push({
      name: 'live_graph_substitution',
      count: native.substitutions,
      observedCalls: native.substitutions,
      measuredOperations: native.substitutions,
      tokens: native.tokensReturned,
      totalOriginalTokens: native.tokensReturned + native.tokensSaved,
      tokensSaved: native.tokensSaved,
      contextUsd: (native.tokensReturned / 1e6) * USD_PER_MILLION_TOKENS,
      savedUsd: (native.tokensSaved / 1e6) * USD_PER_MILLION_TOKENS,
    });
  }
  const recentMeasured = [
    ...(analytics?.recent || []),
    ...(native?.recent || []).map((row) => ({
      ...row,
      contextUsd:
        (Number(row.optimizedTokens || 0) / 1e6) * USD_PER_MILLION_TOKENS,
      savedUsd: (Number(row.tokensSaved || 0) / 1e6) * USD_PER_MILLION_TOKENS,
    })),
  ].sort(
    (a, b) => Date.parse(b.timestamp || '') - Date.parse(a.timestamp || '')
  );

  return {
    ...(hooks || {}),
    activityMode: 'combined',
    analytics,
    legacy,
    totalTokens:
      analytics?.summary?.totalOptimizedTokens ?? legacy?.totalTokens ?? null,
    totalTools:
      hooks?.totalTools ??
      analytics?.summary?.totalOperations ??
      legacy?.totalTools ??
      0,
    toolBreakdown,
    events: recentMeasured.length
      ? recentMeasured
      : legacyEvents || hooks?.events || [],
  };
}

function activityFromDiagnostics(report) {
  const events = report.events || [];
  const actions = events.filter(
    (event) =>
      event.event !== 'hook.started' &&
      event.hookEvent === 'pre-tool' &&
      event.toolName
  );
  const toolBreakdown = {};
  for (const event of actions) {
    const name = event.toolName || 'Unknown action';
    toolBreakdown[name] ||= { count: 0, tokens: null };
    toolBreakdown[name].count += 1;
  }
  for (const [name, count] of Object.entries(report.summary.byTool || {})) {
    toolBreakdown[name] = { count, tokens: null };
  }
  return {
    activityMode: 'hooks',
    totalHooks: report.summary.total || 0,
    totalTools: report.summary.actions ?? actions.length,
    activeClients: Object.keys(report.summary.byClient || {}).length,
    p95DurationMs: report.summary.p95DurationMs,
    successRate: report.summary.successRate,
    clients: report.summary.byClient || {},
    toolBreakdown,
    events,
  };
}

/* ------------------------------------------------------------- the hero -- */

function renderSavings(analytics, balance, status) {
  const mcpSaved = Number(analytics?.summary?.totalTokensSaved || 0);
  const nativeSaved = Number(balance?.nativeOptimizer?.tokensSaved || 0);
  const saved = mcpSaved + nativeSaved;
  const foot = $('saved-foot');
  const card = $('saved-card');

  const hasDirectMeasurement =
    Boolean(analytics?.summary?.measuredSavingsOperations) ||
    Number(balance?.nativeOptimizer?.substitutions || 0) > 0;
  if (!hasDirectMeasurement || !Number.isFinite(saved)) {
    // Before there is a measurement, say what will appear and why -- and do
    // NOT show a zero, which reads as failure rather than as "not yet".
    $('saved-tokens').textContent = '—';
    $('saved-money').textContent = '—';
    $('saved-percent').textContent = '—';
    $('saved-tokens').dataset.state = analytics?.available
      ? 'collecting'
      : 'not-measured';
    card.dataset.state = $('saved-tokens').dataset.state;
    card.setAttribute('aria-busy', 'false');
    $('comparison').innerHTML = '';

    const learned = Number(status?.nodes) || 0;
    foot.innerHTML = learned
      ? `${fmt(learned)} things are learned. Measured optimizer savings appear after an optimizer operation reports both its original and returned context size.`
      : `Nothing measured yet. Use an optimizer read, search, edit, or other context-reducing tool and this fills itself in.`;
    return;
  }

  $('saved-tokens').dataset.state = 'measured';
  card.dataset.state = 'measured';
  card.setAttribute('aria-busy', 'false');

  const spentAnyway =
    Number(analytics?.summary?.measuredOptimizedTokens || 0) +
    Number(balance?.nativeOptimizer?.tokensReturned || 0);
  const wouldHave =
    Number(analytics?.summary?.totalOriginalTokens || 0) +
    nativeSaved +
    Number(balance?.nativeOptimizer?.tokensReturned || 0);
  const percent = wouldHave > 0 ? (saved / wouldHave) * 100 : 0;

  countUp($('saved-tokens'), saved);
  $('saved-money').textContent = formatUsd(
    Number(analytics?.summary?.savedUsd || 0) +
      (nativeSaved / 1e6) * USD_PER_MILLION_TOKENS
  );
  $('saved-percent').textContent = `${percent.toFixed(0)}%`;

  comparison($('comparison'), {
    withoutLabel: 'without this',
    withoutValue: wouldHave,
    withLabel: 'with it',
    withValue: spentAnyway,
  });

  foot.textContent =
    `${fmt(analytics?.summary?.totalOperations || 0)} MCP operations context-accounted and ${fmt(balance?.nativeOptimizer?.substitutions || 0)} native substitutions recorded. ` +
    `Graph-effect savings remain separate and are ${balance?.sufficientData ? 'measured' : 'still collecting'}.`;
}

function formatUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'Not measured';
  if (number === 0) return '$0.00';
  if (number < 0.01) return `$${number.toFixed(4)}`;
  return `$${number.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function renderAccounting(analytics, balance) {
  const host = $('accounting-grid');
  const section = $('token-accounting');
  const note = $('accounting-note');
  const summary = analytics?.summary;
  const graphCost =
    Number(balance?.deliveryTokens ?? balance?.injectedTokens ?? 0) +
    Number(balance?.harvestTokens || 0);
  const causalSaved = balance?.sufficientData
    ? Number(balance.estimatedTokensAvoided)
    : null;
  const hasDirect =
    Boolean(summary?.totalOperations) ||
    Number(balance?.nativeOptimizer?.substitutions || 0) > 0;
  const hasSavingsMeasurement =
    Boolean(summary?.measuredSavingsOperations) ||
    Number(balance?.nativeOptimizer?.substitutions || 0) > 0;
  const canComputeNet = hasSavingsMeasurement || causalSaved != null;
  const combinedNet = canComputeNet
    ? Number(summary?.totalTokensSaved || 0) +
      Number(balance?.nativeOptimizer?.tokensSaved || 0) +
      Number(causalSaved || 0) -
      graphCost
    : null;
  const cards = [
    [
      'Original context',
      summary?.measuredSavingsOperations
        ? compact(summary.totalOriginalTokens)
        : 'Not measured',
      'known before-state only',
    ],
    [
      'Returned context',
      summary ? compact(summary.totalOptimizedTokens) : 'Not measured',
      summary
        ? `${formatUsd(summary.contextUsd)} · ${fmt(summary.actualReturnedContextOperations || 0)} actual-return · ${fmt(summary.legacyReportedContextOperations || 0)} legacy rows`
        : 'actual results returned to clients',
    ],
    [
      'Optimizer saved',
      hasSavingsMeasurement
        ? compact(
            Number(summary?.totalTokensSaved || 0) +
              Number(balance?.nativeOptimizer?.tokensSaved || 0)
          )
        : 'Not measured',
      hasSavingsMeasurement
        ? `${formatUsd(
            Number(summary?.savedUsd || 0) +
              (Number(balance?.nativeOptimizer?.tokensSaved || 0) / 1e6) *
                USD_PER_MILLION_TOKENS
          )} · MCP + native`
        : 'USD unavailable',
    ],
    [
      'Graph memory cost',
      balance ? compact(graphCost) : 'Not measured',
      balance
        ? `${formatUsd((graphCost / 1e6) * USD_PER_MILLION_TOKENS)} · delivery + harvest`
        : 'delivery + harvest',
    ],
    [
      'Causal graph saving',
      causalSaved == null ? 'Collecting' : compact(causalSaved),
      causalSaved == null
        ? `${fmt(balance?.injections || 0)}/20 treated · ${fmt(balance?.holdouts || 0)}/5 holdout`
        : 'holdout measured',
    ],
    [
      'Combined net measured',
      combinedNet == null ? 'Not measured' : compact(combinedNet),
      causalSaved == null
        ? 'optimizer saving − graph cost; causal graph benefit excluded'
        : 'optimizer + causal graph saving − graph cost',
    ],
  ];
  host.innerHTML = cards
    .map(
      ([label, value, detail]) => `
    <div class="accounting-card">
      <span class="accounting-label">${escapeHtml(label)}</span>
      <strong class="accounting-value num">${escapeHtml(value)}</strong>
      <span class="accounting-detail">${escapeHtml(detail)}</span>
    </div>`
    )
    .join('');
  section.dataset.state = hasSavingsMeasurement ? 'measured' : 'not-measured';
  section.setAttribute('aria-busy', 'false');
  note.textContent = hasDirect
    ? `${analytics?.source || 'No MCP operation rows yet'}; ${balance?.nativeOptimizer?.source || 'no native substitutions recorded'}. USD uses a $${analytics?.referenceUsdPerMillionTokens || USD_PER_MILLION_TOKENS}/million reference rate; graph causal savings are never counted before the holdout gate passes.`
    : 'No direct optimizer before/after measurements have been recorded yet.';
}

function renderClientLedger(session, balance) {
  const host = $('client-ledger');
  const section = $('measured-by-agent');
  const analytics = session?.analytics;
  const activeClients = new Set(Object.keys(session?.clients || {}));
  const rows = (analytics?.byClient || []).map((row) => ({ ...row }));
  for (const [name, native] of Object.entries(
    balance?.nativeOptimizer?.byClient || {}
  )) {
    const current = rows.find((row) => row.name === name);
    if (current) {
      current.totalOperations += native.substitutions || 0;
      current.totalOptimizedTokens += native.tokensReturned || 0;
      current.totalTokensSaved += native.tokensSaved || 0;
      current.contextUsd +=
        ((native.tokensReturned || 0) / 1e6) * USD_PER_MILLION_TOKENS;
      current.nativeSubstitutions = native.substitutions || 0;
    } else {
      rows.push({
        name,
        attribution:
          name === 'Historical — client not recorded'
            ? 'historical-unattributed'
            : 'recorded',
        totalOperations: native.substitutions || 0,
        totalOptimizedTokens: native.tokensReturned || 0,
        totalTokensSaved: native.tokensSaved || 0,
        contextUsd:
          ((native.tokensReturned || 0) / 1e6) * USD_PER_MILLION_TOKENS,
        nativeSubstitutions: native.substitutions || 0,
      });
    }
  }
  for (const client of activeClients) {
    if (!rows.some((row) => row.name === client)) {
      rows.push({
        name: client,
        attribution: 'lifecycle-only',
        totalOperations: 0,
        totalOptimizedTokens: null,
        totalTokensSaved: null,
        contextUsd: null,
      });
    }
  }
  if (!rows.length) {
    host.innerHTML = teach(
      'No agent attribution yet',
      'New MCP operations record their client identity after the handshake.'
    );
    section.dataset.state = 'not-measured';
    section.setAttribute('aria-busy', 'false');
    return;
  }
  host.innerHTML = rows
    .map(
      (row) => `
      <div class="client-ledger-row">
        <div>
          <strong>${escapeHtml(row.name)}</strong>
          <span>${row.attribution === 'historical-unattributed' ? 'historical total; client was not stored' : row.attribution === 'lifecycle-only' ? 'lifecycle active; optimizer cost not yet attributed' : `${row.nativeSubstitutions ? `${fmt(row.nativeSubstitutions)} graph substitutions · ` : ''}attributed by client protocol`}</span>
        </div>
        <div><span>Operations</span><strong class="num">${fmt(row.totalOperations)}</strong></div>
        <div><span>Returned context</span><strong class="num">${row.totalOptimizedTokens == null ? 'Not measured' : fmt(row.totalOptimizedTokens)}</strong></div>
        <div><span>Context USD</span><strong class="num">${row.contextUsd == null ? 'Not measured' : formatUsd(row.contextUsd)}</strong></div>
        <div><span>Saved</span><strong class="num saved-cell">${row.totalTokensSaved == null ? 'Not measured' : fmt(row.totalTokensSaved)}</strong></div>
      </div>`
    )
    .join('');
  section.dataset.state = 'measured';
  section.setAttribute('aria-busy', 'false');
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

function renderVerdict(analytics, balance, status) {
  const box = $('verdict');
  const title = $('verdict-title');
  const detail = $('verdict-detail');
  box.hidden = false;
  box.classList.remove('is-ok', 'is-warn', 'is-bad');

  const directSaved =
    Number(analytics?.summary?.totalTokensSaved || 0) +
    Number(balance?.nativeOptimizer?.tokensSaved || 0);
  const graphCost =
    Number(balance?.deliveryTokens ?? balance?.injectedTokens ?? 0) +
    Number(balance?.harvestTokens || 0);

  if (!balance?.sufficientData && directSaved > 0) {
    box.classList.add('is-ok');
    title.textContent = 'Saving context now';
    detail.textContent = `${fmt(directSaved)} tokens were removed by measured optimizer operations. The separate causal graph-effect study is still collecting (${fmt(balance?.injections || 0)}/20 treated, ${fmt(balance?.holdouts || 0)}/5 holdout).`;
    return;
  }

  if (!balance?.sufficientData) {
    box.classList.add('is-warn');
    title.textContent = 'Still learning';
    const need = balance
      ? `${balance.injections || 0} of 20 measured reads, ${balance.holdouts || 0} of 5 comparisons`
      : 'no measurements yet';
    detail.textContent = `Not enough evidence to claim a number yet (${need}). Keep working — it gets there on its own.`;
    return;
  }

  const net =
    directSaved + Number(balance.estimatedTokensAvoided || 0) - graphCost;
  const ratio = graphCost > 0 ? (net + graphCost) / graphCost : Infinity;

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
    overviewGraph?.destroy();
    overviewGraph = null;
    // TWO DIFFERENT EMPTIES, and conflating them produced a page that
    // contradicted itself: the verdict said "across 475 things it has learned"
    // while this panel said "Nothing learned yet". The constellation surfaces
    // findings; the count of remembered files is a different question, and when
    // files exist the honest message is that nothing has been CONCLUDED yet.
    host.innerHTML = remembered
      ? '<div class="empty is-compact"><div class="mark">◍</div>' +
        `<h3>${fmt(remembered)} graph nodes remembered</h3>` +
        '<p>Nothing has been concluded about them yet. Findings appear here as ' +
        'your coding agents work out how the pieces fit together.</p></div>'
      : '<div class="empty is-compact"><div class="mark">◌</div>' +
        '<h3>Nothing learned yet</h3>' +
        '<p>As a supported agent reads your code, each file is remembered here so it does not ' +
        'have to be read twice.</p>' +
        '<p class="next">Open a file with your coding agent, then refresh.</p></div>';

    // The counts are still true and still worth showing.
    stats.innerHTML = remembered ? statRows(status) : '';
    return;
  }

  if (!overviewGraph) {
    overviewGraph = createKnowledgeGraph3D(host, constellation, {
      compact: true,
      cap: 60,
    });
  } else {
    overviewGraph.update(constellation);
  }
  stats.innerHTML = statRows(status);
}

function statRows(status) {
  const rows = [
    ['graph nodes', status?.nodes],
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
  svg.setAttribute(
    'aria-label',
    `${nodes.length} things this project has learned`
  );

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
      x: 18 + ((a % 1000) / 1000) * (w - 36),
      y: 16 + ((b % 1000) / 1000) * (h - 32),
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
    dot.setAttribute(
      'fill',
      p.kind === 'finding' ? 'var(--saved)' : 'var(--graph)'
    );
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
      '<p>These fill in while you are working in a supported coding agent. The savings above ' +
      'are kept per project, so they stay accurate between sessions.</p>' +
      '<p class="next">Start a session, then refresh.</p></div></div>';
    return;
  }

  const cards =
    s.activityMode === 'hooks' || s.activityMode === 'combined'
      ? [
          {
            label: 'Lifecycle events',
            value: fmt(s.totalHooks),
            tip: 'Hook executions observed across every installed CLI during the last 24 hours.',
          },
          {
            label: 'Actions observed',
            value: fmt(s.totalTools),
            tip: 'Pre-tool actions observed by the cross-client hook protocol during the last 24 hours.',
          },
          {
            label: 'CLI clients active',
            value: fmt(s.activeClients),
            tip: 'Distinct CLI clients that emitted lifecycle telemetry during the last 24 hours.',
          },
          {
            label: 'Hook latency p95',
            value:
              s.p95DurationMs == null
                ? 'Not measured'
                : `${fmt(s.p95DurationMs)} ms`,
            tip: 'Ninety-five percent of observed hook calls completed at or below this latency.',
          },
        ]
      : [
          {
            label: 'Context used',
            value: compact(s.totalTokens),
            tip:
              'How much of the active agent’s limited workspace this session has taken up. ' +
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
              'Reads, edits, searches and commands the active agent ran on your behalf. ' +
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
  if (s?.clients) {
    const slices = Object.entries(s.clients).map(([client, values], index) => ({
      label: client,
      value: values.total || 0,
      color: SERVER_COLORS[index % SERVER_COLORS.length],
    }));
    donut(host, slices, {
      centerLabel: 'lifecycle events',
      centerValue: compact(s.totalHooks),
    });
    return;
  }
  if (!s?.tokensByCategory) {
    host.innerHTML = teach(
      'Nothing to break down yet',
      'Once a coding agent runs a few actions, this shows which kinds of thing filled the workspace.'
    );
    return;
  }
  const slices = Object.entries(s.tokensByCategory).map(([key, v]) => ({
    label: CATEGORY_LABELS[key] || key,
    value: v?.tokens || 0,
    color: CATEGORY_COLORS[key] || 'var(--graph)',
  }));
  donut(host, slices, {
    centerLabel: 'context used',
    centerValue: compact(s.totalTokens),
  });
}

function renderServers(s) {
  const host = $('server-chart');
  if (s?.analytics?.byAction?.length) {
    const slices = toolRows(s)
      .filter((row) => Number(row.tokensSaved) > 0)
      .map((row, index) => ({
        label: row.name || row.tool,
        value: row.tokensSaved,
        color: SERVER_COLORS[index % SERVER_COLORS.length],
      }))
      .sort((a, b) => b.value - a.value);
    if (!slices.length) {
      host.innerHTML = teach(
        'No measured savings yet',
        'Optimizer operations are recorded here after both their original and returned context sizes are known.'
      );
      return;
    }
    donut(host, slices, {
      centerLabel: 'tokens saved',
      centerValue: compact(slices.reduce((sum, item) => sum + item.value, 0)),
    });
    return;
  }
  let entries = Object.entries(s?.tokensByServer || {}).filter(
    ([, v]) => (v?.tokens || v) > 0
  );
  if (!entries.length)
    entries = toolRows(s)
      .map((row) => [row.name || row.tool, row.tokens])
      .filter(([name, tokens]) => name && Number(tokens) > 0);
  if (!entries.length) {
    host.innerHTML = teach(
      'No measured actions yet',
      'When a coding agent reads, edits, searches, or runs a command, its share of the workspace shows up here.'
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
      'Every observed read, edit, search, and command will appear here in order, newest first.'
    );
    return;
  }
  host.innerHTML = events
    .slice(0, 40)
    .map((e) => {
      const action = describeEvent(e);
      return `
      <div class="event">
        <span class="ev-dot"></span>
        <span class="ev-copy">
          <span class="ev-name">${escapeHtml(action.tool)}</span>
          <span class="ev-detail">${escapeHtml(action.detail)}</span>
        </span>
        <span class="ev-meta num">${action.contextTokens != null ? (action.tokens == null ? `${compact(action.contextTokens)} context · ${action.costLabel}` : `${compact(action.contextTokens)} context · ${formatUsd(action.contextUsd)} · ${compact(action.tokens)} saved`) : action.tokens ? `${compact(action.tokens)} context tokens` : action.costLabel}</span>
        <span class="ev-time">${e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : ''}</span>
      </div>`;
    })
    .join('');
}

function describeEvent(event) {
  if (event.originalTokens != null && event.optimizedTokens != null) {
    const isNative = event.name === 'live_graph_substitution';
    return {
      tool: isNative
        ? `Live graph substitution${event.client ? ` · ${event.client}` : ''}`
        : `${event.name || event.toolName || 'optimizer operation'}${event.client ? ` · ${event.client}` : ''}`,
      detail:
        event.savingsMeasured === false
          ? `${fmt(event.optimizedTokens)} returned context tokens; no before baseline`
          : `${fmt(event.originalTokens)} → ${fmt(event.optimizedTokens)} context tokens`,
      tokens:
        event.savingsMeasured === false ? null : Number(event.tokensSaved || 0),
      contextTokens: Number(event.optimizedTokens || 0),
      contextUsd: event.contextUsd,
      costLabel:
        event.savingsMeasured === false
          ? `${formatUsd(event.contextUsd)} context · saving not measurable`
          : `${formatUsd(event.contextUsd)} context · ${formatUsd(event.savedUsd)} saved`,
    };
  }
  const hookEvent = String(event.hookEvent || '').trim();
  const client = String(event.client || '').trim();
  const tool = String(
    event.toolName ||
      event.name ||
      event.tool ||
      (hookEvent && `${client || 'agent'} ${hookEvent.replaceAll('-', ' ')}`) ||
      event.type ||
      'agent event'
  );
  const details = {
    Edit: 'Edited project content',
    Write: 'Wrote project content',
    Read: 'Read project context',
    Bash: 'Ran a terminal command',
    Shell: 'Ran a terminal command',
    Grep: 'Searched project text',
    Glob: 'Matched project files',
    TodoWrite: 'Updated the task plan',
    WebSearch: 'Searched the web',
    BashOutput: 'Inspected terminal output',
    KillShell: 'Stopped a background command',
  };
  const eventType = String(hookEvent || event.type || 'agent event')
    .replaceAll('_', ' ')
    .replaceAll('-', ' ');
  const tokens = Number(event.estimatedTokens ?? event.tokens ?? 0);
  return {
    tool,
    detail:
      details[tool] ||
      `${eventType.charAt(0).toUpperCase()}${eventType.slice(1)}`,
    tokens,
    costLabel: hookEvent
      ? 'token cost not reported by client'
      : 'no context recorded',
  };
}

function renderBreakdown(s) {
  const body = $('tool-breakdown-body');
  const rows = toolRows(s);
  if (!rows.length) {
    body.innerHTML =
      '<tr><td colspan="5">' +
      teach(
        'No actions counted yet',
        'Each kind of observed agent action gets a row here, so repeat costs are easy to spot.'
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
        <td class="right num">${t.tokens == null ? 'Not measured' : fmt(t.tokens)}</td>
        <td class="right num">${t.contextUsd == null ? 'Not measured' : formatUsd(t.contextUsd)}</td>
        <td class="right num saved-cell">${t.tokensSaved == null ? 'Not measured' : fmt(t.tokensSaved)}</td>
      </tr>`
    )
    .join('');
}

function toolRows(summary) {
  const source = summary?.toolBreakdown || summary?.tools || [];
  return Array.isArray(source)
    ? source
    : Object.entries(source).map(([name, values]) => ({ name, ...values }));
}

/** An empty state that teaches. Never "No data available". */
function teach(title, body) {
  return (
    `<div class="empty is-compact"><div class="mark">◌</div>` +
    `<h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p></div>`
  );
}
