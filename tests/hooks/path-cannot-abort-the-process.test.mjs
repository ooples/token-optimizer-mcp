import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

/**
 * A path must never be able to ABORT the hook process.
 *
 * U+10FFFF is the largest legal Unicode code point, and libuv asserts
 * `code_point < 0x10FFFF` -- strictly less than -- while converting a UTF-8 path
 * to UTF-16 on Windows. The assert is off by one, so passing that character to
 * `existsSync`, `statSync` or `readFileSync` does not throw:
 *
 *     Assertion failed: code_point < 0x10FFFF, file c:\ws\deps\uv\src\idna.c, line 397
 *
 * The PROCESS DIES. That is categorically worse than an exception here, because
 * the whole hook is wrapped in `try { ... } catch` on the stated promise that
 * "any defect in this hook must cost the user nothing: an exception here allows
 * the call exactly as if the plugin were not installed". A native abort walks
 * straight through that catch, so the one guarantee the hook makes about its own
 * failures does not hold for this input.
 *
 * Found as an intermittent failure of the property suite -- it generates
 * arbitrary strings, so it produced U+10FFFF roughly one run in five and the
 * worker vanished with no assertion output, which is exactly how a crash looks
 * when a test framework cannot distinguish it from a hang.
 *
 * Characterised before fixing: U+10FFFD and U+10FFFE are fine, U+10FFFF is not.
 */

const CORE = (name) =>
  pathToFileURL(join(process.cwd(), 'hooks-core', name)).href;

/** The exact character libuv mishandles. */
const ABORTS = String.fromCodePoint(0x10ffff);

// AN ISOLATED, EMPTY GRAPH FOR EVERY SPAWN IN THIS SUITE.
//
// These spawns passed `cwd: process.cwd()`, so the hook resolved the project
// root to this repository and parsed its real graph -- 207 MB at the time this
// was written, 1.2-1.6 seconds per invocation. Four spawns against a 20 s
// budget is fine alone and not fine alongside 139 other suites, which is why
// this failed intermittently on a loaded machine and passed on a rerun.
//
// The suite is about whether a hostile PATH can abort the process. Nothing in
// it needs the developer's accumulated graph, and depending on it made the
// result a function of how much unrelated history happened to be on disk.
const ISOLATED_GRAPH = mkdtempSync(join(tmpdir(), 'abort-probe-graph-'));
const HOOK_ENV = { ...process.env, TOKEN_OPTIMIZER_WIKI_DIR: ISOLATED_GRAPH, TOKEN_OPTIMIZER_SHARED_DIR: ISOLATED_GRAPH };

