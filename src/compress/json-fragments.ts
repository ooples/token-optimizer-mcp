/** Preserve truncated JSON as truncated, while templating complete flat records.
 * Never repairs a missing range, infers a missing value, or discards a visible one.
 */
import type { CompressionResult, Elision } from './types.js';
import { unchanged } from './types.js';

export function looksLikeJsonFragments(text: string): boolean {
  return (
    /^Warning: truncated output\b/.test(text) &&
    /\d+ tokens truncated/.test(text) &&
    /(?:^|\\n)[ \t]+\{(?:\r?\n|\\(?:r\\)?n)/m.test(text)
  );
}

/**
 * How many scalars a record exposes as `"key": value` pairs, at any depth.
 *
 * THE COUNT IS THE INTEGRITY CHECK, and it used to be `Object.keys().length`
 * with nested records refused outright a few lines above. That refusal cost
 * two workloads their whole margin: a search result is `{id, score, title,
 * snippet, source, metadata:{author, created_at, category}}`, and one nested
 * object was enough to send forty identical-shaped records to plain
 * minification. Measured on `code-search` the array encoder returned the
 * input untouched at 15,697 characters on every one of its blocks.
 *
 * Descending fixes the count rather than the encoder: the field scanner
 * already reads inner pairs, because it walks the record's bytes and does not
 * care how deep a pair sits. A key whose value is an object or an array is not
 * a column -- the scanner cannot match `{` as a scalar -- so those bytes stay
 * in the literal chunk, which is where a constant belongs anyway.
 *
 * ARRAY ELEMENTS ARE NOT COUNTED UNLESS THEY ARE OBJECTS. A bare scalar in an
 * array has no key in front of it, so the scanner never matches it and it
 * stays literal; counting it here would fail every record that has one.
 */
function scalarLeaves(value: unknown): number {
  if (Array.isArray(value)) {
    // A LIST OF SCALARS IS ONE SLOT, WHICH IS WHAT MAKES ITS LENGTH STOP
    // MATTERING. `labels: ["bug"]` and `labels: ["bug", "needs-triage"]` are
    // the same record to a reader and were two different SHAPES here, because
    // the elements sat in the literal chunks rather than in a value. Two
    // hundred and twenty issues drawn from two shapes fragmented into a
    // hundred and eighteen contiguous runs, nearly all of them too short to
    // template at all. Captured whole, the list is one varying value like any
    // other and the length stops splitting the document.
    if (value.every((item) => item === null || typeof item !== 'object'))
      return 1;
    let total = 0;
    for (const item of value)
      if (item !== null && typeof item === 'object')
        total += scalarLeaves(item);
    return total;
  }
  if (value === null || typeof value !== 'object') return 0;
  let total = 0;
  for (const inner of Object.values(value as Record<string, unknown>))
    total +=
      inner !== null && typeof inner === 'object' ? scalarLeaves(inner) : 1;
  return total;
}

/**
 * One JSON scalar, as it is SPELLED rather than as it parses.
 *
 * Shared by both alternatives of the field scanner so that a list of scalars
 * and a bare scalar can never disagree about what a scalar is. A disagreement
 * there is silent: the record fails the leaf count, every record after it does
 * too, and the document goes out minified with nothing to say why.
 *
 * IT CARRIES ITS OWN `(?:...)`. Interpolating a bare alternation splits
 * whatever encloses it -- `(?:\\s*${SCALAR}\\s*,)*` became "whitespace then a
 * string" OR "true" OR ... OR "a number then a comma" -- which still compiles,
 * still matches, and quietly matches the wrong thing.
 */
const SCALAR =
  '(?:"(?:\\\\.|[^"\\\\])*"|true|false|null|-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)';

interface RecordParts {
  start: number;
  end: number;
  chunks: string[];
  values: string[];
  shape: string;
}
/**
 * Every TOP-LEVEL object in the text, found by counting braces rather than
 * by matching a pattern.
 *
 * THE PATTERN-BASED SCANNER COULD NOT SEE DEPTH, AND SILENTLY FOUND THE WRONG
 * RECORDS. Its character class excluded braces, so on a row like
 * `{"id":1,"meta":{"k":2}}` it matched the INNER `{"k":2}` -- which parses, and
 * so was accepted as a record. On an eleven-row log array it reported sixteen
 * records and on a thirteen-row one, nineteen. The count check then rejected the
 * array, which is why the flat-rows gate had to exist at all: it kept nested
 * input away from a scanner that would mis-read it. Counting depth removes the
 * reason for that gate, and with it the refusal of every minified array whose
 * rows hold an object -- measured at 62-77% on arrays that had been left whole.
 *
 * A backslash hides whatever follows it, which is what lets this read a record
 * whose quotes are escaped (a serialized document) without a second pass. Braces
 * inside a string value are skipped, so `"a {b} c"` does not open a record; a
 * value holding one unbalanced brace still misreads a boundary, and that is what
 * the parse and the exact-count check downstream are for.
 */
function balancedObjects(text: string): { raw: string; at: number }[] {
  const out: { raw: string; at: number }[] = [];
  const isSpace = (c: string): boolean =>
    c === ' ' || c === '\t' || c === '\n' || c === '\r';
  let depth = 0,
    start = -1,
    inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === BACKSLASH) {
      i += 1;
      continue;
    }
    if (ch === QUOTE) {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth !== 0 || start < 0) continue;
    // The trailing comma and whitespace belong to the record, exactly as the
    // pattern scanner consumed them, so the spans of adjacent rows abut.
    let end = i + 1;
    while (end < text.length && isSpace(text[end])) end += 1;
    if (text[end] === ',') {
      end += 1;
      while (end < text.length && isSpace(text[end])) end += 1;
    }
    out.push({ raw: text.slice(start, end), at: start });
    start = -1;
  }
  return out;
}

