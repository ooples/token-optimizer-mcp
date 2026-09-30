import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { CacheEngine } from '../../src/core/cache-engine.js';

/**
 * THE CACHE HAD NO EXPIRY AT ALL.
 *
 * `set(key, value, originalSize, compressedSize)` took two byte sizes and
 * nothing else, and the table had no expiry column, so nothing a tool wrote
 * ever stopped being served. Thirty-one call sites nonetheless passed a TTL --
 * `set(key, value, 86400, tokensSaved)`, `set(key, value, 300, tokensSaved)`,
 * `set(key, value, 0, maxAge)` -- because the intent was real and the
 * parameter was not. Every one of those recorded its TTL as a byte size, which
 * both corrupted the size columns every compression statistic is derived from
 * and expired nothing, ever.
 *
 * The control arm in each pair below writes the SAME value with no TTL. If a
 * miss shows up there too, the fixture is broken and the test proves nothing
 * about expiry.
 */

/** Long enough that no run can outlive it. */
const NEVER_IN_PRACTICE = 3600;
/** Short enough that the sleep below cannot fail to outlast it. */
const ALREADY_GONE = 0.02;
const SLEEP_MS = 80;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('cache entries expire when they were given a TTL', () => {
  let dir: string;
  let cache: CacheEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cache-expiry-'));
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

  it('serves an entry that has not reached its TTL', () => {
    cache.set('live', 'payload', 100, 50, { ttlSeconds: NEVER_IN_PRACTICE });

    expect(cache.get('live')).toBe('payload');
  });

  it('stops serving an entry once its TTL has passed', async () => {
    cache.set('doomed', 'payload', 100, 50, { ttlSeconds: ALREADY_GONE });
    cache.set('control', 'payload', 100, 50);
    await sleep(SLEEP_MS);

    // Control first: the same value, same age, written without a TTL. It has
    // to still be there, or the miss below is the read path and not the TTL.
    expect(cache.get('control')).toBe('payload');
    expect(cache.get('doomed')).toBeNull();
  });

  it('stops serving an expired entry that is already in the memory tier', async () => {
    cache.set('doomed', 'payload', 100, 50, { ttlSeconds: ALREADY_GONE });
    cache.set('control', 'payload', 100, 50);
    // Read both now, so the hot path below is the in-memory LRU and not SQLite.
    expect(cache.get('doomed')).toBe('payload');
    expect(cache.get('control')).toBe('payload');
    await sleep(SLEEP_MS);

    expect(cache.get('control')).toBe('payload');
    expect(cache.get('doomed')).toBeNull();
  });

  it('stops serving an expired entry through getWithMetadata', async () => {
    cache.set('doomed', 'payload', 100, 50, { ttlSeconds: ALREADY_GONE });
    cache.set('control', 'payload', 100, 50);
    await sleep(SLEEP_MS);

    expect(cache.getWithMetadata('control')?.content).toBe('payload');
    expect(cache.getWithMetadata('doomed')).toBeNull();
  });

  it('restarts the clock when an entry is written again', async () => {
    cache.set('renewed', 'first', 100, 50, { ttlSeconds: ALREADY_GONE });
    cache.set('renewed', 'second', 100, 50, { ttlSeconds: NEVER_IN_PRACTICE });
    await sleep(SLEEP_MS);

    expect(cache.get('renewed')).toBe('second');
  });

  it('treats a zero or negative TTL as no expiry, like the four-argument form', async () => {
    cache.set('zero', 'payload', 100, 50, { ttlSeconds: 0 });
    cache.set('negative', 'payload', 100, 50, { ttlSeconds: -1 });
    await sleep(SLEEP_MS);

    expect(cache.get('zero')).toBe('payload');
    expect(cache.get('negative')).toBe('payload');
  });

  it('keeps a four-argument write forever, so no existing caller loses its cache', async () => {
    cache.set('legacy', 'payload', 100, 50);
    await sleep(SLEEP_MS);

    expect(cache.get('legacy')).toBe('payload');
  });
});

