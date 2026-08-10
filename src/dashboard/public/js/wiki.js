/**
 * Wiki graph browser.
 *
 * No chart or layout library, and no CDN: the dashboard already pulls Chart.js
 * from a CDN and adding a second network dependency for a graph view would make
 * the page fail in exactly the air-gapped and locked-down environments where a
 * local-first knowledge graph is most wanted.
 *
 * TWO MODES ON ONE CANVAS, because they answer different questions:
 *
 *   FOCUS -- one node centred with its direct edges radiating out. Readable at
 *   any graph size, because what it renders is bounded by the node's degree
 *   rather than by the size of the graph.
 *
 *   CONSTELLATION -- force-directed over a BOUNDED subgraph. The hairball that
 *   makes force layouts useless comes from running physics over everything; the
 *   server caps the subgraph, so this stays a navigation map you click into.
 *   Physics stops as soon as it settles rather than spinning forever.
 */

const KINDS = ['file', 'symbol', 'finding', 'task'];
const RADIUS = { file: 9, symbol: 8, finding: 10, task: 8 };

/**
 * Room reserved on each side so a caption never runs off the edge.
 *
 * DRAWING IS IN REAL PIXELS, not a scaled viewBox. A viewBox was tried and is
 * the wrong tool here: fitting a 1000-unit space into a ~535px pane scales
 * everything by ~0.53, which drags 11px labels down to about 6px on screen and
 * makes the whole graph unreadable. Text does not survive being scaled.
 *
 * The bug a viewBox was meant to solve -- the detail drawer reflowing the pane
 * after coordinates were computed, leaving the graph off-centre with clipped
 * labels -- is a STALE MEASUREMENT problem, so it is fixed by re-measuring:
 * the drawer opens before the first render, and a ResizeObserver re-renders
 * whenever the pane actually changes size.
 */
const LABEL_GUTTER = 150;

const el = (id) => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';

const state = {
  mode: 'focus',
  offset: 0,
  selected: null,
  items: [],
};

/** Kind colour, read from CSS so the validated palette has one home. */
function colourFor(kind) {
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue(`--wiki-${kind}`)
      .trim() || '#94a3b8'
  );
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}

/* ---- Balance --------------------------------------------------------- */

const nf = new Intl.NumberFormat();

/**
 * Renders the balance.
 *
 * The refusal to show a headline number below the sufficiency threshold is the
 * point, not a limitation: a saving figure computed from four samples is the
 * kind of confident-looking number this project exists to argue against.
 */
async function loadBalance() {
  let balance;
  try {
    balance = await api('/api/wiki/balance');
  } catch {
    return;
  }

  // Plain language, because someone reading this page has no reason to know
  // what "injected" means. The words describe what happened, not what the code
  // calls it.
  const tiles = [
    ['Times memory was used', nf.format(balance.injections)],
    ['Kept back for comparison', nf.format(balance.holdouts)],
    ['Cost of remembering', `${nf.format(balance.injectedTokens)} tokens`],
    [
      'Reading avoided',
      balance.estimatedTokensAvoided === null
        ? '—'
        : `${nf.format(balance.estimatedTokensAvoided)} tokens`,
    ],
  ];

  el('balance-grid').innerHTML = tiles
    .map(
      ([label, value]) => `
    <div class="stat-card">
      <div class="stat-content">
        <div class="stat-label">${label}</div>
        <div class="stat-value wiki-figure">${value}</div>
      </div>
    </div>`
    )
    .join('');

  const verdict = el('balance-verdict');
  verdict.textContent = balance.verdict;
  verdict.dataset.state = !balance.sufficientData
    ? 'insufficient'
    : balance.netTokens > 0
      ? 'positive'
      : 'negative';

  if (balance.sufficientData) {
    el('balance-method').textContent =
      `Measured against ${nf.format(balance.holdouts)} withheld control touches — not estimated. ` +
      `Net after injection and harvest cost: ${nf.format(balance.netTokens)} tokens.`;
  }
}

/* ---- Causal evidence ------------------------------------------------ */

function formatInterval(interval, suffix = '') {
  if (!interval || interval.mean === null) return '—';
  const mean = nf.format(Math.round(interval.mean * 100) / 100);
  const low = nf.format(Math.round(interval.low * 100) / 100);
  const high = nf.format(Math.round(interval.high * 100) / 100);
  return `${mean}${suffix} [${low}, ${high}]`;
}

