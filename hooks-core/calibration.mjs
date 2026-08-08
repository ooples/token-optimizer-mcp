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

// readBalance, not readMetrics. Both readers used the windowed firehose, which returns at most
// 2,000,000 bytes and the last 5,000 lines -- and forecast events were not among the protected
// kinds, so they lived in a log dominated by per-tool-call records (metrics.mjs's own comment
// cites 4,735 capture events inside one window).
//
// Two failures followed. In observeOutcome, on a busy project the forecast had scrolled past the
// tail by the time compaction fired, so the outcome was discarded with no record, no error and no
// counter. In reliability, outcomes vanished faster than they accumulated, so rows.length could
// never reach MIN_SCORED and calibrate returned 'not yet calibrated (n/8)' permanently -- leaving
// a user unable to distinguish "never had data" from "the data is being thrown away".
//
// 'forecast' and 'forecast-outcome' are now balance kinds, so they are written to balance.jsonl
// as well and read back unwindowed.
import { record, readBalance } from './metrics.mjs';

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

/**
 * Records a prediction so it can be scored when the outcome arrives.
 *
 * `turns` is the session's turn count AT PREDICTION TIME, and it is what makes the outcome
 * computable at all: predictedTurns means "turns from here until compaction", so the ground truth
 * is the turns that ELAPSED, not the turn number compaction happened on. Without it the caller at
 * compaction has nothing to subtract from and would have to score an interval against an absolute.
 */
export function logForecast(dir, { sessionId, predictedTurns, used, capacity, turns }) {
  if (!Number.isFinite(predictedTurns)) return;
  record(dir, {
    kind: 'forecast',
    sessionId,
    predictedTurns,
    horizon: horizonOf(predictedTurns),
    used,
    capacity,
    turns: Number.isFinite(turns) ? turns : null,
  });
}

/**
 * Records what actually happened, closing the most recent open forecast for a
 * session.
 *
 * Called when compaction fires: the number of turns that elapsed since the
 * prediction is the ground truth it was predicting.
 */
export function observeOutcome(dir, { sessionId, actualTurns, atTurn }) {
  // EITHER THE ELAPSED COUNT OR THE TURN IT HAPPENED ON.
  //
  // The only real caller -- the PreCompact hook -- knows what turn compaction fired on, not how
  // many turns have passed since a prediction it did not make. Deriving the interval here keeps
  // that subtraction next to the record that defines it, rather than making every caller
  // re-discover which forecast is open in order to compute its own ground truth.
  const elapsed = Number.isFinite(actualTurns)
    ? actualTurns
    : null;
  if (elapsed === null && !Number.isFinite(atTurn)) return;

  // CLOSURE IS DERIVED FROM THE OUTCOME ROWS, not from a flag on the forecast.
  //
  // The old filter was `!e.scored`, but nothing ever writes `scored`: logForecast records
  // kind/sessionId/predictedTurns/horizon/used/capacity, and record() is an append-only JSONL
  // writer with no update path, so a forecast can never gain the field. The predicate was always
  // true, and the last forecast for a session was therefore re-closable without limit.
  //
  // A session where compaction fires twice with no intervening logForecast popped the SAME
  // forecast twice, producing two outcome rows for one prediction. reliability counts ROWS, not
  // predictions, so the hit rate and the bias mean both inflate and MIN_SCORED can be satisfied
  // by a single prediction re-closed eight times -- precisely the "threshold from a single
  // sample" this module exists to prevent. The existing test used a fresh sessionId per
  // iteration, so it never exposed it.
  const events = readBalance(dir);
  const closed = new Set(
    events.filter((e) => e.kind === 'forecast-outcome' && e.forecastId).map((e) => e.forecastId),
  );
  // ID-BEARING ROWS ONLY, AND NEWEST BY TIME RATHER THAN BY POSITION.
  //
  // Two separate hazards, both from readBalance's shape. It returns balance-log rows followed by
  // the legacy firehose rows it migrates, unsorted -- so `.pop()` returns the last row in the
  // array, which is not the newest forecast. And legacy rows predate `id`, so `closed.has(e.id)`
  // is `closed.has(undefined)`, always false: such a forecast can be closed again and again, and
  // each outcome stores `forecastId: undefined`, which JSON.stringify drops entirely. That is the
  // repeat-scoring defect this function was written to fix, reappearing through the back door.
  const open = events
    .filter((e) => e.kind === 'forecast' && e.sessionId === sessionId && e.id && !closed.has(e.id))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    .pop();
  if (!open) return;

  // Derived only once the open forecast is known, since the interval is measured from ITS turn.
  // A forecast recorded before `turns` existed has none, and there is nothing to subtract from --
  // scoring it against an absolute turn number would manufacture an error rather than measure one,
  // so it is left open instead.
  const actual = elapsed !== null ? elapsed
    : (Number.isFinite(open.turns) ? atTurn - open.turns : null);
  // AT LEAST ONE TURN MUST HAVE PASSED. `atTurn` is the transcript's current turn count and
  // `open.turns` the count at prediction time, so a truncated, rotated or replaced transcript
  // makes the difference zero or negative. Recording that as ground truth feeds a large negative
  // `error` into `reliability`, which shifts `bucket.bias`, which is what `calibrate` publishes a
  // corrected forecast from -- so one bad transcript would skew every later prediction. Leaving
  // the forecast open loses nothing: the next compaction closes it against a sane count.
  if (actual === null || !Number.isFinite(actual) || actual < 1) return;

  record(dir, {
    kind: 'forecast-outcome',
    sessionId,
    // Stamped so the next call can see this forecast is spoken for. Without it the set above is
    // empty and the same defect returns.
    forecastId: open.id,
    horizon: open.horizon,
    predictedTurns: open.predictedTurns,
    actualTurns: actual,
    error: actual - open.predictedTurns,
    hit: Math.abs(actual - open.predictedTurns) <= TOLERANCE,
  });
}

/**
 * Reliability per horizon, plus the bias in each.
 *
 * Bias is signed on purpose: knowing the far-horizon forecast runs 40% long is
 * actionable, where "62% accurate" is not.
 */
export function reliability(dir) {
  const outcomes = readBalance(dir).filter((e) => e.kind === 'forecast-outcome');
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
  //
  // NOT CLAMPED WITH Math.max, which converted nonsense into a plausible-looking emergency. bias
  // is a plain arithmetic mean of signed error, and a mean is not robust to the shape the
  // 50%-hit-rate floor admits: a near bucket with errors [0,0,0,0,-30,-30,-30,-30] has four hits,
  // so it clears the floor and is called calibrated, and its bias is -15. A raw forecast of 3
  // turns then became Math.max(0, Math.round(3 - 15)) = 0 and was published as fact, with the
  // note "within 3 on 50% of 8 past forecasts" -- a zero-turn deadline the forecaster never
  // produced, from a bucket that is wrong half the time.
  //
  // A correction at least as large as the thing it corrects is not a correction.
  const adjusted = Math.round(predictedTurns + bucket.bias);
  if (Math.abs(bucket.bias) >= predictedTurns || adjusted < 1) {
    return {
      publishable: false,
      predictedTurns,
      horizon,
      bias: bucket.bias,
      reason: `the observed bias at this horizon (${Math.round(bucket.bias)} turns) is as large as ` +
        `the forecast itself (${predictedTurns}), so the correction would replace it rather than ` +
        'adjust it',
    };
  }

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
