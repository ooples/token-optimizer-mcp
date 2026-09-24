/**
 * Log and build-output compression.
 *
 * Build logs, test runs and stack traces are the content a debugging loop reads
 * most and the content that repeats hardest. This is also the engine with the
 * best lossless story: a run of identical lines collapses to one line and a
 * count, and that is FULLY reconstructible from the output -- the reader knows
 * exactly what was there and exactly how many times.
 *
 * WHAT IS NEVER COLLAPSED. Lines carrying an error, a failure, an exception or
 * a non-zero exit survive individually even when they repeat. Two identical
 * `AssertionError` lines are two failures, and telling a debugging agent it saw
 * "2x AssertionError" when it needed to see both stack frames is exactly the
 * "inappropriate compression strategy [where] the model may not be able to
 * obtain key details" their own documentation warns about. The tokens saved by
 * folding an error are the tokens that mattered.
 */

import { count, inlineMarker } from './annotate.js';
import { compressLogPeriods } from './log-periods.js';
import { overlapsStructural, structuralRanges } from './structural.js';
import type { CompressionResult, Elision, EngineContext } from './types.js';
import { spillFor, unchanged } from './types.js';

/** A run shorter than this is left alone: the marker costs more than the lines. */
const MIN_RUN = 3;

/**
 * Lines that must never be folded, however often they repeat.
 *
 * Deliberately broad. A false positive costs a few tokens; a false negative
 * costs the model the one line it needed.
 */
const LOAD_BEARING =
  /\b(error|err|fail(ed|ure)?|exception|traceback|panic|fatal|assert(ion)?|exit code|refused|timeout|denied|cannot|unable)\b/i;

/** Volatile prefixes that make otherwise identical lines look distinct. */
const TIMESTAMP =
  /^\s*(?:\[\s*)?(?:\d{4}-\d{2}-\d{2}[T ])?\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?(?:\s*\])?\s*/;

/**
 * The key two lines are compared on.
 *
 * Timestamps are stripped before comparison so that a line repeating once a
 * second still folds -- otherwise the most repetitive logs in existence, the
 * ones with a clock on every line, would be the ones we could not touch.
 */
function foldKey(line: string): string {
  return line.replace(TIMESTAMP, '');
}

/** The timestamp that was stripped, or an empty string when there was none. */
function stampOf(line: string): string {
  return line.match(TIMESTAMP)?.[0] ?? '';
}

/**
 * A fold that lists its timestamps is only worth doing if it still pays.
 *
 * Listing is what makes the fold lossless, and it is not free: forty stamps
 * is a few hundred characters. It is still far less than forty whole log
 * lines, but the ratio has to be checked rather than assumed, because a run
 * of very short lines under long ISO timestamps can genuinely cost more to
 * annotate than to leave alone.
 */
const STAMP_BUDGET = 0.5;

/** Detects content worth treating as a log rather than prose. */
export function looksLikeLog(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length < 8) return false;
  let stamped = 0;
  let levelled = 0;
  for (const line of lines) {
    if (TIMESTAMP.test(line)) stamped += 1;
    if (/\b(DEBUG|INFO|WARN|WARNING|ERROR|TRACE|FATAL)\b/.test(line))
      levelled += 1;
  }
  const signal = Math.max(stamped, levelled);
  return signal / lines.length > 0.3;
}

/**
 * Whether the text is made of repeated records, whatever they are records OF.
 *
 * `looksLikeLog` recognises a log by its timestamps and its severity words,
 * which is one way for a block to be a pile of repeated records and not the
 * only one. A browser accessibility tree is the same thing without either --
 *
 *   node 0: role=listitem name="collect digest" focusable=false bounds=(597,141)
 *
 * -- and 701 such lines were reaching the router as `unknown`, compressing by
 * 0.0%, while the console log printed beside them in the same conversation was
 * claimed and folded by 41.4%. The engine could already do the work; nothing
 * asked it to.
 *
 * So the question is asked structurally: strip each line to its shape and see
 * whether a real share of the block collapses into a handful of them. That is
 * the same test `foldTemplates` applies to decide it has something to fold, so
 * a claim made here is one the compressor can honour.
 */
export function looksTemplated(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length < 8) return false;
  const shapes = new Map<string, number>();
  for (const line of lines) {
    if (!line.trim() || line.includes('#')) continue;
    const shape = shapeOf(line);
    // A line with nothing variable in it is not a record, it is a line.
    if (shape === line) continue;
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  }
  let templated = 0;
  for (const n of shapes.values()) if (n >= MIN_TEMPLATE) templated += n;
  return templated / lines.length > 0.3;
}

/**
 * Folds runs of identical lines into one line and a count.
 *
 * LOSSLESS BY CONSTRUCTION, which is the point. "the same line, 37 more times"
 * is not an approximation of the removed content -- it is a complete
 * description of it, and the model can reconstruct the original exactly without
 * asking anyone for anything. No spill, no path, no lookup.
 */
