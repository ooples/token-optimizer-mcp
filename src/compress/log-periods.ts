import { inlineMarker } from './annotate.js';
import type { CompressionResult, Elision } from './types.js';

/** Exact repeated sequences preserve order, timestamps and whitespace inline. */
export function compressLogPeriods(
  text: string,
  protectedLine: (line: string) => boolean
): CompressionResult | null {
  const lines = text.split('\n');
  // Existing marker-looking input must not become ambiguous with our encoding.
  if (lines.some((line) => line.trimStart().startsWith('[... '))) return null;
  const out: string[] = [];
  const elisions: Elision[] = [];
  // MEMOISED PER LINE. protectedLine is a regex scan, and the loop below tries
  // eight periods at every position, so a line sits inside the candidate block
  // of all eight periods at up to eight positions -- up to 36 scans of the same
  // line. It is a pure test of one string, so one scan answers all of them.
  // Measured on raw-build-log it was the single hottest frame in the compressor.
  //
  // THE BLANK TEST IS MEMOISED WITH IT, for the same reason and one more: it is
  // `!line.trim()`, which allocates a whole trimmed copy of the line to ask a
  // question with a one-character answer. Both operands are a pure test of one
  // string and the caller only ever wants their disjunction, so caching the
  // disjunction keeps the short-circuit -- protectedLine still never sees a
  // blank line -- while running each side once per line rather than once per
  // (position, period) pair.
  const known = new Array<boolean | undefined>(lines.length);
  const unusable = (i: number): boolean => {
    const cached = known[i];
    if (cached !== undefined) return cached;
    const found = !lines[i].trim() || protectedLine(lines[i]);
    known[i] = found;
    return found;
  };
  let at = 0;
  while (at < lines.length) {
    let best:
      | { period: number; repeats: number; marker: string; saved: number }
      | undefined;
    for (
      let period = 1;
      period <= 8 && at + period * 3 <= lines.length;
      period++
    ) {
      // ONE NEW LINE PER PERIOD, AND BLOCKING IS FINAL. The candidate block for
      // period p is the block for p - 1 with one more line on the end, so the
      // lines before it were tested on the previous turn; and because each
      // block contains every shorter one, a line that blocks period p blocks
      // every longer period too. Re-testing the whole prefix each time turned
      // eight tests per position into thirty-six.
      if (unusable(at + period - 1)) break;
      // Read through `lines` rather than slicing a block out of it: a slice
      // per period is eight throwaway arrays per position, and the index it
      // would be read at is the same arithmetic either way.
      let end = at + period;
      while (
        end < lines.length &&
        lines[end] === lines[at + ((end - at) % period)]
      )
        end++;
      const repeats = Math.floor((end - at) / period);
      if (repeats < 3) continue;
      const marker = inlineMarker(
        `previous ${period} log lines repeat ${repeats - 1} more times, verbatim and in order`,
        null
      );
      // The block joined on newlines plus a trailing one: every line's length,
      // plus one separator each. Counted rather than built, for the same
      // reason the slice went.
      let span = period;
      for (let i = at; i < at + period; i += 1) span += lines[i].length;
      const saved = span * (repeats - 1) - marker.length - 1;
      if (saved > 0 && (!best || saved > best.saved))
        best = { period, repeats, marker, saved };
    }
    if (!best) {
      out.push(lines[at++]);
      continue;
    }
    out.push(...lines.slice(at, at + best.period), best.marker);
    elisions.push({
      removed: `${best.period * (best.repeats - 1)} repeated log lines`,
      recoverAt: null,
      lossless: true,
    });
    at += best.period * best.repeats;
  }
  return elisions.length
    ? { text: out.join('\n'), elisions, lossless: true }
    : null;
}
