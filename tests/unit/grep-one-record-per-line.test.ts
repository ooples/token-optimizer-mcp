import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SmartGrepTool } from '../../src/tools/file-operations/smart-grep.js';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { TokenCounter } from '../../src/core/token-counter.js';
import { MetricsCollector } from '../../src/core/metrics.js';

/**
 * One record per matching line, as grep prints one.
 *
 * A record per OCCURRENCE sent a line holding the pattern twice back twice,
 * full text each time -- 4 of 18 records on one AiDotNet search -- and every
 * record repeated the literal pattern as `match`.
 */

let dir: string;
let cache: CacheEngine;
const grep = (pattern: string, options: Record<string, unknown> = {}) =>
  new SmartGrepTool(cache, new TokenCounter(), new MetricsCollector()).grep(
    pattern,
    { path: dir, ...options }
  );

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'grep-per-line-'));
  writeFileSync(
    join(dir, 'a.cs'),
    'public BackboneType Backbone { get; set; } = BackboneType.ResNet50;\nBackboneType once\nnothing\n'
  );
  cache = new CacheEngine(join(dir, 'cache-db'), 10);
});

afterAll(() => {
  try {
    cache.close?.();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('smart_grep records', () => {
  it('returns a line that holds the pattern twice once', async () => {
    const result = await grep('BackboneType', { caseSensitive: true });

    expect(result.matches?.map((m) => m.lineNumber)).toEqual([1, 2]);
    expect(result.metadata.totalMatches).toBe(2);
    expect(result.metadata.occurrences).toBe(3);
  });

  it('omits `match` when it is the pattern itself', async () => {
    const result = await grep('BackboneType', { caseSensitive: true });
    expect(result.matches?.every((m) => m.match === undefined)).toBe(true);
  });

  it('keeps `match` when the matched text differs from the pattern', async () => {
    const result = await grep('backbonetype');
    expect(result.matches?.[0].match).toBe('BackboneType');
  });

  it('lists every column on the line when columns are asked for', async () => {
    const result = await grep('BackboneType', {
      caseSensitive: true,
      includeColumn: true,
    });
    expect(result.matches?.[0].column).toBe(7);
    expect(result.matches?.[0].columns).toEqual([7, 45]);
    expect(result.matches?.[1].columns).toBeUndefined();
  });

  it('count mode still counts occurrences per file', async () => {
    const result = (await grep('BackboneType', {
      caseSensitive: true,
      count: true,
    })) as unknown as { counts: Record<string, number> };
    expect(result.counts).toEqual({ 'a.cs': 3 });
  });
});
