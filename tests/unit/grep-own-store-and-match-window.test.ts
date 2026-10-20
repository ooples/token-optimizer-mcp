import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SmartGrepTool,
  matchWindow,
  withOwnStoreIgnored,
} from '../../src/tools/file-operations/smart-grep.js';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { TokenCounter } from '../../src/core/token-counter.js';
import { MetricsCollector } from '../../src/core/metrics.js';

/**
 * smart_grep searched this product's own store, and returned long lines from
 * their start rather than around the match.
 *
 * Observed live on 2026-10-20: `gcServer` over a .NET repository answered first
 * with `.token-optimizer/wiki/snapshots.jsonl` -- each "line" a multi-KB file
 * snapshot, cut at 2,000 characters that did not contain the match -- and the
 * real workflow hits sat behind an expand handle. The caller had passed its own
 * `ignore` (for bin/obj), which replaced the defaults entirely.
 */

let dir: string;
let cache: CacheEngine;
const deps = () => [cache, new TokenCounter(), new MetricsCollector()] as const;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'grep-own-store-'));
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'env:\n  DOTNET_gcServer: 1\n');
  mkdirSync(join(dir, '.token-optimizer', 'wiki'), { recursive: true });
  writeFileSync(
    join(dir, '.token-optimizer', 'wiki', 'snapshots.jsonl'),
    JSON.stringify({ snapshot: 'x'.repeat(5_000) + ' DOTNET_gcServer: 1 ' + 'y'.repeat(5_000) }) + '\n'
  );
  writeFileSync(join(dir, 'long.txt'), 'a'.repeat(6_000) + 'NEEDLE' + 'b'.repeat(6_000) + '\n');
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

describe("smart_grep never searches this product's own store", () => {
  it('with the default ignore list', async () => {
    const result = await new SmartGrepTool(...deps()).grep('gcServer', { path: dir });
    const files = (result.matches ?? []).map((m) => m.file.replace(/\\/g, '/'));

    expect(files).toContain('.github/workflows/ci.yml');
    expect(files.some((f) => f.includes('.token-optimizer'))).toBe(false);
  });

  it("with a caller's own ignore list, which used to replace the defaults", async () => {
    const result = await new SmartGrepTool(...deps()).grep('gcServer', {
      path: dir,
      ignore: ['**/bin/**', '**/obj/**'],
    });
    const files = (result.matches ?? []).map((m) => m.file.replace(/\\/g, '/'));

    expect(files.some((f) => f.includes('.token-optimizer'))).toBe(false);
  });

  it('unless the search is pointed into the store itself', async () => {
    const result = await new SmartGrepTool(...deps()).grep('gcServer', {
      path: join(dir, '.token-optimizer'),
    });
    expect(result.metadata?.totalMatches).toBeGreaterThan(0);
  });

  it('withOwnStoreIgnored is idempotent', () => {
    const once = withOwnStoreIgnored(['**/bin/**'], '/repo');
    expect(withOwnStoreIgnored(once, '/repo')).toEqual(once);
    expect(withOwnStoreIgnored(['**/bin/**'], 'C:\\repo\\.token-optimizer\\wiki')).toEqual(['**/bin/**']);
  });
});

describe('a long matching line comes back as a window around the match', () => {
  it('the match is inside the returned text, and the text is small', async () => {
    const result = await new SmartGrepTool(...deps()).grep('NEEDLE', { path: join(dir, 'long.txt') });
    const line = result.matches?.[0]?.line ?? '';

    expect(line).toContain('NEEDLE');
    expect(line.length).toBeLessThan(500);
    expect(line.startsWith('...')).toBe(true);
    expect(line.endsWith('...')).toBe(true);
  });

  it('short lines are returned whole', () => {
    expect(matchWindow('const x = 1;', 6, 1)).toBe('const x = 1;');
  });

  it('a match at the very start or end keeps its edge unmarked', () => {
    const long = 'N' + 'z'.repeat(1_000);
    expect(matchWindow(long, 0, 1).startsWith('N')).toBe(true);
    const tail = 'z'.repeat(1_000) + 'N';
    const w = matchWindow(tail, 1_000, 1);
    expect(w.endsWith('N')).toBe(true);
    expect(w.startsWith('...')).toBe(true);
  });

  it('a match longer than the window is never cut', () => {
    const match = 'M'.repeat(600);
    const line = 'a'.repeat(200) + match + 'b'.repeat(200);
    expect(matchWindow(line, 200, 600)).toContain(match);
  });
});
