import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SmartGrepTool,
  gitEnvironment,
  gitIgnoredGlobs,
} from '../../src/tools/file-operations/smart-grep.js';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { TokenCounter } from '../../src/core/token-counter.js';
import { MetricsCollector } from '../../src/core/metrics.js';

/**
 * smart_grep read gitignored build output by default.
 *
 * Measured on AiDotNet (2026-10-20): the default ignore list named only
 * node_modules, .git, dist and build, so a literal search read 3 GB of
 * gitignored bin/ and obj/ -- 8-10 s, against 1.8 s with them skipped -- and on
 * a cold cache git used the whole deadline, leaving the fallback walk none: 0
 * matches over 0 files. Inside a checkout .gitignore now decides; outside one,
 * common build-output directories join the default list.
 */

const NEEDLE = 'GITIGNORE_DEFAULT_NEEDLE';
let root: string;
let repo: string;
let plain: string;
let cache: CacheEngine;
const tool = () =>
  new SmartGrepTool(cache, new TokenCounter(), new MetricsCollector());
const files = (result: { matches?: { file: string }[] }) =>
  (result.matches ?? []).map((m) => m.file.replace(/\\/g, '/')).sort();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'grep-gitignore-'));
  repo = join(root, 'repo');
  plain = join(root, 'plain');
  for (const dir of [repo, plain]) {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'obj', 'Debug'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), `${NEEDLE}\n`);
    writeFileSync(join(dir, 'obj', 'Debug', 'gen.cs'), `${NEEDLE}\n`);
  }
  execFileSync('git', ['init', '-q', repo], { env: gitEnvironment() });
  writeFileSync(join(repo, '.gitignore'), 'obj/\n*.log\n');
  writeFileSync(join(repo, 'run.log'), `${NEEDLE}\n`);
  cache = new CacheEngine(join(root, 'cache-db'), 10);
});

afterAll(() => {
  try {
    cache.close?.();
  } catch {
    /* already closed */
  }
  rmSync(root, { recursive: true, force: true });
});

describe('inside a git checkout', () => {
  it('lists what .gitignore excludes as globs, directories collapsed', async () => {
    expect((await gitIgnoredGlobs(repo, 10_000))?.sort()).toEqual([
      'obj/**',
      'run.log',
    ]);
  });

  it('skips gitignored files by default', async () => {
    expect(files(await tool().grep(NEEDLE, { path: repo }))).toEqual([
      'src/a.ts',
    ]);
  });

  it('skips them with the walk backend too, so both answer alike', async () => {
    const before = process.env.TOKEN_OPTIMIZER_GREP_BACKEND;
    process.env.TOKEN_OPTIMIZER_GREP_BACKEND = 'walk';
    try {
      expect(files(await tool().grep(NEEDLE, { path: repo }))).toEqual([
        'src/a.ts',
      ]);
    } finally {
      if (before === undefined) delete process.env.TOKEN_OPTIMIZER_GREP_BACKEND;
      else process.env.TOKEN_OPTIMIZER_GREP_BACKEND = before;
    }
  });

  it('says so when the only matches were in gitignored paths', async () => {
    writeFileSync(join(repo, 'obj', 'Debug', 'only.cs'), 'ONLY_IN_GENERATED\n');
    const result = await tool().grep('ONLY_IN_GENERATED', { path: repo });

    expect(result.metadata.totalMatches).toBe(0);
    expect(result.hint).toMatch(/gitignored paths .*includeIgnored: true/);
  });

  it('stays quiet when a zero is a real zero', async () => {
    const result = await tool().grep('ABSENT_EVERYWHERE_123', { path: plain });
    expect(result.metadata.totalMatches).toBe(0);
    expect(result.hint).toBeUndefined();
  });

  it('reads them when includeIgnored is set', async () => {
    expect(
      files(await tool().grep(NEEDLE, { path: repo, includeIgnored: true }))
    ).toEqual(['obj/Debug/gen.cs', 'run.log', 'src/a.ts']);
  });
});

describe('outside a git checkout', () => {
  it('has no .gitignore to consult', async () => {
    expect(await gitIgnoredGlobs(plain, 10_000)).toBeNull();
  });

  it('skips common build output by default', async () => {
    expect(files(await tool().grep(NEEDLE, { path: plain }))).toEqual([
      'src/a.ts',
    ]);
  });

  it("leaves a caller's own ignore list as the caller wrote it", async () => {
    expect(
      files(await tool().grep(NEEDLE, { path: plain, ignore: [] }))
    ).toEqual(['obj/Debug/gen.cs', 'src/a.ts']);
  });
});
