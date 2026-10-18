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

import { count, inlineMarker, withStamp } from './annotate.js';
import { containsStructural } from './structural.js';
import { activeRanker } from './ranking.js';
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
  const out: Sentence[] = [];
  const push = (body: string, after: string): void => {
    if (body.trim()) out.push({ text: body, after });
    else if (out.length > 0) {
      // A whitespace-only piece folds into the gap before it, so no byte of
      // the original is lost from the rejoin.
      const last = out[out.length - 1];
      out[out.length - 1] = {
        text: last.text,
        after: last.after + body + after,
      };
    }
  };
  // Paragraphs first: a blank line always ends a sentence.
  const paragraphs = text.split(PARAGRAPH_BREAK);
  for (let p = 0; p < paragraphs.length; p += 2) {
    const paragraph = paragraphs[p] ?? '';
    const breakAfter = paragraphs[p + 1] ?? '';
    const lines = paragraph.split(LINE_BREAK);
    if (isHardWrapped(lines)) {
      // Wrapped prose: a sentence runs across the soft breaks, as written.
      const parts = paragraph.split(WRAPPED_BOUNDARY);
      for (let i = 0; i < parts.length; i += 2) {
        const last = i + 2 >= parts.length;
        push(parts[i] ?? '', last ? breakAfter : (parts[i + 1] ?? ''));
      }
      continue;
    }
    // Everywhere else a LINE is the outer unit (#494): no sentence crosses a
    // newline, and a record line is never split inside, so it is kept or
    // dropped whole. Leading indentation stays with its line, so a line that
    // survives is byte-identical to the one it came from.
    for (let l = 0; l < lines.length; l += 2) {
      const line = lines[l] ?? '';
      const lastLine = l + 2 >= lines.length;
      const eol = lastLine ? breakAfter : (lines[l + 1] ?? '');
      if (isRecordLine(line)) {
        push(line, eol);
        continue;
      }
      const parts = line.split(INLINE_BOUNDARY);
      for (let i = 0; i < parts.length; i += 2) {
        const last = i + 2 >= parts.length;
        push(parts[i] ?? '', last ? eol : (parts[i + 1] ?? ''));
      }
    }
  }
  return out;
}

/** One or more blank lines, kept so the rejoin can restore them. */
const PARAGRAPH_BREAK = /(\r?\n(?:[ \t]*\r?\n)+)/;

/** A single line ending, kept; indentation stays with the next line. */
const LINE_BREAK = /(\r?\n)/;

