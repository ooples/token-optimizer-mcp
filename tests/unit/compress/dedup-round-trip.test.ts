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
 * work with -- the quoted text is a prefix of the referent's first line -- and
 * demands that exactly one block above satisfies it.
 */
function firstLine(text: string): string {
  return (text.slice(0, 400).split('\n', 1)[0] ?? '')
    .trim()
    .replace(/\s+/g, ' ');
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
      firstLine(earlier).startsWith(needle)
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
});
