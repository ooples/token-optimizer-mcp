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
 *
 * AND THE AGENT, WHERE IT IS KNOWN. A Claude subagent shares its parent's
 * server and session id, so a session scope alone handed a subagent
 * `// No changes` for a file only its parent read. Claude Code tags each call
 * with a toolUseId, and the PreToolUse hook records which agent made it
 * (hooks-core/agent-scope.mjs writes `<state>/agent-scope/<toolUseId>.json`);
 * the agent is added to the scope when that record is found. When it is not --
 * another client, no hook, a failed write -- the scope is the session's,
 * exactly as before.
 *
 * READ HERE RATHER THAN BY LOADING THE HOOK MODULE. `require` of an ES module
 * needs Node 22.12, and this package supports 22.0: a loader that failed would
 * silently drop the agent scope. The format is two fields, and a test reads
 * what the hook module writes so the two cannot drift.
 */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { callContext } from './call-context.js';

const PROCESS_SESSION = `process:${randomUUID()}`;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const AGENT_KEY = /^[a-f0-9]{16}$/;

/** The agent the PreToolUse hook recorded for `toolUseId`, or null. */
export function agentForCall(toolUseId: string): string | null {
  if (!SAFE_ID.test(toolUseId)) return null;
  const directory = join(
    process.env.TOKEN_OPTIMIZER_STATE_DIR ||
      join(tmpdir(), 'token-optimizer-hooks'),
    'agent-scope'
  );
  try {
    const record = JSON.parse(
      // eslint-disable-next-line n/no-sync -- the cache key is computed synchronously, and this is a few dozen bytes
      readFileSync(join(directory, `${toolUseId}.json`), 'utf8')
    ) as { agent?: unknown };
    return typeof record.agent === 'string' && AGENT_KEY.test(record.agent)
      ? record.agent
      : null;
  } catch {
    return null;
  }
}

export function sessionScope(): string {
  const raw = (process.env.TOKEN_OPTIMIZER_SESSION_ID || '').trim();
  const session = raw ? `session:${raw}` : PROCESS_SESSION;
  const toolUseId = callContext.getStore()?.toolUseId;
  const agent = toolUseId ? agentForCall(toolUseId) : null;
  return agent ? `${session}|agent:${agent}` : session;
}
