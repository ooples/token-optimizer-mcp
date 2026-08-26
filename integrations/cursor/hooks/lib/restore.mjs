// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/restore.mjs. Regenerate with `npm run sync:hooks`.
﻿/**
 * Restoration after compaction.
 *
 * A checkpoint restores what you HAD. That is a recap: it spends the scarcest
 * budget in the session replaying context already paid for. Three modes are
 * available to a graph, and only the first is what competitors do:
 *
 *   BRIEF     what was established  -- orientation, backward-looking
 *   FORWARD   what you are about to touch, predicted from co-occurrence
 *   FRONTIER  what you were about to LEARN -- the open question, what has been
 *             ruled out, what remains untested
 *
 * FRONTIER is the one nobody has. Resuming a thought is categorically different
 * from reloading a transcript: "you were establishing whether X; A and B are
 * ruled out; C is untested" continues the work, where a summary describes it.
 *
 * SITUATION PICKS THE SPLIT, MEASUREMENT PICKS THE SIZE. Which mode matters
 * depends on the moment -- mid-problem wants continuation, a cold resume wants
 * orientation -- so the weighting adapts per compaction. The ceilings do not:
 * they are earned from the control arm, so a misread situation can shift the
 * mix but never overspend. Adaptive within measured bounds.
 */

import { findingsFor, nodeId } from './wiki.mjs';
import { serve } from './staleness.mjs';
import { indexBudget } from './metrics.mjs';
import { canonicalPath } from './paths.mjs';
import { safeLine } from './safe-text.mjs';

const estimate = (text) => Math.ceil(String(text || '').length / 4);

/**
 * What kind of compaction is this?
 *
 * Read from what the session was doing, not from a setting. The three cases want
 * genuinely different things, and treating them identically is what makes a
 * fixed-order restore feel wrong half the time.
 */
export function classifySituation({
  openQuestion,
  recentAnchors = [],
  idleMs = 0,
} = {}) {
  // Days later, nothing in the fresh context connects to anything. Orientation
  // is the only thing that helps; continuation has nothing to continue from.
  if (idleMs > 6 * 60 * 60 * 1000) return 'cold-resume';

  // An unresolved question is the most valuable thing to restore, because it is
  // the only part that cannot be re-derived by looking at the code.
  if (openQuestion) return 'mid-problem';

  // Work was flowing across a set of files with nothing outstanding: what
  // matters is what comes next, not what just happened.
  if (recentAnchors.length >= 3) return 'in-flow';

  return 'general';
}

/**
 * How the budget splits across modes for a situation.
 *
 * Fractions, not token counts -- the total comes from the earned ceiling, so a
 * situational misread changes the mix and never the spend.
 */
const SPLITS = {
  'mid-problem': { frontier: 0.6, forward: 0.25, brief: 0.15 },
  'cold-resume': { frontier: 0.15, forward: 0.25, brief: 0.6 },
  'in-flow': { frontier: 0.2, forward: 0.6, brief: 0.2 },
  general: { frontier: 0.35, forward: 0.35, brief: 0.3 },
};

