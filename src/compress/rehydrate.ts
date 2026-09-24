import { expandLongRepeats } from './runs.js';
import { expandLog } from './expand-log.js';
import { PATH_ID_PREFIX } from './search.js';
import { findReferent, readBackReference } from './dedup.js';
import { readImageBackReference } from './images.js';

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
 * A SUBSTRING ORACLE CANNOT DO THIS JOB. The records encoder states a repeated
 * row shape once, and for a column stepping by a constant it writes a rule
 * rather than the values -- so `r-0` is not a substring of the output at all,
 * it is `"r-"` in the template joined to slot 0 the rule produces. Asked
 * whether the output still contains the input, such an oracle reports healthy
 * compression as data loss.
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
          // Slots carrying a rule were omitted from the row; the rest arrive in
          // order, so the two streams are interleaved by slot number.
          const slotCount =
            present.length + [...rules.keys()].filter((k) => k >= 0).length;
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
/** `[paths @0=src/a.ts @1=src/b.ts ...]`, as `compressSearchResults` writes it. */
const PATH_TABLE = /^\[paths ((?:[^\s=]+=[^\s]+)(?: [^\s=]+=[^\s]+)*)\]$/;

const SEARCH_PATH =
  `(?:[A-Za-z]:[\\\\/][^\\s:]*|[^\\s:]*[\\\\/][^\\s:]*|[^\\s:]+\\.[A-Za-z0-9]+|${PATH_ID_PREFIX}\\d+)`;

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
  // EACH LINE CARRIES ITS OWN TERMINATOR, exactly as the engine now emits them.
  // Splitting on one guessed newline left a stray CR on every line of the other
  // kind, so a mixed-ending document's header was never matched and the decoder
  // reported it as an unconsumed marker -- the decoder failing, read as the
  // encoder failing.
  type Line = { raw: string; eol: string };
  const lines: Line[] = [];
  for (let i = 0; i < text.length; ) {
    let stop = i;
    while (stop < text.length && text[stop] !== '\n' && text[stop] !== '\r')
      stop += 1;
    const eol =
      stop >= text.length
        ? ''
        : text[stop] === '\r' && text[stop + 1] === '\n'
          ? '\r\n'
          : text[stop];
    lines.push({ raw: text.slice(i, stop), eol });
    i = stop + eol.length;
  }
  // THE PATH TABLE, IF THE ENCODER MINTED ONE. It is the first line or it is
  // absent; a block that never folded reads exactly as it did before.
  const paths = new Map<string, string>();
  const table = lines.length ? PATH_TABLE.exec(lines[0].raw) : null;
  if (table) {
    for (const entry of table[1].split(' ')) {
      const at = entry.indexOf('=');
      if (at < 1)
        throw new Error(`rehydrate: unreadable path table entry ${entry}`);
      paths.set(entry.slice(0, at), entry.slice(at + 1));
    }
    lines.shift();
  }
  // AN ID WITH NO TABLE ENTRY IS A TRUNCATED BLOCK, NOT A FILE NAMED `@3`.
  // Passing it through would put a path the reader cannot resolve into a
  // reconstruction that claims to be the original.
  const resolve = (id: string): string => {
    if (!id.startsWith(PATH_ID_PREFIX)) return id;
    const path = paths.get(id);
    if (path === undefined)
      throw new Error(`rehydrate: hunk path ${id} is not in the path table`);
    return path;
  };
  const out: Line[] = [];
  for (let cursor = 0; cursor < lines.length; cursor += 1) {
    const header = SEARCH_HEADER.exec(lines[cursor].raw);
    if (!header) {
      out.push(lines[cursor]);
      continue;
    }
    const [, id, first, last, marks, encoded] = header;
    const path = resolve(id);
    const start = Number(first);
    const end = Number(last);
    // A DESCENDING RANGE HAS TO FAIL, NOT HANG. `src/a.ts:3-1` gives a count
    // of -1, the short-body check below passes it because `0 < -1` is false,
    // and `cursor += count` walks back onto this same header for ever. A
    // helper that hangs takes the whole run with it; a helper that throws
    // names the bad input.
    if (end < start)
      throw new Error(
        `rehydrate: hunk ${path}:${start}-${end} has a descending range`
      );
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
      let content = row.raw;
      if (template) {
        const fields = row.raw.split('\t');
        if (fields.length !== 2)
          throw new Error(
            `rehydrate: declaration row is not two fields: ${row.raw}`
          );
        content =
          template[0] + fields[0] + template[1] + fields[1] + template[2];
      }
      // The body line's OWN terminator, not the header's: the header is
      // consumed and the line it restores must end as it originally did.
      out.push({
        raw: `${path}:${line}${matched.has(line) ? ':' : '-'}${content}`,
        eol: row.eol,
      });
    });
    cursor += count;
  }
  // A HUNK TOO SHORT FOR A HEADER KEEPS ITS OWN PREFIX ON EVERY LINE, and the
  // fold shortened those prefixes as well. They are not headers, so the loop
  // above passed them through untouched and they would reach the caller still
  // saying `@3:` -- a path no reader can resolve, inside output that claims to
  // be the original.
  return out
    .map((line) => {
      if (!paths.size) return line.raw + line.eol;
      const at = line.raw.indexOf(':');
      const id = at > 0 ? line.raw.slice(0, at) : '';
      const path = paths.get(id);
      return path === undefined
        ? line.raw + line.eol
        : path + line.raw.slice(at) + line.eol;
    })
    .join('');
}