function records(text: string, compact = false): RecordParts[] {
  const result: RecordParts[] = [];
  // An interrupted object may match through the truncation marker. JSON.parse
  // rejects it; the original bytes stay in the gap between valid records.
  // Shell envelopes can render structural newlines as literal backslash-n
  // while leaving quotes unescaped. Keep those bytes in the template rather
  // than unescaping the document (which would corrupt escapes inside values).
  const object = compact
    ? /\{(?:"(?:\\.|[^"\\])*"|[^{}"])*\}\s*,?\s*/g
    : /(?:^|(?<=\\n))([ \t]+)\{(?:\r?\n|\\(?:r\\)?n)[\s\S]*?(?:^|(?<=\\n))\1\},?(?:\r?\n|\\(?:r\\)?n|$)/gm;
  const scanned = compact
    ? balancedObjects(text)
    : [...text.matchAll(object)].map((m) => ({ raw: m[0], at: m.index ?? 0 }));
  for (const { raw, at } of scanned) {
    let source = raw;
    let encode = (value: string): string => value;
    let parsed: Record<string, unknown>;
    try {
      // A record's first quote opens its first property name. If escaped,
      // this is a serialized record: avoid a predictably failing JSON parse
      // and exception allocation for every row on the successful path.
      if (raw[raw.indexOf('"') - 1] === '\\') {
        // Decode only this complete record, require canonical round-trip
        // encoding, and keep that encoding in every template fragment.
        // Never repair or parse across a truncated gap.
        source = JSON.parse(`"${raw}"`) as string;
        encode = (value: string): string => JSON.stringify(value).slice(1, -1);
        if (encode(source) !== raw) continue;
        parsed = JSON.parse(source.trim().replace(/,$/, ''));
      } else {
        const structural = raw.replace(
          /("(?:\\.|[^"\\])*")|\\r\\n|\\n/g,
          (token, quoted: string | undefined) =>
            quoted ?? (token === '\\n' ? '\n' : '\r\n')
        );
        parsed = JSON.parse(structural.trim().replace(/,$/, ''));
      }
    } catch {
      continue;
    }
    if (!parsed || Array.isArray(parsed)) continue;
    const field = new RegExp(
      // `"key":` followed by one scalar, or by a whole list of them.
      //
      // THE LIST ALTERNATIVE IS ONLY FOR LISTS OF SCALARS. A list holding
      // objects is left alone: the key/value alternative reaches its inner
      // fields by itself and templates each of them, which is the better
      // encoding whenever the inner records line up. It is the list of bare
      // scalars -- labels, tags, a set of ids -- that has no keys to match and
      // so ends up as literal text whose LENGTH becomes part of the shape.
      `"(?:\\\\.|[^"\\\\])*"\\s*:\\s*(` +
        `\\[(?:\\s*${SCALAR}\\s*,)*\\s*(?:${SCALAR}\\s*)?\\]` +
        `|${SCALAR})`,
      'g'
    );
    const chunks: string[] = [],
      values: string[] = [];
    let cursor = 0;
    for (const value of source.matchAll(field)) {
      const start = value.index! + value[0].length - value[1].length;
      chunks.push(encode(source.slice(cursor, start)));
      values.push(encode(value[1]));
      cursor = start + value[1].length;
    }
    if (!values.length || values.length !== scalarLeaves(parsed)) continue;
    chunks.push(encode(source.slice(cursor)));
    result.push({
      start: at,
      end: at + raw.length,
      chunks,
      values,
      shape: JSON.stringify(chunks),
    });
  }
  return result;
}

export function compressJsonFragments(text: string): CompressionResult {
  if (!looksLikeJsonFragments(text)) return unchanged(text);
  return compressRecords(text, records(text), false);
}

/** Exact full-array encoding, admitted only when every record was recognized. */
export function compressJsonArray(
  text: string,
  minimumRows = 32
): CompressionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unchanged(text);
  }
  if (!Array.isArray(parsed) || parsed.length < minimumRows)
    return unchanged(text);
  let found = records(text);
  // Compact arrays have no indented record boundaries, so fall back to counting
  // braces. This USED TO REQUIRE EVERY ROW TO BE FLAT, because the scanner it
  // falls back to could not see depth and would return inner objects as records;
  // now that it counts braces the flat-rows condition only refuses input the
  // scanner reads correctly, so the count mismatch alone decides. What makes it
  // safe is unchanged: every row is parsed and re-encoded below, and the exact
  // count check after this rejects the array if a single record was missed.
  if (found.length !== parsed.length) found = records(text, true);

  if (found.length !== parsed.length) return unchanged(text);
  return compressRecords(text, found, true, minimumRows < 32);
}

