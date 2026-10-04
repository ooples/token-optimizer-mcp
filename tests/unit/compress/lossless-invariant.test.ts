/**
 * The other half of the lossless contract: a claim of it is never free.
 *
 * There are exactly two ways to earn the claim, and an engine has to be held to
 * whichever one it is making.
 *
 * EARNED BY RECONSTRUCTION. `dedupBlocks` rewrites its output and still says
 * `lossless: true`, because the bytes stay reachable elsewhere in the same
 * request -- `dedup-round-trip.test.ts` rebuilds them to prove it.
 * `foldRepeatedSegments` now earns it the same way on its heading cut, where
 * the sections it kept plus the order vector it writes inline are the original;
 * so it is held to the same standard here, by round-tripping every folded
 * output through `rehydrate` rather than by trusting the flag.
 *
 * EARNED BY ABSTENTION. `compressCode` makes no such promise: for it the claim
 * only ever means "I did not touch this", so the contract stays the strict one
 * and needs nothing reconstructed to check.
 *
 * WHY EITHER IS WORTH A TEST. segments.ts records that breaking this already
 * shipped once -- output that could not be reconstructed was reported as
 * lossless, which is the one mode where that answer is load-bearing. The point
 * is not which branch an engine takes but that a `true` is always backed.
 */
import { describe, it, expect } from '@jest/globals';
import { foldRepeatedSegments } from '../../../src/compress/segments.js';
import { rehydrate } from '../../../src/compress/rehydrate.js';
import { compressCode } from '../../../src/compress/code.js';
import { DEFAULT_TUNING } from '../../../src/compress/options.js';
import type { CompressionResult } from '../../../src/compress/types.js';

/** `lossless` means the output IS the input, for an engine that only abstains. */
function assertStrict(input: string, result: CompressionResult): void {
  if (result.lossless) {
    expect(result.text).toBe(input);
    expect(result.elisions).toEqual([]);
    return;
  }
  expect(result.text).not.toBe(input);
  // THE PER-ELISION FLAG IS THE ONE THE REGISTRY READS, and the result-level
  // assertion above cannot see it. registry.ts:183 rejects an elision with no
  // `recoverAt` only when that elision admits `lossless: false`, so one elision
  // lying there drops bytes with no route back while the result stays honest --
  // which is why the engine carries a second `lossless` literal, inside the
  // elision itself.
  // AN EMPTY LIST SATISFIES EVERY LOOP BELOW. Rewritten output that admits
  // `lossless: false` and then names nothing removed passes this test while
  // telling the reader nothing about where its content went, so the metadata
  // is required before it is inspected.
  expect(result.elisions.length).toBeGreaterThan(0);
  for (const elision of result.elisions) {
    expect(elision.lossless).toBe(false);
    expect(elision.recoverAt).not.toBeNull();
  }
}

/**
 * `lossless` means the output can be turned back into the input.
 *
 * The strict contract above cannot be used on an engine that rewrites and is
 * still right to claim the flag, so this one spends the reconstruction instead:
 * whatever the engine hands back, `rehydrate` has to give the input back from
 * it. That is a stronger check than "the text did not change", not a weaker
 * one -- it fails both on content that went missing and on content that came
 * back in the wrong order, which is the failure an order-carrying fold can
 * actually have.
 */
function assertRecoverable(input: string, result: CompressionResult): void {
  if (!result.lossless) {
    expect(result.text).not.toBe(input);
    expect(result.elisions.length).toBeGreaterThan(0);
    for (const elision of result.elisions) {
      expect(elision.lossless).toBe(false);
      // Content it cannot rebuild has to name where the original went.
      expect(elision.recoverAt).not.toBeNull();
    }
    return;
  }
  if (result.text === input) {
    expect(result.elisions).toEqual([]);
    return;
  }
  // A REWRITE THAT CLAIMS THE FLAG PAYS FOR IT HERE. Every elision must own the
  // claim too, and must name no recovery path -- a lossless elision pointing at
  // a spill would be asking for a round trip it does not need, and the cost
  // model prices that round trip.
  expect(result.elisions.length).toBeGreaterThan(0);
  for (const elision of result.elisions) {
    expect(elision.lossless).toBe(true);
    expect(elision.recoverAt).toBeNull();
  }
  expect(rehydrate(result.text, result.stamp)).toBe(input);
}

const repeated = (() => {
  const section = `# Heading\n${'detail '.repeat(120)}`;
  return Array(12).fill(section).join('\n');
})();

/** The other cut: no headings to split on, so `segment` falls to blank lines. */
const paragraphs = Array(12).fill('detail '.repeat(120)).join('\n\n');

const source = [
  "import { join } from 'node:path';",
  ...Array.from(
    { length: 6 },
    (_, i) =>
      `export function handler${i}(value: string): string {\n` +
      `  const parts = value.split(':');\n`.repeat(8) +
      `  return join(parts[0], '${i}');\n}`
  ),
].join('\n\n');

describe('an engine never claims lossless without backing it', () => {
  it('holds for foldRepeatedSegments, on every context it accepts', () => {
    // BOTH CUTS, because they earn the flag in different ways and only one of
    // them can reconstruct: `repeated` splits on headings and folds inline,
    // `paragraphs` splits on blank lines and has to name a spill.
    const inputs = [repeated, paragraphs, 'no repetition here at all', ''];
    const contexts = [{}, { spill: () => '' }, { spill: () => '/rec/s.txt' }];
    let folded = 0;
    for (const input of inputs) {
      for (const ctx of contexts) {
        const result = foldRepeatedSegments(input, ctx);
        assertRecoverable(input, result);
        if (result.text !== input) folded += 1;
      }
    }
    // NOT VACUOUS: if nothing ever folded, every result would be the identity
    // and the invariant would be satisfied by an engine that does nothing.
    expect(folded).toBeGreaterThan(0);
  });

  it('holds for compressCode, lossy tuning included', () => {
    const inputs = [source, 'const x = 1;', ''];
    // A BODY IS ONLY FOLDED WHEN THERE IS SOMEWHERE TO POINT AT. Without
    // sourcePath the engine has no recovery location to name, so it declines
    // and returns the input -- keep one such context to cover that path, and
    // give the rest a path so the fold actually happens.
    const contexts = [
      {},
      { sourcePath: 'src/w.ts' },
      {
        sourcePath: 'src/w.ts',
        tuning: { ...DEFAULT_TUNING, allowLossy: false },
      },
      {
        sourcePath: 'src/w.ts',
        tuning: { ...DEFAULT_TUNING, allowLossy: true },
      },
    ];
    let rewritten = 0;
    for (const input of inputs) {
      for (const ctx of contexts) {
        const result = compressCode(input, ctx);
        assertStrict(input, result);
        if (result.text !== input) rewritten += 1;
      }
    }
    expect(rewritten).toBeGreaterThan(0);
  });
});
