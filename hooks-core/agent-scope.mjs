/**
 * Which agent made an MCP call, for scoping the server's read cache (#488).
 *
 * A Claude subagent shares its parent's MCP server and session id, so a cache
 * scoped to the session handed a subagent `// No changes` for a file only its
 * parent had read. Claude Code tags every MCP `tools/call` with
 * `_meta["claudecode/toolUseId"]` but sends an agent id to no third-party
 * server. The PreToolUse hook, though, sees both that call's `tool_use_id` and
 * the calling agent's own `transcript_path` -- so it records the pair here, and
 * the server looks its call up by id.
 *
 * Shared by the hook (writer) and the server (reader) so the two cannot
 * disagree on the location or the key. Every failure reads as "unknown", which
 * the server treats as today's session scope: this can narrow a scope, never
 * widen one.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const AGENT_KEY = /^[a-f0-9]{16}$/;
// A call is looked up within moments of being recorded; an hour is generous.
const MAX_AGE_MS = 60 * 60 * 1000;
const REAP_ABOVE = 256;

/** Where the call-to-agent records live: beside the hooks' own state. */
export function agentScopeDirectory(env = process.env) {
  return join(
    env.TOKEN_OPTIMIZER_STATE_DIR || join(tmpdir(), 'token-optimizer-hooks'),
    'agent-scope'
  );
}

/** A short, stable key for an agent, from its transcript path. */
export function agentKey(transcriptPath) {
  return createHash('sha256').update(String(transcriptPath)).digest('hex').slice(0, 16);
}

/** Record that the call `toolUseId` was made by the agent writing `transcriptPath`. */
export function recordAgentForCall(toolUseId, transcriptPath, env = process.env) {
  if (!SAFE_ID.test(String(toolUseId || '')) || !transcriptPath) return false;
  const directory = agentScopeDirectory(env);
  try {
    mkdirSync(directory, { recursive: true });
    const target = join(directory, `${toolUseId}.json`);
    const temporary = `${target}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify({ agent: agentKey(transcriptPath), at: Date.now() }));
    renameSync(temporary, target);
    reapOld(directory);
    return true;
  } catch {
    return false;
  }
}

/** The agent key recorded for `toolUseId`, or null when unknown. */
export function agentForCall(toolUseId, env = process.env) {
  if (!SAFE_ID.test(String(toolUseId || ''))) return null;
  try {
    const record = JSON.parse(
      readFileSync(join(agentScopeDirectory(env), `${toolUseId}.json`), 'utf8')
    );
    return AGENT_KEY.test(String(record?.agent)) ? record.agent : null;
  } catch {
    return null;
  }
}

/** Drop records older than an hour, but only once there are enough to matter. */
function reapOld(directory) {
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  if (names.length <= REAP_ABOVE) return;
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const name of names) {
    const file = join(directory, name);
    try {
      if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
    } catch {
      // Gone already, or in use; the next pass gets it.
    }
  }
}
