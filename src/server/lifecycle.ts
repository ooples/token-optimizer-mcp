/**
 * Process lifecycle wiring for the stdio MCP server.
 *
 * Extracted into its own side-effect-free module so the shutdown logic can be
 * unit-tested in isolation, without importing (and booting) the whole server.
 */

export interface ShutdownDeps {
  /** Runs the actual resource cleanup. Must be safe to call once. */
  cleanup: () => Promise<void>;
  /** Signal/exit target. Defaults to the real `process`; injectable for tests. */
  proc?: NodeJS.EventEmitter & { exit: (code?: number) => void };
  /** stdin stream. Defaults to `process.stdin`; injectable for tests. */
  stdin?: NodeJS.EventEmitter;
}

/**
 * Wire every process-termination path to a single guarded shutdown so that
 * cleanup() + exit run EXACTLY ONCE.
 *
 * Why one guard for all paths: they race each other. A signal can arrive while
 * stdin is closing, and stdin itself can emit both 'end' and 'close' (plus
 * 'error') for a single disconnect. Without a shared guard, cleanup() runs
 * concurrently and process.exit() is called more than once.
 *
 * Why the stdin handlers (the core fix, PR #177): a stdio MCP server MUST exit
 * when its parent (the MCP client, e.g. Claude Code) dies. On Windows a killed
 * parent sends NO signal to the child, so SIGINT/SIGTERM never fire on
 * orphaning. The only reliable "parent is gone" signal is stdin closing/ending/
 * erroring (the client's pipe write-end goes away). Without it the process
 * leaks forever: the prune timer is unref'd (does not pin the loop), but
 * StdioServerTransport's active stdin read handle keeps the process alive.
 */
export function installShutdownHandlers(deps: ShutdownDeps): void {
  const proc = deps.proc ?? process;
  const stdin = deps.stdin ?? process.stdin;

  let shuttingDown = false;
  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // stderr, not stdout — stdout is the MCP JSON-RPC channel.
    console.error(`[token-optimizer] shutting down (${reason})`);
    // Swallow any cleanup failure (log it) so a rejecting cleanup can never
    // surface as an unhandled rejection, then exit unconditionally. Wrapping in
    // Promise.resolve().then also absorbs a synchronous throw from cleanup().
    Promise.resolve()
      .then(() => deps.cleanup())
      .catch((err) =>
        console.error('[token-optimizer] cleanup error during shutdown:', err)
      )
      .finally(() => proc.exit(0));
  };

  proc.on('SIGINT', () => shutdown('SIGINT'));
  proc.on('SIGTERM', () => shutdown('SIGTERM'));
  proc.on('SIGHUP', () => shutdown('SIGHUP')); // Unix: controlling terminal/parent closed

  stdin.on('end', () => shutdown('stdin end'));
  stdin.on('close', () => shutdown('stdin close'));
  stdin.on('error', () => shutdown('stdin error'));
}
