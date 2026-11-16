// GENERATED FILE -- do not edit.
// Source of truth: src/hooks-core/task-ledger.mjs. Regenerate with `npm run sync:hooks`.
/**
 * What task classification did, recorded so it can be judged (task-report.mjs).
 *
 * THREE QUESTIONS, THREE RECORDS, one append-only file in the user's
 * token-optimizer home (all repositories together, never sent anywhere):
 * - `classified` (prompt hook): which category the prompt got, from which
 *   signals, and which ARM the session is in.
 * - `settled` (Stop): the category the turn ended on after the tool calls had
 *   their say -- read from saved state, so a correction the merge rejected is
 *   never counted as one.
 * - `outcome` (the background transcript fold): what each prompt cost, so a
 *   category's cost can be compared between its two arms.
 *
 * THE HOLDOUT IS WHAT MAKES A COST A SAVING. A share of sessions -- the
 * injection holdout's knob and fraction, TOKEN_OPTIMIZER_INJECTION_HOLDOUT(
 * _FRACTION), default 10% -- is classified and recorded like every other but
 * runs on the UNKNOWN row: today's product before categories. Without it a
 * category's cost is a description; with it, it is a measured counterfactual.
 * The draw is salted apart from the injection holdout's own, so one session is
 * not silently the subject of both experiments at once.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { holdoutSettings, holdoutUnit } from './injection-holdout.mjs';

export const LEDGER_FILE = 'task-classes.jsonl';
/** Trimmed to its newer half past this size; a record is ~150 bytes. */
export const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
/** Bumped when the record shape or the arm draw changes, so old rows are not mixed in. */
export const TASK_LEDGER_GENERATION = 1;

export const ARM_CLASSIFIED = 'classified';
export const ARM_HOLDOUT = 'holdout';

const home = (env) => env.TOKEN_OPTIMIZER_HOME || join(homedir(), '.token-optimizer');
export const ledgerPath = (env = process.env) => join(home(env), LEDGER_FILE);

/**
 * The session's arm. Deterministic in the session id, so every hook process of
 * one session agrees without sharing state. A session with no id, or with the
 * holdout switched off, is classified.
 */
export function taskArm(sessionId, env = process.env) {
  const settings = holdoutSettings(env);
  if (!settings.enabled || !sessionId) return ARM_CLASSIFIED;
  return holdoutUnit(String(sessionId), 'task-class') < settings.fraction ? ARM_HOLDOUT : ARM_CLASSIFIED;
}

/**
 * The signal NAMES a classification used, never their values: a large-input
 * signal carries a file path, and the ledger records what decided, not what
 * the user was working on.
 */
function signalNames(signals) {
  return Array.isArray(signals)
    ? [...new Set(signals.map((s) => String(s).replace(/(:large-input):[\s\S]*$/, '$1')))].slice(0, 8)
    : [];
}

/** Append one record. Best effort: telemetry must never cost a hook its answer. */
export function recordTaskEvent(event, env = process.env) {
  try {
    const path = ledgerPath(env);
    mkdirSync(home(env), { recursive: true, mode: 0o700 });
    try {
      if (statSync(path).size > MAX_LEDGER_BYTES) {
        const text = readFileSync(path, 'utf8');
        const half = text.slice(Math.floor(text.length / 2));
        writeFileSync(path, half.slice(half.indexOf('\n') + 1), { mode: 0o600 });
      }
    } catch {
      // No ledger yet.
    }
    appendFileSync(path, `${JSON.stringify({ g: TASK_LEDGER_GENERATION, at: Date.now(), ...event })}\n`, {
      mode: 0o600,
    });
  } catch {
    // Lost: one record fewer of evidence.
  }
}

export function recordClassified({ sessionId, gen, category, signals, client, arm }, env = process.env) {
  if (!sessionId || !gen) return;
  recordTaskEvent(
    { k: 'classified', s: String(sessionId), gen, c: category, arm, client: client || null, sig: signalNames(signals) },
    env
  );
}

export function recordSettled({ sessionId, taskClass }, env = process.env) {
  // gen 0 is a session no prompt hook classified: its category came from tool
  // calls alone (clients without a prompt hook). Recorded, so the mix of those
  // clients is visible in the raw ledger; the report's correction rate counts
  // only prompt-classified generations, since there is nothing to correct.
  if (!sessionId || !taskClass || typeof taskClass.category !== 'string') return;
  recordTaskEvent(
    {
      k: 'settled',
      s: String(sessionId),
      gen: taskClass.gen || 0,
      c: taskClass.category,
      src: taskClass.source,
      calls: taskClass.calls,
      arm: taskArm(sessionId, env),
    },
    env
  );
}

/**
 * One prompt's cost, from the fold. `at` is the prompt's transcript timestamp;
 * the report matches it to the classification made when the prompt arrived.
 */
export function recordOutcomes(sessionId, segments, env = process.env) {
  if (!sessionId || !Array.isArray(segments)) return;
  for (const segment of segments) {
    if (!(segment.at > 0) || !(segment.costUnits >= 0)) continue;
    recordTaskEvent(
      { k: 'outcome', s: String(sessionId), promptAt: segment.at, cu: Math.round(segment.costUnits), out: segment.outputTokens | 0 },
      env
    );
  }
}

/** Every record of the current generation, oldest first. */
export function readTaskEvents(env = process.env, { since = 0 } = {}) {
  let text = '';
  try {
    text = readFileSync(ledgerPath(env), 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && row.g === TASK_LEDGER_GENERATION && (row.at || 0) >= since) rows.push(row);
    } catch {
      // A torn final line from a concurrent append.
    }
  }
  return rows;
}
