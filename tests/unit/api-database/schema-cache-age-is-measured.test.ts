/**
 * A PUBLISHED DURATION HAS TO BE A SUBTRACTION OF TWO INSTANTS.
 *
 * `smart_schema` reported `cacheAge` on every cache hit and rendered it to the
 * caller as "*Cached result (age: 0ms)*". The line that produced it read
 *
 *     result.cacheAge = Date.now() - Date.now(); // Would need timestamp ...
 *
 * so the answer was zero by construction: a number presented as a measurement
 * that had never been measured, with the admission sitting in a comment beside
 * it. Nothing was recording when the entry had been written, so there was
 * nothing to subtract from.
 *
 * These tests drive the two private cache methods directly, because the public
 * path needs a live database connection and the thing under test is entirely
 * between the write and the read.
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SmartSchema } from '../../../src/tools/api-database/smart-schema.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';

/** The two methods under test, which the class declares private. */
interface SchemaCache {
  cacheResult(key: string, result: unknown): Promise<void>;
  getCachedResult(
    key: string
  ): Promise<{ cached: boolean; cacheAge?: number } | null>;
}

const dirs: string[] = [];
const caches: CacheEngine[] = [];

afterEach(() => {
  for (const c of caches.splice(0)) c.close?.();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tool(): SchemaCache {
  // A temp directory, never the real home cache.
  const dir = mkdtempSync(join(tmpdir(), 'schema-age-'));
  dirs.push(dir);
  const cache = new CacheEngine(join(dir, 'c.db'));
  caches.push(cache);
  return new SmartSchema(
    cache,
    new TokenCounter(),
    new MetricsCollector()
  ) as unknown as SchemaCache;
}

const RESULT = {
  analysis: { tables: 1, missingIndexes: [], issues: [] },
  cached: false,
};

describe('smart_schema reports a cache age it actually measured', () => {
  it('answers a hit with an age, not with zero', async () => {
    const t = tool();
    await t.cacheResult('k', RESULT);
    const before = Date.now();
    await new Promise((r) => setTimeout(r, 25));
    const hit = await t.getCachedResult('k');
    expect(hit).not.toBeNull();
    expect(hit?.cached).toBe(true);
    // The age has to have moved with the clock. A lower bound of 20ms against a
    // 25ms wait is the whole claim: the old code answered 0 here no matter how
    // long the entry had sat, and `toBeGreaterThan(0)` alone would also pass
    // for an age that was merely a different constant.
    expect(hit?.cacheAge).toBeGreaterThanOrEqual(20);
    expect(hit?.cacheAge).toBeLessThan(Date.now() - before + 5000);
  });

  it('says nothing about the age of an entry written without a stamp', async () => {
    // THE POSITIVE CONTROL FOR THE REFUSAL. An entry a previous build wrote
    // carries no `cachedAt`, and there is still no age to report -- so the
    // field is absent rather than present and zero, which is what the renderer
    // keys on to leave the age out of the sentence entirely.
    const t = tool();
    const cache = caches[caches.length - 1];
    const serialized = JSON.stringify(RESULT);
    cache.set(
      'legacy',
      serialized,
      Buffer.byteLength(serialized, 'utf-8'),
      Buffer.byteLength(serialized, 'utf-8')
    );
    const hit = await t.getCachedResult('legacy');
    expect(hit).not.toBeNull();
    expect(hit?.cached).toBe(true);
    expect(hit?.cacheAge).toBeUndefined();
  });

  it('does not leak the stamp into the published result', async () => {
    // `cachedAt` is a fact about the cache entry, not part of the answer about
    // the schema, so it is destructured off on the way back out and never
    // reaches a caller.
    const t = tool();
    await t.cacheResult('k', RESULT);
    const hit = await t.getCachedResult('k');
    expect(hit).not.toHaveProperty('cachedAt');
  });

  it('returns null for a key that was never written', async () => {
    // THE CONTROL that the two tests above are reading a real round trip and
    // not a method that answers the same way whatever it is handed.
    expect(await tool().getCachedResult('absent')).toBeNull();
  });
});