async function loadEvidence() {
  const params = new URLSearchParams();
  const values = {
    client: el('evidence-client').value.trim(),
    model: el('evidence-model').value.trim(),
    taskId: el('evidence-task').value.trim(),
    arm: el('evidence-arm').value,
  };
  for (const [key, value] of Object.entries(values))
    if (value) params.set(key, value);

  let report;
  try {
    report = await api(`/api/wiki/evidence?${params}`);
  } catch {
    el('evidence-status').textContent = 'Evidence report unavailable';
    el('evidence-status').dataset.state = 'bad';
    return;
  }

  const summary = report.summary;
  const coverage =
    summary.causalJoinCoverage === null
      ? '—'
      : `${Math.round(summary.causalJoinCoverage * 100)}%`;
  el('evidence-summary').innerHTML = [
    ['Randomized runs', nf.format(summary.evalRuns)],
    ['Live injections', nf.format(summary.liveInjections)],
    ['Outcome join coverage', coverage],
    ['Harmful feedback', nf.format(summary.harmfulFeedback)],
  ]
    .map(
      ([label, value]) => `
    <div class="stat-card"><div class="stat-content">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value wiki-figure">${escapeHtml(value)}</div>
    </div></div>`
    )
    .join('');

  const status = el('evidence-status');
  status.textContent = summary.evidenceStatus;
  status.dataset.state =
    summary.evidenceStatus === 'causal estimates available'
      ? 'ok'
      : 'insufficient';

  const cohortRows = [];
  for (const cohort of report.cohorts || []) {
    for (const effect of cohort.effects || []) {
      cohortRows.push(`<tr>
        <td>${escapeHtml(cohort.client)}<br><span class="wiki-muted">${escapeHtml(cohort.clientVersion || 'version unknown')}</span></td>
        <td>${escapeHtml(cohort.model || 'model unknown')}</td>
        <td>${escapeHtml(cohort.taskId || 'task unknown')}</td>
        <td>${escapeHtml(effect.comparison || effect.arm)}</td>
        <td>${nf.format(effect.pairs)}</td>
        <td>${escapeHtml(formatInterval(effect.totalTokensSaved, ' tokens'))}</td>
        <td>${escapeHtml(formatInterval(effect.toolCallsAvoided, ' calls'))}</td>
        <td>${escapeHtml(cohort.evidenceStatus)}</td>
      </tr>`);
    }
  }
  el('evidence-cohorts').innerHTML = `
    <thead><tr><th>Client</th><th>Model</th><th>Task</th><th>Comparison</th><th>Pairs</th><th>Token effect (95% CI)</th><th>Call effect (95% CI)</th><th>Status</th></tr></thead>
    <tbody>${cohortRows.join('') || '<tr><td colspan="8">No randomized cohorts match these filters.</td></tr>'}</tbody>`;

  const episodeRows = (report.episodes || [])
    .map(
      (trace) => `<tr>
    <td>${escapeHtml(trace.client)}</td>
    <td>${escapeHtml(trace.arm)}</td>
    <td>${escapeHtml(trace.surface)}</td>
    <td class="evidence-anchor">${escapeHtml(trace.anchor || '—')}</td>
    <td>${nf.format(trace.deliveredTokens || 0)} / ${nf.format(trace.shadowTokens || 0)}</td>
    <td>${trace.outcome ? `${trace.outcome.success ? '✓ success' : '✕ failed'} · ${escapeHtml(trace.outcome.joinMethod)}` : 'not joined'}</td>
  </tr>`
    )
    .join('');
  el('evidence-episodes').innerHTML = `
    <thead><tr><th>Client</th><th>Arm</th><th>Surface</th><th>Anchor</th><th>Delivered / shadow</th><th>Outcome</th></tr></thead>
    <tbody>${episodeRows || '<tr><td colspan="6">No live injection traces match these filters.</td></tr>'}</tbody>`;

  const capabilityRows = (report.capabilities || [])
    .map(
      (client) => `<tr>
    <td>${escapeHtml(client.name)}</td><td>${escapeHtml(client.tier)}</td>
    <td>${escapeHtml(client.routing)}</td><td>${escapeHtml(client.structuralCapture)}</td>
    <td>${escapeHtml(client.findingDelivery)}</td><td>${escapeHtml(client.semanticHarvest)}</td>
  </tr>`
    )
    .join('');
  el('evidence-capabilities').innerHTML = `
    <thead><tr><th>Client</th><th>Tier</th><th>Routing</th><th>Capture</th><th>Delivery</th><th>Harvest</th></tr></thead>
    <tbody>${capabilityRows}</tbody>`;
}

