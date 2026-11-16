// GENERATED FILE -- do not edit.
// Source of truth: src/hooks-core/task-session.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Where a session's task category is set and moved, for every client.
 *
 * Two entry points, one per pass (task-class.mjs explains why there are two):
 * - promptSubmitted: a prompt hook classifies the prompt and returns the text
 *   its category's settings call for. Clients with a prompt hook that can add
 *   context call it; the rest keep SessionStart's UNKNOWN-row text.
 * - toolCallObserved: a post-tool hook lets the first calls correct the
 *   category. Only settings applied per call move with it.
 */

import { loadState, saveState } from './policy.mjs';
import { TaskCategory, afterToolCall, classifyPrompt } from './task-class.mjs';
import { OUTPUT_DISCIPLINE, sessionSettings } from './task-settings.mjs';
import { recordClassified, taskArm } from './task-ledger.mjs';

/**
 * Classify a submitted prompt, store the category, and return the context to add.
 *
 * Each prompt starts a fresh classification and a fresh correction window: a
 * session that moves from fixing a bug to writing its report has changed task.
 * The discipline block is said once per context -- again only after a
 * SessionStart rebuilt the context (compaction, resume) -- because text already
 * in context cannot be withdrawn and repeating it only re-bills it.
 *
 * @param {{deliver?: boolean}} options deliver: false classifies without adding text
 * @returns {{category: string, context: string}}
 */
export function promptSubmitted({
  sessionId,
  prompt,
  cwd,
  agent,
  client = null,
  deliver = true,
  env = process.env,
  now = Date.now(),
}) {
  const { category, signals } = classifyPrompt(prompt, { cwd });
  const state = loadState(sessionId, agent);
  // A NEW GENERATION per prompt. Tool observations carry the generation they
  // loaded, and saveState never lets an older generation's correction or count
  // overwrite a newer prompt's decision, however late it is saved. Strictly
  // increasing even for two prompts in one millisecond.
  const gen = Math.max(now, (Number(state.taskClass?.gen) || 0) + 1);
  state.taskClass = { category, source: 'prompt', calls: 0, gen };
  // A held-out session is classified and recorded like any other, and runs the
  // UNKNOWN row (task-ledger.mjs explains why).
  const settings = sessionSettings(state, env, { sessionId });
  recordClassified({ sessionId, gen, category, signals, client, arm: taskArm(sessionId, env) }, env);
  let context = '';
  // Said once per context: again after a compaction or resume rebuilt it.
  const servedAt = Number(state.disciplineServedAt) || 0;
  // `deliver` is false for a client whose prompt hook classifies but cannot add
  // text: SessionStart said the block there, so nothing is served or recorded.
  if (deliver && settings.outputDiscipline && (!servedAt || servedAt < (Number(state.contextStartedAt) || 0))) {
    context = OUTPUT_DISCIPLINE;
    state.disciplineServedAt = now;
  }
  saveState(sessionId, state, agent);
  return { category, context };
}

/**
 * Let one finished tool call correct the session's category, in place.
 * The caller saves the state it already holds; this neither loads nor saves.
 */
export function toolCallObserved(state, payload, { cwd, count = true } = {}) {
  if (!state) return;
  const before = state.taskClass;
  const next = afterToolCall(before, payload, {
    cwd,
    readPaths: Object.keys(state.seen || {}),
  }, { count });
  if (next === before) return;
  // Same generation as what was loaded: saveState merges this observation into
  // that prompt's task, and drops it if a newer prompt has been saved since.
  state.taskClass = { ...next, gen: Number(before?.gen) || 0 };
}

/** SessionStart: the context was (re)built, so prompt-time text is due again. */
export function contextStarted(state, now = Date.now()) {
  if (state) state.contextStartedAt = now;
}

export { TaskCategory };
