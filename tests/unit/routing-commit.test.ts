/**
 * The deferred-route committer: installs a route a session prepared, only once that session's
 * process has gone and no other session would be switched mid-conversation by the write.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import {
  commitWhenSessionsEnd,
  parseCommitArgs,
} from '../../src/proxy/routing-commit.js';
import type { LiveClaudeSession } from '../../src/proxy/default-routing.js';

afterEach(() => jest.useRealTimers());

const written = () =>
  jest.fn(async (_env: NodeJS.ProcessEnv, _options?: { switchTiming?: string }) => ({
    status: 'written' as const,
  }));
const self = { pids: [4242], sessionId: 'mine' };

describe('committing a deferred route', () => {
  it('waits for its own session to exit, then writes with the installer timing', async () => {
    jest.useFakeTimers();
    let polls = 0;
    // Claude Code outlives the server it stops: its entry is still live for a while.
    const sessions = jest.fn((): LiveClaudeSession[] =>
      polls++ < 3 ? [{ pid: 4242, sessionId: 'mine' }] : []
    );
    const maintain = written();
    const done = commitWhenSessionsEnd({ env: {}, self, sessions, maintain, pollMs: 10, waitMs: 1000 });
    await jest.advanceTimersByTimeAsync(100);
    expect((await done).status).toBe('written');
    expect(maintain).toHaveBeenCalledWith({}, { switchTiming: 'now' });
  });

  it('writes nothing when its session is still running at the deadline: that was a restart', async () => {
    jest.useFakeTimers();
    // Matched by session id alone, as under a launcher shim whose pid is not the parent.
    const sessions = () => [{ pid: 99, sessionId: 'mine' }];
    const maintain = written();
    const done = commitWhenSessionsEnd({ env: {}, self, sessions, maintain, pollMs: 10, waitMs: 100 });
    await jest.advanceTimersByTimeAsync(200);
    expect((await done).status).toBe('deferred');
    expect(maintain).not.toHaveBeenCalled();
  });

  it('writes nothing while another session would be switched, or when it cannot tell', async () => {
    for (const live of [[{ pid: 777, sessionId: 'theirs' }], null]) {
      const maintain = written();
      const result = await commitWhenSessionsEnd({ env: {}, self, sessions: () => live, maintain, waitMs: 0 });
      expect(result.status).toBe('deferred');
      expect(maintain).not.toHaveBeenCalled();
    }
  });

  it('reads back the identity it was spawned with', () => {
    expect(parseCommitArgs(['--pid', '12', '--session', 'abc'])).toEqual({ pids: [12], sessionId: 'abc' });
    expect(parseCommitArgs(['--pid', 'x', '--pid', '7'])).toEqual({ pids: [7] });
    expect(parseCommitArgs([])).toEqual({ pids: [] });
  });
});
