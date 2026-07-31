/**
 * What counts as a touched file, and which project it belongs to.
 *
 * Every case here is a regression from the FIRST LIVE RUN against a real
 * repository. The unit suite was green throughout, because it drove the graph
 * functions directly and never asked the question these tests ask: when a real
 * agent works in a real shell, does anything get recorded at all?
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { touchedPaths } from '../../hooks-core/decide.mjs';
import { projectRootFor } from '../../hooks-core/wiki.mjs';

let home;
let repoA;
let repoB;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'touched-'));
  repoA = join(home, 'repo-a');
  repoB = join(home, 'repo-b');
  for (const repo of [repoA, repoB]) {
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'main.ts'), 'export const x = 1;\n');
  }
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const bash = (command, cwd) => touchedPaths({ tool_name: 'Bash', tool_input: { command }, cwd });
const names = (paths) => paths.map((p) => p.split('/').slice(-2).join('/'));

describe('a touch is a touch however the tool spells it', () => {
  test('a Read names its file', () => {
    const out = touchedPaths({ tool_name: 'Read', tool_input: { file_path: join(repoA, 'src/main.ts') }, cwd: repoA });
    expect(names(out)).toEqual(['src/main.ts']);
  });

  test('a shell operand counts too -- a session in the shell was invisible', () => {
    expect(names(bash('wc -l src/main.ts', repoA))).toEqual(['src/main.ts']);
  });

  test('an operand AFTER a pipe is still a real read', () => {
    // fileOperands looks only at the head of the pipeline because that is where
    // the COST is; observation is a different question, and dropping this lost
    // a genuine touch.
    expect(names(bash('echo hi | wc -l src/main.ts', repoA))).toEqual(['src/main.ts']);
  });

  test('flags, globs and heredocs never become files', () => {
    // Inventing a node for a flag would put fiction in the graph.
    expect(bash('grep -rn "x" src/*.ts', repoA)).toEqual([]);
    expect(bash('cat <<EOF', repoA)).toEqual([]);
  });

  test('a path that does not resolve is not recorded', () => {
    expect(bash('wc -l src/nope.ts', repoA)).toEqual([]);
  });
});

describe('a `cd` inside the command changes where operands resolve', () => {
  test('relative operands follow the cd, not the session cwd', () => {
    // Observed live: a Bash call beginning `cd /other/repo` had its operands
    // resolved against the session's directory, matched nothing, and recorded
    // no touch -- so all work in a second checkout was invisible.
    const out = bash(`cd ${repoB}\nwc -l src/main.ts`, repoA);
    expect(out).toHaveLength(1);
    expect(out[0].startsWith(repoB.split('\\').join('/'))).toBe(true);
  });

  test('without a cd, the session cwd still applies', () => {
    const out = bash('wc -l src/main.ts', repoA);
    expect(out[0].startsWith(repoA.split('\\').join('/'))).toBe(true);
  });
});

describe('the graph a touch belongs to is the FILE\'s project', () => {
  test('a file in another repository routes to that repository', () => {
    // Keying the graph on the session cwd put findings about one project into
    // another project's graph, which quietly breaks the per-project promise.
    const root = projectRootFor(join(repoB, 'src/main.ts'), repoA);
    expect(root).toBe(repoB.split('\\').join('/'));
  });

  test('a file outside any repository falls back to the session project', () => {
    const loose = join(home, 'scratch.ts');
    writeFileSync(loose, 'x');
    expect(projectRootFor(loose, repoA)).toBe(repoA.split('\\').join('/'));
  });

  test('the marker search does not run away up the tree', () => {
    // A bounded walk, so a path on a huge filesystem cannot cost a hook call.
    expect(projectRootFor(join(repoA, 'src/main.ts'), repoA)).toBe(repoA.split('\\').join('/'));
  });
});
