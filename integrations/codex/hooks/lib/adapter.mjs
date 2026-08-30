// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/adapter.mjs. Regenerate with `npm run sync:hooks`.
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
  loadState,
  saveState,
  alreadyDenied,
  mode,
  MODE_OFF,
  MODE_ADVISE,
  largeFileBytes,
  readPayloadResult,
  withEscape,
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
import {
  record,
  recordRead,
  fingerprint,
  recordToolOutcome,
  recordEpisodeOutcome,
} from './metrics.mjs';
import { derive } from './derive.mjs';
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
import { scoreRefreshes } from './keepwarm.mjs';
import { cachedRoutingBriefing } from './routing.mjs';
import {
  forCommand,
  forRepeatedAct,
  forSharedCommand,
  forTouch,
  noteActClasses,
  relevantFindingIdsForContext,
  sessionContext,
  sessionIndex,
  standingRules,
} from './inject.mjs';
import { indexFile } from './staleness.mjs';
import { recordAuthoredContent } from './authored.mjs';
import { observedWrites, queueInvalidation } from './pending.mjs';
import { archive, isArchived } from './transcript.mjs';
import { harvestMode } from './harvest.mjs';
import { isFsSafePath } from './paths.mjs';
import {
  isSubstantive,
  recordingNudge,
  semanticHarvestPrompt,
} from './recording.mjs';
import {
  HOOK_MCP_TOOLS,
  nativeClientProfiles,
  optimizerToolEvidence,
  optimizerToolsForHook,
  rememberOptimizerTools,
} from './capabilities.mjs';
import { episodeMeta, featuresForArm, usageFrom } from './experiment.mjs';
import { evaluateUcrGuards } from './ucr-guard.mjs';
import { beginHookInvocation, noteHookOutput } from './observability.mjs';
import { registerProject } from './projects.mjs';
import { runStopHarvest } from './stop-harvest.mjs';

/**
 * Per-client capability.
 *
 * `canDeny` is not a preference -- it is a statement of protocol fact. Setting
 * it true where the client has no pre-execution veto would make the product
 * claim enforcement it cannot deliver.
 */
export const CLIENTS = nativeClientProfiles();

/** Never synchronously hash an unbounded build artifact on a hook path. */
const HARVEST_MAX_BYTES =
  Number(process.env.TOKEN_OPTIMIZER_HARVEST_MAX_BYTES) || 4_000_000;

/**
 * The response envelopes a completed tool call can arrive in.
 *
 * Spelled out ONCE because FOUR readers depend on it -- mutation accounting,
 * success classification, output capture and exit-code capture -- and clients
 * disagree on the envelope name and on nothing else. Letting each reader name
 * its own subset is exactly how both classifiers came to miss MCP's failure
 * flag: `toolSucceeded` listed four envelopes and `mutationSucceeded` listed
 * three, and neither list mentioned `isError` at all.
 */
function responseEnvelopes(raw) {
  return [
    raw?.tool_response,
    raw?.toolResponse,
    raw?.tool_result,
    raw?.toolResult,
    raw?.postToolUse,
  ].filter((envelope) => envelope !== undefined && envelope !== null);
}

/**
 * Did an MCP result declare itself an error?
 *
 * `isError` is the ONLY failure signal an MCP result carries -- there is no
 * `error` field and no `status` -- and `src/server/index.ts` sets it in seven
 * places. Shared by both classifiers so they cannot disagree about what a
 * failed call from this project's own tools looks like.
 *
 * `=== true` EXACTLY. A client using the key for anything else must not have
 * its successful calls silently reclassified, and `isError: false` is a
 * successful MCP call, not a missing verdict.
 */
function reportedMcpError(raw) {
  return [...responseEnvelopes(raw), raw].some(
    (envelope) => envelope?.isError === true
  );
}

/**
 * A post-tool event is not universally proof of success. Some clients split
 * success and failure into distinct events; others expose a result status.
 * Keep mutation accounting conservative so a failed edit cannot arm Stop.
 */
export function mutationSucceeded(clientName, raw) {
  if (raw?.error || raw?.tool_response?.error || raw?.toolResponse?.error)
    return false;
  if (raw?.postToolUse?.success === false || raw?.success === false)
    return false;
  // BEFORE the status read, the explicit-success read AND the client
  // allowlist, because all three would otherwise pass a failed MCP write. The
  // allowlist is the one that actually bit: it returns true for claude-code,
  // codex, qwen, opencode, kilo and windsurf on any post-tool event with no
  // error and no status, which is precisely the shape of a failed smart_write.
  //
  // WHY THIS IS THE SAME BUG AS THE ONE IN `toolSucceeded` AND NOT A COSMETIC
  // ECHO OF IT: this function gates edit counting and harvest pressure, so
  // counting a failed write to THE OPTIMIZER'S OWN TOOLS as a mutation
  // inflates "the optimizer successfully edited a file". Different consumers
  // from the effectiveness figures, same direction of bias -- toward
  // flattering the thing being measured.
  if (reportedMcpError(raw)) return false;

  const status =
    raw?.tool_response?.status ??
    raw?.tool_response?.result_type ??
    raw?.toolResponse?.status ??
    raw?.toolResponse?.resultType ??
    raw?.tool_result?.result_type ??
    raw?.tool_result?.status ??
    raw?.toolResult?.resultType ??
    raw?.toolResult?.status;
  if (status !== undefined) {
    return /^(?:ok|success|succeeded|complete|completed)$/i.test(
      String(status)
    );
  }

  if (raw?.postToolUse?.success === true || raw?.success === true) return true;
  if (clientName === 'gemini' && raw?.tool_response) return true;

  // These lifecycle contracts fire this event only after a successful tool,
  // or are called by our in-process bridge only from its successful after hook.
  return new Set([
    'claude-code',
    'codex',
    'qwen',
    'opencode',
    'kilo',
    'windsurf',
  ]).has(
    clientName
  );
}