/**
 * An OBJECT MAP of flat records -- `{"/route-0": {..}, "/route-1": {..}}`.
 *
 * The array encoder cannot see this shape: it requires `Array.isArray`, so a
 * map of forty identical-shaped entries fell through to plain minification at
 * 20.8% while the same forty records in an ARRAY reach the seventies. Keyed
 * maps are how route tables, per-host metrics and config-by-name are written,
 * so the gap is a common shape rather than an exotic one.
 *
 * THE KEY IS JUST COLUMN ZERO. Once each entry is split into literal chunks
 * and varying values with the key first, `compressRecords` does the rest --
 * grouping by shape, factoring shared prefixes and suffixes per column, and
 * emitting one template with a row per entry. Nothing here re-implements that.
 *
 * EVERY ENTRY SURVIVES. The competitor's `lossless_only=True` on this shape
 * returns valid JSON holding 15 of 40 keys with no marker of any kind -- their
 * own info string reads `object:adaptive(40->15 keys)` -- so a reader cannot
 * tell anything was removed. This keeps all forty and says how to rebuild them.
 */
export function compressJsonObjectMap(
  text: string,
  minimumEntries = 8
): CompressionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unchanged(text);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return unchanged(text);
  // NO TOP-LEVEL ENTRY COUNT. A map is usually nested -- `byRoute` inside a
  // metrics document -- and comparing against `Object.entries(parsed)` counts
  // the WRAPPER's three properties against the forty entries actually found,
  // so every nested map was rejected. The entry regex already matches at any
  // depth, and the split below is purely lexical: chunks and values
  // concatenate back to the matched bytes exactly, so correctness does not
  // depend on where in the document the entries were found. Parsing the whole
  // text is still required, because a template over damaged JSON would
  // present a repair as a reconstruction.
  const entry =
    // THE SEPARATOR IS PART OF THE MATCH. compressRecords only groups records
    // that are CONTIGUOUS (`found[end].start === found[end - 1].end`), so an
    // entry regex stopping at the closing brace leaves `,\n  ` between every
    // pair and nothing ever groups -- the encoder silently returns its input.
    /("(?:\\.|[^"\\])*")(\s*:\s*)(\{(?:"(?:\\.|[^"\\])*"|[^{}"])*\})(\s*,?\s*)/g;
  const field =
    /"(?:\\.|[^"\\])*"\s*:\s*("(?:\\.|[^"\\])*"|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  const found: RecordParts[] = [];
  for (const match of text.matchAll(entry)) {
    const [raw, key, separator, body, tail] = match;
    const chunks: string[] = [''];
    const values: string[] = [key];
    let cursor = 0;
    let literal = separator;
    for (const value of body.matchAll(field)) {
      const start = value.index! + value[0].length - value[1].length;
      chunks.push(literal + body.slice(cursor, start));
      values.push(value[1]);
      literal = '';
      cursor = start + value[1].length;
    }
    if (values.length < 2) continue;
    chunks.push(body.slice(cursor) + tail);
    found.push({
      start: match.index!,
      end: match.index! + raw.length,
      chunks,
      values,
      shape: JSON.stringify(chunks),
    });
  }
  if (found.length < minimumEntries) return unchanged(text);
  // Entries must be contiguous to group, which compressRecords enforces; a
  // scatter of unrelated `"k": {...}` pairs simply fails to pay and the
  // input comes back.
  return compressRecords(text, found, true, false, 'entries');
}
/** A closing quote, as it appears raw and as it appears escaped. */
const QUOTE = String.fromCharCode(34);
const BACKSLASH = String.fromCharCode(92);
const ESCAPED_QUOTE = String.fromCharCode(92, 34);

/**
 * A TOKEN PROXY, BECAUSE CHARACTERS ARE NOT WHAT ANYONE PAYS FOR.
 *
 * Two encodings of the same records can sit within a few characters of each
 * other and still differ by scores of tokens, because one spends its bytes on
 * English prose -- about four characters to the token -- and the other on dense
 * JSON punctuation, which is closer to two. Choosing the shorter STRING therefore
 * chose the dearer payload: on one transcript it saved 109 characters and cost 72
 * tokens, and the corpus total moved the wrong way while every character count
 * improved.
 *
 * This counts pretokens -- the pieces a tokeniser splits out before it merges
 * anything -- using cl100k_base's own splitting rule. Every pretoken costs at
 * least one token, so the count is a lower bound; it tracks prose almost exactly
 * and understates long runs of punctuation, which is the safe direction here,
 * because it makes the JSON-heavy candidate look cheaper than it is and so a
 * marker has to earn the swap rather than win it by rounding. The tokeniser
 * itself is not a dependency of this package and must not become one:
 * `bench/compression/pretoken-proxy.check.mjs` is what keeps the two agreed.
 */
const PRETOKEN =
  /'(?:[sdmt]|ll|ve|re)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
// Exported only so `bench/compression/pretoken-proxy.check.mjs` scores the very
// function the encoder decides with, rather than a copy of it that can drift.
export function tokenCost(text: string): number {
  let n = 0;
  PRETOKEN.lastIndex = 0;
  while (PRETOKEN.exec(text) !== null) n += 1;
  return n;
}

/** The records of one adjacent run, grouped by shape and keeping their places. */
interface ShapeClass {
  rows: RecordParts[];
  /** Where each of `rows` sat in the run, as an index from its start. */
  at: number[];
}

/**
 * TWO RECORDS OF THE SAME SHAPE NEED NOT BE NEIGHBOURS.
 *
 * The grouping below used to require them to be, which on a real agent
 * transcript templated nothing at all: 47 records in 16 shapes, the largest
 * class 21 records, and not one adjacent triple among them. Each class carries
 * the positions it occupies, so a class is stated once while every record still
 * decodes back to the index it came from -- nothing is reordered, and the
 * decoder does not have to be told an order it could get wrong.
 */
function shapeClasses(run: RecordParts[]): ShapeClass[] {
  const order: ShapeClass[] = [];
  const byShape = new Map<string, ShapeClass>();
  run.forEach((row, index) => {
    let cls = byShape.get(row.shape);
    if (cls === undefined) {
      cls = { rows: [], at: [] };
      byShape.set(row.shape, cls);
      order.push(cls);
    }
    cls.rows.push(row);
    cls.at.push(index);
  });
  return order;
}

/** One shape stated once: the literal parts, the slots, and the rules. */
interface Templated {
  /** Literal strings and slot numbers, in the order they are joined. */
  template: (string | number)[];
  /** Which value each slot takes, and how much of it the template holds. */
  columns: {
    col: number;
    start: number;
    end: number;
    /** Interior literals hoisted out of this column, in order. */
    parts?: string[];
    /** Which piece of the split this slot holds. */
    piece?: number;
  }[];
  /** Slots the rows omit because an arithmetic rule generates them. */
  runs: Map<number, { first: number; step: number }>;
  /** Slots whose cells are drawn from a small closed set, stated once. */
  dicts: Map<number, string[]>;
}

/**
 * The longest run of characters that every one of `mids` contains somewhere.
 *
 * Binary search rather than a scan from the top, because the property is
 * monotone: if a common substring of length k exists then so does one of
 * length k - 1, being any of its prefixes. That turns a quadratic walk down
 * the lengths into log2(probe) rounds, which is what makes this affordable to
 * run on every varying column of every templated class.
 */
function commonSubstring(mids: string[]): string | null {
  const probe = mids.reduce((a, b) => (b.length < a.length ? b : a));
  const others = mids.filter((m) => m !== probe);
  if (others.length === 0 || probe.length === 0) return null;
  const find = (len: number): string | null => {
    for (let i = 0; i + len <= probe.length; i += 1) {
      const candidate = probe.slice(i, i + len);
      if (others.every((m) => m.includes(candidate))) return candidate;
    }
    return null;
  };
  let lo = 1,
    hi = probe.length,
    best: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const got = find(mid);
    if (got === null) hi = mid - 1;
    else {
      best = got;
      lo = mid + 1;
    }
  }
  return best;
}

/** At most this many interior literals per column, so one pathological
 * column cannot turn every row into a list of two-character shards. */
const INTERIOR_PARTS = 4;

/**
 * The interior literals worth hoisting out of one column's values.
 *
 * THE SHARED PREFIX AND SUFFIX ARE NOT THE WHOLE SHARED TEXT. A column of
 * `"deploy the worker for tenant 3"` against `"restart the queue for tenant 7"`
 * shares no prefix past the opening quote and no suffix past the digit, so the
 * prefix/suffix factoring above hoists nothing and every row carries ` the `
 * and ` for tenant ` again. On the relevance-probe fixture that was about
 * 3,900 characters of a 20,360-character output: text stated once in the shape
 * and then repeated once per row anyway.
 *
 * The split is exact by construction rather than by alignment. Each row is cut
 * at its OWN first occurrence of each literal, so left + literal + right is the
 * row's value whatever the literal meant there; a literal that lines up badly
 * costs compression, never content.
 *
 * Whether it pays is arithmetic, in the same spirit as the prefix test above.
 * Hoisting N characters out of R rows removes N from each row but adds one more
 * cell to every row's array -- two quotes and a comma, three characters -- and
 * adds the literal once to the template as an array element of its own, another
 * N + 3. So it pays when R * (N - 3) > N + 3, which is why a three-character
 * separator is never worth a slot however many rows share it.
 */
function interiorParts(mids: string[], budget: number): string[] {
  if (budget <= 0) return [];
  const found = commonSubstring(mids);
  if (found === null || mids.length * (found.length - 3) <= found.length + 3)
    return [];
  const lefts: string[] = [],
    rights: string[] = [];
  for (const mid of mids) {
    const at = mid.indexOf(found);
    lefts.push(mid.slice(0, at));
    rights.push(mid.slice(at + found.length));
  }
  const before = interiorParts(lefts, budget - 1);
  return [
    ...before,
    found,
    ...interiorParts(rights, budget - 1 - before.length),
  ];
}

/**
 * Cuts one value at each literal in turn, yielding `parts.length + 1` pieces.
 *
 * A literal the encoder found in every row must be here, so a miss is a bug in
 * the encoder rather than a row to be tolerated -- and tolerating it would drop
 * the text silently, which is the one failure this whole format exists to make
 * impossible. It throws instead.
 */
function splitOn(mid: string, parts: string[]): string[] {
  const out: string[] = [];
  let rest = mid;
  for (const part of parts) {
    const at = rest.indexOf(part);
    if (at < 0)
      throw new Error(
        `template part ${JSON.stringify(part)} is not in row ${JSON.stringify(mid)}`
      );
    out.push(rest.slice(0, at));
    rest = rest.slice(at + part.length);
  }
  out.push(rest);
  return out;
}

/**
 * States one shape once, as literal template parts plus per-row fragments.
 *
 * Extracted from `compressRecords` unchanged so that a class found by shape and
 * a class found by adjacency cannot be encoded by two different rules that
 * drift apart. The caller decides WHICH records share a template; this decides
 * what the template is.
 */
function templateOf(group: RecordParts[]): Templated {
  const first = group[0];
  const varying = first.values.map((value, col) =>
    group.some((row) => row.values[col] !== value)
  );
  const template: (string | number)[] = [],
    columns: Templated['columns'] = [];
  // THE REMAINDER IS WHAT THE ROW CARRIES. Reading the whole value here made
  // a factored column ineligible, which is backwards: once `/route-` is
  // hoisted into the template the rows hold 0..39, and that is a cleaner run
  // than the original strings ever were. So the test takes the cells the rows
  // would actually carry, whether those come from an offset pair or from a
  // piece of a split column.
  const runOfCells = (
    cells: string[]
  ): { first: number; step: number } | null => {
    if (cells.length < 4) return null;
    const nums: number[] = [];
    for (const raw of cells) {
      if (!/^-?(?:0|[1-9]\d*)$/.test(raw)) return null;
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || String(n) !== raw) return null;
      nums.push(n);
    }
    const step = nums[1] - nums[0];
    for (let i = 2; i < nums.length; i += 1)
      if (nums[i] - nums[i - 1] !== step) return null;
    // A zero step is a constant column, which the template already hoists.
    return step === 0 ? null : { first: nums[0], step };
  };
  const cellsOf = (col: number, head: number, tail: number): string[] =>
    group.map((row) => row.values[col].slice(head, tail ? -tail : undefined));
  const runOf = (
    col: number,
    head: number,
    tail: number
  ): { first: number; step: number } | null =>
    group.length < 4 ? null : runOfCells(cellsOf(col, head, tail));
  let literal = first.chunks[0];
  first.values.forEach((value, col) => {
    if (varying[col]) {
      // Factor shared lexical prefixes/suffixes as well as field names.
      // IDs often differ only in their final digits; retaining the full
      // escaped ID in every row needlessly repeats it across every turn.
      let start = value.length,
        suffix = value.length;
      for (const row of group) {
        const other = row.values[col];
        let n = 0;
        while (n < start && n < other.length && value[n] === other[n]) n++;
        start = n;
      }
      for (const row of group) {
        const other = row.values[col];
        let n = 0;
        while (
          n < suffix &&
          n < value.length - start &&
          n < other.length - start &&
          value[value.length - n - 1] === other[other.length - n - 1]
        )
          n++;
        suffix = n;
      }
      // Keep booleans and numbers explicit: a number's digits ARE its
      // content, and factoring them yields nothing a reader can use.
      const quoted = value.startsWith('"') || value.startsWith('\\"');

      // PREFIX AND SUFFIX ARE JUDGED SEPARATELY, and by whether they pay.
      // They used to share one `start < 8` test, so a seven-character
      // common prefix zeroed a SIXTEEN-character common suffix along with
      // itself. On ninety rows of `"line N priced by hand"` the prefix
      // `\"line ` is exactly seven, one short, and the whole ` priced by
      // hand\"` tail was then repeated on every row -- about 2,500 bytes
      // thrown away by an off-by-one in a magic number.
      //
      // The honest test is arithmetic rather than a constant: hoisting
      // N characters out of R rows saves N * R and costs N once in the
      // template, so it pays whenever R > 1 and N is not trivial. Two is
      // the smallest run worth the indirection.
      const pays = (shared: number): boolean =>
        quoted && shared >= 2 && shared * (group.length - 1) > shared;
      if (!pays(start)) start = 0;
      if (!pays(suffix)) suffix = 0;

      // A KEY COLUMN ENDS IN ITS CLOSING QUOTE -- one character -- and the
      // `shared >= 2` floor above rejects it, leaving the row holding `0"`
      // rather than `0`, so /route-0../route-39 was not read as the run it
      // plainly is. One character is not worth hoisting on its own, which
      // is why the floor exists; it IS worth hoisting when it turns a whole
      // column into a rule. That judgement needs the run test, so it
      // happens here rather than in `pays` -- and before the template is
      // emitted, because widening the tail afterwards would leave the quote
      // in neither the template nor the row.
      if (!runOf(col, start, suffix))
        for (const wider of [suffix + 1, suffix + 2]) {
          const shared = group.every((row) => {
            const v = row.values[col];
            if (v.length - start - wider <= 0) return false;
            const cut = v.slice(
              v.length - wider,
              suffix ? v.length - suffix : undefined
            );
            return cut === QUOTE || cut === ESCAPED_QUOTE;
          });
          if (shared && runOf(col, start, wider)) {
            suffix = wider;
            break;
          }
        }
      // A COLUMN IS NOT NECESSARILY ONE SLOT. Once the shared prefix and
      // suffix are off, what is left may still be mostly shared text with a
      // few varying pieces in it, and `interiorParts` finds those. A column
      // an arithmetic rule already generates is left alone: its rows carry
      // nothing to split. See `interiorParts` for why this pays.
      const parts =
        quoted && !runOf(col, start, suffix)
          ? interiorParts(
              group.map((row) =>
                row.values[col].slice(start, suffix ? -suffix : undefined)
              ),
              INTERIOR_PARTS
            )
          : [];
      const base = columns.length;
      template.push(literal + value.slice(0, start), base);
      parts.forEach((part, j) => template.push(part, base + j + 1));
      for (let j = 0; j <= parts.length; j += 1)
        columns.push(
          parts.length === 0
            ? { col, start, end: suffix }
            : { col, start, end: suffix, parts, piece: j }
        );
      literal = suffix ? value.slice(-suffix) : '';
    } else literal += value;
    literal += first.chunks[col + 1];
  });
  template.push(literal);
  // AN ARITHMETIC COLUMN IS A RULE, NOT A LIST.
  //
  // Sequential ids, byte offsets, line numbers and page cursors step by a
  // constant, and both this engine and the competitor were spelling every
  // one of them out digit by digit: measured on 120 records whose id,
  // offset and line columns are perfect runs, their router gains 0.9
  // points over the same shape with RANDOM values and we gain 0.8. The
  // redundancy was simply not being read.
  //
  // `1000..1119 step 1` is a complete generator, not a summary: every
  // value is derivable exactly and none is approximated. That is what
  // separates this from factoring a shared prefix out of an identifier,
  // which leaves a row holding a fragment of a token -- the failure
  // json-anomaly-completeness guards. Here the guard is structural: a run
  // requires every value to be a SAFE integer, so an unsafe id can never
  // enter one.
  const runs = new Map<number, { first: number; step: number }>();
  // A PIECE OF A SPLIT COLUMN IS ELIGIBLE TOO. `... for tenant 1`, `... for
  // tenant 2` is the shape interior factoring produces, and the piece left
  // after ` for tenant ` is hoisted is exactly the run the rows should stop
  // spelling. Testing the cells rather than an offset pair is what lets the
  // same rule reach both kinds of slot.
  const pieces = new Map<number, string[][]>();
  columns.forEach((column, slot) => {
    const { col, start, end, parts, piece } = column;
    if (parts === undefined) {
      const run = runOf(col, start, end);
      if (run) runs.set(slot, run);
      return;
    }
    let cut = pieces.get(col);
    if (cut === undefined) {
      cut = cellsOf(col, start, end).map((mid) => splitOn(mid, parts));
      pieces.set(col, cut);
    }
    const run = runOfCells(cut.map((row) => row[piece ?? 0]));
    if (run) runs.set(slot, run);
  });
  return { template, columns, runs, dicts: dictsOf(cellColumns(group, { columns, runs })) };
}