async function loadUcr() {
  let status;
  try {
    status = await api('/api/ucr/status');
  } catch {
    el('ucr-summary').innerHTML = '';
    el('ucr-verdict').textContent = 'UCR runtime unavailable';
    el('ucr-verdict').dataset.state = 'bad';
    return;
  }
  el('ucr-summary').innerHTML = [
    ['Protocol', status.protocolVersion],
    ['Canonical events', nf.format(status.events)],
    ['Typed objects', nf.format(status.graph?.objects || 0)],
    ['Certified clients', nf.format(status.certifiedClients)],
    [
      'Evidence artifacts',
      status.evidenceIndex
        ? `${status.evidenceIndex.summary.artifactsValid}/${status.evidenceIndex.summary.artifactsTotal}`
        : 'not assembled',
    ],
    [
      'Live directions',
      status.evidenceIndex
        ? `${status.evidenceIndex.summary.liveDirectionsPassed}/${status.evidenceIndex.summary.liveDirectionsAttempted}`
        : 'not run',
    ],
    [
      'Lower token traffic',
      status.evidenceIndex
        ? `${status.evidenceIndex.summary.liveDirectionsWithLowerTokenTraffic || 0}/${status.evidenceIndex.summary.liveDirectionsPassed || 0} passing`
        : 'not measured',
    ],
    [
      'Lower latency',
      status.evidenceIndex
        ? `${status.evidenceIndex.summary.liveDirectionsWithLowerLatency || 0}/${status.evidenceIndex.summary.liveDirectionsPassed || 0} passing`
        : 'not measured',
    ],
    [
      'Consumer MCP schema',
      status.evidenceIndex?.summary.maximumConsumerStaticSchemaTokens != null
        ? `${nf.format(status.evidenceIndex.summary.maximumConsumerStaticSchemaTokens)} tokens max`
        : 'not measured',
    ],
    ['Scale events', nf.format(status.evidenceIndex?.summary.graphEvents || 0)],
    [
      'Physical writers',
      nf.format(status.evidenceIndex?.summary.coordinationWorkers || 0),
    ],
    [
      'Fault exercises',
      `${status.productionExercise?.faults?.exercised || 0}/${status.productionExercise?.faults?.required?.length || 6}`,
    ],
    [
      'Cognitive schema',
      status.evidenceIndex?.summary.cognitiveSchemaTokens
        ? `${nf.format(status.evidenceIndex.summary.cognitiveSchemaTokens)} tokens`
        : 'not measured',
    ],
    [
      'Schema reduction',
      status.evidenceIndex?.summary.cognitiveReductionVsFull != null
        ? `${(status.evidenceIndex.summary.cognitiveReductionVsFull * 100).toFixed(1)}% vs full`
        : 'not measured',
    ],
  ]
    .map(
      ([label, value]) => `
    <div class="stat-card"><div class="stat-content">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value wiki-figure">${escapeHtml(value)}</div>
    </div></div>`
    )
    .join('');
  const verdict = status.verdict?.status || 'insufficient';
  const deterministic = status.deterministicEvidence
    ? `${status.deterministicEvidence.checksPassed}/${status.deterministicEvidence.checksTotal} deterministic gates`
    : 'no deterministic ledger';
  el('ucr-verdict').textContent =
    `${verdict} · ${deterministic} · ${status.cognitiveOperations?.length || 0} lazy cognitive operations · ${status.malformed || 0} malformed events`;
  el('ucr-verdict').dataset.state =
    verdict === 'passed'
      ? 'ok'
      : verdict === 'harmful'
        ? 'bad'
        : 'insufficient';
  const tiers = status.evidenceIndex?.tiers || {};
  el('ucr-tiers').innerHTML = `
    <thead><tr><th>Tier</th><th>Status</th><th>Ledgers</th><th>Rows</th></tr></thead>
    <tbody>${Object.entries(tiers)
      .map(
        ([tier, value]) => `<tr>
          <td>${escapeHtml(tier)}</td>
          <td>${escapeHtml(value.status)}</td>
          <td>${escapeHtml(value.ledgers)}</td>
          <td>${escapeHtml(value.rows)}</td>
        </tr>`
      )
      .join('')}</tbody>`;
  el('ucr-artifacts').innerHTML = `
    <thead><tr><th>Study</th><th>Evidence class</th><th>Integrity</th><th>Outcome</th></tr></thead>
    <tbody>${(status.evidenceIndex?.artifacts || [])
      .map(
        (artifact) => `<tr>
          <td>${escapeHtml(artifact.name)}</td>
          <td>${escapeHtml(artifact.evidenceClass)}</td>
          <td>${artifact.valid ? 'valid' : 'invalid'}</td>
          <td>${artifact.passed ? 'passed' : 'negative / incomplete'}</td>
        </tr>`
      )
      .join('')}</tbody>`;
}

