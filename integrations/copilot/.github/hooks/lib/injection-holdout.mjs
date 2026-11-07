// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/injection-holdout.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Does each kind of context this package injects pay for itself?
 *
 * WHY THIS EXISTS. Every block of context a hook adds is billed on every later
 * request of the session, because it sits in the conversation the model
 * re-reads. TokenEconomizer's paper measured exactly this failure in a fixed
 * strategy: Aider's RepoMap "bills its map on every turn", and adding it made
 * their controller save LESS in four of five settings. This package injects a
 * session index, standing rules, graph findings on file touches, advisories and
 * recording guidance. Each is plausible. None had been shown to lower the cost
 * of a session it rides in, and a plausible injection that costs more than it
 * saves is the defect this file is built to catch.
 *
 * THE DESIGN. A small, fixed fraction of sessions (10% by default) is enrolled.
 * An enrolled session withholds exactly ONE injection class, chosen from the
 * session id, so every class is withheld in about one session in eighty and
 * nothing else about the session changes. After the session has finished, its
 * cache-aware cost per prompt is computed from its transcript (in the
 * background, at the next session start) and compared against sessions that
 * served everything, with the same permutation test Layer 2 uses
 * (`loo.permutationP`).
 *
 *   * A class that sessions are measurably CHEAPER without is gated: it stops
 *     being injected. The test keeps running in REVERSE -- an enrolled session
 *     now SERVES the gated class -- so a gate that later turns out wrong is
 *     reversed by the same evidence that set it.
 *   * A class that sessions are measurably dearer without is marked as paying.
 *   * Everything else is still collecting, and says how many sessions it has.
 *
 * WHAT IS NEVER WITHHELD. The tool policy itself (what refusals mean), crash and
 * runtime-floor notices, storage notices and deferred tool context: withholding
 * those breaks the session rather than measuring it.
 *
 * WHAT IT COSTS A USER. One session in ten loses one kind of context. The worst
 * case is the cost that context would have saved, once, in that session -- the
 * same exposure Layer 2 accepts, at the class level instead of per finding.
 *
 * Configuration (all optional):
 *   TOKEN_OPTIMIZER_INJECTION_HOLDOUT=on|off       default on
 *   TOKEN_OPTIMIZER_INJECTION_HOLDOUT_FRACTION=0.1
 * An explicit TOKEN_OPTIMIZER_EXPERIMENT_ARM (benchmark runs) turns it off, so a
 * benchmark arm is never silently perturbed.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { permutationP } from './loo.mjs';
import { writeAtomically } from './policy.mjs';

export const WITHHOLDABLE = Object.freeze([
  'standing',
  'index',
  'graph',
  'advisory',
  'guidance',
  'harvest-nudge',
  'over-window',
  'hook-latency',
]);

export const EVENTS_FILE = 'holdout-events.jsonl';
export const OUTCOMES_FILE = 'holdout-outcomes.json';
export const POLICY_FILE = 'holdout-policy.json';
export const MAX_OUTCOMES = 600;
/** The injection log is trimmed to its newer half past this size. */
export const MAX_EVENTS_BYTES = 4 * 1024 * 1024;
export const MIN_WITHHELD = 8;
export const MIN_SERVED = 30;
export const ALPHA = 0.05;
/** Bumped when the class list or the arm assignment changes, so old sessions are not mixed in. */
export const HOLDOUT_GENERATION = 1;

const OFF = /^(0|false|no|off)$/i;

export function holdoutSettings(env = process.env) {
  const fraction = Number(env.TOKEN_OPTIMIZER_INJECTION_HOLDOUT_FRACTION);
  return {
    enabled:
      !OFF.test(String(env.TOKEN_OPTIMIZER_INJECTION_HOLDOUT ?? '').trim()) &&
      !String(env.TOKEN_OPTIMIZER_EXPERIMENT_ARM ?? '').trim(),
    fraction: Number.isFinite(fraction) && fraction >= 0 && fraction <= 0.5 ? fraction : 0.1,
  };
}

