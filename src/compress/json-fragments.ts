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
    if (
      !parsed ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((v) => v !== null && typeof v === 'object')
    )
      continue;
    const field =
      /"(?:\\.|[^"\\])*"\s*:\s*("(?:\\.|[^"\\])*"|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    const chunks: string[] = [],
      values: string[] = [];
    let cursor = 0;
    for (const value of source.matchAll(field)) {
      const start = value.index! + value[0].length - value[1].length;
      chunks.push(encode(source.slice(cursor, start)));
      values.push(encode(value[1]));
      cursor = start + value[1].length;
    }
    if (!values.length || values.length !== Object.keys(parsed).length)
      continue;
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
      const runOf = (col: number): { first: number; step: number } | null => {
        if (group.length < 4) return null;
        const nums: number[] = [];
        for (const row of group) {
          const raw = row.values[col];
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
      const runs = new Map<number, { first: number; step: number }>();
      columns.forEach(({ col, start, end }, slot) => {
        if (start || end) return; // a factored column is no longer a number
        const run = runOf(col);
        if (run) runs.set(slot, run);
      });

      const compact =
        (shortHeader
          ? `[All ${found.length} JSON records; join template strings and row[integer] verbatim. Template: `
          : (complete
              ? `[JSON ${noun === 'entries' ? 'object map' : 'array records'}; ALL ${found.length} ${noun} preserved. `
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
