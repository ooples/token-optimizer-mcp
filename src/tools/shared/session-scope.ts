/**
 * The session a cached read or write belongs to (#488).
 *
 * THE CACHE OUTLIVES THE SESSION. It is a SQLite file in the user's home that
 * every server process opens, so an entry keyed on a path alone is visible to
 * every later session -- and `smart_read` answers a re-read of an unchanged
 * file with `// No changes`. A session that never read the file was handed
 * that instead of the file, reported as success.
 *
 * TOKEN_OPTIMIZER_SESSION_ID is the client's own session id, set for the hooks
 * and the server alike (`authoredBase` scopes the same way). Without it, the
 * server process stands in: each client session starts its own stdio server,
 * so a fresh process is a fresh session and never sees an earlier one's reads.
 * Read at call time, not import time, so the value the client set is the one
 * used.
 */
import { randomUUID } from 'crypto';

const PROCESS_SESSION = `process:${randomUUID()}`;

export function sessionScope(): string {
  const raw = (process.env.TOKEN_OPTIMIZER_SESSION_ID || '').trim();
  return raw ? `session:${raw}` : PROCESS_SESSION;
}
