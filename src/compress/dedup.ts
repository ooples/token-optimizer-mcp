/**
 * Cross-block dedup: the same bytes, sent twice, charged twice.
 *
 * WHY THIS IS THE BIGGEST REMAINING WIN, and why the per-block engines cannot
 * find it. Every engine here is a pure function of ONE block, so it cannot see
 * that the file it is compressing is the same file the agent read nine turns
 * ago. An agentic coding session repeats itself constantly and for good
 * reasons: read a file, edit it, read it back; run the tests, fix, run them
 * again; grep, follow a hit, grep the same pattern from a different directory.
 * The second copy is pure cost -- it teaches the model nothing the first copy
 * did not already say.
 *
 * THE REFERENT IS INSIDE THE REQUEST, WHICH IS THE WHOLE POINT.
 *
 * HeadRoom dedups too -- a content hash naturally collapses repeats -- but
 * their marker points OUT of the payload, at a cache entry keyed by that hash.
 * When the entry is missing the model receives `<<ccr:a1b2c3>> [unresolved:
 * entry not found]` (their #2509), a dead token mid-context. A back-reference
 * here points at bytes that are still in the very request being sent. It cannot
 * miss, because there is no lookup: the content the model needs is above.
 *
 * That is why these elisions are `lossless: true` with no `recoverAt`. The rule
 * is not "we hope it is retrievable" -- it is that the output alone fully
 * determines what was removed, which is exactly what `lossless` means.
 *
 * TWO KINDS OF REPEAT, IN ORDER OF VALUE:
 *
 *   verbatim   the referent was never rewritten -- it sits before the cache
 *              frontier, or nothing claimed it -- so the later copy can be
 *              dropped whole and never compressed at all. This is the case
 *              that pays best: a file re-read after an edit whose earlier copy
 *              is already in the cached prefix costs nothing on the wire.
 *
 *   compressed the referent was rewritten, so the later copy is compared
 *              AFTER compression. Identical compressed forms mean the later
 *              block would have contributed nothing new, and the reference is
 *              still exact -- it names bytes the model can read above.
 *
 * WHAT IS DELIBERATELY NOT DONE: near-duplicate matching. A file read before
 * and after an edit is NOT the same file, and the difference is precisely what
 * the agent is looking at. Collapsing "almost the same" would hide the edit --
 * a silent, confident wrong answer, which is worse than the tokens it saves.
 * Only exact equality dedups here.
 */

import type { Elision } from './types.js';

/**
 * How much of the referent's opening is quoted, so the model can find it.
 *
 * KEPT SHORT ON PURPOSE, and the number was measured rather than guessed. Every
 * character here is paid on every repeat, and the whole marker is what we spend
 * to stay legible where a hash costs 24 characters. Forty is enough to make an
 * opening line unique in practice -- a file's first import, a log's first
 * timestamped line -- without paying for the rest of it.
 */
const QUOTE_CHARS = 40;

/** The widest ordinal the bound below assumes; see `markerCost`. */
const WIDEST_LABEL = 99;

/**
 * Below this a reference cannot pay for itself -- derived, not chosen.
 *
 * THE OLD NUMBER WAS A GUESS, AND IT WAS WRONG BY A FACTOR OF FOUR. It read 600
 * on the strength of a comment estimating the marker at "about 130 characters".
 * Measured across the twelve benchmark workloads, the markers actually emitted
 * run 31 to 83 characters, median 59. So the floor is computed instead: the
 * widest marker this module can render, quoting a full `QUOTE_CHARS`, doubled.
 * A block is pointed at only when the pointer costs at most half of it.
 * Marginal savings are still refused -- now at the size where they are in fact
 * marginal, rather than four times above it.
 *
 * A PRE-FILTER, NOT THE GUARANTEE. It bounds the marker by its widest possible
 * form and by a byte count of zero, both of which flatter a real block.
 * `worthPointingAt` weighs the marker that will actually be emitted.
 */
export const MIN_DEDUP_BYTES =
  2 * labelledReference(0, 'x'.repeat(QUOTE_CHARS), WIDEST_LABEL).length;

