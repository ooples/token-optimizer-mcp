import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import { SmartCacheTool } from '../../../src/tools/advanced-caching/smart-cache.js';

/**
 * A cache must not return what it was told to overwrite or forget.
 *
 * smart_cache memoized the RESULT of every `get`, `batch-get` and `stats` call
 * under `smart-cache:{operation, params}`, with no invalidation when a `set` or
 * `delete` changed the entry underneath. Those are exactly the three operations
 * that describe LIVE STATE, so the memo was wrong for all of them:
 *
 *   set k = ORIGINAL; get k; set k = UPDATED; get k  ->  ORIGINAL
 *   set k; get k; delete k; get k                    ->  the deleted value
 *
 * It bought nothing either. A `get` is a lookup in the in-memory L1/L2/L3 maps;
 * memoizing it substituted a SQLite read and a JSON.parse. It also polluted
 * `get_cache_stats`: every distinct `get` wrote an entry, so reads inflated the
 * entry count and each counted as a MISS, pinning the reported hit rate at zero
 * no matter how well the cache was working.
 */

const dirs: string[] = [];
const engines: CacheEngine[] = [];

afterEach(() => {
  while (engines.length) {
    try {
      engines.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (dirs.length) {
    const d = dirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* windows */
      }
    }
  }
});

function fixture(): { tool: SmartCacheTool; engine: CacheEngine } {
  const dir = mkdtempSync(join(tmpdir(), 'sc-live-'));
  dirs.push(dir);
  const engine = new CacheEngine(join(dir, 'c.db'));
  engines.push(engine);
  return {
    engine,
    tool: new SmartCacheTool(
      engine,
      new TokenCounter(),
      new MetricsCollector()
    ),
  };
}

const valueOf = (r: unknown): unknown =>
  (r as { data?: { value?: unknown } })?.data?.value;

describe('smart_cache reflects the current state', () => {
  it('returns the NEW value after an overwrite', async () => {
    const { tool } = fixture();
    await tool.run({ operation: 'set', key: 'k', value: 'ORIGINAL' });
    await tool.run({ operation: 'get', key: 'k' });

    await tool.run({ operation: 'set', key: 'k', value: 'UPDATED' });
    const after = await tool.run({ operation: 'get', key: 'k' });

    expect(valueOf(after)).toBe('UPDATED');
  });

  it('does not return a deleted value', async () => {
    const { tool } = fixture();
    await tool.run({ operation: 'set', key: 'k', value: 'PRESENT' });
    await tool.run({ operation: 'get', key: 'k' });

    await tool.run({ operation: 'delete', key: 'k' });
    const after = await tool.run({ operation: 'get', key: 'k' });

    expect(valueOf(after)).toBeUndefined();
  });

  it('does not return entries that were cleared', async () => {
    const { tool } = fixture();
    await tool.run({ operation: 'set', key: 'k', value: 'PRESENT' });
    await tool.run({ operation: 'get', key: 'k' });

    await tool.run({ operation: 'clear' });
    const after = await tool.run({ operation: 'get', key: 'k' });

    expect(valueOf(after)).toBeUndefined();
  });
});

describe('reading does not corrupt the statistics', () => {
  it('does not write a cache entry for every read', async () => {
    // Reads used to add one CacheEngine entry each, so 4 writes and 4 reads
    // reported 8 entries.
    const { tool, engine } = fixture();
    for (let i = 0; i < 4; i++) {
      await tool.run({ operation: 'set', key: `k${i}`, value: `v${i}` });
    }
    const afterWrites = engine.getStats().totalEntries;

    for (let i = 0; i < 4; i++)
      await tool.run({ operation: 'get', key: `k${i}` });
    const afterReads = engine.getStats().totalEntries;

    expect(afterReads).toBe(afterWrites);
  });

  it('does not count a successful read as a miss', async () => {
    const { tool, engine } = fixture();
    for (let i = 0; i < 4; i++) {
      await tool.run({ operation: 'set', key: `k${i}`, value: `v${i}` });
    }
    const before = engine.getStats().misses;
    for (let i = 0; i < 4; i++)
      await tool.run({ operation: 'get', key: `k${i}` });

    expect(engine.getStats().misses).toBe(before);
  });

  it('reports a truthful hit rate from its own stats', async () => {
    // The honest number was always available here; the memo was corrupting the
    // OTHER one. Four reads that all found their key are four hits.
    const { tool } = fixture();
    for (let i = 0; i < 4; i++) {
      await tool.run({ operation: 'set', key: `k${i}`, value: `v${i}` });
    }
    for (let i = 0; i < 4; i++)
      await tool.run({ operation: 'get', key: `k${i}` });

    const stats = await tool.run({ operation: 'stats' });
    const rate = (stats as { data?: { stats?: { overallHitRate?: number } } })
      ?.data?.stats?.overallHitRate;
    expect(rate).toBeGreaterThan(0);
  });
});
