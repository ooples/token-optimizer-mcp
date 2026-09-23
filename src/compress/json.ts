/**
 * JSON and tool-output compression.
 *
 * Their SmartCrusher claims 70-90% on "typical API response payloads". Most of
 * that is not clever: an API response is overwhelmingly repeated key names,
 * indentation, and rows that say the same thing as the row above.
 *
 * WHAT IS DROPPED, AND WHETHER IT CAN COME BACK:
 *
 *   whitespace          preserves parsed values; original formatting is not retained
 *   nulls               retained -- absent and null are distinct
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
import { numericExtrema } from './json-numeric.js';
import { compressJsonArray } from './json-fragments.js';
import {
  booleanFacts,
  nullFacts,
  rareBooleanRows,
  rareStringGroups,
} from './json-facts.js';
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
): { selected: Set<number>; all: number[] } {
  const frequency = new Map<string, number>();
  let objects = 0;

  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    objects += 1;
    for (const key of Object.keys(row as Record<string, unknown>)) {
      frequency.set(key, (frequency.get(key) ?? 0) + 1);
    }
  }
  if (!objects) return { selected: new Set(), all: [] };

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
  // Keep the full population for claims about completeness, independently of
  // the capped representatives selected for compression.
  return { selected: odd, all: [...byDeviation.values()].flat() };
}

/**
 * Compresses a JSON document.
 *
 * Whitespace and nulls first, because they are free and lossless. The array
 * tail is considered only when the document is still large afterwards -- a
 * payload that fits comfortably once minified should not pay a marker to lose
 * rows it could have carried whole.
 */
/**
 * The values of an NDJSON document, or null when the text is not one.
 *
 * Strict on purpose. Requires at least two non-empty lines, every one of
 * which parses as JSON on its own -- which is what separates NDJSON from a
 * truncated or corrupted JSON document, and the reason this can sit behind
 * the same refusal without weakening it. Blank lines are skipped, since a
 * trailing newline is universal and a blank line carries no value.
 *
 * A single line is deliberately not NDJSON here: it would already have
 * parsed as ordinary JSON above, so reaching this point with one line means
 * that line is malformed.
 */
function parseNdjson(text: string): unknown[] | null {
  const lines = text.split(/\r?\n/);
  const values: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  return values.length >= 2 ? values : null;
}

/**
 * Whitespace-only minification that keeps every token exactly as written.
 *
 * WHY NOT `JSON.stringify(JSON.parse(text))`, which is what this replaced.
 * A round trip through the parser canonicalises every number, so `19.90`
 * comes back `19.9`, `0.0500` comes back `0.05` and `1e3` comes back `1000`.
 * Those bytes are unrecoverable from the output, and the result was still
 * reporting `lossless: true` -- which claims the opposite. Measured on three
 * ordinary documents (a service config, a pricing table, a metrics snapshot)
 * the round trip destroyed 5, 6 and 7 distinct lexemes respectively while
 * every one reported losslessly, and `JSON.parse` deep-equality is blind to
 * it because the VALUES are identical. Only the source text differs, which
 * is exactly what significant figures and currency display are made of.
 *
 * Scanning instead of parsing keeps the saving and makes the claim true: a
 * string span is copied byte for byte, and everything outside one loses only
 * its whitespace. Numbers are never interpreted, so they cannot be rewritten.
 *
 * Returns null when the scan cannot finish -- an unterminated string -- so
 * the caller falls back rather than emitting a truncated document.
 */
function minifyPreservingTokens(text: string): string | null {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      i += 1;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return null;
      out += text.slice(start, i);
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
/**
 * The number lexemes of a document, in order, ignoring anything inside a string.
 *
 * OUTSIDE STRINGS, AND POSITIONAL. The first version asked whether each
 * rewritten lexeme still appeared ANYWHERE in the output, which a string
 * containing the same text satisfies for free: in
 * `{"n":1e3,"note":"value 1e3"}` the serialising fallback rewrites n to 1000,
 * yet `1e3` survives inside the note, so a substring test reports the
 * document unchanged and the result claims losslessness it does not have.
 *
 * The string-skipping here is deliberately the same shape as
 * minifyPreservingTokens above: a span opened by a quote is consumed whole,
 * with a backslash swallowing the character after it.
 */
function numberLexemes(text: string): string[] | null {
  const found: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i += 1;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      // An unterminated string means the scan cannot be trusted; say so
      // rather than returning a prefix that would compare as equal.
      if (!closed) return null;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const start = i;
      if (ch === '-') i += 1;
      while (i < text.length && text[i] >= '0' && text[i] <= '9') i += 1;
      if (text[i] === '.') {
        i += 1;
        while (i < text.length && text[i] >= '0' && text[i] <= '9') i += 1;
      }
      if (text[i] === 'e' || text[i] === 'E') {
        i += 1;
        if (text[i] === '+' || text[i] === '-') i += 1;
        while (i < text.length && text[i] >= '0' && text[i] <= '9') i += 1;
      }
      found.push(text.slice(start, i));
      continue;
    }
    i += 1;
  }
  return found;
}

/**
 * Did every number survive as WRITTEN, not merely as valued?
 *
 * The runtime half of the guarantee. `minifyPreservingTokens` makes the
 * common path safe by construction, but the serialising fallback still
 * canonicalises, and a future edit could route more content through it. A
 * claim of losslessness that nothing checks is how this defect shipped in the
 * first place, so the claim is now conditioned on a check rather than on the
 * author having remembered.
 *
 * Compared as SEQUENCES, position by position, so a rewrite cannot be masked
 * by the same text appearing elsewhere in the document.
 */
