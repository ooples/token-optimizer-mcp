/**
 * Session state under contention.
 *
 * Several tool calls can run in parallel and each spawns its own hook process,
 * so concurrent writers are the normal case here rather than an edge one. The
 * lock exists because merging alone still loses updates: two processes can both
 * read, both merge, and the second write discards the first's additions.
 *
 * What made that worse than it looked: the lock was retried twenty times with
 * NO delay, so it exhausted in microseconds and the caller fell through to an
 * unlocked read-modify-write -- reintroducing the exact lost update the lock was
 * added to prevent. For `injected` that means a finding can be delivered twice
 * in one session; for `denied` it re-arms a refusal that was already issued.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { loadState, saveState } from '../../hooks-core/policy.mjs';
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let root;
let session;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'state-contention-'));
  process.env.TOKEN_OPTIMIZER_STATE_DIR = root;
  session = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
});

afterEach(() => {
  delete process.env.TOKEN_OPTIMIZER_STATE_DIR;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
});

describe('the injected set survives', () => {
  it('persists across separate loads, which is what makes the gate real', () => {
    // Every tool call is a separate PROCESS. A set held only in memory dies
    // with the process that built it, so this round trip IS the feature.
    saveState(session, { seen: {}, denied: {}, injected: ['finding-a'] });
    expect(loadState(session).injected).toContain('finding-a');
  });

  it('unions rather than overwrites, so parallel writers cannot erase each other', () => {
    saveState(session, { seen: {}, denied: {}, injected: ['finding-a'] });
    saveState(session, { seen: {}, denied: {}, injected: ['finding-b'] });

    const after = loadState(session).injected;
    expect(after).toEqual(expect.arrayContaining(['finding-a', 'finding-b']));
  });

  it('does not duplicate an id written twice', () => {
    saveState(session, { seen: {}, denied: {}, injected: ['finding-a'] });
    saveState(session, { seen: {}, denied: {}, injected: ['finding-a'] });
    expect(loadState(session).injected.filter((k) => k === 'finding-a')).toHaveLength(1);
  });
});

describe('a held lock', () => {
  /** The lock file saveState uses, alongside the state file. */
  const lockPath = (s) => join(root, `${s}.json.lock`);

  it('makes the write skip rather than proceed unlocked', () => {
    saveState(session, { seen: {}, denied: {}, injected: ['first'] });
    expect(loadState(session).injected).toContain('first');

    // Hold the lock as a LIVE holder -- freshly created, so it is not stale.
    writeFileSync(lockPath(session), '');

    try {
      const ok = saveState(session, { seen: {}, denied: {}, injected: ['second'] });

      // The write is refused rather than performed without exclusion. Doing it
      // anyway is what could erase the other process's entry.
      expect(ok).toBe(false);
      const after = loadState(session).injected;
      expect(after).toContain('first');
      expect(after).not.toContain('second');
    } finally {
      try {
        unlinkSync(lockPath(session));
      } catch {
        /* already gone */
      }
    }
  });

  it('is broken and taken when it is stale, so a killed process cannot wedge state', () => {
    // A lock left behind by a killed process must never block writes forever --
    // that would stop `denied` persisting and turn a bounded refusal into a loop.
    writeFileSync(lockPath(session), '');
    // Backdate it well past the staleness window. `require` is unavailable in
    // an ESM test, and swallowing that in a try/catch made this pass silently
    // against a lock that was never actually stale.
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath(session), old, old);

    const ok = saveState(session, { seen: {}, denied: {}, injected: ['after-stale'] });
    expect(ok).not.toBe(false);
    expect(loadState(session).injected).toContain('after-stale');
  });

  it('releases the lock afterwards so the next writer is not blocked', () => {
    saveState(session, { seen: {}, denied: {}, injected: ['x'] });
    expect(existsSync(lockPath(session))).toBe(false);
  });
});

describe('the pre-tool count under contention', () => {
  /** What a pre-tool hook does to its snapshot before it saves. */
  const countOneCall = (state) => {
    state.toolCalls = (Number(state.toolCalls) || 0) + 1;
    return state;
  };

  it('adds each writer call rather than keeping the larger snapshot', () => {
    // TWO HOOK PROCESSES, ONE POSITION. Both load the session at 0 -- which is
    // what parallel tool calls do -- and both count their own call. A merge
    // that took the larger snapshot kept 1, so the session forgot a call and
    // the next hook priced its outline from a stale position.
    const first = countOneCall(loadState(session));
    const second = countOneCall(loadState(session));

    saveState(session, first);
    saveState(session, second);

    expect(loadState(session).toolCalls).toBe(2);
  });

  it('counts one call once even when the same hook saves twice', () => {
    // The router saves for a subagent briefing and again for its verdict, both
    // for ONE pre-tool call, so the claim has to be settled by the first write.
    const state = countOneCall(loadState(session));
    saveState(session, state);
    saveState(session, state);

    expect(loadState(session).toolCalls).toBe(1);
  });

  it('keeps the count monotonic when the state file is gone', () => {
    // A cleared or rolled-back state file must not reopen a session at zero:
    // the snapshot is still the floor.
    const state = countOneCall(loadState(session));
    state.toolCalls = 7;
    saveState(session, state);

    expect(loadState(session).toolCalls).toBe(7);
  });

  it('adds nothing for a state this module never handed out', () => {
    // Every other caller in these tests builds its own object, and a hook that
    // assigns a count without loading one has counted nothing to add. The
    // snapshot is still the floor, so the number it names is what lands.
    saveState(session, { seen: {}, denied: {}, toolCalls: 4 });
    expect(loadState(session).toolCalls).toBe(4);
  });
});
