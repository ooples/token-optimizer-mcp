/**
 * The other half of the lossless contract: engines that must never claim it.
 *
 * `dedupBlocks` claims `lossless: true` on output it rewrote, and earns it by
 * leaving the bytes elsewhere in the same request -- `dedup-round-trip.test.ts`
 * reconstructs them to prove it. `foldRepeatedSegments` and `compressCode` make
 * no such promise: for them the claim is only ever "I did not touch this", so
 * the contract is the strict one, and it is checkable without reconstructing
 * anything.
 *
 * WHY THIS IS WORTH A TEST WHEN IT HOLDS TRIVIALLY TODAY. segments.ts:111-119
 * records that breaking it already shipped once -- output that could not be
 * reconstructed was reported as lossless, which is the one mode where that
 * answer is load-bearing. Both engines currently say `false` on every folding
 * path, so nothing here is asserting a bug; it is a ratchet against the
 * specific regression the source says happened before.
 */
import { describe, it, expect } from '@jest/globals';
import { foldRepeatedSegments } from '../../../src/compress/segments.js';
import { compressCode } from '../../../src/compress/code.js';
import { DEFAULT_TUNING } from '../../../src/compress/options.js';
import type { CompressionResult } from '../../../src/compress/types.js';

/** `lossless` means the output IS the input, for these two engines. */
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
  // which is why both engines carry a second `lossless` literal, inside the
  // elision itself.
  for (const elision of result.elisions) {
    expect(elision.lossless).toBe(false);
    expect(elision.recoverAt).not.toBeNull();
  }
}

const repeated = (() => {
  const section = `# Heading\n${'detail '.repeat(120)}`;
  return Array(12).fill(section).join('\n');
})();

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

describe('an engine that folds never reports the result as lossless', () => {
  it('holds for foldRepeatedSegments, on every context it accepts', () => {
    const inputs = [repeated, 'no repetition here at all', ''];
    const contexts = [{}, { spill: () => '' }, { spill: () => '/rec/s.txt' }];
    let folded = 0;
    for (const input of inputs) {
      for (const ctx of contexts) {
        const result = foldRepeatedSegments(input, ctx);
        assertStrict(input, result);
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
