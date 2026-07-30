// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/calibration.mjs. Regenerate with `npm run sync:hooks`.
/**
 * A forecast that keeps its own score.
 *
 * NOTHING IN THIS SPACE IS CALIBRATED. Competing tools print a context-quality
 * letter and never revisit it; no mechanism exists, in any of them, to ask
 * whether the number was right. That makes it a vibe with a typeface.
 *
 * Here every forecast is logged, the outcome is observed when it arrives, and
 * the number is displayed WITH its own track record:
 *
 *     ~18 turns to compaction (within +-3 on 82% of past forecasts)
 *
 * A user can then decide how much to trust it, and a bad model is visible
 * instead of authoritative.
 *
 * SCORED BY HORIZON, NOT IN AGGREGATE. A single hit rate hides the failure that
 * actually matters: long-horizon forecasts are systematically optimistic in
 * almost every predictive system, and averaging them with easy short-horizon
 * calls conceals exactly that. Buckets keep it visible.
 *
 * REFIT FROM THIS PROJECT. A global heuristic cannot know that this repository
 * has enormous files, or that this team's sessions are short. Once enough
 * outcomes exist, the correction factor comes from observed error here rather
 * than from a constant.
 *
 * AND IT REFUSES TO SPEAK WHEN IT CANNOT. Below a reliability floor the panel
 * says the forecast is not yet calibrated rather than printing a number, which
 * is the same rule the savings report follows: no confident figure from data
 * that cannot support one.
 */

import { record, readMetrics } from './metrics.mjs';

/** Horizon buckets, in turns. Error behaves differently across these ranges. */
const HORIZONS = [
  { name: 'near', max: 5 },
  { name: 'mid', max: 20 },
  { name: 'far', max: Infinity },
];

/** Predicted-within tolerance, in turns, for a forecast to count as a hit. */
const TOLERANCE = 3;

/** Minimum scored forecasts in a bucket before its reliability means anything. */
const MIN_SCORED = 8;

/** Hit rate below which the forecast is not published at all. */
const RELIABILITY_FLOOR = 0.5;

function horizonOf(turns) {
  return HORIZONS.find((h) => turns <= h.max).name;
}

/** Records a prediction so it can be scored when the outcome arrives. */
export function logForecast(dir, { sessionId, predictedTurns, used, capacity }) {
  if (!Number.isFinite(predictedTurns)) return;
  record(dir, {
    kind: 'forecast',
    sessionId,
    predictedTurns,
    horizon: horizonOf(predictedTurns),
    used,
    capacity,
  });
}

/**
 * Records what actually happened, closing the most recent open forecast for a
 * session.
 *
 * Called when compaction fires: the number of turns that elapsed since the
 * prediction is the ground truth it was predicting.
 */
export function observeOutcome(dir, { sessionId, actualTurns }) {
  if (!Number.isFinite(actualTurns)) return;
  const open = readMetrics(dir)
    .filter((e) => e.kind === 'forecast' && e.sessionId === sessionId && !e.scored)
    .pop();
  if (!open) return;

  record(dir, {
    kind: 'forecast-outcome',
    sessionId,
    horizon: open.horizon,
    predictedTurns: open.predictedTurns,
    actualTurns,
    error: actualTurns - open.predictedTurns,
    hit: Math.abs(actualTurns - open.predictedTurns) <= TOLERANCE,
  });
}

/**
 * Reliability per horizon, plus the bias in each.
 *
 * Bias is signed on purpose: knowing the far-horizon forecast runs 40% long is
 * actionable, where "62% accurate" is not.
 */
export function reliability(dir) {
  const outcomes = readMetrics(dir).filter((e) => e.kind === 'forecast-outcome');
  const buckets = {};

  for (const horizon of HORIZONS) {
    const rows = outcomes.filter((o) => o.horizon === horizon.name);
    if (!rows.length) {
      buckets[horizon.name] = { scored: 0, hitRate: null, bias: null };
      continue;
    }
    const hits = rows.filter((r) => r.hit).length;
    const bias = rows.reduce((sum, r) => sum + (r.error || 0), 0) / rows.length;
    buckets[horizon.name] = {
      scored: rows.length,
      hitRate: hits / rows.length,
      bias,
      calibrated: rows.length >= MIN_SCORED && hits / rows.length >= RELIABILITY_FLOOR,
    };
  }

  const scored = outcomes.length;
  const hits = outcomes.filter((o) => o.hit).length;

  return {
    buckets,
    scored,
    // The single legible figure, from the same data as the buckets.
    hitRate: scored ? hits / scored : null,
    tolerance: TOLERANCE,
  };
}

/**
 * Corrects a raw forecast using this project's observed bias.
 *
 * Returns the adjusted prediction and whether it is fit to publish. A forecast
 * from a bucket that has not earned reliability is returned UNPUBLISHABLE
 * rather than adjusted-and-shown, because an uncalibrated number with a
 * confident face is the failure mode being avoided.
 */
export function calibrate(dir, predictedTurns) {
  if (!Number.isFinite(predictedTurns)) return { publishable: false, reason: 'no forecast' };

  const horizon = horizonOf(predictedTurns);
  const bucket = reliability(dir).buckets[horizon];

  if (!bucket || bucket.scored < MIN_SCORED) {
    return {
      publishable: false,
      predictedTurns,
      horizon,
      reason: `not yet calibrated (${bucket?.scored || 0}/${MIN_SCORED} scored forecasts at this horizon)`,
    };
  }

  if (!bucket.calibrated) {
    return {
      publishable: false,
      predictedTurns,
      horizon,
      reason: `forecast unreliable at this horizon (${Math.round(bucket.hitRate * 100)}% within ` +
        `${TOLERANCE} turns over ${bucket.scored} attempts)`,
    };
  }

  // Refit: shift by the observed bias for this horizon. A bucket that runs long
  // gets pulled in, and vice versa.
  const adjusted = Math.max(0, Math.round(predictedTurns + bucket.bias));

  return {
    publishable: true,
    predictedTurns: adjusted,
    raw: predictedTurns,
    horizon,
    hitRate: bucket.hitRate,
    bias: bucket.bias,
    note: `within ${TOLERANCE} on ${Math.round(bucket.hitRate * 100)}% of ${bucket.scored} past forecasts`,
  };
}
