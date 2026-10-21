import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SmartGrepTool,
  gitEnvironment,
  gitGrepCandidates,
} from '../../src/tools/file-operations/smart-grep.js';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { TokenCounter } from '../../src/core/token-counter.js';
import { MetricsCollector } from '../../src/core/metrics.js';

// Every fixture git call runs without inherited GIT_* variables, so a test run
// started inside another repository (GIT_DIR, GIT_INDEX_FILE) cannot touch it
// (review on #517). The product's runGit strips them the same way.
const gitFixture = (args: string[], options: { stdio?: 'ignore' } = {}) =>
  execFileSync('git', args, { ...options, env: gitEnvironment() });

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
  gitFixture(['init', '-q', repo]);
  writeFileSync(join(repo, '.gitignore'), 'ignored.txt\nbuild/\n');
  writeFileSync(join(repo, 'tracked.ts'), `const a = '${NEEDLE}';\n`);
  writeFileSync(join(repo, 'untracked.ts'), `// ${NEEDLE.toLowerCase()}\n`);
  writeFileSync(join(repo, 'ignored.txt'), `${NEEDLE}\n`);
  mkdirSync(join(repo, '.github'));
  writeFileSync(join(repo, '.github', 'ci.yml'), `env: ${NEEDLE}\n`);
  mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'dep', 'x.js'), `${NEEDLE}\n`);
  writeFileSync(join(repo, 'nothing.ts'), 'no match here\n');
  gitFixture(['-C', repo, 'add', 'tracked.ts', '.gitignore']);
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
  it('tracked, untracked and dot files alike; gitignored and node_modules excluded', async () => {
    const walk = await run('walk');
    const git = await run('git');

    expect(git.files).toEqual(walk.files);
    expect(git.total).toBe(walk.total);
    expect(git.files).toEqual(['.github/ci.yml', 'tracked.ts', 'untracked.ts']);
    // The point: git read only the files that contain the needle.
    expect(git.searched).toBeLessThan(walk.searched);
  });

  it('with includeIgnored, gitignored files too -- still the same answer', async () => {
    const walk = await run('walk', { includeIgnored: true });
    const git = await run('git', { includeIgnored: true });

    expect(git.files).toEqual(walk.files);
    expect(git.total).toBe(walk.total);
    expect(git.files).toEqual(['.github/ci.yml', 'ignored.txt', 'tracked.ts', 'untracked.ts']);
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
    expect(await gitGrepCandidates('N.EDLE', { ...base, cwd: repo, regex: true }, 30_000)).toBeNull();
  });

  it('explicit file globs are left to the walk', async () => {
    expect(await gitGrepCandidates(NEEDLE, { ...base, cwd: repo, files: ['**/*.ts'] }, 30_000)).toBeNull();
  });

  it('a directory that is not a repository is left to the walk', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'grep-plain-'));
    try {
      expect(await gitGrepCandidates(NEEDLE, { ...base, cwd: plain }, 30_000)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('a repository with no match is an empty answer, not a fallback', async () => {
    expect(await gitGrepCandidates('ZZ_NOT_ANYWHERE', { ...base, cwd: repo }, 30_000)).toEqual([]);
  });

  // Review on #517: every case where git's answer could be SMALLER than the walk's.
  it('wholeWord with a non-word edge, case-insensitive non-ASCII, and non-UTF-8 are left to the walk', async () => {
    expect(await gitGrepCandidates('foo(', { ...base, cwd: repo, wholeWord: true }, 30_000)).toBeNull();
    expect(await gitGrepCandidates('(foo', { ...base, cwd: repo, wholeWord: true }, 30_000)).toBeNull();
    expect(await gitGrepCandidates('straße', { ...base, cwd: repo }, 30_000)).toBeNull();
    expect(await gitGrepCandidates(NEEDLE, { ...base, cwd: repo, encoding: 'utf16le' }, 30_000)).toBeNull();
    // ...while the plain cases still go to git.
    expect(await gitGrepCandidates('NEEDLE_7Q', { ...base, cwd: repo, wholeWord: true }, 30_000)).not.toBeNull();
    expect(await gitGrepCandidates('straße', { ...base, cwd: repo, caseSensitive: true }, 30_000)).toEqual([]);
  });

  it('a nested repository or a submodule is left to the walk', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'grep-nested-'));
    try {
      gitFixture(['init', '-q', outer]);
      writeFileSync(join(outer, 'top.ts'), `${NEEDLE}\n`);
      expect(await gitGrepCandidates(NEEDLE, { ...base, cwd: outer }, 30_000)).toEqual([join(outer, 'top.ts')]);

      const inner = join(outer, 'vendored');
      gitFixture(['init', '-q', inner]);
      writeFileSync(join(inner, 'deep.ts'), `${NEEDLE}\n`);
      expect(await gitGrepCandidates(NEEDLE, { ...base, cwd: outer }, 30_000)).toBeNull();

      // A submodule is an index entry of mode 160000.
      rmSync(inner, { recursive: true, force: true });
      gitFixture([
        '-C', outer, 'update-index', '--add', '--cacheinfo',
        `160000,${'1'.repeat(40)},sub`,
      ]);
      expect(await gitGrepCandidates(NEEDLE, { ...base, cwd: outer }, 30_000)).toBeNull();
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('a filename with spaces and a quote survives the path parsing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grep-names-'));
    try {
      gitFixture(['init', '-q', dir]);
      const odd = join(dir, ' odd "name".ts');
      writeFileSync(odd, `${NEEDLE}\n`);
      expect(await gitGrepCandidates(NEEDLE, { ...base, cwd: dir }, 30_000)).toEqual([odd]);
    } catch (error) {
      // A filesystem that refuses `"` in names (Windows) cannot hold the case.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'EINVAL')
        throw error;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the searched repository's core.fsmonitor hook does not run", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grep-fsmon-'));
    try {
      gitFixture(['init', '-q', dir]);
      writeFileSync(join(dir, 'a.ts'), `${NEEDLE}\n`);
      const marker = join(dir, 'HOOK_RAN');
      const hook = join(dir, 'hook.sh');
      writeFileSync(hook, `#!/bin/sh\ntouch "${marker.replace(/\\/g, '/')}"\nexit 1\n`, { mode: 0o755 });
      gitFixture(['-C', dir, 'config', 'core.fsmonitor', hook.replace(/\\/g, '/')]);

      expect(await gitGrepCandidates(NEEDLE, { ...base, cwd: dir }, 30_000)).toEqual([join(dir, 'a.ts')]);
      expect(existsSync(marker)).toBe(false);

      // The control: an ordinary git command in that repository DOES run it. If
      // this platform's git cannot run the hook at all, the case above proves nothing.
      try {
        gitFixture(['-C', dir, 'status', '--untracked-files=all'], { stdio: 'ignore' });
      } catch {
        /* a failing hook can fail status; only whether it ran matters */
      }
      if (!existsSync(marker)) return;
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  // Second review round on #517.
  it('a nested repository below an untracked directory is left to the walk', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'grep-deep-'));
    try {
      gitFixture(['init', '-q', outer]);
      mkdirSync(join(outer, 'third_party', 'libfoo'), { recursive: true });
      writeFileSync(join(outer, 'third_party', 'top.ts'), `${NEEDLE}\n`);
      expect(await gitGrepCandidates(NEEDLE, { ...base, cwd: outer }, 30_000)).toEqual([
        join(outer, 'third_party', 'top.ts'),
      ]);
      gitFixture(['init', '-q', join(outer, 'third_party', 'libfoo')]);
      writeFileSync(join(outer, 'third_party', 'libfoo', 'deep.ts'), `${NEEDLE}\n`);
      expect(await gitGrepCandidates(NEEDLE, { ...base, cwd: outer }, 30_000)).toBeNull();
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('a tracked or untracked symlink is left to the walk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grep-link-'));
    try {
      gitFixture(['init', '-q', dir]);
      writeFileSync(join(dir, 'real.ts'), `${NEEDLE}\n`);
      expect(await gitGrepCandidates(NEEDLE, { ...base, cwd: dir }, 30_000)).toEqual([join(dir, 'real.ts')]);
      try {
        symlinkSync(join(dir, 'real.ts'), join(dir, 'link.ts'));
      } catch {
        return; // no symlink privilege on this host
      }
      expect(await gitGrepCandidates(NEEDLE, { ...base, cwd: dir }, 30_000)).toBeNull();
      gitFixture(['-C', dir, 'add', 'link.ts']);
      expect(await gitGrepCandidates(NEEDLE, { ...base, cwd: dir }, 30_000)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a text file .gitattributes marks binary is still a candidate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grep-attr-'));
    try {
      gitFixture(['init', '-q', dir]);
      writeFileSync(join(dir, '.gitattributes'), '*.svg binary\n');
      writeFileSync(join(dir, 'icon.svg'), `<svg><title>${NEEDLE}</title></svg>\n`);
      expect(await gitGrepCandidates(NEEDLE, { ...base, cwd: dir }, 30_000)).toEqual([join(dir, 'icon.svg')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('git runs without inherited GIT_* variables', () => {
    const env = gitEnvironment({ PATH: '/bin', GIT_DIR: '/elsewhere/.git', GIT_INDEX_FILE: '/x', git_work_tree: '/y' });
    expect(env).toEqual({ PATH: '/bin' });
  });
});