/* ---- Finding list ---------------------------------------------------- */

function tagsFor(item) {
  const tags = [];
  if (item.type && item.type !== 'finding') tags.push({ text: item.type });
  if (item.origin === 'human') tags.push({ text: '✎ human', status: 'human' });
  if (item.pinned) tags.push({ text: '★ pinned', status: 'pinned' });
  // Status always carries a glyph AND a word, so it never depends on colour.
  if (item.stale) tags.push({ text: '⚠ stale', status: 'stale' });
  tags.push({ text: `confidence ${(item.confidence ?? 0.5).toFixed(2)}` });
  return tags;
}

/** Tag markup with every value escaped, shared by the list and audit views. */
function renderTags(item) {
  return tagsFor(item)
    .map(
      (t) =>
        `<span class="wiki-tag"${t.status ? ` data-status="${escapeHtml(t.status)}"` : ''}>${escapeHtml(t.text)}</span>`
    )
    .join('');
}

function renderList(append) {
  const list = el('wiki-list');
  const html = state.items
    .map(
      (item) => `
    <li tabindex="0" data-id="${escapeHtml(item.id)}" data-key="${escapeHtml(item.key)}"
        aria-current="${state.selected === item.id}">
      <span class="wiki-claim">${escapeHtml(item.claim || item.key)}</span>
      <span class="wiki-tags">${renderTags(item)}</span>
    </li>`
    )
    .join('');

  if (append) list.insertAdjacentHTML('beforeend', html);
  else list.innerHTML = html;
}

/**
 * Escapes text for HTML interpolation.
 *
 * EVERY graph-derived value goes through this, not just `claim`. The graph is
 * built from repository files by an agent, so its contents are not trusted
 * input: a file named `"><img onerror=...>` or a harvested `type` reaches the
 * dashboard verbatim otherwise. Attribute values are quoted AND escaped, since
 * an unescaped `"` in `data-key` breaks out of the attribute entirely.
 */
function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]
  );
}

async function search(append = false) {
  const query = el('wiki-search').value.trim();
  const type = el('wiki-type').value;
  if (!append) state.offset = 0;

  const params = new URLSearchParams({
    q: query,
    type,
    offset: String(state.offset),
    limit: '50',
  });
  const result = await api(`/api/wiki/search?${params}`);

  state.items = append ? state.items.concat(result.items) : result.items;
  state.offset += result.items.length;

  renderList(append);
  el('wiki-count').textContent = `${state.items.length} of ${result.total}`;
  el('wiki-more-btn').hidden = state.offset >= result.total;
}

/* ---- Graph ----------------------------------------------------------- */

function clearGraph() {
  const svg = el('wiki-graph');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}

/** Current pane size in real pixels, measured at draw time. */
function paneSize() {
  const box = el('wiki-graph').getBoundingClientRect();
  return { width: Math.max(320, box.width), height: Math.max(320, box.height) };
}

function drawNode(svg, node, x, y, isCentre) {
  const group = document.createElementNS(svgNS, 'g');
  group.setAttribute('class', `wiki-node${isCentre ? ' is-center' : ''}`);
  group.setAttribute('transform', `translate(${x},${y})`);
  group.setAttribute('tabindex', '0');
  group.dataset.id = node.id;

  const circle = document.createElementNS(svgNS, 'circle');
  circle.setAttribute('r', String(RADIUS[node.kind] || 8));
  circle.setAttribute('fill', colourFor(node.kind));
  group.appendChild(circle);

  // Identity is never colour-alone: the kind and a label ride with every mark.
  const label = document.createElementNS(svgNS, 'text');
  label.setAttribute('x', String((RADIUS[node.kind] || 8) + 6));
  label.setAttribute('y', '4');
  const caption =
    node.kind === 'finding'
      ? (node.claim || node.key).slice(0, 46)
      : node.name || node.key.split(/[\\/]/).pop();
  // A retired node stays reachable through `supersedes` edges -- that is how the
  // history of a claim remains legible -- so it must be marked here. Unlabelled,
  // it renders identically to a live finding.
  label.textContent = `${caption}${node.stale ? ' ⚠' : ''}${node.retired ? ' ⊘' : ''}`;
  group.appendChild(label);

  const title = document.createElementNS(svgNS, 'title');
  title.textContent = `${node.kind}: ${node.claim || node.key}`;
  group.appendChild(title);

  group.addEventListener('click', () => selectNode(node.id));
  group.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectNode(node.id);
    }
  });

  svg.appendChild(group);
  return group;
}

