/**
 * Whether the proxy is on, in a module of its own.
 *
 * KEPT OUT OF server.ts ON PURPOSE. The MCP server's routing maintenance needs
 * only this answer, and importing it from server.ts pulled the whole
 * compression stack into the MCP server process -- strategy, router, and
 * @babel/parser through compress/code.ts -- a moment after every handshake.
 * Measured: importing routing-maintenance.js loaded @babel/parser, which is
 * what tests/integration/server-startup-loads-no-heavy-deps caught on Linux,
 * where the import finishes before the test's server exits.
 */

/** Enabled by default; explicit opt-outs and the global kill switch win. */
export function proxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TOKEN_OPTIMIZER_MODE?.trim().toLowerCase() === 'off') return false;
  return !/^(0|false|no|off)$/i.test(env.TOKEN_OPTIMIZER_PROXY?.trim() || '');
}
