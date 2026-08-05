/**
 * The universal client adapter.
 *
 * Every CLI agent that supports hooks gives us the same three levers -- a
 * session-start notice, a pre-tool challenge, and a pre-compaction pass -- and
 * differs only in the envelope. Rather than five diverging advisor scripts (the
 * state this replaces, where Codex, Gemini and Claude Code each drifted their
 * own thresholds and guidance strings), each client now ships a four-line entry
 * file that calls in here with its name.
 *
 * WHAT ACTUALLY DIFFERS BETWEEN CLIENTS, and is therefore configured below:
 *
 *   - `hookEventName` echo. Claude Code requires the event name back in
 *     hookSpecificOutput; Gemini does not read it. Emitting it always is
 *     harmless, so the shape is shared.
 *
 *   - WHETHER A REFUSAL IS EVEN POSSIBLE. This is the real fault line. A client
 *     with a *pre*-tool hook can deny before the tokens are spent. A client
 *     whose only hook fires *after* the tool ran (Gemini's AfterTool) cannot --
 *     the file is already in context, and refusing it retroactively saves
 *     nothing on this call. Those clients get a forward-looking notice instead,
 *     and the honest claim in the docs is "advises", not "enforces".
 */

import {
  loadState, saveState, alreadyDenied, mode, MODE_OFF, MODE_ADVISE, largeFileBytes, withEscape,
} from './policy.mjs';
import { decide, remember, normalizePayload, readCostBytes } from './decide.mjs';
import { recordRead } from './metrics.mjs';
import { wikiDir } from './wiki.mjs';
import { briefing } from './remedy.mjs';
import { stableText, transcriptFor } from './cache.mjs';
import { cachedRoutingBriefing } from './routing.mjs';

/**
 * Per-client capability.
 *
 * `canDeny` is not a preference -- it is a statement of protocol fact. Setting
 * it true where the client has no pre-execution veto would make the product
 * claim enforcement it cannot deliver.
 */
export const CLIENTS = {
  'claude-code': { canDeny: true, denyField: 'permissionDecision' },
  codex: { canDeny: true, denyField: 'permissionDecision' },
  gemini: { canDeny: false, denyField: null },
  opencode: { canDeny: true, denyField: 'permissionDecision' },
  qwen: { canDeny: false, denyField: null },
};

function emit(object) {
  process.stdout.write(JSON.stringify(object));
}

/**
 * Bounded stdin read. See policy.readPayload for why the ceiling matters: the
 * entry points fail open on a THROW, but a host that opens the pipe and never
 * closes it produces no throw -- just a hook that waits forever with the user's
 * tool call stuck behind it.
 */
async function readStdin({ timeoutMs = 5000 } = {}) {
  const raw = await new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => resolve(null), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => { clearTimeout(timer); resolve(chunks.join('')); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(null); });
  });

  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The session-start notice, shared verbatim so no client drifts its own copy. */
export function policyText(canDeny) {
  const kb = Math.round(largeFileBytes() / 1024);
  const enforcement = (canDeny && mode() !== MODE_ADVISE)
    ? 'Built-in calls matching these cases are DENIED and must be reissued against ' +
      'the tool named in the refusal. A second attempt at the same target is always ' +
      'allowed, so you can never be stuck.'
    : 'These are strong recommendations; the built-in tools remain available.';

  return `# Token optimization is active

The token-optimizer MCP server is connected. Prefer its tools over the built-ins
in these cases -- they cut context usage 60-90% by caching, diffing and bounding
output:

- Reading a file larger than ~${kb} KB, or ANY file already read this session
  -> smart_read (returns only what changed since the last read)
- Searching file contents -> smart_grep ; finding files -> smart_glob
- Editing a file larger than ~${kb} KB -> smart_edit (returns a diff, not the file)
- Printing a large file via cat/head/tail/type/Get-Content -> smart_read
- Recursive shell searches (grep -r, rg) -> smart_grep

${enforcement}

When the context window gets tight, call optimize_session. To report savings,
call get_optimization_report. Small one-off reads are fine with the built-ins.

## Record what you work out

Call wiki_write when you establish something durable about this project, while
you still hold the context. Every claim needs at least one anchor -- a real file
path, or path#symbol -- because an unanchored claim can never be checked against
the code again and would be served as current forever; unanchored writes are
refused.

Worth recording: a decision and why the alternative was rejected, a failure and
what actually caused it, a command that turned out to be the one that works.
Not worth recording: what the code plainly says. Prefer the thing someone had to
work out, because that exists nowhere in the source tree.${projectBriefing()}`;
}