/** One block on its way through a strategy. */
export interface DedupBlock {
  /** The text as it stands now -- already compressed, if it was going to be. */
  readonly text: string;
  /** The text before any engine touched it. */
  readonly original: string;
  /**
   * May this block be rewritten at all? False for a signed message or content
   * behind the cache frontier, both of which must stay byte-identical.
   */
  readonly touchable: boolean;
}

export interface DedupResult {
  /** One text per input block, in order. */
  readonly texts: readonly string[];
  readonly elisions: readonly Elision[];
}

/**
 * A short, quoted opening line, so the reference names something findable.
 *
 * NOT A HASH, on purpose. A hash is only meaningful to the machine holding the
 * table; a quoted first line is meaningful to the reader, which is the model.
 */
function opening(text: string): string {
  const firstLine = text.slice(0, 400).split('\n', 1)[0] ?? '';
  const trimmed = firstLine.trim().replace(/\s+/g, ' ');
  return trimmed.length > QUOTE_CHARS
    ? `${trimmed.slice(0, QUOTE_CHARS)}...`
    : trimmed;
}

/**
 * The head of a block as a reader scanning the payload reads it: the same
 * window `opening` quotes from, with its line breaks flattened.
 *
 * `opening`'s short form is always a prefix of this, because collapsing the
 * whitespace of the whole window and collapsing the whitespace of its first
 * line agree until that line ends.
 */
function readerHead(text: string): string {
  return text.slice(0, 400).replace(/\s+/g, ' ').trim();
}

/**
 * How far a quote may be widened before the reference is given up on.
 *
 * Past this the marker costs more than the block it replaces is worth, and a
 * pair of blocks that agree for two hundred characters is better served by
 * being sent twice than by a quote nobody would read.
 */
const MAX_QUOTE_CHARS = 200;

/**
 * A quote that names exactly ONE block above, or null when none does.
 *
 * FORTY CHARACTERS IS NOT A KEY, and treating it as one is how `lossless: true`
 * became a claim the payload could not keep. Two blocks that open on the same
 * license header, the same shebang or the same timestamped prefix quote
 * identically, so a marker naming that opening names both, and a reader
 * following it cannot tell which bytes were removed. The elision still said
 * `recoverAt: null` -- there is nothing to look up -- which is only true while
 * the thing it points at is singular.
 *
 * So the quote is widened until it separates the referent from every other
 * block a reader can see above it, and the common case is untouched: no rival
 * shares the opening, the first test passes, and the marker is the same forty
 * characters it always was. Only a genuine collision pays, and it pays in
 * characters rather than in a wrong answer.
 */
function quoteFor(referent: string, above: ReadonlySet<string>): string | null {
  const rivals: string[] = [];
  for (const text of above)
    if (text !== referent) rivals.push(readerHead(text));

  const short = opening(referent);
  const needle = short.endsWith('...') ? short.slice(0, -3) : short;
  if (!rivals.some((rival) => rival.startsWith(needle))) return short;

  const full = readerHead(referent);
  const limit = Math.min(MAX_QUOTE_CHARS, full.length);
  for (let width = needle.length + 1; width <= limit; width += 1) {
    const wider = full.slice(0, width);
    if (!rivals.some((rival) => rival.startsWith(wider))) return `${wider}...`;
  }
  return null;
}

/**
 * The back-reference written where the repeat used to be.
 *
 * THE PRICE OF BEING LEGIBLE, stated plainly: this runs about 100 characters
 * where HeadRoom's `<<ccr:hash,blob,32107>>` runs 24, and on the repeated-reads
 * workload that difference is the entire margin by which their control arm
 * leads ours on raw gross reduction. It is still the right trade. Their 24
 * characters only mean anything to a process holding the matching cache entry;
 * when it is missing the model reads `[unresolved: entry not found]` (#2509).
 * These hundred characters mean something to the reader on their own, and the
 * content they point at is in the same request.
 */
