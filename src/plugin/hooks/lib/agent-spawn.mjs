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
 *   - it tells the parent what a large fork or a batch of agents costs, and in
 *     enforce mode refuses a large fork with the cheaper alternative named.
 *
 * Every function here is pure or reads a bounded tail; the hook fails open.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';

/** A fork larger than this is worth a sentence before it is copied. */
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
 * The parent's context as of its latest request, and how many Agent/Task calls
 * the assistant message carrying `toolUseId` makes -- the batch being spawned.
 */
export function parentState(transcriptPath, toolUseId) {
  const entries = lines(tail(transcriptPath));
  let contextTokens = 0;
  let batch = 1;
  let first = true;
  for (const entry of entries) {
    const message = entry?.message;
    if (entry?.type !== 'assistant' || !message) continue;
    const usage = message.usage;
    if (usage) {
      contextTokens =
        (Number(usage.input_tokens) || 0) +
        (Number(usage.cache_read_input_tokens) || 0) +
        (Number(usage.cache_creation_input_tokens) || 0);
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
  return { contextTokens, batch, first };
}

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
  if (input.subagent_type === 'fork') return null;
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
 * @param {string} args.mode         assist | advise | enforce
 * @returns {{ updatedInput: object|null, context: string|null, deny: string|null }}
 */
export function planSpawn({ input, contextTokens = 0, batch = 1, first = true, agentBase = DEFAULT_AGENT_BASE, mode = 'assist', env = process.env }) {
  const updatedInput = withReportBudget(input, env);
  const notes = [];
  let deny = null;

  if (input?.subagent_type === 'fork' && contextTokens >= FORK_ADVISE_TOKENS) {
    const copied = contextTokens * Math.max(1, batch);
    const fresh = agentBase * Math.max(1, batch);
    const line =
      `${batch > 1 ? `${batch} forks copy` : 'This fork copies'} the whole conversation: ~${k(copied)} tokens of context ` +
      `before any work, re-read on every turn of each fork. A fresh agent starts from ~${k(agentBase)}` +
      `${batch > 1 ? ` (~${k(fresh)} for ${batch})` : ''}; give it the files and facts it needs in its prompt instead.`;
    if (mode === 'enforce') deny = `${line} Retry with a non-fork subagent_type and a self-contained prompt.`;
    else if (first) notes.push(line);
  } else if (batch >= BATCH_ADVISE && first) {
    notes.push(
      `${batch} agents each start from ~${k(agentBase)} tokens of fixed context (~${k(agentBase * batch)} together) ` +
        'and re-read it every turn. That pays for independent work that runs in parallel; for steps that depend ' +
        'on each other, or a handful of reads, doing it directly is cheaper.'
    );
  }

  return { updatedInput, context: notes.length ? `token-optimizer: ${notes.join(' ')}` : null, deny };
}
