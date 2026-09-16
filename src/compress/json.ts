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
import { needleRows, shapeRepresentatives } from './needles.js';
import { compressNestedStrings } from './nested.js';
import { activeRanker } from './ranking.js';
import { DEFAULT_TUNING } from './options.js';
import type { CompressionResult, Elision, EngineContext } from './types.js';
import { spillFor, unchanged } from './types.js';

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

/**
 * Above this share of anomalous rows, the anomaly rule is not discriminating.
 *
 * An array of three interleaved table shapes has no common key set, so every
 * row reads as exceptional and the keep set swallows the array. Past this
 * point shape diversity is preserved by keeping one representative of each
 * shape instead, which is what the rule was for.
 */
const MAX_ANOMALOUS_SHARE = 0.5;

/** Keys present in at least this fraction of rows define the common shape. */
const COMMON_KEY_SHARE = 0.8;

/** The way a row departs from the common shape, as a comparable key. */
function deviationOf(
  keys: readonly string[],
  common: ReadonlySet<string>
): string {
  const extra = keys.filter((key) => !common.has(key)).sort();
  const missing = [...common].filter((key) => !keys.includes(key)).sort();
  return `+${extra.join(',')}|-${missing.join(',')}`;
}

/**
 * Which rows depart from the shape the rest of the array shares.
 *
 * A row is anomalous when it carries a key most rows lack -- `uuid`,
 * `is_needle`, `error`, `status` -- or lacks one most rows carry. Both
 * directions matter: an extra field marks a special record, and a missing
 * field marks an incomplete one, and a reader wants each.
 *
 * ROWS ARE GROUPED BY HOW THEY DEVIATE, and each group is capped at
 * `maxPerDeviation`. Measured on their api-responses fixture: 60 of 200 rows
 * carry an optional `relationships` key, so every one of them departed from
 * the common shape and all 60 were kept whole -- 31% of the array retained,
 * 75.8% reduction against their 91.4%. Sixty rows deviating IDENTICALLY are
 * one subpopulation, not sixty anomalies, and the shape rule already keeps a
 * representative of it. The global share cap could not catch this: 60 is well
 * under half the array, so the backstop never fired.
 *
 * A deviation nobody else shares is still kept in full -- that is the error
 * row, the record with the unexpected field, the thing this rule exists for.
 *
 * The cap is `tuning.keepRows` rather than a constant, because the profiles
 * disagree about how much evidence is worth keeping (1 row on the aggressive
 * profile, 8 on the conservative one) and a fixed number would have quietly
 * overridden both.
 */
