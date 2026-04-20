import { describe, it, expect } from '@jest/globals';
import { LruCache } from '../../src/utils/lru-cache.js';

describe('LruCache', () => {
  it('rejects non-positive maxSize', () => {
    expect(() => new LruCache<string, number>(0)).toThrow();
    expect(() => new LruCache<string, number>(-1)).toThrow();
  });

  it('get returns undefined on miss and counts it', () => {
    const cache = new LruCache<string, number>(2);
    expect(cache.get('x')).toBeUndefined();
    expect(cache.stats().misses).toBe(1);
  });

  it('set/get round-trips and counts hits', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.stats().hits).toBe(1);
  });

  it('evicts the least recently used entry when full', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.stats().evictions).toBe(1);
  });

  it('refreshes recency on get', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);

    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
  });

  it('expires entries past the TTL', async () => {
    const cache = new LruCache<string, number>(2, 20);
    cache.set('a', 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.stats().expired).toBe(1);
  });

  it('prune removes expired entries', async () => {
    const cache = new LruCache<string, number>(4, 20);
    cache.set('a', 1);
    cache.set('b', 2);
    await new Promise((r) => setTimeout(r, 30));
    cache.set('c', 3);
    const removed = cache.prune();
    expect(removed).toBe(2);
    expect(cache.size).toBe(1);
  });

  it('stats.hitRate reflects hits / total', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.get('a');
    cache.get('a');
    cache.get('missing');
    const stats = cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3);
  });
});