/**
 * The cells each row would carry, column-major, paired with their slot number.
 *
 * Both the row writer and the dictionary chooser need exactly this matrix, and
 * they have to agree on it to the character: a dictionary built from cells that
 * are cut differently from the ones written out would index rows by values no
 * row holds. Cutting it once here is what makes that disagreement impossible
 * rather than merely unlikely.
 */
function cellColumns(
  group: RecordParts[],
  { columns, runs }: Pick<Templated, 'columns' | 'runs'>
): { slot: number; cells: string[] }[] {
  const out: { slot: number; cells: string[] }[] = [];
  // One split per column per row, not one per slot: the pieces of a column are
  // consecutive slots reading the same value, and cutting it again for each of
  // them would be the same work repeated parts.length times.
  const split = group.map(() => new Map<number, string[]>());
  columns.forEach(({ col, start, end, parts, piece }, slot) => {
    if (runs.has(slot)) return;
    const cells = group.map((row, i) => {
      const cut = row.values[col].slice(start, end ? -end : undefined);
      if (parts === undefined) return cut;
      let cuts = split[i].get(col);
      if (cuts === undefined) {
        cuts = splitOn(cut, parts);
        split[i].set(col, cuts);
      }
      return cuts[piece ?? 0];
    });
    out.push({ slot, cells });
  });
  return out;
}

