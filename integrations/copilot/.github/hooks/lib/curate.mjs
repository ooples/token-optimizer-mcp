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

import { randomBytes } from 'node:crypto';
import { putNode, putEdge, putNodeWithEdges, load, nodeId } from './wiki.mjs';
import { indexFile } from './staleness.mjs';
import { symbolKey } from './symbols.mjs';
import { canonicalPath } from './paths.mjs';

/** Alias so `create` can re-read the graph after indexing an anchor. */
const loadGraph = load;

export const ORIGIN_HARVESTED = 'harvested';
export const ORIGIN_HUMAN = 'human';

/**
 * Written deliberately by the agent that did the work, via wiki_write.
 *
 * Distinct from ORIGIN_HARVESTED on purpose. Harvested means a cheap model read
 * a transcript afterwards and inferred a claim from it; this means the session
 * that actually did the reasoning recorded its own conclusion while it still
 * held the context. Those deserve different trust, and collapsing them would
 * destroy exactly the calibration that the origin field exists to provide.
 */
export const ORIGIN_AGENT = 'agent';

/** Ranking multiplier for human-asserted findings. */
export const HUMAN_WEIGHT = 1.5;

/**
 * Ranking multiplier for agent-written findings. Above a post-hoc extraction
 * because the writer held the context; below a person because it is still a
 * model asserting something about its own work.
 */
export const AGENT_WEIGHT = 1.2;

/**
 * The one provenance ranking table.
 *
 * Exported as a FUNCTION rather than left to each caller to assemble, because
 * the alternative already failed twice: HUMAN_WEIGHT sat declared and unread
 * until wiki.mjs worked around it with a private duplicate table, and
 * AGENT_WEIGHT is still unread today -- so an agent finding ranks level with a
 * post-hoc guess in the dashboard search while findingsFor ranks it correctly.
 * Two rankings that disagree is worse than one that is wrong.
 */
export function originWeight(origin) {
  if (origin === ORIGIN_HUMAN) return HUMAN_WEIGHT;
  if (origin === ORIGIN_AGENT) return AGENT_WEIGHT;
  return 1;
}

/**
 * The claim-time anchor hashes, for a finding being written right now.
 *
 * THE CHECKABLE HALF OF PROVENANCE, and until now only `harvest-write.mjs`
 * wrote it -- so the asymmetry ran exactly the wrong way. `reverify` and the
 * automatic clear in `serve` both compare disk against these frozen hashes, and
 * a finding without them can never have a stale flag cleared by anything. That
 * meant HUMAN-asserted findings, the ones somebody deliberately created or
 * corrected, were the only ones condemned to stay stale forever once marked,
 * while machine-harvested claims could recover. The hashes are simply the anchor
 * nodes' hashes at this moment, and every writer has them in hand.
 *
 * DELIBERATELY NOT THE WHOLE RECORD `derivationFor` BUILDS. That one joins the
 * evidence log to find FILE-surface operations behind the claim; curation
 * performs no such join, so `operations` is empty and `operationsComplete` says
 * so. An empty list declared incomplete is honest -- "nothing recorded here, and
 * do not read that as nothing happened" -- where an empty list declared complete
 * would assert a fact nobody established.
 *
 * An anchor with no stored hash contributes no entry, and a finding whose
 * anchors all lack one gets a record with no hashes -- which `claimTimeVerdict`
 * reads as `unknown` and refuses to clear on, which is the correct reading.
 */
