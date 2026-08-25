// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/pending.mjs. Regenerate with `npm run sync:hooks`.
/**
 * The eager-invalidation queue: the missing half of staleness.mjs's header.
 *
 * That header describes TWO invalidation paths and says eager exists because
 * lazy "would silently serve stale findings as fresh whenever a change came
 * from outside the agent". `invalidateOnWrite` had been written, tested and
 * documented -- and its only reference in shipped code was a COMMENT in the
 * PreToolUse router. Staleness was lazy-only in production, and the router's
 * own comment ("a write the hook observes is invalidated eagerly by
 * `invalidateOnWrite`") described something that never happened.
 *
 * WHY THAT MATTERS MORE THAN IT SOUNDS. The lazy check compares the anchor's
 * stored hash against disk -- and both the router and the adapter call
 * `indexFile` on every file they observe, which re-points that hash at the new
 * bytes. So for a write the session performed ITSELF, the lazy check is
 * self-defeating: by the next retrieval the anchor already agrees with disk and
 * the finding derived from the old content is served clean. Lazy catches the
 * changes we never saw; only eager catches the ones we did.
 *
 * WHY A QUEUE AND NOT A DIRECT CALL. `invalidateOnWrite` needs the graph, and
 * the graph is a megabyte of JSONL. Loading it on the return path of every
 * write is the cost this shape exists to avoid. So the post-tool hook, which
 * already holds the write's evidence, appends one record here and exits; the
 * next graph read -- `forTouch`/`forCommand`, which load the graph anyway --
 * drains it BEFORE serving anything.
 *
 * The guarantee is unchanged. What must never happen is SERVING a stale finding
 * as fresh, and serve time is where that is enforced.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { invalidateOnWrite } from './staleness.mjs';
import { canonicalPath, isFsSafePath, resolvableCandidates } from './paths.mjs';

const queuePath = (dir) => join(dir, 'pending-invalidation.jsonl');

/**
 * Largest before/after side kept in a queue record.
 *
 * Matched to the graph's own snapshot limit for the same reason it has one: past
 * this size the text is a bundle, a lockfile or a generated asset, and copying
 * it into a queue file would mirror the repository into the graph directory one
 * write at a time. Past the cap the write is simply not queued -- the lazy path
 * still governs it, which is exactly the status quo for that file.
 */
const MAX_SIDE_CHARS = 262_144;

/**
 * Largest queue file appended to.
 *
 * A queue only grows while nothing drains it, which means the retrieval feature
 * is off or every read has failed. Neither is a reason to keep writing: bounded
 * here so a long unattended session cannot turn one directory into a log of
 * every file it touched.
 */
const MAX_QUEUE_BYTES = 8 * 1024 * 1024;