/**
 * A COLUMN DRAWN FROM A CLOSED SET IS A LIST, NOT A VALUE PER ROW.
 *
 * Log levels, HTTP methods, statuses, repeated verbs and repeated nouns are the
 * commonest shape in machine-written JSON, and a template cannot hoist them
 * because they DO vary from row to row -- just over seven values, not three
 * hundred. Every row was spelling one of a handful of strings out in full.
 * Measured over the 18 fixtures this engine is judged on, stating the set once
 * and indexing into it takes 49,469 characters off 1,129,667 -- 4.4% of the
 * whole corpus, and 47.9% of search-results on its own.
 *
 * The saving is arithmetic, not a heuristic: a column pays only when the rows
 * it shortens outweigh the dictionary it adds, and a column whose cells are all
 * distinct is rejected before any of that is computed. Nothing is approximated
 * -- an index names one member of a stated list, so the value comes back
 * exactly, which is what separates this from abbreviating a value in place.
 */
function dictsOf(
  cols: { slot: number; cells: string[] }[]
): Map<number, string[]> {
  const dicts = new Map<number, string[]>();
  for (const { slot, cells } of cols) {
    const distinct = [...new Set(cells)];
    if (distinct.length === cells.length) continue;
    const index = new Map(distinct.map((value, i) => [value, i]));
    let before = 0,
      after = 0,
      beforeChars = 0,
      afterChars = 0;
    for (const cell of cells) {
      const was = JSON.stringify(cell),
        now = String(index.get(cell));
      before += tokenCost(was);
      after += tokenCost(now);
      beforeChars += was.length;
      afterChars += now.length;
    }
    // `4=` and the leading space the clause pays for this slot, plus the list.
    const list = JSON.stringify(distinct),
      cost = tokenCost(list) + tokenCost(`${slot}=`) + 1,
      costChars = list.length + String(slot).length + 2;
    // DECIDED IN THE BILLED UNIT, with characters as a floor rather than as the
    // judgement. A subscription is metered in tokens, so a swap that shortens
    // the text while costing tokens is a loss the character count would have
    // reported as a win. The character test is kept only to refuse the reverse
    // case -- a token win paid for with a longer output -- because the corpus
    // is judged on both columns and neither may be spent to buy the other.
    if (before - after - cost > 0 && beforeChars - afterChars - costChars >= 0)
      dicts.set(slot, distinct);
  }
  return dicts;
}

