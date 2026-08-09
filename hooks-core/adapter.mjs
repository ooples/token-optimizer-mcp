/**
 * The universal client adapter.
 *
 * CLI agents expose similar lifecycle levers under different envelopes. Rather
 * than diverging advisor scripts (the state this replaces, where Codex, Gemini
 * and Claude Code drifted their own thresholds and guidance), command-hook
 * clients ship generated entry files that call this module with a client/event.
 *
 * WHAT ACTUALLY DIFFERS BETWEEN CLIENTS, and is therefore configured below:
 *
 *   - `hookEventName` echo. Claude Code requires the event name back in
 *     hookSpecificOutput; Gemini does not read it. Emitting it always is
 *     harmless, so the shape is shared.
 *
 *   - WHETHER A REFUSAL IS POSSIBLE and how it is represented: nested
 *     permissionDecision, top-level decision, Cline cancel, Cursor permission,
 *     or Windsurf's exit code 2. A post-tool event never claims to undo work.
 */

import {
  loadState, saveState, alreadyDenied, mode, MODE_OFF, MODE_ADVISE, largeFileBytes, withEscape,
} from './policy.mjs';
import {
  commandProjectRoot,
  decide,
  isContentDump,
  remember,
  normalizePayload,
  readCostBytes,
  touchedFiles,
} from './decide.mjs';
import { recordRead, fingerprint } from './metrics.mjs';
import {
  contentHash,
  harvest,
  load,
  wikiDir,
  projectRootFor,
} from './wiki.mjs';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { briefing } from './remedy.mjs';
import { stableText, transcriptFor } from './cache.mjs';
import { cachedRoutingBriefing } from './routing.mjs';
import {
  forCommand,
  forRepeatedAct,
  forSharedCommand,
  forTouch,
  noteActClasses,
} from './inject.mjs';
import { indexFile } from './staleness.mjs';
import { isArchived } from './transcript.mjs';
import { isFsSafePath } from './paths.mjs';
import {
  isSubstantive, recordingNudge, semanticHarvestPrompt,
} from './recording.mjs';

/**
 * Per-client capability.
 *
 * `canDeny` is not a preference -- it is a statement of protocol fact. Setting
 * it true where the client has no pre-execution veto would make the product
 * claim enforcement it cannot deliver.
 */
export const CLIENTS = {
  'claude-code': { canDeny: true, denyStyle: 'permission', stopDecision: 'block' },
  codex: { canDeny: true, denyStyle: 'permission', stopDecision: 'block' },
  cline: {
    canDeny: true,
    contextStyle: 'cline',
    denyStyle: 'cline',
    stopDecision: 'block',
  },
  copilot: {
    canDeny: true,
    contextStyle: 'top-level',
    denyStyle: 'top-level-permission',
    stopDecision: 'block',
  },
  cursor: {
    canDeny: true,
    contextStyle: 'cursor',
    denyStyle: 'cursor',
    stopStyle: 'followup',
    stopDecision: 'block',
  },
  // Gemini's BeforeTool and AfterAgent decisions are top-level. Treating it
  // like Codex produced well-formed JSON that Gemini ignored.
  gemini: { canDeny: true, denyStyle: 'top-level', stopDecision: 'deny' },
  kilo: { canDeny: true, denyStyle: 'permission', stopDecision: 'block' },
  opencode: { canDeny: true, denyStyle: 'permission', stopDecision: 'block' },
  qwen: { canDeny: true, denyStyle: 'permission', stopDecision: 'block' },
  windsurf: {
    canDeny: true,
    contextStyle: 'silent',
    denyStyle: 'exit-2',
    stopDecision: 'block',
  },
};

/** Never synchronously hash an unbounded build artifact on a hook path. */
const HARVEST_MAX_BYTES =
  Number(process.env.TOKEN_OPTIMIZER_HARVEST_MAX_BYTES) || 4_000_000;

