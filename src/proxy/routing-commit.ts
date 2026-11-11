/**
 * Install a route that a session prepared, once that session has ended.
 *
 * WHY A PROCESS OF ITS OWN. The MCP server cannot see its session end: Claude Code closes the
 * server's stdin, keeps running itself, and kills the server about a third of a second later
 * (observed 2026-11-07, Windows, Claude Code 2.1.319). A write made inside that window lands while
 * the session is still alive -- and a server restart (/mcp reconnect, a plugin reload) closes stdin
 * the same way while the session carries on for hours. So the server hands the commit to a detached
 * process that outlives it, and that process waits for the session's process to go.
 *
 * The wait is bounded. A session that is still running when it runs out was a restart, not an exit;
 * nothing is written, and the next session to end with nobody else running installs the route.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isSelfSession,
  liveClaudeSessionEntries,
  maintainDefaultRouting,
  type RoutingOptions,
  type RoutingResult,
} from './default-routing.js';

export interface SessionIdentity {
  readonly pids: readonly number[];
  readonly sessionId?: string;
}

/** Longest a committer waits for its session to exit before deciding it was a restart. */
export const COMMIT_WAIT_MS = 30_000;

export async function commitWhenSessionsEnd({
  env = process.env,
  self,
  sessions = liveClaudeSessionEntries,
  maintain = maintainDefaultRouting,
  waitMs = COMMIT_WAIT_MS,
  pollMs = 250,
}: {
  env?: NodeJS.ProcessEnv;
  self: SessionIdentity;
  sessions?: typeof liveClaudeSessionEntries;
  maintain?: (
    env: NodeJS.ProcessEnv,
    options?: RoutingOptions
  ) => Promise<RoutingResult>;
  waitMs?: number;
  pollMs?: number;
}): Promise<RoutingResult> {
  let live = sessions(env);
  const deadline = Date.now() + waitMs;
  while (
    live !== null &&
    live.some((entry) => isSelfSession(entry, self)) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    live = sessions(env);
  }
  // Still running: our session (a server restart, not an exit) or another one, either of which the
  // write would switch mid-conversation. An unreadable registry is not "nobody".
  if (live === null || live.length) return { status: 'deferred' };
  return maintain(env, { switchTiming: 'now' });
}

/** Start the committer detached, so it survives the server being killed. False if it could not. */
export function spawnRoutingCommit(
  env: NodeJS.ProcessEnv,
  self: SessionIdentity
): boolean {
  try {
    const entry = join(
      dirname(fileURLToPath(import.meta.url)),
      'routing-commit-cli.js'
    );
    const args = [entry, ...self.pids.flatMap((pid) => ['--pid', String(pid)])];
    if (self.sessionId) args.push('--session', self.sessionId);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...env },
      windowsHide: true,
    });
    child.once('error', () => {
      /* nothing to install then; the next session's server prepares it again */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** `--pid N` (repeatable) and `--session ID`, as `spawnRoutingCommit` passes them. */
export function parseCommitArgs(argv: readonly string[]): SessionIdentity {
  const pids: number[] = [];
  let sessionId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--pid') {
      const pid = Number(argv[index + 1]);
      if (Number.isInteger(pid) && pid > 0) pids.push(pid);
      index += 1;
    } else if (argv[index] === '--session') {
      sessionId = argv[index + 1] || undefined;
      index += 1;
    }
  }
  return sessionId ? { pids, sessionId } : { pids };
}
