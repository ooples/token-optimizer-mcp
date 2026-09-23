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
} from '../../../src/compress/dedup.js';

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

const MARKER =
  /^\[\.\.\. [\d,]+ bytes, (?:shown above: "(.*)"(?: \(#(\d+)\))?|as #(\d+) above)\]$/;

/** The elided text, recovered from what a model can see and nothing else. */
function reconstruct(texts: readonly string[]): string[] {
  const out: string[] = [];
  const byLabel = new Map<number, string>();
  for (const text of texts) {
    const m = MARKER.exec(text);
    if (m === null) {
      out.push(text);
      continue;
    }
    const [, quoted, introduced, repeated] = m;
    if (repeated !== undefined) {
      const referent = byLabel.get(Number(repeated));
      if (referent === undefined)
        throw new Error(`#${repeated} was never introduced above`);
      out.push(referent);
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
    const { texts } = dedupBlocks(blocks);

    // NOT VACUOUS. If nothing were deduped the reconstruction would be the
    // identity and would round-trip for free.
    const before = blocks.map((b) => b.text).join('').length;
    expect(texts.join('').length).toBeLessThan(before);
    expect(texts.filter((t) => MARKER.test(t))).toHaveLength(2);

    expect(reconstruct(texts)).toEqual(blocks.map((b) => b.text));
  });

  it('resolves every reference it claims is lossless', () => {
    const blocks = [body('one'), body('two'), body('one'), body('two')].map(
      touchable
    );
    const { texts, elisions } = dedupBlocks(blocks);
    const claimed = elisions.filter((e) => e.lossless);
    expect(claimed.length).toBeGreaterThan(0);
    // Every lossless claim corresponds to a marker, and every marker resolves.
    expect(texts.filter((t) => MARKER.test(t))).toHaveLength(claimed.length);
    expect(reconstruct(texts)).toEqual(blocks.map((b) => b.text));
  });

  it('fails when a reference points at the wrong block', () => {
    const blocks = [body('alpha'), body('beta'), body('alpha')].map(touchable);
    const { texts } = dedupBlocks(blocks);
    // THE GATE HAS TO BE ABLE TO FAIL. Rewriting the referent's opening line is
    // what a dedup that matched too loosely would effectively do: the marker
    // still reads well, and it now names bytes that are not the ones removed.
    const damaged = texts.map((t, i) =>
      i === 0 ? t.replace('alpha', 'gamma') : t
    );
    expect(() => reconstruct(damaged)).toThrow(/names 0 blocks above/);
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
    const { texts } = dedupBlocks(blocks);
    expect(texts.filter((t) => MARKER.test(t))).toHaveLength(0);
    expect(reconstruct(texts)).toEqual(blocks.map((b) => b.text));
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
    const { texts, elisions } = dedupBlocks(blocks);

    // Still deduped -- the answer to an ambiguous quote is a longer quote, not
    // a refusal, as long as one exists.
    const markers = texts.filter((t) => MARKER.test(t));
    expect(markers).toHaveLength(1);
    expect(elisions.filter((e) => e.lossless)).toHaveLength(1);

    // And it cost what it had to and no more: the quote reaches past the
    // shared opening line, far enough to exclude the other block and not one
    // character further.
    const quoted = MARKER.exec(markers[0])?.[1] ?? '';
    const needle = quoted.replace(/\.\.\.$/, '');
    expect(needle.length).toBeGreaterThan(LICENSE.length);
    expect(readerHead(alpha).startsWith(needle)).toBe(true);
    expect(readerHead(beta).startsWith(needle)).toBe(false);
    expect(readerHead(beta).startsWith(needle.slice(0, -1))).toBe(true);

    expect(reconstruct(texts)).toEqual(blocks.map((b) => b.text));
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
    const { texts, elisions } = dedupBlocks(blocks);
    expect(texts.filter((t) => MARKER.test(t))).toHaveLength(0);
    expect(elisions).toHaveLength(0);
    expect(texts).toEqual(blocks.map((b) => b.text));

    // A POSITIVE CONTROL, because "no marker" is what a broken engine emits
    // too. The same three-block shape with a separable head does dedup, so the
    // refusal above is the ambiguity and not the fixture.
    const separable = [body('alpha'), body('beta'), body('alpha')].map(
      touchable
    );
    expect(
      dedupBlocks(separable).texts.filter((t) => MARKER.test(t))
    ).toHaveLength(1);
  });
});
