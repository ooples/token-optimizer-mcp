// GENERATED FILE -- do not edit.
// Source of truth: src/hooks-core/agent-spawn.mjs. Regenerate with `npm run sync:hooks`.
/**
 * What spawning an agent will cost, said before it happens (#567).
 *
 * Three costs of an agent are fixed the moment it is spawned, and the parent
 * decides all three without ever seeing a number:
 *
 *   STARTING CONTEXT  every agent begins with the system prompt, tools,
 *                     instructions and memory -- 35-61k tokens measured on real
 *                     agents -- before it does any work, and re-reads it each turn.
 *   FORKS             a fork inherits the parent's whole conversation. Forking a
 *                     150k-token session three times is 450k tokens of context
 *                     before any of them starts.
 *   THE REPORT        an agent's final result enters the parent's context and is
 *                     re-read on every later parent turn. 29 of 113 measured
 *                     results exceeded 4,000 characters, up to 8,160 -- and they
 *                     arrive as task notifications, where no PostToolUse hook can
 *                     trim them. The only point at which they can be shaped is
 *                     the prompt, before the agent starts.
 *
 * So this runs at PreToolUse on Agent/Task:
 *   - it asks the agent for a short report, with detail written to a file
 *     (the report budget), by appending to the agent's prompt;
 *   - it tells the parent what a batch of agents costs, and refuses a large
 *     fork with the cheaper alternative named (TOKEN_OPTIMIZER_FORK_GUARD=off
 *     to advise instead);
 *   - it starts agents in the foreground (TOKEN_OPTIMIZER_AGENT_FOREGROUND=off
 *     to leave them in the background).
 *
 * Every function here is pure or reads a bounded tail; the hook fails open.
 */

import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isWorkerType, routeToWorker } from './agent-brief.mjs';

/** Spawns closer together than this are one batch. */
export const BURST_GAP_MS = 5_000;

/**
 * WHY A RECORD AND NOT THE TRANSCRIPT. Claude Code runs each Agent call's
 * PreToolUse hook before that call reaches the transcript, so a hook reading
 * the transcript never sees its siblings: every call of a 12-agent batch read
 * as a batch of one and as its first, the routing note was said 11 times into
 * the parent's context (measured on #567's bench), and the batch-cost note
 * never fired at all. The record is per session and keeps two facts: how many
 * spawns the current burst has had, and whether the routing note was said.
 */
function spawnStatePath(sessionId, env) {
  const key = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16);
  return join(env.TOKEN_OPTIMIZER_STATE_DIR || join(tmpdir(), 'token-optimizer-hooks'), 'agent-spawn', `${key}.json`);
}

/** Which burst a new agent call joins, given the previous record. Pure. */
export function nextSpawnState(prev, now) {
  const last = Number(prev?.lastAt) || 0;
  const burst = last && now - last >= 0 && now - last < BURST_GAP_MS ? (Number(prev?.burst) || 0) + 1 : 1;
  return { lastAt: now, burst, routedNoted: Boolean(prev?.routedNoted) };
}

/** Count this spawn into the session's record; null without a session id or on any failure. */
export function recordSpawn(sessionId, { now = Date.now(), env = process.env } = {}) {
  if (!sessionId) return null;
  try {
    const path = spawnStatePath(sessionId, env);
    let prev = null;
    try {
      prev = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      /* the session's first spawn */
    }
    const next = nextSpawnState(prev, now);
    saveSpawnState(sessionId, next, env);
    return next;
  } catch {
    return null;
  }
}

/** Write the record atomically, so concurrent hooks never read a torn file. */
export function saveSpawnState(sessionId, state, env = process.env) {
  const path = spawnStatePath(sessionId, env);
  mkdirSync(join(path, '..'), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(state));
  renameSync(temporary, path);
}

/** Whether a large fork is refused rather than advised on (TOKEN_OPTIMIZER_FORK_GUARD=off to advise). */
export function forkGuard(env = process.env) {
  return !/^(0|false|no|off)$/i.test(String(env.TOKEN_OPTIMIZER_FORK_GUARD || '').trim());
}