function drawEdge(svg, x1, y1, x2, y2, kind) {
  const line = document.createElementNS(svgNS, 'line');
  line.setAttribute('class', 'wiki-edge');
  line.setAttribute('x1', x1);
  line.setAttribute('y1', y1);
  line.setAttribute('x2', x2);
  line.setAttribute('y2', y2);
  svg.insertBefore(line, svg.firstChild);

  if (kind) {
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('class', 'wiki-edge-label');
    label.setAttribute('x', String((x1 + x2) / 2));
    label.setAttribute('y', String((y1 + y2) / 2 - 4));
    label.textContent = kind;
    svg.appendChild(label);
  }
}

/** FOCUS: one node, its neighbours on a ring. Bounded by degree, not graph size. */
async function renderFocus(nodeId) {
  const data = await api(`/api/wiki/node/${encodeURIComponent(nodeId)}`);
  const svg = el('wiki-graph');
  clearGraph();
  el('graph-hint').hidden = true;

  // The drawer is opened BEFORE measuring: it reflows the pane, and measuring
  // first is exactly what left the graph off-centre with clipped captions.
  showDetail(data.node);

  const { width, height } = paneSize();
  const cx = width / 2;
  const cy = height / 2;
  // Inset by the label gutter so captions stay on the canvas.
  const ring = Math.max(70, Math.min(cx - LABEL_GUTTER, cy - 60));

  data.neighbours.forEach((neighbour, index) => {
    const angle = (index / data.neighbours.length) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(angle) * ring;
    const y = cy + Math.sin(angle) * ring;
    const edge = data.edges.find(
      (e) => e.from === neighbour.id || e.to === neighbour.id
    );
    drawEdge(svg, cx, cy, x, y, edge && edge.edge);
    drawNode(svg, neighbour, x, y, false);
  });

  drawNode(svg, data.node, cx, cy, true);
  if (data.truncated) el('graph-hint').hidden = false;
  fitLabels(svg);
}

/**
 * CONSTELLATION: force-directed over the server-capped subgraph.
 *
 * The simulation runs a fixed number of ticks and stops. An endless physics
 * loop in a background tab is a laptop-fan problem, and the layout adds nothing
 * after it settles.
 */
