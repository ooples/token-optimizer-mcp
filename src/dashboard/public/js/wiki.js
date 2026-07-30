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
  return getComputedStyle(document.documentElement)
    .getPropertyValue(`--wiki-${kind}`).trim() || '#94a3b8';
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

  const tiles = [
    ['Findings injected', nf.format(balance.injections)],
    ['Held back as control', nf.format(balance.holdouts)],
    ['Tokens spent injecting', nf.format(balance.injectedTokens)],
    ['Tokens avoided (est.)', balance.estimatedTokensAvoided === null ? '—' : nf.format(balance.estimatedTokensAvoided)],
  ];

  el('balance-grid').innerHTML = tiles.map(([label, value]) => `
    <div class="stat-card">
      <div class="stat-content">
        <div class="stat-label">${label}</div>
        <div class="stat-value wiki-figure">${value}</div>
      </div>
    </div>`).join('');

  const verdict = el('balance-verdict');
  verdict.textContent = balance.verdict;
  verdict.dataset.state = !balance.sufficientData ? 'insufficient'
    : (balance.netTokens > 0 ? 'positive' : 'negative');

  if (balance.sufficientData) {
    el('balance-method').textContent =
      `Measured against ${nf.format(balance.holdouts)} withheld control touches — not estimated. ` +
      `Net after injection and harvest cost: ${nf.format(balance.netTokens)} tokens.`;
  }
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

function renderList(append) {
  const list = el('wiki-list');
  const html = state.items.map((item) => `
    <li tabindex="0" data-id="${item.id}" data-key="${item.key}"
        aria-current="${state.selected === item.id}">
      <span class="wiki-claim">${escapeHtml(item.claim || item.key)}</span>
      <span class="wiki-tags">${tagsFor(item)
        .map((t) => `<span class="wiki-tag"${t.status ? ` data-status="${t.status}"` : ''}>${t.text}</span>`)
        .join('')}</span>
    </li>`).join('');

  if (append) list.insertAdjacentHTML('beforeend', html);
  else list.innerHTML = html;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function search(append = false) {
  const query = el('wiki-search').value.trim();
  const type = el('wiki-type').value;
  if (!append) state.offset = 0;

  const params = new URLSearchParams({ q: query, type, offset: String(state.offset), limit: '50' });
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
  const caption = node.kind === 'finding'
    ? (node.claim || node.key).slice(0, 46)
    : (node.name || node.key.split(/[\\/]/).pop());
  label.textContent = `${caption}${node.stale ? ' ⚠' : ''}`;
  group.appendChild(label);

  const title = document.createElementNS(svgNS, 'title');
  title.textContent = `${node.kind}: ${node.claim || node.key}`;
  group.appendChild(title);

  group.addEventListener('click', () => selectNode(node.id));
  group.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectNode(node.id); }
  });

  svg.appendChild(group);
  return group;
}

