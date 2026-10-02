import { expandLongRepeats } from './runs.js';
import {
  HEADING,
  SECTION_JOIN,
  decodeOrder,
  sectionOrderMarker,
} from './segments.js';
import { expandLog } from './expand-log.js';
import { assertStamp, stampPattern } from './annotate.js';
import { BACK_REFERENCE, ESCAPED_REFERENCE, PATH_ID_PREFIX } from './search.js';
import { findReferent, readBackReference } from './dedup.js';
import { readImageBackReference } from './images.js';
import type { Stamp } from './types.js';

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
/**
 * Reads a `; dict` clause: the closed set each listed slot indexes into.
 *
 * A member may itself contain ], so the list is not read as `up to the next
 * bracket``. The lookahead says where the NEXT entry starts, which lets the
 * lazy match grow past an interior bracket instead of stopping at one -- the
 * difference between decoding `["a]b"]` and throwing on it.
 */
function readDicts(clause: string | undefined): Map<number, string[]> {
  const dicts = new Map<number, string[]>();
  for (const part of (clause ?? '').matchAll(/(\d+)=(\[.*?\])(?= \d+=\[|$)/g))
    dicts.set(Number(part[1]), JSON.parse(part[2]) as string[]);
  return dicts;
}

/**
 * One slot of one row: the rule generates it, a dictionary names it, or the
 * row spelled it out. A dictionary index that names no member is a refusal,
 * not a hole -- the row said which member it was and the list does not have it,
 * so anything returned here would be invented.
 */
function slotValue(
  slot: number,
  raw: string | number | undefined,
  dicts: Map<number, string[]>
): string {
  const set = dicts.get(slot);
  if (set === undefined) return String(raw);
  const got = set[Number(raw)];
  if (got === undefined)
    throw new Error(`dict slot ${slot} has no member ${String(raw)}`);
  return got;
}

/**
 * FOUR HEADERS, ONE BODY. `compressRecords` writes the same rows under four
 * different prose headers -- a keyed map says `object map` and `entries` where
 * a list says `array records` and `records`, a partial group says `missing
 * records remain unknown`, and the short-header variant drops the sentence
 * entirely. This pattern matched only the list header, so an object map reached
 * `UNCONSUMED` and rehydrate threw `unconsumed marker "[JSON object map; ALL 40
 * entries preserved ..."`, losing the whole block rather than the rows it could
 * not state. The body is byte-identical across all four, so the alternation is
 * on the header alone and the capture groups stay where the handler expects.
 *
 * SPLIT IN TWO SO THE STAMP CAN GO IN THE MIDDLE, and left as literals either
 * side so every backslash in it is still single-escaped.
 * `stampPattern` refuses everything when handed no stamp, so an unkeyed call
 * reads none of these.
 */
const RECORDS_HEAD =
  /(?:\[All \d+ JSON records; join template strings and row\[integer\] verbatim\. Template: |\[JSON (?:array records; ALL \d+ records|object map; ALL \d+ entries) preserved(?:, \d+ encoded here)?\. Join template parts, replacing numeric slots with verbatim text fragments from each row\. Template: |\[JSON fragment records; missing records remain unknown\. Join template parts, replacing numeric slots with verbatim text fragments from each row\. Template: )(\[[^\n]+?\])(; slots ([^\]\n]+) count from 0)?(?:; dict (.+?))?/;
/** Between the stamped opener and the stamped closer. */
const RECORDS_BODY = /\]\n([\s\S]*?)\[\/JSON fragment records/;

function recordsPattern(stamp: Stamp): RegExp {
  const tag = stampPattern(stamp);
  return new RegExp(
    RECORDS_HEAD.source + tag + RECORDS_BODY.source + tag + /\]\n/.source,
    'g'
  );
}

export function expandJsonRecords(text: string, stamp: Stamp = null): string {
  assertStamp(stamp);
  return text.replace(
    recordsPattern(stamp),
    (
      _all,
      encoded: string,
      _clause,
      slots: string | undefined,
      dict: string | undefined,
      rows: string
    ) => {
      const template = JSON.parse(encoded) as (number | string)[];
      const dicts = readDicts(dict);
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
          const present = JSON.parse(row) as (string | number)[];
          // Slots carrying a rule were omitted from the row; the rest arrive in
          // order, so the two streams are interleaved by slot number.
          const slotCount =
            present.length + [...rules.keys()].filter((k) => k >= 0).length;
          const values: string[] = [];
          let next = 0;
          for (let slot = 0; slot < slotCount; slot += 1) {
            const rule = rules.get(slot);
            values.push(
              slotValue(
                slot,
                rule ? rule.first + rule.step * index : present[next++],
                dicts
              )
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
/** The TAP envelope, split either side of its stamp. */
const TAP_HEAD =
  /\[TAP (?:passing|failing) records: JSON rows \[name,id,ms\]; substitute into template ("[^\n]+")/;
const TAP_BODY = /\]\r?\n([\s\S]*?)\[\/TAP (?:passing|failing) records/;

function tapPattern(stamp: Stamp): RegExp {
  const tag = stampPattern(stamp);
  return new RegExp(
    TAP_HEAD.source + tag + TAP_BODY.source + tag + /\]\r?\n/.source,
    'g'
  );
}

export function expandTapRecords(text: string, stamp: Stamp = null): string {
  assertStamp(stamp);
  return text.replace(
    tapPattern(stamp),
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

// A minted id is the prefix followed by digits and nothing else.
const MINTED_PATH_ID = new RegExp(`^${PATH_ID_PREFIX}\\d+$`);
const SEARCH_PATH = `(?:[A-Za-z]:[\\\\/][^\\s:]*|[^\\s:]*[\\\\/][^\\s:]*|[^\\s:]+\\.[A-Za-z0-9]+|${PATH_ID_PREFIX}\\d+)`;

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
  //
  // A MINTED ID IS THE PREFIX AND DIGITS, NOTHING ELSE. Testing only the
  // prefix condemned every real path that begins with one: ripgrep inside
  // node_modules reports @babel/parser/lib/index.js and @types/node/fs.d.ts,
  // and when the encoder mints no path table the header carries that path
  // unchanged -- so a block round-tripped fine until a scoped package appeared
  // in the results, and then threw on a path that was never an id. The two
  // shapes cannot collide: a hit path has to carry a separator or an
  // extension, so it can never be the prefix followed only by digits.
  const resolve = (id: string): string => {
    if (!MINTED_PATH_ID.test(id)) return id;
    const path = paths.get(id);
    if (path === undefined)
      throw new Error(`rehydrate: hunk path ${id} is not in the path table`);
    return path;
  };
  // THE BODY LINES THE ENCODER NUMBERED, AND ONLY THOSE. A back-reference
  // names a line by its position among the body lines of hunks written
  // WITHOUT a declaration template -- the same set the encoder walked, in the
  // same order -- so neither side has to carry the numbering. A declaration
  // row is two tab-separated fields rather than content and was never
  // counted; counting it here would shift every ordinal after the first one.
  const literals = new Map<number, string>();
  let ordinal = 0;
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
      if (!template) {
        const reference = BACK_REFERENCE.exec(row.raw);
        if (reference) {
          // A REFERENCE FORWARD OR TO NOTHING IS A TRUNCATED BLOCK. Emitting
          // the marker as content would report a reconstruction carrying a
          // line the original never held.
          const referent = literals.get(Number(reference[1]));
          if (referent === undefined)
            throw new Error(
              `rehydrate: hunk line ${row.raw} references no earlier line`
            );
          content = referent;
        } else {
          // AN ESCAPED LINE IS CONTENT, and the content is the form with one
          // fewer `=`. Registering the escape instead would hand a later
          // reference the wrong line.
          const escaped = ESCAPED_REFERENCE.exec(row.raw);
          if (escaped) content = `[=${escaped[1]}]`;
          literals.set(ordinal, content);
        }
        ordinal += 1;
      }
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

/** One `rows` block header: the positions it fills, its rules, its template. */
const BY_POSITION_ROWS =
  /^\[rows at ([\d,]+)(?:; slots ((?:-?\d+=-?\d+\+-?\d+n ?)+)count from 0)?(?:; dict (.+?))?; Template: (\[[^\n]*)\]\n/;
/** One preserved record: its position, and how many characters it is. */
const BY_POSITION_RECORD = /^\[at (\d+); (\d+) chars\]\n/;

/**
 * Rebuilds a run whose records did not all share one shape.
 *
 * Each block states the positions it fills, so the rows of a class that was
 * scattered through the run go back to the indices they came from rather than
 * to wherever the block happened to sit. Nothing here searches for a delimiter:
 * a row line and a block header both start with a bracket, and a preserved
 * record can contain any line at all, so a `rows` block is read as exactly as
 * many lines as it lists positions and a `record` block as exactly as many
 * characters as it declares.
 *
 * Every refusal below is a refusal to guess. A position filled twice, a position
 * never filled, a block header that does not parse: each of them means the
 * output is not the input, and saying so is the only useful thing left to do.
 */
/** The by-position envelope, split either side of its stamp. */
const BY_POSITION_HEAD =
  /\[JSON (?:array records|object map) by position; [^\n]*/;
const BY_POSITION_BODY = /\]\n([\s\S]*?)\[\/JSON records by position/;

function byPositionPattern(stamp: Stamp): RegExp {
  const tag = stampPattern(stamp);
  return new RegExp(
    BY_POSITION_HEAD.source +
      tag +
      BY_POSITION_BODY.source +
      tag +
      /\]\n/.source,
    'g'
  );
}

export function expandJsonRecordsByPosition(
  text: string,
  stamp: Stamp = null
): string {
  assertStamp(stamp);
  return text.replace(byPositionPattern(stamp), (_all, body: string) => {
    const filled = new Map<number, string>();
    let rest = body;
    while (rest.length) {
      const rows = BY_POSITION_ROWS.exec(rest);
      if (rows) {
        const at = rows[1].split(',').map(Number);
        const rules = new Map<number, { first: number; step: number }>();
        for (const part of (rows[2] ?? '').split(' ').filter(Boolean)) {
          const m = /^(\d+)=(-?\d+)\+(-?\d+)n$/.exec(part);
          if (!m) throw new Error(`unreadable run clause ${part}`);
          rules.set(Number(m[1]), {
            first: Number(m[2]),
            step: Number(m[3]),
          });
        }
        // THE CAPTURE ALREADY ENDS AT THE TEMPLATE'S OWN BRACKET. The header's
        // closing bracket is the one the pattern consumes, so appending one
        // here fed `JSON.parse` a trailing `]` and it threw on the character
        // after a complete value -- which reads as a corrupt template rather
        // than as an off-by-one in the grammar.
        const dicts = readDicts(rows[3]);
        const template = JSON.parse(rows[4]) as (number | string)[];
        rest = rest.slice(rows[0].length);
        for (const [index, position] of at.entries()) {
          const cut = rest.indexOf('\n');
          if (cut < 0) throw new Error('rows block ended mid-row');
          const present = JSON.parse(rest.slice(0, cut)) as (string | number)[];
          rest = rest.slice(cut + 1);
          const values: string[] = [];
          let next = 0;
          for (let slot = 0; slot < present.length + rules.size; slot += 1) {
            const rule = rules.get(slot);
            values.push(
              slotValue(
                slot,
                rule ? rule.first + rule.step * index : present[next++],
                dicts
              )
            );
          }
          if (filled.has(position))
            throw new Error(`position ${position} stated twice`);
          filled.set(
            position,
            template
              .map((part) => (typeof part === 'number' ? values[part] : part))
              .join('')
          );
        }
        continue;
      }
      const one = BY_POSITION_RECORD.exec(rest);
      if (!one)
        throw new Error(
          `unreadable by-position block ${JSON.stringify(rest.slice(0, 40))}`
        );
      const position = Number(one[1]),
        length = Number(one[2]);
      rest = rest.slice(one[0].length);
      if (rest.length < length)
        throw new Error(`record at ${position} is shorter than ${length}`);
      if (filled.has(position))
        throw new Error(`position ${position} stated twice`);
      filled.set(position, rest.slice(0, length));
      rest = rest.slice(length);
    }
    let out = '';
    for (let position = 0; position < filled.size; position += 1) {
      const record = filled.get(position);
      if (record === undefined)
        throw new Error(`position ${position} was never stated`);
      out += record;
    }
    return out;
  });
}

/**
 * Markers this module must consume rather than pass through as text.
 *
 * ASKED OF THE STAMP, NOT OF THE SHAPE. A refusal is the right answer to one of
 * OUR envelopes a grammar above declined to read -- the rows under it are gone
 * and saying so beats returning the header as prose. Asked of a line the
 * CONTENT wrote, the same refusal denies the caller a whole block on the
 * strength of one planted line: measured at 7 of 12 cells refused and 160
 * carrier lines lost in `bench/compression/adversarial.mjs`.
 *
 * The stamp sits at the very end of every envelope line we emit, opener and
 * closer alike, so requiring it there costs nothing a real marker has.
 */
function unconsumed(stamp: Stamp): RegExp {
  return new RegExp(
    /^\s*\[\/?(?:JSON |All \d+ JSON |TAP )[^\n]*/.source +
      stampPattern(stamp) +
      /\]\s*$/.source
  );
}

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
/**
 * Rebuilds the sections the lossless branch of `foldRepeatedSegments` folded.
 *
 * The encoder kept one copy of each distinct section, joined them with the
 * single newline its cut consumed, and wrote where every section stood. So the
 * inverse is exact: re-cut on the same boundary, then read the order back.
 *
 * DECLINES RATHER THAN GUESSES. A vector that does not describe the sections
 * actually present is not something to repair -- rebuilding a document in the
 * wrong order would be silently wrong output, which is worse than a refusal.
 * Leaving the marker in place is the refusal: `rehydrate` below then throws on
 * it as an unconsumed marker instead of returning a plausible wrong answer.
 */
export function expandFoldedSections(
  text: string,
  stamp: Stamp = null
): string {
  const cut = text.lastIndexOf('\n[... ');
  if (cut === -1) return text;
  const marker = sectionOrderMarker(stamp).exec(text.slice(cut + 1));
  if (!marker) return text;

  const order = decodeOrder(marker[2]);
  if (!order) return text;
  const kept = text.slice(0, cut).split(HEADING);
  // The count the note states has to agree with the sections that are here and
  // with the vector's length; all three come from one encode, so a disagreement
  // means this marker does not belong to this text.
  if (order.length - kept.length !== Number(marker[1])) return text;
  if (order.some((i) => i < 0 || i >= kept.length)) return text;

  return order.map((i) => kept[i]).join(SECTION_JOIN);
}

/*
 * THE STAMP IS THE CALLER'S TO SUPPLY, and `compressBlock` returns it.
 *
 * Verification cannot come from the text: whatever this function could
 * recompute from the output, the author of the content in that output could
 * compute first -- they have this source and they write their line before we
 * compress it. So the only thing separating our markers from theirs is a value
 * they could not predict, and it has to arrive out of band.
 *
 * NULL IS NOT "ANY", IT IS "NONE". Handed no stamp this decoder honours no
 * marker, so every marker-shaped line is content and is returned verbatim.
 * That is the safe direction: the cost of being wrong that way is a line that
 * reads like a marker surviving into the output, against a whole block denied
 * and an attacker's path quoted back at the caller as ours.
 */
export function rehydrate(text: string, stamp: Stamp = null): string {
  assertStamp(stamp);
  // Long repeats first of all, because the fold is the LAST thing the encoder
  // does and inverting in the other order would hand each grammar a block with
  // a hole in it. Search next: its grammar is line-structural rather than
  // delimited, so it has to see the hunk bodies before any other grammar
  // rewrites a line inside one.
  const out = expandLog(
    expandTapRecords(
      expandJsonRecords(
        expandJsonRecordsByPosition(
          expandSearchHunks(
            expandLongRepeats(expandFoldedSections(text, stamp), stamp)
          ),
          stamp
        ),
        stamp
      ),
      stamp
    ),
    stamp
  );
  const leftover = unconsumed(stamp);
  for (const line of out.split('\n'))
    if (leftover.test(line) || UNCONSUMED_SUFFIX.test(line))
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
): (block: string, stamp?: Stamp) => string {
  const above: string[] = [];
  // EACH BLOCK'S OWN STAMP, aligned to `above` index for index. A stamp is
  // minted per `compressBlock` call and a sequence is many such calls, so there
  // is no one value for the whole walk: resolving a back-reference means
  // rebuilding a block the caller handed over EARLIER, with the stamp it came
  // with. Holding one stamp for the sequence would decode the referent against
  // the referrer's stamp and honour none of its markers.
  const stamps: Stamp[] = [];
  const byLabel = new Map<number, string>();
  // WHERE THE LAST REFERENCE LEFT THE READER, as an index into `above`. The run
  // form names its referent by order -- the block after that one -- so following
  // it means remembering where the walk had got to. A literal block puts it back
  // to nowhere, because the encoder only ever emits a run form directly after
  // another reference; a decoder that carried the position across a literal
  // would resolve something the encoder never wrote.
  let walkedTo = -1;

  return (block: string, stamp: Stamp = null): string => {
    assertStamp(stamp);
    const ordinal = readImageBackReference(block);
    if (ordinal !== null) {
      const data = images[ordinal - 1];
      if (data === undefined)
        throw new Error(`rehydrate: no image #${ordinal} above this block`);
      return data;
    }

    const reference = readBackReference(block);
    if (reference === null) {
      // KEPT AS IT ARRIVED, NOT AS IT REBUILT. A quote is computed over the
      // text that was EMITTED -- `quoteFor` separates the referent from the
      // other emitted blocks -- so matching it against a rebuilt original
      // would be comparing it with bytes the encoder never saw.
      //
      // AND RECORDED BEFORE IT IS REBUILT, which is not a tidy-up. A literal
      // whose content was moved to a spill path throws `PathAddressedError`
      // out of `rehydrate` -- by design, because the path IS the answer -- and
      // with the push sitting after that call, such a block silently never
      // joined `above`. Every later reference naming it then resolved to
      // nothing, so the decoder refused a reference the encoder had written
      // correctly. `above` is what a reader can SEE, not what this decoder
      // managed to expand: a block whose bytes are one path-follow away is
      // still a block the reader has been shown.
      above.push(block);
      stamps.push(stamp);
      walkedTo = -1;
      return rehydrate(block, stamp);
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
    // records a literal's position on the same first-wins rule. Taken once and
    // reused, because the same index names the referent's stamp.
    const at = reference.follows ? walkedTo + 1 : above.indexOf(referent);
    walkedTo = at;
    return rehydrate(referent, stamps[at] ?? null);
  };
}
