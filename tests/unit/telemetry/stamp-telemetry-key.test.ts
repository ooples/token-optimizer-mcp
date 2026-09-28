/**
 * The release stamp refuses more often than it writes, on purpose.
 *
 * The key cannot live in git: this repository is public and the package is
 * published, so a committed anon key is handed to everyone and cannot be rotated
 * out of the copies already installed. That makes this script the only thing
 * between "the release uploads" and "the release silently does not", and its
 * refusals are the part worth pinning -- a stamp that guessed would ship an
 * unstamped release while exiting 0.
 *
 * It runs the real script as a child process, because that is how the workflow
 * runs it: an exported function tested in-process would not catch a script that
 * cannot even be executed.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'stamp-telemetry-key.mjs');
const SOURCE = join(process.cwd(), 'src', 'telemetry', 'credentials.ts');
const VALID = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.not-a-signature';

let dir: string;
let copy: string;

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

// spawnSync, NOT execFileSync: this asserts on stderr in the success case too --
// "no secret, so nothing can be uploaded" is a notice, not a failure -- and
// execFileSync only hands back stderr when the child fails.
const run = (key?: string): Run => {
  const env = { ...process.env };
  delete env.TOKEN_OPTIMIZER_BEACON_KEY;
  if (key !== undefined) env.TOKEN_OPTIMIZER_BEACON_KEY = key;
  const out = spawnSync(process.execPath, [SCRIPT, copy], { env, encoding: 'utf8' });
  return {
    status: out.status ?? 1,
    stdout: out.stdout ?? '',
    stderr: out.stderr ?? '',
  };
};

const stamped = (): string => readFileSync(copy, 'utf8');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stamp-key-'));
  copy = join(dir, 'credentials.ts');
  copyFileSync(SOURCE, copy);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the release key stamp', () => {
  it('leaves the empty literal alone when there is no secret', () => {
    const out = run(undefined);
    expect(out.status).toBe(0);
    expect(out.stderr).toContain('cannot upload telemetry');
    expect(stamped()).toContain("export const KEY_DEFAULT = '';");
  });

  it('writes the key when one is supplied, and never logs it', () => {
    const out = run(VALID);
    expect(out.status).toBe(0);
    expect(stamped()).toContain(`export const KEY_DEFAULT = '${VALID}';`);
    // WORKFLOW LOGS ARE PUBLIC on a public repository, so the length is
    // reported and the value is not.
    expect(out.stdout).toContain(`${VALID.length}-character key`);
    expect(out.stdout + out.stderr).not.toContain(VALID);
  });

  it('refuses to overwrite a key that is already stamped', () => {
    expect(run(VALID).status).toBe(0);
    const second = run(VALID);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('already set');
  });

  it('refuses a value that is not shaped like an anon key', () => {
    const out = run('short');
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('does not look like');
    expect(stamped()).toContain("export const KEY_DEFAULT = '';");
  });

  it('refuses a value that would splice code into the module', () => {
    // The literal is single-quoted, so a quote in the value ends it early and
    // everything after it is code. Length alone would let this through.
    const out = run("x'; process.exit(0); // " + 'a'.repeat(40));
    expect(out.status).toBe(1);
    expect(stamped()).toContain("export const KEY_DEFAULT = '';");
  });

  it('refuses a source file whose constant has been renamed', () => {
    const text = readFileSync(copy, 'utf8').replace('KEY_DEFAULT', 'BEACON_KEY_DEFAULT');
    writeFileSync(copy, text, 'utf8');
    const out = run(VALID);
    // DRIFT IS AN ERROR, not something to work around: a script that could not
    // find its target and exited 0 is how a release ships unstamped.
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('could not find');
  });
});