/** The tool payload fields that name the file a mutation landed on. */
function writtenPath(payload, raw) {
  const input = payload?.tool_input || {};
  const response = raw?.tool_response || raw?.toolResponse || {};
  for (const candidate of [
    input.file_path,
    input.path,
    input.notebook_path,
    response.filePath,
    response.file_path,
  ]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return null;
}

/** First string among several possible spellings of the same field. */
function firstString(...values) {
  for (const value of values) if (typeof value === 'string') return value;
  return null;
}

/**
 * The text before the write, reconstructed from a completed edit.
 *
 * PREFERENCE ORDER IS ABOUT EXACTNESS, not convenience. Claude Code's Edit
 * response carries the whole pre-edit file (`originalFile`), which needs no
 * reasoning at all. Failing that, an edit is a known substitution, so reverting
 * `new_string` back to `old_string` in the post-write text reproduces the
 * before side exactly -- but only when the substitution is unambiguous, which
 * is why a `new_string` that now appears more than once is refused rather than
 * guessed at.
 *
 * NULL MEANS "DO NOT QUEUE", and that is deliberate. An unknown before side
 * could be passed as '' -- and `invalidateOnWrite` would then see every symbol
 * in the file as changed and mark every finding anchored anywhere in it, which
 * is the exact over-marking its own comments call worse than the file-level
 * staleness symbols were introduced to avoid. A missed eager invalidation costs
 * what today already costs; a wrong one permanently discounts correct findings.
 */
function beforeText(payload, raw, after) {
  const input = payload?.tool_input || {};
  const response = raw?.tool_response || raw?.toolResponse || {};

  const original = firstString(
    response.originalFile,
    response.original_file,
    response.originalContent,
    response.original_content
  );
  if (original !== null) return original;

  // MultiEdit applies its edits in order, so reverting walks them backwards.
  const edits = Array.isArray(input.edits) ? input.edits : null;
  if (edits) {
    let text = after;
    for (const edit of [...edits].reverse()) {
      const reverted = revert(text, edit);
      if (reverted === null) return null;
      text = reverted;
    }
    return text;
  }

  return revert(after, input);
}

/** Undoes one old->new substitution, or null when it cannot be done exactly. */
function revert(text, edit) {
  const oldString = firstString(edit?.old_string, edit?.oldString);
  const newString = firstString(edit?.new_string, edit?.newString);
  if (oldString === null || newString === null || newString === '') return null;

  const all = edit?.replace_all === true || edit?.replaceAll === true;
  if (all) return text.split(newString).join(oldString);

  const at = text.indexOf(newString);
  if (at < 0) return null;
  // Ambiguous: more than one candidate for the occurrence that was written, and
  // reverting the wrong one fabricates a before side that never existed.
  if (text.indexOf(newString, at + newString.length) >= 0) return null;
  return text.slice(0, at) + oldString + text.slice(at + newString.length);
}

/** The post-write text, read from disk because that is what the write produced. */
function afterText(path) {
  if (!isFsSafePath(path)) return null;
  for (const candidate of resolvableCandidates(path)) {
    try {
      if (statSync(candidate).size > MAX_SIDE_CHARS) return null;
      return readFileSync(candidate, 'utf8');
    } catch {
      // Wrong spelling, or gone again already. Try the next one.
    }
  }
  return null;
}

/**
 * Does this payload carry enough to reconstruct a before side at all?
 *
 * Named tool lists were the alternative and were rejected: every client calls
 * its editor something different (`Edit`, `replace`, `write_to_file`,
 * `apply_patch`), and a list would silently exclude the ones nobody thought of
 * while still charging a file read for every Read that matched by accident.
 * Asking about the EVIDENCE instead covers any client that carries an edit in
 * one of these shapes and costs nothing on the calls that do not.
 */
function hasEditEvidence(payload, raw) {
  const input = payload?.tool_input || {};
  const response = raw?.tool_response || raw?.toolResponse || {};
  if (
    firstString(
      response.originalFile,
      response.original_file,
      response.originalContent,
      response.original_content
    ) !== null
  )
    return true;
  if (Array.isArray(input.edits) && input.edits.length > 0) return true;
  return firstString(input.old_string, input.oldString) !== null;
}

/**
 * The evidence a completed mutation left behind, or null when there is none.
 *
 * Separate from `queueInvalidation` so the caller can be a hook branch that
 * knows nothing about diffs, and so the reconstruction above is testable
 * without a filesystem queue.
 */
export function observedWrite(payload, raw) {
  // CHEAP CHECK FIRST, because this runs after every tool call on every client.
  // Reading the file is the expensive part, and there is no point paying for it
  // on a Read, a Bash or a write whose before side cannot be reconstructed.
  if (!hasEditEvidence(payload, raw)) return null;

  const path = writtenPath(payload, raw);
  if (!path) return null;

  const after = afterText(path);
  if (after === null || after.length > MAX_SIDE_CHARS) return null;

  const before = beforeText(payload, raw, after);
  if (before === null || before.length > MAX_SIDE_CHARS) return null;
  // Nothing changed: a formatter no-op, or a write of identical bytes. Queuing
  // it would mark findings stale against an empty diff.
  if (before === after) return null;

  return { path, before, after };
}

/**
 * Appends one pending write.
 *
 * NEVER THROWS. This runs on a hook's return path, and a queue that cannot be
 * written degrades to the lazy path rather than costing the user a tool call.
 */
export function queueInvalidation(dir, { path, before, after, at } = {}) {
  try {
    if (typeof path !== 'string' || !path.trim()) return false;
    if (typeof before !== 'string' || typeof after !== 'string') return false;
    if (before.length > MAX_SIDE_CHARS || after.length > MAX_SIDE_CHARS)
      return false;

    const file = queuePath(dir);
    try {
      if (statSync(file).size > MAX_QUEUE_BYTES) return false;
    } catch {
      // No queue yet, which is the normal case.
    }

    mkdirSync(dir, { recursive: true });
    appendFileSync(
      file,
      `${JSON.stringify({ path: canonicalPath(path), before, after, at: at ?? Date.now() })}\n`,
      'utf8'
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Applies every queued invalidation and clears the queue.
 *
 * Returns the number of findings marked, so the caller knows whether its
 * in-memory graph is now behind the file on disk and needs re-reading.
 *
 * CLEARED AFTER APPLYING AND UNCONDITIONALLY: a record that cannot be applied
 * must not be retried on every tool call for the rest of the session, and the
 * cost of dropping one is a single missed eager mark that the lazy path still
 * has a chance at.
 */
export function drainInvalidations(dir, graph) {
  let records;
  try {
    const file = queuePath(dir);
    if (!existsSync(file)) return 0;
    records = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          // A torn append costs one record, not the queue.
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return 0;
  }

  let marked = 0;
  for (const record of records) {
    if (!record || typeof record.path !== 'string' || !record.path) continue;
    if (typeof record.before !== 'string' || typeof record.after !== 'string')
      continue;
    try {
      const result = invalidateOnWrite(
        dir,
        graph,
        record.path,
        record.before,
        record.after
      );
      marked += Array.isArray(result) ? result.length : 0;
    } catch {
      // One bad record must not stop the rest, and must not stop the tool call.
    }
  }

  try {
    rmSync(queuePath(dir), { force: true });
  } catch {
    // Held open by a concurrent hook. The next drain re-applies these records,
    // which is safe: marking an already-marked finding is idempotent.
  }

  return marked;
}