/**
 * The same reference, plus a label, for a referent that will be pointed at more
 * than once.
 *
 * The label costs about five characters here and saves about seventy on every
 * later repeat, so it is only ever attached when a second reference exists to
 * use it -- see `dedupBlocks`. Attaching it unconditionally made the common
 * case (a block repeated exactly once) slightly worse.
 */
function labelledReference(
  bytes: number,
  quote: string,
  label: number
): string {
  return `[... ${bytes.toLocaleString('en-US')} bytes, shown above: "${quote}" (#${label})]`;
}

/**
 * A repeat of something already labelled: the cheap form.
 *
 * STILL NOT A HASH. `#2` is an ordinal into this request, and the thing it
 * names is a reference that spelled itself out in full further up the same
 * payload -- so a reader who scrolls finds a quoted opening line, not a table
 * lookup that can miss. That is the property their `<<ccr:a1b2c3>>` gives up,
 * and the one that degrades to `[unresolved: entry not found]` (#2509).
 *
 * WHAT IT BUYS. The legible form runs about 100 characters against their 24,
 * and on the repeat-heavy workloads that difference was the entire margin by
 * which their arm led. Paying it once per distinct referent instead of once
 * per repeat keeps the legibility where a reader needs it -- the first time --
 * and charges roughly their price for every repeat after.
 */
function repeatReference(bytes: number, label: number): string {
  return `[... ${bytes.toLocaleString('en-US')} bytes, as #${label} above]`;
}

/**
 * The block after the one the previous reference named: the run form.
 *
 * A MIRRORED REGION IS THE COMMON SHAPE, and quoting every block of it pays for
 * the same information over and over. When an agent re-sends its message list a
 * turn later, a stretch of blocks reappears in the order it first appeared in,
 * so after the first reference has been spelled out with a quote, each block
 * after it is fully determined by ORDER alone -- and order is free.
 *
 * STILL NOT A HASH, AND STILL NOT A POINTER INTO A TABLE. A reader follows this
 * by scrolling one block further than the reference above it just sent them,
 * which is the same motion the quoted form asks for and needs no lookup. It is
 * only ever emitted directly after another reference whose referent sits
 * immediately before this one, so the walk it describes is the walk that exists.
 *
 * Measured on the mirrored-payload workload: fourteen quoted references at 1,016
 * characters became one quoted reference and thirteen of these, at 388.
 */
function nextReference(bytes: number): string {
  return `[... ${bytes.toLocaleString('en-US')} bytes, next above]`;
}

function backReference(bytes: number, quote: string): string {
  return `[... ${bytes.toLocaleString('en-US')} bytes, shown above: "${quote}"]`;
}

/**
 * The widest marker this block could be rendered as, in characters.
 *
 * A label is not handed out until every slot is known, so the bound assumes the
 * labelled form with a two-digit ordinal -- the widest of the three shapes. A
 * reference approved on this figure can only come out shorter than it was
 * judged on, never longer, which is the direction a guard has to err in.
 */
function markerCost(bytes: number, quote: string): number {
  return labelledReference(bytes, quote, 99).length;
}

/**
 * Is a pointer worth what it replaces?
 *
 * THE FLOOR ALONE CANNOT ANSWER THIS, because a quote widens. `quoteFor` pushes
 * one out towards MAX_QUOTE_CHARS to separate a referent from its rivals, so a
 * block that cleared the floor on the assumption of a forty-character quote can
 * still meet a marker five times that. Here the quote exists, so the question is
 * answered rather than assumed.
 *
 * AND THE MARKER REPLACES THE EMITTED TEXT, NOT THE SOURCE. The two drift a long
 * way apart: a block whose original ran to five thousand bytes may have been
 * compressed to eighty before it reached this module, and pointing at that costs
 * more than sending it. The count the marker DISPLAYS is the original -- that is
 * what the reader lost, and what makes the marker wide -- so the cost is
 * measured against the original and the saving against the text.
 */
function worthPointingAt(block: DedupBlock, quote: string): boolean {
  return markerCost(block.original.length, quote) * 2 <= block.text.length;
}