function unit(sessionId, salt) {
  const digest = createHash('sha256').update(`${HOLDOUT_GENERATION}:${salt}:${sessionId}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * The class this session is the experiment for, or null for an ordinary session.
 * Deterministic in the session id, so every hook process of one session agrees
 * without sharing any state.
 */
export function armFor(sessionId, settings = holdoutSettings()) {
  if (!settings.enabled || !sessionId) return null;
  if (unit(sessionId, 'enrol') >= settings.fraction) return null;
  return WITHHOLDABLE[Math.floor(unit(sessionId, 'class') * WITHHOLDABLE.length)];
}

export function loadPolicy(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, POLICY_FILE), 'utf8'));
    return {
      gated: Array.isArray(parsed?.gated) ? parsed.gated : [],
      decidedAt: parsed?.decidedAt || 0,
      looks: parsed?.looks && typeof parsed.looks === 'object' ? parsed.looks : {},
    };
  } catch {
    return { gated: [], looks: {} };
  }
}

/**
 * Whether `cls` is delivered in this session.
 *
 *   ordinary session  -> served, unless the class is gated
 *   enrolled for cls  -> the opposite of the ordinary answer
 */
export function shouldServe(cls, { sessionId, dir, settings = holdoutSettings(), policy = null } = {}) {
  if (!WITHHOLDABLE.includes(cls)) return true;
  const gated = new Set((policy || (dir ? loadPolicy(dir) : { gated: [] })).gated);
  const ordinary = !gated.has(cls);
  return armFor(sessionId, settings) === cls ? !ordinary : ordinary;
}

/** Account what was injected, by class: characters now, tokens at analysis. */
export function recordInjection(dir, { sessionId, cls, chars, served }) {
  if (!dir || !sessionId || !cls) return;
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, EVENTS_FILE);
    try {
      if (statSync(path).size > MAX_EVENTS_BYTES) {
        const text = readFileSync(path, 'utf8');
        const half = text.slice(Math.floor(text.length / 2));
        writeFileSync(path, half.slice(half.indexOf('\n') + 1));
      }
    } catch {
      // No log yet.
    }
    appendFileSync(
      path,
      `${JSON.stringify({ g: HOLDOUT_GENERATION, s: sessionId, c: cls, n: chars | 0, v: served ? 1 : 0, at: Date.now() })}\n`
    );
  } catch {
    // Accounting is best effort.
  }
}

export function loadOutcomes(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, OUTCOMES_FILE), 'utf8'));
    return parsed && typeof parsed.sessions === 'object' ? parsed : { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

/**
 * Record a finished session's cost. Called by the background fold, once the
 * session's transcript is no longer being written.
 */
export function recordOutcome(dir, { sessionId, costUnits, prompts, endedAt }, settings = holdoutSettings()) {
  if (!sessionId || !(prompts > 0) || !(costUnits >= 0)) return;
  const outcomes = loadOutcomes(dir);
  outcomes.sessions[sessionId] = {
    arm: armFor(sessionId, settings) || 'none',
    costPerPrompt: costUnits / prompts,
    prompts,
    endedAt: endedAt || Date.now(),
    g: HOLDOUT_GENERATION,
  };
  const entries = Object.entries(outcomes.sessions)
    .sort((a, b) => (a[1].endedAt || 0) - (b[1].endedAt || 0))
    .slice(-MAX_OUTCOMES);
  outcomes.sessions = Object.fromEntries(entries);
  try {
    mkdirSync(dir, { recursive: true });
    writeAtomically(join(dir, OUTCOMES_FILE), JSON.stringify(outcomes));
  } catch {
    // Lost: one session fewer of evidence.
  }
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * The verdict per class, and the gate decision that follows from it.
 *
 * For a class that is not gated, "withheld" sessions are its enrolled ones and
 * "served" sessions are the ordinary ones. For a gated class the roles swap:
 * its enrolled sessions are the ones that SERVED it.
 */
/**
 * Holm step-down adjustment: the family-wise error stays at `ALPHA` across all
 * classes tested together. Eight classes tested one by one at 0.05 would wrongly
 * gate a useful class about a third of the time.
 */
export function holm(pValues) {
  const order = pValues
    .map((p, index) => ({ p, index }))
    .filter((item) => item.p != null)
    .sort((a, b) => a.p - b.p);
  const adjusted = pValues.map(() => null);
  let running = 0;
  order.forEach((item, rank) => {
    running = Math.max(running, Math.min(1, (order.length - rank) * item.p));
    adjusted[item.index] = running;
  });
  return adjusted;
}

/** The smallest power of two at or below n, from MIN_WITHHELD up; 0 below it. */
export function milestone(n) {
  if (n < MIN_WITHHELD) return 0;
  let step = MIN_WITHHELD;
  while (step * 2 <= n) step *= 2;
  return step;
}

// Session cost is heavy-tailed: one long debugging session outweighs twenty
// ordinary ones. The test runs on log cost, where a class's effect is a ratio.
const logCost = (value) => Math.log(Math.max(value, 1e-9));

export function analyze(dir, { policy = loadPolicy(dir) } = {}) {
  const outcomes = Object.values(loadOutcomes(dir).sessions).filter((row) => row.g === HOLDOUT_GENERATION);
  const ordinary = outcomes.filter((row) => row.arm === 'none').map((row) => logCost(row.costPerPrompt));
  const gated = new Set(policy.gated);
  const rows = [];
  for (const cls of WITHHOLDABLE) {
    const enrolled = outcomes.filter((row) => row.arm === cls).map((row) => logCost(row.costPerPrompt));
    const isGated = gated.has(cls);
    const withheld = isGated ? ordinary : enrolled;
    const served = isGated ? enrolled : ordinary;
    const row = {
      cls,
      gated: isGated,
      withheld: withheld.length,
      served: served.length,
      enrolled: enrolled.length,
      verdict: 'collecting',
      p: null,
      pAdjusted: null,
      effect: null,
    };
    const enough = isGated
      ? served.length >= MIN_WITHHELD && withheld.length >= MIN_SERVED
      : withheld.length >= MIN_WITHHELD && served.length >= MIN_SERVED;
    if (enough) {
      row.p = permutationP(served, withheld, { seed: 0x5eed + WITHHOLDABLE.indexOf(cls) });
      // Geometric-mean ratio of cost per prompt, withheld over served, minus one.
      row.effect = Math.exp(mean(withheld) - mean(served)) - 1;
    }
    rows.push(row);
  }
  const adjusted = holm(rows.map((row) => row.p));
  rows.forEach((row, index) => {
    if (row.p == null) return;
    row.pAdjusted = adjusted[index];
    row.verdict =
      row.pAdjusted < ALPHA
        ? row.effect < 0
          ? 'costs-more-than-it-saves'
          : 'pays-for-itself'
        : 'no-detectable-effect';
  });
  return rows;
}

/** Apply the verdicts: gate what costs more than it saves, ungate what pays. */
export function decide(dir, { now = Date.now() } = {}) {
  const policy = loadPolicy(dir);
  const rows = analyze(dir, { policy });
  const gated = new Set(policy.gated);
  const looks = { ...(policy.looks || {}) };
  let looked = false;
  for (const row of rows) {
    // A DECISION ONLY AT A MILESTONE. Re-testing on every fold is peeking: the
    // chance that some look crosses the threshold by luck grows with every
    // session. Deciding only when the enrolled count reaches a new power of two
    // bounds the looks per class to a handful over its whole life.
    const mark = milestone(row.enrolled);
    if (!mark || (looks[row.cls] || 0) >= mark) continue;
    looks[row.cls] = mark;
    looked = true;
    if (row.verdict === 'costs-more-than-it-saves') gated.add(row.cls);
    if (row.verdict === 'pays-for-itself') gated.delete(row.cls);
  }
  const next = [...gated].sort();
  if (looked || next.join(',') !== [...policy.gated].sort().join(',')) {
    try {
      mkdirSync(dir, { recursive: true });
      writeAtomically(join(dir, POLICY_FILE), JSON.stringify({ gated: next, decidedAt: now, looks }));
    } catch {
      // Undecided: the next fold tries again.
    }
  }
  return { gated: next, rows };
}

/** Characters injected per class, over every recorded session. */
export function injectedTotals(dir) {
  const totals = {};
  try {
    for (const line of readFileSync(join(dir, EVENTS_FILE), 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event.g !== HOLDOUT_GENERATION || !event.v) continue;
        totals[event.c] = (totals[event.c] || 0) + (event.n || 0);
      } catch {
        // Skip a torn line.
      }
    }
  } catch {
    // No events yet.
  }
  return totals;
}

/**
 * Filter one hook's context parts through the experiment, accounting each.
 * Off means off: every part is served and nothing is recorded or gated.
 *
 * @param {Array<{cls: string, text: string|null}>} parts
 * @returns {Array<{cls: string, text: string}>} the parts to deliver, in order
 */
export function applyHoldout(parts, { dir, sessionId, settings = holdoutSettings() } = {}) {
  const present = (Array.isArray(parts) ? parts : []).filter(
    (part) => part && typeof part.text === 'string' && part.text.trim()
  );
  if (!settings.enabled || !dir || !sessionId) return present;
  const policy = loadPolicy(dir);
  const out = [];
  for (const part of present) {
    if (!WITHHOLDABLE.includes(part.cls)) {
      out.push(part);
      continue;
    }
    const served = shouldServe(part.cls, { sessionId, settings, policy });
    recordInjection(dir, { sessionId, cls: part.cls, chars: part.text.length, served });
    if (served) out.push(part);
  }
  return out;
}