/** Conservative success classification for any completed tool call. */
export function toolSucceeded(raw) {
  if (raw?.error || raw?.tool_response?.error || raw?.toolResponse?.error)
    return false;
  if (raw?.postToolUse?.success === false || raw?.success === false)
    return false;
  // MCP'S OWN FAILURE FLAG, which this function did not read for as long as it
  // existed. It did not matter while `normalizeTool` dropped MCP names before
  // any accounting ran; it matters now that `mcp__<server>__smart_edit` and
  // `smart_write` reach the post-tool path, because an MCP result carries no
  // `error` field and no `status` -- only `isError` -- so a failed smart_edit
  // fell through to the optimistic `return true` below.
  //
  // WHY THIS IS A MEASUREMENT BUG AND NOT A COSMETIC ONE: this boolean feeds
  // episode outcomes and effectiveness accounting, so recording every failed
  // call to THE OPTIMIZER'S OWN TOOLS as a success biased all of it in the
  // optimizer's favour. A measurement that flatters the thing being measured
  // is worse than no measurement.
  if (reportedMcpError(raw)) return false;
  const status =
    raw?.tool_response?.status ??
    raw?.toolResponse?.status ??
    raw?.tool_result?.status ??
    raw?.toolResult?.status;
  if (status !== undefined) {
    if (
      /^(?:error|failed|failure|cancelled|canceled|denied)$/i.test(
        String(status)
      )
    )
      return false;
    if (/^(?:ok|success|succeeded|complete|completed)$/i.test(String(status)))
      return true;
  }
  // A post-tool lifecycle event is evidence that the call completed, but not
  // that its output proved the task.  `success` here is deliberately scoped to
  // the tool call; task correctness comes only from an eval grader.
  return true;
}

/** A non-empty string, or null.  Blank output is the same as none. */
function nonEmpty(value) {
  const text = String(value ?? '');
  return text.trim() ? text : null;
}

/**
 * The human-readable result text inside one envelope, or null.
 *
 * RETURNS NULL RATHER THAN GUESSING. An envelope shape nobody here has seen
 * produces no capture at all, which costs one finding. Stringifying it instead
 * would put `[object Object]` or a wall of JSON metadata into a claim that gets
 * injected into model context -- a wrong observation, which is strictly worse
 * than a missing one.
 */
function resultText(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return nonEmpty(value);
  if (typeof value === 'number' || typeof value === 'boolean') return null;

  // MCP content blocks, which is how THIS PROJECT'S OWN tools now arrive:
  // `normalizeTool` resolves `mcp__<server>__smart_edit`, so smart_edit and
  // smart_write reach the post-tool path for the first time and their results
  // are `{ content: [{ type: 'text', text }], isError }` rather than a shell
  // result. Both the bare array and the wrapping object are accepted because
  // hosts differ on whether they hand the hook the result or its content.
  if (Array.isArray(value)) {
    const blocks = value
      .map((block) =>
        typeof block === 'string' ? block : nonEmpty(block?.text)
      )
      .filter(Boolean);
    return blocks.length ? nonEmpty(blocks.join('\n')) : null;
  }
  if (typeof value !== 'object') return null;

  // STDERR FIRST, and not because that is the order it was produced in. The
  // cap can only ever cut the tail, and the diagnostic that explains a failure
  // is almost always on stderr while the volume is almost always on stdout --
  // so appending stderr would let a 3 MB build log push the one line worth
  // capturing out of the window.
  const streams = [nonEmpty(value.stderr), nonEmpty(value.stdout)].filter(
    Boolean
  );
  if (streams.length) return streams.join('\n');

  if (Array.isArray(value.content)) {
    const inner = resultText(value.content);
    if (inner) return inner;
  }

  const error = value.error;
  if (error) {
    const message =
      typeof error === 'string' ? error : nonEmpty(error.message ?? error.msg);
    if (message) return message;
  }

  return (
    nonEmpty(value.output) ??
    nonEmpty(value.text) ??
    nonEmpty(value.message) ??
    (typeof value.result === 'string' ? nonEmpty(value.result) : null)
  );
}

/**
 * The result text of a completed tool call, or null when the client reports
 * none.  Redaction and the size cap are NOT applied here -- they belong at the
 * `recordToolOutcome` boundary, which is the only place every caller passes.
 */
export function outputFrom(raw) {
  for (const envelope of responseEnvelopes(raw)) {
    const text = resultText(envelope);
    if (text) return text;
  }
  return resultText(raw?.output) ?? resultText(raw?.stdout) ?? null;
}

/**
 * Key names that mean "process exit code" and nothing else.
 *
 * `code` is deliberately ABSENT. JSON-RPC errors (`code: -32602`), Node errno
 * objects (`code: 'ENOENT'`) and HTTP wrappers all reuse that name, so reading
 * it would record a confident exit code for calls that never had one. A null
 * here is honest; a -32602 claiming to be an exit status is not.
 */
const EXIT_KEYS = [
  'exit_code',
  'exitCode',
  'exit',
  'exit_status',
  'exitStatus',
  'return_code',
  'returncode',
];

/** The numeric exit code a client reported, or null when it reported none. */
export function exitFrom(raw) {
  for (const envelope of [...responseEnvelopes(raw), raw]) {
    if (!envelope || typeof envelope !== 'object') continue;
    for (const key of EXIT_KEYS) {
      const value = envelope[key];
      if (Number.isInteger(value)) return value;
      // A client that serializes the code as a digit string still reported it.
      // Bounded so a hash or an id cannot be mistaken for a status.
      if (typeof value === 'string' && /^-?\d{1,5}$/.test(value.trim()))
        return Number(value.trim());
    }
  }
  return null;
}