/**
 * This project's own waste facts, appended to the standing policy.
 *
 * The cheapest of the four remedy surfaces by an order of magnitude: a few
 * dozen tokens that change what the model reaches for, with no call to
 * intercept and no turn to spend. Waste that never starts costs nothing to
 * stop.
 *
 * Deliberately concrete. A general exhortation to be efficient is worth
 * nothing; "this file has never repaid a read here" is a fact about this
 * project that changes a decision.
 */
function projectBriefing() {
  try {
    const cwd = process.cwd();

    // Routing facts join the same briefing, and are number-free for the same
    // reason the rest of it is: a count that ticks up as evidence accumulates
    // would change the prefix every session and invalidate the cache behind it.
    // The digits live in the model_routing tool, where changing costs nothing.
    let routing = null;
    try {
      routing = cachedRoutingBriefing(wikiDir(cwd), transcriptFor(cwd));
    } catch { /* no transcript, no routing facts; the rest still applies */ }

    const text = briefing(wikiDir(cwd), { extra: routing ? [routing] : [] });
    if (!text) return '';

    // CACHE-SAFE BY CONSTRUCTION. This text sits near the front of the prompt
    // prefix, so a single character that differs between sessions invalidates
    // everything after it -- and an optimizer that costs more cache than it
    // saves tokens is worse than no optimizer. A line that would vary is
    // dropped rather than emitted: missing guidance costs a little, a volatile
    // line costs the whole prefix.
    const { text: safe } = stableText(text);
    return safe.trim() ? `\n\n## What we have learned about this project\n\n${safe}` : '';
  } catch {
    // A briefing is a bonus. It must never be the reason a session starts badly.
    return '';
  }
}

/**
 * Runs one hook invocation.
 *
 * @param {string} clientName  Key into CLIENTS.
 * @param {'session-start'|'pre-tool'|'post-tool'} event
 */
export async function run(clientName, event) {
  const client = CLIENTS[clientName] || CLIENTS['claude-code'];
  const eventName = event === 'session-start' ? 'SessionStart'
    : event === 'post-tool' ? 'PostToolUse' : 'PreToolUse';

  if (mode() === MODE_OFF) process.exit(0);

  if (event === 'session-start') {
    emit({ hookSpecificOutput: { hookEventName: eventName, additionalContext: policyText(client.canDeny) } });
    process.exit(0);
  }

  const raw = await readStdin();
  if (!raw) process.exit(0);

  const payload = normalizePayload(raw);
  if (!payload.tool_name) process.exit(0);

  const state = loadState(payload.session_id);
  const verdict = decide(payload, state);

  if (!verdict) {
    remember(payload, state);
    saveState(payload.session_id, state);

    // Same measurement as the Claude Code router: every client's allowed read
    // feeds the same holdout comparison, or the metric is client-specific and
    // therefore not comparable.
    const bytes = readCostBytes(payload);
    if (bytes) {
      recordRead(wikiDir(payload.cwd), {
        anchor: payload.tool_input.file_path,
        sessionId: payload.session_id,
        bytes,
      });
    }
    process.exit(0);
  }

  const repeat = alreadyDenied(state, verdict.key);
  remember(payload, state);
  saveState(payload.session_id, state);

  // A post-tool hook has already paid for the call, so a denial would cost a
  // turn and save nothing. It advises about the NEXT one instead.
  const canRefuse = client.canDeny && event === 'pre-tool' && !repeat && mode() !== MODE_ADVISE;

  if (canRefuse) {
    // Every client's refusal carries the off switch, for the same reason Claude
    // Code's does: enforcement that hides its own disable is coercive.
    emit({
      hookSpecificOutput: {
        hookEventName: eventName,
        [client.denyField]: 'deny',
        permissionDecisionReason: withEscape(verdict.reason),
      },
    });
  } else {
    emit({ hookSpecificOutput: { hookEventName: eventName, additionalContext: verdict.reason } });
  }
  process.exit(0);
}
