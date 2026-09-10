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
function backReference(
  bytes: number,
  referent: string,
  exact: boolean
): string {
  const what = exact ? 'identical to' : 'the same as';
  return `[... ${bytes.toLocaleString('en-US')} bytes ${what} the earlier output starting "${opening(referent)}"]`;
}

/**
 * Replaces repeated blocks with a reference to the copy already in the request.
 *
 * Order matters and is preserved: the FIRST occurrence is always kept whole,
 * because it is what every later reference points at. A block that may not be
 * rewritten is still recorded as a referent -- an untouchable block is the best
 * referent there is, since it is guaranteed to arrive byte-identical.
 */
export function dedupBlocks(blocks: readonly DedupBlock[]): DedupResult {
  const texts: string[] = [];
  const elisions: Elision[] = [];

  // Two tables, because the two kinds of repeat are recoverable for different
  // reasons: a verbatim referent still holds the ORIGINAL bytes, so a later
  // copy can skip compression entirely; a compressed referent only proves the
  // later copy would have said the same thing.
  const verbatim = new Map<string, string>();
  const compressed = new Map<string, string>();

  for (const block of blocks) {
    const untouched = block.text === block.original;

    if (!block.touchable) {
      // Never rewritten, so it arrives exactly as recorded and is the strongest
      // possible referent.
      if (block.original.length >= MIN_DEDUP_BYTES) {
        if (!verbatim.has(block.original))
          verbatim.set(block.original, block.original);
        if (!compressed.has(block.text)) compressed.set(block.text, block.text);
      }
      texts.push(block.text);
      continue;
    }

    if (block.original.length >= MIN_DEDUP_BYTES) {
      const earlier = verbatim.get(block.original);
      if (earlier !== undefined) {
        texts.push(backReference(block.original.length, earlier, true));
        elisions.push({
          removed: `${block.original.length.toLocaleString('en-US')} bytes repeated verbatim from earlier in this conversation`,
          // The referent is in the same request. There is nothing to look up.
          recoverAt: null,
          lossless: true,
        });
        continue;
      }
    }

    if (block.text.length >= MIN_DEDUP_BYTES) {
      const earlier = compressed.get(block.text);
      if (earlier !== undefined) {
        texts.push(backReference(block.text.length, earlier, false));
        elisions.push({
          removed: `${block.text.length.toLocaleString('en-US')} bytes that compress to output already above`,
          recoverAt: null,
          lossless: true,
        });
        continue;
      }
    }

    // Not a repeat: it stands, and becomes a referent for whatever follows.
    if (untouched && block.original.length >= MIN_DEDUP_BYTES) {
      if (!verbatim.has(block.original))
        verbatim.set(block.original, block.original);
    }
    if (block.text.length >= MIN_DEDUP_BYTES && !compressed.has(block.text)) {
      compressed.set(block.text, block.text);
    }
    texts.push(block.text);
  }

  return { texts, elisions };
}