/** `; slots 0=1+1n count from 0`, or nothing when no column is a rule. */
function slotClause(runs: Templated['runs']): string {
  return runs.size
    ? '; slots ' +
        [...runs]
          .map(([slot, r]) => `${slot}=${r.first}+${r.step}n`)
          .join(' ') +
        ' count from 0'
    : '';
}

/**
 * `; dict 3=["GET","POST"]`, or nothing when no column is a closed set.
 *
 * Placed beside the run clause and, like it, inside the header's own brackets.
 * A list ends in `]` and the header ends in `]`, so the reader's pattern stops
 * at the first `]` that is followed by a newline -- which a JSON string cannot
 * contain, because a raw newline inside one is not JSON at all.
 */
function dictClause(dicts: Templated['dicts']): string {
  return dicts.size
    ? '; dict ' +
        [...dicts]
          .map(([slot, values]) => `${slot}=${JSON.stringify(values)}`)
          .join(' ')
    : '';
}

/** One JSON array per row, holding only the slots no rule generates. */
function rowLines(group: RecordParts[], shaped: Templated): string {
  const cols = cellColumns(group, shaped);
  // An index map, not `indexOf`: a dictionary that pays can still hold hundreds
  // of members, and a linear scan per cell would make writing a block quadratic
  // in the very case the encoding is best at.
  const index = new Map(
    [...shaped.dicts].map(([slot, values]) => [
      slot,
      new Map(values.map((value, i) => [value, i])),
    ])
  );
  return group
    .map((_row, i) =>
      JSON.stringify(
        cols.map(({ slot, cells }) => {
          const at = index.get(slot);
          return at === undefined ? cells[i] : at.get(cells[i]);
        })
      )
    )
    .join('\n');
}

