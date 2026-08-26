/**
 * The Stop path actually reaches the harvest.
 *
 * #300 unregistered `plugin/hooks/stop-harvest.mjs` and nothing replaced it, so
 * four capabilities went silently: the transcript archive, the harvest worker
 * spawn, refusal detection, and the notice that says why no findings exist. On
 * a full session with a valid credential, `harvestMode()` reported `remote` and
 * nothing happened.
 *
 * WHY IT SURVIVED A YEAR, and what this file is really for. Nothing observed
 * that the harvest had not run. There is no `kind:'harvest'` event to be absent
 * from a report, no error, and a harvest that ran and found nothing looks
 * exactly like one that never started. The reachability guard could not see it
 * either: the unregistered file's own imports gave `archive`, `detectRefusals`
 * and `recordRefusal` their call sites, and a name-based scan proves a
 * REFERENCE exists, never that it RUNS. The old marker suite even kept passing,
 * because it spawned the removed hook directly.
 *
 * So these assertions are deliberately about REACHABILITY THROUGH THE REGISTERED
 * ENTRY rather than about the harvest's internals, which have their own tests.
 * Every one of them drives the file the host is actually configured to run.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';

const NL = String.fromCharCode(10);
const ROOT = process.cwd();
const STOP = join(ROOT, 'plugin', 'hooks', 'stop.mjs');
const HOOKS_JSON = join(ROOT, 'plugin', 'hooks', 'hooks.json');
const STATE_VAR = process.platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_STATE_HOME';

let work;
let state;
let transcript;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'stop-reach-'));
  mkdirSync(join(work, '.git'), { recursive: true });
  state = join(work, 'state');
  transcript = join(work, 'transcript.jsonl');
  writeFileSync(transcript, '{"role":"user","content":"hello"}' + NL);
});

afterEach(() => {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
});

function runStop(env = {}, sessionId = null) {
  const merged = { ...process.env, [STATE_VAR]: state };
  for (const key of [
    'TOKEN_OPTIMIZER_HARVEST',
    'TOKEN_OPTIMIZER_HARVEST_ENDPOINT',
    'TOKEN_OPTIMIZER_API_KEY',
    'TOKEN_OPTIMIZER_MODE',
  ]) {
    delete merged[key];
  }
  Object.assign(merged, env);

  return spawnSync(process.execPath, [STOP], {
    input: JSON.stringify({
      transcript_path: transcript,
      session_id: sessionId || 'reach-' + Math.random().toString(36).slice(2),
      cwd: work,
    }),
    env: merged,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('the registered Stop entry', () => {
  test('is the file hooks.json actually points at', () => {
    // The defect was a registration one, so the registration is asserted
    // directly. A hooks.json that names a file which does not exist, or that
    // stops naming Stop at all, is exactly how this happened.
    const config = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
    const stop = (config.hooks || config).Stop;
    expect(stop).toBeTruthy();
    const command = JSON.stringify(stop);
    expect(command).toContain('stop.mjs');
    expect(existsSync(STOP)).toBe(true);
  });

  test('archives the transcript, even with harvesting off', () => {
    // ARCHIVE IS NOT GATED BY THE OPT-IN, deliberately: it is a local file copy
    // that costs no model call and sends nothing anywhere. Gating it would keep
    // the record of what the user said only for users who paid for a feature.
    const result = runStop();
    expect(result.status).toBe(0);

    const graph = join(work, '.token-optimizer', 'wiki');
    expect(existsSync(graph)).toBe(true);
    const archived = readdirSync(graph).filter((f) => f.includes('transcript'));
    expect(archived.length).toBeGreaterThan(0);
  });

  test('says once why no findings exist when the harvest cannot run', () => {
    // Silence is how this stayed invisible: a user sees a graph filling with
    // structural nodes and no findings, and has no way to learn why.
    const result = runStop();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/token-optimizer:/);
  });

  test('emits ONE json object, with the notice folded into it', () => {
    // The old hook wrote its own JSON to stdout beside whatever the adapter
    // emitted. Two writers on one hook's stdout is how a Stop payload gets
    // corrupted, so the notice is returned and merged rather than written.
    const result = runStop();
    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout.trim())).not.toThrow();
    expect(JSON.parse(result.stdout.trim()).systemMessage).toMatch(/token-optimizer/);
  });

  test('does not repeat the notice on the next Stop of the same session', () => {
    // Saying it once is the difference between a disabled feature and a nag.
    // Asserted on the shared prefix rather than one reason's wording: which
    // OFF_REASON applies depends on the environment, and pinning the exact
    // sentence would make this a test about the runner's env vars.
    const first = runStop({}, 'repeat-session');
    const second = runStop({}, 'repeat-session');
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toMatch(/token-optimizer:/);
    expect(second.stdout).not.toMatch(/token-optimizer:/);
  });

  test('stays silent and succeeds when the optimizer is off entirely', () => {
    const result = runStop({ TOKEN_OPTIMIZER_MODE: 'off' });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/token-optimizer:/);
  });

  test('succeeds when the transcript does not exist', () => {
    const result = spawnSync(process.execPath, [STOP], {
      input: JSON.stringify({
        transcript_path: join(work, 'nope.jsonl'),
        session_id: 'missing',
        cwd: work,
      }),
      env: { ...process.env, [STATE_VAR]: state },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
  });
});

describe('the harvest worker is reachable from every client, not one', () => {
  test('ships in the shared core rather than beside one client entry', () => {
    // THE REASON ONLY CLAUDE CODE COULD EVER HAVE RUN IT. The worker lived in
    // plugin/hooks/, which is vendored to no other client, so even a correctly
    // registered Stop on the other ten would have found no worker to spawn.
    expect(existsSync(join(ROOT, 'hooks-core', 'harvest-worker.mjs'))).toBe(true);
    expect(existsSync(join(ROOT, 'plugin', 'hooks', 'harvest-worker.mjs'))).toBe(false);
  });

  test('is vendored beside the adapter in every client that has one', () => {
    // The adapter resolves the worker as a sibling, so this is the property the
    // spawn depends on -- asserted per client rather than assumed from the
    // sync script having run.
    const libs = [
      join(ROOT, 'plugin', 'hooks', 'lib'),
      join(ROOT, 'integrations', 'codex', 'hooks', 'lib'),
      join(ROOT, 'integrations', 'qwen', 'hooks', 'lib'),
      join(ROOT, 'integrations', 'cursor', 'hooks', 'lib'),
      join(ROOT, 'integrations', 'windsurf', 'hooks', 'lib'),
      join(ROOT, 'integrations', 'cline', 'hooks', 'token-optimizer', 'lib'),
    ];
    for (const lib of libs) {
      expect([lib, existsSync(join(lib, 'adapter.mjs'))]).toEqual([lib, true]);
      expect([lib, existsSync(join(lib, 'harvest-worker.mjs'))]).toEqual([lib, true]);
    }
  });
});
