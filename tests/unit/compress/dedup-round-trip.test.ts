/**
 * Reconstructs the input from a deduped payload, using only the payload.
 *
 * `dedupBlocks` is the one block engine that claims `lossless: true` on output
 * it actually rewrote (dedup.ts:258, with `recoverAt: null` -- there is nothing
 * to look up because the bytes are in the same request). Everything else either
 * claims nothing or claims it only on a path that returns its input untouched.
 * So this is where the claim needs a proof rather than a spot check.
 *
 * `dedup.test.ts` already asserts that a marker NAMES something findable above
 * and that the elision is shaped correctly. Neither shows that following every
 * marker gets the original text back, which is the whole content of the claim.
 */
import { describe, it, expect } from '@jest/globals';
import {
  dedupBlocks,
  MIN_DEDUP_BYTES,
  type DedupBlock,
  type DedupResult,
} from '../../../src/compress/dedup.js';
import type { Stamp } from '../../../src/compress/types.js';

/**
 * A READER'S RULE, DELIBERATELY NOT THE EMITTER'S.
 *
 * `opening()` in dedup.ts slices 400 characters, takes the first line, collapses
 * whitespace and cuts at 40. Re-implementing that here would make the gate agree
 * with the emitter by construction: change the quoting scheme and the test would
 * follow it rather than fail. So resolution uses the weakest rule a reader could
 * work with -- the quoted text is a prefix of the block as it reads on screen,
 * with its line breaks flattened -- and demands that exactly one block above
 * satisfies it. That is weaker than "a prefix of the first line", and it has to
 * be: a quote is widened past the opening line when two blocks open alike, and
 * a reader who could not follow it there would be reading a marker that names
 * nothing.
 */
function readerHead(text: string): string {
  return text.slice(0, 400).replace(/\s+/g, ' ').trim();
}

/*
 * AND THE STAMP IS PART OF THE READER'S RULE NOW.
 *
 * The three shapes each end in an authenticator the encoder derived from the
 * block, and a reader that ignored it would honour a reference-shaped line that
 * arrived in the CONTENT -- which is the defect the stamps exist for, measured
 * at a whole four-block request denied by one planted line and, worse, at a
 * planted line silently resolving to a kilobyte of unrelated content above.
 *
 * Hand-written here rather than imported, like everything else in this file: the
 * suffix is ` ~` and the key, and a reader holding no key honours nothing.
 */