/**
 * The marker for a run that is all one shape -- unchanged, byte for byte.
 *
 * Kept as its own form rather than folded into the by-position marker below,
 * because the by-position marker pays for a position list per block and a
 * single-shape run has nothing to spend it on: every position is covered by the
 * one template, in order, which is exactly what this header already says.
 */
function oneShapeMarker(
  group: RecordParts[],
  found: RecordParts[],
  complete: boolean,
  shortHeader: boolean,
  noun: string,
  label: string
): string | null {
  if (group.length < 3) return null;
  const shaped = templateOf(group);
  // THE COUNT BELONGS TO THIS MARKER, NOT TO THE DOCUMENT. Each marker
  // encodes one contiguous `group`; `found` is every record in the
  // document. With two or more groups -- which is what a keyed map with
  // unrelated properties between its entries produces -- every marker
  // announced the document-wide total, so a reader counting rows under
  // one marker found fewer than it claimed.
  const whole = group.length === found.length;
  return (
    (shortHeader
      ? `[All ${group.length} JSON records; join template strings and row[integer] verbatim. Template: `
      : (complete
          ? `[JSON ${label}; ALL ${found.length} ${noun} preserved${whole ? '' : `, ${group.length} encoded here`}. `
          : '[JSON fragment records; missing records remain unknown. ') +
        'Join template parts, replacing numeric slots with verbatim text fragments from each row. Template: ') +
    JSON.stringify(shaped.template) +
    slotClause(shaped.runs) +
    dictClause(shaped.dicts) +
    ']\n' +
    rowLines(group, shaped) +
    '\n[/JSON fragment records]\n'
  );
}

/**
 * The marker for a run whose records do NOT all share one shape.
 *
 * Every position in the run is stated exactly once. A class of three or more
 * records becomes a template that names the positions it fills; anything left
 * over is carried verbatim, at its own position, with its length in front of it
 * -- which costs about a dozen characters and, unlike escaping it into a JSON
 * string, does not inflate the text it is preserving by a byte.
 *
 * THE LENGTH IS WHAT MAKES THE BODY PARSEABLE, not a fence. A row line and a
 * block header both begin with a bracket, and a preserved record may contain any
 * line at all, so nothing in the body can be found by looking for it: the header
 * states how many rows follow, or how many characters, and the decoder counts.
 *
 * Returns null when no class is large enough to template, since the marker would
 * then be a re-statement of the run with overhead on top.
 */
