import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SmartGrepTool } from '../../src/tools/file-operations/smart-grep.js';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { TokenCounter } from '../../src/core/token-counter.js';
import { MetricsCollector } from '../../src/core/metrics.js';

/**
 * `count: true` must actually deliver the counts.
 *
 * The result carried `counts` as a `Map`, and a Map does not survive
 * `JSON.stringify` -- it serialises to `{}`. Every caller across the MCP
 * boundary therefore received:
 *
 *     { success: true, metadata: { totalMatches: 11, filesWithMatches: 1 },
 *       counts: {} }
 *
 * Totals present, per-file counts silently empty, which is the whole documented
 * purpose of the flag ("Only return match counts per file").
 *
 * Found live: asked for counts over a file with 11 matches and got `{}` beside a
 * `totalMatches: 11`. The internal cache path already did it correctly with
 * `Object.fromEntries`; only the returned object was wrong, so the two disagreed
 * about the same query.
 *
 * TypeScript could not catch it: `Map<string, number>` is a perfectly good type
 * for a field that is about to be serialised, and nothing in the type system
 * says this object crosses a JSON boundary.
 */

let dir: string;
let cache: CacheEngine;
let tokenCounter: TokenCounter;
let metrics: MetricsCollector;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'grep-count-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'a.ts'),
    'export function one() {}\nexport function two() {}\n'
  );
  writeFileSync(join(dir, 'src', 'b.ts'), 'export function three() {}\n');
  writeFileSync(join(dir, 'src', 'none.ts'), 'const x = 1;\n');

  cache = new CacheEngine(join(dir, 'cache'), 10);
  tokenCounter = new TokenCounter();
  metrics = new MetricsCollector();
});

afterAll(() => {
  try {
    cache.close?.();
  } catch {
    // temp dir goes anyway
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('smart_grep count mode', () => {
  it('returns per-file counts that survive JSON serialisation', async () => {
    const tool = new SmartGrepTool(cache, tokenCounter, metrics);

    const result = await tool.grep('export function', {
      path: dir,
      count: true,
    });

    // THROUGH JSON, because that is how every real caller receives it. Asserting
    // on the in-process object would pass with a Map and prove nothing.
    const overTheWire = JSON.parse(JSON.stringify(result));

    expect(Object.keys(overTheWire.counts ?? {}).length).toBeGreaterThan(0);
  });

  it('counts each file correctly', async () => {
    const tool = new SmartGrepTool(cache, tokenCounter, metrics);

    const result = await tool.grep('export function', {
      path: dir,
      count: true,
    });
    const counts = JSON.parse(JSON.stringify(result)).counts as Record<
      string,
      number
    >;

    const byName = Object.fromEntries(
      Object.entries(counts).map(([path, n]) => [
        path.replace(/^.*[\\/]/, ''),
        n,
      ])
    );

    expect(byName['a.ts']).toBe(2);
    expect(byName['b.ts']).toBe(1);
    expect(byName['none.ts']).toBeUndefined();
  });

  it('agrees with the totals it reports beside them', async () => {
    // The two came from different code paths and disagreed: totals were right
    // while counts were empty.
    const tool = new SmartGrepTool(cache, tokenCounter, metrics);

    const result = await tool.grep('export function', {
      path: dir,
      count: true,
    });
    const wire = JSON.parse(JSON.stringify(result));
    const summed = Object.values(wire.counts as Record<string, number>).reduce(
      (a, b) => a + b,
      0
    );

    expect(summed).toBe(wire.metadata.totalMatches);
  });
});
