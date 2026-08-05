import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  SmartGrepTool,
  type SmartGrepOptions,
} from '../../../src/tools/file-operations/smart-grep.js';
import {
  SmartGlobTool,
  type SmartGlobOptions,
} from '../../../src/tools/file-operations/smart-glob.js';
import { appendAll } from '../../../src/tools/shared/append-all.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';

/**
 * A search must search where it was told, and must survive what it finds.
 *
 * Both halves were measured live and both were broken. The hook REFUSES the
 * built-in Grep and names smart_grep as the replacement, so a caller passes the
 * one argument that describes a search -- where to look. Neither smart_grep nor
 * smart_glob declared `path`, and an undeclared field that is not a near miss of
 * a declared one is dropped without a word: `cwd` then fell back to
 * process.cwd(), which for an MCP server is its own launch directory, not the
 * caller's target.
 *
 * On this machine that was the whole home directory: 676,875 files, 65 seconds
 * per call. smart_glob returned confident results from the wrong tree.
 * smart_grep never returned at all -- `filesToSearch.push(...matches)` spread
 * 676,875 arguments past V8's limit of 125,262 and threw
 * "Maximum call stack size exceeded", the same error for every caller in every
 * project. The tool the hook forces you to use could not succeed.
 */

describe('a search searches where it was told', () => {
  let root: string;
  let wanted: string;
  let other: string;
  let cache: CacheEngine;
  let counter: TokenCounter;
  let tool: SmartGrepTool;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'search-scope-'));

    // Two sibling trees holding the SAME token. Scope is the only thing that can
    // tell them apart, so an ignored `path` cannot accidentally pass.
    wanted = join(root, 'wanted');
    other = join(root, 'other');
    mkdirSync(wanted);
    mkdirSync(other);
    writeFileSync(join(wanted, 'a.ts'), 'const x = UNIQUE_SCOPE_TOKEN;\n');
    writeFileSync(join(other, 'b.ts'), 'const y = UNIQUE_SCOPE_TOKEN;\n');

    cache = new CacheEngine(join(root, 'cache.db'), 100);
    counter = new TokenCounter();
    tool = new SmartGrepTool(cache, counter, new MetricsCollector());
  });

  afterEach(() => {
    cache.close();
    counter.free();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A locked cache file on Windows must not fail the run.
    }
  });

  it('treats `path` as the search root, not as an unknown field to discard', async () => {
    const result = await tool.grep('UNIQUE_SCOPE_TOKEN', {
      path: wanted,
    } as unknown as SmartGrepOptions);

    expect(result.success).toBe(true);
    expect(result.metadata.totalMatches).toBe(1);
    // Asserting on the file, not just the count: a count of 1 could also come
    // from the wrong tree.
    expect(result.matches?.[0]?.file).toContain('a.ts');
  });

  it('still honours `cwd`, which is what the schema has always declared', async () => {
    const result = await tool.grep('UNIQUE_SCOPE_TOKEN', { cwd: other });

    expect(result.success).toBe(true);
    expect(result.metadata.totalMatches).toBe(1);
    expect(result.matches?.[0]?.file).toContain('b.ts');
  });

  it('prefers `path` when both are given, because it is the more specific ask', async () => {
    const result = await tool.grep('UNIQUE_SCOPE_TOKEN', {
      cwd: other,
      path: wanted,
    } as unknown as SmartGrepOptions);

    expect(result.metadata.totalMatches).toBe(1);
    expect(result.matches?.[0]?.file).toContain('a.ts');
  });
});