async function renderConstellation() {
  const data = await api('/api/wiki/constellation?cap=150');
  const svg = el('wiki-graph');
  clearGraph();
  el('graph-hint').hidden = data.nodes.length > 0;

  const { width, height } = paneSize();

  const positions = new Map();
  data.nodes.forEach((node, index) => {
    // Seeded from the index rather than randomly, so a refresh does not
    // reshuffle a layout the user has just learned to read.
    const angle = index * 2.39996;
    const radius =
      20 +
      (index / data.nodes.length) *
        Math.min(width - LABEL_GUTTER * 2, height) *
        0.42;
    positions.set(node.id, {
      x: width / 2 + Math.cos(angle) * radius,
      y: height / 2 + Math.sin(angle) * radius,
    });
  });

  const REPULSION = 2600;
  const SPRING = 0.012;
  const IDEAL = 70;

  for (let tick = 0; tick < 160; tick++) {
    const cooling = 1 - tick / 160;

    for (const [idA, a] of positions) {
      for (const [idB, b] of positions) {
        if (idA === idB) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distance = Math.hypot(dx, dy) || 0.01;
        const force = (REPULSION / (distance * distance)) * cooling;
        a.x += (dx / distance) * force;
        a.y += (dy / distance) * force;
      }
    }

    for (const edge of data.edges) {
      const a = positions.get(edge.from);
      const b = positions.get(edge.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 0.01;
      const pull = (distance - IDEAL) * SPRING * cooling;
      a.x += (dx / distance) * pull;
      a.y += (dy / distance) * pull;
      b.x -= (dx / distance) * pull;
      b.y -= (dy / distance) * pull;
    }

    for (const point of positions.values()) {
      // Clamped inside the label gutter, not the raw canvas, so a node at the
      // boundary still has room for its caption.
      point.x = Math.max(LABEL_GUTTER, Math.min(width - LABEL_GUTTER, point.x));
      point.y = Math.max(24, Math.min(height - 24, point.y));
    }
  }

  // Labels sit on a single baseline per node, so two nodes at a similar height
  // overlap even when the MARKS are comfortably apart. The physics has no
  // notion of text, so a separate pass nudges colliding captions apart. Without
  // it, dense regions produce overlapping unreadable text -- visible only by
  // looking at the rendered page, never from the node coordinates alone.
  const LABEL_HEIGHT = 14;
  const ordered = [...positions.entries()].sort((a, b) => a[1].y - b[1].y);
  for (let i = 1; i < ordered.length; i++) {
    const [, previous] = ordered[i - 1];
    const [, current] = ordered[i];
    const sameSide = previous.x > width * 0.55 === current.x > width * 0.55;
    if (sameSide && current.y - previous.y < LABEL_HEIGHT) {
      current.y = Math.min(height - 24, previous.y + LABEL_HEIGHT);
    }
  }

  for (const edge of data.edges) {
    const a = positions.get(edge.from);
    const b = positions.get(edge.to);
    if (a && b) drawEdge(svg, a.x, a.y, b.x, b.y, null);
  }
  for (const node of data.nodes) {
    const point = positions.get(node.id);
    if (point) drawNode(svg, node, point.x, point.y, false);
  }
  fitLabels(svg);
}

/**
 * Corrects labels against what was ACTUALLY rendered.
 *
 * Predicting text width from character count does not work: font metrics vary
 * by glyph, family and platform, so a caption budget that fits on one machine
 * clips on another. Every attempt to solve clipping and overlap by guessing
 * ahead of time left a label off the canvas somewhere.
 *
 * So this measures the painted boxes and fixes them in two passes -- flip the
 * label inward, then trim it until it fits, then push colliding captions apart
 * vertically. It runs once per render and is bounded, so it cannot loop.
 */
function fitLabels(svg) {
  const bounds = svg.getBoundingClientRect();
  const labels = [...svg.querySelectorAll('.wiki-node text')];

  for (const label of labels) {
    let box = label.getBoundingClientRect();

    // Pass 1: if it runs off an edge, grow it the other way instead.
    if (
      box.right > bounds.right - 4 &&
      label.getAttribute('text-anchor') !== 'end'
    ) {
      label.setAttribute('text-anchor', 'end');
      label.setAttribute(
        'x',
        String(-Math.abs(Number(label.getAttribute('x')) || 14))
      );
      box = label.getBoundingClientRect();
    } else if (
      box.left < bounds.left + 4 &&
      label.getAttribute('text-anchor') === 'end'
    ) {
      label.removeAttribute('text-anchor');
      label.setAttribute(
        'x',
        String(Math.abs(Number(label.getAttribute('x')) || 14))
      );
      box = label.getBoundingClientRect();
    }

    // Pass 2: still overflowing, so trim. A visibly shortened label beats a
    // silently cut one -- the reader can see that there is more.
    let text = label.textContent;
    let guard = 0;
    while (
      (box.right > bounds.right - 4 || box.left < bounds.left + 4) &&
      text.length > 6 &&
      guard++ < 60
    ) {
      text = text.slice(0, -3);
      label.textContent = text.replace(/…?$/, '…');
      box = label.getBoundingClientRect();
    }
  }

  // Pass 3: vertical de-overlap on the real boxes. Only the LABEL moves, never
  // the node, so the edges stay attached to the marks they describe.
  const ordered = labels
    .map((label) => ({ label, box: label.getBoundingClientRect() }))
    .sort((a, b) => a.box.top - b.box.top);

  for (let i = 1; i < ordered.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = ordered[j].box;
      const b = ordered[i].box;
      const overlaps =
        a.left < b.right &&
        b.left < a.right &&
        a.top < b.bottom &&
        b.top < a.bottom;
      if (!overlaps) continue;
      const shift = a.bottom - b.top + 2;
      const current = Number(ordered[i].label.getAttribute('y')) || 0;
      ordered[i].label.setAttribute('y', String(current + shift));
      ordered[i].box = ordered[i].label.getBoundingClientRect();
    }
  }
}

/* ---- Detail and curation --------------------------------------------- */

/**
 * Opens or closes the drawer.
 *
 * The body class is what reserves the page gutter so the drawer never covers
 * the controls behind it. Routing every open and close through here is what
 * stops the class and the hidden flag drifting apart -- which would leave the
 * page permanently indented, or the drawer silently swallowing clicks.
 */
function setDetailOpen(open) {
  el('wiki-detail').hidden = !open;
  document.body.classList.toggle('wiki-detail-open', open);
}

