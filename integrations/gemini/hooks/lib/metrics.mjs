// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/metrics.mjs. Regenerate with `npm run sync:hooks`.
/**
 * P5: proving the graph earns its keep.
 *
 * The design says plainly that a wiki which cannot show a positive token
 * balance is overhead wearing a knowledge-graph costume. This file is how that
 * gets found out from our own telemetry rather than from users.
 *
 * THE HOLDOUT, AND WHY IT IS STRATIFIED. Injection is silently skipped on a
 * random slice of touches, and cost is compared between served and withheld.
 * Naively randomising across all touches is noisy, because touches are wildly
 * heterogeneous -- a 40-line config and a 3,000-line module are not comparable
 * units. So the holdout is stratified BY ANCHOR: the decision for a given file
 * is made from a hash of (file, epoch), so the same file lands in the holdout
 * during some epochs and the treated arm in others. The comparison becomes
 * within-file, which removes the dominant source of variance and makes the
 * number mean something at far lower volume.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Read per call, not once at module load.
 *
 * Hooks are short-lived, but the same module is also imported by long-running
 * callers, and a process started before a config change would otherwise honour
 * the old value indefinitely with no way to tell. Reading here costs nothing
 * and removes a class of "I changed the setting and nothing happened" bug.
 */
function holdoutFraction() {
  const raw = Number(process.env.TOKEN_OPTIMIZER_HOLDOUT);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.1;
}

/** Epoch length for stratification: a file switches arms roughly daily. */
const EPOCH_MS = 86_400_000;

const metricsPath = (dir) => join(dir, 'metrics.jsonl');

/**
 * Is this touch in the holdout arm?
 *
 * Deterministic in (anchor, epoch) rather than random per call, so repeated
 * touches of the same file within a session are consistently in one arm.
 * Flipping arms mid-session would contaminate both.
 */
export function inHoldout(anchorKey, now = Date.now()) {
  const fraction = holdoutFraction();
  if (fraction <= 0) return false;
  const epoch = Math.floor(now / EPOCH_MS);
  const digest = createHash('sha1').update(`${anchorKey}:${epoch}`).digest();
  return (digest[0] / 256) < fraction;
}

export function record(dir, event) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(metricsPath(dir), JSON.stringify({ ...event, at: Date.now() }) + '\n');
  } catch {
    // Metrics must never break a tool call.
  }
}

function readAll(dir) {
  const path = metricsPath(dir);
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A truncated final line is normal; skip it.
    }
  }
  return out;
}

/**
 * The report.
 *
 * `tokensAvoided` is an ESTIMATE and is labelled as one everywhere it appears.
 * It is the difference in mean downstream cost between the treated and holdout
 * arms, multiplied by treated touches. Reporting it as a measured fact would be
 * the same overclaiming this project criticises competitors for.
 */
export function report(dir) {
  const events = readAll(dir);

  const injections = events.filter((e) => e.kind === 'inject');
  const treated = injections.filter((e) => !e.holdout);
  const withheld = injections.filter((e) => e.holdout);

  const mean = (rows, field) =>
    rows.length ? rows.reduce((sum, r) => sum + (r[field] || 0), 0) / rows.length : 0;

  const injectedTokens = treated.reduce((sum, e) => sum + (e.tokens || 0), 0);
  const harvestTokens = events
    .filter((e) => e.kind === 'harvest')
    .reduce((sum, e) => sum + (e.tokens || 0), 0);

  // Downstream cost = what the session spent on this anchor AFTER the touch.
  const treatedCost = mean(treated, 'downstream');
  const withheldCost = mean(withheld, 'downstream');

  const perTouchSaving = withheldCost - treatedCost;
  const estimatedAvoided = Math.max(0, Math.round(perTouchSaving * treated.length));

  // Below this, arm means are noise and a ratio would be theatre.
  const sufficient = treated.length >= 20 && withheld.length >= 5;

  return {
    injections: treated.length,
    holdouts: withheld.length,
    staleServed: injections.filter((e) => e.stale).length,
    staleRate: injections.length ? injections.filter((e) => e.stale).length / injections.length : 0,
    injectedTokens,
    harvestTokens,
    estimatedTokensAvoided: sufficient ? estimatedAvoided : null,
    netTokens: sufficient ? estimatedAvoided - injectedTokens - harvestTokens : null,
    sufficientData: sufficient,
    verdict: !sufficient
      ? `insufficient data (${treated.length} treated, ${withheld.length} holdout; need 20 and 5)`
      : estimatedAvoided > injectedTokens + harvestTokens
        ? 'the graph is saving more than it costs'
        : 'the graph is NOT yet paying for itself',
  };
}

/**
 * The earned index budget.
 *
 * Answers a real objection to a fixed cap: a mature project with a dense,
 * useful graph deserves a richer session index than a young one, but scaling
 * with graph SIZE makes the worst case unbounded exactly where the graph is
 * largest -- and size is not the same as usefulness.
 *
 * So the budget is earned from measured hit rate and bounded at both ends. A
 * graph whose index leads to queries grows its allowance; a noisy one shrinks
 * back toward the floor. Nobody configures it, and it cannot run away.
 */
export function indexBudget(dir, { floor = 150, base = 300, ceiling = 1200 } = {}) {
  const events = readAll(dir);
  const listed = events.filter((e) => e.kind === 'index').length;
  const queries = events.filter((e) => e.kind === 'query').length;

  if (listed < 5) return base;

  const hitRate = queries / listed;
  // 0% hit rate falls to the floor; ~50% and above reaches the ceiling.
  const scaled = Math.round(floor + (ceiling - floor) * Math.min(1, hitRate * 2));
  return Math.max(floor, Math.min(ceiling, scaled));
}