/** A fork larger than this is refused before it is copied (advised on with the guard off). */
export const FORK_ADVISE_TOKENS = 60_000;
/** A batch at least this large is worth a sentence before it is spawned. */
export const BATCH_ADVISE = 3;
/** What a fresh agent starts from when the ledger has no measurement yet. */
export const DEFAULT_AGENT_BASE = 40_000;
/** The marker that keeps the report budget from being appended twice. */
export const BUDGET_MARKER = '[token-optimizer report budget]';

const TAIL_BYTES = 2_000_000;

function tail(path, maxBytes = TAIL_BYTES) {
  if (!path) return '';
  try {
    const size = statSync(path).size;
    const handle = openSync(path, 'r');
    try {
      const want = Math.min(size, maxBytes);
      const buffer = Buffer.allocUnsafe(want);
      const got = readSync(handle, buffer, 0, want, size - want);
      return buffer.toString('utf8', 0, got);
    } finally {
      closeSync(handle);
    }
  } catch {
    return '';
  }
}

function lines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a cut first line */
    }
  }
  return out;
}

/**
 * Price tiers, cheapest first. A model outside them -- one this file does not
 * know the price of -- is never routed from or to.
 */
export const MODEL_TIERS = ['haiku', 'sonnet', 'opus'];
/** The worker's model when the parent runs a dearer one. */
export const DEFAULT_WORKER_MODEL = 'haiku';

/** The tier of a model id or alias (`claude-opus-5-5`, `sonnet`), or -1. */
export function modelTier(model) {
  const id = String(model || '').toLowerCase();
  return MODEL_TIERS.findIndex((tier) => id.includes(tier));
}

/**
 * The model a routed worker runs on, or null to leave it on the parent's.
 *
 * WHY. Measured on #567's bench, agents cost 2.8x solo on a twelve-file task
 * even with every fixed-context saving applied: the parent's orchestration alone
 * costs about what solo does for the whole job, because solo batches its tool
 * calls and finishes in a handful of turns. No context diet closes that. A
 * delegated sub-task with an approved brief and a self-contained prompt does
 * not need the parent's model, and a cheaper tier is the one lever left.
 *
 * Only a routed worker, only when the caller named no model, only to a cheaper
 * tier than the parent's, and never when the parent's model is unknown.
 * TOKEN_OPTIMIZER_WORKER_MODEL picks the model; `inherit` (or off) disables it.
 */
export function workerModel({ input, routed, parentModel, env = process.env }) {
  if (!routed || !input || input.model) return null;
  // `inherit`, `off` and any other non-tier value are tier -1, and so is an
  // unknown parent model -- which no tier is below.
  // An empty value is unset, as everywhere else in this package's switches.
  const want = modelTier(env.TOKEN_OPTIMIZER_WORKER_MODEL || DEFAULT_WORKER_MODEL);
  const parent = modelTier(parentModel);
  if (want < 0 || want >= parent) return null;
  return MODEL_TIERS[want];
}

/**
 * The spawn with `run_in_background: false`, or null to leave it alone.
 *
 * WHY. Claude Code starts agents in the background unless told otherwise, and
 * every background agent costs its parent a launch receipt (~270 tokens) and a
 * completion notice (~250), each written into the parent's context at its
 * cache tier and re-read on every later turn -- and, when the notices arrive
 * apart, a parent turn per notice re-reading the whole context: 9 extra turns
 * of ~45k in one measured run (#567). In the foreground, a batch spawned in one
 * message still runs concurrently and returns every result in one turn.
 *
 * MEASURED (bench/agents agents-opt-fg, Sonnet parent, large task, 3/3
 * correct each): median $0.202 against $0.243 in the background (0.831x) and
 * $0.274 solo (0.736x); the parent fell from ~107-166k to ~87-91k weighted.
 * On by default; TOKEN_OPTIMIZER_AGENT_FOREGROUND=off restores the background
 * for a parent that wants to keep working while an agent runs. Never over an
 * explicit choice, and never for a fork.
 */
export function inForeground(input, env = process.env) {
  if (/^(0|false|no|off)$/i.test(String(env.TOKEN_OPTIMIZER_AGENT_FOREGROUND || '').trim())) return null;
  if (!input || typeof input !== 'object' || input.subagent_type === 'fork') return null;
  if (input.run_in_background !== undefined) return null;
  return { ...input, run_in_background: false };
}

