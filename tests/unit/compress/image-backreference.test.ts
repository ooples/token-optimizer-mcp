import { describe, it, expect } from '@jest/globals';
import {
  dedupImages,
  describeImage,
  MIN_DEDUP_IMAGE_CHARS,
} from '../../../src/compress/images.js';

/**
 * AN IMAGE BACK-REFERENCE MUST RESOLVE TO THE IMAGE IT REPLACED.
 *
 * A repeated screenshot is replaced by `[... the same 800x600 image/png image
 * already shown above (#3) ... -- not repeated here]`, and the elision is
 * reported lossless. That claim rests entirely on `#3` being resolvable: the
 * bytes are gone from the request, and the only route back to them is that
 * number. A wrong ordinal is not a cosmetic defect -- it points the model at a
 * different screenshot, which is worse than pointing at nothing, because it
 * looks like an answer.
 *
 * THE ORDINAL IS NOT THE BLOCK INDEX, and that is the trap. `images.ts:204`
 * numbers by FIRST APPEARANCE AMONG DISTINCT IMAGES -- `seen.set(image.data,
 * seen.size + 1)` -- so `#3` means "the third distinct image in this request",
 * not "the third block" and not "the third image block". A reader resolves it
 * by counting distinct images in order, which is exactly what `resolve` below
 * does, using only what survives in the output.
 *
 * `images.test.ts` asserts `elision?.lossless === true` and never resolves an
 * ordinal, so every numbering scheme above passes it equally.
 */

/** Distinct base64 payloads, each over the dedup floor so they are touchable. */
const png = (seed: string) =>
  `${seed.repeat(Math.ceil((MIN_DEDUP_IMAGE_CHARS + 200) / seed.length))}`;

const ALPHA = png('QUJDRA');
const BETA = png('RUZHSA');
const GAMMA = png('SUpLTA');

const image = (data: string) => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data },
});

const text = (body: string) => ({ type: 'text', text: body });

/** `(#N)` out of a back-reference, or null when the line is not one. */
function ordinalOf(replacement: string): number | null {
  const m = /already shown above \(#(\d+)\)/.exec(replacement);
  return m ? Number(m[1]) : null;
}

/**
 * Resolves every back-reference the way a reader must, from the output alone.
 *
 * Walks what survives, numbering distinct images by first appearance, then
 * checks each back-reference's ordinal against that numbering. Returns the
 * data it resolved to, so the caller can compare it with what was removed.
 */
function resolve(
  blocks: readonly unknown[],
  replacements: readonly (string | null)[]
): Array<{ at: number; resolved: string | null }> {
  const order: string[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    if (replacements[i] !== null) continue; // removed: not visible to a reader
    const described = describeImage(blocks[i]);
    if (described && !order.includes(described.data))
      order.push(described.data);
  }
  const out: Array<{ at: number; resolved: string | null }> = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const replacement = replacements[i];
    if (replacement === null) continue;
    const ordinal = ordinalOf(replacement);
    out.push({
      at: i,
      resolved: ordinal === null ? null : (order[ordinal - 1] ?? null),
    });
  }
  return out;
}

const touchable = (blocks: readonly unknown[]) =>
  blocks.map((block) => ({ block, touchable: true }));

describe('an image back-reference resolves to the image it replaced', () => {
  it('numbers by distinct image, not by block position', () => {
    // BLOCK POSITION AND IMAGE ORDINAL MUST DISAGREE FOR EVERY IMAGE HERE.
    // Text blocks alone are not enough: with the repeat placed after the
    // first BETA, BETA was both the second image block AND the second
    // distinct image, so an implementation numbering by image-block position
    // produced the same #2 and passed. Putting the ALPHA repeat first makes
    // BETA the THIRD image block but still the SECOND distinct image, and
    // GAMMA the fourth block but the third image, so the two schemes can no
    // longer agree anywhere.
    const blocks = [
      text('first screenshot'),
      image(ALPHA), // image block 1, distinct image 1
      text('some analysis'),
      image(ALPHA), // image block 2, still distinct image 1 -- repeat of the FIRST
      text('more analysis'),
      image(BETA), // image block 3, distinct image 2
      image(GAMMA), // image block 4, distinct image 3
      image(BETA), // repeat of the SECOND
    ];

    const { replacements, collapsed } = dedupImages(touchable(blocks));

    // An inert dedup would satisfy every assertion below by collapsing nothing.
    expect(collapsed).toBe(2);

    const resolved = resolve(blocks, replacements);
    expect(resolved).toHaveLength(2);

    for (const { at, resolved: data } of resolved) {
      const original = describeImage(blocks[at]);
      expect(original).not.toBeNull();
      // The whole guarantee, in one line: what the number points at is what
      // was taken away.
      expect(data).toBe(original?.data);
    }
  });

  it('a wrong ordinal is rejected', () => {
    const blocks = [image(ALPHA), image(BETA), image(ALPHA)];
    const { replacements } = dedupImages(touchable(blocks));
    const real = replacements.find((r) => r !== null);
    expect(real).toBeTruthy();

    const damaged = [
      // Off by one: points at the next distinct image along.
      real?.replace(/\(#(\d+)\)/, (_, n) => `(#${Number(n) + 1})`),
      // Off by one the other way: past the start of the numbering.
      real?.replace(/\(#(\d+)\)/, (_, n) => `(#${Number(n) - 1})`),
    ].filter((candidate): candidate is string => Boolean(candidate));
    expect(damaged).toHaveLength(2);

    const original = describeImage(blocks[2]);
    for (const candidate of damaged) {
      const patched = replacements.map((r) => (r === null ? null : candidate));
      const [{ resolved }] = resolve(blocks, patched);
      expect(resolved).not.toBe(original?.data);
    }
  });

  it('an image below the dedup floor is left alone', () => {
    // A positive control for the floor: without it, "nothing collapsed" above
    // would be indistinguishable from "the floor swallowed everything".
    const tiny = 'QUJD'.repeat(4);
    expect(tiny.length).toBeLessThan(MIN_DEDUP_IMAGE_CHARS);
    const blocks = [image(tiny), image(tiny)];
    const { replacements, collapsed } = dedupImages(touchable(blocks));
    expect(collapsed).toBe(0);
    expect(replacements.every((r) => r === null)).toBe(true);
  });
});