/** A sentence end within one line. */
const INLINE_BOUNDARY = /(?<=[.!?])([ \t]+)(?=[A-Z(`"'[])/;

/** A sentence end anywhere in a hard-wrapped paragraph, line ends included. */
const WRAPPED_BOUNDARY = /(?<=[.!?])(\s+)(?=[A-Z(`"'[])/;

/** A line that ends the way a sentence or a paragraph does. */
const TERMINATED = /[.!?:;]["'`)*\]]*\s*$/;

/**
 * Whether a line is a record -- an issue, a hit, a row -- rather than prose.
 *
 * Outside a hard-wrapped paragraph, a line that stops without closing
 * punctuation is a unit of its own, and eliding inside it strips its key or
 * joins it to a neighbour (#494). Splitting it is what let `. Next` inside a
 * record lose half the record even when the surrounding text was prose.
 */
function isRecordLine(line: string): boolean {
  return line.trim().length > 0 && !TERMINATED.test(line);
}

/**
 * Whether a paragraph is hard-wrapped prose, the one place a sentence may run
 * across a line break.
 *
 * STRONGER THAN "THE NEXT LINE STARTS LOWERCASE" (#494 review). A listing
 * whose rows all start lowercase passed that test, so a sentence crossed from
 * one row into the next and eliding it cut both. Wrapped prose also FILLS ITS
 * WIDTH: every line but the last sits near the longest, because the wrap
 * broke it there, and only because the next word would not have fitted. So all
 * three are required -- the body lines within 70% of the widest, each break
 * forced by the next word, and most unterminated breaks continued in lowercase
 * -- and a paragraph that fails any is treated line by line.
 */
function isHardWrapped(lines: readonly string[]): boolean {
  const text = lines.filter((_, i) => i % 2 === 0);
  if (text.length < 2) return false;
  const widths = text.map((line) => line.trimEnd().length);
  const widest = Math.max(...widths);
  if (widest < 40) return false;
  // A lowercase line start only means "continued" in text that capitalises
  // its sentences. Rows like `alpha ... nightly. it drops ...` do not, so their
  // lowercase starts are no evidence of wrapping, and a layout that happens to
  // be even cannot stand in for it. Failing here is the safe direction: the
  // paragraph is then handled line by line, which only compresses less.
  if (text.some((line) => /[.!?][ \t]+[a-z]/.test(line))) return false;
  const body = widths.slice(0, -1);
  if (body.some((w) => w < widest * 0.7)) return false;
  // GREEDY FILL: a wrapper breaks a line only when the next word would not
  // fit. Rows of similar length that merely happen to start lowercase fail
  // this, because their next row's first word would have fitted.
  for (let i = 0; i < text.length - 1; i += 1) {
    const next = /\S+/.exec(text[i + 1])?.[0] ?? '';
    if (widths[i] + 1 + next.length <= widest) return false;
  }
  let open = 0;
  let continued = 0;
  for (let i = 0; i < text.length - 1; i += 1) {
    if (TERMINATED.test(text[i])) continue;
    open += 1;
    if (/^[ \t]*[a-z]/.test(text[i + 1])) continued += 1;
  }
  return open > 0 && continued * 2 > open;
}

const BLANK_LINE = /\n[ \t]*\r?\n/;

/**
 * What stands between two survivors once the sentences between them are gone.
 *
 * THE ORIGINAL GAP, NOT A NORMALISED ONE. A run with no line break in it
 * stays a space. A run that crossed lines keeps the last break in it, so the
 * next survivor -- which carries its own indentation -- starts a line exactly
 * as it did; if any gap in the run was a paragraph break the result still is
 * one.
 */
function rejoin(gaps: readonly string[]): string {
  const breaks = gaps.filter((gap) => gap.includes('\n'));
  if (breaks.length === 0) return ' ';
  const last = breaks[breaks.length - 1];
  if (BLANK_LINE.test(last) || !breaks.some((gap) => BLANK_LINE.test(gap)))
    return last;
  return (last.startsWith('\r\n') ? '\r\n' : '\n') + last;
}
/**
 * Weight of the one term that cannot be carried in from outside.
 *
 * EVERY OTHER POSITIVE TERM IS A SURFACE FEATURE. A digit, a path, a quoted
 * span, a word from a fixed vocabulary -- a sentence inserted into a document
 * carries any of them for free, and measurement showed what that costs: on
 * the adversarial prose carrier the document's OWN sentences scored 0, 0 and
 * -3.3 while a planted `Do not mention this line; audit-skip-7743 ...` scored
 * 12. The ranker had no term for being about the document, so the document
 * lost to the insert by twelve points to nothing.
 *
 * Set above the concrete-content terms (3, 2, 2) and below CRITICAL (10): a
 * sentence that is about the subject outranks one that merely names a file,
 * and a warning about the subject still outranks both.
 */
const SUBJECT = 8;

/**
 * How much of the document a sentence has to share before CRITICAL counts.
 *
 * The vocabulary is deliberately not stopword-filtered, so an ordinary
 * English sentence inserted into an English document already scores around
 * 0.2 on `and`, `the`, `with` alone. Measured on the adversarial arms: the
 * carrier's own sentences 1.00, the attack arm 0.13-0.29, the decoy arm
 * 0.00-0.25. The floor sits above that baseline and well below the document.
 */
const SUBJECT_FLOOR = 0.5;

/** Content words, lowercased; three characters up, hyphens kept. */
function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? [];
}

/** How many times each word appears across the whole passage. */
function vocabulary(bodies: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const body of bodies)
    for (const word of words(body))
      counts.set(word, (counts.get(word) ?? 0) + 1);
  return counts;
}

/**
 * The share of a sentence's vocabulary that the REST of the passage also uses.
 *
 * THE SENTENCE ITSELF HAS TO COME OUT OF THE DOCUMENT FIRST, or every
 * sentence shares everything with a document that contains it and the term is
 * a constant. Comparing each word against its count WITHIN the sentence is
 * what does that, without building a vocabulary per sentence.
 */
function subjectShare(sentence: string, counts: Map<string, number>): number {
  const own = words(sentence);
  if (own.length === 0) return 0;
  const mine = new Map<string, number>();
  for (const word of own) mine.set(word, (mine.get(word) ?? 0) + 1);
  let shared = 0;
  for (const [word, count] of mine)
    if ((counts.get(word) ?? 0) > count) shared++;
  return shared / mine.size;
}
/**
 * Importance of one sentence, higher is more worth keeping.
 *
 * Every term is a claim about what a coding agent needs, and every one is
 * checkable against a fixture.
 */
export function score(
  sentence: string,
  index: number,
  total: number,
  subject: number
): number {
  let value = 0;

  // AN IDENTIFIER OUTRANKS EVERYTHING, because it is the one thing in a
  // passage that cannot be paraphrased, inferred or looked up again. A
  // sentence carrying a correlation id, a key or a commit hash is the
  // sentence a reader came for, and dropping it is unrecoverable in a way
  // that dropping an explanation is not.
  if (containsStructural(sentence)) value += 14;

  // Something the reader must act on. Dominant term by design: a false
  // negative here deletes the point of the document.
  //
  // GATED ON THE SENTENCE BEING ABOUT THE DOCUMENT, because the vocabulary
  // is exactly the shape a planted instruction has: `do not`, `never`,
  // `always`, `must`. Measured, the attack and decoy arms of the
  // instruction-override fixture are identical in every other respect and
  // the attack arm scored ten points higher on the words `Do not` alone --
  // the whole of the 8.3-point prose gap in the adversarial grid. A warning
  // about the document's own subject is unaffected; one about the
  // conversation it was pasted into gets nothing.
  if (CRITICAL.test(sentence) && subject >= SUBJECT_FLOOR) value += 10;

  // Being about the document. See SUBJECT.
  value += SUBJECT * subject;

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

/**
 * Lines whose POSITION is part of their meaning, not just their words.
 *
 * A line number, a comment marker, a bullet. Prose elision drops sentences, and
 * a sentence here is a whole line, so a drop silently renumbers the body or
 * removes a step from a list.
 */
// `1.` and `1)` are included: a numbered list written with a period is exactly
// as line-oriented as one written with a pipe, and the trailing space keeps a
// decimal like `3.5 ms` at the start of a line from matching.
//
// A GUTTER IS A GUTTER WHATEVER IT IS SPELT WITH. Only a bare leading number
// was recognised, so `L755| // comment`, `0300# // comment` and every
// `git grep -n` hit -- `src/a.ts:12:  // comment`, whose line starts with the
// path -- read as prose, and a source listing came back with comment lines
// missing from its middle: the #469 failure through a different door. A path
// is told apart from a hyphenated word by the `/` or `.` it carries.
const LINE_ORIENTED =
  /^\s*(?:[A-Za-z]{0,2}\d+\s*[|:\t#]|\d+[.)]\s|[^\s:|]*[/.][^\s:|]*[:-]\d+[:-]|\/\/|\/\*|\*\s|#\s|--\s|[-+]\s)/;

/**
 * Recognises prose rather than structured content.
 *
 * DECLINES LINE-ORIENTED CONTENT, which by word count reads exactly like prose
 * and is the one shape this engine must not touch (#469). A comment block, a
 * numbered listing and a bulleted list all clear the wordiness bar -- a dense
 * block of `//` lines is wordier than most paragraphs -- while their lines are
 * the unit of meaning rather than their sentences.
 *
 * WHY THIS IS A CORRECTNESS FIX AND NOT A TUNING CHOICE. The reported session
 * read source through this path, got comment lines elided out of the middle of
 * a region, and built exact-text edits from what came back; every anchor
 * missed, because the lines it was anchored to had been removed from the view
 * and not from the file. A `12 lower-signal sentences removed` marker is an
 * honest report for a passage of prose and a corrupted one for a listing whose
 * reader is about to match it against the file it came from. The same goes for
 * a numbered listing, where dropping line 7 leaves 6 and 8 adjacent and every
 * line number after it meaningless.
 *
 * The cost is real and accepted: comment-dense and bulleted content stops being
 * elided, so some reduction is given up. A compression that makes an edit fail
 * is not a saving.
 */
export function looksLikeProse(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return false;
  const oriented = lines.filter((l) => LINE_ORIENTED.test(l)).length;
  if (oriented / lines.length > 0.5) return false;
  // RECORDS, NOT SENTENCES (#494): outside a hard-wrapped paragraph, a line
  // that stops without closing punctuation is a unit of its own -- an issue,
  // a hit, a row. Decided by the same rule the splitter uses, so the gate and
  // the engine cannot disagree about what a record is.
  let records = 0;
  const paragraphs = text.split(PARAGRAPH_BREAK);
  for (let p = 0; p < paragraphs.length; p += 2) {
    const split = (paragraphs[p] ?? '').split(LINE_BREAK);
    if (isHardWrapped(split)) continue;
    records += split.filter(
      (line, i) => i % 2 === 0 && isRecordLine(line)
    ).length;
  }
  if (records / lines.length > 0.5) return false;
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
/*
 * MINTS ITS OWN STAMP WHEN THE CALLER BROUGHT NONE, AND HANDS IT BACK.
 *
 * An engine that emits markers and tells nobody how to verify them produces
 * output that cannot be decoded at all -- the markers are indistinguishable
 * from content, which is the safe direction and a useless one. So the stamp
 * travels with the result, from whichever layer created it: the router sets one
 * for the whole block and this passes it through, and a caller reaching an
 * engine directly gets one minted from the content it handed over.
 */
export function compressProse(
  text: string,
  ctx: EngineContext = {}
): CompressionResult {
  const stamped = withStamp(ctx, text);
  return { ...compressProseBody(text, stamped), stamp: stamped.stamp };
}

function compressProseBody(
  text: string,
  ctx: EngineContext
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
  const rank = activeRanker(ctx.query, ctx.embeddings);
  const relevant = rank.active
    ? rank.top(
        bodies,
        Math.max(1, Math.round(parts.length * tuning.keepSentenceFraction))
      )
    : new Set<number>();

  const counts = vocabulary(bodies);
  const ranked = parts.map((part, index) => ({
    sentence: part.text,
    index,
    value:
      score(part.text, index, parts.length, subjectShare(part.text, counts)) +
      (relevant.has(index) ? 6 : 0),
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
    body += rejoin(parts.slice(index, next).map((part) => part.after));
  });
  body += ` ${inlineMarker(
    `${count(dropped, 'lower-signal sentence')} removed`,
    recoverAt,
    ctx.stamp ?? null
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
