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
import { touchedPaths, isContentDump } from '../../hooks-core/decide.mjs';
import { projectRootFor } from '../../hooks-core/wiki.mjs';
import { isMachineOwned } from '../../hooks-core/policy.mjs';

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
    // Actually builds a chain deeper than the bound, rather than re-checking
    // the shallow case the tests above already cover -- the previous version of
    // this test named the depth bound without ever reaching it.
    const deep = join(home, 'unmarked', Array.from({ length: 45 }, (_, i) => `d${i}`).join('/'));
    mkdirSync(deep, { recursive: true });
    const buried = join(deep, 'main.ts');
    writeFileSync(buried, 'x');

    // No marker anywhere above it within the bound, so it must fall back rather
    // than walk to the filesystem root.
    expect(projectRootFor(buried, repoA)).toBe(repoA.split('\\').join('/'));
  });

  test('a nested package.json does NOT shadow the repository root', () => {
    // In a monorepo every workspace has a manifest, so treating package.json as
    // a repository marker split one project's graph into as many graphs as it
    // had manifests.
    const pkg = join(repoA, 'packages', 'foo');
    mkdirSync(join(pkg, 'src'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), '{}');
    const file = join(pkg, 'src', 'index.ts');
    writeFileSync(file, 'x');

    expect(projectRootFor(file, repoA)).toBe(repoA.split('\\').join('/'));
  });

  test('a .git FILE counts, not just a directory', () => {
    // Submodules and `git worktree` checkouts both write a .git FILE pointing
    // elsewhere, and those are the layouts where the root is easiest to get
    // wrong.
    const wt = join(home, 'worktree');
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
    const file = join(wt, 'src', 'main.ts');
    writeFileSync(file, 'x');

    expect(projectRootFor(file, repoA)).toBe(wt.split('\\').join('/'));
  });
});

describe('a cd that goes nowhere must not lose the touch', () => {
  test('an unresolvable cd falls back to the session cwd', () => {
    // `cd $REPO && cat src/main.ts` with $REPO unexpanded re-based every
    // relative operand onto a path resolving to nothing, so the call recorded
    // no touch at all.
    const out = bash('cd $REPO\nwc -l src/main.ts', repoA);
    expect(names(out)).toEqual(['src/main.ts']);
  });

  test('a cd to a missing directory also falls back', () => {
    const out = bash(`cd ${join(home, 'does-not-exist')}\nwc -l src/main.ts`, repoA);
    expect(names(out)).toEqual(['src/main.ts']);
  });

  test('a cd to a FILE is not treated as a directory', () => {
    const out = bash(`cd ${join(repoA, 'src/main.ts')}\nwc -l src/main.ts`, repoA);
    expect(names(out)).toEqual(['src/main.ts']);
  });
});

describe('machine-owned paths are never knowledge', () => {
  test('VCS internals, dependencies and build output are excluded', () => {
    // Found live: a Read of a 1.3 MB binary git index was REFUSED with an offer
    // of "structure and what is known about it", delivered an empty structure
    // section because there is none, and pointed at smart_read -- which would
    // have dumped the binary. The same call also wrote that index into the
    // knowledge graph as a file node.
    for (const p of ['/r/.git/index', '/r/node_modules/x/a.js', '/r/dist/main.js', '/r/obj/Debug/x.dll']) {
      expect(isMachineOwned(p)).toBe(true);
    }
  });

  test('authored files that merely start with a dot are kept', () => {
    // .github/workflows is written by people and is worth remembering, so the
    // rule cannot simply be "starts with a dot".
    for (const p of ['/r/src/app.ts', '/r/.github/workflows/ci.yml', '/r/.eslintrc.json']) {
      expect(isMachineOwned(p)).toBe(false);
    }
  });

  test('windows separators are excluded too', () => {
    expect(isMachineOwned('C:\\repo\\.git\\index')).toBe(true);
  });

  test('a machine-owned operand is not harvested', () => {
    const vcs = join(repoA, '.git', 'index');
    writeFileSync(vcs, 'binary-ish');
    expect(bash(`head -1 ${vcs}`, repoA)).toEqual([]);
  });
});

describe('only content dumps pay for the bytes', () => {
  test('cat and grep are dumps', () => {
    expect(isContentDump('cat src/main.ts')).toBe(true);
    expect(isContentDump('grep -rn x src')).toBe(true);
  });

  test('a bare wc or an edit is not', () => {
    // Charging these a full-file read inflated the cost the holdout comparison
    // is built on, and an overstated saving is the one number to never produce.
    expect(isContentDump('wc -l src/main.ts')).toBe(false);
    expect(isContentDump('')).toBe(false);
    expect(isContentDump(undefined)).toBe(false);
  });
});
