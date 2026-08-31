// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/substitute.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Pointing a Read at a cheaper representation of the same file.
 *
 * THE MECHANISM THE LEADER CANNOT USE. tokenade reaches 0.666 context-per-turn
 * by offering the agent compact views -- skeleton, query, map -- through a CLI,
 * which the agent has to CHOOSE to call, taught by a project rules file that is
 * loaded on every task whether it helps or not. That fixed cost is why their
 * advantage scales with task length (corr -0.689) and why they LOSE the three
 * shortest tasks outright.
 *
 * We sit in the tool path instead of beside it. PreToolUse can rewrite a Read's
 * file_path, so the substitution happens inside a call the model already made:
 * no rules file, no CLI, no schema, and nothing to adopt. Zero fixed cost, so
 * the short tasks stay free.
 *
 * WHY A RE-READ IS NOT A LOSS. The obvious objection is that a model wanting
 * the real text will read again and spend a turn. Priced out, that still wins:
 * a 50KB file read in full sits in context and is re-read on every later turn,
 * while an outline plus one TARGETED read of the region it names is about 4KB.
 * A turn costs ~$0.01 and cache_read is $0.30/M, so a turn is worth ~33k tokens
 * of re-reading -- roughly 2.2k tokens saved across 15 remaining turns. That is
 * where the floor comes from, and it is why the floor RISES as a session runs
 * out of turns to amortise over.
 *
 * This is the same budget-aware idea that was wrong for bounding and is right
 * here: a truncation withholds what the model needs, while an outline hands it
 * a cheaper route to the same place.
 */

import { statSync, readFileSync } from 'node:fs';
import { extractSymbols, extractImports } from './symbols.mjs';
import { isFsSafePath } from './paths.mjs';

/** What a turn is worth in re-read tokens: $0.010 / ($0.30 per 1M). */
const TOKENS_PER_TURN = 33_000;

/** Bytes per token, near enough for source text. */
const BYTES_PER_TOKEN = 3.6;

/** A session's typical length, for estimating how many re-reads remain. */
const TYPICAL_TURNS = 16;

/** Below this there is no outline worth having, whatever the arithmetic says. */
const ABSOLUTE_FLOOR_BYTES = 4_000;

/**
 * The size at which substituting pays, given how much session is left.
 *
 * Saving `b` bytes is worth `b / BYTES_PER_TOKEN * remaining` re-read tokens.
 * Substituting risks at most one extra turn, worth TOKENS_PER_TURN. Solving for
 * the break-even and keeping the absolute floor gives the size we require.
 */
export function floorBytes(turnsSoFar, typicalTurns = TYPICAL_TURNS) {
  const remaining = Math.max(1, typicalTurns - turnsSoFar);
  const breakEven = (TOKENS_PER_TURN / remaining) * BYTES_PER_TOKEN;
  return Math.max(ABSOLUTE_FLOOR_BYTES, Math.round(breakEven));
}

/** Extensions whose structure we can actually describe. */
const OUTLINEABLE = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.rb', '.php', '.cs',
]);

const extensionOf = (path) => {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot).toLowerCase();
};

/**
 * The outline itself.
 *
 * LINE NUMBERS ARE THE POINT. Without them a follow-up read is a guess, and one
 * guess becomes several -- which is how a mechanism that saves context starts
 * costing turns. With them the model reads exactly the region it wants.
 */
export function outlineFor(path, source, { lines, bytes }) {
  const symbols = extractSymbols(path, source) || [];
  if (!symbols.length) return null;

  const text = source.split(/\r?\n/);

  // THE DECLARATION LINE IS THE SIGNATURE. extractSymbols returns a name, a
  // line and an indent but no signature text, and a bare list of names is not
  // enough to act on -- the model would read the file anyway to find out what
  // something takes, which is the re-read this exists to avoid. The line the
  // symbol sits on already says it, so take that and keep the indent so methods
  // still read as belonging to their class.
  const body = symbols
    .slice(0, 200)
    .map((symbol) => {
      const raw = (text[(symbol.line ?? 1) - 1] || symbol.name).trim();
      const signature = raw.length > 110 ? `${raw.slice(0, 107)}...` : raw;
      const nesting = '  '.repeat(Math.min(3, Math.floor((symbol.indent || 0) / 2)));
      return `${String(symbol.line ?? '').padStart(6)}  ${nesting}${signature}`;
    })
    .join('\n');

  // extractImports covers the languages it knows and returns nothing for
  // others, so fall back to reading the head of the file rather than shipping
  // an outline with no dependency information at all.
  let imports = [];
  try {
    imports = (extractImports(path, source) || []).slice(0, 12);
  } catch {
    imports = [];
  }
  if (!imports.length) {
    imports = text
      .slice(0, 80)
      .filter((line) => /^\s*(import|from|use|using|require|#include|package)\b/.test(line))
      .map((line) => line.trim())
      .slice(0, 12);
  }

  return (
    `outline of ${path} (${lines} lines, ${Math.round(bytes / 1024)}KB)\n` +
    (imports.length ? `${imports.join('\n')}\n` : '') +
    '\n' +
    body +
    '\n\n' +
    `This is a structural outline, not the file. Read ${path} with offset and ` +
    `limit to get any region above in full.\n`
  );
}

/**
 * Should this Read be pointed at an outline, and what should the outline say?
 *
 * Returns null whenever anything is uncertain -- an unsupported extension, a
 * file we cannot stat, a source we cannot outline, or an outline that did not
 * come out smaller. Substituting on a guess is how this mechanism would turn
 * into the last one.
 */
export function substitutionFor(filePath, { turnsSoFar = 0, alreadyRead = false } = {}) {
  if (typeof filePath !== 'string' || !filePath) return null;

  // BEFORE ANY FILESYSTEM CALL. A path carrying an invalid code point aborts
  // libuv inside statSync -- a hard process abort, not a catchable error, so no
  // try/catch below would save it. The repo already has this guard precisely
  // because a Read payload can carry such a path; going near the filesystem
  // without it is how the hook stops being fail-open.
  if (!isFsSafePath(filePath)) return null;

  if (!OUTLINEABLE.has(extensionOf(filePath))) return null;

  let bytes;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
    bytes = stat.size;
  } catch {
    return null;
  }

  if (bytes < floorBytes(turnsSoFar)) return null;

  let source;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const lines = source.split(/\r?\n/).length;
  const outline = outlineFor(filePath, source, { lines, bytes });
  if (!outline) return null;

  // An outline that is not decisively smaller buys nothing and risks a re-read.
  if (Buffer.byteLength(outline, 'utf8') > bytes / 4) return null;

  return { outline, bytes, lines, alreadyRead };
}
