/**
 * File discovery is bounded DURING the walk, not after it.
 *
 * ISSUE #335. `smart_glob` and `smart_grep` enumerated an entire tree with
 * `globSync` and only then applied `limit`, so on a real machine they did not
 * merely run slowly, they ran unbounded. Measured on 2026-08-28: a
 * default-ignore glob of a Windows user profile directory ran **178 seconds without
 * completing** and had to be killed, past the caller's 120 s tool timeout,
 * while `dir` and `rg` answered the same question instantly. Because the
 * routing policy DENIES the built-in `Glob`/`grep`, a tool that hangs there
 * does not degrade the workflow, it removes it.
 *
 * TWO BOUNDS, TESTED SEPARATELY, because each covers a case the other cannot:
 * the cap is only ever checked on a match, so it does nothing while a walk
 * grinds through `node_modules` finding none; the deadline is delivered by
 * `AbortSignal` and fires regardless.
 *
 * AND A CORRECTNESS GUARD. Stopping early changes WHICH matches come back, so
 * the cap must not engage where that would silently produce a wrong answer --
 * `sortBy: 'size'` with a limit asks for the largest files in the tree, and
 * "largest among the first few found" is a wrong answer that looks right.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  boundedGlob,
  boundedWalk,
  traversalDeadlineMs,
  DEFAULT_TRAVERSAL_DEADLINE_MS,
} from '../../../src/tools/shared/bounded-traversal.js';
import { SmartGlobTool } from '../../../src/tools/file-operations/smart-glob.js';
import { SmartGrepTool } from '../../../src/tools/file-operations/smart-grep.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';

let dir: string;
let cache: CacheEngine;
let tool: SmartGlobTool;
let grep: SmartGrepTool;

/** Wide enough that a cap is meaningfully cheaper than a full enumeration. */
const DIRECTORIES = 40;
const FILES_PER_DIRECTORY = 50; // 2000 files

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bounded-traversal-'));
  for (let d = 0; d < DIRECTORIES; d++) {
    const sub = join(dir, `pkg-${String(d).padStart(3, '0')}`);
    mkdirSync(sub, { recursive: true });
    for (let f = 0; f < FILES_PER_DIRECTORY; f++) {
      writeFileSync(join(sub, `file-${String(f).padStart(3, '0')}.ts`), 'x');
    }
  }
  // A directory the ignore patterns are expected to keep out of the walk.
  const heavy = join(dir, 'node_modules', 'dep');
  mkdirSync(heavy, { recursive: true });
  for (let f = 0; f < 200; f++) {
    writeFileSync(join(heavy, `dep-${f}.ts`), 'x');
  }
  // One unmistakably largest file, for the sort-correctness guard. It lives in
  // the LAST directory walked, so a capped walk would never reach it.
  // Filled with 'y', not 'x': the grep tests search for 'x', and 50,000
  // matches on ONE line of ONE file swamped those runs entirely.
  writeFileSync(join(dir, `pkg-039`, 'zzz-largest.ts'), 'y'.repeat(50_000));

  cache = new CacheEngine(join(dir, 'cache.db'), 100);
  tool = new SmartGlobTool(cache, new TokenCounter(), new MetricsCollector());
  grep = new SmartGrepTool(cache, new TokenCounter(), new MetricsCollector());
});

