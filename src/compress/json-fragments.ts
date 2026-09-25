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
  for (const match of text.matchAll(object)) {
    const raw = match[0];
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
      start: match.index!,
      end: match.index! + raw.length,
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
  // Compact small arrays have no indented record boundaries. Use the lexical
  // flat-object scanner only after validating the entire array and every row.
  // This keeps original numeric and string spellings, including large integers.
  if (
    // THE ROW COUNT WAS NEVER THE SAFETY CONDITION. This used to require
    // `minimumRows < 32`, false on the default call compressJson makes, so
    // the lexical scanner was unreachable from the router and a one-line-
    // per-record array -- what `jq -c` emits -- compressed 12.9% where the
    // same rows over several lines reach 77%. What makes it safe is the
    // validation below plus the exact-count check after it, both unchanged.
    found.length !== parsed.length &&
    parsed.every(
      (row: unknown) =>
        row !== null &&
        typeof row === 'object' &&
        !Array.isArray(row) &&
        Object.values(row).every((v) => v === null || typeof v !== 'object')
    )
  ) {
    found = records(text, true);
  }
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
const ESCAPED_QUOTE = String.fromCharCode(92, 34);

function compressRecords(
  text: string,
  found: RecordParts[],
  complete: boolean,
  shortHeader = false,
  /** What the rows ARE, so a keyed map is not announced as an array. */
  noun = 'records'
): CompressionResult {
  const elisions: Elision[] = [];
  let result = '',
    cursor = 0;
  for (let i = 0; i < found.length; ) {
    const first = found[i];
    let end = i + 1;
    while (
      end < found.length &&
      found[end].start === found[end - 1].end &&
      found[end].shape === first.shape
    )
      end++;
    const group = found.slice(i, end),
      stop = group[group.length - 1].end;
    if (group.length >= 3) {
      const varying = first.values.map((value, col) =>
        group.some((row) => row.values[col] !== value)
      );
      const template: (string | number)[] = [],
        columns: { col: number; start: number; end: number }[] = [];
      const runOf = (
        col: number,
        head: number,
        tail: number
      ): { first: number; step: number } | null => {
        if (group.length < 4) return null;
        const nums: number[] = [];
        for (const row of group) {
          // THE REMAINDER IS WHAT THE ROW CARRIES. Reading the whole value
          // here made a factored column ineligible, which is backwards: once
          // `/route-` is hoisted into the template the rows hold 0..39, and
          // that is a cleaner run than the original strings ever were.
          const raw = row.values[col].slice(head, tail ? -tail : undefined);
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
          template.push(literal + value.slice(0, start), columns.length);
          columns.push({ col, start, end: suffix });
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
      columns.forEach((column, slot) => {
        const { col, start } = column;
        let { end } = column;
        const run = runOf(col, start, end);
        if (run) runs.set(slot, run);
      });

      // THE COUNT BELONGS TO THIS MARKER, NOT TO THE DOCUMENT. Each marker
      // encodes one contiguous `group`; `found` is every record in the
      // document. With two or more groups -- which is what a keyed map with
      // unrelated properties between its entries produces -- every marker
      // announced the document-wide total, so a reader counting rows under
      // one marker found fewer than it claimed.
      const whole = group.length === found.length;
      const label = noun === 'entries' ? 'object map' : 'array records';
      const compact =
        (shortHeader
          ? `[All ${group.length} JSON records; join template strings and row[integer] verbatim. Template: `
          : (complete
              ? `[JSON ${label}; ALL ${found.length} ${noun} preserved${whole ? '' : `, ${group.length} encoded here`}. `
              : '[JSON fragment records; missing records remain unknown. ') +
            'Join template parts, replacing numeric slots with verbatim text fragments from each row. Template: ') +
        JSON.stringify(template) +
        (runs.size
          ? '; slots ' +
            [...runs]
              .map(([slot, r]) => `${slot}=${r.first}+${r.step}n`)
              .join(' ') +
            ' count from 0'
          : '') +
        ']\n' +
        group
          .map((row) =>
            JSON.stringify(
              columns
                .map(({ col, start, end }, slot) =>
                  runs.has(slot)
                    ? null
                    : row.values[col].slice(start, end ? -end : undefined)
                )
                .filter((cell): cell is string => cell !== null)
            )
          )
          .join('\n') +
        '\n[/JSON fragment records]\n';
      if (compact.length < stop - first.start) {
        result += text.slice(cursor, first.start) + compact;
        cursor = stop;
        elisions.push({
          removed: `${group.length} complete records${complete ? '' : ' within truncated JSON'} represented by exact template and rows`,
          recoverAt: null,
          lossless: true,
        });
      }
    }
    i = end;
  }
  return elisions.length
    ? { text: result + text.slice(cursor), elisions, lossless: true }
    : unchanged(text);
}
