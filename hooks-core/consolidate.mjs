/**
 * Compaction as CONSOLIDATION.
 *
 * Every competing tool treats compaction as damage: checkpoint before it, restore
 * after, hope the summary kept the right things. That framing concedes the
 * event. Compaction is a forced consolidation -- transient episodic context
 * being compressed -- and the useful move is to promote what matters into
 * durable, anchored, stale-checkable knowledge on the way past. Done that way
 * every compaction leaves the graph RICHER than before it, which inverts the
 * event instead of surviving it.
 *
 * THE SELECTION RULE IS DERIVED, NOT A CATEGORY LIST. "Save decisions and dead
 * ends" is a guess about what matters. What actually matters is what cannot be
 * cheaply recovered:
 *
 *   value = cost-to-rederive x irrecoverability x reuse-probability
 *
 * with two structural facts layered on top:
 *
 *   - STRUCTURE IS FREE, so it is always kept. Which files and symbols were
 *     touched costs almost nothing to store and is what orients a fresh context.
 *   - DEAD ENDS HAVE A FLOOR, so they survive regardless of score. A negative
 *     result exists nowhere else -- not in the code, not in the docs, not in the
 *     commit log -- and it is small. Ranking alone would drop a cheaply-found
 *     dead end, and cheap to FIND is not the same as cheap to find AGAIN.
 *
 * Cost is measured rather than guessed: the transcript says how many tokens were
 * spent before a conclusion appeared, which is exactly the quantity a competitor
 * without session instrumentation cannot obtain.
 */

import { statSync } from 'node:fs';
import { nodeId } from './wiki.mjs';

const estimate = (text) => Math.ceil(String(text || '').length / 4);

/**
 * How hard something is to reproduce, independent of what it cost this time.
 *
 * Token cost alone understates the expensive cases. Reproducing a flaky failure
 * may take three runs and an hour while consuming few tokens; re-reading a file
 * is instant however large it is. The multiplier encodes that difference, and it
 * is deliberately coarse -- these are ratios between kinds of work, not
 * measurements, and pretending otherwise would be false precision.
 */
export function irrecoverability(entry) {
  const text = `${entry.summary || ''} ${entry.evidence || ''}`.toLowerCase();

  // Anything derived from a non-deterministic or long-running observation.
  //
  // WORD-ANCHORED. The bare fragment `race` matched "stack trace", and a stack trace is among
  // the most common things to appear in a finding's evidence -- so an ordinary reasoned finding
  // scored 4, the tier reserved for observations that cannot be re-derived, instead of the 2 it
  // earns. That is a 2x multiplier inflation on a very common input, and under budget pressure
  // an inflated ordinary finding displaces a genuinely irrecoverable one.
  if (/flak|intermitten|\brace\b|\btiming|\breproduc|only fails|sometimes/.test(text)) return 4;
  // Conclusions drawn from running something, not from reading it.
  // `reproduced` is deliberately absent: the `\breproduc` prefix above returns first, so listing
  // it here was unreachable.
  if (/benchmark|\bprofil(?:ed|ing|er)\b|measured|timed|ran the|test run/.test(text)) return 3;
  // Reasoning over material that is on disk but had to be understood.
  if (/because|therefore|turns out|root cause|the reason/.test(text)) return 2;
  return 1;
}

/**
 * Probability this will be wanted again, from the graph's own edges.
 *
 * A conclusion about a file that is touched constantly is worth more than one
 * about a file nobody has opened since. Co-occurrence already records which
 * files travel together, so this needs no new data.
 */
export function reuseProbability(graph, anchors) {
  if (!anchors || !anchors.length) return 0.5;

  let degree = 0;
  for (const anchor of anchors) {
    for (const edge of graph.edges) {
      if (edge.from === anchor || edge.to === anchor) degree++;
    }
  }
  // Saturating: the difference between 0 and 5 edges is large, between 40 and
  // 45 is not.
  return 0.25 + 0.75 * (1 - Math.exp(-degree / 8));
}

/**
 * What a conclusion cost to produce, in tokens.
 *
 * Measured from the transcript: the work between the previous conclusion and
 * this one is what it took to reach it. That is an attribution, not a
 * certainty -- but it is grounded in observed spend rather than assumed, and no
 * tool without session instrumentation can compute it at all.
 */