function contextOutput(client, eventName, additionalContext) {
  if (client.contextStyle === 'top-level') return { additionalContext };
  if (client.contextStyle === 'cline') {
    return {
      cancel: false,
      contextModification: additionalContext,
      errorMessage: '',
    };
  }
  if (client.contextStyle === 'cursor') {
    return { continue: true, agent_message: additionalContext };
  }
  if (client.contextStyle === 'silent') return null;
  return {
    hookSpecificOutput: { hookEventName: eventName, additionalContext },
  };
}

/** Convert one static JavaScript string literal without evaluating code. */
function codexStringLiteral(literal) {
  if (typeof literal !== 'string' || literal.length < 2) return null;
  const quote = literal[0];
  if (!['"', "'", '`'].includes(quote) || literal.at(-1) !== quote) return null;

  let decoded = '';
  for (let index = 1; index < literal.length - 1; index += 1) {
    const character = literal[index];
    if (quote === '`' && character === '$' && literal[index + 1] === '{')
      return null;
    if (character !== '\\') {
      decoded += character;
      continue;
    }

    index += 1;
    if (index >= literal.length - 1) return null;
    const escaped = literal[index];
    const simple = {
      b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', 0: '\0',
      '\\': '\\', "'": "'", '"': '"', '`': '`', '$': '$',
    };
    if (Object.hasOwn(simple, escaped)) {
      decoded += simple[escaped];
      continue;
    }
    if (escaped === '\n') continue;
    if (escaped === '\r') {
      if (literal[index + 1] === '\n') index += 1;
      continue;
    }
    if (escaped === 'x') {
      const digits = literal.slice(index + 1, index + 3);
      if (!/^[0-9a-f]{2}$/i.test(digits)) return null;
      decoded += String.fromCodePoint(Number.parseInt(digits, 16));
      index += 2;
      continue;
    }
    if (escaped === 'u') {
      const braced = literal[index + 1] === '{';
      const close = braced ? literal.indexOf('}', index + 2) : index + 5;
      const digits = braced
        ? literal.slice(index + 2, close)
        : literal.slice(index + 1, close);
      if (
        close < 0 ||
        !(braced ? /^[0-9a-f]{1,6}$/i : /^[0-9a-f]{4}$/i).test(digits)
      ) return null;
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint > 0x10ffff) return null;
      decoded += String.fromCodePoint(codePoint);
      index = close;
      continue;
    }
    // JavaScript identity escapes drop the slash (for example, '\q' is 'q').
    decoded += escaped;
  }
  return decoded;
}

/** Convert client-specific lifecycle envelopes into the common tool shape. */
function codexStringBindings(source) {
  const values = new Map();
  const declaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*((?:"(?:\\.|[^"\\])*")|(?:'(?:\\.|[^'\\])*')|(?:`(?:\\.|[^`\\])*`))/gs;
  for (const match of String(source || '').matchAll(declaration)) {
    try {
      const value = codexStringLiteral(match[2]);
      if (value !== null) values.set(match[1], value);
    } catch {
      // A computed or malformed JavaScript expression is not safe to execute
      // merely to understand a hook envelope. Leave it opaque.
    }
  }
  return values;
}

function codexCallArguments(source, method) {
  const calls = [];
  const pattern = new RegExp(`(?:tools\\.)?${method}\\s*\\(\\s*([^),]+)`, 'gi');
  for (const match of String(source || '').matchAll(pattern))
    calls.push(match[1].trim());
  return calls;
}

function codexLiteral(value, bindings) {
  if (bindings.has(value)) return String(bindings.get(value));
  return codexStringLiteral(value);
}

function codexExecCommands(source, bindings) {
  const commands = [];
  for (const call of String(source || '').matchAll(
    /(?:tools\.)?exec_command\s*\(\s*\{([\s\S]*?)\}\s*\)/gi
  )) {
    const property = /\bcmd\s*:\s*((?:"(?:\\.|[^"\\])*")|(?:'(?:\\.|[^'\\])*')|(?:`(?:\\.|[^`\\])*`)|(?:[A-Za-z_$][\w$]*))/s.exec(call[1]);
    if (!property) continue;
    const command = codexLiteral(property[1], bindings);
    if (command) commands.push(command);
  }
  return commands;
}