function showDetail(node) {
  const panel = el('wiki-detail');
  setDetailOpen(true);
  panel.innerHTML = `
    <button class="btn" id="detail-close">Close</button>
    <h3>${escapeHtml(node.claim || node.key)}</h3>
    <dl>
      <dt>Kind</dt><dd>${escapeHtml(node.kind)}</dd>
      <dt>Type</dt><dd>${escapeHtml(node.type || '—')}</dd>
      <dt>Origin</dt><dd>${node.origin === 'human' ? '✎ asserted by a person' : 'harvested from a session'}</dd>
      <dt>Confidence</dt><dd class="wiki-figure">${(node.confidence ?? 0.5).toFixed(2)}</dd>
      <dt>Calibration</dt><dd>${escapeHtml(node.confidenceLabel || 'legacy/unlabelled')}</dd>
      <dt>Scope</dt><dd>${escapeHtml(node.scope || 'project')}</dd>
      <dt>Applies when</dt><dd>${escapeHtml(node.applicability || 'legacy finding: unspecified')}</dd>
      <dt>Evidence</dt><dd>${escapeHtml(node.evidence || 'legacy finding: unspecified')}</dd>
      <dt>Invalidated by</dt><dd>${escapeHtml((node.invalidators || []).join('; ') || 'anchor changes')}</dd>
      <dt>Status</dt><dd>${node.stale ? '⚠ stale' : 'current'}</dd>
    </dl>
    ${node.snapshot ? `<div class="wiki-diff">${escapeHtml(node.snapshot.slice(0, 2000))}</div>` : ''}
    ${
      node.kind === 'finding'
        ? `
      <textarea id="detail-claim" placeholder="Correct this claim…"></textarea>
      <div class="wiki-actions">
        <button class="btn btn-primary" id="detail-correct">Save correction</button>
        <button class="btn" id="detail-pin">${node.pinned ? 'Unpin' : 'Pin'}</button>
        <button class="btn" id="detail-retire">Retire</button>
        <button class="btn" id="detail-helpful">Helpful</button>
        <button class="btn" id="detail-harmful">Harmful</button>
      </div>
      <p class="wiki-muted">Corrections append: the original is retired and kept,
      so the record shows what changed and when.</p>`
        : ''
    }`;

  el('detail-close').addEventListener('click', () => setDetailOpen(false));

  if (node.kind !== 'finding') return;

  const curate = async (body) => {
    await api('/api/wiki/curate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-token-optimizer': 'dashboard',
      },
      body: JSON.stringify({ key: node.key, ...body }),
    });
    setDetailOpen(false);
    await Promise.all([search(), loadAudit()]);
  };

  el('detail-correct').addEventListener('click', () => {
    const claim = el('detail-claim').value.trim();
    if (claim) curate({ action: 'correct', claim });
  });
  el('detail-pin').addEventListener('click', () =>
    curate({ action: 'pin', pinned: !node.pinned })
  );
  el('detail-retire').addEventListener('click', () =>
    curate({ action: 'retire' })
  );
  const feedback = async (rating) => {
    await api('/api/wiki/evidence/feedback', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-token-optimizer': 'dashboard',
      },
      body: JSON.stringify({ findingId: node.key, rating }),
    });
    await loadEvidence();
  };
  el('detail-helpful').addEventListener('click', () => feedback('helpful'));
  el('detail-harmful').addEventListener('click', () => feedback('harmful'));
}

/**
 * Switches view mode, updating state AND the controls together.
 *
 * They were set in two places that could disagree. Selecting a node while
 * Constellation was active rendered a FOCUS graph without changing `state.mode`,
 * so the toggle still read "Constellation" -- and the next re-render (a resize,
 * or the drawer opening) honoured the stale mode and threw the selection away.
 * The user saw their click undo itself.
 */
function setMode(mode) {
  state.mode = mode;
  const focus = mode === 'focus';
  el('mode-focus').classList.toggle('is-active', focus);
  el('mode-constellation').classList.toggle('is-active', !focus);
  el('mode-focus').setAttribute('aria-pressed', String(focus));
  el('mode-constellation').setAttribute('aria-pressed', String(!focus));
}

async function selectNode(nodeId) {
  // Selecting a node IS a focus action, whatever mode was active before.
  setMode('focus');
  state.selected = nodeId;
  document
    .querySelectorAll('.wiki-list li')
    .forEach((li) =>
      li.setAttribute('aria-current', String(li.dataset.id === nodeId))
    );
  await renderFocus(nodeId);
}

/* ---- Audit ----------------------------------------------------------- */

