/**
 * A forecast that scores itself, instead of a grade nobody can check.
 *
 * Competing tools compute a context-quality LETTER from seven heuristic signals.
 * That number is descriptive, uncalibrated, unactionable and -- most
 * importantly -- uncheckable: nothing, including the tool that printed it, can
 * say whether a "B-" was right.
 *
 * Three quantities are available here that a tool without a control arm cannot
 * compute at all, and they answer different questions:
 *
 *   RUNWAY         turns until compaction, WITH and WITHOUT the graph. A
 *                  deadline, and the only form that says what to do next.
 *   BURN RATE      tokens per turn, and how many of them the graph removes.
 *                  The causal statement, updating continuously.
 *   CONSOLIDATION  reasoning tokens compressed into carried findings. What the
 *                  product IS, expressed as a multiple.
 *
 * They have DIFFERENT DATA REQUIREMENTS, which is what lets the panel degrade
 * per-number rather than all-or-nothing: consolidation is available from the
 * first finding, burn rate within one session, and the runway counterfactual
 * only once the holdout carries volume. Each appears when it has earned the
 * right to, and says so plainly when it has not.
 *
 * THE COUNTERFACTUAL IS COMPUTED TWICE, ON PURPOSE. The measured arm is what a
 * withheld session actually spent; the shadow is what intercepted calls would
 * have cost. Neither retires the other -- when they DISAGREE that divergence is
 * itself a calibration signal, so the estimate and the measurement check each
 * other rather than one standing in for the other.
 */

import { readMetrics } from './metrics.mjs';
import { aggregateConsolidation } from './consolidate.mjs';

/** Turns of headroom below which the runway is worth interrupting for. */
export const ACTIONABLE_RUNWAY = 8;

/**
 * Tokens per turn, and how many the graph is removing.
 *
 * The delta is causal because it comes from the arms, not from a model of what
 * "would have" happened.
 */
export function burnRate(events) {
  const injects = events.filter((e) => e.kind === 'inject');
  const treated = injects.filter((e) => !e.holdout);
  const withheld = injects.filter((e) => e.holdout);

  const reads = new Map();
  for (const event of events) {
    if (event.kind !== 'read' || !event.anchor) continue;
    const key = `${event.sessionId || ''}|${event.anchor}`;
    if (!reads.has(key)) reads.set(key, []);
    reads.get(key).push(event);
  }

  const downstream = (rows) => {
    if (!rows.length) return null;
    let total = 0;
    for (const row of rows) {
      const bucket = reads.get(`${row.sessionId || ''}|${row.anchor}`) || [];
      const after = row.at ?? 0;
      total += bucket.reduce((sum, r) => sum + ((r.at ?? 0) >= after ? (r.tokens || 0) : 0), 0);
    }
    return total / rows.length;
  };

  const treatedCost = downstream(treated);
  const withheldCost = downstream(withheld);
  const injectionCost = treated.length
    ? treated.reduce((sum, e) => sum + (e.tokens || 0), 0) / treated.length
    : 0;

  if (treatedCost === null) return null;

  return {
    perTouch: treatedCost + injectionCost,
    // Null rather than zero when the control arm is too thin: a saving of
    // "unknown" must never render as a saving of "none".
    savedPerTouch: withheldCost === null ? null : withheldCost - treatedCost - injectionCost,
    treatedTouches: treated.length,
    withheldTouches: withheld.length,
  };
}

/**
 * What the intercepted calls would have cost if nothing had intervened.
 *
 * MODELLED, not measured, and labelled as such wherever it surfaces. Every
 * substitution records the bytes it displaced, so this is a tally of real
 * events under one assumption -- that the full read would otherwise have
 * happened -- which is exactly the assumption a competitor's savings figure
 * makes silently and never states.
 */
export function shadowAvoided(events) {
  let avoided = 0;
  let spent = 0;
  for (const event of events) {
    if (event.kind !== 'substitute') continue;
    avoided += Math.ceil((event.bytesAvoided || 0) / 4);
    spent += event.tokens || 0;
  }
  return avoided ? { avoided, spent, net: avoided - spent } : null;
}

