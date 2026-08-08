/**
 * The entry point the forecast never had.
 *
 * forecast.mjs computes a runway, calibration.mjs scores it, and worthSurfacing decides whether a
 * change is worth interrupting for -- and none of it ran. The reachability guard listed
 * forecastPanel, worthSurfacing, logForecast and observeOutcome as unwired, which is a polite way
 * of saying the feature did not exist for any user. This module is the missing half: it derives
 * the session numbers the panel needs from the transcript, decides when the panel has earned an
 * interruption, and closes the calibration loop when compaction fires.
 *
 * THREE COSTS ARE BOUNDED HERE, because this runs on the PreToolUse path and every tool call is a
 * separate process:
 *
 *   THE READ      readCacheUsage parses up to 4 MB of transcript. Doing that on every tool call
 *                 would tax the hook that exists to save the user money.
 *   THE COMPUTE   the panel walks the metrics log, the balance log and the graph.
 *   THE CONTEXT   the panel is only worth its own tokens when it says something actionable.
 *
 * So the throttle is checked FIRST, from persisted state, before any file is opened. Everything
 * expensive happens after a clock comparison.
 *
 * NOTHING HERE IS ALLOWED TO BREAK A TOOL CALL. Every entry point returns null on failure rather
 * than throwing: a forecast is a courtesy, and the hook's promise is that a defect in it costs the
 * user nothing.
 */

import { forecastPanel, worthSurfacing } from './forecast.mjs';
import { observeOutcome } from './calibration.mjs';
import { readCacheUsage } from './cache.mjs';
import { readBalance } from './metrics.mjs';

/**
 * How long between two attempts to build the panel.
 *
 * Not a tuning knob so much as an admission: the panel costs a transcript parse, and a user makes
 * many tool calls per minute. Two minutes is short enough that a runway falling into single digits
 * is still caught with turns to spare, and long enough that the check is free in aggregate.
 */
export const SURFACE_INTERVAL_MS =
  Number(process.env.TOKEN_OPTIMIZER_SURFACE_INTERVAL_MS) || 120_000;

/**
 * The context window to measure the runway against.
 *
 * NOT DISCOVERABLE from the transcript: the usage rows carry what was spent, never the ceiling it
 * was spent against. Defaulting is therefore unavoidable, so the default is stated rather than
 * buried, and overridable for anyone running a different window.
 */
export const DEFAULT_CAPACITY =
  Number(process.env.TOKEN_OPTIMIZER_CONTEXT_CAPACITY) || 200_000;

/**
 * What the session has spent, read from its own transcript.
 *
 * `used` is the FULL input size of the most recent request -- cache reads plus cache writes plus
 * fresh input -- which is what the context window actually holds, rather than the marginal cost of
 * that one turn. Summing the per-turn inputs instead would count the same carried prefix once per
 * turn and report a number many times the window size.
 *
 * Returns null rather than a zeroed object when there is nothing to measure, so a caller cannot
 * mistake "no data" for "an empty context".
 */
export function sessionUsage(transcriptPath, { capacity = DEFAULT_CAPACITY } = {}) {
  let turns;
  try {
    turns = readCacheUsage(transcriptPath);
  } catch {
    return null;
  }
  if (!turns?.length) return null;

  const last = turns[turns.length - 1];
  const used = (last.read || 0) + (last.written || 0) + (last.input || 0);
  if (!used) return null;

  return { used, capacity, turns: turns.length };
}

/** Intercepted touches recorded for this session, which converts a per-touch saving to per-turn. */
function touchesFor(dir, sessionId) {
  try {
    return readBalance(dir).filter((e) => e.kind === 'inject' && e.sessionId === sessionId).length;
  } catch {
    return 0;
  }
}

/**
 * Should the forecast interrupt right now, and with what?
 *
 * The state object is the caller's persisted per-session state; this reads `forecast` from it and
 * returns the value to store back, so the throttle and the last-shown runway survive across hook
 * processes. Returning the next state rather than mutating it keeps this testable without a
 * filesystem.
 *
 * @returns { text, state } -- text is null when nothing should be shown.
 */
export function maybeSurface(dir, {
  transcriptPath, sessionId, state = {}, now = Date.now(), findings = [],
} = {}) {
  const previous = state.forecast || null;

  // THE THROTTLE IS FIRST, and deliberately before any I/O. Everything below opens files.
  if (previous?.checkedAt && now - previous.checkedAt < SURFACE_INTERVAL_MS) {
    return { text: null, state: previous };
  }

  let usage;
  try {
    usage = sessionUsage(transcriptPath);
  } catch {
    return { text: null, state: previous };
  }
  // The clock is stamped even when there is nothing to measure, so a session with no usage rows
  // does not re-attempt the transcript parse on every single tool call.
  if (!usage) return { text: null, state: { ...previous, checkedAt: now } };

  let panel;
  try {
    panel = forecastPanel(dir, {
      ...usage,
      sessionId,
      touches: touchesFor(dir, sessionId),
    }, findings);
  } catch {
    return { text: null, state: { ...previous, checkedAt: now } };
  }
  if (!panel) return { text: null, state: { ...previous, checkedAt: now } };

  // worthSurfacing compares against the last panel that was actually SHOWN, not the last one
  // computed. Comparing against the last computed panel would let the runway drift down past the
  // threshold one throttle window at a time and never trip the "crossed it" test.
  const shown = previous?.shown ? { parts: { runway: { withGraph: previous.shown } } } : null;
  if (!worthSurfacing(panel, shown)) {
    return { text: null, state: { ...previous, checkedAt: now } };
  }

  return {
    text: panel.text,
    state: { checkedAt: now, shown: panel.parts.runway.withGraph },
  };
}

/**
 * Closes the calibration loop, at the only moment that can close it.
 *
 * Compaction firing IS the ground truth a runway forecast was predicting, so this belongs on the
 * PreCompact path and nowhere else. `actualTurns` is turns ELAPSED between the prediction and
 * compaction, which is what predictedTurns meant -- so the forecast has to have recorded the turn
 * it was made on, and observeOutcome subtracts.
 *
 * Silent by design: nothing is shown to anybody. It writes one record so that the NEXT session's
 * forecast can be published with a track record instead of as a bare assertion.
 */
export function closeForecast(dir, { transcriptPath, sessionId } = {}) {
  try {
    const usage = sessionUsage(transcriptPath);
    if (!usage) return false;
    observeOutcome(dir, { sessionId, atTurn: usage.turns });
    return true;
  } catch {
    return false;
  }
}