describe('an expired entry is not part of the cache anything reports on', () => {
  let dir: string;
  let cache: CacheEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cache-expiry-stats-'));
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

  it('counts a live entry and not an expired one', async () => {
    cache.set('control', 'payload', 4000, 40);
    cache.set('doomed', 'payload', 7000, 70, { ttlSeconds: ALREADY_GONE });
    // Control before the sleep: both are counted while both are live, so a
    // count of 1 afterwards is the expiry and not a write that never landed.
    expect(cache.getStats().totalEntries).toBe(2);
    await sleep(SLEEP_MS);

    const stats = cache.getStats();
    expect(stats.totalEntries).toBe(1);
    expect(stats.totalOriginalSize).toBe(4000);
    expect(stats.totalCompressedSize).toBe(40);
  });

  it('lists a live entry and not an expired one', async () => {
    cache.set('control', 'payload', 4000, 40);
    cache.set('doomed', 'payload', 7000, 70, { ttlSeconds: ALREADY_GONE });
    expect(cache.getAllEntries().map((e) => e.key).sort()).toEqual([
      'control',
      'doomed',
    ]);
    await sleep(SLEEP_MS);

    expect(cache.getAllEntries().map((e) => e.key)).toEqual(['control']);
  });

  it('evicts an expired entry even when the size limit would have kept it', async () => {
    cache.set('control', 'payload', 4000, 40);
    cache.set('doomed', 'payload', 7000, 70, { ttlSeconds: ALREADY_GONE });
    await sleep(SLEEP_MS);

    // A limit far above both entries: nothing here is evicted for size, so the
    // one removal is the expired row.
    expect(cache.evictLRU(10_000_000)).toBe(1);
    expect(cache.get('control')).toBe('payload');
  });

  it('evicts nothing under the same limit when neither entry has a TTL', () => {
    cache.set('control', 'payload', 4000, 40);
    cache.set('other', 'payload', 7000, 70);

    // The control for the row above: the limit is what keeps both, so the
    // eviction there cannot have been the limit.
    expect(cache.evictLRU(10_000_000)).toBe(0);
    expect(cache.get('other')).toBe('payload');
  });
});

describe('a cache database written before expiry existed still opens', () => {
  let dir: string;
  let dbPath: string;

  /** Exactly the schema that shipped, with no expires_at column. */
  const OLD_SCHEMA = `
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      compressed_size INTEGER NOT NULL,
      original_size INTEGER NOT NULL,
      hit_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL
    );
  `;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cache-expiry-migrate-'));
    dbPath = join(dir, 'cache.db');

    // CREATE TABLE IF NOT EXISTS leaves an existing table exactly as it is, so
    // without a migration every query naming expires_at fails against a cache
    // that was already on disk -- which is every installed user's cache.
    const legacy = new Database(dbPath);
    legacy.exec(OLD_SCHEMA);
    legacy
      .prepare(
        'INSERT INTO cache (key, value, compressed_size, original_size, ' +
          'hit_count, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run('legacy', 'payload', 40, 4000, 0, Date.now(), Date.now());
    legacy.close();
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp dir, reclaimed by the OS */
    }
  });

  it('still serves what the old database already held', () => {
    const cache = new CacheEngine(dbPath, 100);
    try {
      expect(cache.get('legacy')).toBe('payload');
    } finally {
      cache.close();
    }
  });

  it('still reports on the old rows, which every expiry-aware query filters', () => {
    const cache = new CacheEngine(dbPath, 100);
    try {
      // getStats, getAllEntries and evictLRU all name expires_at now. A row
      // that predates the column has to read as never expiring, not vanish.
      expect(cache.getStats().totalEntries).toBe(1);
      expect(cache.getAllEntries().map((e) => e.key)).toEqual(['legacy']);
      expect(cache.evictLRU(10_000_000)).toBe(0);
    } finally {
      cache.close();
    }
  });

  it('can give a migrated row a TTL that then expires', async () => {
    const cache = new CacheEngine(dbPath, 100);
    try {
      cache.set('legacy', 'payload', 4000, 40, { ttlSeconds: ALREADY_GONE });
      await sleep(SLEEP_MS);

      expect(cache.get('legacy')).toBeNull();
    } finally {
      cache.close();
    }
  });
});