function contextOutput(client, eventName, additionalContext) {
  if (client.contextStyle === 'top-level') return { additionalContext };
  if (client.contextStyle === 'cline') {
    return { cancel: false, contextModification: additionalContext, errorMessage: '' };
  }
  if (client.contextStyle === 'cursor') {
    return { continue: true, agent_message: additionalContext };
  }
  if (client.contextStyle === 'silent') return null;
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext } };
}

/** Convert client-specific lifecycle envelopes into the common tool shape. */
export function normalizeClientPayload(clientName, event, raw) {
  if (clientName === 'cline') {
    const body = event === 'post-tool' ? raw.postToolUse : raw.preToolUse;
    if (!body) return raw;
    return {
      ...raw,
      session_id: raw.taskId ?? raw.task_id,
      cwd: raw.workspaceRoots?.[0] ?? raw.workspacePath,
      model: raw.model?.slug,
      tool: body.tool,
      parameters: body.parameters,
    };
  }

  if (clientName === 'windsurf') {
    const info = raw.tool_info || {};
    const action = String(raw.agent_action_name || '');
    const tool = action.includes('read_code') ? 'read_file'
      : action.includes('write_code') ? 'write_file'
        : action.includes('run_command') ? 'run_shell_command'
          : null;
    return {
      ...raw,
      session_id: raw.trajectory_id,
      cwd: info.working_directory ?? raw.working_directory,
      model: raw.model_name,
      tool,
      args: {
        ...info,
        path: info.file_path,
        command: info.command,
      },
    };
  }

  return raw;
}

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
    // THE GRAPH LIVES AT THE REPOSITORY ROOT, and wikiDir does no upward walk. Trusting the
    // bare cwd meant that launching the agent from a subdirectory read an empty directory and
    // reported "nothing learned" for a project whose graph was fully populated one level up --
    // indistinguishable, to the reader, from a project that has genuinely learned nothing.
    // The sentinel filename is what session-start.mjs uses: the walk wants a path INSIDE the
    // tree, not the tree itself.
    const dir = wikiDir(projectRootFor(join(cwd, '__session__'), cwd));

    // Routing facts join the same briefing, and are number-free for the same
    // reason the rest of it is: a count that ticks up as evidence accumulates
    // would change the prefix every session and invalidate the cache behind it.
    // The digits live in the model_routing tool, where changing costs nothing.
    let routing = null;
    try {
      routing = cachedRoutingBriefing(dir, transcriptFor(cwd));
    } catch { /* no transcript, no routing facts; the rest still applies */ }

    const text = briefing(dir, { extra: routing ? [routing] : [] });
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
 * Observe one tool call and return knowledge that is relevant to it.
 *
 * This is the non-Claude delivery path. It deliberately mirrors the ordering
 * in pretooluse-router.mjs: consult the graph before refreshing snapshots, then
 * index the bytes for the next touch. The previous adapter only wrote read
 * metrics. It never called forTouch/forCommand, so four advertised clients
 * accumulated a graph that their active model could not receive.
 */
