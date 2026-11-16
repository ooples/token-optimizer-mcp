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
import { OUTPUT_DISCIPLINE, settingsFor } from './task-settings.mjs';

/**
 * Classify a submitted prompt, store the category, and return the context to add.
 *
 * Each prompt starts a fresh classification and a fresh correction window: a
 * session that moves from fixing a bug to writing its report has changed task.
 * The discipline block is said once per context -- again only after a
 * SessionStart rebuilt the context (compaction, resume) -- because text already
 * in context cannot be withdrawn and repeating it only re-bills it.
 *
 * @returns {{category: string, context: string}}
 */
export function promptSubmitted({ sessionId, prompt, cwd, agent, env = process.env, now = Date.now() }) {
  const { category } = classifyPrompt(prompt, { cwd });
  const state = loadState(sessionId, agent);
  state.taskClass = { category, source: 'prompt', calls: 0, at: now };
  const settings = settingsFor(category, env);
  let context = '';
  // Said once per context: again after a compaction or resume rebuilt it.
  const servedAt = Number(state.disciplineServedAt) || 0;
  if (settings.outputDiscipline && (!servedAt || servedAt < (Number(state.contextStartedAt) || 0))) {
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
export function toolCallObserved(state, payload, { cwd, count = true, now = Date.now() } = {}) {
  if (!state) return;
  const before = state.taskClass;
  const next = afterToolCall(before, payload, {
    cwd,
    readPaths: Object.keys(state.seen || {}),
  }, { count });
  if (next === before) return;
  // A correction is a newer decision; a mere count keeps the decision's time,
  // so a racing prompt classification is not overwritten by a tally.
  const moved = !before || next.category !== before.category;
  state.taskClass = { ...next, at: moved ? now : before?.at || now };
}

/** SessionStart: the context was (re)built, so prompt-time text is due again. */
export function contextStarted(state, now = Date.now()) {
  if (state) state.contextStartedAt = now;
}

export { TaskCategory };