/** Markers this module must consume rather than pass through as text. */
const UNCONSUMED = /^\s*\[\/?(?:JSON |All \d+ JSON |TAP )/;

/**
 * The search engine's markers sit at the END of a header line, not the start,
 * so the line-prefix refusal above cannot see them. A declaration note that
 * survived expansion means `expandSearchHunks` declined the header carrying
 * it -- a variant it does not invert -- and the body lines under it are still
 * missing their path and line number.
 *
 * Anchored to the header's own shape: the phrase is ordinary content anywhere
 * else, and `{"note":"[exact declaration rows: ...]"}` is a document this
 * helper has no business refusing.
 */
const UNCONSUMED_SUFFIX = new RegExp(
  `^(?:${SEARCH_PATH}):\\d+-\\d+.*\\[exact declaration rows:`
);

/**
 * Applies every registered grammar, then refuses anything left over.
 *
 * `expandLog` already refuses an unrecognised `[... ` envelope; this adds the
 * same refusal for the json marker families, which do not use that prefix and
 * would otherwise survive as ordinary-looking lines.
 */
export function rehydrate(text: string): string {
  // Long repeats first of all, because the fold is the LAST thing the encoder
  // does and inverting in the other order would hand each grammar a block with
  // a hole in it. Search next: its grammar is line-structural rather than
  // delimited, so it has to see the hunk bodies before any other grammar
  // rewrites a line inside one.
  const out = expandLog(
    expandTapRecords(
      expandJsonRecords(expandSearchHunks(expandLongRepeats(text)))
    )
  );
  for (const line of out.split('\n'))
    if (UNCONSUMED.test(line) || UNCONSUMED_SUFFIX.test(line))
      throw new Error(`rehydrate: unconsumed marker ${JSON.stringify(line)}`);
  return out;
}

/**
 * A rehydrator for a WHOLE payload: blocks handed over in the order a reader
 * meets them, each rebuilt with the ones above it in hand.
 *
 * `rehydrate` answers "rebuild this block from this block", which is the right
 * question for every engine that compresses a block in place. It is the wrong
 * question for a back-reference. `dedupBlocks` and `dedupImages` remove a
 * repeat and point at the copy still standing further up the SAME request, so
 * the content is in the output -- it is simply not in the fragment holding the
 * marker. Asked block by block the decoder refused, correctly and uselessly,
 * and three by-design references sat on a list of suspected data loss.
 *
 * STILL THE STRICT ORACLE. A marker naming nothing above, or naming two things,
 * throws. Resolving it to a guess would be the too-forgiving decoder this
 * module exists to avoid, and the guess would be silent.
 *
 * `images` is the one thing a text-only reader cannot work out for itself: an
 * image back-reference counts DISTINCT images, and telling an image block from
 * a text block needs the structure the payload was parsed from. The caller
 * passes their data in order of first appearance -- read off the output, where
 * the first copy of each one is still present.
 */
export function rehydrateSequence(
  images: readonly string[] = []
): (block: string) => string {
  const above: string[] = [];
  const byLabel = new Map<number, string>();
  // WHERE THE LAST REFERENCE LEFT THE READER, as an index into `above`. The run
  // form names its referent by order -- the block after that one -- so following
  // it means remembering where the walk had got to. A literal block puts it back
  // to nowhere, because the encoder only ever emits a run form directly after
  // another reference; a decoder that carried the position across a literal
  // would resolve something the encoder never wrote.
  let walkedTo = -1;

  return (block: string): string => {
    const ordinal = readImageBackReference(block);
    if (ordinal !== null) {
      const data = images[ordinal - 1];
      if (data === undefined)
        throw new Error(`rehydrate: no image #${ordinal} above this block`);
      return data;
    }

    const reference = readBackReference(block);
    if (reference === null) {
      const out = rehydrate(block);
      // KEPT AS IT ARRIVED, NOT AS IT REBUILT. A quote is computed over the
      // text that was EMITTED -- `quoteFor` separates the referent from the
      // other emitted blocks -- so matching it against a rebuilt original
      // would be comparing it with bytes the encoder never saw.
      above.push(block);
      walkedTo = -1;
      return out;
    }

    const referent = reference.follows
      ? // NOT `above[walkedTo + 1]` ON ITS OWN. With the walk at nowhere, that
        // index is zero, and a run form arriving with no reference before it
        // would quietly resolve to the FIRST block above instead of refusing --
        // the decoder vouching for a reconstruction it never made. Caught by
        // the test that breaks a walk with a literal and asks for a refusal.
        walkedTo < 0
        ? null
        : (above[walkedTo + 1] ?? null)
      : reference.needle === null
        ? reference.label === null
          ? null
          : (byLabel.get(reference.label) ?? null)
        : findReferent(reference.needle, above);
    if (referent === null)
      throw new Error(
        `rehydrate: back-reference names no single block above: ${JSON.stringify(block)}`
      );
    // The spelled-out form is the one that carries both a quote and a label,
    // so the cheap `as #n above` repeats after it resolve by label alone.
    if (reference.label !== null) byLabel.set(reference.label, referent);
    // Advance the walk, so a stretch of run forms steps one block at a time.
    // `indexOf` is the first copy, which is the one the encoder pointed at: it
    // records a literal's position on the same first-wins rule.
    walkedTo = reference.follows ? walkedTo + 1 : above.indexOf(referent);
    return rehydrate(referent);
  };
}