/**
 * Turns of headroom left, with and without the graph.
 *
 * @param used     Tokens of context consumed so far.
 * @param capacity Context window size.
 * @param turns    Turns taken to consume it.
 */
export function runway({ used, capacity, turns }, rate) {
  if (!capacity || !turns || used == null) return null;

  const perTurn = used / turns;
  if (perTurn <= 0) return null;

  const remaining = Math.max(0, capacity - used);
  const withGraph = Math.floor(remaining / perTurn);

  // Without the graph each turn costs what it costs now PLUS what the graph is
  // removing. Only computable when the control arm has spoken.
  const saved = rate?.savedPerTouch;
  const withoutGraph = saved != null && saved > 0
    ? Math.floor(remaining / (perTurn + saved))
    : null;

  return { withGraph, withoutGraph, perTurn: Math.round(perTurn) };
}

/**
 * Builds the panel, including only the parts that have earned the right to
 * appear.
 *
 * A number without the data behind it is omitted rather than estimated, which
 * is the same rule the savings report already follows. The alternative -- a
 * confident figure derived from four samples -- is precisely what this project
 * criticises elsewhere.
 */
export function forecastPanel(dir, session = {}, findings = []) {
  const events = readMetrics(dir);
  const rate = burnRate(events);
  const shadow = shadowAvoided(events);
  const consolidation = aggregateConsolidation(findings);
  const air = runway(session, rate);

  const lines = [];
  const parts = {};

  if (air) {
    parts.runway = air;
    lines.push(air.withoutGraph != null
      ? `~${air.withGraph} turns to compaction; without the graph, ~${air.withoutGraph}.`
      : `~${air.withGraph} turns to compaction (no counterfactual yet -- the control arm needs more volume).`);
  }

  if (rate) {
    parts.burn = rate;
    lines.push(rate.savedPerTouch != null
      ? `${Math.round(rate.perTouch)} tokens/touch; the graph is removing ${Math.round(rate.savedPerTouch)}.`
      : `${Math.round(rate.perTouch)} tokens/touch (saving not yet measurable).`);
  }

  if (consolidation) {
    parts.consolidation = consolidation;
    lines.push(`${consolidation.derived.toLocaleString()} tokens of reasoning carried as ` +
      `${consolidation.carry.toLocaleString()} -- ${Math.round(consolidation.ratio)}x consolidation.`);
  }

  // Divergence between the modelled and measured views. Agreement is
  // reassurance; disagreement means the model is wrong and should be said out
  // loud rather than quietly preferred one way or the other.
  if (shadow && rate?.savedPerTouch != null && rate.treatedTouches > 0) {
    const modelled = shadow.net / Math.max(1, rate.treatedTouches);
    const measured = rate.savedPerTouch;
    const spread = Math.abs(modelled - measured) / Math.max(1, Math.abs(measured));
    parts.divergence = { modelled, measured, spread };
    if (spread > 0.5) {
      lines.push(`Note: the modelled saving (${Math.round(modelled)}/touch) and the measured one ` +
        `(${Math.round(measured)}/touch) disagree; treat the measured figure as authoritative.`);
    }
  }

  return lines.length ? { text: lines.join('\n'), parts } : null;
}

/**
 * Should this forecast interrupt?
 *
 * Only when it says something ACTIONABLE. A runway that moved from 19 turns to
 * 18 is different, not actionable; one that crossed into single digits changes
 * what a person would do next. Everyone else spends context on an always-on
 * display, which is the opposite of the discipline this product enforces.
 */
export function worthSurfacing(current, previous) {
  if (!current?.parts?.runway) return false;
  const now = current.parts.runway.withGraph;

  if (now > ACTIONABLE_RUNWAY) return false;
  if (!previous?.parts?.runway) return true;

  // Crossed the threshold, or halved since last time it was shown.
  const before = previous.parts.runway.withGraph;
  return before > ACTIONABLE_RUNWAY || now <= Math.floor(before / 2);
}
