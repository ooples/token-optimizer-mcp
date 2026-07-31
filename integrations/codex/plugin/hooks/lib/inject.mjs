// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/inject.mjs. Regenerate with `npm run sync:hooks`.
/**
 * P4: getting knowledge to the model for less than it saves.
 *
 * Two layers, per the design: a bounded SessionStart index so the model knows
 * what the graph holds, and just-in-time injection when it reaches for a file.
 * The second is where the win lands, because it requires no query -- the model
 * receives what it would have spent 20k tokens deriving without ever needing to
 * know to ask.
 *
 * THE ZERO-TURN REFUSAL. A plain deny-and-redirect costs a full turn: the model
 * calls Read, is refused, re-plans, calls smart_read. But at refusal time this
 * process already holds the file on disk AND the snapshot the graph stored, so
 * it can compute the diff itself and put it INSIDE the refusal. The model asked
 * a question and the refusal contains the answer, so there is nothing to
 * re-plan and no second call. Turn cost drops from one to zero, and the token
 * cost drops from a whole file to a diff.
 *
 * That is the difference between a tool that nags and a tool that helps.
 */

import { readFileSync } from 'node:fs';
import { findingsFor, putNode, putEdge, nodeId } from './wiki.mjs';
import { serve, diffLines } from './staleness.mjs';
import { inHoldout, record, indexBudget } from './metrics.mjs';
import { canonicalPath, resolvableCandidates } from './paths.mjs';
import { annotatedSkeleton } from './skeleton.mjs';
import { substitutionBudget } from './metrics.mjs';

// Read per call for the same reason as the holdout fraction in metrics.mjs.
const touchBudget = () => Number(process.env.TOKEN_OPTIMIZER_TOUCH_BUDGET) || 500;
const estimate = (text) => Math.ceil(String(text || '').length / 4);

/**
 * Fits findings into a token budget, best first.
 *
 * The bound is load-bearing rather than tidy: without it the most heavily
 * worked files accumulate the most findings and become the most expensive to
 * touch, and the optimizer becomes its own token problem.
 */
function fit(findings, budget) {
  const kept = [];
  let spent = 0;
  for (const finding of findings) {
    const cost = estimate(render(finding));
    if (spent + cost > budget) continue;
    kept.push(finding);
    spent += cost;
  }
  return { kept, spent };
}

function render(finding) {
  const head = `- [${finding.type || 'finding'}] ${finding.claim}`;
  if (!finding.stale) return head;
  // A stale finding NEVER renders without its evidence. Serving one bare would
  // be worse than having no graph at all.
  return `${head}\n  STALE (${finding.staleReason}). What changed:\n${finding.diff}`;
}

/**
 * What the model sees when it touches a file.
 *
 * Returns null when there is nothing to say, or when this touch fell into the
 * measurement holdout -- in which case the caller must behave exactly as if the
 * graph were empty, or the experiment measures nothing.
 */
export function forTouch(dir, graph, rawPath, { budget = touchBudget(), sessionId } = {}) {
  // Canonical, so a touch finds findings anchored under any other spelling.
  const filePath = canonicalPath(rawPath);
  const anchorId = nodeId('file', filePath);
  const candidates = findingsFor(graph, anchorId, { limit: 30 });
  if (!candidates.length) return null;

  const holdout = inHoldout(filePath);
  const served = serve(graph, candidates);
  const { kept, spent } = fit(served, budget);

  record(dir, {
    kind: 'inject',
    anchor: filePath,
    holdout,
    tokens: holdout ? 0 : spent,
    count: kept.length,
    stale: kept.some((f) => f.stale),
    sessionId,
  });

  if (holdout || !kept.length) return null;

  return `Known about ${filePath} (from previous sessions):\n${kept.map(render).join('\n')}`;
}

/**
 * The bounded SessionStart index: titles and ids only, never bodies.
 *
 * Its budget is EARNED from measured hit rate rather than fixed, so a mature
 * graph that demonstrably gets queried grows its allowance while a noisy one
 * shrinks toward the floor. See metrics.indexBudget.
 */