const AUDIT_GROUPS = [
  [
    'contradicted',
    'Contradicted',
    'Two findings disagree. Nothing resolves this automatically — until someone decides, both are being served.',
  ],
  [
    'stale',
    'Stale',
    'The anchor changed. These are served with the invalidating diff attached.',
  ],
  [
    'orphaned',
    'Unanchored',
    'No anchor, so these can never be checked against the code again. The most dangerous nodes in the graph.',
  ],
  [
    'lowConfidence',
    'Low confidence',
    'Extracted with little support. Worth confirming or retiring.',
  ],
];

async function loadAudit() {
  let audit;
  try {
    audit = await api('/api/wiki/audit');
  } catch {
    return;
  }

  const badge = el('audit-count');
  badge.hidden = audit.total === 0;
  badge.textContent = String(audit.total);

  el('audit-groups').innerHTML =
    AUDIT_GROUPS.map(([key, title, blurb]) => {
      const items = audit[key] || [];
      if (!items.length) return '';
      return `
      <section class="wiki-balance">
        <h2>${title} <span class="wiki-muted">(${items.length})</span></h2>
        <p class="wiki-muted">${blurb}</p>
        <ol class="wiki-list">${items
          .map(
            (item) => `
          <li tabindex="0" data-id="${escapeHtml(item.id)}">
            <span class="wiki-claim">${escapeHtml(item.claim || item.key)}</span>
            <span class="wiki-tags">${renderTags(item)}</span>
          </li>`
          )
          .join('')}</ol>
      </section>`;
    }).join('') ||
    '<p class="wiki-muted">Nothing needs attention. The graph is healthy.</p>';
}

/* ---- Wiring ---------------------------------------------------------- */

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

document.addEventListener('click', (event) => {
  const item = event.target.closest('.wiki-list li');
  if (item && item.dataset.id) selectNode(item.dataset.id);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setDetailOpen(false);
});

el('wiki-search').addEventListener(
  'input',
  debounce(() => search(), 250)
);
el('wiki-type').addEventListener('change', () => search());
el('wiki-more-btn').addEventListener('click', () => search(true));
for (const id of ['evidence-client', 'evidence-model', 'evidence-task']) {
  el(id).addEventListener('input', debounce(loadEvidence, 250));
}
el('evidence-arm').addEventListener('change', loadEvidence);

el('mode-focus').addEventListener('click', () => {
  setMode('focus');
  if (state.selected) renderFocus(state.selected);
});

el('mode-constellation').addEventListener('click', () => {
  setMode('constellation');
  renderConstellation();
});

document.querySelectorAll('.wiki-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.wiki-tab').forEach((t) => {
      t.classList.toggle('is-active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    });
    document.querySelectorAll('.wiki-panel').forEach((panel) => {
      panel.hidden = panel.id !== `tab-${tab.dataset.tab}`;
    });
    // The drawer describes a selection made in the tab being left, so leaving it
    // open shows detail for something no longer on screen.
    setDetailOpen(false);
  });
});

/**
 * Re-render when the pane actually changes size.
 *
 * Covers the drawer opening and closing, window resizes, and the responsive
 * breakpoints -- every case where a previously-correct layout silently becomes
 * wrong. Debounced so a drag-resize does not run the force simulation on every
 * frame.
 */
const reRender = debounce(() => {
  if (state.mode === 'constellation') renderConstellation();
  else if (state.selected) renderFocus(state.selected);
}, 200);

if (typeof ResizeObserver !== 'undefined') {
  let lastWidth = 0;
  new ResizeObserver((entries) => {
    const width = Math.round(entries[0].contentRect.width);

    // A HIDDEN pane is not a resize worth reacting to. Switching to the Audit
    // tab hides Explore, which collapses this pane to zero width and fired the
    // observer -- which re-rendered, which called showDetail, which RE-OPENED
    // the drawer a moment after the user had navigated away. Re-rendering
    // something nobody can see is wasted work even without that side effect.
    if (width === 0 || el('tab-explore').hidden) {
      lastWidth = 0;
      return;
    }

    // Width only: the drawer changes width, and reacting to sub-pixel height
    // jitter would re-render continuously.
    if (Math.abs(width - lastWidth) > 8) {
      lastWidth = width;
      reRender();
    }
  }).observe(el('wiki-graph'));
}

(async function init() {
  try {
    const status = await api('/api/wiki/status');
    el('graph-stats').textContent = status.available
      ? `${status.findings} findings · ${status.nodes} nodes · ${status.edges} edges`
      : 'No graph yet — it builds as you work';
    if (!status.available) return;
  } catch {
    el('graph-stats').textContent = 'Graph unavailable';
    return;
  }
  await Promise.all([
    loadBalance(),
    search(),
    loadAudit(),
    loadEvidence(),
    loadUcr(),
  ]);
})();