describe('a search survives a result set larger than V8 can spread', () => {
  let root: string;
  let cache: CacheEngine;
  let counter: TokenCounter;
  let tool: SmartGrepTool;

  // Comfortably past the measured ceiling of 125,262 spread arguments.
  const MATCH_COUNT = 130_000;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'search-scale-'));
    // One file, many matching lines: this reaches the per-file accumulation
    // without needing 130,000 files on disk.
    writeFileSync(join(root, 'many.txt'), 'needle\n'.repeat(MATCH_COUNT));

    cache = new CacheEngine(join(root, 'cache.db'), 100);
    counter = new TokenCounter();
    tool = new SmartGrepTool(cache, counter, new MetricsCollector());
  });

  afterEach(() => {
    cache.close();
    counter.free();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // See above.
    }
  });

  it('does not throw when one file holds more matches than the spread limit', async () => {
    const result = await tool.grep('needle', { cwd: root });

    // The failure this pins down is not a wrong number, it is no number at all:
    // success false and error "Maximum call stack size exceeded".
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.metadata.totalMatches).toBe(MATCH_COUNT);
  });

  it('still caps what it returns, so surviving does not mean flooding the caller', async () => {
    const result = await tool.grep('needle', { cwd: root });

    expect(result.metadata.truncated).toBe(true);
    expect(result.metadata.tokenCount).toBeLessThanOrEqual(8_000);
  });
});

/**
 * smart_glob has the same defect and must be fixed with it.
 *
 * Not speculation: a live call passing `path` for one repository returned a hit
 * from a DIFFERENT repository, because the search actually ran from the home
 * directory. It does not crash only because a narrow pattern matches few files
 * -- it still walks the whole tree and still answers about the wrong one, which
 * is worse than failing. This repository has already been bitten by fixing one
 * tool and not its twin (see backup-location.test.ts).
 */
describe('smart_glob searches where it was told, exactly as smart_grep does', () => {
  let root: string;
  let wanted: string;
  let other: string;
  let cache: CacheEngine;
  let counter: TokenCounter;
  let tool: SmartGlobTool;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'glob-scope-'));
    wanted = join(root, 'wanted');
    other = join(root, 'other');
    mkdirSync(wanted);
    mkdirSync(other);
    writeFileSync(join(wanted, 'inside.ts'), 'export const a = 1;\n');
    writeFileSync(join(other, 'outside.ts'), 'export const b = 2;\n');

    cache = new CacheEngine(join(root, 'cache.db'), 100);
    counter = new TokenCounter();
    tool = new SmartGlobTool(cache, counter, new MetricsCollector());
  });

  afterEach(() => {
    cache.close();
    counter.free();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // See above.
    }
  });

  it('treats `path` as the search root', async () => {
    const result = await tool.glob('**/*.ts', {
      path: wanted,
    } as unknown as SmartGlobOptions);

    const names = (result.files ?? []).map((f) =>
      typeof f === 'string' ? f : f.relativePath
    );
    expect(names).toHaveLength(1);
    expect(names[0]).toContain('inside.ts');
  });

  it('still honours `cwd`', async () => {
    const result = await tool.glob('**/*.ts', { cwd: other });

    const names = (result.files ?? []).map((f) =>
      typeof f === 'string' ? f : f.relativePath
    );
    expect(names).toHaveLength(1);
    expect(names[0]).toContain('outside.ts');
  });
});

/**
 * The file-list site cannot be reached from a test -- it needs more than 125,262
 * files on disk -- so the fix is a helper that is tested directly at that scale.
 */
describe('appendAll moves any number of items without spreading them', () => {
  it('appends more elements than V8 accepts as spread arguments', () => {
    const source = new Array(200_000).fill('x');
    const dest: string[] = [];

    appendAll(dest, source);

    expect(dest.length).toBe(200_000);
  });

  it('is the operation push(...items) would have been, for a small input', () => {
    const dest = [1, 2];

    appendAll(dest, [3, 4, 5]);

    expect(dest).toEqual([1, 2, 3, 4, 5]);
  });

  it('leaves the destination alone when there is nothing to add', () => {
    const dest = [1];

    appendAll(dest, []);

    expect(dest).toEqual([1]);
  });

  it('proves the bug it exists to prevent: push(...) throws at this size', () => {
    const source = new Array(200_000).fill('x');

    // Guarding the guard. If a future V8 raises the limit this assertion is the
    // thing that tells us, rather than the helper quietly becoming pointless.
    expect(() => [].push(...(source as never[]))).toThrow(RangeError);
  });
});
