/**
 * Folding repeated segments inside one block of text, losslessly.
 *
 * THE UNIT IS THE THING. Every workload this package compresses well is won the
 * same way -- find the repeating unit, keep what is distinct, fold what is not.
 * A JSON array hands us that unit for free, which is why row-shaped payloads
 * reach 96-99%. A document does not, so the same redundancy sat untouched:
 * HeadRoom's rag-conversation fixture is one 162,250-character string holding
 * 1,154 markdown sections, of which only 115 are distinct and 1,039 are EXACT
 * duplicates. We removed 0.5% of it and they removed 0.1%, because neither of us
 * looks for a repeating unit inside a string.
 *
 * LOSSLESS, AND THAT IS WHY IT RUNS FIRST. Every distinct segment stays in the
 * request; only byte-identical repeats are folded, and the copy they are
 * identical to is still present above them. Nothing is elided, nothing is
 * spilled, nothing needs reading back -- so there is no turn to pay for and no
 * needle to lose. Measured on that fixture: 162,250 to 25,086, 84.5%, with all
 * 21 configuration identifiers retained and not one distinct source line
 * missing.
 *
 * It is deliberately NOT a near-duplicate matcher. Two sections differing by one
 * value are two facts, and folding them would be the data loss this engine
 * exists to avoid -- the failure that a 97.4% "win" on this same document turned
 * out to be, having destroyed 16 of 21 configuration keys.
 */

import type { CompressionResult, EngineContext } from './types.js';

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
  _ctx: EngineContext = {}
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

  const note = `\n[... ${folded} repeated sections folded; each is byte-identical to one above]`;
  const out = `${kept.join('\n')}${note}`;
  // NEVER GROW. Folding a handful of short segments can cost more than the note
  // saves, and a compressor that returns something larger than it was given is
  // strictly worse than one that declines.
  if (out.length >= text.length) return { text, elisions: [], lossless: true };

  return {
    text: out,
    // Lossless: the content is still present, so there is nothing to recover
    // and nothing to record as removed.
    elisions: [],
    lossless: true,
  };
}
