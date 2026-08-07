// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/forecast.mjs. Regenerate with `npm run sync:hooks`.
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

import { readMetrics, readBalance, isFixtureAnchor, BALANCE_KINDS } from './metrics.mjs';
import { aggregateConsolidation } from './consolidate.mjs';
import { previewQuality } from './expand.mjs';

/** Turns of headroom below which the runway is worth interrupting for. */
export const ACTIONABLE_RUNWAY = 8;

/**
 * Held-out touches required before the runway counterfactual is published.
 *
 * The header of this file promises the counterfactual appears "only once the holdout carries
 * volume", and the fallback string says "the control arm needs more volume" -- but the only check
 * was `if (!rows.length) return null`, so "volume" meant "at least one". With a single withheld
 * touch, withheldCost IS that one touch's downstream read total: one held-out read of a
 * 3,000-line module set savedPerTouch to several thousand tokens and published a counterfactual
 * an order of magnitude off, as a bare fact with no caveat.
 *
 * Ten is a floor rather than a statistically derived threshold, and is deliberately stated as
 * such where it surfaces: the panel prints the held-out count against it, so a reader can see how
 * close the arm is instead of being told only that it is short.
 */
export const MIN_CONTROL_TOUCHES = 10;

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

  // EACH READ IS CHARGED TO EXACTLY ONE INJECTION.
  //
  // The windows used to run from each injection to the end of the log, so they overlapped
  // completely: for anchor A with injections i1..i5 interleaved with five reads of 100 tokens,
  // i1 saw 500, i2 400, i3 300, i4 200, i5 100 -- 1500 / 5 = 300 against a true per-touch cost of
  // 100. A 3x inflation growing with the repeat count.
  //
  // It does not cancel between the arms. metrics.mjs makes the holdout deterministic in
  // (anchor, epoch), so every repeat touch of a file lands in the SAME arm -- whichever arm drew
  // the heavily re-touched anchors is inflated and the other is not. savedPerTouch's sign and
  // magnitude were therefore driven by which files happened to be held out, and that value is
  // what the published counterfactual divides by.
  //
  // Bounding each window at the next injection of the same (session, anchor) -- across BOTH arms,
  // since an injection ends the previous window regardless of which arm it is in -- makes the
  // charge exact.
  const nextInjectAfter = new Map();
  for (const row of injects) {
    const key = `${row.sessionId || ''}|${row.anchor}`;
    if (!nextInjectAfter.has(key)) nextInjectAfter.set(key, []);
    nextInjectAfter.get(key).push(row.at ?? 0);
  }
  for (const times of nextInjectAfter.values()) times.sort((a, b) => a - b);

  const downstream = (rows) => {
    if (!rows.length) return null;
    let total = 0;
    for (const row of rows) {
      const key = `${row.sessionId || ''}|${row.anchor}`;
      const bucket = reads.get(key) || [];
      const after = row.at ?? 0;
      const until = (nextInjectAfter.get(key) || []).find((t) => t > after) ?? Infinity;
      total += bucket.reduce(
        (sum, r) => sum + ((r.at ?? 0) >= after && (r.at ?? 0) < until ? (r.tokens || 0) : 0),
        0,
      );
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
  let seen = 0;
  for (const event of events) {
    if (event.kind !== 'substitute') continue;
    // FIXTURES EXCLUDED, as balanceSheet already does. metrics.mjs records the measurement:
    // "366 of 370 substitutions pointed at the enforcement suite's own big.ts fixture under a
    // temp dir, and counting them made the product look like it had avoided 40 MB of reads. It
    // had avoided 154 KB." Running the test suite against a real graph inflated `avoided` by two
    // orders of magnitude, which blew up shadow.net, pushed `spread` past 0.5 and fired the
    // divergence note with a fabricated number -- so the panel's own credibility check was the
    // thing the fixture noise corrupted.
    if (isFixtureAnchor(event.anchor)) continue;
    seen += 1;
    avoided += Math.ceil((event.bytesAvoided || 0) / 4);
    spent += event.tokens || 0;
  }
  // GUARDED ON WHETHER ANYTHING WAS SEEN, not on whether it was favourable. Guarding on `avoided`
  // meant twenty substitutions that each spent 20 tokens and avoided nothing -- a measured net
  // loss of 400 -- returned null, so the divergence block never ran and the panel said nothing
  // about the shadow arm. The one outcome the function could not express was the one unfavourable
  // to the product, collapsed into the same return value as "no data".
  return seen ? { avoided, spent, net: avoided - spent, substitutions: seen } : null;
}

/**
 * Turns of headroom left, with and without the graph.
 *
 * @param used     Tokens of context consumed so far.
 * @param capacity Context window size.
 * @param turns    Turns taken to consume it.
 * @param touches  Intercepted touches in this session. Required for the counterfactual: it is
 *                 what converts a per-TOUCH saving into a per-TURN one.
 */
export function runway({ used, capacity, turns, touches }, rate) {
  if (!capacity || !turns || used == null) return null;

  const perTurn = used / turns;
  if (perTurn <= 0) return null;

  const remaining = Math.max(0, capacity - used);
  const withGraph = Math.floor(remaining / perTurn);
  const base = { withGraph, perTurn: Math.round(perTurn) };

  const saved = rate?.savedPerTouch;
  if (saved == null) return { ...base, withoutGraph: null, counterfactual: 'unmeasured' };

  // VOLUME, MEANING VOLUME. See MIN_CONTROL_TOUCHES.
  const withheld = rate.withheldTouches ?? 0;
  if (withheld < MIN_CONTROL_TOUCHES) {
    return { ...base, withoutGraph: null, counterfactual: 'thin-control', withheld };
  }

  // UNITS. `perTurn` is tokens per TURN for this session; `savedPerTouch` is an average over
  // injection EVENTS across the whole metrics log. Adding them directly was only correct with
  // exactly one intercepted touch per turn, which is not the usual case in either direction.
  //
  // Session {used 60000, capacity 200000, turns 30} gives perTurn 2000 and remaining 140000. With
  // 5 injections over those 30 turns and savedPerTouch 1500, the true per-turn saving is 250, so
  // the honest counterfactual is floor(140000/2250) = 62. Adding the per-touch figure gave
  // floor(140000/3500) = 40, and the panel published "~70 turns to compaction; without the graph,
  // ~40" -- claiming the graph nearly doubled the runway when it added about eight turns.
  //
  // Without a touch count there is no density to convert with, so the counterfactual is withheld
  // rather than computed on the one-touch-per-turn assumption.
  if (!touches) return { ...base, withoutGraph: null, counterfactual: 'no-touch-density' };

  const savedPerTurn = saved * (touches / turns);

  // A MEASURED NON-POSITIVE SAVING IS A RESULT, NOT A MISSING ONE. The old `saved > 0` guard
  // discarded a measurement: with withheldCost 1000, treatedCost 900 and injectionCost 200,
  // savedPerTouch is -100 -- the control arm has spoken and said the graph is a net cost -- and
  // the panel printed "no counterfactual yet, the control arm needs more volume". The one result
  // unfavourable to the product was the one result the panel could not show, disguised as
  // insufficient data. The runway is longer without the graph in that case, and says so.
  const denominator = perTurn + savedPerTurn;
  if (denominator <= 0) {
    // The graph is measured to be removing more per turn than the session is spending, which is
    // arithmetically possible and not interpretable as a runway. Reported as such.
    return { ...base, withoutGraph: null, counterfactual: 'implausible', savedPerTurn };
  }

  return {
    ...base,
    withoutGraph: Math.floor(remaining / denominator),
    counterfactual: savedPerTurn > 0 ? 'saving' : 'costing',
    savedPerTurn,
    withheld,
  };
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
/**
 * The events the forecast reasons about, each kind read from the log that keeps it.
 *
 * Reads come from readMetrics, which applies MAX_EVENTS and a tail byte cap -- correct, because
 * reads are the high-volume kind and only the recent ones describe the current burn.
 *
 * Inject, harvest and substitute come from readBalance, which is exempt from that window and
 * exists for precisely this reason. metrics.mjs records what the window does to them, measured in
 * this repository: "44 inject records in the file, 9 of them holdout, all at lines 60-76 of
 * 9,058 -- every single one outside the window. report() therefore said 0 holdout."
 *
 * The 10% holdout arm is the rarer kind, so it ages out FIRST. On any graph with more than 5,000
 * events since the last injection burst, downstream(withheld) returned null, savedPerTouch was
 * null, and the panel printed "no counterfactual yet -- the control arm needs more volume" while
 * balance.jsonl held the control arm in full. The panel blamed insufficient data for a read-path
 * bug; in the partial case it computed the published counterfactual from whichever slice of the
 * control arm happened to survive the window.
 */
export function balanceAwareEvents(dir) {
  const balance = readBalance(dir);
  // No id-matching needed, and deliberately so: readBalance already reads balance.jsonl in full,
  // migrates the pre-split records out of metrics.jsonl WITHOUT the window, and dedupes the two
  // on record id (falling back to a composite for records written before ids existed). It is
  // therefore a strict superset of the balance kinds in the windowed read, so the windowed copies
  // are dropped outright. Trying to merge them back by id would double-count exactly the legacy
  // records that have no id.
  const out = readMetrics(dir).filter((e) => !BALANCE_KINDS.has(e?.kind));
  out.push(...balance);
  return out;
}

/** How the runway reads, given what the control arm was actually able to say. */
function runwayLine(air) {
  const head = `~${air.withGraph} turns to compaction`;
  switch (air.counterfactual) {
    case 'saving':
      return `${head}; without the graph, ~${air.withoutGraph}.`;
    case 'costing':
      // Said plainly rather than suppressed. A tool that can only report results in its own
      // favour is not measuring anything.
      return `${head}; without the graph, ~${air.withoutGraph} -- the graph is measurably NOT ` +
        'extending the runway here.';
    case 'thin-control':
      return `${head} (no counterfactual yet -- the control arm holds ${air.withheld} of the ` +
        `${MIN_CONTROL_TOUCHES} held-out touches needed).`;
    case 'no-touch-density':
      return `${head} (no counterfactual -- this session's intercepted-touch count is unknown, ` +
        'and a per-touch saving cannot be converted to a per-turn one without it).';
    case 'implausible':
      return `${head} (no counterfactual -- the measured saving exceeds this session's whole ` +
        'per-turn cost, so the arithmetic does not describe a runway).';
    default:
      return `${head} (no counterfactual yet -- the control arm has not spoken).`;
  }
}

export function forecastPanel(dir, session = {}, findings = []) {
  const events = balanceAwareEvents(dir);
  const rate = burnRate(events);
  const shadow = shadowAvoided(events);
  const consolidation = aggregateConsolidation(findings);
  // The touch count converts the per-touch saving into a per-turn one. Taken from the session
  // when the caller knows it, and otherwise from the treated touches this rate was built from.
  const touches = session.touches ?? rate?.treatedTouches ?? 0;
  const air = runway({ ...session, touches }, rate);

  const lines = [];
  const parts = {};

  if (air) {
    parts.runway = air;
    lines.push(runwayLine(air));
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

  // How well the previews are holding. Reported rather than buried: the
  // expansion rate is the honest quality metric for progressive disclosure, and
  // a tool that hides it is asking to be trusted on a number it will not show.
  // Only surfaced once it is failing -- a healthy rate is not news.
  const previews = previewQuality(dir);
  if (previews && !previews.healthy) {
    parts.previews = previews;
    lines.push(previews.text);
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