export function compressLog(
  text: string,
  ctx: EngineContext = {}
): CompressionResult {
  const lines = text.split('\n');
  if (
    lines.length < MIN_RUN ||
    lines.some(
      (line) =>
        line.trimStart().startsWith('[... ') ||
        /\[\d+ occurrences, positions=\[/.test(line)
    )
  )
    return unchanged(text);
  const periodic = compressLogPeriods(text, (line) => LOAD_BEARING.test(line));
  // Return directly: later grouping must not move the lines a repeat references.
  if (periodic) return periodic;

  const out: string[] = [];
  const elisions: Elision[] = [];
  let i = 0;

  // WHERE THE ORIGINAL LIVES WHEN LISTING IS TOO EXPENSIVE.
  //
  // A fold that lists its timestamps is lossless and usually cheap. Usually
  // is not always: a run of very short lines under long ISO timestamps can
  // cost more to annotate than to leave alone, and a build log is exactly
  // that shape. Refusing to fold in that case was correct but expensive --
  // it took the raw-build-log workload from 74.7% to 55.6%.
  //
  // So the third option is the one the rest of this package already uses:
  // fold anyway, say so honestly as a LOSSY elision, and name the path where
  // the whole block is. Resolved lazily, because a log with no such run must
  // not pay for a spill it never uses.
  let spilled: string | null | undefined;
  const spillPath = (): string | null => {
    if (spilled === undefined) spilled = spillFor(ctx, text, 'log.txt');
    return spilled;
  };

  while (i < lines.length) {
    const line = lines[i];
    const key = foldKey(line);

    // An empty key would fold every blank line in the file into one run.
    if (!key.trim() || LOAD_BEARING.test(line)) {
      out.push(line);
      i += 1;
      continue;
    }

    let run = 1;
    while (i + run < lines.length && foldKey(lines[i + run]) === key) run += 1;

    if (run >= MIN_RUN) {
      const dropped = run - 1;

      // THE TIMESTAMPS ARE PART OF THE CONTENT, and dropping them silently
      // was a real defect rather than a rounding error. `foldKey` strips the
      // clock so that a line repeating once a second still folds -- the whole
      // reason this engine beats a naive one on the most repetitive logs
      // there are. But the stripped stamps were then gone, unrecoverable, and
      // the result still claimed `lossless: true`. "The same line, 37 more
      // times" does not tell a reader WHEN, and on a log the when is often
      // the question.
      //
      // So the stamps are listed, and the fold stays genuinely lossless: a
      // reader can reconstruct every removed line exactly, because the line
      // is above and each stamp is named. Listing costs a fraction of what
      // the lines cost, and the fold is skipped outright when it would not.
      const removedLines = lines.slice(i + 1, i + run);
      const stamps = removedLines.map(stampOf);
      const varying = stamps.some((stamp) => stamp !== stampOf(line));
      const listed = varying
        ? ` with prefix replacements ${JSON.stringify({ firstPrefix: stampOf(line), copies: stamps })}`
        : '';
      const removedBytes = removedLines.reduce((n, l) => n + l.length + 1, 0);

      const tooDear = listed.length > removedBytes * STAMP_BUDGET;
      const where = tooDear ? spillPath() : null;

      if (tooDear && !where) {
        // Listing costs more than it saves and there is nowhere to put the
        // original. Leave the run whole rather than drop timestamps that
        // could never be recovered.
        for (let k = 0; k < run; k += 1) out.push(lines[i + k]);
        i += run;
        continue;
      }

      out.push(line);
      out.push(
        inlineMarker(
          `the same line, ${count(dropped, 'more time')}${tooDear ? '' : listed}`,
          where
        )
      );
      elisions.push({
        removed: count(dropped, 'duplicate line'),
        recoverAt: where,
        // Lossless when the timestamps are listed: every removed line is
        // fully determined by the line above plus its own stamp, and both
        // are in the output. Lossy when they were too expensive to list,
        // and then the spill is what makes the removal recoverable.
        lossless: !tooDear,
      });
      i += run;
    } else {
      for (let k = 0; k < run; k += 1) out.push(lines[i + k]);
      i += run;
    }
  }

  const folded = templated(foldScattered(out, elisions), elisions);

  if (!elisions.length) return unchanged(text);
  return {
    text: folded.join('\n'),
    elisions,
    lossless: elisions.every((elision) => elision.lossless),
  };
}

/**
 * Splits a line into its fixed shape and its varying values.
 *
 * A VARIABLE SPAN IS A WHOLE TOKEN, NEVER PART OF ONE. Substituting every
 * digit run turned
 *
 *   request 3f2a9c14-8b7d-4e56-9a01-ffedcba98765 authorised with sk-ant-...
 *
 * into
 *
 *   request #f#a#c#-#b#d-#e#-#a#-ffedcba# authorised with sk-ant-api#-QmFz...
 *
 * which is neither the original nor a placeholder -- still identifier-shaped
 * enough for a model to quote back or search for. A dropped value is visibly
 * missing; a shredded one is invisibly wrong.
 *
 * THE FIRST FIX WENT TOO FAR, and the benchmark said so. Refusing to touch
 * identifiers at all meant a log carrying one correlation id per line could
 * not be templated at all: the sre workload fell from 92.8% to 58.8% on
 * touchable content the moment the fixture carried realistic ids.
 *
 * The requirement was never "do not substitute an identifier" -- it was "do
 * not substitute PART of one". So a structural range is itself a variable
 * span: the whole id is replaced by one placeholder and recorded verbatim
 * among the values, which is lossless and compresses like anything else.
 */
function variableSpans(line: string): Array<[number, number]> {
  const protectedRanges = structuralRanges(line);
  const spans: Array<[number, number]> = protectedRanges.map(([a, b]) => [
    a,
    b,
  ]);

  VARIABLE.lastIndex = 0;
  for (let m = VARIABLE.exec(line); m; m = VARIABLE.exec(line)) {
    const start = m.index;
    const end = start + m[0].length;
    // Digits inside an identifier are already covered by its own span.
    if (overlapsStructural(protectedRanges, start, end)) continue;
    spans.push([start, end]);
  }

  return spans.sort((a, b) => a[0] - b[0]);
}

/** The line with every variable span replaced by a single placeholder. */
function shapeOf(line: string): string {
  let out = '';
  let cursor = 0;
  for (const [start, end] of variableSpans(line)) {
    if (start < cursor) continue;
    out += line.slice(cursor, start) + '#';
    cursor = end;
  }
  return out + line.slice(cursor);
}

/** The values that shape stands in for, in order and verbatim. */
function valuesOf(line: string): string[] {
  const values: string[] = [];
  let cursor = 0;
  for (const [start, end] of variableSpans(line)) {
    if (start < cursor) continue;
    values.push(line.slice(start, end));
    cursor = end;
  }
  return values;
}
/** Digits, hex ids and quoted values -- the parts that vary between two runs of one event. */
// NO WORD BOUNDARIES, deliberately. With `\b` this matched nothing useful:
// the digits in `src/mod1000.ts` sit between two word characters, so no two
// assertion errors ever shared a shape and the grouping found nothing to
// template. Measured: 0 templates over 108 near-identical ERROR lines.
//
// Bare hex runs are NOT matched -- only an explicit 0x prefix -- because an
// unanchored hex class happily eats the middle of ordinary identifiers.
// A QUOTED VALUE IS ONE TOKEN, and leaving it out made the comment above a lie
// about the code below it. Without it a browser accessibility tree --
//
//   node 0: role=listitem name="collect digest" focusable=false bounds=(597,141)
//
// shares no shape with the next line, because the name differs, so 701 lines of
// a rigid four-field record templated at 8.7% and 65,210 chars of the
// browser-session workload were left at full width by an engine whose whole job
// is folding repeated records.
const VARIABLE = /"[^"\n]*"|0x[0-9a-f]+|\d+(?:\.\d+)?/gi;

/**
 * A value, made safe to put between the inline delimiters.
 *
 * The rows of a template join on ' | ' and the values within a row on ' ', so a
 * value carrying either was previously grounds for abandoning the whole group
 * (see the guard below). A quoted name almost always carries a space, which
 * would have made the widening above buy nothing at all.
 *
 * Percent-encoding is chosen over quoting because it leaves every value that
 * does NOT contain a delimiter completely untouched: existing output stays
 * byte-identical, which matters when the provider is holding those bytes in a
 * cached prefix. `%` itself is encoded first so decoding is unambiguous.
 */
function encodeValue(value: string): string {
  return value
    .replace(/%/g, '%25')
    .replace(/ /g, '%20')
    .replace(/\t/g, '%09')
    .replace(/\|/g, '%7C');
}

/** Below this a template costs more than the lines it replaces. */
const MIN_TEMPLATE = 4;

/**
 * Collapses lines that differ only in their numbers.
 *
 * THE LINES THAT SURVIVE FOLDING ARE THE PROBLEM. Load-bearing lines are
 * exempt from duplicate folding on purpose -- two AssertionErrors are two
 * failures -- and measurement showed what that leaves behind: on the
 * sre-debugging workload 12,220 of the 14,500 surviving characters, 84% of the
 * output, were assertion errors identical except for their numbers:
 *
 *   ... ERROR AssertionError at src/mod1000.ts:200: expected 1000 to equal 1001
 *   ... ERROR AssertionError at src/mod1012.ts:212: expected 1012 to equal 1013
 *
 * Folding those away would destroy the information. Templating them does not:
 * the shape is stated once and every varying value is listed, so the reader
 * can still see that mod1012 failed and can still reconstruct each line
 * exactly. LOSSLESS, and it is the only way to compress content that must not
 * be deduplicated.
 *
 * The values are listed in full rather than summarised as a range, because
 * `expected 1000 to equal 1001` for a range would invent pairs that never
 * occurred.
 */
function templated(lines: string[], elisions: Elision[]): string[] {
  const groups = new Map<string, number[]>();

  lines.forEach((line, index) => {
    if (
      !line.trim() ||
      line.includes('#') ||
      line.trimStart().startsWith('[... ')
    )
      return;
    const shape = shapeOf(line);
    // A line with nothing variable in it is not a template, it is a line.
    if (shape === line) return;
    const bucket = groups.get(shape);
    if (bucket) bucket.push(index);
    else groups.set(shape, [index]);
  });

  const replaced = new Map<number, string>();
  const drop = new Set<number>();

  for (const [shape, members] of groups) {
    if (members.length < MIN_TEMPLATE) continue;

    // One row of values per occurrence, in the order they appeared.
    const valueRows = members.map((i) => valuesOf(lines[i]));
    // Values must not collide with the inline row/column delimiters. Encoding
    // handles a space, a tab and a bar; a newline cannot be encoded away
    // because it would still split the line, so such a group is still refused.
    if (valueRows.some((row) => row.some((value) => /[\r\n]/.test(value))))
      continue;
    const rows = valueRows.map((row) => row.map(encodeValue).join(' '));
    const rendered =
      `${shape}  [${count(members.length, 'occurrence')}, positions=${JSON.stringify(members.map((index) => index + 1))}; # = ` +
      `${rows.join(' | ')}]`;

    // Only if it actually pays. A template over long, highly variable lines
    // can be larger than the lines themselves.
    const was = members.reduce((n, i) => n + lines[i].length + 1, 0);
    if (rendered.length >= was) continue;

    replaced.set(members[0], rendered);
    for (const i of members.slice(1)) drop.add(i);
    elisions.push({
      removed: `${count(members.length - 1, 'line')} folded into a template`,
      recoverAt: null,
      lossless: true,
    });
  }

  if (!replaced.size) return lines;

  const out: string[] = [];
  lines.forEach((line, index) => {
    if (drop.has(index)) return;
    out.push(replaced.get(index) ?? line);
  });
  return out;
}

/**
 * Folds duplicates that are NOT adjacent.
 *
 * The run-folding above only sees repeats that happen to be consecutive, and
 * the proof gate showed what that misses: a busy build log interleaves its
 * repetition -- the same peer-dependency warning four hundred times, scattered
 * between other lines -- so consecutive-only folding compressed it by 0%.
 *
 * The first occurrence stays visible. Explicit sequence positions and raw
 * prefixes preserve the location of every removed copy, even when timestamps
 * are identical, out of order, absent, or carry different whitespace.
 *
 * Load-bearing lines are exempt here for the same reason as above, and it
 * matters more at this range: two identical AssertionErrors five hundred lines
 * apart are two failures, and a debugging agent needs both.
 */
function foldScattered(lines: string[], elisions: Elision[]): string[] {
  const groups = new Map<string, number[]>();
  lines.forEach((line, index) => {
    if (
      !line.trim() ||
      LOAD_BEARING.test(line) ||
      line.trimStart().startsWith('[... ')
    )
      return;
    const key = foldKey(line);
    if (!key) return;
    const members = groups.get(key);
    if (members) members.push(index);
    else groups.set(key, [index]);
  });
  const markers = new Map<number, string>();
  const drop = new Set<number>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const first = members[0];
    // Positions refer to the sequence entering this stage, not timestamps.
    // Restore templates, then scattered copies, then adjacent runs.
    const copies = members
      .slice(1)
      .map((index) => [index + 1, stampOf(lines[index])]);
    const annotation = inlineMarker(
      `the same line, ${count(copies.length, 'more time')} elsewhere; before scattered folding ${JSON.stringify({ firstPrefix: stampOf(lines[first]), copiesAtLines: copies })}`,
      null
    );
    const removedSize = members
      .slice(1)
      .reduce((size, index) => size + lines[index].length + 1, 0);
    if (annotation.length + 1 >= removedSize) continue;
    markers.set(first, annotation);
    for (const index of members.slice(1)) drop.add(index);
    elisions.push({
      removed: count(copies.length, 'duplicate line'),
      recoverAt: null,
      lossless: true,
    });
  }
  const out: string[] = [];
  lines.forEach((line, index) => {
    if (drop.has(index)) return;
    out.push(line);
    const marker = markers.get(index);
    if (marker) out.push(marker);
  });
  return out;
}
