/**
 * Prose compression by deterministic importance scoring.
 *
 * NO MODEL, ON PURPOSE. Their equivalent engine, Kompress-base, is a
 * ModernBERT classifier -- and it is simultaneously their weakest engine by
 * their own figures (30-50%, against 70-92% for the structural ones) and the
 * source of a stated limitation: "Kompress-base adds RAM overhead on
 * memory-constrained machines". Their whole product also "requires local Python
 * runtime -- incompatible with restricted sandboxes".
 *
 * Buying their least effective engine at the price of their worst deployment
 * constraint is a bad trade. The one structural advantage we hold is that we
 * are Node, already present wherever all sixteen supported clients run, and a
 * transformer dependency would spend exactly that.
 *
 * So: score sentences on features that are cheap and legible. A deterministic
 * scorer is also TESTABLE in a way a learned one is not -- every decision here
 * can be pinned by a fixture, which matters for a component whose failure mode
 * is quietly discarding the sentence that mattered.
 *
 * IF IT UNDERPERFORMS THEIR BAND, IT REPORTS THAT. The benchmark prints the
 * real number for this engine; it does not get to claim theirs.
 */

import { count, inlineMarker } from './annotate.js';
import type { CompressionResult, EngineContext } from './types.js';
import { unchanged } from './types.js';

/** Below this a document is left alone; scoring noise dominates. */
const MIN_SENTENCES = 6;

/** Fraction of sentences kept. Tuned against the fixtures, not guessed. */
const KEEP_FRACTION = 0.5;

/** Signals the sentence carries something a reader must act on. */
const CRITICAL =
  /\b(error|failed|failure|exception|traceback|panic|fatal|must|required|cannot|unable|denied|deprecated|breaking|warning|caution|note that|do not|never|always)\b/i;

/** Boilerplate that costs tokens and says nothing. */
const FILLER =
  /\b(as (?:we|you) (?:can see|mentioned|noted)|it (?:is|'s) (?:worth|important) (?:noting|to note)|in (?:other words|general|summary)|please note|generally speaking|of course|needless to say|that said|it should be noted|this (?:means|is to say) that)\b/i;

/** Hedges: a sentence made mostly of these is rarely load-bearing. */
const HEDGE =
  /\b(might|maybe|perhaps|possibly|arguably|somewhat|fairly|quite|rather|often|usually|typically|tends? to)\b/gi;

/** Splits on sentence boundaries without mangling code spans or version numbers. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z(`"'\[])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Importance of one sentence, higher is more worth keeping.
 *
 * Every term is a claim about what a coding agent needs, and every one is
 * checkable against a fixture.
 */
export function score(sentence: string, index: number, total: number): number {
  let value = 0;

  // Something the reader must act on. Dominant term by design: a false
  // negative here deletes the point of the document.
  if (CRITICAL.test(sentence)) value += 10;

  // Concrete over abstract: paths, identifiers, numbers, quoted spans.
  if (/[\w-]+\.[a-z]{1,4}\b|\/|\\/.test(sentence)) value += 3;
  if (/`[^`]+`|"[^"]{3,}"/.test(sentence)) value += 2;
  if (/\d/.test(sentence)) value += 2;

  // Position: openings state the subject, closings state the conclusion.
  if (index === 0) value += 4;
  if (index === total - 1) value += 2;

  // Pure filler, and hedging density.
  if (FILLER.test(sentence)) value -= 6;
  const hedges = sentence.match(HEDGE)?.length ?? 0;
  const words = sentence.split(/\s+/).length || 1;
  value -= Math.min(4, (hedges / words) * 40);

  // Very long sentences with no concrete content are usually exposition.
  if (words > 40 && !/\d|`|\//.test(sentence)) value -= 2;

  return value;
}

/** Recognises prose rather than structured content. */
export function looksLikeProse(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return false;
  const wordy = lines.filter((l) => l.split(/\s+/).length > 8).length;
  return wordy / lines.length > 0.5;
}

/**
 * Keeps the highest-scoring half, in original order.
 *
 * LOSSY, and it says so. The marker names how many sentences went and, when a
 * spill is available, where the original is. A model reading "12 lower-signal
 * sentences" knows the shape of what it is missing, which is the difference
 * between compression and quiet damage.
 */
export function compressProse(
  text: string,
  ctx: EngineContext = {}
): CompressionResult {
  const parts = sentences(text);
  if (parts.length < MIN_SENTENCES) return unchanged(text);

  const ranked = parts.map((sentence, index) => ({
    sentence,
    index,
    value: score(sentence, index, parts.length),
  }));

  const keepCount = Math.max(1, Math.round(parts.length * KEEP_FRACTION));
  const keep = new Set(
    [...ranked]
      .sort((a, b) => b.value - a.value || a.index - b.index)
      .slice(0, keepCount)
      .map((r) => r.index)
  );

  const dropped = parts.length - keep.size;
  if (dropped <= 0) return unchanged(text);

  const recoverAt = ctx.spill ? ctx.spill(text, 'prose.txt') : null;
  const kept = ranked.filter((r) => keep.has(r.index)).map((r) => r.sentence);
  const body = `${kept.join(' ')} ${inlineMarker(
    `${count(dropped, 'lower-signal sentence')} removed`,
    recoverAt
  )}`;

  return {
    text: body,
    elisions: [{ removed: count(dropped, 'lower-signal sentence'), recoverAt }],
    lossless: false,
  };
}
