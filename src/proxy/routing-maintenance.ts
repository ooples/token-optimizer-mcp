import {
  claudeSettingsFile,
  maintainDefaultRouting,
  readRoutingManifest,
  type RoutingOptions,
  type RoutingResult,
} from './default-routing.js';
import { spawnRoutingCommit, type SessionIdentity } from './routing-commit.js';
import { proxyEnabled } from './server.js';
import { applyCompactWindow } from './compact-window.js';
import { readFileSync } from 'node:fs';
import {
  ensureSupervisor,
  readSupervisorState,
  controlPort,
} from './supervisor.js';

export interface RoutingMaintenance {
  /** Stop the background checks. Safe to call more than once. */
  stop(): void;
  /**
   * Hand a route that startup deferred to a detached committer, which installs it once this
   * session's process has exited and no other session is running (routing-commit.ts). True when
   * one was started; false when nothing was deferred or it could not be started.
   */
  commitDeferred(): boolean;
}

/**
 * Keep an installed route alive after a supervisor crash, without delaying MCP.
 *
 * A ROUTE THIS SESSION WOULD INSTALL WAITS FOR THE SESSION TO END. The server starts inside a
 * session that has already begun, and Claude Code applies a settings change to the running session
 * between two requests -- which re-sends everything after the tool definitions uncached, because a
 * loopback endpoint does not get the same request as Anthropic's (default-routing.ts,
 * `RouteSwitchTiming`). So startup prepares the route and the write happens at shutdown, when the
 * next session will read it before its first request.
 *
 * SHUTDOWN IS NOT THE SESSION ENDING. Claude Code outlives the server it stops, and a /mcp
 * reconnect stops the server while the session carries on, so the write is handed to a process
 * that waits for the session itself to exit (routing-commit.ts).
 */
export function startRoutingMaintenance({
  env = process.env,
  intervalMs = 5000,
  maintain = maintainDefaultRouting,
  recover = ensureSupervisor,
  spawnCommit = spawnRoutingCommit,
  parentPid = process.ppid,
}: {
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  maintain?: (
    env: NodeJS.ProcessEnv,
    options?: RoutingOptions
  ) => Promise<RoutingResult>;
  recover?: (env: NodeJS.ProcessEnv) => Promise<unknown>;
  spawnCommit?: (env: NodeJS.ProcessEnv, self: SessionIdentity) => boolean;
  parentPid?: number;
} = {}): RoutingMaintenance {
  let stopped = false;
  let deferred = false;
  let timer: NodeJS.Timeout | undefined;
  const stillOwned = (): boolean => {
    const path = claudeSettingsFile(env);
    const entry = readRoutingManifest(env).entries[path];
    return (
      !!entry &&
      // Inspect ownership before recovery without yielding to another settings writer.
      // eslint-disable-next-line n/no-sync
      JSON.parse(readFileSync(path, 'utf8')).env?.[entry.variable] ===
        entry.value
    );
  };
  const run = async (initial = false): Promise<void> => {
    try {
      // Persistent routes are shared by clients (including Zed), not owned by Claude.
      // The supervisor restores its complete route table on restart, at the recorded ports.
      const saved = readSupervisorState(env);
      if (
        !stopped &&
        proxyEnabled(env) &&
        Array.isArray(saved?.routes) &&
        saved.routes.length &&
        saved.controlUrl === `http://127.0.0.1:${controlPort(env)}`
      )
        await recover(env);
      // Initial setup may install a route. Later checks only maintain a route we still own:
      // removing routing or opting out must not be undone by a background timer.
      if (!stopped && initial) {
        const result = await maintain(env, { switchTiming: 'when-no-session' });
        deferred = result?.status === 'deferred';
      } else if (!stopped && stillOwned()) await maintain(env);
      // Once per server start: the compaction window the user chose (compact-window.ts).
      if (!stopped && initial) applyCompactWindow(env);
    } catch {
      // A transient filesystem/startup error must not take down the MCP server.
    } finally {
      if (!stopped) {
        // Schedule after completion: slow recovery attempts must never overlap.
        timer = setTimeout(() => void run(), intervalMs);
        timer.unref();
      }
    }
  };
  void run(true);
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
    commitDeferred: () => {
      if (!deferred) return false;
      deferred = false;
      // Matched two ways, see liveClaudeSessions: the parent pid, and the id Claude Code passed.
      const self: SessionIdentity = env.CLAUDE_CODE_SESSION_ID
        ? { pids: [parentPid], sessionId: env.CLAUDE_CODE_SESSION_ID }
        : { pids: [parentPid] };
      return spawnCommit(env, self);
    },
  };
}