export function sessionIndex(dir, graph) {
  const budget = indexBudget(dir);
  // RETIRED findings must not appear. They are excluded from every other read
  // path, so listing them here would advertise claims a human has explicitly
  // withdrawn -- and the index is the first thing the model reads.
  const findings = [...graph.nodes.values()]
    .filter((n) => n.kind === 'finding' && !n.retired && typeof n.claim === 'string');
  if (!findings.length) return null;

  const now = Date.now();
  const ranked = findings.sort((a, b) =>
    ((b.confidence || 0.5) / (1 + (now - (b.at || now)) / 2.6e9)) -
    ((a.confidence || 0.5) / (1 + (now - (a.at || now)) / 2.6e9)));

  const lines = [];
  let spent = 0;
  for (const finding of ranked) {
    const line = `- ${finding.key}: ${finding.claim.slice(0, 90)}`;  // claim guaranteed above
    const cost = estimate(line);
    if (spent + cost > budget) break;
    lines.push(line);
    spent += cost;
  }
  if (!lines.length) return null;

  record(dir, { kind: 'index', count: lines.length, tokens: spent });

  return `# Project wiki (${findings.length} findings, ${lines.length} listed)

Established in previous sessions. Call wiki_query with a key for detail, or just
work -- findings anchored to a file are surfaced automatically when you touch it.

${lines.join('\n')}`;
}

/**
 * The zero-turn refusal payload.
 *
 * When the model re-reads a file the graph has a snapshot of, the refusal can
 * carry the diff instead of merely pointing at smart_read. The model gets the
 * answer inside the refusal, so no second call is needed at all.
 *
 * Returns null when no snapshot exists, in which case the caller falls back to
 * the ordinary redirect -- this is an optimization on top of a working path,
 * never a replacement for it.
 */
/**
 * What a refusal returns INSTEAD of the file.
 *
 * Ordered by how much better than the file each option is:
 *
 *   1. UNCHANGED since the last read -- say so; there is nothing to send.
 *   2. CHANGED and we hold a snapshot -- send the diff.
 *   3. Otherwise -- send the annotated skeleton: structure plus every finding
 *      anchored to it, plus git history when nothing has been learned yet.
 *
 * Only (3) is new, and it is the one that inverts the interaction. A refusal
 * stops being a tax the model pays to get the real answer and becomes the most
 * informative response available -- more useful than the file, not a lossier
 * version of it.
 */
export function substitutionFor(dir, graph, rawPath, source) {
  const filePath = canonicalPath(rawPath);
  const budget = substitutionBudget(dir, filePath);
  const built = annotatedSkeleton(graph, rawPath, source, { budget });

  // A skeleton that is not meaningfully cheaper than the file saves nothing and
  // costs the model a round trip; send it back to the ordinary redirect.
  if (built.tokens * 4 > source.length * 0.5) return null;

  record(dir, {
    kind: 'substitute',
    anchor: filePath,
    tokens: built.tokens,
    findings: built.findings,
    symbols: built.symbols,
    bytesAvoided: source.length,
  });

  return built.text;
}

export function refusalPayload(graph, rawPath, { maxDiffLines = 60 } = {}) {
  const filePath = canonicalPath(rawPath);
  const anchor = graph.nodes.get(nodeId('file', filePath));
  if (!anchor || !anchor.snapshot) return null;

  let current = null;
  for (const candidate of resolvableCandidates(rawPath)) {
    try {
      current = readFileSync(candidate, 'utf8');
      break;
    } catch { /* try the next spelling */ }
  }
  if (current === null) return null;

  if (current === anchor.snapshot) {
    return `${filePath} is UNCHANGED since you last read it this session. ` +
      `Nothing to re-read -- use what you already have.`;
  }

  const diff = diffLines(anchor.snapshot, current, { maxLines: maxDiffLines });
  // A diff approaching the size of the file saves nothing; fall back.
  if (estimate(diff) > estimate(current) * 0.6) return null;

  return `${filePath} changed since you read it. Here is the diff, so you do not ` +
    `need to re-read it:\n\n${diff}`;
}

/**
 * Co-occurrence: files worked on together become weakly related.
 *
 * This closes the one real gap in traversal-only retrieval -- a finding that is
 * relevant but structurally unconnected -- WITHOUT an embedding model. It is
 * collaborative filtering over the agent's own attention: whatever gets opened
 * together is related, learned from behaviour rather than from vector geometry,
 * and it costs one edge write.
 *
 * Edges are capped per task so a session that touches 200 files does not write
 * 20,000 edges.
 */
export function linkCoOccurrence(dir, sessionId, paths, { maxLinks = 40 } = {}) {
  const unique = [...new Set(paths.map((p) => canonicalPath(p)))].slice(0, 12);
  let written = 0;

  for (let i = 0; i < unique.length && written < maxLinks; i++) {
    for (let j = i + 1; j < unique.length && written < maxLinks; j++) {
      putEdge(dir, nodeId('file', unique[i]), 'related', nodeId('file', unique[j]));
      written++;
    }
  }
  if (sessionId && unique.length) {
    putNode(dir, { kind: 'task', key: sessionId, files: unique.length });
  }
  return written;
}
