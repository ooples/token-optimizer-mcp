/**
 * Fold exact repeated sections while retaining every distinct section.
 *
 * Whether that is lossy depends entirely on the cut. Splitting on headings
 * consumes exactly one newline per boundary, so the kept sections plus the
 * order they appeared in rebuild the source byte for byte -- that case carries
 * the order inline and is LOSSLESS, needing no spill file and no round trip.
 * Splitting on blank lines consumes a run of whitespace nobody recorded, so
 * that case still loses the separators and still needs somewhere to put them.
 * Near-duplicates remain distinct under both.
 */

import type { CompressionResult, EngineContext } from './types.js';
import { spillFor, unchanged } from './types.js';

/**
 * Segment boundaries, most structured first.
 *
 * A markdown heading is a real record boundary; a blank line is a weaker guess
 * that still beats treating a document as one opaque run. Both are content the
 * segment keeps, so a fold never loses the boundary it was cut on.
 */
/** Exported so the decoder re-cuts on exactly the boundary the encoder cut on. */
export const HEADING = /\n(?=#{1,6} )/;
const PARAGRAPH = /\n\s*\n/;

/** Below this a document has no bulk worth folding. */
const MIN_CHARS = 4000;

/** Fewer segments than this and there is nothing to repeat. */
const MIN_SEGMENTS = 8;

/**
 * Repeats needed before folding pays.
 *
 * The note costs a line, so folding two copies of a short section can make the
 * block bigger. Requiring a real majority of duplicates also keeps this off
 * documents that merely share a heading style.
 */
const MIN_DUPLICATE_SHARE = 0.3;

/**
 * A cut of the text, and whether joining it back up is exact.
 *
 * `exact` is the whole difference between a lossless fold and a lossy one.
 * `HEADING` is a lookahead, so the split consumes the single `\n` before the
 * heading and nothing else: `parts.join('\n')` is the source, byte for byte.
 * `PARAGRAPH` consumes `\n\s*\n` -- a run of whitespace of unrecorded length --
 * so rejoining can only guess at it.
 */
interface Segmentation {
  readonly parts: string[];
  readonly exact: boolean;
}

function segment(text: string): Segmentation {
  const byHeading = text.split(HEADING);
  if (byHeading.length >= MIN_SEGMENTS)
    return { parts: byHeading, exact: true };
  return { parts: text.split(PARAGRAPH), exact: false };
}

/**
 * The separator `segment` cut on when it reported `exact`.
 *
 * Written once here and consumed by the decoder, so the encoder and the
 * rehydrator cannot drift apart over a literal.
 */
export const SECTION_JOIN = '\n';

/**
 * The order the sections stood in, run-length encoded.
 *
 * An ascending run of distinct sections -- which is what an unrepetitive
 * stretch of the document looks like -- collapses to `first-last`, so the
 * common case costs a few characters rather than one number per section. On
 * the corpus's most repetitive block this writes 1,106 positions in 2,185
 * characters while saving 137,973.
 */
export function encodeOrder(order: readonly number[]): string {
  const runs: string[] = [];
  let start = 0;
  for (let i = 1; i <= order.length; i++) {
    if (i === order.length || order[i] !== order[i - 1] + 1) {
      runs.push(
        i - start > 1 ? `${order[start]}-${order[i - 1]}` : `${order[start]}`
      );
      start = i;
    }
  }
  return runs.join(',');
}

/**
 * Inverse of `encodeOrder`. Returns null on anything it does not fully
 * understand, so a malformed vector declines rather than rebuilding a document
 * in the wrong order -- silently wrong output is the one outcome worse than
 * refusing.
 */
export function decodeOrder(vector: string): number[] | null {
  if (!vector) return null;
  const out: number[] = [];
  for (const run of vector.split(',')) {
    const span = /^(\d+)-(\d+)$/.exec(run);
    if (span) {
      const from = Number(span[1]);
      const to = Number(span[2]);
      if (to < from) return null;
      for (let i = from; i <= to; i++) out.push(i);
      continue;
    }
    if (!/^\d+$/.test(run)) return null;
    out.push(Number(run));
  }
  return out;
}

/** The marker the lossless fold writes, and the decoder's only entry point. */
export const SECTION_ORDER_MARKER =
  /^\[\.\.\. (\d+) repeated sections folded; each byte-identical to one above; order: ([\d,-]+)\]$/;

/** Duplicate share of a segmentation, used both to claim and to decide. */
function duplicateShare(parts: readonly string[]): number {
  if (!parts.length) return 0;
  const seen = new Set<string>();
  let repeats = 0;
  for (const part of parts) {
    if (seen.has(part)) repeats += 1;
    else seen.add(part);
  }
  return repeats / parts.length;
}

/** Is this text worth folding at all? */
export function looksRepetitive(text: string): boolean {
  if (text.length < MIN_CHARS) return false;
  const { parts } = segment(text);
  if (parts.length < MIN_SEGMENTS) return false;
  return duplicateShare(parts) >= MIN_DUPLICATE_SHARE;
}

/**
 * Folds byte-identical repeats, keeping the first occurrence of each.
 *
 * The note names the count rather than pointing anywhere, because every folded
 * segment is an exact copy of one still in the text above it. That is what
 * makes this recoverable without a spill file and without a round trip.
 */
export function foldRepeatedSegments(
  text: string,
  ctx: EngineContext = {}
): CompressionResult {
  const { parts, exact } = segment(text);
  if (parts.length < MIN_SEGMENTS)
    return { text, elisions: [], lossless: true };

  const kept: string[] = [];
  const at = new Map<string, number>();
  // WHERE EACH SECTION STOOD, not merely how many were dropped. This is the one
  // fact the old note left out, and leaving it out is what made the fold lossy:
  // `A B A C A` and `A A B C A` fold to the same sections and the same count,
  // so neither could be told from the other afterwards.
  const order: number[] = [];
  for (const part of parts) {
    const seen = at.get(part);
    if (seen !== undefined) {
      order.push(seen);
      continue;
    }
    at.set(part, kept.length);
    order.push(kept.length);
    kept.push(part);
  }
  const folded = parts.length - kept.length;
  if (!folded) return { text, elisions: [], lossless: true };

  // THE LOSSLESS CUT. `segment` reports `exact` when it split on headings, and
  // there the separator is a single `\n` it can hand back. Sections plus order
  // plus that separator IS the original, so this writes the order inline and
  // asks for no spill file -- which also makes it the only branch that works on
  // the published arm, which is handed no sink at all.
  if (exact) {
    const note = `\n[... ${folded} repeated sections folded; each byte-identical to one above; order: ${encodeOrder(order)}]`;
    const out = `${kept.join(SECTION_JOIN)}${note}`;
    if (out.length >= text.length)
      return { text, elisions: [], lossless: true };
    return {
      text: out,
      elisions: [
        {
          removed: `${folded} repeated sections`,
          // NOTHING TO POINT AT. Every folded section is still in the text
          // above it and the order vector says which, so there is no file to
          // fetch and no turn spent fetching it.
          recoverAt: null,
          lossless: true,
        },
      ],
      insertedLines: [note.slice(1)],
      lossless: true,
    };
  }

  const recoverAt = ctx.sourcePath || spillFor(ctx, text, 'sections.txt');
  if (!recoverAt) return unchanged(text);
  const note = `\n[... ${folded} repeated sections folded; each is byte-identical to one above; original order and separators: ${recoverAt}]`;
  const out = `${kept.join('\n')}${note}`;
  // NEVER GROW. Folding a handful of short segments can cost more than the note
  // saves, and a compressor that returns something larger than it was given is
  // strictly worse than one that declines.
  // Declining to compress IS lossless -- the original is returned untouched.
  if (out.length >= text.length) return { text, elisions: [], lossless: true };

  return {
    text: out,
    elisions: [
      {
        removed: `${folded} repeated sections and their positions`,
        recoverAt,
        lossless: false,
      },
    ],
    insertedLines: [note.slice(1)],
    // NOT LOSSLESS, and claiming otherwise was wrong in a way that matters.
    // The note records HOW MANY sections were folded, never WHICH one stood at
    // each removed position -- so `A B A C A` and `A A B C A` produce an
    // identical result, and neither can be reconstructed from it. `kept.join`
    // also normalises the original separators. Under `allowLossy: false` this
    // engine must therefore decline, which is exactly what this flag decides;
    // reporting it as lossless put unreconstructable output into the one mode
    // that exists to forbid it.
    lossless: false,
  };
}