export function costToRederive(entry, previousAt) {
  if (typeof entry.tokensSpent === 'number') return entry.tokensSpent;

  // NO TRANSCRIPT ATTRIBUTION IS IMPLEMENTED. This previously computed an
  // inter-conclusion window and then consumed it as `window > 0 ? 0 : 0` --
  // zero on both branches -- so the value, and the `previousAt` parameter
  // threaded through selectForConsolidation to produce it, had no effect on any
  // output. The docstring above and the module header claimed cost was
  // "measured from the transcript" and called that "exactly the quantity a
  // competitor without session instrumentation cannot obtain"; it was not
  // measured at all.
  //
  // `entry.at` is a millisecond timestamp, not a token count, so feeding the
  // window in would substitute a fabricated ms-to-token conversion for the
  // no-op. The only measured cost is `entry.tokensSpent`, which the extraction
  // site must supply; otherwise fall back to the size of the evidence, so a
  // conclusion drawn from a large investigation still outranks an aside.
  return estimate(entry.evidence) * 4 || estimate(entry.summary) * 8;
}

/** Kinds that survive on the floor regardless of score. */
const ALWAYS_KEEP = new Set(['failure', 'decision']);

/**
 * Chooses what to promote into the graph, under a token budget.
 *
 * @param {object} graph      Loaded wiki graph, for reuse probability.
 * @param {Array}  candidates Extracted conclusions, each { type, summary, anchors, evidence, at }.
 * @param {object} options    budget: tokens available for promoted findings.
 */
export function selectForConsolidation(graph, candidates, { budget = 4000 } = {}) {
  const scored = [];
  let previousAt = null;

  for (const entry of candidates) {
    // Graph edges hold NODE IDS -- wiki.mjs writes from/to as nodeId(kind, key), a hash --
    // so an anchor must be hashed to the same identity before it can match anything.
    // Comparing raw paths made `degree` zero for every candidate, which made the whole
    // reuse-probability term a constant. Worse than inert: reuseProbability returns 0.5 for an
    // EMPTY anchor list and 0.25 for a resolved-but-unmatched one, so every anchored candidate
    // was penalised 2x against every unanchored aside -- and under budget pressure the anchored
    // findings, the ones the graph can actually retrieve later, were dropped first.
    const anchors = (entry.anchors || []).map((a) => {
      const raw = String(a);
      return nodeId(raw.includes('#') ? 'symbol' : 'file', raw);
    });
    const cost = costToRederive(entry, previousAt);
    const score = cost * irrecoverability(entry) * reuseProbability(graph, entry.anchorIds || anchors);
    scored.push({ entry, score, cost, tokens: estimate(entry.summary) });
    previousAt = entry.at ?? previousAt;
  }

  // The floor first: dead ends and decisions are admitted before ranking, so a
  // cheaply-found negative result cannot be crowded out by an expensive essay.
  const kept = [];
  let spent = 0;

  for (const item of scored) {
    if (!ALWAYS_KEEP.has(item.entry.type)) continue;
    if (spent + item.tokens > budget) continue;
    kept.push(item);
    spent += item.tokens;
  }

  for (const item of scored.sort((a, b) => b.score - a.score)) {
    if (kept.includes(item)) continue;
    if (spent + item.tokens > budget) continue;
    kept.push(item);
    spent += item.tokens;
  }

  return {
    kept: kept.map((k) => ({ ...k.entry, derivedCost: k.cost, score: k.score })),
    dropped: scored.length - kept.length,
    tokens: spent,
  };
}

/**
 * The consolidation ratio: what a finding cost to derive against what it costs
 * to carry.
 *
 * This is the metric nobody else can compute, because computing it requires
 * having watched the session that produced the finding. A conclusion that took
 * 12,000 tokens to reach and costs 150 tokens to carry is an 80x consolidation
 * -- and that multiple is the honest statement of what a knowledge graph is
 * FOR, in a way that "tokens saved" never quite is.
 */
export function consolidationRatio(finding) {
  const carry = estimate(finding.claim);
  const derived = finding.derivedCost || 0;
  if (!carry || !derived) return null;
  return derived / carry;
}

/** Aggregate ratio across a set of findings, ignoring any without a cost. */
export function aggregateConsolidation(findings) {
  let derived = 0;
  let carry = 0;
  for (const finding of findings) {
    if (!finding.derivedCost) continue;
    derived += finding.derivedCost;
    carry += estimate(finding.claim);
  }
  return carry ? { derived, carry, ratio: derived / carry } : null;
}

/**
 * Content identity for a file, so a finding can reach across projects.
 *
 * A vendored library file is the same file in every repository that holds it,
 * whatever path each gives it. Anchoring to content as well as path means a
 * finding about it appears in all of them with no promotion step and no path
 * mapping -- reach a per-session checkpoint cannot have even in principle.
 *
 * The PATH anchor still drives staleness within a repo; this is additive.
 */
export function contentAnchor(path, hash) {
  if (!hash) return null;
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  // Size is included so two different files sharing a truncated digest do not
  // collide into one identity.
  return `content:${hash}:${size}`;
}