function observeAndInject(payload, state) {
  const touched = touchedFiles(payload);
  const dirFor = (path) => wikiDir(projectRootFor(path, payload.cwd));

  const bytes = readCostBytes(payload);
  if (bytes && payload.tool_input.file_path) {
    recordRead(dirFor(payload.tool_input.file_path), {
      anchor: payload.tool_input.file_path,
      sessionId: payload.session_id,
      bytes,
      fp: fingerprint(payload.tool_input.file_path),
    });
  } else if (isContentDump(payload.tool_input.command)) {
    for (const { path, size } of touched) {
      if (size > 0) {
        recordRead(dirFor(path), {
          anchor: path,
          sessionId: payload.session_id,
          bytes: size,
          fp: fingerprint(path),
        });
      }
    }
  }

  const parts = [];
  state.injected = state.injected || [];
  const alreadyInjected = new Set(state.injected);

  for (const { path } of touched) {
    const dir = dirFor(path);
    const note = forTouch(dir, load(dir), path, {
      sessionId: payload.session_id,
      alreadyInjected,
    });
    if (note) parts.push(note);
  }

  const command = payload.tool_input?.command;
  if (command) {
    const root = commandProjectRoot(payload, payload.cwd);
    const dir = wikiDir(root);
    const local = forCommand(dir, load(dir), command, {
      sessionId: payload.session_id,
      alreadyInjected,
    });
    if (local) parts.push(local);

    const shared = forSharedCommand(dir, command, {
      sessionId: payload.session_id,
      alreadyInjected,
      projectRoot: root,
    });
    if (shared) parts.push(shared);

    const crossed = noteActClasses(state, command);
    const repeated = forRepeatedAct(dir, command, crossed, {
      sessionId: payload.session_id,
      projectRoot: root,
    });
    if (repeated) parts.push(repeated);
  }
  state.injected = [...alreadyInjected];

  // Structural capture is evidence about what was touched, not a semantic
  // conclusion. It is therefore safe to automate for every client and leaves
  // the active model responsible for wiki_write at completion.
  for (const { path, size } of touched) {
    try {
      if (isArchived(path) || size > HARVEST_MAX_BYTES || !isFsSafePath(path))
        continue;
      const source = readFileSync(path, 'utf8');
      const dir = dirFor(path);
      harvest(dir, {
        filePath: path,
        sessionId: payload.session_id,
        action: payload.tool_name,
        hash: contentHash(path, source),
      });
      indexFile(dir, path, source);
    } catch {
      // Graph bookkeeping must never break the user's tool call.
    }
  }

  return parts.join('\n\n');
}

/**
 * Runs one hook invocation.
 *
 * @param {string} clientName  Key into CLIENTS.
 * @param {'session-start'|'pre-tool'|'post-tool'|'stop'} event
 */
