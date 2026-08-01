import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import { SmartGlobTool } from '../../../src/tools/file-operations/smart-glob.js';
import { SmartGrepTool } from '../../../src/tools/file-operations/smart-grep.js';
import { SmartEditTool } from '../../../src/tools/file-operations/smart-edit.js';

/**
 * A search must never describe a tree that no longer exists.
 *
 * smart_grep and smart_glob cached results keyed on `{pattern, options}` and
 * nothing else, with no expiry, in SQLite. Measured live: search a tree,
 * create a matching file, search again with the same arguments -- the
 * pre-creation answer came back, and survived a process restart.
 *
 * The uncomfortable part is WHEN such a cache is hit. An identical search is
 * usually repeated *because* something changed, so the moment it answers is
 * the moment it is most likely to be wrong. Hence the default below.
 *
 * Reporting that a file does not exist is the same category of harm as
 * inventing one: the caller acts on an answer the filesystem never gave.
 */

let dir: string;
let cache: CacheEngine;
const deps = (): [CacheEngine, TokenCounter, MetricsCollector] => [
  cache,
  new TokenCounter(),
  new MetricsCollector(),
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'search-stale-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const NEEDLE = 1;\n');
  cache = new CacheEngine(join(dir, 'cache.db'));
});

afterEach(() => {
  try {
    cache.close();
  } catch {
    /* */
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows */
  }
});

describe('smart_glob freshness', () => {
  it('sees a file created between two identical searches', async () => {
    const tool = new SmartGlobTool(...deps());
    const before = await tool.glob('src/*.ts', { cwd: dir });
    writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 2;\n');
    const after = await tool.glob('src/*.ts', { cwd: dir });

    expect(before.metadata.totalMatches).toBe(1);
    expect(after.metadata.totalMatches).toBe(2);
    expect(JSON.stringify(after.files)).toContain('b.ts');
  });

  it('stops listing a file that was deleted', async () => {
    const tool = new SmartGlobTool(...deps());
    writeFileSync(join(dir, 'src', 'gone.ts'), 'export const g = 0;\n');
    await tool.glob('src/*.ts', { cwd: dir });
    rmSync(join(dir, 'src', 'gone.ts'));
    const after = await tool.glob('src/*.ts', { cwd: dir });

    expect(JSON.stringify(after.files)).not.toContain('gone.ts');
  });

  it('does not cache by default', async () => {
    // The default is the fix. Flipping it back to true reintroduces the bug
    // for every caller who never thinks about caching -- which is all of them.
    const tool = new SmartGlobTool(...deps());
    await tool.glob('src/*.ts', { cwd: dir });
    const second = await tool.glob('src/*.ts', { cwd: dir });
    expect(second.metadata.cacheHit).toBe(false);
  });
});

describe('smart_grep freshness', () => {
  it('finds a match created between two identical searches', async () => {
    const tool = new SmartGrepTool(...deps());
    const before = await tool.grep('NEEDLE', { cwd: dir });
    writeFileSync(join(dir, 'src', 'c.ts'), 'export const NEEDLE = 3;\n');
    const after = await tool.grep('NEEDLE', { cwd: dir });

    expect(after.metadata.totalMatches).toBeGreaterThan(
      before.metadata.totalMatches
    );
  });

  it('reflects an edit that removed the only match', async () => {
    const tool = new SmartGrepTool(...deps());
    const before = await tool.grep('NEEDLE', { cwd: dir });
    expect(before.metadata.totalMatches).toBeGreaterThan(0);

    writeFileSync(join(dir, 'src', 'a.ts'), 'export const RENAMED = 1;\n');
    const after = await tool.grep('NEEDLE', { cwd: dir });
    expect(after.metadata.totalMatches).toBe(0);
  });
});

describe('the opt-in cache', () => {
  it('still serves a repeat when the caller asks for it', async () => {
    // Opting in has to actually do something, or the option is a lie.
    const tool = new SmartGlobTool(...deps());
    await tool.glob('src/*.ts', { cwd: dir, useCache: true });
    const second = await tool.glob('src/*.ts', { cwd: dir, useCache: true });
    expect(second.metadata.cacheHit).toBe(true);
  });

  it('is invalidated by a write made through this server', async () => {
    // The generation counter closes the case that dominates a session: our own
    // edit. An opted-in caller still cannot be shown a tree we ourselves moved.
    const glob = new SmartGlobTool(...deps());
    const edit = new SmartEditTool(...deps());

    await glob.glob('src/*.ts', { cwd: dir, useCache: true });
    await edit.edit(join(dir, 'src', 'a.ts'), {
      type: 'replace',
      startLine: 1,
      endLine: 1,
      content: 'export const CHANGED = 1;',
    });

    const after = await glob.glob('src/*.ts', { cwd: dir, useCache: true });
    expect(after.metadata.cacheHit).toBe(false);
  });
});