function byPositionMarker(
  text: string,
  run: RecordParts[],
  classes: ShapeClass[],
  found: RecordParts[],
  complete: boolean,
  noun: string,
  label: string
): string | null {
  if (!classes.some((cls) => cls.rows.length >= 3)) return null;
  const blocks: string[] = [];
  for (const cls of classes)
    if (cls.rows.length >= 3) {
      const shaped = templateOf(cls.rows);
      blocks.push(
        `[rows at ${cls.at.join(',')}${slotClause(shaped.runs)}${dictClause(
            shaped.dicts
          )}; Template: ` +
          JSON.stringify(shaped.template) +
          ']\n' +
          rowLines(cls.rows, shaped) +
          '\n'
      );
    } else
      cls.rows.forEach((row, n) => {
        const raw = text.slice(row.start, row.end);
        blocks.push(`[at ${cls.at[n]}; ${raw.length} chars]\n${raw}`);
      });
  return (
    `[JSON ${label} by position; ${found.length} ${noun}, ` +
    `${run.length} here as positions 0-${run.length - 1}` +
    (complete ? '' : ', with missing records still unknown') +
    '. Each block fills the positions it names: rows from its template, ' +
    'numeric slots taking its fragments in order; a record verbatim at the ' +
    'stated length.]\n' +
    blocks.join('') +
    '[/JSON records by position]\n'
  );
}

/**
 * The legacy encoding of a run: maximal same-shape NEIGHBOURS, each on its own.
 *
 * Kept as a candidate rather than replaced, because it beats a position list
 * whenever the shapes really are adjacent. The commonest run in any JSON array
 * is N records with a trailing comma followed by one without: the odd record out
 * is a shape of its own, and leaving it in place costs nothing at all, where
 * carrying it inside a marker costs a block header. Byte-identical to what this
 * function emitted before position lists existed, so that a payload the old
 * grouping handled well is encoded exactly as it was.
 */
function legacyMarkers(
  text: string,
  run: RecordParts[],
  found: RecordParts[],
  complete: boolean,
  shortHeader: boolean,
  noun: string,
  label: string
): { out: string; counts: number[] } {
  let out = '';
  const counts: number[] = [];
  for (let i = 0; i < run.length; ) {
    let end = i + 1;
    while (end < run.length && run[end].shape === run[i].shape) end++;
    const group = run.slice(i, end),
      from = group[0].start,
      stop = group[group.length - 1].end;
    const marker = oneShapeMarker(
      group,
      found,
      complete,
      shortHeader,
      noun,
      label
    );
    if (marker !== null && marker.length < stop - from) {
      out += marker;
      counts.push(group.length);
    } else out += text.slice(from, stop);
    i = end;
  }
  return { out, counts };
}

function compressRecords(
  text: string,
  found: RecordParts[],
  complete: boolean,
  shortHeader = false,
  /** What the rows ARE, so a keyed map is not announced as an array. */
  noun = 'records'
): CompressionResult {
  const elisions: Elision[] = [];
  const label = noun === 'entries' ? 'object map' : 'array records';
  let result = '',
    cursor = 0;
  for (let i = 0; i < found.length; ) {
    // ADJACENCY BOUNDS THE RUN; SHAPE PARTITIONS IT TWO WAYS, AND THE SHORTER
    // ONE WINS.
    //
    // This scan used to carry `found[end].shape === first.shape` as well, so a
    // run ended at the first record that differed and only NEIGHBOURING records
    // of one shape were ever templated. On a real agent transcript that
    // templated nothing at all: 47 records in 16 shapes, the largest class 21
    // records, and not one adjacent triple among them.
    //
    // The span still has to be contiguous -- it is the byte range a marker
    // replaces -- but which records inside it share a template is decided below,
    // by measuring both answers. Neither is better in general: a position list
    // reaches a scattered class, and costs a block header for every record that
    // is not in one.
    let end = i + 1;
    while (end < found.length && found[end].start === found[end - 1].end) end++;
    const run = found.slice(i, end),
      from = run[0].start,
      stop = run[run.length - 1].end;
    const classes = shapeClasses(run);
    const legacy = legacyMarkers(
      text,
      run,
      found,
      complete,
      shortHeader,
      noun,
      label
    );
    const scattered =
      classes.length > 1
        ? byPositionMarker(text, run, classes, found, complete, noun, label)
        : null;
    // EACH CANDIDATE PASSES ITS OWN PAY TEST, IN ITS OWN UNIT. The legacy form
    // keeps the character test it has always used, so every payload the old
    // grouping already handled is encoded byte for byte as it was; the position
    // list, which buys its saving with prose, has to pay for that prose in
    // tokens. A TIE GOES TO THE LEGACY FORM for the same reason.
    const raw = text.slice(from, stop);
    const legacyPays =
      legacy.counts.length > 0 && legacy.out.length < raw.length;
    const best: { out: string; counts: number[] } | null =
      scattered !== null &&
      tokenCost(scattered) < tokenCost(raw) &&
      (!legacyPays || tokenCost(scattered) < tokenCost(legacy.out))
        ? { out: scattered, counts: [run.length] }
        : legacyPays
          ? legacy
          : null;
    if (best !== null) {
      result += text.slice(cursor, from) + best.out;
      cursor = stop;
      for (const count of best.counts)
        elisions.push({
          removed: `${count} complete records${complete ? '' : ' within truncated JSON'} represented by exact template and rows`,
          recoverAt: null,
          lossless: true,
        });
    }
    i = end;
  }
  return elisions.length
    ? { text: result + text.slice(cursor), elisions, lossless: true }
    : unchanged(text);
}
