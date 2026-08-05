import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SmartGrepTool } from '../../src/tools/file-operations/smart-grep.js';
import { SmartGlobTool } from '../../src/tools/file-operations/smart-glob.js';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { TokenCounter } from '../../src/core/token-counter.js';
import { MetricsCollector } from '../../src/core/metrics.js';

/**
 * `path` naming a SINGLE FILE must search that file, not silently nothing.
 *
 * THE FAILURE THIS ENCODES IS A CONFIDENT ZERO. `path` was wired as the search
 * root -- `cwd: options.path ?? options.cwd` -- and the file list defaults to
 * `['**&#47;*']`. Globbing `**&#47;*` with a FILE as the cwd yields nothing, so a
 * search scoped to one file returned:
 *
 *     { success: true, totalMatches: 0, filesSearched: 0 }
 *
 * which is indistinguishable from "the pattern is not in that file". Measured
 * live against hooks-core/wiki.mjs: `path` = the file found 0 hits for a string
 * on line 112, while the same search via `files: [<same path>]` found it. An
 * answer that is wrong and reports success is worse than an error, and this is
 * the third time this tool family has produced one from an argument it accepted
 * but did not honour (the others: `path` undeclared entirely, and `filePattern`
 * silently dropped).
 *
 * `filesSearched > 0` is asserted alongside the match count, because that field
 * is the only part of the response that distinguished the bug from an honest
 * miss.
 */

let dir: string;
let cache: CacheEngine;
let tokenCounter: TokenCounter;
let metrics: MetricsCollector;

const deps = () => [cache, tokenCounter, metrics] as const;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'search-path-file-'));
  mkdirSync(join(dir, 'nested'));
  writeFileSync(
    join(dir, 'target.ts'),
    'export function findMe() {\n  return 1;\n}\n'
  );
  writeFileSync(join(dir, 'nested', 'other.ts'), 'export function findMe() {}\n');

  cache = new CacheEngine(join(dir, 'cache'), 10);
  tokenCounter = new TokenCounter();
  metrics = new MetricsCollector();
});

afterAll(() => {
  try {
    cache.close?.();
  } catch {
    // A cache that will not close must not fail the suite; the dir goes anyway.
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('smart_grep path naming a single file', () => {
  it('searches the file and reports having searched it', async () => {
    const tool = new SmartGrepTool(...deps());

    const result = await tool.grep('findMe', { path: join(dir, 'target.ts') });

    expect({
      matches: result.metadata?.totalMatches,
      searched: result.metadata?.filesSearched,
    }).toEqual({ matches: 1, searched: 1 });
  });

  it('scopes to that file alone, not its directory', async () => {
    // Both fixtures contain `findMe`. A file-scoped search that quietly widened
    // to the parent directory would be a different wrong answer, so the count
    // has to prove the scope held.
    const tool = new SmartGrepTool(...deps());

    const result = await tool.grep('findMe', { path: join(dir, 'target.ts') });

    expect(result.matches?.map((m) => m.lineNumber)).toEqual([1]);
  });

  it('still walks the tree when path names a directory', async () => {
    // The existing behaviour, which the fix must not trade away.
    const tool = new SmartGrepTool(...deps());

    const result = await tool.grep('findMe', { path: dir });

    expect(result.metadata?.totalMatches).toBe(2);
  });

  it('reports a path that does not exist instead of answering zero', async () => {
    // A typo'd path is the other way to produce a confident zero, and it is the
    // one a caller is most likely to hit.
    const tool = new SmartGrepTool(...deps());

    const result = await tool.grep('findMe', {
      path: join(dir, 'no-such-file.ts'),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not exist/i);
  });
});

describe('smart_glob path naming a single file', () => {
  it('matches that file rather than returning nothing', async () => {
    // Same wiring, same defect: `cwd: options.path` with a file cannot match.
    const tool = new SmartGlobTool(...deps());

    const result = await tool.glob('**/*.ts', { path: join(dir, 'target.ts') });

    expect(result.files?.length).toBe(1);
  });
});