function anomalousRows(
  rows: readonly unknown[],
  maxPerDeviation: number
): Set<number> {
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

  // GROUPED BY HOW THEY DEVIATE, not just counted. A deviation shared by many
  // rows is a shape; a deviation shared by none is an anomaly. Only the second
  // kind earns the whole row.
  const byDeviation = new Map<string, number[]>();
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    const keys = Object.keys(row as Record<string, unknown>);
    const extra = keys.some((key) => !common.has(key));
    const missing = [...common].some((key) => !keys.includes(key));
    if (!extra && !missing) return;
    const deviation = deviationOf(keys, common);
    const bucket = byDeviation.get(deviation);
    if (bucket) bucket.push(index);
    else byDeviation.set(deviation, [index]);
  });

  const odd = new Set<number>();
  for (const indices of byDeviation.values()) {
    // Ordered by position, so the rows kept are the first occurrences rather
    // than an arbitrary slice -- the same bias the head-of-array rule uses.
    for (const index of indices.slice(0, maxPerDeviation)) odd.add(index);
  }
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
  let nestedElisions: readonly Elision[] = [];
  // Set when a nested string was compressed lossily. Every `lossless: !nestedLossy`
  // return below is conditioned on it, because a document is only lossless if
  // its nested values were too.
  let nestedLossy = false;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not our content. A half-parsed rewrite of malformed JSON would be a
    // corruption dressed as an optimisation.
    return unchanged(text);
  }

  // CONTENT THAT ARRIVED AS A STRING. A tool result serialised into a
  // `content` field is invisible to everything below, which stops at the
  // container -- and on HeadRoom's own conversation fixtures that is where
  // almost all of the bulk lives. Descending first means the structural work
  // below operates on already-compressed values, and the caller's `nested`
  // handler decides which engine each string deserves.
  if (ctx.compressNested) {
    const inner = compressNestedStrings(
      parsed,
      ctx.compressNested,
      ctx,
      ctx.stringDepth ?? 0
    );
    if (inner.removed > 0) {
      parsed = inner.value;
      nestedElisions = inner.elisions;
      // A lossy nested string makes the whole document lossy. Without this the
      // structural passes below decided `lossless` alone and could report true
      // for a document whose inner content needs external recovery.
      if (!inner.lossless) nestedLossy = true;
    }
  }

  const elisions: Elision[] = [...nestedElisions];

  const nulls = countNulls(parsed);
  const stripped = nulls ? dropNulls(parsed) : parsed;
  if (nulls) {
    // Lossless: absent and null read the same, and the surviving rows carry
    // the key list.
    elisions.push({
      removed: count(nulls, 'null field'),
      recoverAt: null,
      // This ELISION is lossless on its own terms whatever happened elsewhere:
      // an absent key and a null key read the same. Per-elision flags describe
      // their own transform; the document-level claim is the engine's return.
      lossless: true,
    });
  }

  const minified = JSON.stringify(stripped);
  // Whitespace is recorded only when there actually was some to remove.
  if (minified.length < text.length) {
    elisions.push({
      removed: count(text.length - minified.length, 'byte') + ' of whitespace',
      recoverAt: null,
      // Re-serialising restores it exactly, independently of nested content.
      lossless: true,
    });
  }

  const tuning = ctx.tuning ?? DEFAULT_TUNING;

  // A long top-level array is where the remaining bulk lives. Eliding its
  // tail is the one lossy thing this engine does, so a lossless posture
  // stops here with the minified document -- which is still a real saving.
  if (
    tuning.allowLossy &&
    Array.isArray(stripped) &&
    stripped.length >= tuning.minRowsToElide
  ) {
    // WHAT MUST SURVIVE, from three rules that cover each other's blind
    // spots. Measured on HeadRoom's own fixtures, each rule alone fails at
    // one extreme: the anomaly rule keeps everything when an array has no
    // single common shape (their database-rows, 300 of 300 flagged, nothing
    // elided, 25.7% against their 60.0%) and keeps nothing when every row is
    // shaped alike (their agentic-conversation, 0 flagged, 45 of 48 rows
    // elided, every needle destroyed at 99.6%).
    const odd = anomalousRows(stripped, tuning.keepRows);
    const keep = new Set<number>();
    // 1. Content that a reader would come back for -- identifiers, failure
    //    vocabulary -- which structure cannot see. Bounded, so an array made
    //    of needles does not simply disable compression.
    for (const i of needleRows(stripped)) keep.add(i);
    // 2. One example of every distinct shape, which is what the anomaly rule
    //    was protecting; taken this way it costs a handful of rows rather
    //    than the whole array.
    for (const i of shapeRepresentatives(stripped)) keep.add(i);
    // 3. The anomalous rows themselves, but only while they are genuinely
    //    exceptional. Past that share the term has stopped discriminating
    //    and rule 2 already carries the shape information.
    if (odd.size <= stripped.length * MAX_ANOMALOUS_SHARE)
      for (const i of odd) keep.add(i);
    for (let i = 0; i < Math.min(tuning.keepRows, stripped.length); i += 1)
      keep.add(i);

    // RELEVANCE ON TOP OF SHAPE, and the extra allowance is bounded on
    // purpose. A row that answers the question is worth more than a row
    // that merely sits at the head, but letting relevance keep whatever it
    // likes would buy task outcomes with a reduction number -- the trade
    // every competitor makes quietly. At most KEEP_ROWS rows are added.
    const rank = activeRanker(ctx.query, ctx.embeddings);
    if (rank.active) {
      const rows = stripped.map((row) => JSON.stringify(row) ?? '');
      for (const i of rank.top(rows, tuning.keepRows)) keep.add(i);
    }

    const dropped = stripped.length - keep.size;
    if (dropped < tuning.minRowsToElide - tuning.keepRows) {
      // Almost everything is exceptional, so there is no redundant tail to
      // remove and eliding a handful of rows would not pay for the marker.
      return { text: minified, elisions, lossless: !nestedLossy };
    }

    // NO HOME MEANS NO ELISION. Without a spill the rows would be gone with
    // nowhere to look -- the marker would name a count and a shape and offer
    // no way back, which is the dangling-reference failure this design exists
    // to avoid. The minified document is still a real saving, so keep it and
    // keep the rows.
    const recoverAt = spillFor(ctx, JSON.stringify(stripped), 'rows.json');
    if (!recoverAt) return { text: minified, elisions, lossless: !nestedLossy };
    const kept = [...keep].sort((a, b) => a - b).map((i) => stripped[i]);
    const sample = stripped.find((_row, i) => !keep.has(i));
    const keptText = JSON.stringify(kept);
    const body =
      keptText.slice(0, -1) +
      ',' +
      inlineMarker(
        `${count(dropped, 'more row')}, ${shapeOf(sample)}` +
          (odd.size && [...odd].every((i) => keep.has(i))
            ? `; all ${count(odd.size, 'row')} that differ are kept above`
            : ''),
        recoverAt
      ) +
      ']';
    return {
      text: body,
      elisions: [
        ...elisions,
        {
          removed: count(dropped, 'repeating row'),
          recoverAt,
          lossless: false,
        },
      ],
      // The repeating tail is gone from the text; only a spill makes it
      // recoverable, and even then it is a lookup rather than a reconstruction.
      lossless: false,
    };
  }

  return { text: minified, elisions, lossless: !nestedLossy };
}
