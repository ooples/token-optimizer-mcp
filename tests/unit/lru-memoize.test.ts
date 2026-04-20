import { describe, it, expect } from '@jest/globals';
import { lruMemoize, memoRegistry } from '../../src/utils/lru-memoize.js';

describe('lruMemoize', () => {
  it('returns cached value for identical args', async () => {
    let calls = 0;
    const fn = async (x: number) => {
      calls++;
      return x * 2;
    };
    const memo = lruMemoize(fn, { name: 'test-double', maxSize: 10 });
    expect(await memo(3)).toBe(6);
    expect(await memo(3)).toBe(6);
    expect(calls).toBe(1);
  });

  it('differentiates calls by args', async () => {
    let calls = 0;
    const fn = async (x: number) => {
      calls++;
      return x * 2;
    };
    const memo = lruMemoize(fn, { name: 'test-by-args', maxSize: 10 });
    await memo(1);
    await memo(2);
    await memo(1);
    expect(calls).toBe(2);
  });

  it('expires entries past the TTL', async () => {
    let calls = 0;
    const fn = async (x: number) => {
      calls++;
      return x;
    };
    const memo = lruMemoize(fn, { name: 'test-ttl', maxSize: 10, ttlMs: 20 });
    await memo(7);
    await memo(7);
    expect(calls).toBe(1);
    await new Promise((r) => setTimeout(r, 30));
    await memo(7);
    expect(calls).toBe(2);
  });

  it('registers with memoRegistry for bulk prune / stats', async () => {
    const fn = async (x: string) => x.toUpperCase();
    lruMemoize(fn, { name: 'test-registered', maxSize: 5 });
    const stats = memoRegistry.stats();
    expect(stats['test-registered']).toBeDefined();
    expect(stats['test-registered'].size).toBe(0);
  });

  it('accepts a custom key function', async () => {
    let calls = 0;
    const fn = async (obj: { id: string; ignore: number }) => {
      calls++;
      return obj.id;
    };
    const memo = lruMemoize(fn, {
      name: 'test-custom-key',
      maxSize: 5,
      keyFn: ([{ id }]) => id,
    });
    await memo({ id: 'a', ignore: 1 });
    await memo({ id: 'a', ignore: 9999 }); // same id → hit
    await memo({ id: 'b', ignore: 1 }); // different id → miss
    expect(calls).toBe(2);
  });

  it('deduplicates concurrent calls for the same args', async () => {
    let calls = 0;
    const fn = async (x: number) => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return x * 2;
    };
    const memo = lruMemoize(fn, { name: 'test-concurrent', maxSize: 10 });
    const [a, b] = await Promise.all([memo(5), memo(5)]);
    expect(a).toBe(10);
    expect(b).toBe(10);
    // Stampede collapsed into a single invocation.
    expect(calls).toBe(1);
  });

  it('memoizes a legitimately-undefined return value', async () => {
    let calls = 0;
    const fn = async (): Promise<undefined> => {
      calls++;
      return undefined;
    };
    const memo = lruMemoize(fn, { name: 'test-undefined', maxSize: 10 });
    expect(await memo()).toBeUndefined();
    expect(await memo()).toBeUndefined();
    // Without envelope-style storage, the second call would re-run fn.
    expect(calls).toBe(1);
  });

  it('distinguishes bigint args from string args in the default key', async () => {
    let calls = 0;
    const fn = async (x: unknown) => {
      calls++;
      return String(x);
    };
    const memo = lruMemoize(fn as (x: unknown) => Promise<string>, {
      name: 'test-bigint-collision',
      maxSize: 10,
    });
    expect(await memo(1n)).toBe('1');
    expect(await memo('1')).toBe('1');
    // Two distinct args ⇒ two distinct cache keys ⇒ two invocations.
    expect(calls).toBe(2);
  });
});
