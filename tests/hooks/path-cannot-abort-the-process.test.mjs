import { describe, it, expect, beforeAll } from '@jest/globals';
import { pathToFileURL } from 'url';
import { join } from 'path';

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
/** Its neighbour, which is handled correctly -- the control for the guard. */
const SAFE_NEIGHBOUR = String.fromCodePoint(0x10fffe);

let contentHash;
let projectRootFor;
let isFsSafePath;
let touchedFiles;

beforeAll(async () => {
  ({ contentHash, projectRootFor } = await import(CORE('wiki.mjs')));
  ({ isFsSafePath } = await import(CORE('paths.mjs')));
  ({ touchedFiles } = await import(CORE('decide.mjs')));
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

    expect([...touched].map((t) => t.path ?? t)).not.toContain(
      `/tmp/bad${ABORTS}.ts`
    );
  });
});