export async function run(clientName, event) {
  const client = CLIENTS[clientName] || CLIENTS['claude-code'];
  const eventName = event === 'session-start' ? 'SessionStart'
    : event === 'post-tool'
      ? (clientName === 'gemini' ? 'AfterTool' : 'PostToolUse')
      : event === 'stop'
        ? (clientName === 'gemini' ? 'AfterAgent' : 'Stop')
        : (clientName === 'gemini' ? 'BeforeTool' : 'PreToolUse');

  if (mode() === MODE_OFF) process.exit(0);

  if (event === 'session-start') {
    const output = contextOutput(client, eventName, policyText(client.canDeny));
    if (output) emit(output);
    process.exit(0);
  }

  const raw = await readStdin();
  if (!raw) {
    // Stop requires JSON on stdout even when it has nothing to add.
    if (event === 'stop') emit({});
    process.exit(0);
  }

  if (event === 'stop') {
    const sessionId = raw.session_id ?? raw.sessionId ?? raw.conversation_id ?? 'default';
    const agentScope = raw.transcript_path ?? raw.transcriptPath ?? null;
    const state = loadState(sessionId, agentScope);
    const prompt = semanticHarvestPrompt({
      edits: state.edits,
      files: state.editedFiles,
      model: raw.model,
      stopHookActive:
        raw.stop_hook_active === true ||
        raw.stopHookActive === true ||
        (clientName === 'cursor' && Number(raw.loop_count || 0) > 0),
    });
    if (prompt && client.stopStyle === 'followup') {
      emit({ followup_message: prompt });
    } else {
      emit(prompt ? { decision: client.stopDecision, reason: prompt } : {});
    }
    process.exit(0);
  }

  if (clientName === 'cline' && event === 'post-tool' && raw.postToolUse?.success === false)
    process.exit(0);
  const payload = normalizePayload(normalizeClientPayload(clientName, event, raw));
  if (!payload.tool_name) process.exit(0);

  // THE AGENT, not just the session -- the same scope the Claude Code router
  // applies. Subagents inherit the parent's session id, so keying state on the
  // session alone lets one agent's reads silence another's: the router's comment
  // records it observed live, an agent refusing a file it had never opened
  // because a sibling had read it. That fix was never carried across to the four
  // clients this adapter serves. `transcript_path` is per agent; absent, this
  // falls back to session scope, which is right for a main session's own calls.
  const agentScope = payload.transcript_path || null;
  const state = loadState(payload.session_id, agentScope);
  let recordingContext = null;

  // Count mutations AFTER Codex reports them, not in PreToolUse where a denied
  // or failed apply_patch has not changed anything. Codex carries an
  // apply_patch body under tool_input.command, so recover the file headers from
  // that body when there is no ordinary file_path field.
  if (event === 'post-tool' && isSubstantive(payload.tool_name)) {
    try {
      const edited = [];
      if (payload.tool_input.file_path) edited.push(payload.tool_input.file_path);
      const patch = payload.tool_input.command;
      if (typeof patch === 'string') {
        for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) {
          const candidate = match[1].trim().replace(/^['"]|['"]$/g, '');
          if (candidate) edited.push(resolve(payload.cwd || process.cwd(), candidate));
        }
      }

      state.edits = (state.edits || 0) + 1;
      state.editedFiles = [
        ...edited,
        ...(state.editedFiles || []),
      ].filter(Boolean).slice(0, 20);
      const anchor = state.editedFiles[0]
        || join(payload.cwd || process.cwd(), '__recording__');
      const dir = wikiDir(projectRootFor(anchor, payload.cwd));
      recordingContext = recordingNudge(dir, {
        state,
        edits: state.edits,
        files: state.editedFiles,
      });
      if (recordingContext) state.recordingNudged = true;
    } catch {
      // Recording pressure is an optimization and must never cost a tool call.
    }
  }
  const verdict = decide(payload, state);
  const repeat = verdict && event === 'pre-tool'
    ? alreadyDenied(state, verdict.key)
    : false;

  // A post-tool hook has already paid for the call, so a denial would cost a
  // turn and save nothing. It advises about the NEXT one instead.
  const canRefuse = Boolean(
    verdict && client.canDeny && event === 'pre-tool' && !repeat && mode() !== MODE_ADVISE
  );

  if (canRefuse) {
    remember(payload, state);
    saveState(payload.session_id, state, agentScope);
    // Every client's refusal carries the off switch, for the same reason Claude
    // Code's does: enforcement that hides its own disable is coercive.
    if (client.denyStyle === 'top-level') {
      emit({ decision: 'deny', reason: withEscape(verdict.reason) });
    } else if (client.denyStyle === 'top-level-permission') {
      emit({
        permissionDecision: 'deny',
        permissionDecisionReason: withEscape(verdict.reason),
      });
    } else if (client.denyStyle === 'cline') {
      emit({ cancel: true, contextModification: '', errorMessage: withEscape(verdict.reason) });
    } else if (client.denyStyle === 'cursor') {
      emit({
        continue: true,
        permission: 'deny',
        agent_message: withEscape(verdict.reason),
        user_message: 'Token Optimizer redirected an expensive built-in operation.',
      });
    } else if (client.denyStyle === 'exit-2') {
      process.stderr.write(withEscape(verdict.reason));
      process.exit(2);
    } else {
      emit({
        hookSpecificOutput: {
          hookEventName: eventName,
          permissionDecision: 'deny',
          permissionDecisionReason: withEscape(verdict.reason),
        },
      });
    }
    process.exit(0);
  }

  // This call either is about to run, has already run, or is the bounded repeat
  // escape after one refusal. All three are real observations. In particular,
  // a post-tool verdict must not skip measurement merely because the same call
  // would have been denied at pre-tool time -- that was why Gemini's large reads
  // produced advice but zero metrics.
  remember(payload, state);
  let graphContext = null;
  try {
    graphContext = observeAndInject(payload, state);
  } catch {
    // Delivery is an optimization. Fail open.
  }
  saveState(payload.session_id, state, agentScope);

  const context = [
    verdict?.reason,
    graphContext,
    recordingContext,
  ].filter(Boolean).join('\n\n');
  if (context) {
    const output = contextOutput(client, eventName, context);
    if (output) emit(output);
  }
  process.exit(0);
}