const MARKER_HEAD =
  /^\[\.\.\. [\d,]+ bytes, (?:shown above: "(.*)"(?: \(#(\d+)\))?|as #(\d+) above|(next above))/;

function marker(stamp: Stamp): RegExp {
  return new RegExp(
    MARKER_HEAD.source + (stamp === null ? '(?!)' : ` ~${stamp}`) + /\]$/.source
  );
}

/** The marker texts in a result, each judged against its own key. */
function markers(result: DedupResult): string[] {
  return result.texts.filter((text, i) =>
    marker(result.stamps[i] ?? null).test(text)
  );
}

/** The elided text, recovered from what a model can see and nothing else. */
function reconstruct(
  texts: readonly string[],
  stamps: readonly Stamp[]
): string[] {
  const out: string[] = [];
  const byLabel = new Map<number, string>();
  // ALSO A READER'S RULE, AND DELIBERATELY NOT THE EMITTER'S. `next above` says
  // the block after the one the marker before it named, so a reader follows it
  // by scrolling one further than they just scrolled -- nothing about slots,
  // positions or first-wins maps, which is what the emitter reasons in. Written
  // that way it can disagree with the emitter, which is the point of this file.
  //
  // Where the reader is not mid-walk there is no "one further", so it refuses.
  let walked = -1;
  for (const [i, text] of texts.entries()) {
    const m = marker(stamps[i] ?? null).exec(text);
    if (m === null) {
      out.push(text);
      walked = -1;
      continue;
    }
    const [, quoted, introduced, repeated, next] = m;
    if (next !== undefined) {
      const referent = walked < 0 ? undefined : out[walked + 1];
      if (referent === undefined)
        throw new Error('"next above" continues a walk that is not running');
      out.push(referent);
      walked += 1;
      continue;
    }
    if (repeated !== undefined) {
      const referent = byLabel.get(Number(repeated));
      if (referent === undefined)
        throw new Error(`#${repeated} was never introduced above`);
      out.push(referent);
      walked = out.indexOf(referent);
      continue;
    }
    const needle = quoted.endsWith('...') ? quoted.slice(0, -3) : quoted;
    const found = out.filter((earlier) =>
      readerHead(earlier).startsWith(needle)
    );
    if (found.length !== 1)
      throw new Error(
        `"${quoted}" names ${found.length} blocks above, not one`
      );
    out.push(found[0]);
    walked = out.indexOf(found[0]);
    if (introduced !== undefined) byLabel.set(Number(introduced), found[0]);
  }
  return out;
}

/** A block comfortably over the floor, with a first line of its own. */
function body(tag: string): string {
  const line = `${tag} :: ${'payload '.repeat(12)}`;
  const filler = `${'lorem ipsum dolor sit amet '.repeat(30)}`;
  const text = `${tag}-opening-line for ${tag}\n${line}\n${filler}`;
  expect(text.length).toBeGreaterThan(MIN_DEDUP_BYTES);
  return text;
}

const touchable = (text: string): DedupBlock => ({
  text,
  original: text,
  touchable: true,
});

describe('a deduped payload reconstructs its input from the output alone', () => {
  it('gives every reference back the bytes it replaced', () => {
    const alpha = body('alpha');
    const beta = body('beta');
    // alpha three times, so both marker forms appear: the spelled-out one that
    // introduces the label and the cheap repeat that reuses it.
    const blocks = [alpha, beta, alpha, alpha].map(touchable);
    const result = dedupBlocks(blocks);
    const { texts, stamps } = result;

    // NOT VACUOUS. If nothing were deduped the reconstruction would be the
    // identity and would round-trip for free.
    const before = blocks.map((b) => b.text).join('').length;
    expect(texts.join('').length).toBeLessThan(before);
    expect(markers(result)).toHaveLength(2);

    expect(reconstruct(texts, stamps)).toEqual(blocks.map((b) => b.text));
  });

  it('resolves every reference it claims is lossless', () => {
    const blocks = [body('one'), body('two'), body('one'), body('two')].map(
      touchable
    );
    const result = dedupBlocks(blocks);
    const { texts, elisions, stamps } = result;
    const claimed = elisions.filter((e) => e.lossless);
    expect(claimed.length).toBeGreaterThan(0);
    // Every lossless claim corresponds to a marker, and every marker resolves.
    expect(markers(result)).toHaveLength(claimed.length);
    expect(reconstruct(texts, stamps)).toEqual(blocks.map((b) => b.text));
  });

  it('fails when a reference points at the wrong block', () => {
    const blocks = [body('alpha'), body('beta'), body('alpha')].map(touchable);
    const { texts, stamps } = dedupBlocks(blocks);
    // THE GATE HAS TO BE ABLE TO FAIL. Rewriting the referent's opening line is
    // what a dedup that matched too loosely would effectively do: the marker
    // still reads well, and it now names bytes that are not the ones removed.
    const damaged = texts.map((t, i) =>
      i === 0 ? t.replace('alpha', 'gamma') : t
    );
    // DECODED WITH THE REAL KEYS, or the damage below is a no-op: a reader
    // holding none honours no marker, hands the damaged text straight back, and
    // `toThrow` would pass without the rule under test ever being read.
    expect(() => reconstruct(damaged, stamps)).toThrow(/names 0 blocks above/);
  });

  it('refuses a source match when the earlier copy was rewritten', () => {
    // THE BUG dedup.ts:223-238 RECORDS, AS A FIXTURE. Two blocks can share a
    // source and still emit different text -- cached content is compressed
    // without the question, fresh content with it -- so a rule that matched on
    // source alone replaced the fresh block with a pointer to the elided one,
    // removing bytes the payload never contained. It must not dedup here.
    const source = body('shared');
    const rewritten: DedupBlock = {
      text: `${source}\n[... 900 bytes elided]`,
      original: source,
      touchable: true,
    };
    const fresh: DedupBlock = {
      text: source,
      original: source,
      touchable: true,
    };
    const blocks = [rewritten, fresh];
    const result = dedupBlocks(blocks);
    expect(markers(result)).toHaveLength(0);
    expect(reconstruct(result.texts, result.stamps)).toEqual(
      blocks.map((b) => b.text)
    );
  });

  /**
   * TWO FILES THAT OPEN ON THE SAME LICENSE HEADER. Forty characters was being
   * treated as a key, and it is not one: the quote named both blocks, the
   * reader could not tell which bytes had been removed, and the elision still
   * said `lossless: true` with `recoverAt: null`.
   */
  const LICENSE =
    '/* Copyright (c) 2026 Example Corp. Licensed under Apache-2.0. */';

  function licensed(tag: string): string {
    const text = `${LICENSE}\n${tag} :: ${'payload '.repeat(12)}\n${'lorem ipsum dolor sit amet '.repeat(30)}`;
    expect(text.length).toBeGreaterThan(MIN_DEDUP_BYTES);
    return text;
  }

  it('widens the quote until it names one block, not two', () => {
    const alpha = licensed('alpha');
    const beta = licensed('beta');
    // THE COLLISION IS REAL, not assumed: the two blocks are distinct and their
    // opening lines are identical, so no prefix of either separates them.
    expect(alpha).not.toEqual(beta);
    expect(alpha.split('\n')[0]).toEqual(beta.split('\n')[0]);

    const blocks = [alpha, beta, alpha].map(touchable);
    const result = dedupBlocks(blocks);
    const { texts, elisions, stamps } = result;

    // Still deduped -- the answer to an ambiguous quote is a longer quote, not
    // a refusal, as long as one exists.
    const found = markers(result);
    expect(found).toHaveLength(1);
    expect(elisions.filter((e) => e.lossless)).toHaveLength(1);

    // And it cost what it had to and no more: the quote reaches past the
    // shared opening line, far enough to exclude the other block and not one
    // character further.
    const at = texts.indexOf(found[0]);
    const quoted = marker(stamps[at] ?? null).exec(found[0])?.[1] ?? '';
    const needle = quoted.replace(/\.\.\.$/, '');
    expect(needle.length).toBeGreaterThan(LICENSE.length);
    expect(readerHead(alpha).startsWith(needle)).toBe(true);
    expect(readerHead(beta).startsWith(needle)).toBe(false);
    expect(readerHead(beta).startsWith(needle.slice(0, -1))).toBe(true);

    expect(reconstruct(texts, stamps)).toEqual(blocks.map((b) => b.text));
  });

  it('sends the block when no quote within reach separates it', () => {
    // NOTHING TO WIDEN TO. These two agree for the whole window a quote is cut
    // from, so every candidate quote names both. A marker here would be a
    // reference a reader cannot follow, and the bytes it claims to have saved
    // are not worth an answer that is wrong.
    const shared = 'lorem ipsum dolor sit amet '.repeat(30);
    const twin = (tag: string): string =>
      `${shared}\n${tag} :: ${'payload '.repeat(12)}`;
    const first = twin('alpha');
    const second = twin('beta');
    expect(first).not.toEqual(second);
    expect(first.slice(0, 400)).toEqual(second.slice(0, 400));
    expect(first.length).toBeGreaterThan(MIN_DEDUP_BYTES);

    const blocks = [first, second, first].map(touchable);
    const result = dedupBlocks(blocks);
    expect(markers(result)).toHaveLength(0);
    expect(result.elisions).toHaveLength(0);
    expect(result.texts).toEqual(blocks.map((b) => b.text));

    // A POSITIVE CONTROL, because "no marker" is what a broken engine emits
    // too. The same three-block shape with a separable head does dedup, so the
    // refusal above is the ambiguity and not the fixture.
    const separable = [body('alpha'), body('beta'), body('alpha')].map(
      touchable
    );
    expect(markers(dedupBlocks(separable))).toHaveLength(1);
  });
});
