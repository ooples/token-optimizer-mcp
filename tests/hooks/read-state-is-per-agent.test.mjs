import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * One agent's reads must not silence another agent's.
 *
 * `statePath(sessionId)` keyed the `seen` set by SESSION ONLY, and every subagent
 * inherits its parent's session id. So the set is shared by every agent running
 * under one session, and the refusal that says "you already read this" fires for
 * an agent that has never seen the file.
 *
 * OBSERVED, verbatim, from a subagent that had never opened the file:
 *
 *     .../\.github/workflows/release.yml is UNCHANGED since you last read it this
 *     session. Nothing to re-read -- use what you already have.
 *
 * It was denied the contents because a DIFFERENT agent had read that file, and
 * worked around the refusal with Bash -- which defeats the optimizer entirely and
 * costs more than the read it replaced.
 *
 * This is the same defect class as "a write is not a read" one level up: a read
 * that never happened. It matters more than it looks, because parallel subagents
 * are exactly the workload where token optimization is worth the most, and this
 * turns the tool from a saving into an obstacle precisely there.
 */

const CORE = pathToFileURL(
  join(process.cwd(), 'hooks-core', 'policy.mjs')
).href;

let dir;
let original;
let policy;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'per-agent-state-'));
  original = process.env.TOKEN_OPTIMIZER_STATE_DIR;
  process.env.TOKEN_OPTIMIZER_STATE_DIR = dir;
  policy = await import(`${CORE}?t=${dir}`);
});

afterEach(() => {
  if (original === undefined) delete process.env.TOKEN_OPTIMIZER_STATE_DIR;
  else process.env.TOKEN_OPTIMIZER_STATE_DIR = original;
  rmSync(dir, { recursive: true, force: true });
});

const SESSION = 'shared-session-id';
const AGENT_A = '/tmp/transcripts/agent-a.jsonl';
const AGENT_B = '/tmp/transcripts/agent-b.jsonl';

describe('read state under one session with several agents', () => {
  it('does not report another agent\u2019s read as this agent\u2019s', () => {
    const { loadState, saveState } = policy;

    const a = loadState(SESSION, AGENT_A);
    a.seen['C:/repo/.github/workflows/release.yml'] = { hash: 'abc' };
    saveState(SESSION, a, AGENT_A);

    const b = loadState(SESSION, AGENT_B);

    expect(b.seen['C:/repo/.github/workflows/release.yml']).toBeUndefined();
  });

  it('still remembers an agent\u2019s own read', () => {
    // The optimization has to keep working within one agent, or the fix is just
    // a way of switching the feature off.
    const { loadState, saveState } = policy;

    const first = loadState(SESSION, AGENT_A);
    first.seen['C:/repo/src/app.ts'] = { hash: 'abc' };
    saveState(SESSION, first, AGENT_A);

    const second = loadState(SESSION, AGENT_A);

    expect(second.seen['C:/repo/src/app.ts']).toEqual({ hash: 'abc' });
  });

  it('keeps separate sessions separate, as before', () => {
    const { loadState, saveState } = policy;

    const a = loadState('session-one', AGENT_A);
    a.seen['C:/repo/x.ts'] = { hash: 'abc' };
    saveState('session-one', a, AGENT_A);

    expect(
      loadState('session-two', AGENT_A).seen['C:/repo/x.ts']
    ).toBeUndefined();
  });

  it('falls back to session scope when no agent is identified', () => {
    // The main session's own tool calls may carry no discriminator. Those must
    // still share one state rather than getting a fresh one per call, which
    // would disable the once-per-session gates entirely.
    const { loadState, saveState } = policy;

    const a = loadState(SESSION);
    a.seen['C:/repo/y.ts'] = { hash: 'abc' };
    saveState(SESSION, a);

    expect(loadState(SESSION).seen['C:/repo/y.ts']).toEqual({ hash: 'abc' });
  });
});