afterAll(() => {
  try {
    cache.close?.();
  } catch {
    /* a cache that will not close must not fail the suite */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('boundedGlob', () => {
  it('stops at the cap and says so', async () => {
    const result = await boundedGlob('**/*.ts', { cwd: dir, cap: 25 });
    expect(result.items).toHaveLength(25);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('cap');
  });

  it('reports completion honestly when nothing stopped it', async () => {
    const result = await boundedGlob('pkg-000/*.ts', { cwd: dir });
    expect(result.items).toHaveLength(FILES_PER_DIRECTORY);
    expect(result.truncated).toBe(false);
    expect(result.truncatedBy).toBeUndefined();
  });

  it('stops at the deadline even when the pattern matches nothing', async () => {
    // THE CASE THE CAP CANNOT COVER. A cap is only checked on a match, so a
    // walk that yields nothing for minutes would never consult it. This is the
    // shape of the reported hang: `**/*.csproj` over a tree of `node_modules`.
    const result = await boundedGlob('**/*.no-such-extension', {
      cwd: dir,
      deadlineMs: 1,
    });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('deadline');
  });

  it('counts the cap AFTER the accept filter, not before', async () => {
    // Otherwise a cap of 10 is spent on candidates that are then discarded and
    // the caller gets 2 results while thousands more existed.
    const result = await boundedGlob('**/*.ts', {
      cwd: dir,
      cap: 10,
      accept: (p) => p.includes('file-000'),
    });
    expect(result.items).toHaveLength(10);
    expect(result.items.every((p) => p.includes('file-000'))).toBe(true);
  });

  it('does not disguise a real failure as a bound', async () => {
    // An abort is a result; anything else must still throw, or a permissions
    // error becomes an empty "successful" search.
    await expect(
      boundedGlob('**/*.ts', {
        cwd: dir,
        accept: () => {
          throw new Error('boom');
        },
      })
    ).rejects.toThrow('boom');
  });
});

describe('boundedWalk', () => {
  it('prunes directories instead of enumerating and discarding them', async () => {
    const seen: string[] = [];
    const result = await boundedWalk(dir, {
      prune: (name) => {
        seen.push(name);
        return name === 'node_modules';
      },
      accept: (_full, name) => name.endsWith('.ts'),
    });
    expect(seen).toContain('node_modules');
    expect(result.items.some((p) => p.includes('node_modules'))).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('never looks at a single file inside a pruned directory', async () => {
    // THE PRECISE PRUNE CONTRACT, and the one assertion that separates pruning
    // from filtering-afterwards. The test above shows no pruned path comes
    // BACK, which a post-hoc filter also satisfies -- it enumerates the whole
    // of `node_modules` and then discards it one entry at a time, which is the
    // exact cost this module exists to stop paying.
    //
    // Every tool that excludes a directory delegates to this, and none of them
    // can assert it for themselves: their accept filters re-reject the same
    // paths, so their output is identical either way and only the work differs.
    const offered: string[] = [];
    await boundedWalk(dir, {
      prune: (name) => name === 'node_modules',
      accept: (fullPath) => {
        offered.push(fullPath);
        return fullPath.endsWith('.ts');
      },
    });

    expect(offered.length).toBeGreaterThan(0);
    expect(offered.some((p) => p.includes('node_modules'))).toBe(false);
  });

  it('stops at the cap', async () => {
    const result = await boundedWalk(dir, { cap: 12 });
    expect(result.items).toHaveLength(12);
    expect(result.truncatedBy).toBe('cap');
  });

  it('stops at the deadline', async () => {
    const result = await boundedWalk(dir, { deadlineMs: 1, cap: Infinity });
    expect(result.truncatedBy).toBe('deadline');
  });
});

describe('the traversal budget', () => {
  it('falls back rather than throwing on a malformed environment value', () => {
    const previous = process.env.TOKEN_OPTIMIZER_TRAVERSAL_DEADLINE_MS;
    process.env.TOKEN_OPTIMIZER_TRAVERSAL_DEADLINE_MS = 'not-a-number';
    try {
      expect(traversalDeadlineMs()).toBe(DEFAULT_TRAVERSAL_DEADLINE_MS);
    } finally {
      if (previous === undefined) {
        delete process.env.TOKEN_OPTIMIZER_TRAVERSAL_DEADLINE_MS;
      } else {
        process.env.TOKEN_OPTIMIZER_TRAVERSAL_DEADLINE_MS = previous;
      }
    }
  });

  it('an explicit override wins over the environment', () => {
    expect(traversalDeadlineMs(1234)).toBe(1234);
  });
});

describe('smart_glob is bounded end to end', () => {
  it('returns under its deadline instead of running to completion', async () => {
    const started = Date.now();
    const result = await tool.glob('**/*.ts', { cwd: dir, deadlineMs: 200 });
    expect(result.success).toBe(true);
    // Generous: the assertion is "bounded", not a millisecond count on a
    // shared runner. Unbounded, the reported failure ran past 120_000.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('flags a capped search as incomplete rather than reporting it as whole', async () => {
    const result = await tool.glob('**/*.ts', { cwd: dir, limit: 5 });
    expect(result.files).toHaveLength(5);
    expect(result.metadata.searchTruncated).toBe(true);
    expect(result.metadata.searchTruncatedBy).toBe('cap');
    expect(result.metadata.searchNote).toContain('not fully searched');
  });

  it('does NOT report a withheld count it can no longer justify', async () => {
    // `ignoredMatches` is the difference between two walks. Once either walk
    // stops early that difference measures where they stopped, and the
    // clamped negative would claim "nothing was withheld" -- the one answer
    // worse than admitting the number is unknown.
    const result = await tool.glob('**/*.ts', { cwd: dir, limit: 5 });
    expect(result.metadata.searchTruncated).toBe(true);
    expect(result.metadata.ignoredMatches).toBeUndefined();
    expect(result.metadata.ignoreNote).toContain('unknown');
  });

  it('still counts withheld matches when the walk completed', async () => {
    const result = await tool.glob('**/*.ts', { cwd: dir });
    expect(result.metadata.searchTruncated).toBeUndefined();
    // node_modules holds 200 real matches the default ignore list withholds.
    expect(result.metadata.ignoredMatches).toBe(200);
  });

  it('never short-circuits a sorted search, because that would answer wrongly', async () => {
    // THE GUARD. `sortBy: 'size'` with a limit asks for the largest files in
    // the whole tree. A cap would return the largest among the first walked,
    // which is a wrong answer that looks exactly like a right one. The largest
    // file is deliberately placed in the last directory a capped walk reaches.
    const result = await tool.glob('**/*.ts', {
      cwd: dir,
      limit: 1,
      sortBy: 'size',
      sortOrder: 'desc',
      includeMetadata: true,
    });
    const [largest] = result.files as Array<{ path: string; size: number }>;
    expect(largest.path).toContain('zzz-largest');
    expect(result.metadata.searchTruncated).toBeUndefined();
  });
});

describe('smart_grep is bounded end to end', () => {
  it('returns under its deadline instead of running to completion', async () => {
    const started = Date.now();
    const result = await grep.grep('x', { cwd: dir, deadlineMs: 200 });
    expect(result.success).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('stops reading once the requested page is filled, and says so', async () => {
    const result = await grep.grep('x', { cwd: dir, limit: 3 });
    expect(result.metadata.searchTruncated).toBe(true);
    expect(result.metadata.searchTruncatedBy).toBe('cap');
    expect(result.metadata.searchNote).toContain('left unsearched');
  });

  it('counts files it actually OPENED, not files it discovered', async () => {
    // THE HONESTY HALF OF THE FIX. `filesSearched` was the discovered count, so
    // a run that stopped early still reported having searched every file it had
    // listed -- coverage it never had. Every one of this tool's previous
    // defects had the same shape: a confident number describing work that did
    // not happen.
    const capped = await grep.grep('x', { cwd: dir, limit: 3 });
    const whole = await grep.grep('x', { cwd: dir });
    expect(whole.success).toBe(true);
    expect(capped.metadata.searchTruncated).toBe(true);
    expect(capped.metadata.filesSearched).toBeLessThan(
      whole.metadata.filesSearched
    );
    expect(capped.metadata.filesSearched).toBeGreaterThan(0);
  });

  it('reports a complete search as complete', async () => {
    const result = await grep.grep('x', { cwd: dir, files: ['pkg-000/*.ts'] });
    expect(result.metadata.searchTruncated).toBeUndefined();
  });
});

describe('smart_grep survives a dense file', () => {
  it('does not fail the whole search on 50,000 matches in one line', async () => {
    // FOUND WHILE WRITING THE TESTS ABOVE, not from the issue. `limit` defaults
    // to Infinity and every match record carries its whole LINE, so 50,000
    // matches on one 50,000-character line built 2.5 GB of string and threw
    // `Invalid string length` out of the response-budget JSON.stringify --
    // returning `success: false, filesSearched: 0, totalMatches: 0` after 5.3 s.
    // Minified bundles, lock files and embedded data all have this shape.
    const dense = mkdtempSync(join(tmpdir(), 'dense-match-'));
    const denseCache = new CacheEngine(join(dense, 'cache.db'), 100);
    try {
      // NOT `.min.js`: that extension is in the documented default
      // `excludeExtensions`, so the file would be skipped by design and the
      // test would pass without ever exercising the dense-match path.
      writeFileSync(join(dense, 'bundle.js'), 'x'.repeat(50_000));
      const tool = new SmartGrepTool(
        denseCache,
        new TokenCounter(),
        new MetricsCollector()
      );
      const result = await tool.grep('x', { cwd: dense });
      expect(result.success).toBe(true);
      expect(result.metadata.filesSearched).toBe(1);
      expect(result.metadata.totalMatches).toBeGreaterThan(0);
      // The stored line is a locator, not a copy of the file.
      const [first] = (result.matches ?? []) as Array<{ line: string }>;
      if (first) expect(first.line.length).toBeLessThanOrEqual(2_100);
    } finally {
      try {
        denseCache.close?.();
      } catch {
        /* ignore */
      }
      rmSync(dense, { recursive: true, force: true });
    }
  }, 120_000);
});
