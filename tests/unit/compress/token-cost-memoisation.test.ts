/**
 * TOKEN COST IS MEMOISED, AND A MEMOISED COUNT MUST BE THE COUNT.
 *
 * `tokenCost` is the price signal the JSON engine decides swaps with: a count
 * that is wrong in the cheap direction approves a swap that costs real tokens.
 * It was 20.5% of one `compressBlock` of the gate's `relevance-probe` payload,
 * and 3,728 of its 4,248 calls there re-walked a string already counted, so it
 * now caches. These tests hold the two things caching can break: a hit that
 * returns the wrong number, and a cache that grows without bound inside a
 * long-lived server process.
 */

import { describe, expect, it } from '@jest/globals';
import {
  tokenCost,
  tokenCostCacheOccupancy,
} from '../../../src/compress/json-fragments.js';

// THE INDEPENDENT WALK. Deliberately a second copy of the pattern rather than
// an import: a test that reuses the implementation's own regex object cannot
// tell a memoised answer from a computed one, which is the whole question here.
const WALK =
  /'(?:[sdmt]|ll|ve|re)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
function walkCost(text: string): number {
  let n = 0;
  WALK.lastIndex = 0;
  while (WALK.exec(text) !== null) n += 1;
  return n;
}

const CORPUS = [
  '',
  ' ',
  '\n',
  'a',
  '{"id":1,"name":"widget","tags":["a","b"]}',
  '{"id":2,"name":"widget","tags":["a","b"]}',
  'the waiter reports a pending publish separately from a broken one',
  "it's a contraction, and they're the hard case for the pattern",
  '2026-10-09T11:22:33.456Z',
  '   leading and trailing   ',
  'punctuation!!!...???---===',
  '\r\n\r\nwindows newlines\r\n',
  'unicode: naïve café 日本語 \u00e9\u0301',
  '1 12 123 1234 12345 123456',
  'a'.repeat(5000),
  JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ i, v: `row ${i}` })) }),
];

describe('tokenCost memoisation returns the same count as a fresh walk', () => {
  it.each(CORPUS.map((s, i) => [i, s] as const))(
    'agrees with an independent walk on corpus entry %i',
    (_i, text) => {
      expect(tokenCost(text)).toBe(walkCost(text));
    }
  );

  it('returns the identical count on a repeat call, which is the cached path', () => {
    for (const text of CORPUS) {
      const first = tokenCost(text);
      // THE POSITIVE CONTROL for the cache being used at all: without it this
      // file would pass equally well against a `tokenCost` that never cached.
      expect(tokenCost(text)).toBe(first);
      expect(first).toBe(walkCost(text));
    }
  });

  it('does not confuse strings that share a prefix or differ only in trailing space', () => {
    const near = ['value', 'value ', 'value  ', 'values', 'value\n', ' value'];
    const expected = near.map((s) => walkCost(s));
    // Costed once to fill the cache, then again to read it back.
    near.forEach((s) => tokenCost(s));
    expect(near.map((s) => tokenCost(s))).toEqual(expected);
  });
});

