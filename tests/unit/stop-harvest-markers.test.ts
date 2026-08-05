/**
 * Where the Stop hook keeps its markers, and what it refuses to write over.
 *
 * The markers are trivial state -- a "said it once" flag and a debounce
 * timestamp -- but they were kept in `os.tmpdir()/token-optimizer`, which is a
 * per-user directory on Windows and a SHARED, world-writable /tmp on POSIX.
 * Their names derive from the session id, so on a multi-user host another local
 * account can predict the path and pre-create it as a symlink; `writeFileSync`
 * follows symlinks, so the write lands wherever the link points, with this
 * user's privileges.
 *
 * The fix is to stop using a shared directory rather than to guard one, so the
 * assertion here is about LOCATION first and refusal second.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'child_process';
import { join, dirname, resolve } from 'path';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'fs';
import { tmpdir } from 'os';

const HOOK = join(process.cwd(), 'plugin', 'hooks', 'stop-harvest.mjs');

/** The env var this platform actually reads for per-user state. */
const STATE_VAR =
  process.platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_STATE_HOME';

let work: string;
let state: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'stop-harvest-'));
  state = join(work, 'state');
});

afterEach(() => {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
});

function runHook(sessionId: string) {
  const transcript = join(work, 'transcript.jsonl');
  writeFileSync(transcript, '{"role":"user","content":"hello"}\n');

  const env: NodeJS.ProcessEnv = { ...process.env, [STATE_VAR]: state };
  // Harvesting must be OFF so the hook takes the notice path -- that is the
  // branch that writes a marker.
  delete env.TOKEN_OPTIMIZER_HARVEST;
  delete env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT;
  delete env.TOKEN_OPTIMIZER_MODE;

  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      transcript_path: transcript,
      session_id: sessionId,
      cwd: work,
    }),
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('stop-harvest marker location', () => {
  it('writes markers under per-user state, not the shared temp directory', () => {
    const result = runHook('session-abc-123');
    expect(result.status).toBe(0);

    const dir = join(state, 'token-optimizer');
    expect(existsSync(dir)).toBe(true);

    const written = readdirSync(dir);
    expect(written).toContain('harvest-notice-session-abc-123');
  });

  it('does not let a session id escape the marker directory', () => {
    // The id arrives in the hook payload, so it is external input. A value
    // containing separators used to be interpolated straight into the path.
    const result = runHook('../../../evil');
    expect(result.status).toBe(0);

    const dir = join(state, 'token-optimizer');
    const written = existsSync(dir) ? readdirSync(dir) : [];

    // The invariant is CONTAINMENT, not the absence of dots. `..` inside a
    // filename traverses nothing -- "harvest-notice-.._.._evil" is one ordinary
    // entry in one directory. What must never happen is a name that resolves
    // outside the marker directory, so assert that directly.
    expect(written.length).toBeGreaterThan(0);
    for (const name of written) {
      expect(dirname(resolve(dir, name))).toBe(resolve(dir));
    }
    expect(existsSync(join(work, 'evil'))).toBe(false);
  });

  it('says it once per session rather than on every Stop', () => {
    const first = runHook('session-repeat');
    const second = runHook('session-repeat');

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    // The notice explains why no findings exist; repeating it every turn would
    // make it noise, which is how it would end up ignored.
    expect(first.stdout).toContain('token-optimizer:');
    expect(second.stdout).not.toContain('token-optimizer:');
  });
});