function claimTimeDerivation(graph, resolved) {
  const anchors = {};
  for (const id of resolved) {
    const node = graph.nodes.get(id);
    if (node && typeof node.hash === 'string') anchors[id] = node.hash;
  }
  return { at: Date.now(), anchors, operations: [], operationsComplete: false };
}

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
export function correct(
  dir,
  key,
  claim,
  { confidence = 0.95, origin = ORIGIN_HUMAN } = {}
) {
  const graph = load(dir);
  const existing = findingByKey(graph, key);
  if (!existing) return false;

  // ORDER MATTERS, AND SO DOES CHECKING. `append` fails open -- it swallows
  // write errors and returns false -- so retiring first and then failing to
  // write the replacement would delete the claim outright: gone from
  // activeFindings, from the export, and from every read path, with nothing put
  // in its place.
  //
  // Writing the successor first was necessary but NOT sufficient. putNode
  // discards appendAll's boolean and returns an id unconditionally, so this
  // function could not observe a failed write and retired the original anyway.
  // One transient EBUSY -- routine on Windows, and withLock gives up after 20
  // attempts and proceeds regardless -- was enough to destroy a human's
  // curated claim while the API replied ok.
  //
  // putNodeWithEdges returns null on a failed append AND writes the node, the
  // supersedes link and every inherited anchor as ONE append, so a partial
  // write cannot leave an unanchored successor either.
  const originalId = nodeId('finding', key);
  const replacementKey = `${key}-c${Date.now().toString(36)}`;

  const edges = [{ edge: 'supersedes', to: originalId }];
  // Collected alongside the edges so the correction carries its own claim-time
  // hashes: it is a NEW claim, re-derived against whatever the code says now, so
  // its evidence is the anchors' current state -- not the predecessor's, which is
  // precisely what went stale.
  const inherited = [];
  // The correction inherits the original's anchors, so it can go stale too --
  // but it inherits NOTHING ELSE, and that is deliberate rather than incidental.
  // The node written below is built field by field from `existing` instead of
  // spreading it, which is what keeps the staleness fields (`stale`,
  // `staleReason`, `diff`) off the successor: a correction is re-derived
  // against the current code by definition, so being born carrying its
  // predecessor's invalidation would discount it the moment it existed --
  // `disclose.mjs` skips a stale finding outright and `utility.mjs` penalises
  // one by 160. Any future edit here that reaches for `...existing` to pick up
  // one more field re-introduces that, since `putNode` writes what it is handed
  // wholesale; `tests/hooks/stale-clearing.test.mjs` is the guard.
  for (const edge of graph.edges) {
    if (edge.edge === 'derived_from' && edge.from === originalId) {
      edges.push({ edge: 'derived_from', to: edge.to });
      inherited.push(edge.to);
    }
  }

  const written = putNodeWithEdges(
    dir,
    {
      kind: 'finding',
      key: replacementKey,
      claim,
      confidence,
      type: existing.type || 'finding',
      // PINNED SURVIVES A CORRECTION. The pin is an explicit human act about the
      // subject matter, not about the wording, and the original that carried it
      // is retired below -- so not copying it silently un-pins the fact and it
      // stops being injected as a standing rule (inject.mjs selects on
      // `n.pinned === true`). Correcting a claim must not demote it.
      ...(existing.pinned ? { pinned: true } : {}),
      // THE CALLER'S ORIGIN, not an assumption. This stamped ORIGIN_HUMAN
      // unconditionally, so a correction written by an agent -- or carried over
      // from a harvested claim -- was recorded as a person's assertion. That is
      // the exact confusion the origin field exists to prevent, and the one
      // harvest-write.mjs refuses to create when it writes a finding: "a
      // hand-written assertion and a machine guess look identical three months
      // later, which quietly destroys the reader's ability to calibrate trust".
      // It also outranks its own source, since human findings carry the highest
      // ranking weight.
      //
      // Defaults to ORIGIN_HUMAN because curate is the hand-curation path, so
      // every existing caller keeps its current behaviour. Deliberately NOT
      // validated against a fixed list: the set of origins differs across
      // branches, and an unrecognised value already degrades to the neutral
      // ranking weight rather than doing damage.
      origin: typeof origin === 'string' && origin ? origin : ORIGIN_HUMAN,
      // Without this a correction could never have a stale flag cleared: both
      // clearing paths compare disk against these hashes, and a finding with
      // none is `unknown` forever. A hand-written correction being the least
      // recoverable record in the graph was the wrong way round.
      derivation: claimTimeDerivation(graph, inherited),
    },
    edges
  );

  // NOTHING IS RETIRED UNTIL THE SUCCESSOR IS ON DISK.
  if (!written) return false;

  putNode(dir, { ...existing, kind: 'finding', key, retired: true });
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
 * Records that one finding disagrees with another.
 *
 * AN EDGE, NOT AN OVERWRITE -- the design is explicit about why: "when a belief
 * changes, the graph should record THAT it changed and why, not quietly present
 * the new one as though it had always been true." `contradicts` has been in
 * EDGE_KINDS since the schema existed and was written by nothing, while
 * `audit()` already READ it.
 *
 * The contradicted finding is deliberately NOT retired, and its claim is
 * deliberately preserved. A reader needs to see both claims and the
 * disagreement between them; retiring one silently picks a winner, and putNode
 * does not merge -- it writes the whole record from what it is handed, so
 * annotating the target without spreading it back in would blank the very claim
 * this edge exists to keep visible. That is the overwrite by another name.
 *
 * THE EDGE IS WRITTEN FIRST, and the order is the guarantee. These are two
 * appends and `append` fails open, so either can be the one that lands. Edge
 * without annotation is a complete, readable disagreement missing only its
 * reason. Annotation without edge is a finding that says "something contradicts
 * me" with no contradictor -- a claim of proof with no proof, and invisible to
 * `audit()` and to `hasOutstandingContradiction`, both of which read the edge.
 */
export function contradict(dir, { key, byKey, reason }) {
  const graph = load(dir);
  const target = findingByKey(graph, key);
  const source = findingByKey(graph, byKey);
  // Both ends must exist, or the edge is unresolvable and the disagreement is
  // recorded against nothing -- the same un-invalidatable shape anchors prevent.
  if (!target || !source) return false;
  // A finding cannot disagree with itself. The self-edge resolves, so the guard
  // above waves it through, and the result is a node permanently blocked from
  // confidence promotion by a dispute no person can ever resolve: there is no
  // second claim to choose between.
  if (target.id === source.id) return false;

  putEdge(dir, source.id, 'contradicts', target.id);
  putNode(dir, {
    ...target,
    kind: 'finding',
    key,
    contradictedAt: Date.now(),
    contradictionReason: String(reason || '').slice(0, 400),
  });
  return true;
}

/**
 * Whether anything currently disagrees with this finding.
 *
 * Gates confidence promotion. Plan 2's per-finding utility measures whether a
 * finding SUPPRESSES READS, and a confidently wrong finding suppresses reads
 * better than a hedged true one -- so utility must never raise confidence on
 * its own, and this is the check that stops it.
 *
 * SYMMETRIC, deliberately: BOTH ends of a `contradicts` edge are outstanding
 * until a person resolves the disagreement. The named hazard in the design is
 * presenting "the new one as though it had always been true", so gating only
 * the older claim would leave the newer one -- which is just as likely to be
 * the wrong one, since nothing here adjudicates -- free to be promoted on
 * measured utility alone. That is the exact failure this gate exists to stop.
 * It also matches `audit()`, the reader that has always been here: it puts both
 * `from` and `to` in its `contradicted` bucket, because "until one looks, BOTH
 * are being served".
 *
 * A RETIRED COUNTERPART DOES NOT COUNT, and that sentence quoted just above is
 * the reason. This read edges ONLY, so retiring one end of a contradiction left
 * the survivor gated against confidence promotion forever and served with a
 * DISPUTED note naming a key `serve` refuses to hand anybody -- `serve`,
 * `activeFindings`, `findingsFor` and `sessionIndex` all drop a retired
 * finding. A retired claim is served to NOBODY, so "BOTH are being served" is
 * false and the premise of the gate is gone: only one claim is in play, and
 * there is nothing left to choose between. Retiring one end IS the person
 * looking that this gate was waiting for -- so the edge counts as open only
 * while NEITHER end is retired, answered the same way from both directions.
 *
 * AN UNRESOLVABLE END STILL COUNTS. An edge whose other side names no node
 * proves nothing about whether that claim was withdrawn, and the conservative
 * reading -- still disputed -- is the one that cannot promote a claim nobody
 * adjudicated.
 */
export function hasOutstandingContradiction(graph, key) {
  const node = findingByKey(graph, key);
  // A withdrawn claim is not in a dispute either: a dispute needs two claims in
  // play, and this one has been taken out of play. Without this the RETIRED end
  // still reported an open disagreement, which is the same defect from the other
  // side -- and the answer has to agree from both directions, since the gate is
  // symmetric on purpose.
  if (!node || node.retired) return false;
  return graph.edges.some((e) => {
    if (e.edge !== 'contradicts') return false;
    const otherId = e.from === node.id ? e.to : e.to === node.id ? e.from : null;
    if (!otherId) return false;
    const other = graph.nodes.get(otherId);
    return !other || !other.retired;
  });
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

  // THE ANCHOR NODE MUST EXIST, not just the edge pointing at its id.
  //
  // Writing a `derived_from` edge to an id nothing ever created produced a
  // finding that LOOKS anchored -- `audit()` counts it as such, because it
  // checks for the edge -- while `checkAnchor` can never run on it, because
  // there is no node to check. That is precisely the un-invalidatable finding
  // the required-anchors rule exists to prevent, arriving through the one door
  // the rule did not guard.
  const resolved = [];
  for (const anchor of anchors) {
    const [rawPath, symbol] = String(anchor).split('#');
    if (!rawPath) continue;
    const path = canonicalPath(rawPath);
    // Indexing creates the file node and its symbols with their hashes and
    // snapshots, which is what makes the claim checkable later.
    indexFile(dir, path);
    const target = symbol ? nodeId('symbol', symbolKey(path, symbol)) : nodeId('file', path);
    if (loadGraph(dir).nodes.has(target)) resolved.push(target);
  }

  // A claim about files that do not exist cannot be verified against anything,
  // so it is refused rather than stored as permanently-current.
  if (!resolved.length) return null;

  // A bare millisecond is NOT unique: two creates landing in the same tick hash
  // to the same node id, and wiki.mjs's fold keeps only the last -- so one
  // person's claim silently replaces another's while both HTTP responses report
  // ok, and the survivor inherits the union of both claims' anchors. Same random
  // suffix harvest-write.mjs already applies for the same reason.
  const key = `human-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

  // ONE APPEND for the finding and every anchor it resolved, and the key is only
  // reported when that append is confirmed. Writing the node and then looping
  // putEdge let a single failed edge append leave an active, human-origin,
  // high-confidence finding anchored to NOTHING -- staleness can never mark it
  // and audit() lists it under `orphaned`, which this file calls the most
  // dangerous nodes in the graph. That is exactly the record the block above
  // refuses to create, arriving through the write path instead of the resolve
  // path. No process death required; one transient EBUSY is enough.
  const id = putNodeWithEdges(
    dir,
    {
      kind: 'finding',
      key,
      claim,
      confidence,
      type,
      origin: ORIGIN_HUMAN,
      // Read AFTER the indexFile loop above, so the hashes are the ones the
      // person's claim was actually made against rather than whatever the graph
      // held before this call touched it.
      derivation: claimTimeDerivation(loadGraph(dir), resolved),
    },
    resolved.map((target) => ({ edge: 'derived_from', to: target }))
  );
  if (!id) return null;
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
  // An edge whose TARGET does not exist is not an anchor -- the finding can
  // never be checked against anything. Counting it as anchored is how an
  // un-invalidatable claim hides from the very report meant to surface it.
  const anchored = new Set(
    graph.edges
      .filter((e) => e.edge === 'derived_from' && graph.nodes.has(e.to))
      .map((e) => e.from)
  );

  // THE SAME DEFINITION OF AN OPEN DISPUTE as hasOutstandingContradiction, and
  // it has to be: that function's own comment claims it "matches audit()", and
  // two rankings that disagree about what needs a human is worse than one that
  // is wrong. A retired counterpart is a resolved dispute -- the retired claim
  // is served to nobody -- so the survivor is not one of two claims in play and
  // does not belong in the bucket of things needing a person to look.
  //
  // One pass, not a call per finding: this is a dashboard read over the whole
  // graph, and the obvious rewrite is O(findings x edges).
  const contradicted = new Set();
  for (const edge of graph.edges) {
    if (edge.edge !== 'contradicts') continue;
    const from = graph.nodes.get(edge.from);
    const to = graph.nodes.get(edge.to);
    // An end that resolves to nothing cannot be shown retired, so it still
    // counts against the other end.
    if (!to || !to.retired) contradicted.add(edge.from);
    if (!from || !from.retired) contradicted.add(edge.to);
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
        finding.origin === ORIGIN_AGENT ? 'agent' : null,
        finding.stale ? 'STALE' : null,
        finding.pinned ? 'pinned' : null,
      ].filter(Boolean);

      out.push(`- ${finding.claim}${tags.length ? ` _(${tags.join(', ')})_` : ''}`);
    }
    out.push('');
  }
  return out.join('\n');
}