/** At most this many paths go into the shared briefing. */
export const DIGEST_MAX_PATHS = 20;
/** The marker that keeps the shared briefing from being appended twice. */
export const DIGEST_MARKER = '[token-optimizer shared briefing]';

const PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const LISTING_TOOLS = new Set(['Glob', 'Grep']);

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n');
}

/** A line of Glob or Grep (files mode) output that names one file, or null. */
function listedPath(line) {
  const s = line.trim();
  if (!s || s.length > 300 || /^(found|no files|showing|\.\.\.|\[)/i.test(s)) return null;
  // A drive letter is the only colon a path may carry; anything else is a
  // content-mode match ("path:12:text") or prose.
  if (s.replace(/^[A-Za-z]:/, '').includes(':')) return null;
  return /[\\/]/.test(s) || /\.[A-Za-z0-9]{1,8}$/.test(s) ? s : null;
}

/**
 * The files the parent has already found relevant -- read, edited, or listed
 * by its Glob and Grep calls -- most recent first. What an agent most often
 * spends its first turns re-deriving is WHERE to look: the same searches the
 * parent already ran. Contents are not passed on, only the locations.
 */
export function parentFindings(entries) {
  const listing = new Set();
  const found = [];
  for (const entry of entries) {
    const content = Array.isArray(entry?.message?.content) ? entry.message.content : [];
    for (const b of content) {
      if (entry.type === 'assistant' && b?.type === 'tool_use') {
        if (PATH_TOOLS.has(b.name)) {
          const p = b.input?.file_path ?? b.input?.notebook_path;
          if (typeof p === 'string' && p) found.push(p);
        } else if (LISTING_TOOLS.has(b.name) && (b.name === 'Glob' || !b.input?.output_mode || b.input.output_mode === 'files_with_matches')) {
          listing.add(b.id);
        }
      } else if (entry.type === 'user' && b?.type === 'tool_result' && listing.has(b.tool_use_id) && !b.is_error) {
        for (const line of resultText(b.content).split('\n')) {
          const p = listedPath(line);
          if (p) found.push(p);
        }
      }
    }
  }
  const seen = new Set();
  const out = [];
  for (let i = found.length - 1; i >= 0; i--) {
    const key = found[i].replace(/\\/g, '/').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(found[i]);
  }
  return out;
}

/**
 * The shared briefing, appended to the agent's prompt once: where the parent
 * already looked, minus what the prompt names already. Paths under `cwd` are
 * given relative to it. Off with TOKEN_OPTIMIZER_AGENT_DIGEST=off; never for a
 * fork, which has the parent's whole conversation.
 */
export function withSharedBriefing(input, found, { cwd = process.cwd(), env = process.env } = {}) {
  if (/^(off|0|false|no)$/i.test(String(env.TOKEN_OPTIMIZER_AGENT_DIGEST || '').trim())) return null;
  if (!input || typeof input.prompt !== 'string' || !input.prompt.trim()) return null;
  if (input.subagent_type === 'fork' || input.prompt.includes(DIGEST_MARKER)) return null;
  const root = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '');
  const prompt = input.prompt.replace(/\\/g, '/').toLowerCase();
  const paths = [];
  for (const p of found || []) {
    const norm = p.replace(/\\/g, '/');
    const short = root && norm.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? norm.slice(root.length + 1) : norm;
    if (prompt.includes(short.toLowerCase())) continue;
    paths.push(short);
    if (paths.length >= DIGEST_MAX_PATHS) break;
  }
  if (!paths.length) return null;
  const briefing =
    `\n\n${DIGEST_MARKER} Files the agent that started you has already found relevant (it read, edited or listed them), ` +
    `most recent first: ${paths.join(', ')}. Their contents are not in your context; start from these rather than searching the tree again.`;
  return { ...input, prompt: `${input.prompt}${briefing}` };
}

/**
 * The parent's context as of its latest request, how many Agent/Task calls
 * the assistant message carrying `toolUseId` makes -- the batch being spawned --
 * and the files it has already found relevant.
 */
