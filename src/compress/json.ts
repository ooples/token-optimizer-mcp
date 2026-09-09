/**
 * JSON and tool-output compression.
 *
 * Their SmartCrusher claims 70-90% on "typical API response payloads". Most of
 * that is not clever: an API response is overwhelmingly repeated key names,
 * indentation, and rows that say the same thing as the row above.
 *
 * WHAT IS DROPPED, AND WHETHER IT CAN COME BACK:
 *
 *   whitespace          lossless -- re-serialising restores it exactly
 *   nulls               lossless -- absent and null are the same to a reader,
 *                       and the key list is recoverable from the surviving rows
 *   long array tails    LOSSY -- spilled to a path, or the count is stated so
 *                       the model knows what it is not seeing
 *
 * ROWS ARE NEVER SILENTLY TRUNCATED. A tail is either spilled to a real path or
 * announced with its length and the shape of what was cut. A model told "38
 * more rows, same shape" can decide it does not care; a model handed a
 * truncated array with no marker cannot tell it was truncated at all, and will
 * reason confidently from a partial list. That failure is silent, which makes
 * it worse than the tokens it saves.
 */

import { count, inlineMarker } from './annotate.js';
import type { CompressionResult, Elision, EngineContext } from './types.js';
import { unchanged } from './types.js';

/** Rows kept at the head of a long array before the tail is elided. */
const KEEP_ROWS = 3;

/** Below this an array is left whole: the marker would cost more than the rows. */
const MIN_ROWS_TO_ELIDE = 6;

/** Recognises JSON without paying to parse something that plainly is not. */
export function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (first === '{' && last === '}') || (first === '[' && last === ']');
}

/** Strips null-valued keys, recursively. Absent and null read the same. */
function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null) continue;
      out[k] = dropNulls(v);
    }
    return out;
  }
  return value;
}

/** Counts nulls before they are dropped, so the marker can be honest. */
function countNulls(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + countNulls(v), 0);
  if (value && typeof value === 'object') {
    let n = 0;
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (v === null) n += 1;
      else n += countNulls(v);
    }
    return n;
  }
  return 0;
}

/** A one-line description of a row's shape, for the elision marker. */
function shapeOf(row: unknown): string {
  if (Array.isArray(row)) return 'arrays';
  if (row && typeof row === 'object') {
    const keys = Object.keys(row as Record<string, unknown>);
    return keys.length ? `objects keyed ${keys.slice(0, 4).join(', ')}` : 'objects';
  }
  return `${typeof row}s`;
}

/**
 * Compresses a JSON document.
 *
 * Whitespace and nulls first, because they are free and lossless. The array
 * tail is considered only when the document is still large afterwards -- a
 * payload that fits comfortably once minified should not pay a marker to lose
 * rows it could have carried whole.
 */
export function compressJson(text: string, ctx: EngineContext = {}): CompressionResult {
  if (!looksLikeJson(text)) return unchanged(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not our content. A half-parsed rewrite of malformed JSON would be a
    // corruption dressed as an optimisation.
    return unchanged(text);
  }

  const elisions: Elision[] = [];

  const nulls = countNulls(parsed);
  const stripped = nulls ? dropNulls(parsed) : parsed;
  if (nulls) {
    elisions.push({ removed: count(nulls, 'null field'), recoverAt: null });
  }

  const minified = JSON.stringify(stripped);
  // Whitespace is recorded only when there actually was some to remove.
  if (minified.length < text.length) {
    elisions.push({
      removed: count(text.length - minified.length, 'byte') + ' of whitespace',
      recoverAt: null,
    });
  }

  // A long top-level array is where the remaining bulk lives.
  if (Array.isArray(stripped) && stripped.length >= MIN_ROWS_TO_ELIDE) {
    const head = stripped.slice(0, KEEP_ROWS);
    const tail = stripped.slice(KEEP_ROWS);
    const recoverAt = ctx.spill ? ctx.spill(JSON.stringify(stripped), 'rows.json') : null;
    const headText = JSON.stringify(head);
    const body =
      headText.slice(0, -1) +
      ',' +
      inlineMarker(`${count(tail.length, 'more row')}, ${shapeOf(tail[0])}`, recoverAt) +
      ']';
    return {
      text: body,
      elisions: [
        ...elisions,
        { removed: count(tail.length, 'row'), recoverAt },
      ],
      // The tail is gone from the text; only a spill makes it recoverable, and
      // even then it is a lookup rather than a reconstruction.
      lossless: false,
    };
  }

  return { text: minified, elisions, lossless: true };
}