afterAll(() => {
  try {
    rmSync(ISOLATED_GRAPH, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
});
/** Its neighbour, which is handled correctly -- the control for the guard. */
const SAFE_NEIGHBOUR = String.fromCodePoint(0x10fffe);

let contentHash;
let projectRootFor;
let isFsSafePath;
let touchedFiles;
let fileSize;
let indexFile;

beforeAll(async () => {
  ({ contentHash, projectRootFor } = await import(CORE('wiki.mjs')));
  ({ isFsSafePath } = await import(CORE('paths.mjs')));
  ({ touchedFiles } = await import(CORE('decide.mjs')));
  ({ fileSize } = await import(CORE('policy.mjs')));
  ({ indexFile } = await import(CORE('staleness.mjs')));
});

describe('a path that would abort libuv', () => {
  it('is rejected by the guard, and its neighbour is not', () => {
    // Both halves matter: a guard that rejects everything would also pass the
    // crash tests below while breaking every real path.
    expect(isFsSafePath(`/tmp/x${ABORTS}.ts`)).toBe(false);
    expect(isFsSafePath(`/tmp/x${SAFE_NEIGHBOUR}.ts`)).toBe(true);
    expect(isFsSafePath('C:/Users/x/project/src/app.ts')).toBe(true);
  });

  it('makes contentHash return null instead of killing the process', () => {
    // If the guard regresses, this does not fail -- the worker dies and the
    // whole suite is reported as unrunnable. That is the loudest possible
    // failure, and it is what the bug looked like before it was diagnosed.
    expect(contentHash(`/tmp/nope${ABORTS}.ts`)).toBeNull();
  });

  it('does not kill the process while looking for a repository root', () => {
    // projectRootFor walks UP a path calling existsSync at every level, so one
    // bad character anywhere in it aborts up to forty times over.
    expect(() =>
      projectRootFor(`/tmp/${ABORTS}/deep/file.ts`, process.cwd())
    ).not.toThrow();
  });

  it('is refused inside the low-level fs helpers, not only at call sites', () => {
    // Guarding call sites one at a time is the wrong shape: review found a
    // `cd` operand that reached statSync ahead of the guard, and the next
    // caller added would be just as easy to miss. Each of these helpers wraps
    // its own fs call in a try/catch that a native abort walks straight
    // through, so the check belongs INSIDE them, where no caller can forget it.
    expect(fileSize(`/tmp/x${ABORTS}.ts`)).toBe(-1);
    expect(indexFile(process.cwd(), `/tmp/x${ABORTS}.ts`)).toBeNull();
  });

  it('survives it in a `cd` operand, which is stat-ed before the candidates', () => {
    // `touchedFiles` resolves a leading `cd` first, to re-base the command's
    // relative operands, and decides whether to trust it with `isDirectory` --
    // a statSync. That happens BEFORE the per-candidate guard, so guarding only
    // the candidates left the abort reachable through any command beginning
    // `cd <bad path> && ...`.
    expect(() =>
      touchedFiles({
        tool_name: 'Bash',
        tool_input: { command: `cd /tmp/${ABORTS} && cat src/app.ts` },
        cwd: process.cwd(),
      })
    ).not.toThrow();
  });

  it.each([
    ['Read', { file_path: `/tmp/bad${ABORTS}.ts` }],
    ['Bash', { command: `cd /tmp/${ABORTS} && cat src/app.ts` }],
    ['Bash', { command: `grep -rn thing /tmp/${ABORTS}/src` }],
    ['Edit', { file_path: `/tmp/${ABORTS}/x.ts` }],
  ])('lets the real hook survive a %s payload carrying it', (tool, input) => {
    // The unit checks above name individual functions; this drives the actual
    // hook process the way Claude Code does. There are 84 fs calls across
    // hooks-core, so proving reachability end-to-end is worth more than
    // enumerating call sites -- which is exactly how the `cd` operand was
    // missed the first time.
    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), 'plugin', 'hooks', 'pretooluse-router.mjs')],
      {
        input: JSON.stringify({
          tool_name: tool,
          tool_input: input,
          cwd: process.cwd(),
          session_id: 'abort-probe',
        }),
        encoding: 'utf8',
        env: HOOK_ENV,
        timeout: 20_000,
      }
    );

    // A libuv abort shows up as a non-zero exit carrying the assert text, never
    // as a thrown JS error, so both are asserted rather than just "no throw".
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).not.toMatch(
      /Assertion failed/
    );
    expect(result.status).toBe(0);
  });

  it('drops it at the hook intake, before anything can stat it', () => {
    // touchedFiles is where externally-supplied paths first enter the hook, and
    // it stats each candidate to size it. Filtering here keeps the character
    // away from every downstream consumer rather than relying on each one to
    // defend itself.
    const touched = touchedFiles({
      tool_name: 'Read',
      tool_input: { file_path: `/tmp/bad${ABORTS}.ts` },
      cwd: process.cwd(),
    });

    // The control, in the same test. touchedFiles drops any path it cannot
    // stat, so returning nothing for everything would satisfy the absence check
    // below while making the hook blind to every file it is supposed to see.
    const clean = touchedFiles({
      tool_name: 'Read',
      tool_input: { file_path: join(process.cwd(), 'package.json') },
      cwd: process.cwd(),
    });
    expect([...clean].map((t) => t.path ?? t).join(' ')).toMatch(/package\.json$/);

    expect([...touched].map((t) => t.path ?? t)).not.toContain(
      `/tmp/bad${ABORTS}.ts`
    );
  });
});