export function parentState(transcriptPath, toolUseId) {
  const entries = lines(tail(transcriptPath));
  let contextTokens = 0;
  let batch = 1;
  let first = true;
  let model = null;
  // The last recorded usage is the context of the PREVIOUS request: what was
  // added since -- that request's output and the tool results that came back --
  // is in the request carrying this spawn but in no usage yet. Measured: a
  // parent read 12 files and forked 12 times; every hook saw ~31k of a real
  // ~76k, so the fork guard's 60k threshold let 11 of the 12 forks through.
  let usageId = null;
  let pending = 0;
  for (const entry of entries) {
    const message = entry?.message;
    if (entry?.type === 'user' && message) {
      pending += estimateTokens(typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''));
      continue;
    }
    if (entry?.type !== 'assistant' || !message) continue;
    // `<synthetic>` marks harness-made messages, not the parent's model.
    if (typeof message.model === 'string' && message.model && !message.model.startsWith('<')) model = message.model;
    const usage = message.usage;
    if (usage) {
      contextTokens =
        (Number(usage.input_tokens) || 0) +
        (Number(usage.cache_read_input_tokens) || 0) +
        (Number(usage.cache_creation_input_tokens) || 0) +
        (Number(usage.output_tokens) || 0);
      // A message streamed as several entries repeats its usage on each; the
      // results interleaved between them still count.
      if (message.id !== usageId || !message.id) pending = 0;
      usageId = message.id ?? null;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    if (toolUseId && content.some((b) => b?.type === 'tool_use' && b.id === toolUseId)) {
      // A message streamed as several entries carries one block per entry, so
      // the batch is counted over every entry of the same message id.
      const sameMessage = entries.filter((e) => e?.type === 'assistant' && e?.message?.id && e.message.id === message.id);
      const calls = [];
      for (const e of sameMessage.length ? sameMessage : [entry]) {
        for (const b of e.message.content || []) {
          if (b?.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task') && !calls.includes(b.id)) calls.push(b.id);
        }
      }
      batch = Math.max(1, calls.length);
      // Every call of a batch runs this hook; only the first speaks for it.
      first = !calls.length || calls[0] === toolUseId;
    }
  }
  return { contextTokens: contextTokens + pending, batch, first, found: parentFindings(entries), model };
}

/**
 * Characters per token for what comes back into the parent: mostly tool
 * results, mostly code. Measured on a parent's 12 file reads: ~111k chars were
 * 42.8k tokens (2.6 chars/token), so the prose rule of 4 under-counted by 1.5x
 * and the guard saw 61k of a real 76k. 3 errs toward the real size without
 * fitting that one sample.
 */
export const RESULT_CHARS_PER_TOKEN = 3;

const estimateTokens = (text) => Math.ceil(String(text || '').length / RESULT_CHARS_PER_TOKEN);

const k = (n) => `${Math.round(n / 1000)}k`;

/**
 * The report budget, appended to the agent's prompt once.
 *
 * Off with TOKEN_OPTIMIZER_AGENT_REPORT_BUDGET=off. Not applied to a fork: a fork
 * shares the parent's instructions already, and its prompt is a continuation.
 */
export function withReportBudget(input, env = process.env) {
  if (/^(off|0|false|no)$/i.test(String(env.TOKEN_OPTIMIZER_AGENT_REPORT_BUDGET || '').trim())) return null;
  if (!input || typeof input.prompt !== 'string' || !input.prompt.trim()) return null;
  if (input.subagent_type === 'fork' || isWorkerType(input.subagent_type)) return null;
  if (input.prompt.includes(BUDGET_MARKER)) return null;
  const budget =
    `\n\n${BUDGET_MARKER} Your final reply is read by the agent that started you on every one of its later turns, ` +
    'so keep it under about 300 words: the answer or outcome, the files you changed, and anything left unresolved. ' +
    'If the detail is longer than that, write it to a file and give its path instead of pasting it.';
  return { ...input, prompt: `${input.prompt}${budget}` };
}

/**
 * The decision for one Agent/Task call.
 *
 * @param {object} args
 * @param {object} args.input        the tool input
 * @param {number} args.contextTokens the parent's context at its latest request
 * @param {number} args.batch        Agent/Task calls in the same parent message
 * @param {boolean} args.first       whether this is the batch's first call (the one that speaks)
 * @param {number} args.agentBase    median starting context of this machine's agents
 * @param {string} args.cwd          the session's directory, for the project's agent brief
 * @param {number} args.sessionStart when the session started (ms), so only agents it loaded are named
 * @returns {{ updatedInput: object|null, context: string|null, deny: string|null }}
 */
export function planSpawn({ input, contextTokens = 0, batch = 1, first = true, batchSpeaks = null, routedNoted = false, found = [], parentModel = null, agentBase = DEFAULT_AGENT_BASE, env = process.env, cwd = process.cwd(), sessionStart = null }) {
  // A general-purpose agent goes to the lean worker with the user's approved
  // brief when there is one (agent-brief.mjs); the worker's own prompt asks for
  // the short report, so the budget is not appended to it as well.
  const routed = routeToWorker(input, { cwd, env, sessionStart });
  const model = workerModel({ input, routed, parentModel, env });
  const worker = routed && model ? { ...routed, model } : routed;
  const shaped = worker ?? withReportBudget(input, env);
  const briefed = withSharedBriefing(shaped ?? input, found, { cwd, env }) ?? shaped;
  const updatedInput = inForeground(briefed ?? input, env) ?? briefed;
  const notes = [];
  let deny = null;
  // The parent must know what its agent was told: measured live, a parent that
  // was not told read the brief's effect on the reply as the agent disobeying.
  // Once per session: the parent keeps it in context, so a second copy is waste.
  const stronger = model ? ' Pass model explicitly on the Agent call for a sub-task that needs a stronger model.' : '';
  if (routed && !routedNoted && isWorkerType(input?.subagent_type)) {
    // The parent chose the worker itself and knows what it is; only the model is news.
    if (model) notes.push(`${routed.subagent_type} agents run on ${model}.${stronger}`);
  } else if (routed && !routedNoted) {
    notes.push(
      `${batch > 1 ? 'These general-purpose agents run' : 'This general-purpose agent runs'} as ${routed.subagent_type}` +
        `${model ? ` on ${model}` : ''} with the user's approved agent brief (rules from their instruction files) in front of the task, ` +
        `instead of the full instruction files.${stronger}`
    );
  }

  if (input?.subagent_type === 'fork' && contextTokens >= FORK_ADVISE_TOKENS) {
    const copied = contextTokens * Math.max(1, batch);
    const fresh = agentBase * Math.max(1, batch);
    const line =
      `${batch > 1 ? `${batch} forks copy` : 'This fork copies'} the whole conversation: ~${k(copied)} tokens of context ` +
      `before any work, re-read on every turn of each fork. A fresh agent starts from ~${k(agentBase)}` +
      `${batch > 1 ? ` (~${k(fresh)} for ${batch})` : ''}; give it the files and facts it needs in its prompt instead.`;
    // Refused in assist as well as enforce: advice reaches the parent only after
    // the batch it was about has started. Measured on 12 forks of a ~76k parent
    // (bench/agents forks-opt-enforce, 3/3 correct each): $0.46 refused against
    // $2.44 advised. TOKEN_OPTIMIZER_FORK_GUARD=off keeps it to advice.
    if (forkGuard(env)) deny = `${line} Retry with a non-fork subagent_type and a self-contained prompt.`;
    else if (first) notes.push(line);
  } else if (batch >= BATCH_ADVISE && (batchSpeaks ?? first)) {
    notes.push(
      `${batchSpeaks === null ? '' : 'At least '}${batch} agents each start from ~${k(agentBase)} tokens of fixed context ` +
        `(~${k(agentBase * batch)}${batchSpeaks === null ? '' : ' or more'} together) ` +
        'and re-read it every turn. That pays for independent work that runs in parallel; for steps that depend ' +
        'on each other, or a handful of reads, doing it directly is cheaper.'
    );
  }

  return { updatedInput, context: notes.length ? `token-optimizer: ${notes.join(' ')}` : null, deny, routedNote: Boolean(routed && !routedNoted) };
}
