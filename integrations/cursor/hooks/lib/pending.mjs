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
import { invalidateChangedAnchors, invalidateOnWrite } from './staleness.mjs';
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
 * Canonical tool names that mean bytes on disk changed.
 *
 * THE NORMALISED SET, not any client's own vocabulary. `normalizePayload` has
 * already mapped `replace`, `write_file`, `apply_patch`, `str_replace`,
 * `search_replace` and the rest onto these three through decide.mjs's alias
 * table -- and a tool that table cannot map arrives as null and exits the hook
 * before this module is reached at all. So matching here is both complete for
 * every client the adapter serves and impossible to spell wrong.
 *
 * `NotebookEdit` and the MCP `smart_edit`/`smart_write` tools were absent for as
 * long as `normalizeTool` mapped them to null. That was a gap in the alias table
 * rather than in this file, and it has since been closed there: all three now
 * arrive as `Edit` or `Write` and are matched by the set below without it having
 * to learn a fourth name.
 */
const MUTATING = new Set(['Edit', 'MultiEdit', 'Write']);

/** Files an apply_patch-style program declares it is about to change. */
function patchTargets(payload) {
  const command = payload?.tool_input?.command;
  if (typeof command !== 'string') return [];
  const out = [];
  for (const match of command.matchAll(
    /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm
  )) {
    const candidate = match[1].trim().replace(/^['"]|['"]$/g, '');
    // Bounded: one patch naming a thousand files must not append a thousand
    // queue records on a hook path.
    if (candidate && out.length < 20) out.push(candidate);
  }
  return out;
}

/**
 * Everything a completed mutation left behind that is worth queueing.
 *
 * TWO GRADES OF EVIDENCE, and the distinction is the point:
 *
 *   { path, before, after }  a reconstructable edit. The drain builds a real
 *                            diff and marks only the symbols that moved.
 *   { path }                 a whole-file write, or a patch program. No before
 *                            side exists anywhere in the payload, so the drain
 *                            compares stored hashes against disk instead.
 *
 * The second grade is what closes the biggest hole. A whole-file write is the
 * commonest write shape there is, and before it was added those writes fell
 * through to a lazy path that CANNOT see the session's own writes at all --
 * `indexFile` refreshes the anchor before the lazy check ever looks at it. They
 * were uncovered, not degraded.
 *
 * Returns an array, because one apply_patch program changes several files.
 */
export function observedWrites(payload, raw) {
  if (!MUTATING.has(String(payload?.tool_name || ''))) return [];

  const path = writtenPath(payload, raw);
  if (path) {
    // The expensive branch is guarded: reading the file only pays off when the
    // payload can actually yield a before side.
    if (hasEditEvidence(payload, raw)) {
      const after = afterText(path);
      if (after !== null && after.length <= MAX_SIDE_CHARS) {
        const before = beforeText(payload, raw, after);
        // Identical bytes: a formatter no-op, or a rewrite of the same content.
        // Nothing changed, so nothing is stale.
        if (before === after) return [];
        if (before !== null && before.length <= MAX_SIDE_CHARS)
          return [{ path, before, after }];
      }
    }
    // Hash grade. Deliberately NOT `{ path, before: '', after }`: an empty
    // before side makes every symbol in the file look changed, and the eager
    // mark is a stored flag no later check ever clears.
    return [{ path }];
  }

  // Codex and code-mode clients carry the whole patch as program text with no
  // file_path field at all, which is why this recorded nothing for them. The
  // hash grade needs only the path, so the patch headers are enough.
  return patchTargets(payload).map((target) => ({ path: target }));
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
    // BOTH SIDES OR NEITHER. A record carrying only one of them cannot produce
    // a diff and must not pretend to, so it is written as a path-only record
    // and the drain resolves it by comparing hashes.
    const diffable =
      typeof before === 'string' &&
      typeof after === 'string' &&
      before.length <= MAX_SIDE_CHARS &&
      after.length <= MAX_SIDE_CHARS;

    const file = queuePath(dir);
    try {
      if (statSync(file).size > MAX_QUEUE_BYTES) return false;
    } catch {
      // No queue yet, which is the normal case.
    }

    mkdirSync(dir, { recursive: true });
    appendFileSync(
      file,
      `${JSON.stringify({
        path: canonicalPath(path),
        ...(diffable ? { before, after } : {}),
        at: at ?? Date.now(),
      })}\n`,
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
    const diffable =
      typeof record.before === 'string' && typeof record.after === 'string';
    try {
      // TWO GRADES, ONE QUEUE. A record carrying both sides gets a real diff and
      // symbol-precise marking; one carrying only a path gets the hash
      // comparison -- the same comparison the lazy path makes, and one that is
      // only meaningful HERE, before `indexFile` refreshes the anchor.
      const result = diffable
        ? invalidateOnWrite(dir, graph, record.path, record.before, record.after)
        : invalidateChangedAnchors(dir, graph, record.path);
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
