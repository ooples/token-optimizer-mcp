// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/recording.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Pressure to record, at the moment a conclusion exists to record.
 *
 * The read side of this product is enforced hard: PreToolUse REFUSES `Read`, `Grep` and `Edit` and
 * names the tool to use instead, so there is no way to work without going through it. The write
 * side had nothing -- SessionStart asks the model to call `wiki_write` and that is all.
 *
 * Measured on a machine running this for weeks: two project graphs holding 340 and 48 read events
 * and ZERO findings between them. In a long working session on this very repository, with that
 * SessionStart line present the whole time, `wiki_write` was called exactly zero times until
 * somebody asked why. Advisory text loses to whatever the model is already doing, every time.
 *
 * A refusal is the wrong instrument here. `wiki_write` is not a substitute for another tool, so
 * there is nothing to deny -- denying an edit until a finding is recorded would hold work hostage
 * to bookkeeping, which is worse than the problem. What is available is TIMING and SPECIFICITY:
 *
 *   WHEN   after real work has happened, not at the start when there is nothing to say, and
 *          again at PreCompact -- the one moment where an unrecorded conclusion is about to be
 *          destroyed rather than merely forgotten.
 *   WHAT   the files this session actually changed, by name. "Record what you learned" is
 *          wallpaper; "you have changed keepwarm.mjs 6 times and this project has no findings"
 *          is a question with an answer.
 *   ONCE   per session, per surface. A nudge that repeats becomes the thing you learn to skip,
 *          and this product's own injection design already turns on that observation.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Edits in one session before an empty graph is worth mentioning. */
export const NUDGE_AFTER_EDITS = Number(process.env.TOKEN_OPTIMIZER_NUDGE_AFTER) || 8;

/** Tools that mean a decision was made, rather than that something was looked at. */
const SUBSTANTIVE = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Does this tool call represent work worth having a conclusion about? */
export function isSubstantive(toolName) {
  return SUBSTANTIVE.has(String(toolName || ''));
}

/**
 * How many findings this project's graph holds.
 *
 * Counted from the graph rather than from session state, because the question is not "did you
 * record something just now" but "has this project ever learned anything" -- a graph with findings
 * already in it does not need prompting, and one with none is the case that matters.
 */
export function findingCount(dir) {
  // READ THE DURABLE RECORD, not load(). load() serves a compacted view whose contents depend on
  // when compaction last ran -- a graph with findings freshly appended reports zero through it,
  // which would fire this nudge at exactly the wrong people: the ones already recording.
  // graph.jsonl is the append-only truth, and every node carries its `kind`.
  const path = join(dir, 'graph.jsonl');
  if (!existsSync(path)) return 0;

  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return 0;
  }

  // DISTINCT IDS. A node rewritten -- pinned, corrected, retired -- appends another record, so
  // counting lines would report one finding as several and silence the nudge on a graph that has
  // learned one thing twice.
  const seen = new Set();
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const node = JSON.parse(line);
      if (node?.kind === 'finding' && node.id) seen.add(node.id);
    } catch {
      /* a torn line costs a count, not the hook */
    }
  }
  return seen.size;
}

/**
 * The nudge, or null.
 *
 * Returns null far more often than not, which is the point: it fires once, after real work, on a
 * project that has learned nothing, and never again in that session.
 *
 * @param state  the session's persisted state; `recordingNudged` is read and set by the caller
 * @param edits  substantive tool calls seen this session
 * @param files  paths edited this session, most-recent-first
 */
export function recordingNudge(dir, { state = {}, edits = 0, files = [] } = {}) {
  if (state.recordingNudged) return null;
  if (edits < NUDGE_AFTER_EDITS) return null;
  if (findingCount(dir) > 0) return null;

  // Named, and capped. Three is enough to make it concrete without turning the nudge into a
  // file listing nobody reads.
  const named = [...new Set(files)].slice(0, 3);
  const subject = named.length
    ? named.map((f) => f.split(/[\\/]/).pop()).join(', ')
    : 'this project';

  return (
    `You have made ${edits} edits this session (${subject}) and this project's graph holds no `
    + 'findings at all -- so the next session starts from nothing and re-derives whatever you have '
    + 'worked out. Call wiki_write for anything durable you concluded: a dead end and why, a '
    + 'decision and what you rejected, a command that finally worked. Anchor it to the file it is '
    + 'about. Not worth recording: what the code plainly says.'
  );
}

/**
 * The same question at PreCompact, where the answer is about to be lost.
 *
 * Separate from the nudge above and deliberately not gated on `recordingNudged`: compaction is the
 * event this whole subsystem exists for, and an unrecorded conclusion does not survive it. This is
 * the last honest moment to ask.
 */
export function compactionNudge(dir, { edits = 0 } = {}) {
  if (edits < 1) return null;
  if (findingCount(dir) > 0) return null;
  return (
    'Compaction is about to discard this session\'s reasoning, and nothing was recorded to the '
    + 'graph. If you concluded anything durable -- a dead end, a decision and its rejected '
    + 'alternative, an invocation that worked -- call wiki_write with a file anchor before it goes.'
  );
}

/**
 * One final reflection by the SAME model that did the work.
 *
 * Codex Stop hooks can continue the active turn once with a new prompt. That is
 * materially different from the detached harvest worker: the active model still
 * holds the reasoning, spends no second-model call, and decides whether anything
 * non-obvious is worth writing. `stopHookActive` is Codex's loop guard; honoring
 * it is what makes this a single reflection rather than an unfinishable turn.
 */
export function semanticHarvestPrompt({
  edits = 0,
  files = [],
  model = '',
  stopHookActive = false,
} = {}) {
  if (stopHookActive || edits < 1) return null;

  const named = [...new Set(files)]
    .slice(0, 3)
    .map((file) => String(file).split(/[\\/]/).pop())
    .filter(Boolean);
  const subject = named.length ? ` Work touched ${named.join(', ')}.` : '';
  const actor = String(model || '').trim()
    ? ` You are the active ${String(model).trim()} model that did the reasoning.`
    : ' You are the active model that did the reasoning.';

  return (
    'Before finishing, perform the semantic harvest yourself.'
    + actor
    + subject
    + ' If this work produced a durable, non-obvious conclusion -- a failed approach and why, '
    + 'a decision and its rejected alternative, or a command that finally worked -- call '
    + 'wiki_write now with a real file anchor. Do not delegate this to another model or an '
    + 'external harvester. Include: the concrete evidence, when the finding applies, a calibrated '
    + 'confidenceLabel (verified/probable/speculative), its project/organization/global scope, '
    + 'and anything that would invalidate it. If there is no such conclusion, do not invent one; '
    + 'finish normally.'
  );
}
