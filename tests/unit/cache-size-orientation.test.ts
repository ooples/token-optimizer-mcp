import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CacheEngine } from '../../src/core/cache-engine.js';

/**
 * The cache records an original size and a compressed size, and every
 * compression statistic is derived from the two.
 *
 * Two call sites passed them the wrong way round -- the signature is
 * `set(key, value, originalSize, compressedSize)` and they passed
 * `compressedSize, originalSize`. Measured live: writing 5,000 highly
 * compressible characters reported `totalOriginalSize: 13,
 * totalCompressedSize: 5000`, and a compressionRatio of 384.6.
 *
 * A compression ratio ABOVE 1 means expansion, so the statistic claimed the
 * cache was making data 384x larger while it was in fact storing it ~384x
 * smaller. Nothing errors, both numbers look plausible in isolation, and only
 * their ORIENTATION is wrong -- which is why a test has to assert the
 * relationship rather than the presence of the fields.
 */

describe('cache size statistics are the right way round', () => {
  let dir: string;
  let cache: CacheEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cache-orientation-'));
    cache = new CacheEngine(join(dir, 'cache.db'), 100);
  });

  afterEach(() => {
    cache.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp dir, reclaimed by the OS */
    }
  });

  /** Deliberately lopsided, so a swap cannot hide behind similar numbers. */
  const ORIGINAL = 5000;
  const COMPRESSED = 13;

  it('reports the original size that was written', () => {
    cache.set('k', 'stored value', ORIGINAL, COMPRESSED);

    expect(cache.getStats().totalOriginalSize).toBe(ORIGINAL);
  });

  it('reports the compressed size that was written', () => {
    cache.set('k', 'stored value', ORIGINAL, COMPRESSED);

    expect(cache.getStats().totalCompressedSize).toBe(COMPRESSED);
  });

  it('never reports a compressed size larger than the original', () => {
    cache.set('k', 'stored value', ORIGINAL, COMPRESSED);

    const { totalCompressedSize, totalOriginalSize } = cache.getStats();
    expect(totalCompressedSize).toBeLessThanOrEqual(totalOriginalSize);
  });

  it('yields a compression ratio below 1, because compression shrinks', () => {
    cache.set('k', 'stored value', ORIGINAL, COMPRESSED);

    // The swap produced 384.6 here. Any value above 1 describes expansion.
    const { compressionRatio } = cache.getStats();
    expect(compressionRatio).toBeGreaterThan(0);
    expect(compressionRatio).toBeLessThan(1);
  });

  it('derives the ratio from the two sizes it reports', () => {
    cache.set('k', 'stored value', ORIGINAL, COMPRESSED);

    const { compressionRatio, totalCompressedSize, totalOriginalSize } = cache.getStats();
    expect(compressionRatio).toBeCloseTo(totalCompressedSize / totalOriginalSize, 6);
  });

  it('keeps the orientation across several entries', () => {
    for (let i = 0; i < 5; i++) {
      cache.set(`k${i}`, `value ${i}`, ORIGINAL, COMPRESSED);
    }

    const { totalOriginalSize, totalCompressedSize } = cache.getStats();
    expect(totalOriginalSize).toBe(ORIGINAL * 5);
    expect(totalCompressedSize).toBe(COMPRESSED * 5);
  });
});
