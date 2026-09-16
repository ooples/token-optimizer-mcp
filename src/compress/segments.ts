/**
 * Fold exact repeated sections while retaining every distinct section.
 *
 * This preserves distinct facts but loses repetition order and separators.
 * Consequently it is lossy: a source path or spill is required, and the result
 * carries recovery metadata. Near-duplicates remain distinct.
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
const HEADING = /\n(?=#{1,6} )/;
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

function segment(text: string): string[] {
  const byHeading = text.split(HEADING);
  if (byHeading.length >= MIN_SEGMENTS) return byHeading;
  return text.split(PARAGRAPH);
}

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
  const parts = segment(text);
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
  const parts = segment(text);
  if (parts.length < MIN_SEGMENTS)
    return { text, elisions: [], lossless: true };

  const kept: string[] = [];
  const seen = new Set<string>();
  let folded = 0;
  for (const part of parts) {
    if (seen.has(part)) {
      folded += 1;
      continue;
    }
    seen.add(part);
    kept.push(part);
  }
  if (!folded) return { text, elisions: [], lossless: true };

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
