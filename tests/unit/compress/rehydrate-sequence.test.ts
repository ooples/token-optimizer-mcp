/**
 * The payload-level oracle: a back-reference rebuilt from the blocks above it.
 *
 * `rehydrate` asks "rebuild this block from this block", and for a
 * back-reference the honest answer is no -- the bytes are in the SAME request,
 * a few blocks up, and not in the fragment holding the marker. That refusal was
 * correct and useless: it put three by-design references onto a list of
 * suspected data loss, which is how such a list stops being read.
 *
 * So this checks the two halves of the replacement. It resolves what the
 * encoder emitted, and it still throws on a marker that names nothing above --
 * because a decoder which guesses is indistinguishable from no gate at all.
 */
import { describe, it, expect } from '@jest/globals';
import {
  dedupBlocks,
  MIN_DEDUP_BYTES,
  type DedupBlock,
} from '../../../src/compress/dedup.js';
import { dedupImages } from '../../../src/compress/images.js';
import { rehydrateSequence } from '../../../src/compress/rehydrate.js';
import { PathAddressedError } from '../../../src/compress/annotate.js';

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

/** A 1x1 PNG, over the image floor once padded, as a data payload would be. */
function png(tag: string): string {
  return `iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB${tag}${'A'.repeat(4000)}`;
}

const imageBlock = (data: string): unknown => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data },
});

describe('rehydrateSequence', () => {
  it('rebuilds a spelled-out reference from the block it names', () => {
    const alpha = body('alpha');
    const beta = body('beta');
    const { texts, stamps } = dedupBlocks([alpha, beta, alpha].map(touchable));

    // The third block really was replaced, or the assertion below is vacuous.
    expect(texts[2]).not.toBe(alpha);
    expect(texts[2]).toMatch(/^\[\.\.\. [\d,]+ bytes, shown above: /);

    // EACH STEP GETS THE KEY FOR ITS OWN BLOCK. The encoder authenticates every
    // marker it writes, and the decoder honours only the ones that verify, so a
    // walk handed no keys reads none of these lines as references, returns them
    // as the content it takes them for, and this would fail on the marker text.
    const step = rehydrateSequence();
    expect(texts.map((text, i) => step(text, stamps[i] ?? null))).toEqual([
      alpha,
      beta,
      alpha,
    ]);
  });

  it('resolves the cheap repeat form by its label', () => {
    const alpha = body('alpha');
    const { texts, stamps } = dedupBlocks([alpha, alpha, alpha].map(touchable));

    // Two references to one referent is what earns the label, and the second
    // of them is the short form that carries nothing else -- bar the
    // authenticator, which every marker this encoder writes now ends on. An
    // assertion anchored on the old closing bracket could never match again,
    // and an assertion that can never match pins no wording at all.
    expect(texts[1]).toMatch(/\(#1\) ~[0-9a-z]+\]$/);
    expect(texts[2]).toBe(
      `[... ${alpha.length.toLocaleString('en-US')} bytes, as #1 above ~${stamps[2] ?? ''}]`
    );

    const step = rehydrateSequence();
    expect(texts.map((text, i) => step(text, stamps[i] ?? null))).toEqual([
      alpha,
      alpha,
      alpha,
    ]);
  });

  it('gives an image back-reference the image data it points at', () => {
    const first = png('one');
    const second = png('two');
    const blocks = [first, second, first].map((data) => ({
      block: imageBlock(data),
      touchable: true,
    }));
    const { replacements, stamps, collapsed } = dedupImages(blocks);
    expect(collapsed).toBe(1);

    const marker = replacements[2];
    expect(marker).toMatch(/already shown above \(#1\)/);

    // The caller supplies the distinct images in order of first appearance,
    // read off the output -- where the first copy of each one is still present.
    //
    // AND THE KEY FOR THE BLOCK THE MARKER REPLACED. An image reference is
    // authenticated like every other marker: unstamped, this line is content,
    // and handing back an image for a line the request merely CONTAINED was the
    // defect the keys exist for.
    const step = rehydrateSequence([first, second]);
    expect(step(String(marker), stamps[2] ?? null)).toBe(first);
  });

  it('throws rather than guess when no single block above answers', () => {
    // STAMPED, AND THE KEY HANDED OVER, because the refusal under test is the
    // one for a reference WE wrote that resolves to nothing. Without the key the
    // line is not read as a reference at all, and the throw this asserts would
    // come from somewhere else entirely -- a green test on the wrong fact.
    const step = rehydrateSequence();
    expect(() =>
      step(
        '[... 9,769 bytes, shown above: "a line nobody sent" ~abcdef]',
        'abcdef'
      )
    ).toThrow(/no single block above/);
  });

  it('throws when an image ordinal names an image that is not above', () => {
    const step = rehydrateSequence([png('only')]);
    expect(() =>
      step(
        '[... the same 8x8 image/png image already shown above (#3) -- not repeated here ~abcdef]',
        'abcdef'
      )
    ).toThrow(/no image #3/);
  });

  it('keeps a path-addressed literal above, so a later reference resolves', () => {
    // THE DECODER USED TO LOSE THE BLOCK IT WAS ABOUT TO BE ASKED FOR. A
    // literal whose content was spilled to a path answers `rehydrate` with
    // `PathAddressedError` -- recognised, recoverable, just not from here --
    // and the sequence recorded the block only AFTER that call returned, so
    // the throw dropped it out of `above`. The reference below then named
    // nothing and the whole payload was refused. Caught in the proxy arm,
    // where the anchor store compresses the first block and spills part of
    // it, which is every request production actually serves.
    // THE MARKER IS STAMPED AND THE STAMP IS HANDED TO EACH STEP. This
    // fixture writes a marker the encoder would have written, so it has to
    // carry what the encoder would have put on it; without that it is a line
    // of content and no decoder reads a path out of it.
    const stamp = 'abcdef';
    const spilled = `${body('spilled')}
[... 41,000 bytes ~${stamp} -> .token-optimizer/spill/b1-block.txt]`;
    const other = body('other');
    const { texts, stamps } = dedupBlocks(
      [spilled, other, spilled].map(touchable)
    );
    expect(texts[2]).toMatch(/^\[\.\.\. [\d,]+ bytes, shown above: /);

    // TWO DIFFERENT KEYS, AND THAT IS THE POINT OF THE WALK KEEPING ONE PER
    // BLOCK. The literal above still holds the path marker the fixture wrote,
    // so it decodes under the fixture's key; the reference below was minted by
    // this dedup pass and decodes under its own. Resolving the reference means
    // rebuilding the literal, and the walk has to reach for the key THAT block
    // arrived with -- handed the referrer's, the path marker inside it would
    // read as content and the recoverable throw would never come.
    const step = rehydrateSequence();
    expect(() => step(texts[0], stamp)).toThrow(PathAddressedError);
    expect(step(texts[1], stamp)).toBe(other);
    // The reference is resolved, and the answer is the path -- not a refusal
    // to name the block, which is what this regressed to.
    expect(() => step(texts[2], stamps[2] ?? null)).toThrow(PathAddressedError);
    expect(() => step(texts[2], stamps[2] ?? null)).not.toThrow(
      /no single block above/
    );
  });

  it('still refuses an unregistered marker family', () => {
    // The payload-level reader must not have widened into passing everything:
    // anything that is not a back-reference goes to `rehydrate` unchanged.
    const step = rehydrateSequence();
    expect(() =>
      step('a line\n[... 4 gizmos folded ~abcdef]\nanother line', 'abcdef')
    ).toThrow(/unrecognised marker/);
  });
});
