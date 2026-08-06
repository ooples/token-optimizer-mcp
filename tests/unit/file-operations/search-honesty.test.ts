import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SmartGrepTool } from '../../../src/tools/file-operations/smart-grep.js';
import { SmartGlobTool } from '../../../src/tools/file-operations/smart-glob.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';

/**
 * The search tools must cap what they return, and must not invent what they
 * saved.
 *
 * Both defects were found by measuring the real tools against a real
 * repository rather than reading their metadata:
 *
 *   - `limit` defaulted to Infinity, so one `grep 'export function'` with
 *     context produced a 481,578-token response. That is more than twice a
 *     200k context window, produced by the tool the hook REFUSES the built-in
 *     Grep in favour of, on the promise that it "caps and deduplicates results
 *     before they reach the context window".
 *
 *   - Savings were a multiplier. smart_grep priced its result at 100x, 20x or
 *     5x depending on mode; smart_glob at 50x. Listing 2,400 paths claimed
 *     117,943 tokens saved without having read a single file.
 */
describe('search tools bound their output', () => {
  const dirs: string[] = [];
  const caches: CacheEngine[] = [];

  afterEach(() => {
    while (caches.length) {
      try {
        caches.pop()?.close();
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

  /** A tree big enough that an unbounded search is genuinely dangerous. */
  function bigRepo(): {
    dir: string;
    counter: TokenCounter;
    cache: CacheEngine;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'token-optimizer-search-'));
    dirs.push(dir);
    const cache = new CacheEngine(join(dir, 'c.db'));
    caches.push(cache);
    mkdirSync(join(dir, 'src'), { recursive: true });
    for (let f = 0; f < 40; f++) {
      const lines = [];
      for (let i = 0; i < 120; i++) {
        lines.push(
          `export function target${f}_${i}() { return ${i}; } // padding padding padding`
        );
      }
      writeFileSync(join(dir, 'src', `mod${f}.ts`), lines.join('\n'));
    }
    return { dir, counter: new TokenCounter(), cache };
  }

  it('never returns a response larger than a context window', async () => {
    const { dir, counter, cache } = bigRepo();
    const grep = new SmartGrepTool(cache, counter, new MetricsCollector());

    const r = await grep.grep('export function', {
      cwd: dir,
      files: ['src/**/*.ts'],
      includeContext: true,
      contextBefore: 3,
      contextAfter: 2,
      useCache: false,
    });

    const paid = counter.count(JSON.stringify(r)).tokens;
    expect(paid).toBeLessThan(12_000);
    // 4,800 matches exist; the response must say it did not return them all.
    expect(r.metadata.totalMatches).toBeGreaterThan(1000);
    expect(r.matches!.length).toBeLessThan(r.metadata.totalMatches);
    expect(r.metadata.truncated).toBe(true);
  });

  it('reports a saving measured against the files it actually searched', async () => {
    const { dir, counter, cache } = bigRepo();
    const grep = new SmartGrepTool(cache, counter, new MetricsCollector());

    const r = await grep.grep('target1_5', {
      cwd: dir,
      files: ['src/**/*.ts'],
      useCache: false,
    });

    const md = r.metadata;
    // Not a multiplier of the result -- the old code produced exactly 100x,
    // 20x or 5x, which is the signature of an invented baseline.
    for (const factor of [5, 20, 100]) {
      expect(md.originalTokenCount).not.toBe(md.tokenCount * factor);
    }
    // And the baseline must be at least as large as the result it replaced.
    expect(md.originalTokenCount).toBeGreaterThanOrEqual(md.tokenCount);
    expect(md.tokensSaved).toBe(
      Math.max(0, md.originalTokenCount - md.tokenCount)
    );
  });

  it('a glob claims only what pagination actually withheld', async () => {
    const { dir, counter, cache } = bigRepo();
    const glob = new SmartGlobTool(cache, counter, new MetricsCollector());

    // Everything fits: nothing was withheld, so nothing was saved. Claiming a
    // saving here is what "50x" did on every single listing.
    const all = await glob.glob('src/**/*.ts', { cwd: dir, useCache: false });
    expect(all.metadata.tokensSaved).toBe(0);
    expect(all.metadata.originalTokenCount).toBe(all.metadata.tokenCount);

    // With a limit, the saving is the paths held back -- countable, so counted.
    const paged = await glob.glob('src/**/*.ts', {
      cwd: dir,
      limit: 5,
      useCache: false,
    });
    expect(paged.metadata.tokensSaved).toBeGreaterThan(0);
    expect(paged.metadata.originalTokenCount).toBeGreaterThan(
      paged.metadata.tokenCount
    );
    for (const factor of [10, 50]) {
      expect(paged.metadata.originalTokenCount).not.toBe(
        paged.metadata.tokenCount * factor
      );
    }
  });
});
