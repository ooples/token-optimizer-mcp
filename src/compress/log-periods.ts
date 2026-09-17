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
      const block = lines.slice(at, at + period);
      if (block.some((line) => !line.trim() || protectedLine(line))) continue;
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
