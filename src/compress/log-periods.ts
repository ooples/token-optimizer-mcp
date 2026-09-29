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
  const known = new Array<boolean | undefined>(lines.length);
  const isProtected = (i: number): boolean => {
    const cached = known[i];
    if (cached !== undefined) return cached;
    const found = protectedLine(lines[i]);
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
      let blocked = false;
      for (let i = at; i < at + period; i += 1) {
        if (!lines[i].trim() || isProtected(i)) {
          blocked = true;
          break;
        }
      }
      // Sliced only once the block is known to be a candidate, so a rejected
      // period costs no array.
      if (blocked) continue;
      const block = lines.slice(at, at + period);
      let end = at + period;
      while (end < lines.length && lines[end] === block[(end - at) % period])
        end++;
      const repeats = Math.floor((end - at) / period);
      if (repeats < 3) continue;
      const marker = inlineMarker(
        `previous ${period} log lines repeat ${repeats - 1} more times, verbatim and in order`,
        null
      );
      const saved =
        (block.join('\n').length + 1) * (repeats - 1) - marker.length - 1;
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
