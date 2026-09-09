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
import type { CompressionResult, Elision, EngineContext } from './types.js';
import { unchanged } from './types.js';

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
  return line.replace(TIMESTAMP, '').trimEnd();
}

/** Detects content worth treating as a log rather than prose. */
export function looksLikeLog(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length < 8) return false;
  let stamped = 0;
  let levelled = 0;
  for (const line of lines) {
    if (TIMESTAMP.test(line)) stamped += 1;
    if (/\b(DEBUG|INFO|WARN|WARNING|ERROR|TRACE|FATAL)\b/.test(line)) levelled += 1;
  }
  const signal = Math.max(stamped, levelled);
  return signal / lines.length > 0.3;
}

/**
 * Folds runs of identical lines into one line and a count.
 *
 * LOSSLESS BY CONSTRUCTION, which is the point. "the same line, 37 more times"
 * is not an approximation of the removed content -- it is a complete
 * description of it, and the model can reconstruct the original exactly without
 * asking anyone for anything. No spill, no path, no lookup.
 */
export function compressLog(text: string, _ctx: EngineContext = {}): CompressionResult {
  const lines = text.split('\n');
  if (lines.length < MIN_RUN) return unchanged(text);

  const out: string[] = [];
  const elisions: Elision[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const key = foldKey(line);

    // An empty key would fold every blank line in the file into one run.
    if (!key || LOAD_BEARING.test(line)) {
      out.push(line);
      i += 1;
      continue;
    }

    let run = 1;
    while (i + run < lines.length && foldKey(lines[i + run]) === key) run += 1;

    if (run >= MIN_RUN) {
      out.push(line);
      const dropped = run - 1;
      out.push(inlineMarker(`the same line, ${count(dropped, 'more time')}`, null));
      elisions.push({ removed: count(dropped, 'duplicate line'), recoverAt: null });
      i += run;
    } else {
      for (let k = 0; k < run; k += 1) out.push(lines[i + k]);
      i += run;
    }
  }

  const folded = foldScattered(out, elisions);

  if (!elisions.length) return unchanged(text);
  return { text: folded.join('\n'), elisions, lossless: true };
}

/**
 * Folds duplicates that are NOT adjacent.
 *
 * The run-folding above only sees repeats that happen to be consecutive, and
 * the proof gate showed what that misses: a busy build log interleaves its
 * repetition -- the same peer-dependency warning four hundred times, scattered
 * between other lines -- so consecutive-only folding compressed it by 0%.
 *
 * The first occurrence keeps its position, so the log still reads in order and
 * the reader still sees where the line first appeared. Later occurrences are
 * dropped and counted on that first line. Still lossless: the output states
 * the line and exactly how many times it occurred.
 *
 * Load-bearing lines are exempt here for the same reason as above, and it
 * matters more at this range: two identical AssertionErrors five hundred lines
 * apart are two failures, and a debugging agent needs both.
 */
function foldScattered(lines: string[], elisions: Elision[]): string[] {
  const seen = new Map<string, number>();
  const extra = new Map<number, number>();

  lines.forEach((line, index) => {
    if (!line.trim() || LOAD_BEARING.test(line)) return;
    // A marker this function or the run-folder already wrote.
    if (line.trimStart().startsWith('[... ')) return;
    const key = foldKey(line);
    if (!key) return;
    const first = seen.get(key);
    if (first === undefined) seen.set(key, index);
    else extra.set(first, (extra.get(first) ?? 0) + 1);
  });

  if (!extra.size) return lines;

  const drop = new Set<number>();
  lines.forEach((line, index) => {
    if (!line.trim() || LOAD_BEARING.test(line)) return;
    if (line.trimStart().startsWith('[... ')) return;
    const key = foldKey(line);
    if (!key) return;
    if (seen.get(key) !== index) drop.add(index);
  });

  const out: string[] = [];
  lines.forEach((line, index) => {
    if (drop.has(index)) return;
    out.push(line);
    const more = extra.get(index);
    if (more) {
      out.push(inlineMarker(`the same line, ${count(more, 'more time')} elsewhere`, null));
      elisions.push({ removed: count(more, 'duplicate line'), recoverAt: null });
    }
  });
  return out;
}
