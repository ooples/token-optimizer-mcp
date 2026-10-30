/**
 * Telling a session WHY the optimizer MCP server is missing.
 *
 * plugin/launch.mjs records a native crash of the server in
 * `<runtime>/.server-crash.json`, with the Node version it crashed under. The
 * host shows such a server only as "Connection closed", which names no cause
 * and no remedy, so it went unnoticed on one machine for five weeks: every
 * session lost the server, and none of them said why (2026-10-30).
 *
 * The notice is shown only while the hooks run under the SAME Node version as
 * the crash: once Node is upgraded the record is stale, and it says nothing.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The record's path; plugin/launch.mjs writes the same one. */
export function serverCrashFile(env = process.env) {
  const runtime =
    env.TOKEN_OPTIMIZER_RUNTIME || join(homedir(), '.token-optimizer', 'runtime');
  return join(runtime, '.server-crash.json');
}

/** The notice for this session, or null when there is no current crash. */
export function serverCrashNotice(env = process.env, node = process.versions.node) {
  let record;
  try {
    record = JSON.parse(readFileSync(serverCrashFile(env), 'utf8'));
  } catch {
    return null;
  }
  if (!record || record.node !== node) return null;
  const exit = typeof record.exit === 'string' ? record.exit.slice(0, 16) : 'a native crash';
  return (
    `The token-optimizer MCP server crashed at startup (${exit}) under Node ${node}, ` +
    `so its tools are unavailable in this session. Its SQLite binding needs Node ` +
    `22.14.0 or newer. Tell the user once: upgrading Node restores the server.`
  );
}
