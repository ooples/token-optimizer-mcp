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
 * Below this a reference costs more than the repeat.
 *
 * The marker runs about 130 characters once it quotes an opening line, so the
 * floor is set well above it rather than at break-even: a marginal saving is
 * not worth asking a model to follow a pointer.
 */
export const MIN_DEDUP_BYTES = 600;

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
  referent: string,
  label: number
): string {
  return `[... ${bytes.toLocaleString('en-US')} bytes, shown above: "${opening(referent)}" (#${label})]`;
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

function backReference(bytes: number, referent: string): string {
  return `[... ${bytes.toLocaleString('en-US')} bytes, shown above: "${opening(referent)}"]`;
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
  | { readonly kind: 'ref'; readonly bytes: number; readonly referent: string };

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

    if (earlier !== undefined) {
      slots.push({
        kind: 'ref',
        bytes: block.original.length,
        referent: earlier,
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

  const spelledOut = new Set<string>();
  const texts = slots.map((slot) => {
    if (slot.kind === 'text') return slot.text;
    const label = labels.get(slot.referent);
    if (label === undefined) return backReference(slot.bytes, slot.referent);
    if (spelledOut.has(slot.referent))
      return repeatReference(slot.bytes, label);
    spelledOut.add(slot.referent);
    return labelledReference(slot.bytes, slot.referent, label);
  });

  return { texts, elisions };
}
