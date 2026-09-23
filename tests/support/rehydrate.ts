import { expandLog } from '../helpers/expand-log.js';

/**
 * ONE ENTRY POINT FOR "REBUILD THE INPUT FROM THE OUTPUT ALONE", AND IT FAILS
 * CLOSED.
 *
 * #414 proved the log engine's `lossless: true` by reconstructing its input,
 * and left the reconstructor inside the test that needed it. Repeating that per
 * engine means one hand-written inverse per encoder, each free to drift from
 * the encoder it is supposed to invert -- and a decoder that has drifted into
 * being too forgiving passes everything, which is indistinguishable from having
 * no gate at all.
 *
 * So the envelope handling lives here once and the per-engine payload grammars
 * register into it. The envelope `[... {removed}]` / `[... {removed} -> {at}]`
 * is centralised in `src/compress/annotate.ts#inlineMarker` even though the
 * engines are not; the payload inside it is not -- `positions=` is log-specific,
 * a records template is json-specific.
 *
 * THE REFUSAL IS THE POINT. An unrecognised marker is not a line of text. A
 * decoder that passes one through as a literal reports a successful
 * reconstruction of content it never restored, which is precisely the vacuous
 * green this module exists to prevent. Two kinds of marker reach the refusal:
 * a new marker family nobody has registered, and the LOSSY form
 * `[... what went -> path]`, which by construction cannot be rebuilt from the
 * output alone -- the path is the whole point of it.
 */

/**
 * Rebuilds the original from the records encoding, rule included.
 *
 * Uniform rows are stated once as a template plus per-row fragments, and a
 * column that steps by a constant becomes a rule (`slot=first+stepN`) rather
 * than a list of values. `r-0` is then `"r-"` in the template joined to a slot
 * the rule generates: present to the byte, absent as a substring.
 */
export function expandJsonRecords(text: string): string {
  return text.replace(
    /\[JSON array records; ALL \d+ records preserved(?:, \d+ encoded here)?\. Join template parts, replacing numeric slots with verbatim text fragments from each row\. Template: (\[[^\n]+?\])(; slots ([^\]\n]+) count from 0)?\]\n([\s\S]*?)\[\/JSON fragment records\]\n/g,
    (
      _all,
      encoded: string,
      _clause,
      slots: string | undefined,
      rows: string
    ) => {
      const template = JSON.parse(encoded) as (number | string)[];
      const rules = new Map<number, { first: number; step: number }>();
      for (const part of (slots ?? '').split(' ').filter(Boolean)) {
        const m = /^(\d+)=(-?\d+)\+(-?\d+)n$/.exec(part);
        if (!m) throw new Error(`unreadable run clause ${part}`);
        rules.set(Number(m[1]), { first: Number(m[2]), step: Number(m[3]) });
      }
      return rows
        .trim()
        .split('\n')
        .map((row, index) => {
          const present = JSON.parse(row) as string[];
          const slotCount = present.length + rules.size;
          const values: string[] = [];
          let next = 0;
          for (let slot = 0; slot < slotCount; slot += 1) {
            const rule = rules.get(slot);
            values.push(
              rule ? String(rule.first + rule.step * index) : present[next++]
            );
          }
          return template
            .map((part) => (typeof part === 'number' ? values[part] : part))
            .join('');
        })
        .join('');
    }
  );
}

/**
 * Rebuilds the original from the TAP records encoding.
 *
 * Node's leaf-test records are stated once as a template with `{name}`, `{id}`
 * and `{ms}` holes plus one JSON row per record. Only byte-identical
 * diagnostics share a template, so every failure still carries its own row --
 * which is what makes this invertible rather than merely compact.
 *
 * This grammar lived inside `tap.test.ts`, which is the arrangement this module
 * exists to end: a decoder beside the one test that uses it is free to drift
 * into being more forgiving than the encoder, and a forgiving decoder passes
 * everything.
 */
export function expandTapRecords(text: string): string {
  return text.replace(
    /\[TAP (?:passing|failing) records: JSON rows \[name,id,ms\]; substitute into template ("[^\n]+")\]\r?\n([\s\S]*?)\[\/TAP (?:passing|failing) records\]\r?\n/g,
    (_all, encoded: string, rows: string) => {
      const template = JSON.parse(encoded) as string;
      return rows
        .trim()
        .split(/\r?\n/)
        .map((row) => {
          const [name, id, ms] = JSON.parse(row) as string[];
          return template.replace(
            /\{(name|id|ms)\}/g,
            (_s, key: string) => ({ name, id, ms })[key as 'name' | 'id' | 'ms']
          );
        })
        .join('');
    }
  );
}
/**
 * The path pattern from `src/compress/search.ts#HIT`, kept in step with it.
 *
 * A header only looks like a header when its first field looks like a path.
 * Without the constraint `18:10-20 INFO up` reads as a hunk of eleven lines
 * and a decoder eats the next eleven lines of an unrelated log.
 */