function drawEdge(svg, x1, y1, x2, y2, kind) {
  const line = document.createElementNS(svgNS, 'line');
  line.setAttribute('class', 'wiki-edge');
  line.setAttribute('x1', x1); line.setAttribute('y1', y1);
  line.setAttribute('x2', x2); line.setAttribute('y2', y2);
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

  const box = svg.getBoundingClientRect();
  const cx = box.width / 2;
  const cy = box.height / 2;
  const ring = Math.min(cx, cy) - 90;

  data.neighbours.forEach((neighbour, index) => {
    const angle = (index / data.neighbours.length) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(angle) * ring;
    const y = cy + Math.sin(angle) * ring;
    const edge = data.edges.find((e) => e.from === neighbour.id || e.to === neighbour.id);
    drawEdge(svg, cx, cy, x, y, edge && edge.edge);
    drawNode(svg, neighbour, x, y, false);
  });

  drawNode(svg, data.node, cx, cy, true);
  if (data.truncated) el('graph-hint').hidden = false;
  showDetail(data.node);
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

  const box = svg.getBoundingClientRect();
  const width = box.width || 600;
  const height = box.height || 520;

  const positions = new Map();
  data.nodes.forEach((node, index) => {
    // Seeded from the index rather than randomly, so a refresh does not
    // reshuffle a layout the user has just learned to read.
    const angle = index * 2.39996;
    const radius = 20 + (index / data.nodes.length) * Math.min(width, height) * 0.42;
    positions.set(node.id, { x: width / 2 + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius });
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
      a.x += (dx / distance) * pull; a.y += (dy / distance) * pull;
      b.x -= (dx / distance) * pull; b.y -= (dy / distance) * pull;
    }

    for (const point of positions.values()) {
      point.x = Math.max(30, Math.min(width - 30, point.x));
      point.y = Math.max(24, Math.min(height - 24, point.y));
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
}

/* ---- Detail and curation --------------------------------------------- */

function showDetail(node) {
  const panel = el('wiki-detail');
  panel.hidden = false;
  panel.innerHTML = `
    <button class="btn" id="detail-close">Close</button>
    <h3>${escapeHtml(node.claim || node.key)}</h3>
    <dl>
      <dt>Kind</dt><dd>${node.kind}</dd>
      <dt>Type</dt><dd>${node.type || '—'}</dd>
      <dt>Origin</dt><dd>${node.origin === 'human' ? '✎ asserted by a person' : 'harvested from a session'}</dd>
      <dt>Confidence</dt><dd class="wiki-figure">${(node.confidence ?? 0.5).toFixed(2)}</dd>
      <dt>Status</dt><dd>${node.stale ? '⚠ stale' : 'current'}</dd>
    </dl>
    ${node.snapshot ? `<div class="wiki-diff">${escapeHtml(node.snapshot.slice(0, 2000))}</div>` : ''}
    ${node.kind === 'finding' ? `
      <textarea id="detail-claim" placeholder="Correct this claim…"></textarea>
      <div class="wiki-actions">
        <button class="btn btn-primary" id="detail-correct">Save correction</button>
        <button class="btn" id="detail-pin">${node.pinned ? 'Unpin' : 'Pin'}</button>
        <button class="btn" id="detail-retire">Retire</button>
      </div>
      <p class="wiki-muted">Corrections append: the original is retired and kept,
      so the record shows what changed and when.</p>` : ''}`;

  el('detail-close').addEventListener('click', () => { panel.hidden = true; });

  if (node.kind !== 'finding') return;

  const curate = async (body) => {
    await api('/api/wiki/curate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: node.key, ...body }),
    });
    panel.hidden = true;
    await Promise.all([search(), loadAudit()]);
  };

  el('detail-correct').addEventListener('click', () => {
    const claim = el('detail-claim').value.trim();
    if (claim) curate({ action: 'correct', claim });
  });
  el('detail-pin').addEventListener('click', () => curate({ action: 'pin', pinned: !node.pinned }));
  el('detail-retire').addEventListener('click', () => curate({ action: 'retire' }));
}

async function selectNode(nodeId) {
  state.selected = nodeId;
  document.querySelectorAll('.wiki-list li').forEach((li) =>
    li.setAttribute('aria-current', String(li.dataset.id === nodeId)));
  await renderFocus(nodeId);
}

/* ---- Audit ----------------------------------------------------------- */

const AUDIT_GROUPS = [
  ['contradicted', 'Contradicted', 'Two findings disagree. Nothing resolves this automatically — until someone decides, both are being served.'],
  ['stale', 'Stale', 'The anchor changed. These are served with the invalidating diff attached.'],
  ['orphaned', 'Unanchored', 'No anchor, so these can never be checked against the code again. The most dangerous nodes in the graph.'],
  ['lowConfidence', 'Low confidence', 'Extracted with little support. Worth confirming or retiring.'],
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

  el('audit-groups').innerHTML = AUDIT_GROUPS.map(([key, title, blurb]) => {
    const items = audit[key] || [];
    if (!items.length) return '';
    return `
      <section class="wiki-balance">
        <h2>${title} <span class="wiki-muted">(${items.length})</span></h2>
        <p class="wiki-muted">${blurb}</p>
        <ol class="wiki-list">${items.map((item) => `
          <li tabindex="0" data-id="${item.id}">
            <span class="wiki-claim">${escapeHtml(item.claim || item.key)}</span>
            <span class="wiki-tags">${tagsFor(item)
              .map((t) => `<span class="wiki-tag"${t.status ? ` data-status="${t.status}"` : ''}>${t.text}</span>`)
              .join('')}</span>
          </li>`).join('')}</ol>
      </section>`;
  }).join('') || '<p class="wiki-muted">Nothing needs attention. The graph is healthy.</p>';
}

/* ---- Wiring ---------------------------------------------------------- */

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

document.addEventListener('click', (event) => {
  const item = event.target.closest('.wiki-list li');
  if (item && item.dataset.id) selectNode(item.dataset.id);
});

el('wiki-search').addEventListener('input', debounce(() => search(), 250));
el('wiki-type').addEventListener('change', () => search());
el('wiki-more-btn').addEventListener('click', () => search(true));

el('mode-focus').addEventListener('click', () => {
  state.mode = 'focus';
  el('mode-focus').classList.add('is-active');
  el('mode-constellation').classList.remove('is-active');
  el('mode-focus').setAttribute('aria-pressed', 'true');
  el('mode-constellation').setAttribute('aria-pressed', 'false');
  if (state.selected) renderFocus(state.selected);
});

el('mode-constellation').addEventListener('click', () => {
  state.mode = 'constellation';
  el('mode-constellation').classList.add('is-active');
  el('mode-focus').classList.remove('is-active');
  el('mode-constellation').setAttribute('aria-pressed', 'true');
  el('mode-focus').setAttribute('aria-pressed', 'false');
  renderConstellation();
});

document.querySelectorAll('.wiki-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.wiki-tab').forEach((t) => {
      t.classList.toggle('is-active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    });
    el('tab-explore').hidden = tab.dataset.tab !== 'explore';
    el('tab-audit').hidden = tab.dataset.tab !== 'audit';
  });
});

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
  await Promise.all([loadBalance(), search(), loadAudit()]);
})();