/**
 * The referent a back-reference names, or null when the line is not one.
 *
 * THE INVERSE LIVES BESIDE THE ENCODER, for the reason `rehydrate` gives for
 * centralising the envelope: a hand-written inverse in another file drifts from
 * the grammar it is supposed to invert, and one that has drifted into being too
 * forgiving passes everything. The three markers above are the whole grammar,
 * and this is where they are read back.
 *
 * NOT A LOSSY MARKER, WHICH IS THE WHOLE POINT OF READING IT BACK. The content
 * is in the same request, above -- that is exactly the claim made below when
 * these elisions are recorded `lossless: true` with `recoverAt: null`. A
 * decoder shown one block in isolation cannot check that claim, so it refused,
 * and three by-design references sat on a list of suspected data loss.
 */
export interface BackReference {
  /**
   * The quoted opening with its ellipsis stripped, so it is a prefix of the
   * referent's reader head. Null on the cheap repeat form, which carries a
   * label and nothing else.
   */
  readonly needle: string | null;
  /** The ordinal in `(#n)` or `as #n above`, or null where there is none. */
  readonly label: number | null;
  /**
   * True on the run form, which names its referent by ORDER rather than by
   * quote: the block after the one the preceding reference resolved to. It
   * carries neither a needle nor a label, so a reader with no preceding
   * reference cannot resolve it -- and must refuse rather than guess.
   */
  readonly follows: boolean;
}

