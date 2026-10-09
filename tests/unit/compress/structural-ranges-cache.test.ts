/**
 * STRUCTURAL RANGES ARE CACHED, AND A CACHED RANGE LIST MUST NOT BE SHARED.
 *
 * `structuralRanges` runs once per line and the lines repeat: one
 * `compressBlock` of the gate's `raw-build-log` payload made 2,697 calls over
 * 1,536 distinct lines. It now caches, which makes the copy on the way out
 * load-bearing rather than tidy -- `variableSpans` in log.ts appends to the
 * result and sorts it in place, and the merge inside `structuralRanges`
 * mutates a tuple while it runs. A shared array would let the first caller
 * rewrite what every later caller is told, and nothing would throw.
 */

import { describe, expect, it } from '@jest/globals';
import {
  containsStructural,
  structuralRanges,
  structuralRangesCacheOccupancy,
} from '../../../src/compress/structural.js';

// A line carrying something the scanner protects, so these tests are about a
// real range list and not about empty arrays agreeing with each other.
const WITH_SECRET =
  'deploy failed: token=Zq7Z4mK9pR2tW5xB8nC3vD6yF1hJ0sL4 rejected by gateway';

describe('structuralRanges still answers correctly when cached', () => {
  it('finds ranges in a line that carries an identifier', () => {
    // THE POSITIVE CONTROL. Every assertion below is about a non-empty list,
    // so this file cannot pass against a scanner that found nothing.
    expect(structuralRanges(WITH_SECRET).length).toBeGreaterThan(0);
    expect(containsStructural(WITH_SECRET)).toBe(true);
  });

  it('returns an equal list on the cached call', () => {
    const first = structuralRanges(WITH_SECRET);
    expect(structuralRanges(WITH_SECRET)).toEqual(first);
  });

  it('finds nothing in a line that carries no identifier', () => {
    const plain = 'the build step finished and wrote no output of any kind';
    expect(structuralRanges(plain)).toEqual([]);
    expect(structuralRanges(plain)).toEqual([]);
  });
});

describe('a cached range list is never shared with the next caller', () => {
  it('survives a caller appending to the list it was given', () => {
    // What `variableSpans` does: it treats the result as its own and grows it.
    const mine = structuralRanges(WITH_SECRET);
    const expected = mine.length;
    mine.push([9999, 10000]);
    expect(structuralRanges(WITH_SECRET).length).toBe(expected);
  });

  it('survives a caller sorting the list it was given', () => {
    // What `variableSpans` also does, at log.ts:370.
    const mine = structuralRanges(WITH_SECRET);
    const expected = structuralRanges(WITH_SECRET);
    mine.reverse();
    expect(structuralRanges(WITH_SECRET)).toEqual(expected);
  });

  it('survives a caller rewriting a tuple inside the list', () => {
    // The merge inside `structuralRanges` does exactly this to `last[1]`, so
    // tuples are not inert and a shallow copy would not be enough.
    const mine = structuralRanges(WITH_SECRET);
    const before = structuralRanges(WITH_SECRET);
    mine[0][0] = -1;
    mine[0][1] = -2;
    expect(structuralRanges(WITH_SECRET)).toEqual(before);
  });

  it('survives the FIRST caller mutating what the first call returned', () => {
    // THE GAP THE OTHER TESTS LEFT. They all reuse a key an earlier test has
    // already cached, so they only ever exercise a cache HIT. On a MISS the
    // value is both stored and returned, and storing the same array that is
    // handed back lets the very first caller corrupt the entry for everyone
    // after it. Mutating this one found nothing until the key was fresh:
    // dropping the copy on the store path passed all nine other tests.
    const fresh =
      'first-miss probe: token=Hn3K8wQ2zF5bR7vX1cM4yT6pL9sD0gJ5 done';
    const onMiss = structuralRanges(fresh);
    expect(onMiss.length).toBeGreaterThan(0);
    const expected = onMiss.map((r) => [r[0], r[1]]);
    onMiss.push([12345, 12346]);
    onMiss[0][0] = -1;
    expect(structuralRanges(fresh)).toEqual(expected);
  });

  it('hands out a different array object each time', () => {
    expect(structuralRanges(WITH_SECRET)).not.toBe(
      structuralRanges(WITH_SECRET)
    );
  });
});

describe('the structural ranges cache is bounded', () => {
  it('holds no more than its declared bound after far more keys than fit', () => {
    // Built inside the loop so nothing but the cache can retain them.
    for (let i = 0; i < 24000; i += 1) {
      structuralRanges(`line ${i}: token=abc${i}def${'x'.repeat(40)}`);
    }
    const held = structuralRangesCacheOccupancy();
    expect(held.entries).toBeLessThanOrEqual(held.maxEntries);
    expect(held.bytes).toBeLessThanOrEqual(held.maxBytes);
    expect(held.entries).toBeGreaterThan(0);
  });

  it('refuses a line too large to fit the bound on its own', () => {
    // Short tokens, sized from the declared bound: a single giant token would
    // overflow the regex backtracking stack under coverage, which is how the
    // equivalent test on #472 failed all four CI shards.
    const bound = structuralRangesCacheOccupancy().maxBytes;
    const oversized = 'word '.repeat(Math.ceil(bound / 2 / 5) + 1);
    expect(oversized.length * 2).toBeGreaterThan(bound);

    const before = structuralRangesCacheOccupancy();
    const ranges = structuralRanges(oversized);
    const after = structuralRangesCacheOccupancy();
    expect(after.bytes).toBe(before.bytes);
    expect(after.entries).toBe(before.entries);
    // And still answers the same thing uncached.
    expect(structuralRanges(oversized)).toEqual(ranges);
  });
});
