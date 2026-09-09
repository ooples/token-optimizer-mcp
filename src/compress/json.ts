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
 *
 * AND THE ROWS THAT DIFFER ARE NEVER IN THE TAIL, which is the harder half and
 * the one this got wrong first. Keeping the head and eliding the rest reads as
 * a 95.7% reduction and is really a truncation: measured on a 60-row search
 * payload with a UUID record at index 47 and an error record at index 23,
 * BOTH WERE DESTROYED. The number looked like the best in the module and the
 * output had thrown away the only two rows anybody would have searched for.
 *
 * HeadRoom's SmartCrusher lists "statistical anomaly preservation" among its
 * transforms, and their benchmark generator plants exactly these: UUID needles
 * and error rows, inserted for relevance testing. A homogeneous tail is
 * genuinely redundant; a row that breaks the shape is the signal. So the shape
 * is computed first, every row that departs from it is kept wherever it sits,
 * and only the rows that truly repeat are elided.
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
  if (Array.isArray(value))
    return value.reduce<number>((n, v) => n + countNulls(v), 0);
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
    return keys.length
      ? `objects keyed ${keys.slice(0, 4).join(', ')}`
      : 'objects';
  }
  return `${typeof row}s`;
}

/** Keys present in at least this fraction of rows define the common shape. */
const COMMON_KEY_SHARE = 0.8;

/**
 * Which rows depart from the shape the rest of the array shares.
 *
 * A row is anomalous when it carries a key most rows lack -- `uuid`,
 * `is_needle`, `error`, `status` -- or lacks one most rows carry. Both
 * directions matter: an extra field marks a special record, and a missing
 * field marks an incomplete one, and a reader wants each.
 */
function anomalousRows(rows: readonly unknown[]): Set<number> {
  const frequency = new Map<string, number>();
  let objects = 0;

  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    objects += 1;
    for (const key of Object.keys(row as Record<string, unknown>)) {
      frequency.set(key, (frequency.get(key) ?? 0) + 1);
    }
  }
  if (!objects) return new Set();

  const common = new Set(
    [...frequency.entries()]
      .filter(([, n]) => n / objects >= COMMON_KEY_SHARE)
      .map(([key]) => key)
  );

  const odd = new Set<number>();
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    const keys = Object.keys(row as Record<string, unknown>);
    const extra = keys.some((key) => !common.has(key));
    const missing = [...common].some((key) => !keys.includes(key));
    if (extra || missing) odd.add(index);
  });
  return odd;
}

/**
 * Compresses a JSON document.
 *
 * Whitespace and nulls first, because they are free and lossless. The array
 * tail is considered only when the document is still large afterwards -- a
 * payload that fits comfortably once minified should not pay a marker to lose
 * rows it could have carried whole.
 */
export function compressJson(
  text: string,
  ctx: EngineContext = {}
): CompressionResult {
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
    const odd = anomalousRows(stripped);
    // Head rows for shape, plus every row that departs from it, in order.
    const keep = new Set<number>(odd);
    for (let i = 0; i < Math.min(KEEP_ROWS, stripped.length); i += 1)
      keep.add(i);

    const dropped = stripped.length - keep.size;
    if (dropped < MIN_ROWS_TO_ELIDE - KEEP_ROWS) {
      // Almost everything is exceptional, so there is no redundant tail to
      // remove and eliding a handful of rows would not pay for the marker.
      return { text: minified, elisions, lossless: true };
    }

    const recoverAt = ctx.spill
      ? ctx.spill(JSON.stringify(stripped), 'rows.json')
      : null;
    const kept = [...keep].sort((a, b) => a - b).map((i) => stripped[i]);
    const sample = stripped.find((_row, i) => !keep.has(i));
    const keptText = JSON.stringify(kept);
    const body =
      keptText.slice(0, -1) +
      ',' +
      inlineMarker(
        `${count(dropped, 'more row')}, ${shapeOf(sample)}` +
          (odd.size
            ? `; all ${count(odd.size, 'row')} that differ are kept above`
            : ''),
        recoverAt
      ) +
      ']';
    return {
      text: body,
      elisions: [
        ...elisions,
        { removed: count(dropped, 'repeating row'), recoverAt },
      ],
      // The repeating tail is gone from the text; only a spill makes it
      // recoverable, and even then it is a lookup rather than a reconstruction.
      lossless: false,
    };
  }

  return { text: minified, elisions, lossless: true };
}
