/**
 * What counts as a touched file, and which project it belongs to.
 *
 * Every case here is a regression from the FIRST LIVE RUN against a real
 * repository. The unit suite was green throughout, because it drove the graph
 * functions directly and never asked the question these tests ask: when a real
 * agent works in a real shell, does anything get recorded at all?
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { touchedFiles, isContentDump, decide, isRecursiveSearch, normalizePayload } from '../../hooks-core/decide.mjs';

// touchedPaths was a compatibility shim -- `touchedFiles(p).map(f => f.path)` --
// kept, per its own docstring, "so every existing caller and test reads exactly
// the same". It had no callers outside this file, so the shim was serving only
// the test that existed to check it. The paths are what this suite is about, so
// it derives them directly now.
const touchedPaths = (payload) => touchedFiles(payload).map((f) => f.path);
import { projectRootFor, unrootedRoot } from '../../hooks-core/wiki.mjs';
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

  test('a file outside any repository routes to the stable unrooted graph', () => {
    // This used to fall back to the caller's cwd. That made the answer depend on
    // where the process was launched rather than on the file: the same file
    // resolved to `<plugin>` from one directory and `<plugin>/mcp` from another,
    // producing two graphs (185 and 284 nodes) for one logical project, with the
    // briefing only ever reading one of them. Every directory a session visits
    // became another shard.
    const loose = join(home, 'scratch.ts');
    writeFileSync(loose, 'x');
    expect(projectRootFor(loose, repoA)).toBe(unrootedRoot());
  });

  test('an unrooted file resolves the same regardless of the caller cwd', () => {
    // The actual property being bought: determinism per FILE, not per caller.
    const loose = join(home, 'scratch2.ts');
    writeFileSync(loose, 'x');
    expect(projectRootFor(loose, repoA)).toBe(projectRootFor(loose, repoB));
    expect(projectRootFor(loose, undefined)).toBe(projectRootFor(loose, repoA));
  });

  test('the marker search does not run away up the tree', () => {
    // Actually builds a chain deeper than the bound, rather than re-checking
    // the shallow case the tests above already cover -- the previous version of
    // this test named the depth bound without ever reaching it.
    const deep = join(home, 'unmarked', Array.from({ length: 45 }, (_, i) => `d${i}`).join('/'));
    mkdirSync(deep, { recursive: true });
    const buried = join(deep, 'main.ts');
    writeFileSync(buried, 'x');

    // No marker anywhere above it within the bound, so it must stop and take the
    // unrooted graph rather than walk to the filesystem root.
    expect(projectRootFor(buried, repoA)).toBe(unrootedRoot());
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

  test('a machine-owned operand is not advised about either', () => {
    // The COST path had its own copy of this hole. It guarded on
    // isBinaryPath, which is extension-based, and `.git/index` has no
    // extension -- so a `cat .git/index` was told to use smart_read on a
    // binary index. Caught live, on this repository's own commit command.
    const vcs = join(repoA, '.git', 'index');
    writeFileSync(vcs, 'x'.repeat(200_000));
    const verdict = decide({ tool_name: 'Bash', tool_input: { command: `cat ${vcs}` }, cwd: repoA }, {});
    expect(verdict).toBeNull();

    // ...while a large authored file in the same repository still is.
    const big = join(repoA, 'src', 'big.ts');
    writeFileSync(big, 'x'.repeat(200_000));
    expect(decide({ tool_name: 'Bash', tool_input: { command: `cat ${big}` }, cwd: repoA }, {})).toBeTruthy();
  });
});

describe('a recursive search is a SEGMENT, not two words in the same string', () => {
  // Caught live: a real build command was refused as a recursive search because
  // the detector asked "is a search tool anywhere in this string?" and "is a
  // -r-ish flag anywhere in this string?" as two INDEPENDENT questions. Any
  // rm -rf / cp -r / chmod -R standing next to any grep matched both.
  test('a -r flag belonging to a DIFFERENT command does not make a search', () => {
    expect(isRecursiveSearch('rm -rf build && npm run verify | grep passed')).toBe(false);
    expect(isRecursiveSearch('cp -r a b && grep needle notes.txt')).toBe(false);
    expect(isRecursiveSearch('chmod -R 755 dir; grep x file')).toBe(false);
    expect(isRecursiveSearch('tar -rf out.tar dir | grep added')).toBe(false);
  });

  test('a real recursive search is still caught, however it is spelled', () => {
    for (const c of ['grep -rn foo src/', 'grep -R foo .', 'grep --recursive foo .',
      'rg foo', 'ag foo', 'git grep -r foo', 'sudo grep -r foo /etc', '/usr/bin/grep -r x .']) {
      expect(isRecursiveSearch(c)).toBe(true);
    }
  });

  test('a search MENTIONED inside quotes is a string, not a command', () => {
    // The mirror image, and the reason segmentation is quote-aware: this hook
    // refused its own author's commit command because the message quoted a
    // recursive grep.
    expect(isRecursiveSearch('node -e "run(\'grep -r x .\')"')).toBe(false);
    expect(isRecursiveSearch("git commit -m 'use grep -r for this'")).toBe(false);
  });

  test('a dump command in one segment does not indict an operand in another', () => {
    // Caught live while starting the dashboard. `wc -l` prints a COUNT, and the
    // only dump command in the line was a `head -5` tailing a 4 KB log in a
    // different segment -- yet the refusal claimed the command would print a
    // 22 MB graph file, because the dump test and the operand search were two
    // independent whole-string tests joined by an unrelated `&&`.
    const big = join(repoA, 'big.jsonl');
    writeFileSync(big, 'x'.repeat(200_000));
    const log = join(repoA, 'small.log');
    writeFileSync(log, 'listening\n');

    const counted = decide(
      { tool_name: 'Bash', tool_input: { command: `wc -l ${big} && grep listen ${log} | head -5` }, cwd: repoA },
      {}
    );
    expect(counted).toBeNull();

    // ...but actually printing the big file is still caught.
    const dumped = decide(
      { tool_name: 'Bash', tool_input: { command: `cat ${big}` }, cwd: repoA },
      {}
    );
    expect(dumped).toBeTruthy();
    expect(dumped.reason).toContain('prints');
  });

  test('a heredoc BODY is data, not a script the shell will run', () => {
    // Three separate self-refusals in one afternoon traced to this: a test
    // fixture quoting `cat .git/index`, then two commit messages describing the
    // very greps they were fixing. `git commit -F - <<'MSG' ... MSG` is one
    // command, and it runs git.
    const message = [
      "git commit -F - <<'MSG'",
      'fix: stop matching greps that never run',
      '',
      '  grep -rn residual src/    still deny',
      '  rg foo                    still deny',
      'MSG',
    ].join('\n');
    expect(isRecursiveSearch(message)).toBe(false);
    expect(isContentDump("git commit -F - <<'MSG'\ncat huge.log\nMSG")).toBe(false);

    // ...but a real search AFTER the body has closed still counts.
    expect(isRecursiveSearch(`${message}\ngrep -r needle src/`)).toBe(true);
  });

  test('a file named only inside a heredoc is not a touch', () => {
    const doc = `cat <<'EOF'\nsee src/main.ts for details\nEOF`;
    expect(bash(doc, repoA)).toEqual([]);
  });

  test('a non-recursive grep is left alone', () => {
    expect(isRecursiveSearch('grep needle one-file.txt')).toBe(false);
    expect(isRecursiveSearch('git log | grep fix')).toBe(false);
  });
});

describe('every payload dialect reaches the same judgement', () => {
  // A client whose arguments are not recognised still carries a tool name, so
  // the hook runs, finds no path and no command, and allows everything. There
  // is no error and no failing check -- the integration is simply a no-op. That
  // is the worst way for this to break, so every spelling is covered.
  test('the args container is found under any of its names', () => {
    const file = join(repoA, 'src/main.ts');
    for (const key of ['tool_input', 'toolInput', 'tool_args', 'toolArgs', 'arguments', 'args', 'parameters']) {
      const payload = normalizePayload({ session_id: 's', cwd: repoA, tool_name: 'Read', [key]: { file_path: file } });
      expect(payload.tool_input.file_path).toBeTruthy();
    }
  });

  test('the tool name is found under any of its names', () => {
    for (const key of ['tool_name', 'toolName', 'tool']) {
      const payload = normalizePayload({ session_id: 's', cwd: repoA, [key]: 'Read', tool_input: {} });
      expect(payload.tool_name).toBe('Read');
    }
  });
});

describe('a refusal must never cost more than the file it replaces', () => {
  // Found by a live invariant sweep over 120 real files across four
  // repositories: the refusal text is itself 50-110 tokens, so for a small
  // enough file every branch spends more than the read would have. The re-read
  // branch was the reachable one at DEFAULT settings -- it fired on any repeat
  // read regardless of size, because it reasoned about the SAVING and treated
  // the refusal as free.
  const tiny = () => {
    const p = join(repoA, 'version.json');
    writeFileSync(p, '{"v":"1"}');
    return p;
  };

  test('a re-read of a 9-byte file is allowed, not refused for 57 tokens', () => {
    const path = tiny();
    const state = { seen: { [path]: true }, denied: {} };
    expect(decide({ tool_name: 'Read', tool_input: { file_path: path }, cwd: repoA }, state)).toBeNull();
  });

  test('a re-read above the floor still IS refused -- the fix must not disarm it', () => {
    const path = join(repoA, 'big.ts');
    writeFileSync(path, 'export const v = 1;\n'.repeat(400));
    const state = { seen: { [path]: true }, denied: {} };
    const verdict = decide({ tool_name: 'Read', tool_input: { file_path: path }, cwd: repoA }, state);
    expect(verdict).toBeTruthy();
    expect(verdict.reason).toContain('already read');
  });

  test('whatever a refusal says, it is cheaper than the file', () => {
    // The invariant itself, stated directly.
    const path = join(repoA, 'big.ts');
    const body = 'export const v = 1;\n'.repeat(2000);
    writeFileSync(path, body);
    const state = { seen: { [path]: true }, denied: {} };
    const verdict = decide({ tool_name: 'Read', tool_input: { file_path: path }, cwd: repoA }, state);
    expect(verdict.reason.length).toBeLessThan(body.length / 2);
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

    // The test is NAMED for edits, so it has to contain one. Without these, a
    // regression classifying `sed -i` as a content dump passed here untouched:
    // the assertions covered wc, an empty string and undefined, and no edit at
    // all. A test that does not exercise the case in its own title is worse
    // than no test, because it reads as coverage.
    expect(isContentDump('sed -i "s/x/y/" src/main.ts')).toBe(false);
    expect(isContentDump("perl -pi -e 's/a/b/' src/main.ts")).toBe(false);
    expect(isContentDump('tee src/main.ts')).toBe(false);

    expect(isContentDump('')).toBe(false);
    expect(isContentDump(undefined)).toBe(false);
  });
});

describe('a touch carries the size that was measured to find it', () => {
  // Resolving a candidate ALREADY stats it -- `fileSize(spelling) >= 0` is how
  // a real file is told from a flag or a glob. Throwing that answer away made
  // the router stat every path twice more: once for the read cost, once for the
  // harvest size cap. On a hook that runs before EVERY tool call, for every
  // operand of every command.
  const bashFiles = (command, cwd) =>
    touchedFiles({ tool_name: 'Bash', tool_input: { command }, cwd });

  test('the size comes back with the path', () => {
    const out = bashFiles('wc -l src/main.ts', repoA);
    expect(out).toHaveLength(1);
    expect(out[0].size).toBe(statSync(join(repoA, 'src/main.ts')).size);
  });

  test.skip('REMOVED: compared touchedPaths with its own definition once the shim went', () => {
    // The sizes are additional information, not a different answer.
    const payload = { tool_name: 'Bash', tool_input: { command: 'wc -l src/main.ts' }, cwd: repoA };
    expect(touchedFiles(payload).map((f) => f.path)).toEqual(touchedPaths(payload));
  });

  test('a path that does not resolve carries no size, because it is not there', () => {
    expect(bashFiles('wc -l src/nope.ts', repoA)).toEqual([]);
  });

  test('a machine-owned path is still excluded, sizes or not', () => {
    // The size must not become a reason to keep something the graph rejects.
    mkdirSync(join(repoA, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(repoA, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;');
    expect(bashFiles('wc -l node_modules/pkg/index.js', repoA)).toEqual([]);
  });
});
