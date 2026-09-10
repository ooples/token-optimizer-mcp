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
import { containsStructural } from './structural.js';
import { ranker } from './relevance.js';
import { DEFAULT_TUNING } from './options.js';
import type { CompressionResult, EngineContext } from './types.js';
import { spillFor, unchanged } from './types.js';

/** Below this a document is left alone; scoring noise dominates. */
const MIN_SENTENCES = 6;

/** Signals the sentence carries something a reader must act on. */
const CRITICAL =
  /\b(error|failed|failure|exception|traceback|panic|fatal|must|required|cannot|unable|denied|deprecated|breaking|warning|caution|note that|do not|never|always)\b/i;

/** Boilerplate that costs tokens and says nothing. */
const FILLER =
  /\b(as (?:we|you) (?:can see|mentioned|noted)|it (?:is|'s) (?:worth|important) (?:noting|to note)|in (?:other words|general|summary)|please note|generally speaking|of course|needless to say|that said|it should be noted|this (?:means|is to say) that)\b/i;

/** Hedges: a sentence made mostly of these is rarely load-bearing. */
const HEDGE =
  /\b(might|maybe|perhaps|possibly|arguably|somewhat|fairly|quite|rather|often|usually|typically|tends? to)\b/gi;

/** One sentence, and the whitespace that followed it in the original. */
interface Sentence {
  readonly text: string;
  /** What separated it from the next sentence: a space, or a paragraph break. */
  readonly after: string;
}

/**
 * Splits on sentence boundaries without mangling code spans or version numbers.
 *
 * THE SEPARATOR IS KEPT, because throwing it away flattened the document.
 * Joining the survivors with a single space turned a design note's paragraphs
 * into one wall of text -- a structural change nobody asked for, on top of the
 * sentence elision that was the actual job. Paragraph breaks carry meaning a
 * reader uses to navigate, and losing them is not compression.
 */
function sentences(text: string): Sentence[] {
  const parts = text.split(/(?<=[.!?])(\s+)(?=[A-Z(`"'\[])/);
  const out: Sentence[] = [];
  // The split keeps the separator, so the array alternates sentence, gap,
  // sentence, gap -- and the final sentence has no gap after it.
  for (let i = 0; i < parts.length; i += 2) {
    const body = (parts[i] ?? '').trim();
    if (!body) continue;
    out.push({ text: body, after: parts[i + 1] ?? '' });
  }
  return out;
}

/** A gap that crosses a blank line is a paragraph break; anything else is a space. */
function separator(gap: string): string {
  return /\n\s*\n/.test(gap) ? '\n\n' : ' ';
}

/**
 * Importance of one sentence, higher is more worth keeping.
 *
 * Every term is a claim about what a coding agent needs, and every one is
 * checkable against a fixture.
 */
export function score(sentence: string, index: number, total: number): number {
  let value = 0;

  // AN IDENTIFIER OUTRANKS EVERYTHING, because it is the one thing in a
  // passage that cannot be paraphrased, inferred or looked up again. A
  // sentence carrying a correlation id, a key or a commit hash is the
  // sentence a reader came for, and dropping it is unrecoverable in a way
  // that dropping an explanation is not.
  if (containsStructural(sentence)) value += 14;

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
  const tuning = ctx.tuning ?? DEFAULT_TUNING;
  // Prose elision is lossy by construction: a removed sentence cannot be
  // reconstructed from the ones that stayed. A lossless posture declines.
  if (!tuning.allowLossy) return unchanged(text);

  const parts = sentences(text);
  if (parts.length < MIN_SENTENCES) return unchanged(text);

  // RELEVANCE REORDERS, IT DOES NOT ENLARGE. The kept fraction is unchanged,
  // so this cannot flatter the reduction number: it decides WHICH half of a
  // passage survives when the agent has told us what it is looking for. The
  // weight is set below the CRITICAL term (10) and the identifier term (14)
  // deliberately -- a sentence naming an error or carrying a correlation id
  // outranks one that merely shares vocabulary with the question.
  const bodies = parts.map((part) => part.text);
  const rank = ranker(ctx.query);
  const relevant = rank.active
    ? rank.top(
        bodies,
        Math.max(1, Math.round(parts.length * tuning.keepSentenceFraction))
      )
    : new Set<number>();

  const ranked = parts.map((part, index) => ({
    sentence: part.text,
    index,
    value:
      score(part.text, index, parts.length) + (relevant.has(index) ? 6 : 0),
  }));

  const keepCount = Math.max(
    1,
    Math.round(parts.length * tuning.keepSentenceFraction)
  );
  const keep = new Set(
    [...ranked]
      .sort((a, b) => b.value - a.value || a.index - b.index)
      .slice(0, keepCount)
      .map((r) => r.index)
  );

  const dropped = parts.length - keep.size;
  if (dropped <= 0) return unchanged(text);

  // Prose has no file of its own and no lossless half to fall back on, so
  // without a spill there is nothing honest to do but leave it whole.
  const recoverAt = spillFor(ctx, text, 'prose.txt');
  if (!recoverAt) return unchanged(text);
  // REJOINED WITH THE ORIGINAL SEPARATORS. When a run of sentences is
  // dropped between two survivors, the widest gap in that run is the one
  // that stands: a paragraph break that had sentences either side of it is
  // still a paragraph break once they are gone. Flattening everything to a
  // single space turned a design note into one wall of text -- a structural
  // change nobody asked for, on top of the elision that was the actual job.
  const keptIndices = [...keep].sort((a, b) => a - b);
  let body = '';
  keptIndices.forEach((index, position) => {
    body += parts[index].text;
    if (position === keptIndices.length - 1) return;
    const next = keptIndices[position + 1];
    // Every gap between this survivor and the next, including the gaps
    // around the sentences being removed.
    const gaps = parts.slice(index, next).map((part) => separator(part.after));
    body += gaps.includes('\n\n') ? '\n\n' : ' ';
  });
  body += ` ${inlineMarker(
    `${count(dropped, 'lower-signal sentence')} removed`,
    recoverAt
  )}`;

  return {
    text: body,
    elisions: [
      {
        removed: count(dropped, 'lower-signal sentence'),
        recoverAt,
        lossless: false,
      },
    ],
    lossless: false,
  };
}
