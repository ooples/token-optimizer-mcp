import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SmartGlobTool } from '../../src/tools/file-operations/smart-glob.js';
import { SmartGrepTool } from '../../src/tools/file-operations/smart-grep.js';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { TokenCounter } from '../../src/core/token-counter.js';
import { MetricsCollector } from '../../src/core/metrics.js';

/**
 * A dot-directory is not a hidden implementation detail. It is where the CI lives.
 *
 * `glob` does not descend into paths beginning with a dot unless `dot: true`, and
 * neither tool set it. So every `.github/`, `.claude/`, `.vscode/`, `.husky/` and
 * every dotfile was invisible, and a repo-wide search answered:
 *
 *     { success: true, totalMatches: 0, filesSearched: 654 }
 *
 * MEASURED, in a real checkout: ten `.yml` files existed, all of them under
 * `.github/workflows/`, and `smart_glob('**\/*.yml')` returned zero. Searching the
 * SAME tree with `.github` named explicitly in `path` returned 7 matches across 4
 * files. The tool reported success both times.
 *
 * This is the third instance of one failure mode in these two tools -- `path`
 * dropped entirely, `path` naming a file, and now dot-directories -- and it is the
 * worst of the three, because `filesSearched` is large and non-zero. The other two
 * at least reported 0 files searched; this one looks like a thorough search that
 * found nothing.
 *
 * It also corrupted a measurement: an experiment classified a fact as "absent from
 * this tree" on the strength of one of these zeros, when the fact was sitting in
 * four workflow files.
 *
 * The ignore list stays the control. `.git/` is excluded because it is in the
 * default ignores, NOT because of the dot -- asserted below, since enabling `dot`
 * without that would start walking object storage.
 */

let dir: string;
let cache: CacheEngine;
let tokenCounter: TokenCounter;
let metrics: MetricsCollector;

const deps = () => [cache, tokenCounter, metrics] as const;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dot-dirs-'));

  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(dir, '.github', 'workflows', 'release.yml'),
    'name: Release\njobs:\n  publish:\n    env:\n      TOKEN: ${{ secrets.GITHUB_TOKEN }}\n'
  );

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = 1;\n');

  // A dotFILE at the root, not only a dot-directory.
  writeFileSync(join(dir, '.eslintrc.json'), '{ "root": true }\n');

  // Must stay excluded by the ignore list, dot or not.
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'config.yml'), 'core: true\n');

  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.yml'), 'dep: true\n');

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

describe('smart_glob and dot-directories', () => {
  it('finds a workflow file under .github', async () => {
    const tool = new SmartGlobTool(...deps());

    const result = await tool.glob('**/*.yml', { path: dir });

    expect(result.files?.map((f) => String(f).replace(/\\/g, '/'))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('.github/workflows/release.yml'),
      ])
    );
  });

  it('finds a dotfile at the root', async () => {
    const tool = new SmartGlobTool(...deps());

    const result = await tool.glob('**/*.json', { path: dir });

    expect(
      result.files?.some((f) => String(f).includes('.eslintrc.json'))
    ).toBe(true);
  });

  it('still excludes .git and node_modules, which the ignore list owns', async () => {
    // Enabling `dot` without this would start walking git object storage.
    const tool = new SmartGlobTool(...deps());

    const result = await tool.glob('**/*.yml', { path: dir });
    const paths = (result.files ?? []).map((f) =>
      String(f).replace(/\\/g, '/')
    );

    expect(paths.some((p) => p.includes('.git/'))).toBe(false);
    expect(paths.some((p) => p.includes('node_modules/'))).toBe(false);

    // The COUNT too, not just the result list. Without this the comparison walk
    // could stop matching .git entirely and these assertions would still pass,
    // leaving the number that explains the omission silently wrong.
    // ONE, and the exact number matters. The fixture hides a .yml in `.git` and
    // another in `node_modules`. `.git` is excluded from BOTH walks, so it
    // contributes nothing to the difference; `node_modules` is withheld by the
    // caller's ignore list, so it is correctly reported as one withheld match.
    // Asserting 0 here would have re-introduced the bug this count exists to
    // prevent -- a silent omission with no number to explain it.
    expect(result.metadata?.ignoredMatches ?? 0).toBe(1);
  });
});

describe('smart_grep and dot-directories', () => {
  it('finds content inside a .github workflow', async () => {
    const tool = new SmartGrepTool(...deps());

    const result = await tool.grep('GITHUB_TOKEN', { path: dir });

    expect(result.metadata?.totalMatches).toBeGreaterThan(0);
  });

  it('reports the same count whether or not .github is named explicitly', async () => {
    // The defect was only visible by comparing the two: searching the parent said
    // zero, searching `.github` directly said seven, and both claimed success.
    const tool = new SmartGrepTool(...deps());

    const fromRoot = await tool.grep('GITHUB_TOKEN', { path: dir });
    const fromDotDir = await tool.grep('GITHUB_TOKEN', {
      path: join(dir, '.github'),
    });

    expect(fromRoot.metadata?.totalMatches).toBe(
      fromDotDir.metadata?.totalMatches
    );
  });
});
