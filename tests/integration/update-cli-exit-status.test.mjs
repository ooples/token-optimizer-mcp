/**
 * `token-optimizer-update` must report the status it decided on.
 *
 * THE DEFECT THIS PINS. The entry block ended with `process.exit(code)`. On
 * Windows that aborted the process -- a libuv assertion in `async.c` -- while
 * the registry lookup's socket was still closing, so the shell saw 127 for
 * every invocation that had made a request. A script reading that status could
 * not tell "not mine to upgrade" (2) from "upgrade failed" (1) from a crash.
 *
 * It spawns the built bin because the defect lives in the process teardown,
 * which is exactly the part no in-process test of `main()` can reach.
 *
 * NOTHING IS INSTALLED. `--check` reports only, and `--dry-run` prints the
 * command instead of running it.
 */
import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'update', 'cli.js');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('the exit status of token-optimizer-update', () => {
  it('has a built bin to run at all', () => {
    expect(existsSync(CLI)).toBe(true);
  });

  it('exits 0 for --help, which makes no request', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('token-optimizer-update [options]');
  });

  it('exits 2 for a flag it does not have', () => {
    const result = run(['--dryrun']);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('unknown option --dryrun');
  });

  it('reports a real status after the registry lookup, never an abort', () => {
    /*
     * 0 when current or unreadable, 1 when behind -- which of those depends on
     * what is published today and whether this box has a network, so the
     * assertion is on the set. 127 and null are the crash this test exists for.
     */
    const result = run(['--check']);
    expect([0, 1]).toContain(result.status);
    expect(result.stdout).toContain('version:');
    expect(result.stderr).not.toContain('Assertion failed');
  });

  it('refuses this source checkout by name, and says so on a real exit', () => {
    const result = run(['--dry-run']);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('source checkout');
    expect(result.stderr).not.toContain('Assertion failed');
  });
});
