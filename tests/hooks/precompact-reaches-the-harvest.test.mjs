/**
 * The harvest runs at PreCompact as well as at Stop.
 *
 * #204 specifies the out-of-band semantic pass "at `Stop`/`PreCompact`", and
 * only Stop had it. Compaction is the event this whole subsystem exists for: a
 * conclusion that is not extracted before it is **destroyed** rather than merely
 * forgotten, so PreCompact is the half with the most to lose.
 *
 * ABOVE THE EARLY RETURN, which is the part worth pinning rather than the call
 * itself. `precompact-optimize.mjs` returns early when the session tracked no
 * file operations, and a harvest placed below that would be unreachable for a
 * session that read nothing and concluded plenty -- the same shape as the defect
 * the comment beside that return is itself about.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const NL = String.fromCharCode(10);
const ROOT = process.cwd();
const PRECOMPACT = join(ROOT, 'plugin', 'hooks', 'precompact-optimize.mjs');
const HOOKS_JSON = join(ROOT, 'plugin', 'hooks', 'hooks.json');
const STATE_VAR = process.platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_STATE_HOME';

let work;
let state;
let transcript;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'precompact-harvest-'));
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

function runPreCompact({ sessionId = 'pc-' + Math.random().toString(36).slice(2), env = {} } = {}) {
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

  return spawnSync(process.execPath, [PRECOMPACT], {
    input: JSON.stringify({
      transcript_path: transcript,
      session_id: sessionId,
      cwd: work,
    }),
    env: merged,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('PreCompact reaches the harvest', () => {
  test('is still the registered PreCompact hook', () => {
    // The defect this pattern keeps producing is a registration one, so the
    // registration is asserted rather than assumed.
    const config = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
    const entry = (config.hooks || config).PreCompact;
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry)).toContain('precompact-optimize.mjs');
    expect(existsSync(PRECOMPACT)).toBe(true);
  });

  test('archives the transcript, on a session that tracked no file operations', () => {
    // THE ASSERTION THAT PINS THE PLACEMENT. This session has no tracked reads,
    // so the hook takes its early return -- and the harvest must already have
    // happened above it. Placed below, this is the case that would silently do
    // nothing.
    const result = runPreCompact();
    expect(result.status).toBe(0);

    const graph = join(work, '.token-optimizer', 'wiki');
    expect(existsSync(graph)).toBe(true);
    expect(readdirSync(graph).filter((f) => f.includes('transcript')).length).toBeGreaterThan(0);
  });

  test('says once why no findings exist, even on that early-return path', () => {
    // `runStopHarvest` marks the notice as said, so a hook that discarded it
    // would spend the once-per-session explanation on nobody.
    const result = runPreCompact();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/token-optimizer:/);
  });

  test('emits ONE json object', () => {
    // This hook already has more than one emit path; a third writer on the same
    // stdout is how a PreCompact payload gets corrupted, so the harvest notice
    // is merged rather than written separately.
    const result = runPreCompact();
    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout.trim())).not.toThrow();
  });

  test('does not repeat the notice on a second compaction of one session', () => {
    const first = runPreCompact({ sessionId: 'pc-repeat' });
    const second = runPreCompact({ sessionId: 'pc-repeat' });
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toMatch(/token-optimizer:/);
    expect(second.stdout).not.toMatch(/token-optimizer:/);
  });

  test('stays silent and succeeds when the optimizer is off entirely', () => {
    const result = runPreCompact({ env: { TOKEN_OPTIMIZER_MODE: 'off' } });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/token-optimizer:/);
  });

  test('succeeds when the transcript does not exist', () => {
    const result = spawnSync(process.execPath, [PRECOMPACT], {
      input: JSON.stringify({
        transcript_path: join(work, 'gone.jsonl'),
        session_id: 'pc-missing',
        cwd: work,
      }),
      env: { ...process.env, [STATE_VAR]: state },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
  });

  test('compaction is never delayed by a model call', () => {
    // The worker is spawned detached; the hook must return immediately. A
    // generous ceiling, because this is about "does not block on a round trip"
    // rather than about milliseconds on a shared runner.
    const started = Date.now();
    expect(runPreCompact().status).toBe(0);
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