function numbersKeptVerbatim(original: string, output: string): boolean {
  const before = numberLexemes(original);
  const after = numberLexemes(output);
  if (before === null || after === null) return false;
  if (before.length !== after.length) return false;
  return before.every((lexeme, at) => lexeme === after[at]);
}
export function compressJson(
  text: string,
  ctx: EngineContext = {}
): CompressionResult {
  if (!looksLikeJson(text)) return unchanged(text);

  // Parsing unsafe integers would round their original lexemes, including in
  // recovery data. Use the lexical codec or preserve the original document.
  // Ordinary integer literals need no token scan; exponents may still overflow.
  if (/\d{16}|[eE][+-]?\d/.test(text)) {
    const tokens = text.matchAll(
      /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g
    );
    for (const [token] of tokens) {
      if (token.startsWith('"')) continue;
      const value = Number(token);
      if (
        !Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value))
      ) {
        const exact = compressJsonArray(text);
        return exact.text.length < text.length ? exact : unchanged(text);
      }
    }
  }
  let parsed: unknown;
  let nestedElisions: readonly Elision[] = [];
  // Set when a nested string was compressed lossily. Every `lossless: !nestedLossy && lexemeSafe`
  // return below is conditioned on it, because a document is only lossless if
  // its nested values were too.
  let nestedLossy = false;
  try {
    parsed = JSON.parse(text);
  } catch {
    // NDJSON FIRST, THEN GIVE UP. One JSON value per line is what docker,
    // kubectl, `jq -c` and most structured loggers emit, and it fails the
    // parse above on its second line -- so this engine used to return the
    // single commonest shape of real tool output completely untouched.
    // Measured: 0.0% on 300 log rows as lines, against 94.6% on the exact
    // same rows as an array.
    //
    // The guard below it stays exactly as strict. A document that only
    // PARTLY parses is still refused, because a half-parsed rewrite of
    // malformed JSON would be a corruption dressed as an optimisation.
    // What distinguishes NDJSON from damaged JSON is that EVERY non-empty
    // line parses on its own, so that is the whole test -- one bad line and
    // we take the original refusal.
    const ndjson = parseNdjson(text);
    if (!ndjson) return unchanged(text);
    // Re-enter with the array spelling and let every existing rule --
    // anomaly grouping, per-shape representatives, needle retention,
    // the unsafe-integer scan above -- apply unchanged. Nothing about
    // NDJSON deserves its own elision policy.
    const asArray = compressJson(JSON.stringify(ndjson, null, 2), ctx);
    // Never pay bytes for the reshaping. A short or already-dense document
    // can come out of the array spelling LARGER than the lines it replaced,
    // and then the honest answer is the input.
    return asArray.text.length < text.length ? asArray : unchanged(text);
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

  // Null and absent are different values. Preserve nulls in visible and recovery data.
  const stripped = parsed;

  // The lexical scan is only equivalent when nothing restructured the
  // document. A nested string that was compressed lives in `stripped` and
  // not in `text`, so scanning the original would silently discard that
  // work -- fall back to serialising in that case.
  const scanned = nestedElisions.length ? null : minifyPreservingTokens(text);
  const minified = scanned ?? JSON.stringify(stripped);
  // Cheap on the scanned path, which cannot rewrite a number at all; the
  // scan only runs when we fell back to serialising.
  const lexemeSafe = scanned !== null || numbersKeptVerbatim(text, minified);
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
    const { selected: odd, all: differing } = anomalousRows(
      stripped,
      tuning.keepRows
    );
    const keep = rareBooleanRows(stripped);
    const hasRareBooleans = keep.size > 0;
    const extrema = numericExtrema(stripped);
    for (const i of extrema.keep) keep.add(i);
    const categories = rareStringGroups(parsed as unknown[]);
    // Numeric tables have no rare categorical population to summarize. Keeping
    // every record in an exact compact form avoids forcing verification reads
    // for aggregate queries. Prefer it only when it materially beats minification.
    if (
      extrema.keep.size &&
      !hasRareBooleans &&
      !categories.keep.size &&
      !nestedElisions.length
    ) {
      const exact = compressJsonArray(text);
      if (exact.text.length < minified.length * 0.7) return exact;
    }
    for (const i of categories.keep) keep.add(i);
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
      return { text: minified, elisions, lossless: !nestedLossy && lexemeSafe };
    }

    // NO HOME MEANS NO ELISION. Without a spill the rows would be gone with
    // nowhere to look -- the marker would name a count and a shape and offer
    // no way back, which is the dangling-reference failure this design exists
    // to avoid. The minified document is still a real saving, so keep it and
    // keep the rows.
    const recoverAt = spillFor(ctx, JSON.stringify(stripped), 'rows.json');
    if (!recoverAt)
      return { text: minified, elisions, lossless: !nestedLossy && lexemeSafe };
    const kept = [...keep].sort((a, b) => a - b).map((i) => stripped[i]);
    const sample = stripped.find((_row, i) => !keep.has(i));
    const keptText = JSON.stringify(kept);
    const body =
      keptText.slice(0, -1) +
      ',' +
      inlineMarker(
        `${count(dropped, 'more row')}, ${shapeOf(sample)}` +
          (differing.length && differing.every((i) => keep.has(i))
            ? `; all ${count(differing.length, 'row')} that differ are kept above`
            : '') +
          booleanFacts(parsed as unknown[]) +
          nullFacts(parsed as unknown[]) +
          categories.facts +
          extrema.facts,
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

  return { text: minified, elisions, lossless: !nestedLossy && lexemeSafe };
}