const SEARCH_PATH =
  '(?:[A-Za-z]:[\\\\/][^\\s:]*|[^\\s:]*[\\\\/][^\\s:]*|[^\\s:]+\\.[A-Za-z0-9]+)';

/**
 * `path:start-end` plus the two optional suffixes the encoder can append.
 *
 * THE RANGE ALWAYS HAS TWO ENDS. `flush` restores any hunk below
 * MIN_HUNK_LINES with its original per-line prefixes, so a header is only ever
 * written for two or more contiguous lines and `start === previous` -- the
 * single-number range -- is unreachable. Matching it anyway would claim every
 * bare `path:12` in the surrounding text.
 */
const SEARCH_HEADER = new RegExp(
  `^(${SEARCH_PATH}):(\\d+)-(\\d+)` +
    '( \\(context\\)| \\(matched [\\d,-]+\\))?' +
    '(?: \\[exact declaration rows: name<TAB>rhs; concatenate template ' +
    '(\\[.*\\]) around the two fields; source line = range start ' +
    '\\+ zero-based row index\\])?$'
);

/** The line numbers a header says matched, as `matchNote` said them. */
function matchedLines(
  marks: string | undefined,
  start: number,
  end: number
): Set<number> {
  const all = (from: number, to: number): number[] =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);
  // No note at all means every line in the range matched: the range says it.
  if (marks === undefined) return new Set(all(start, end));
  if (marks === ' (context)') return new Set();
  const listed = /^ \(matched (.+)\)$/.exec(marks);
  if (!listed) throw new Error(`rehydrate: unreadable match note ${marks}`);
  const span = /^(\d+)-(\d+)$/.exec(listed[1]);
  if (span) return new Set(all(Number(span[1]), Number(span[2])));
  return new Set(listed[1].split(',').map(Number));
}

/**
 * Rebuilds the original from the search-hunk encoding.
 *
 * REPLACES A DECODER THAT ONLY READ THE RARE HALF OF THE FORMAT.
 * `search-declarations.test.ts` carried a `reconstruct` that returned any
 * header without `[exact declaration rows:` unchanged, as a line of text --
 * and the declaration table needs 64 uniform lines, so the engine's ordinary
 * output, a path stated once over a hunk of content, was never reconstructed
 * by anything. The round trip it appeared to prove was the one case the
 * encoder is least likely to reach.
 *
 * Both halves are read here. The separator is not stored per line, so it is
 * derived the way the encoder wrote it: `:` for a line the header calls
 * matched, `-` for one it does not.
 */
export function expandSearchHunks(text: string): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(newline);
  const out: string[] = [];
  for (let cursor = 0; cursor < lines.length; cursor += 1) {
    const header = SEARCH_HEADER.exec(lines[cursor]);
    if (!header) {
      out.push(lines[cursor]);
      continue;
    }
    const [, path, first, last, marks, encoded] = header;
    const start = Number(first);
    const end = Number(last);
    const count = end - start + 1;
    const body = lines.slice(cursor + 1, cursor + 1 + count);
    if (body.length < count)
      throw new Error(
        `rehydrate: hunk ${path}:${start}-${end} claims ${count} lines but ${body.length} follow`
      );
    const matched = matchedLines(marks, start, end);
    const template = encoded ? (JSON.parse(encoded) as string[]) : null;
    body.forEach((row, offset) => {
      const line = start + offset;
      let content = row;
      if (template) {
        const fields = row.split('\t');
        if (fields.length !== 2)
          throw new Error(
            `rehydrate: declaration row is not two fields: ${row}`
          );
        content =
          template[0] + fields[0] + template[1] + fields[1] + template[2];
      }
      out.push(`${path}:${line}${matched.has(line) ? ':' : '-'}${content}`);
    });
    cursor += count;
  }
  return out.join(newline);
}

/** Markers this module must consume rather than pass through as text. */
const UNCONSUMED = /^\s*\[\/?(?:JSON |All \d+ JSON |TAP )/;

/**
 * The search engine's markers sit at the END of a header line, not the start,
 * so the line-prefix refusal above cannot see them. A declaration note that
 * survived expansion means `expandSearchHunks` declined the header carrying
 * it -- a variant it does not invert -- and the body lines under it are still
 * missing their path and line number.
 */
const UNCONSUMED_SUFFIX = /\[exact declaration rows:/;

/**
 * Applies every registered grammar, then refuses anything left over.
 *
 * `expandLog` already refuses an unrecognised `[... ` envelope; this adds the
 * same refusal for the json marker families, which do not use that prefix and
 * would otherwise survive as ordinary-looking lines.
 */
export function rehydrate(text: string): string {
  // Search first: its grammar is line-structural rather than delimited, so it
  // has to see the hunk bodies before any other grammar rewrites a line inside
  // one.
  const out = expandLog(
    expandTapRecords(expandJsonRecords(expandSearchHunks(text)))
  );
  for (const line of out.split('\n'))
    if (UNCONSUMED.test(line) || UNCONSUMED_SUFFIX.test(line))
      throw new Error(`rehydrate: unconsumed marker ${JSON.stringify(line)}`);
  return out;
}