describe('the cache is bounded', () => {
  // THE CAP IS DRIVEN PAST DELIBERATELY. The clear-on-overflow branch is the
  // one a correctness bug would hide in, because it runs only after thousands
  // of distinct strings, which no other test in this suite reaches.
  const distinct = (n: number, pad: number) =>
    Array.from({ length: n }, (_, i) => `k${i}:${'x'.repeat(pad)}`);

  it('still counts correctly after more distinct strings than the entry cap', () => {
    const many = distinct(9000, 4);
    many.forEach((s) => tokenCost(s));
    const probes = [many[0], many[4500], many[8999], 'a fresh string after the clear'];
    expect(probes.map((s) => tokenCost(s))).toEqual(probes.map((s) => walkCost(s)));
  });

  it('holds no more than its declared bound after far more keys than fit', () => {
    // 24000 x ~1KB = ~24MB of distinct keys against a 4MB byte cap. The keys
    // are built inside the loop and never collected into an array, so nothing
    // but the cache can still be holding them.
    //
    // ASSERTED AS OCCUPANCY, NOT AS HEAP. The first version of this test read
    // `process.memoryUsage().heapUsed` either side of the loop; it passed on
    // its own and failed inside the full suite, because without a forced
    // collection that delta measures the whole worker, not this map.
    let last = '';
    for (let i = 0; i < 24000; i += 1) {
      last = `k${i}:${'x'.repeat(1024)}`;
      tokenCost(last);
    }
    const held = tokenCostCacheOccupancy();
    expect(held.entries).toBeLessThanOrEqual(held.maxEntries);
    expect(held.bytes).toBeLessThanOrEqual(held.maxBytes);
    // THE POSITIVE CONTROL: the loop really did fill it, so the bounds above
    // are holding something back rather than describing an empty map.
    expect(held.entries).toBeGreaterThan(0);
    // And it is still correct with a cache that has been cleared under it.
    expect(tokenCost(last)).toBe(walkCost(last));
  });

  it('refuses to cache a fragment that cannot fit the bound on its own', () => {
    // REVIEW FINDING ON #472, AND A REAL ONE. The guard used to clear and then
    // insert regardless, so a single oversized key sat in a long-lived server
    // with occupancy above its own declared ceiling. Every key in the test
    // above is 1KB, which is why none of them caught it.
    //
    // BUILT FROM MANY SHORT TOKENS, and sized from `maxBytes` rather than a
    // hardcoded number. A first version used `'x'.repeat(5 * 1024 * 1024)`,
    // which the pretoken pattern matches as ONE multi-million-character match:
    // that overflowed the regex backtracking stack under coverage and failed
    // all four CI Node shards with `Maximum call stack size exceeded` while
    // passing under a bare `jest` run locally.
    const bound = tokenCostCacheOccupancy().maxBytes;
    const oversized = 'word '.repeat(Math.ceil(bound / 2 / 5) + 1);
    expect(oversized.length * 2).toBeGreaterThan(bound);

    const expected = walkCost(oversized);
    const before = tokenCostCacheOccupancy();
    expect(tokenCost(oversized)).toBe(expected);
    const after = tokenCostCacheOccupancy();
    // Refused outright: nothing stored, and nothing evicted to make room.
    expect(after.bytes).toBe(before.bytes);
    expect(after.entries).toBe(before.entries);
    expect(after.bytes).toBeLessThanOrEqual(after.maxBytes);
    // Still answers correctly on the way back out, uncached.
    expect(tokenCost(oversized)).toBe(expected);
  });

  it('accounts a multibyte fragment at two bytes per code unit', () => {
    // REVIEW FINDING ON #472: `text.length` is UTF-16 code units, not bytes,
    // so a run of CJK was accounted at half what it retains.
    //
    // THIS ASSERTION HAD TO BE EARNED. A first version costed a 3M-unit CJK
    // string and asserted only that the ceiling still held -- which it does
    // either way, so mutating the measure back to `text.length` passed it.
    // The accounting itself is what has to be observed.
    const cjk = '\u6f22'.repeat(1000) + 'unique-multibyte-accounting-probe';
    const units = cjk.length;
    const before = tokenCostCacheOccupancy();
    tokenCost(cjk);
    const after = tokenCostCacheOccupancy();
    // Either this entry was added to the set already there, or the insert
    // cleared first and it is now all that is left. Both say two bytes a unit.
    expect([after.bytes - before.bytes, after.bytes]).toContain(units * 2);
  });

  it('refuses a multibyte fragment whose retention exceeds the bound', () => {
    // The case the measure exists for: counted as code units this fits under
    // the ceiling, counted as retention it does not. Short tokens again, for
    // the stack reason given above.
    const bound = tokenCostCacheOccupancy().maxBytes;
    const units = Math.ceil(bound / 2 / 3) + 1;
    const huge = '\u6f22\u5b57 '.repeat(units);
    expect(huge.length).toBeLessThan(bound);
    expect(huge.length * 2).toBeGreaterThan(bound);

    const before = tokenCostCacheOccupancy();
    expect(tokenCost(huge)).toBe(walkCost(huge));
    const after = tokenCostCacheOccupancy();
    expect(after.bytes).toBe(before.bytes);
    expect(after.entries).toBe(before.entries);
    expect(after.bytes).toBeLessThanOrEqual(after.maxBytes);
  });

  it('agrees with a fresh walk on multibyte text that does fit', () => {
    const small = ['\u6f22\u5b57 and latin', '\ud83d\ude80\ud83d\ude80 rocket', 'caf\u00e9 na\u00efve'];
    small.forEach((t) => tokenCost(t));
    expect(small.map((t) => tokenCost(t))).toEqual(small.map((t) => walkCost(t)));
  });
});
