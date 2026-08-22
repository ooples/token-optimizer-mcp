/**
 * Regression coverage for wiki_write anchors with no VCS ancestor.
 *
 * Each containment scenario runs in a fresh Node process. This is required on
 * Windows, where os.homedir() may retain the USERPROFILE value present when the
 * process started; mutating HOME or USERPROFILE inside Jest does not exercise
 * the production behavior and leaks environment changes into later tests.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { isFilesystemRoot } from '../../hooks-core/harvest-write.mjs';
import { canonicalPath } from '../../hooks-core/paths.mjs';

const PROBE = fileURLToPath(
  new URL('../fixtures/wiki-write-unrooted-probe.mjs', import.meta.url)
);

let sandbox;
let fakeHome;

function runScenario(scenario, { home = fakeHome } = {}) {
  const graph = join(sandbox, `graph-${scenario}`);
  const unrooted = join(sandbox, `unrooted-${scenario}`);
  mkdirSync(graph, { recursive: true });
  mkdirSync(unrooted, { recursive: true });

  const child = spawnSync(process.execPath, [PROBE], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TOKEN_OPTIMIZER_TEST_SCENARIO: scenario,
      TOKEN_OPTIMIZER_TEST_SANDBOX: sandbox,
      TOKEN_OPTIMIZER_UNROOTED_DIR: unrooted,
      TOKEN_OPTIMIZER_WIKI_DIR: graph,
    },
    encoding: 'utf8',
  });

  expect(child.status).toBe(0);
  expect(child.stderr).toBe('');
  return JSON.parse(child.stdout.trim());
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'wiki-write-unrooted-'));
  fakeHome = join(sandbox, 'home');
  mkdirSync(fakeHome, { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('anchors with no VCS ancestor', () => {
  test('one under the home directory resolves', () => {
    expect(runScenario('home')).toEqual({
      projectIsUnrooted: true,
      written: 1,
    });
  });

  test('one outside the home directory stays refused', () => {
    expect(runScenario('outside')).toEqual({
      projectIsUnrooted: true,
      written: 0,
    });
  });

  test('the current platform filesystem root fails closed', () => {
    expect(runScenario('root', { home: parse(sandbox).root })).toEqual({
      homeIsRoot: true,
      projectIsUnrooted: true,
      written: 0,
    });
  });

  test.each([
    ['POSIX root', '/'],
    ['Windows drive root', 'C:\\'],
    ['Windows UNC share root', '\\\\server\\share\\'],
  ])('recognizes the portable filesystem-root shape: %s', (_label, path) => {
    expect(isFilesystemRoot(canonicalPath(path))).toBe(true);
  });

  (process.platform === 'win32' ? test : test.skip)(
    'accepts an existing Windows home path with different letter casing',
    () => {
      expect(runScenario('case')).toEqual({
        exists: true,
        projectIsUnrooted: true,
        written: 1,
      });
    }
  );

  test('refuses a symlink or junction that escapes the home directory', () => {
    expect(runScenario('link')).toEqual({
      projectIsUnrooted: true,
      written: 0,
    });
  });

  test('does not index a later anchor from a different repository', () => {
    expect(runScenario('cross-project')).toEqual({
      projectIsUnrooted: true,
      projectsDiffer: true,
      written: 1,
      repositoryIndexed: false,
    });
  });
});