const SPELLED_OUT =
  /^\s*\[\.\.\. [\d,]+ bytes, shown above: "([\s\S]*)"(?: \(#(\d+)\))?\]\s*$/;
const REPEAT = /^\s*\[\.\.\. [\d,]+ bytes, as #(\d+) above\]\s*$/;
const NEXT = /^\s*\[\.\.\. [\d,]+ bytes, next above\]\s*$/;

export function readBackReference(line: string): BackReference | null {
  const spelled = SPELLED_OUT.exec(line);
  if (spelled) {
    const quote = spelled[1];
    return {
      // `quoteFor` strips the same three characters before it tests rivals, so
      // stripping them here asks the identical question it answered.
      needle: quote.endsWith('...') ? quote.slice(0, -3) : quote,
      label: spelled[2] === undefined ? null : Number(spelled[2]),
      follows: false,
    };
  }
  const repeat = REPEAT.exec(line);
  if (repeat) return { needle: null, label: Number(repeat[1]), follows: false };
  return NEXT.test(line) ? { needle: null, label: null, follows: true } : null;
}

/**
 * The one block above whose head this quote names, or null when it names no
 * single one.
 *
 * FAILING CLOSED IS THE POINT. `quoteFor` widens a quote until exactly one
 * block above answers to it, so zero matches or two mean the output and this
 * reader disagree about what is above -- and a decoder that picked one anyway
 * would be vouching for a reconstruction it did not make.
 *
 * Duplicates collapse first because the encoder compared against a Set: two
 * byte-identical untouchable blocks are one rival to it, and counting them as
 * two here would refuse a reference that is perfectly well defined.
 */
export function findReferent(
  needle: string,
  above: readonly string[]
): string | null {
  const hits = [...new Set(above)].filter((text) =>
    readerHead(text).startsWith(needle)
  );
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Replaces repeated blocks with a reference to the copy already in the request.
 *
 * KEYED ON THE SOURCE, NOT ON THE COMPRESSED FORM, and this took a measurement
 * to get right. The first version matched a repeat only when the two blocks
 * had compressed to identical text. That held until cached content started
 * being compressed WITHOUT the question (see `strategy.ts`: the question
 * changes every turn, so a query-dependent prefix can never be cache-stable).
 * From then on the cached copy and the fresh copy of the same file compressed
 * differently, matched nothing, and were both sent in full -- which cost more
 * than re-anchoring saved. On the repeated-reads workload the anchored arm
 * scored 5,646 steady-state tokens against the frontier-only 2,901: the
 * feature was a regression until this changed.
 *
 * So two blocks are the same repeat when their SOURCE bytes are the same,
 * whatever each compressed to. The later one is replaced by a reference to the
 * earlier one.
 *
 * WHAT THAT COSTS, since it is a real trade and not a free win. The earlier
 * copy may have elided something the later copy would have kept -- a function
 * body the question made live, say. The reader is not stuck: every elision in
 * the earlier copy names a path or a line range, so the body is one `Read`
 * away. That is the same guarantee the rest of this design rests on, and it is
 * why the trade is acceptable here where it would not be for a hash.
 *
 * Order matters and is preserved: the FIRST occurrence is always kept, because
 * it is what every later reference points at.
 */
/** A position in the output: either literal text, or a reference to be worded. */
type Slot =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'ref';
      readonly bytes: number;
      readonly referent: string;
      /** Widened past `opening` only where a rival above shares it. */
      readonly quote: string;
      /**
       * Where the referent sits in this same array. Two references whose
       * referents are one apart describe a mirrored stretch, and the second of
       * them can be worded by order instead of by quote -- see `nextReference`.
       */
      readonly at: number;
    };

export function dedupBlocks(blocks: readonly DedupBlock[]): DedupResult {
  // COLLECTED BEFORE THEY ARE WORDED. How a reference should be phrased depends
  // on how many OTHER references share its referent, which is not known until
  // every block has been matched. Collecting slots first keeps that decision in
  // one place rather than duplicating the matching rules in a counting pass.
  const slots: Slot[] = [];
  const elisions: Elision[] = [];

  // By source bytes, but ONLY for a block that was never rewritten -- an
  // untouchable one, which still holds the original. Such a block is the
  // strongest referent there is: a later copy of the same source is fully
  // present above, byte for byte.
  const verbatim = new Map<string, string>();
  // And by emitted text, which is the general case: two blocks that SAY the
  // same thing, whatever their sources were.
  const byOutput = new Map<string, string>();

  // EVERY literal above, not just the ones eligible to be pointed at. A block
  // under the floor is never a referent, but it is still text on the reader's
  // screen that a quote can land on, so it counts as a rival.
  const emitted = new Set<string>();

  // WHERE each literal landed, on the same first-wins rule `byOutput` uses, so
  // the position recorded here is the position of the block a reference will
  // actually resolve to. Only literals are recorded: a reference is not a block
  // a later reference can point at.
  const positionOf = new Map<string, number>();

  const remember = (block: DedupBlock): void => {
    if (
      !block.touchable &&
      block.original.length >= MIN_DEDUP_BYTES &&
      !verbatim.has(block.original)
    )
      verbatim.set(block.original, block.text);
    if (block.text.length >= MIN_DEDUP_BYTES && !byOutput.has(block.text))
      byOutput.set(block.text, block.text);
  };

  for (const block of blocks) {
    // An untouchable block -- signed, or behind the cache frontier -- is never
    // rewritten, so it arrives byte-identical no matter what.
    if (!block.touchable) {
      remember(block);
      emitted.add(block.text);
      if (!positionOf.has(block.text)) positionOf.set(block.text, slots.length);
      slots.push({ kind: 'text', text: block.text });
      continue;
    }

    // MATCHING ON SOURCE ALONE WAS A LIE, and it is the same lie this module
    // helped catch elsewhere: correct about what was removed, wrong about
    // what was claimed. Two blocks with the same SOURCE can emit different
    // text -- cached content is compressed without the question and fresh
    // content with it, so a fresh block may keep the very body the question
    // made live while the earlier copy elided it. Replacing the fresh block
    // with a pointer to the earlier one then removes something the output
    // does not contain, and `lossless: true` was simply false.
    //
    // So a source match counts only when the earlier block was never
    // rewritten. Everything else has to match on what was actually EMITTED,
    // where the reference is exact by construction. The compression is not
    // lost: `strategy.ts` compresses a repeated source query-independently
    // at both positions, so the two texts come out equal and this second
    // path catches them -- the difference is that now they really are equal
    // rather than assumed to be close enough.
    const earlier =
      (block.original.length >= MIN_DEDUP_BYTES
        ? verbatim.get(block.original)
        : undefined) ??
      (block.text.length >= MIN_DEDUP_BYTES
        ? byOutput.get(block.text)
        : undefined);

    // A REFERENCE NOBODY CAN FOLLOW IS WORSE THAN THE BYTES IT SAVES. When no
    // quote within reach separates the referent from the other blocks above,
    // the honest move is to send the block, not to emit a marker that points
    // at two places and call the elision lossless.
    const quote = earlier === undefined ? null : quoteFor(earlier, emitted);

    if (
      earlier !== undefined &&
      quote !== null &&
      worthPointingAt(block, quote)
    ) {
      slots.push({
        kind: 'ref',
        bytes: block.original.length,
        referent: earlier,
        quote,
        at: positionOf.get(earlier) ?? -1,
      });
      elisions.push({
        removed: `${block.original.length.toLocaleString('en-US')} bytes already shown earlier in this conversation`,
        // The referent is in the same request. There is nothing to look up,
        // and nothing to miss.
        recoverAt: null,
        lossless: true,
      });
      continue;
    }

    remember(block);
    emitted.add(block.text);
    if (!positionOf.has(block.text)) positionOf.set(block.text, slots.length);
    slots.push({ kind: 'text', text: block.text });
  }

  // A LABEL ONLY WHERE IT PAYS. One reference to a referent is the common case
  // and a label would make it five characters worse for no later saving; from
  // two references on, the label is spelled out once and every repeat after it
  // costs roughly what a hash would.
  const referenceCounts = new Map<string, number>();
  for (const slot of slots) {
    if (slot.kind === 'ref')
      referenceCounts.set(
        slot.referent,
        (referenceCounts.get(slot.referent) ?? 0) + 1
      );
  }

  const labels = new Map<string, number>();
  for (const slot of slots) {
    if (slot.kind !== 'ref') continue;
    if ((referenceCounts.get(slot.referent) ?? 0) < 2) continue;
    if (!labels.has(slot.referent)) labels.set(slot.referent, labels.size + 1);
  }

  // A MIRRORED STRETCH IS WORDED ONCE. Where consecutive references name
  // consecutive blocks above, every one after the first is already determined by
  // its position, and quoting it charges again for what the reference before it
  // has just established. `nextReference` says only how many bytes went and that
  // the walk carries on, which on the mirrored workload turned 1,016 characters
  // of marker into 388.
  //
  // THE CHAIN IS WHAT MAKES IT RESOLVABLE, so it must not be broken anywhere in
  // the middle. A run form is emitted only directly after another reference, and
  // only when its referent is the very next block after that one's -- which is
  // exactly the walk a reader performs. The first of any stretch stays spelled
  // out with its quote, so the chain always starts somewhere a reader can find.
  //
  // LABELLED REFERENTS ARE LEFT ALONE. A label is handed to a referent that is
  // pointed at more than once, and the cheap `as #n above` form already prices
  // those repeats; folding one into a run would have to decide which of the two
  // cheap forms wins and would put a label's introduction behind a marker that
  // does not carry it. Runs are built only from referents named exactly once.
  const runnable = slots.map((slot, i) => {
    if (slot.kind !== 'ref' || labels.has(slot.referent)) return false;
    const prev = slots[i - 1];
    if (prev === undefined || prev.kind !== 'ref') return false;
    if (labels.has(prev.referent) || slot.at !== prev.at + 1) return false;
    // AND ONLY WHERE IT PAYS, measured on the markers themselves rather than
    // assumed. A very short quote can make the spelled-out form the cheaper of
    // the two, and emitting the terser wording would then cost bytes to say
    // less.
    return (
      nextReference(slot.bytes).length <
      backReference(slot.bytes, slot.quote).length
    );
  });

  const spelledOut = new Set<string>();
  const texts = slots.map((slot, i) => {
    if (slot.kind === 'text') return slot.text;
    if (runnable[i]) return nextReference(slot.bytes);
    const label = labels.get(slot.referent);
    if (label === undefined) return backReference(slot.bytes, slot.quote);
    if (spelledOut.has(slot.referent))
      return repeatReference(slot.bytes, label);
    spelledOut.add(slot.referent);
    return labelledReference(slot.bytes, slot.quote, label);
  });

  return { texts, elisions };
}