/** Findings for files the co-occurrence graph says are likely next. */
function predictNext(graph, recentAnchors, limit = 6) {
  const recent = new Set(
    recentAnchors.map((a) => nodeId('file', canonicalPath(a)))
  );
  const weight = new Map();

  for (const edge of graph.edges) {
    if (edge.edge !== 'related') continue;
    const [from, to] = [edge.from, edge.to];
    if (recent.has(from) && !recent.has(to))
      weight.set(to, (weight.get(to) || 0) + 1);
    if (recent.has(to) && !recent.has(from))
      weight.set(from, (weight.get(from) || 0) + 1);
  }

  return [...weight.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}

/**
 * Builds the restoration block.
 *
 * @param {string} dir     Graph directory, for the earned budget.
 * @param {object} graph   Loaded graph.
 * @param {object} context { openQuestion, ruledOut, untested, recentAnchors, idleMs }
 */
export function restorationPlan(dir, graph, context = {}) {
  const situation = classifySituation(context);
  const total = indexBudget(dir);
  const split = SPLITS[situation] || SPLITS.general;

  const sections = [];
  let spent = 0;

  const section = (title, lines, allowance) => {
    if (!lines.length) return;
    const header = `## ${title}`;
    let used = estimate(header);
    const kept = [];
    for (const line of lines) {
      const cost = estimate(line);
      if (used + cost > allowance) break;
      kept.push(line);
      used += cost;
    }
    if (!kept.length) return;
    sections.push([header, ...kept].join('\n'));
    spent += used;
  };

  // FRONTIER -- the continuation. First because it is the only part that cannot
  // be recovered by looking at the code again.
  if (context.openQuestion) {
    const lines = [`Open: ${context.openQuestion}`];
    for (const ruled of context.ruledOut || [])
      lines.push(`  ruled out: ${ruled}`);
    for (const open of context.untested || [])
      lines.push(`  untested: ${open}`);
    section('Where you were', lines, total * split.frontier);
  }

  // FORWARD -- anticipation. What the graph knows about files this session is
  // statistically about to touch, which spends the budget on work still ahead.
  const predicted = predictNext(graph, context.recentAnchors || []);
  if (predicted.length) {
    const lines = [];
    for (const id of predicted) {
      const node = graph.nodes.get(id);
      if (!node) continue;
      const findings = serve(graph, findingsFor(graph, id, { limit: 2 }), { dir });
      for (const finding of findings) {
        // `! STALE` only where a diff actually exists to back it; see the
        // renderer in inject.mjs for the measurement behind this.
        //
        // BOTH HALVES, matching inject.mjs exactly (`!staleEvidence || !diff`).
        // Checking staleEvidence alone marked a finding `! STALE` here while the
        // injector softened the same finding elsewhere -- and the strong marker
        // claims 'this is contradicted, here is the proof' with no proof to
        // show, which is the bare stale finding the design calls worse than
        // having no graph.
        const mark = finding.stale
          ? finding.staleEvidence && finding.diff
            ? '! STALE '
            : '~ '
          : '';
        // A DISPUTE DISCLOSED ELSEWHERE AND SILENT HERE reads as "the dispute
        // went away". `serve` already attached the fields; the only question is
        // the wording, and this list is the most compressed surface in the
        // system, so it gets the marker and the key and nothing else.
        const disputed = finding.contradicted
          ? finding.contradictedBy
            ? ` (disputed by ${finding.contradictedBy})`
            : ' (disputed)'
          : '';
        lines.push(`${node.key}: ${mark}${finding.claim}${disputed}`);
      }
    }
    section('Likely next', lines, total * split.forward);
  }

  // BRIEF -- orientation. Last, because it is the most replaceable: normal
  // just-in-time injection will deliver most of it the moment work resumes.
  const established = [...graph.nodes.values()]
    .filter(
      (n) => n.kind === 'finding' && !n.retired && typeof n.claim === 'string'
    )
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, 12)
    // FLATTENED HERE, because this list does NOT go through `serve`. It reads
    // graph nodes directly -- deliberately, since it wants the highest-confidence
    // claims rather than the ones anchored to a file -- so it is outside the
    // boundary that holds the no-forged-lines guarantee for everything else. A
    // stored newline here writes its own entries into the restore brief, which
    // is injected at SessionStart before the model has read anything.
    .map((n) => `${safeLine(n.key)}: ${safeLine(n.claim).slice(0, 100)}`);
  section('Established', established, total * split.brief);

  if (!sections.length) return null;

  return {
    situation,
    tokens: spent,
    // One blank line between blocks. The empty strings were separators from
    // when this joined on '\n', and joining on '\n\n' turned each of them into a
    // doubled gap -- wasted tokens inside the one block whose entire purpose is
    // not wasting them.
    text: [
      `# Restored after compaction (${situation})`,
      ...sections,
      'Findings anchored to a file are surfaced automatically when you touch it.',
    ].join('\n\n'),
  };
}
