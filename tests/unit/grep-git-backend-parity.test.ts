import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SmartGrepTool,
  gitGrepCandidates,
} from '../../src/tools/file-operations/smart-grep.js';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { TokenCounter } from '../../src/core/token-counter.js';
import { MetricsCollector } from '../../src/core/metrics.js';

/**
 * Inside a git checkout, `git grep -l` picks the candidate files and the walk's
 * own filters and matching do the rest -- so the answer must be the walk's.
 *
 * Measured on 2026-10-20 on a 17,627-file .NET checkout: the walk took 8.3 s
 * (10.2 s and truncated by its deadline on a cold run); git found the same 5
 * files and 32 matches in 1.6 s.
 */

let repo: string;
let cache: CacheEngine;
const deps = () => [cache, new TokenCounter(), new MetricsCollector()] as const;
const NEEDLE = 'NEEDLE_7Q';

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'grep-git-'));
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, '.gitignore'), 'ignored.txt\nbuild/\n');
  writeFileSync(join(repo, 'tracked.ts'), `const a = '${NEEDLE}';\n`);
  writeFileSync(join(repo, 'untracked.ts'), `// ${NEEDLE.toLowerCase()}\n`);
  writeFileSync(join(repo, 'ignored.txt'), `${NEEDLE}\n`);
  mkdirSync(join(repo, '.github'));
  writeFileSync(join(repo, '.github', 'ci.yml'), `env: ${NEEDLE}\n`);
  mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'dep', 'x.js'), `${NEEDLE}\n`);
  writeFileSync(join(repo, 'nothing.ts'), 'no match here\n');
  execFileSync('git', ['-C', repo, 'add', 'tracked.ts', '.gitignore']);
  cache = new CacheEngine(join(mkdtempSync(join(tmpdir(), 'grep-git-cache-')), 'db'), 10);
});

afterAll(() => {
  try {
    cache.close?.();
  } catch {
    /* already closed */
  }
  delete process.env.TOKEN_OPTIMIZER_GREP_BACKEND;
  rmSync(repo, { recursive: true, force: true });
});

const run = async (backend: 'git' | 'walk', options: Record<string, unknown> = {}) => {
  process.env.TOKEN_OPTIMIZER_GREP_BACKEND = backend === 'walk' ? 'walk' : '';
  const result = await new SmartGrepTool(...deps()).grep(NEEDLE, { path: repo, ...options });
  return {
    total: result.metadata?.totalMatches,
    files: [...new Set((result.matches ?? []).map((m) => m.file.replace(/\\/g, '/')))].sort(),
    searched: result.metadata?.filesSearched ?? 0,
  };
};

describe('the git backend answers exactly what the walk answers', () => {
  it('tracked, untracked, ignored and dot files alike; node_modules excluded', async () => {
    const walk = await run('walk');
    const git = await run('git');

    expect(git.files).toEqual(walk.files);
    expect(git.total).toBe(walk.total);
    expect(git.files).toEqual(['.github/ci.yml', 'ignored.txt', 'tracked.ts', 'untracked.ts']);
    // The point: git read only the files that contain the needle.
    expect(git.searched).toBeLessThan(walk.searched);
  });

  it('case sensitivity and whole-word behave the same', async () => {
    for (const options of [{ caseSensitive: true }, { wholeWord: true }]) {
      const walk = await run('walk', options);
      const git = await run('git', options);
      expect(git.files).toEqual(walk.files);
      expect(git.total).toBe(walk.total);
    }
  });

  it('a caller ignore list is honoured', async () => {
    const options = { ignore: ['**/.github/**', '**/node_modules/**'] };
    expect((await run('git', options)).files).toEqual((await run('walk', options)).files);
  });
});

describe('when git is not asked', () => {
  // The parity tests above leave the backend env set; these call git directly.
  beforeEach(() => {
    delete process.env.TOKEN_OPTIMIZER_GREP_BACKEND;
  });
  const base = {
    cwd: '',
    files: ['**/*'],
    regex: false,
    caseSensitive: false,
    wholeWord: false,
    skipBinary: true,
    ignore: [],
  };

  it('a regex is left to the walk', async () => {
    expect(await gitGrepCandidates('N.EDLE', { ...base, cwd: repo, regex: true }, 5_000)).toBeNull();
  });

  it('explicit file globs are left to the walk', async () => {
    expect(await gitGrepCandidates(NEEDLE, { ...base, cwd: repo, files: ['**/*.ts'] }, 5_000)).toBeNull();
  });

  it('a directory that is not a repository is left to the walk', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'grep-plain-'));
    try {
      expect(await gitGrepCandidates(NEEDLE, { ...base, cwd: plain }, 5_000)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('a repository with no match is an empty answer, not a fallback', async () => {
    expect(await gitGrepCandidates('ZZ_NOT_ANYWHERE', { ...base, cwd: repo }, 5_000)).toEqual([]);
  });
});