export function normalizeClientPayload(clientName, event, raw) {
  if (clientName === 'codex') {
    const outerName = String(raw.tool_name ?? raw.toolName ?? raw.tool ?? '');
    if (/^(?:functions\.)?exec$/i.test(outerName)) {
      const envelope = raw.tool_input ?? raw.toolInput ?? raw.arguments ?? raw.args;
      const source =
        typeof envelope === 'string'
          ? envelope
          : envelope?.code ?? envelope?.input ?? envelope?.source ?? '';
      const bindings = codexStringBindings(source);
      const patchCalls = codexCallArguments(source, 'apply_patch');
      const patch = patchCalls
        .map((argument) => codexLiteral(argument, bindings))
        .find(Boolean);
      const mutation = patchCalls.length > 0;
      const commands = codexExecCommands(source, bindings);

      // `functions.exec` is also the orchestration envelope for web, image and
      // other non-filesystem tools. Do not reinterpret those as shell commands:
      // doing so produced irrelevant cross-project advice and fabricated graph
      // activity for operations the filesystem hooks never observed.
      if (!mutation && !commands.length) return raw;
      return {
        ...raw,
        tool_name: mutation ? 'apply_patch' : 'run_command',
        tool_input: {
          ...(envelope && typeof envelope === 'object' ? envelope : {}),
          command: String(patch || commands.join('\n') || source || ''),
          code_mode_envelope: true,
          // A single nested shell call is unambiguous and safe to veto. Keep
          // multi-operation programs advisory because rejecting their outer
          // envelope would discard unrelated work in the same orchestration.
          code_mode_single_shell_command:
            !mutation && commands.length === 1,
        },
      };
    }
  }

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
    const tool = action.includes('read_code')
      ? 'read_file'
      : action.includes('write_code')
        ? 'write_file'
        : action.includes('run_command')
          ? 'run_shell_command'
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

/** Extract only user/task text, never cwd, ids, or other metadata. */
export function sessionTaskContext(raw = {}) {
  return [
    raw.prompt,
    raw.user_prompt,
    raw.userPrompt,
    raw.initial_prompt,
    raw.initialPrompt,
    raw.task_prompt,
    raw.taskPrompt,
    raw.task_description,
    raw.taskDescription,
    raw.task?.prompt,
    raw.task?.text,
    raw.message?.content,
  ]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n');
}

function emit(object) {
  const serialized = JSON.stringify(object);
  noteHookOutput(object, Buffer.byteLength(serialized, 'utf8'));
  process.stdout.write(serialized);
}

/**
 * What will and will not extract findings after this session, in one sentence.
 *
 * THE STATE WAS ONLY EVER LEGIBLE FROM THE DOCTOR, and the doctor is a place
 * someone visits after they already suspect something is wrong. A user watching
 * a graph fill with structural nodes and no verdicts has no reason to suspect
 * anything, which is the failure this project has now measured twice.
 *
 * IT IS ADDRESSED TO THE MODEL, NOT ONLY TO THE READER, which is why it earns a
 * place in the prefix rather than a systemMessage. "Nothing else will write this
 * down in words" changes what the model does with a conclusion it is holding;
 * "here is a configuration variable" would not.
 *
 * CACHE-SAFE: derived from configuration, so it differs between sessions only
 * when the configuration does -- the same standard the rest of this block is
 * held to, and it carries no digits for `stableText` to reject.
 *
 * A local endpoint is named FIRST in the off case on purpose. It is the option
 * that costs nothing and sends nothing, and it was the one buried deepest.
 */
function extractionNotice() {
  switch (harvestMode()) {
    case 'local':
      return (
        '\n\nA local model endpoint is configured, so semantic extraction also runs after this ' +
        'session -- free and private, with nothing leaving this machine.'
      );
    case 'remote':
      return (
        '\n\nA credential is configured, so fallback extraction also runs after this session from ' +
        'a bounded digest: paths, commands, prompts and conclusions, never file contents.'
      );
    case 'off:mode':
      // The whole optimizer is off and this text is not emitted anyway. Saying
      // anything here would be noise stacked on an explicit choice.
      return '';
    case 'off:opted-out':
      // A DELIBERATE CHOICE, SO NO PITCH. The consequence is stated because the
      // model needs it; the setting that would reverse it is not, because
      // arguing with a configured decision on every session is how a notice
      // stops being read. doctor.mjs draws the same line for the same reason.
      return (
        '\n\nFallback extraction is off by configuration, so a conclusion you do not record is ' +
        'not written down in words anywhere. Findings are still derived locally from exit codes, ' +
        'red-to-green transitions and corrections.'
      );
    default:
      // off:no-key, and any mode a future harvest adds: no extractor is running
      // and nobody chose that, so the free option is worth naming.
      return (
        '\n\nNo separate extractor will run after this session, so a conclusion you do not record ' +
        'is not written down in words anywhere. Findings are still derived locally from exit ' +
        'codes, red-to-green transitions and corrections. Pointing ' +
        'TOKEN_OPTIMIZER_HARVEST_ENDPOINT at a local model adds semantic extraction, free and ' +
        'private.'
      );
  }
}

/** The session-start notice, shared verbatim so no client drifts its own copy. */
export function policyText(
  canDeny,
  availableTools = undefined,
  registrationProven = availableTools !== undefined
) {
  const kb = Math.round(largeFileBytes() / 1024);
  // Direct library callers historically asked for policyText(true) to render
  // the core policy. Runtime entry points always pass an explicit Set, where
  // an empty set means "do not claim or redirect to any MCP schema".
  const tools =
    availableTools === undefined
      ? new Set(HOOK_MCP_TOOLS)
      : new Set(availableTools);
  const routes = [];
  if (tools.has('smart_read')) {
    routes.push(
      `- Reading a file larger than ~${kb} KB, re-reading a file, or printing a large file -> smart_read`
    );
  }
  if (tools.has('smart_grep'))
    routes.push(
      '- Searching file contents or running a recursive shell search -> smart_grep'
    );
  if (tools.has('smart_glob'))
    routes.push('- Finding files with an unbounded pattern -> smart_glob');
  if (tools.has('smart_edit'))
    routes.push(`- Editing a file larger than ~${kb} KB -> smart_edit`);
  if (tools.has('smart_write'))
    routes.push(`- Writing a file larger than ~${kb} KB -> smart_write`);

  const connection =
    tools.size > 0 && registrationProven
      ? `The host supplied positive runtime inventory evidence for ${tools.size} optimizer MCP tool(s).`
      : tools.size > 0
        ? 'The following optimizer MCP tools are available to this policy caller.'
        : registrationProven
          ? 'The host supplied a proven empty optimizer MCP inventory for this session.'
          : 'This hook received no positive evidence that optimizer MCP tools are registered in this session.';
  const routing = routes.length
    ? `\n\nPrefer only the registered replacements listed below; they cache, diff, or bound output:\n\n${routes.join('\n')}`
    : "\n\nKeep the CLI's native tools available and bound their output. Do not redirect to or call an optimizer MCP tool unless its schema is visible in the current tool inventory.";
  const enforcement = routes.length
    ? canDeny && mode() !== MODE_ADVISE
      ? '\n\nA built-in call is denied only when its exact replacement has positive registration evidence. A second attempt at the same target remains available.'
      : '\n\nThese are recommendations; the built-in tools remain available.'
    : '';
  const utilities = [
    tools.has('optimize_session')
      ? 'When the context window gets tight, call optimize_session.'
      : null,
    tools.has('get_optimization_report')
      ? 'Use get_optimization_report for measured savings.'
      : null,
  ]
    .filter(Boolean)
    .join(' ');
  const recording = tools.has('wiki_write')
    ? `\n\n## Record what you work out\n\nCall wiki_write when you establish something durable about this project, while\nyou still hold the context. Every claim needs at least one anchor -- a real file\npath, or path#symbol -- because an unanchored claim can never be checked against\nthe code again and would be served as current forever; unanchored writes are\nrefused.\n\nWorth recording: a decision and why the alternative was rejected, a failure and\nwhat actually caused it, a command that turned out to be the one that works.\nNot worth recording: what the code plainly says. Every wiki_write must include\nthe concrete evidence, when it applies, a calibrated confidence label, its\nscope, and what would invalidate it. Prefer the thing someone had to work out,\nbecause that exists nowhere in the source tree.${extractionNotice()}`
    : '\n\nStructural graph capture remains active through lifecycle hooks. Durable semantic MCP writes are not requested because the writer schema is not proven available.';

  return `# Token optimization is active\n\nLive graph capture is active through the lifecycle adapter.\n\n${connection}${routing}${enforcement}${utilities ? `\n\n${utilities}` : ''}${recording}${projectBriefing()}`;
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
    } catch {
      /* no transcript, no routing facts; the rest still applies */
    }

    const text = briefing(dir, { extra: routing ? [routing] : [] });
    if (!text) return '';

    // CACHE-SAFE BY CONSTRUCTION. This text sits near the front of the prompt
    // prefix, so a single character that differs between sessions invalidates
    // everything after it -- and an optimizer that costs more cache than it
    // saves tokens is worse than no optimizer. A line that would vary is
    // dropped rather than emitted: missing guidance costs a little, a volatile
    // line costs the whole prefix.
    const { text: safe } = stableText(text);
    return safe.trim()
      ? `\n\n## What we have learned about this project\n\n${safe}`
      : '';
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
function observeAndInject(payload, state, episode, features) {
  const touched = touchedFiles(payload);
  const dirFor = (path) => wikiDir(projectRootFor(path, payload.cwd));
  const registerRoot = (root) => {
    const dir = wikiDir(root);
    registerProject({
      root,
      graphDir: dir,
      client: episode.client || 'unknown',
    });
    return dir;
  };

  // SessionStart is not delivered consistently by every host/version. The
  // graph was still written in that case, but the dashboard registry never
  // learned it existed. Register every repository observed by a real tool call
  // as a second, idempotent production path.
  for (const { path } of touched)
    registerRoot(projectRootFor(path, payload.cwd));

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

  if (features.retrieval) {
    for (const { path } of touched) {
      const dir = dirFor(path);
      const note = forTouch(dir, load(dir), path, {
        sessionId: payload.session_id,
        alreadyInjected,
        episode,
      });
      if (note) parts.push(note);
    }

    const command = payload.tool_input?.command;
    if (command) {
      const root = commandProjectRoot(payload, payload.cwd);
      const dir = registerRoot(root);
      const local = forCommand(dir, load(dir), command, {
        sessionId: payload.session_id,
        alreadyInjected,
        episode,
      });
      if (local) parts.push(local);

      const shared = forSharedCommand(dir, command, {
        sessionId: payload.session_id,
        alreadyInjected,
        projectRoot: root,
        episode,
      });
      if (shared) parts.push(shared);

      const crossed = noteActClasses(state, command);
      const repeated = forRepeatedAct(dir, command, crossed, {
        sessionId: payload.session_id,
        projectRoot: root,
        episode,
      });
      if (repeated) parts.push(repeated);
    }
  }
  state.injected = [...alreadyInjected];

  // Structural capture is evidence about what was touched, not a semantic
  // conclusion. It is therefore safe to automate for every client and leaves
  // the active model responsible for wiki_write at completion.
  if (features.capture)
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

        // WHAT THIS SESSION WROTE, kept separate from the graph snapshot above
        // because it answers a different question. `indexFile` records what a
        // hook OBSERVED -- reads included, across sessions -- which is unusable
        // as a diff base: it would tell a session that never saw a file that
        // nothing had changed. This record is written only on a mutation and
        // carries the authoring session, so `smart_read` can ask "did I write
        // this?" rather than "has anyone seen this?".
        //
        // Free here: the source is already in hand for the graph write.
        recordAuthoredContent(
          projectRootFor(path, payload.cwd),
          payload.session_id,
          path,
          source
        );
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
  const invocation = beginHookInvocation(clientName, event);
  try {
    await runHook(clientName, event, invocation);
    invocation.succeed();
  } catch (error) {
    // The optimizer must fail open, but the failure is now reconstructable.
    invocation.fail(error);
  }
}

async function runHook(clientName, event, invocation) {
  const client = CLIENTS[clientName] || CLIENTS['claude-code'];
  const eventName =
    event === 'session-start'
      ? 'SessionStart'
      : event === 'post-tool'
        ? clientName === 'gemini'
          ? 'AfterTool'
          : 'PostToolUse'
        : event === 'stop'
          ? clientName === 'gemini'
            ? 'AfterAgent'
            : 'Stop'
          : clientName === 'gemini'
            ? 'BeforeTool'
            : 'PreToolUse';

  if (mode() === MODE_OFF) process.exit(0);

  const features = featuresForArm();

  if (event === 'session-start') {
    if (!features.routing && !features.retrieval && !features.harvest)
      process.exit(0);
    // Some hook hosts invoke SessionStart without closing stdin. Waiting the
    // full pre-tool timeout would turn optional context into a five-second
    // startup tax; lifecycle payloads are tiny and arrive immediately when
    // the host supplies one.
    const input = await readPayloadResult({ timeoutMs: 250 });
    const raw = input.payload || {};
    invocation.bind(raw, null, input.bytes);
    if (input.status !== 'ok') invocation.noteInput(input.status, input.bytes);
    const toolEvidence = optimizerToolEvidence(raw);
    const sessionId = raw.session_id ?? raw.sessionId ?? raw.conversation_id;
    if (sessionId && toolEvidence.proven) {
      const state = loadState(sessionId);
      rememberOptimizerTools(state, toolEvidence);
      saveState(sessionId, state);
    }
    // ASSEMBLED IN CACHE ORDER, not in whatever order this function happens to
    // discover the blocks. Everything emitted here sits near the FRONT of the
    // prompt prefix, and a prefix cache invalidates from the first differing
    // byte onward -- so the block that changes most often has to sit LAST, or it
    // re-prices every block behind it on every session. `sessionContext` sorts
    // by the declared volatility; inject.mjs records how each number was
    // assigned and why.
    const blocks = [
      {
        id: 'policy',
        volatility: 0,
        text: policyText(
          client.canDeny,
          toolEvidence.names,
          toolEvidence.proven
        ),
      },
    ];
    const cwd = raw.cwd || raw.working_directory || process.cwd();
    const root = projectRootFor(join(cwd, '__session__'), cwd);
    registerProject({ root, graphDir: wikiDir(root), client: clientName });
    if (features.retrieval) {
      try {
        const dir = wikiDir(root);
        // SessionStart needs hashes and claims, not stored file bodies. Parsing
        // the snapshot sidecar here would make startup scale with repository
        // history even though this compact index never renders a diff.
        const graph = load(dir);
        const episode = episodeMeta({ client: clientName, raw });
        const rules = standingRules(dir, graph, { episode });
        if (rules) blocks.push({ id: 'standing', volatility: 1, text: rules });
        const relevantFindingIds = relevantFindingIdsForContext(
          graph,
          sessionTaskContext(raw)
        );
        const index = sessionIndex(dir, graph, {
          episode,
          relevantFindingIds,
        });
        if (index) blocks.push({ id: 'index', volatility: 2, text: index });
      } catch {
        // Retrieval is optional context; the policy must still reach the model.
      }
    }
    const output = contextOutput(client, eventName, sessionContext(blocks));
    if (output) emit(output);
    process.exit(0);
  }

  const input = await readPayloadResult();
  const raw = input.payload;
  if (!raw) {
    invocation.noteInput(input.status, input.bytes);
    // Stop requires JSON on stdout even when it has nothing to add.
    if (event === 'stop') emit({});
    process.exit(0);
  }

  if (event === 'stop') {
    // Stop has no normalized tool payload, but it is still a fully formed hook
    // invocation. Bind its lifecycle identifiers so successful completions do
    // not look like an input reader that never ran in cross-client telemetry.
    invocation.bind(raw, null, input.bytes);
    const sessionId =
      raw.session_id ?? raw.sessionId ?? raw.conversation_id ?? 'default';
    const agentScope = raw.transcript_path ?? raw.transcriptPath ?? null;
    const state = loadState(sessionId, agentScope);
    const toolEvidence = optimizerToolsForHook(raw, state);
    rememberOptimizerTools(state, toolEvidence);
    const episode = episodeMeta({ client: clientName, raw });
    // Hoisted out of the try below, because the harvest needs the same resolved
    // directory and resolving it twice is how two halves of one hook end up
    // reasoning about different projects.
    const cwd = raw.cwd || raw.working_directory || process.cwd();
    try {
      const dir = wikiDir(projectRootFor(join(cwd, '__session__'), cwd));
      recordEpisodeOutcome(dir, {
        ...episode,
        status: 'completed',
        ...usageFrom(raw),
      });
    } catch {
      // Evidence is best effort and must never stop a session from finishing.
    }
    try {
      // THE KEEP-WARM FEEDBACK ARM, at the boundary where a turn has just
      // ended -- which is the only place the arrival question can be answered.
      // Every refresh whose TTL has since elapsed is scored here as used or
      // unused; anything the log cannot settle is left unscored rather than
      // recorded as a miss, because an absent signal is not a miss.
      //
      // Nothing in this repository issues a refresh today -- cache_audit only
      // recommends one -- so this scores nothing, and what it costs while
      // dormant is one readBalance: median 70 ms on this machine's 3.5 MB log,
      // against derive's 71-111 ms a few lines below on the same path. The
      // firehose is read for ARRIVALS only if an unscored refresh exists, so
      // the dormant case never pays for that. The moment an issuer exists, the
      // decision starts learning with no second wiring change.
      const cwd = raw.cwd || raw.working_directory || process.cwd();
      const dir = wikiDir(projectRootFor(join(cwd, '__session__'), cwd));
      scoreRefreshes(dir);
    } catch {
      // A refresh that cannot be scored costs a measurement, not a session.
    }
    try {
      // THE ARCHIVE, WRITTEN BEFORE ANYTHING READS IT.
      //
      // This was lost rather than retired. `plugin/hooks/stop-harvest.mjs` called
      // `archive()` at Stop, and #300 replaced that entry in `hooks.json` with the
      // generated `stop.mjs`, which routes here -- so on Claude Code no session has
      // been archived since. Nothing failed loudly: `readArchive` simply returns an
      // empty list, so `derive`'s correction detector fell through to the live
      // transcript (present only for a client that reports one) and `lessons.mjs`
      // lost the only corpus it can verify a verbatim quote against, which is the
      // single test that grants a feedback finding human origin.
      //
      // BEFORE `derive`, deliberately: the correction detector reads the archive
      // first and treats the live transcript as the fallback, and the archive is
      // the copy that survives into later sessions.
      const cwd = raw.cwd || raw.working_directory || process.cwd();
      const dir = wikiDir(projectRootFor(join(cwd, '__session__'), cwd));
      if (agentScope) archive(dir, agentScope, { sessionId });
    } catch {
      // The archive is a record, not a result. A session still ends.
    }
    try {
      // ZERO-COST DERIVATION, on every client, with no credential. The semantic
      // harvest below needs an API key, so on a machine without one the graph
      // accumulates structure and no verdicts at all. These detectors read only
      // what is already on disk and send nothing anywhere.
      //
      // COUNTS are recorded rather than the candidates, and BOTH counts: how
      // many findings a session's own evidence supports, and how many of them
      // survived the storage budget and the anchor discipline. The gap between
      // the two is the number that says whether the bound is doing anything --
      // one figure alone cannot distinguish "nothing to derive" from "derived
      // plenty and stored none of it".
      const cwd = raw.cwd || raw.working_directory || process.cwd();
      const projectRoot = projectRootFor(join(cwd, '__session__'), cwd);
      const dir = wikiDir(projectRoot);
      const derived = derive(dir, {
        sessionId,
        projectRoot,
        transcriptPath: agentScope,
        // The hook payload's own identity, not a value a model typed.
        authoritativeSessionId: sessionId,
      });
      record(dir, {
        kind: 'derive',
        sessionId,
        candidates: derived.candidates.length,
        observations: derived.observations.length,
        written: derived.written.length,
      });
    } catch {
      // A detector failing must never cost a user the end of their session.
    }
    const alreadyHarvested =
      Number(state.edits || 0) > 0 &&
      Number(state.harvestedEdits || 0) >= Number(state.edits || 0);
    const prompt =
      features.harvest && toolEvidence.names.has('wiki_write')
        ? semanticHarvestPrompt({
            edits: state.edits,
            files: state.editedFiles,
            model: raw.model,
            stopHookActive:
              raw.stop_hook_active === true ||
              raw.stopHookActive === true ||
              alreadyHarvested ||
              (clientName === 'cursor' && Number(raw.loop_count || 0) > 0),
          })
        : null;
    if (prompt) {
      state.harvestedEdits = Number(state.edits || 0);
      saveState(sessionId, state, agentScope);
    }
    // THE OUT-OF-BAND HARVEST, which no client was running.
    //
    // The in-band `prompt` above asks the MODEL to call `wiki_write`, and the
    // session pays for summarising itself -- the exact cost the design says the
    // harvest exists to avoid ("out-of-band, so the session doing the work never
    // pays for the harvest"). The out-of-band half lived in a Claude Code hook
    // that #300 unregistered, and nothing replaced it, so on every client the
    // transcript was never archived, the worker never spawned, refusals were
    // never detected, and the notice explaining why no findings exist was never
    // shown. Awaited because it must finish before the exit below; it spawns a
    // DETACHED worker and returns immediately, so Stop is not delayed by a model
    // call.
    let harvestNotice = null;
    try {
      // NORMALIZED, NOT RAW. The identifiers were resolved a few lines up
      // through every alias a host might use -- `sessionId`,
      // `conversation_id`, `working_directory` -- and handing `raw` straight
      // over threw that away: runStopHarvest reads `session_id` and `cwd`
      // only, so on a client that sends an alias the session id came back
      // undefined and the archive root fell back to `process.cwd()`. That
      // shares the once-per-session notice and the debounce marker across
      // every session, and files the transcript under whatever directory the
      // hook happened to start in.
      harvestNotice = await runStopHarvest({
        ...raw,
        session_id: sessionId,
        cwd,
        transcript_path: raw.transcript_path ?? raw.transcriptPath ?? null,
      });
    } catch {
      // The harvest is a side effect of ending a session. It must never stop
      // one from ending.
    }

    if (prompt && client.stopStyle === 'followup') {
      emit({ followup_message: prompt, ...(harvestNotice ? { systemMessage: harvestNotice } : {}) });
    } else {
      emit({
        ...(prompt ? { decision: client.stopDecision, reason: prompt } : {}),
        ...(harvestNotice ? { systemMessage: harvestNotice } : {}),
      });
    }
    process.exit(0);
  }

  if (
    clientName === 'cline' &&
    event === 'post-tool' &&
    raw.postToolUse?.success === false
  )
    process.exit(0);
  const payload = normalizePayload(
    normalizeClientPayload(clientName, event, raw)
  );
  invocation.bind(raw, payload, input.bytes);
  if (!payload.tool_name) process.exit(0);
  const episode = episodeMeta({ client: clientName, raw, payload });

  // THE AGENT, not just the session -- the same scope the Claude Code router
  // applies. Subagents inherit the parent's session id, so keying state on the
  // session alone lets one agent's reads silence another's: the router's comment
  // records it observed live, an agent refusing a file it had never opened
  // because a sibling had read it. That fix was never carried across to the four
  // clients this adapter serves. `transcript_path` is per agent; absent, this
  // falls back to session scope, which is right for a main session's own calls.
  const agentScope = payload.transcript_path || null;
  const state = loadState(payload.session_id, agentScope);
  const toolEvidence = optimizerToolsForHook(raw, state);
  rememberOptimizerTools(state, toolEvidence);
  let recordingContext = null;

  // Count mutations AFTER Codex reports them, not in PreToolUse where a denied
  // or failed apply_patch has not changed anything. Codex carries an
  // apply_patch body under tool_input.command, so recover the file headers from
  // that body when there is no ordinary file_path field.
  if (
    event === 'post-tool' &&
    isSubstantive(payload.tool_name) &&
    mutationSucceeded(clientName, raw)
  ) {
    try {
      const edited = [];
      if (payload.tool_input.file_path)
        edited.push(payload.tool_input.file_path);
      const patch = payload.tool_input.command;
      if (typeof patch === 'string') {
        for (const match of patch.matchAll(
          /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm
        )) {
          const candidate = match[1].trim().replace(/^['"]|['"]$/g, '');
          if (candidate)
            edited.push(resolve(payload.cwd || process.cwd(), candidate));
        }
      }

      state.edits = (state.edits || 0) + 1;
      state.editedFiles = [...edited, ...(state.editedFiles || [])]
        .filter(Boolean)
        .slice(0, 20);
      const anchor =
        state.editedFiles[0] ||
        join(payload.cwd || process.cwd(), '__recording__');
      const dir = wikiDir(projectRootFor(anchor, payload.cwd));
      recordingContext =
        features.harvest && toolEvidence.names.has('wiki_write')
          ? recordingNudge(dir, {
              state,
              edits: state.edits,
              files: state.editedFiles,
            })
          : null;
      if (recordingContext) state.recordingNudged = true;
    } catch {
      // Recording pressure is an optimization and must never cost a tool call.
    }
  }
  if (event === 'post-tool') {
    try {
      const command = payload.tool_input?.command;
      const touched = touchedFiles(payload);
      const anchor = command
        ? String(command).slice(0, 120)
        : touched[0]?.path || payload.tool_input?.file_path || '';
      const root = command
        ? commandProjectRoot(payload, payload.cwd)
        : projectRootFor(
            anchor || join(payload.cwd || process.cwd(), '__tool__'),
            payload.cwd
          );
      recordToolOutcome(wikiDir(root), {
        ...episode,
        surface: command ? 'command' : 'file',
        anchor,
        toolName: payload.tool_name,
        success: toolSucceeded(raw),
        // The two fields a boolean cannot carry: which KIND of failure this
        // was. Read through the same normalisers as `success`, never off `raw`
        // at this call site.
        output: outputFrom(raw),
        exit: exitFrom(raw),
        durationMs:
          Number(
            raw.duration_ms ?? raw.durationMs ?? raw.elapsed_ms ?? raw.elapsedMs
          ) || null,
        ...usageFrom(raw),
      });
    } catch {
      // Causal tracing is fail-open like every other hook optimization.
    }

    // EAGER INVALIDATION, finally connected. `invalidateOnWrite` has existed,
    // been tested and been described in staleness.mjs's own header since
    // staleness landed, and its only reference in shipped code was a COMMENT in
    // the PreToolUse router -- so the path that header calls load-bearing had
    // never run once in production. It matters most for exactly this event: the
    // lazy check compares the anchor's stored hash against disk, and the
    // capture below re-points that hash at the bytes this write just produced,
    // so a write the session performed ITSELF is invisible to lazy staleness.
    //
    // QUEUED, NOT APPLIED. Applying needs the graph, and loading a megabyte of
    // JSONL on the return path of every write is what this shape exists to
    // avoid. The next graph read drains it before serving anything.
    try {
      if (mutationSucceeded(clientName, raw)) {
        for (const evidence of observedWrites(payload, raw)) {
          // THE SAME DIRECTORY THE GRAPH ITSELF USES. `observeAndInject` keys
          // every write on `wikiDir(projectRootFor(path, payload.cwd))`, and a
          // queue written anywhere else is a queue nothing ever drains.
          queueInvalidation(
            wikiDir(projectRootFor(evidence.path, payload.cwd)),
            evidence
          );
        }
      }
    } catch {
      // Bookkeeping for a call that already completed. Never let it cost one.
    }
  }

  const ucrGuardVerdict =
    event === 'pre-tool'
      ? evaluateUcrGuards(
          payload,
          touchedFiles(payload).map((item) => item.path)
        )
      : null;
  const verdict =
    ucrGuardVerdict ||
    (features.routing ? decide(payload, state, toolEvidence.names) : null);
  const repeat =
    verdict && event === 'pre-tool' && !verdict.persistent
      ? alreadyDenied(state, verdict.key)
      : false;

  // A post-tool hook has already paid for the call, so a denial would cost a
  // turn and save nothing. It advises about the NEXT one instead.
  const canRefuse = Boolean(
    verdict &&
      client.canDeny &&
      event === 'pre-tool' &&
      !repeat &&
      mode() !== MODE_ADVISE &&
      // Codex code mode presents orchestration as one outer `functions.exec`.
      // Refuse only when it contains one shell call; a multi-operation envelope
      // can include unrelated safe work that must not be discarded wholesale.
      !(
        clientName === 'codex' &&
        payload.tool_input?.code_mode_envelope &&
        !payload.tool_input?.code_mode_single_shell_command
      )
  );

  if (canRefuse) {
    remember(payload, state);
    saveState(payload.session_id, state, agentScope);
    // Every client's refusal carries the off switch, for the same reason Claude
    // Code's does: enforcement that hides its own disable is coercive.
    if (client.denyStyle === 'top-level') {
      invocation.block('policy_denied');
      emit({ decision: 'deny', reason: withEscape(verdict.reason) });
    } else if (client.denyStyle === 'top-level-permission') {
      invocation.block('policy_denied');
      emit({
        permissionDecision: 'deny',
        permissionDecisionReason: withEscape(verdict.reason),
      });
    } else if (client.denyStyle === 'cline') {
      invocation.block('policy_denied');
      emit({
        cancel: true,
        contextModification: '',
        errorMessage: withEscape(verdict.reason),
      });
    } else if (client.denyStyle === 'cursor') {
      invocation.block('policy_denied');
      emit({
        continue: true,
        permission: 'deny',
        agent_message: withEscape(verdict.reason),
        user_message:
          'Token Optimizer redirected an expensive built-in operation.',
      });
    } else if (client.denyStyle === 'exit-2') {
      invocation.block('policy_denied');
      process.stderr.write(withEscape(verdict.reason));
      process.exit(2);
    } else {
      invocation.block('policy_denied');
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
    graphContext = observeAndInject(payload, state, episode, features);
  } catch {
    // Delivery is an optimization. Fail open.
  }
  saveState(payload.session_id, state, agentScope);

  const context = [verdict?.reason, graphContext, recordingContext]
    .filter(Boolean)
    .join('\n\n');
  if (context) {
    const output = contextOutput(client, eventName, context);
    if (output) emit(output);
  }
  process.exit(0);
}
