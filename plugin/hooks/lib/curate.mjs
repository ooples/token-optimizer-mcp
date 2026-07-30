// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/curate.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Human curation of the wiki, and export.
 *
 * The graph is written by an agent, but an agent is not always right, and the
 * cheapest fix for a wrong finding is a person correcting it. Everything here
 * APPENDS -- a correction is a new record that supersedes the old one, never an
 * edit in place -- so provenance survives and the whole graph still rebuilds
 * from the log.
 *
 * PROVENANCE IS EXPLICIT. Every node carries `origin`: 'harvested' when a model
 * extracted it, 'human' when a person asserted it. Without that field a
 * hand-written assertion and a machine guess look identical three months later,
 * which quietly destroys the reader's ability to calibrate trust in anything.
 *
 * Human findings are exempt from confidence DECAY -- a person's assertion does
 * not become less true because time passed -- but they are NOT exempt from
 * STALENESS. They still anchor to files, and when those files change the claim
 * is flagged like any other. Exempting them from staleness would create exactly
 * the un-invalidatable node the schema rules exist to prevent.
 */

import { putNode, putEdge, load, nodeId } from './wiki.mjs';

export const ORIGIN_HARVESTED = 'harvested';
export const ORIGIN_HUMAN = 'human';

/** Ranking multiplier for human-asserted findings. */
export const HUMAN_WEIGHT = 1.5;

function findingByKey(graph, key) {
  return graph.nodes.get(nodeId('finding', key)) || null;
}

/**
 * Pins a finding against decay. Pinned findings keep full weight regardless of
 * age -- for the architectural facts that stay true for years and would
 * otherwise sink below newer, noisier entries.
 */
export function pin(dir, key, pinned = true) {
  const existing = findingByKey(load(dir), key);
  if (!existing) return false;
  putNode(dir, { ...existing, kind: 'finding', key, pinned });
  return true;
}

/**
 * Corrects a claim.
 *
 * The old finding is retired and a new one supersedes it, rather than the text
 * being overwritten. Someone reading this graph later can see that the belief
 * changed, and what it changed from -- which is the same reason `contradicts`
 * is an edge rather than an overwrite.
 */
export function correct(dir, key, claim, { confidence = 0.95 } = {}) {
  const graph = load(dir);
  const existing = findingByKey(graph, key);
  if (!existing) return false;

  putNode(dir, { ...existing, kind: 'finding', key, retired: true });

  const replacementKey = `${key}-c${Date.now().toString(36)}`;
  putNode(dir, {
    kind: 'finding',
    key: replacementKey,
    claim,
    confidence,
    type: existing.type || 'finding',
    origin: ORIGIN_HUMAN,
  });

  const replacementId = nodeId('finding', replacementKey);
  putEdge(dir, replacementId, 'supersedes', nodeId('finding', key));

  // The correction inherits the original's anchors, so it can go stale too.
  for (const edge of graph.edges) {
    if (edge.edge === 'derived_from' && edge.from === nodeId('finding', key)) {
      putEdge(dir, replacementId, 'derived_from', edge.to);
    }
  }
  return replacementKey;
}

/** Retires a finding. Not deleted -- the log is the record of what was believed. */
export function retire(dir, key) {
  const existing = findingByKey(load(dir), key);
  if (!existing) return false;
  putNode(dir, { ...existing, kind: 'finding', key, retired: true });
  return true;
}

/**
 * Creates a finding by hand.
 *
 * Anchors are REQUIRED here for the same reason they are required of harvested
 * findings: without one the claim can never be checked against the code again.
 * A human is not more exempt from that than a model is.
 */
export function create(dir, { claim, anchors, type = 'finding', confidence = 0.95 }) {
  if (!claim || !Array.isArray(anchors) || !anchors.length) return null;

  const key = `human-${Date.now().toString(36)}`;
  const id = putNode(dir, { kind: 'finding', key, claim, confidence, type, origin: ORIGIN_HUMAN });

  for (const anchor of anchors) {
    const [path, symbol] = String(anchor).split('#');
    putEdge(dir, id, 'derived_from', symbol ? nodeId('symbol', `${path}#${symbol}`) : nodeId('file', path));
  }
  return key;
}

/** Live findings: retired ones are excluded from every read path. */
export function activeFindings(graph) {
  return [...graph.nodes.values()].filter((n) => n.kind === 'finding' && !n.retired);
}

/**
 * Findings that need a human to look at them.
 *
 * This is the audit view, and it is what actually protects against the
 * confidently-wrong-finding risk. Rot does not announce itself; it has to be
 * surfaced deliberately.
 */
export function audit(graph) {
  const findings = activeFindings(graph);
  const anchored = new Set(
    graph.edges.filter((e) => e.edge === 'derived_from').map((e) => e.from)
  );

  const contradicted = new Set();
  for (const edge of graph.edges) {
    if (edge.edge !== 'contradicts') continue;
    contradicted.add(edge.from);
    contradicted.add(edge.to);
  }

  return {
    // Two findings that disagree. Nothing else in the system resolves this --
    // it needs a person, and until one looks, BOTH are being served.
    contradicted: findings.filter((f) => contradicted.has(f.id)),
    // Unanchored findings should be impossible via the schema, so any that
    // exist came from an older version or a direct write, and can never go
    // stale. They are the most dangerous nodes in the graph.
    orphaned: findings.filter((f) => !anchored.has(f.id)),
    lowConfidence: findings.filter((f) => (f.confidence ?? 0.5) < 0.4),
    stale: findings.filter((f) => f.stale),
  };
}

/**
 * Exports the graph as markdown.
 *
 * Turns knowledge the agent accumulated as a by-product of working into
 * documentation a person can read, review, and commit. That inverts the usual
 * relationship: instead of humans writing docs that agents consume, the agent's
 * working memory becomes the first draft of the architecture notes.
 *
 * Stale and human-asserted findings are labelled rather than filtered, because
 * a reader deciding whether to trust a line needs to know which it is.
 */
export function exportMarkdown(graph, { title = 'Project knowledge' } = {}) {
  const findings = activeFindings(graph);
  if (!findings.length) return `# ${title}\n\n_No findings recorded yet._\n`;

  const byAnchor = new Map();
  for (const finding of findings) {
    const anchors = graph.edges
      .filter((e) => e.edge === 'derived_from' && e.from === finding.id)
      .map((e) => graph.nodes.get(e.to))
      .filter(Boolean);

    const label = anchors.length
      ? (anchors[0].kind === 'symbol' ? anchors[0].file : anchors[0].key)
      : '(unanchored)';
    if (!byAnchor.has(label)) byAnchor.set(label, []);
    byAnchor.get(label).push(finding);
  }

  const sections = [...byAnchor.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const out = [
    `# ${title}`,
    '',
    `Generated from the token-optimizer wiki graph: ${findings.length} findings ` +
    `across ${sections.length} files. Findings marked STALE have had their ` +
    `anchor change since they were established.`,
    '',
  ];

  for (const [anchor, group] of sections) {
    out.push(`## ${anchor}`, '');
    for (const finding of group.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))) {
      const tags = [
        finding.type && finding.type !== 'finding' ? finding.type : null,
        finding.origin === ORIGIN_HUMAN ? 'human' : null,
        finding.stale ? 'STALE' : null,
        finding.pinned ? 'pinned' : null,
      ].filter(Boolean);

      out.push(`- ${finding.claim}${tags.length ? ` _(${tags.join(', ')})_` : ''}`);
    }
    out.push('');
  }
  return out.join('\n');
}
