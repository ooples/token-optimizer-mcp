// GENERATED FILE -- do not edit.
// Source of truth: src/hooks-core/subagents.mjs. Regenerate with `npm run sync:hooks`.
/**
 * What each subagent of a session cost, and how much of it was fixed context.
 *
 * THE COST NOBODY WAS MEASURING. A multi-agent run on 2026-10-20 spent 4.09M
 * tokens across nine subagents and 62 turns, and token_audit reported about 2.9k
 * tokens of waste -- two re-read files. The split, from the agents' own usage
 * records:
 *
 *   cache reads     3.60M  88%   every agent started at ~56k tokens of fixed
 *                                context (memory index, deferred-tool names --
 *                                ~250 of them from one unused plugin -- MCP
 *                                instructions, system prompt) and re-read all of
 *                                it on every turn
 *   cache writes    0.49M  12%
 *   tool output     ~38k    1%   the only part smart_read/smart_grep can shrink
 *   model output      4k
 *
 * So the lever was the baseline times the turn count, and nothing in the product
 * could see either. This reads the subagent transcripts Claude Code writes beside
 * the session (`<session>/subagents/**\/agent-*.jsonl`) and reports, per agent:
 * turns, the context its first turn carried, cache reads and writes, output, and
 * tool output -- plus the largest blocks of the fixed context, read from the
 * agent's first request, so the report can say WHAT to remove.
 *
 * Reads local files only, bounded per file, and never throws: a transcript it
 * cannot read is simply absent from the report.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_AGENTS = 200;
const MAX_REQUESTS = 20_000;
const charsToTokens = (chars) => Math.round(chars / 4);

/** Prompt-cache prices relative to one uncached input token. */
export const CACHE_PRICE = Object.freeze({ write5m: 1.25, write1h: 2, read: 0.1 });
export const TTL_SECONDS = Object.freeze({ '5m': 300, '1h': 3600 });

/** The subagent transcripts of the session whose transcript is `sessionTranscript`. */
export function subagentTranscripts(sessionTranscript) {
  if (!sessionTranscript) return [];
  const root = join(dirname(sessionTranscript), basename(sessionTranscript, '.jsonl'), 'subagents');
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4 || found.length >= MAX_AGENTS) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/^agent-.*\.jsonl$/.test(entry.name)) found.push(full);
      if (found.length >= MAX_AGENTS) return;
    }
  };
  if (existsSync(root)) walk(root, 0);
  return found;
}

function readBounded(path) {
  const size = statSync(path).size;
  if (size <= MAX_FILE_BYTES) return readFileSync(path, 'utf8');
  const handle = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES);
    const got = readSync(handle, buffer, 0, MAX_FILE_BYTES, 0);
    return buffer.toString('utf8', 0, got);
  } finally {
    closeSync(handle);
  }
}

function labelFor(path) {
  try {
    const meta = JSON.parse(readFileSync(path.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    return { label: String(meta.description || meta.label || basename(path, '.jsonl')), model: meta.model ?? null };
  } catch {
    return { label: basename(path, '.jsonl'), model: null };
  }
}

/** A short name for a block of fixed context, from its first meaningful line. */
function blockLabel(text) {
  const contents = /Contents of ([^\s(]+)/.exec(text);
  if (contents) return `memory/instructions file ${basename(contents[1])}`;
  if (/deferred tools are now available|tools just became available/i.test(text)) return 'deferred-tool names and MCP instructions';
  const first = text.replace(/<[^>]+>/g, ' ').trim().split('\n').find((line) => line.trim()) || '';
  return first.trim().slice(0, 70);
}

/**
 * One agent's usage, from its transcript text.
 *
 * Usage is counted once per assistant MESSAGE id: a message streamed as several
 * transcript entries repeats the same usage on each.
 */
export function tallyTranscript(text) {
  const seen = new Set();
  const out = {
    turns: 0,
    baseContext: 0,
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
    toolOutput: 0,
    fixedBlocks: [],
    // Cache writes by TTL tier, from usage.cache_creation. Claude Code writes the
    // main thread at 1h and everything else -- subagents included -- at 5m
    // unless `subagentPromptCacheTtl` says otherwise.
    write5m: 0,
    write1h: 0,
    // One entry per request, for the TTL replay: when it was sent, how much of
    // the prompt was cacheable, and how much was not.
    requests: [],
  };
  let sawAssistant = false;
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('{')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry.message || {};
    const content = Array.isArray(message.content) ? message.content : [];

    // The first request's text blocks ARE the fixed context, minus the system
    // prompt, which the transcript does not hold.
    if (!sawAssistant && entry.type === 'api-request-blob') {
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.length >= 8_000) {
          out.fixedBlocks.push({ label: blockLabel(part.text), tokens: charsToTokens(part.text.length) });
        }
      }
    }
    if (entry.type === 'user') {
      for (const part of content) {
        if (part?.type === 'tool_result') out.toolOutput += charsToTokens(JSON.stringify(part.content ?? '').length);
      }
    }
    const usage = message.usage;
    if (entry.type !== 'assistant' || !usage) continue;
    sawAssistant = true;
    const id = message.id || `${out.turns}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.turns += 1;
    const read = Number(usage.cache_read_input_tokens) || 0;
    const write = Number(usage.cache_creation_input_tokens) || 0;
    const input = Number(usage.input_tokens) || 0;
    if (out.turns === 1) out.baseContext = read + write + input;
    out.cacheRead += read;
    out.cacheWrite += write;
    out.input += input;
    out.output += Number(usage.output_tokens) || 0;
    const tiers = usage.cache_creation || {};
    const w1h = Number(tiers.ephemeral_1h_input_tokens) || 0;
    // A record without the tier split is a 5m write: that is the default tier.
    out.write1h += w1h;
    out.write5m += Number(tiers.ephemeral_5m_input_tokens) || (w1h ? 0 : write);
    const at = Date.parse(entry.timestamp);
    if (out.requests.length < MAX_REQUESTS && Number.isFinite(at)) {
      out.requests.push({ at, cached: read + write, read, input });
    }
  }
  out.fixedBlocks.sort((a, b) => b.tokens - a.tokens);
  return out;
}

/** One agent transcript file, tallied; null when it cannot be read. */
export function tallyFile(path) {
  try {
    return tallyTranscript(readBounded(path));
  } catch {
    return null;
  }
}

/**
 * The transcript of one subagent, from a SubagentStop payload: the path Claude
 * Code names when it names one, otherwise `agent-<agent_id>.jsonl` under the
 * session's subagents directory.
 */
export function agentTranscriptFor(payload) {
  const direct = payload?.agent_transcript_path ?? payload?.agentTranscriptPath;
  if (direct && existsSync(direct)) return direct;
  const agentId = payload?.agent_id ?? payload?.agentId;
  const session = payload?.transcript_path ?? payload?.transcriptPath;
  if (!agentId || !session) return null;
  return subagentTranscripts(session).find((p) => basename(p) === `agent-${agentId}.jsonl`) || null;
}

/** Every subagent of the session, tallied, most expensive first. */
export function subagentTally(sessionTranscript) {
  const agents = [];
  for (const path of subagentTranscripts(sessionTranscript)) {
    try {
      const tally = tallyTranscript(readBounded(path));
      if (!tally.turns) continue;
      agents.push({ ...labelFor(path), path, ...tally });
    } catch {
      /* unreadable: absent from the report */
    }
  }
  return agents.sort((a, b) => b.cacheRead + b.cacheWrite - (a.cacheRead + a.cacheWrite));
}

/**
 * The audit finding: fixed context re-read on every turn of every subagent.
 *
 * Priced as `baseContext x (turns - 1)` per agent -- the re-reads of what the
 * first turn already carried -- which is the part a smaller baseline or fewer
 * turns would remove. Null when there are no subagents or the cost is trivial.
 */
export function fixedContextFinding(agents, { minTokens = 50_000 } = {}) {
  if (!agents?.length) return null;
  const reread = agents.reduce((sum, a) => sum + a.baseContext * Math.max(0, a.turns - 1), 0);
  if (reread < minTokens) return null;
  const turns = agents.reduce((sum, a) => sum + a.turns, 0);
  const avgBase = Math.round(agents.reduce((sum, a) => sum + a.baseContext, 0) / agents.length);
  const total = agents.reduce((sum, a) => sum + a.cacheRead + a.cacheWrite + a.input + a.output, 0);
  const toolOutput = agents.reduce((sum, a) => sum + a.toolOutput, 0);

  // The blocks common to the agents, by the first agent that recorded any.
  const blocks = (agents.find((a) => a.fixedBlocks.length)?.fixedBlocks || []).slice(0, 3);
  const what = blocks.length
    ? ` Largest fixed blocks: ${blocks.map((b) => `${b.label} ~${b.tokens.toLocaleString()}`).join('; ')}.`
    : '';
  return {
    id: 'subagent-fixed-context',
    title:
      `${agents.length} subagents started at ~${avgBase.toLocaleString()} tokens of fixed context and re-read it ` +
      `on each of ${turns} turns: ${reread.toLocaleString()} of ${total.toLocaleString()} tokens ` +
      `(tool output was ${toolOutput.toLocaleString()}).${what} ` +
      'Disable plugins and MCP servers the task does not use, trim always-loaded memory/instructions, ' +
      'and batch commands so agents take fewer turns.',
    costPerSession: reread,
    // The decline key: one finding per machine, not per agent or per run.
    file: 'subagents',
    remedy: null,
  };
}

/**
 * What one agent's requests would cost under a cache TTL tier, in uncached-input
 * token equivalents (output excluded: the tier does not change it).
 *
 * Replays the recorded prompts: when the gap since the previous request exceeds
 * the TTL, or the cached part shrank (the prefix changed), the whole cacheable
 * prompt is written again; otherwise only its growth is written and the rest is
 * read. This is a model of the provider's cache, not a record of it -- it assumes
 * the prefix is otherwise stable, which the recorded reads confirm for the
 * common case. Checked against real subagent transcripts: the 5m replay landed
 * within 8% of the recorded weighted cost of 37 agents.
 */
export function replayTtl(requests, tier) {
  const ttl = TTL_SECONDS[tier] * 1000;
  // No tier expires this soon, so a request this close to the previous one
  // was read or written for a reason that holds at every tier.
  const observed = TTL_SECONDS['5m'] * 1000;
  const writePrice = tier === '1h' ? CACHE_PRICE.write1h : CACHE_PRICE.write5m;
  let cost = 0;
  let prev = null;
  for (const request of requests || []) {
    const gap = prev ? request.at - prev.at : Infinity;
    const expired = !prev || gap > ttl || request.cached < prev.cached;
    if (expired) {
      cost += writePrice * request.cached;
    } else if (gap <= observed && Number.isFinite(request.read)) {
      // WHAT THE PROVIDER DID, NOT THE MODEL. A prefix changed within the TTL
      // (a tool list or system reminder that moved) shows as a read below the
      // previous prompt. Pricing it as a read made both tiers look cheaper than
      // they were, and 1h's dearer write the most (#568 review).
      // `cached` is read + write (tallyFile), so 0 <= read <= cached.
      cost += writePrice * (request.cached - request.read) + CACHE_PRICE.read * request.read;
    } else {
      cost += writePrice * (request.cached - prev.cached) + CACHE_PRICE.read * prev.cached;
    }
    cost += request.input;
    prev = request;
  }
  return Math.round(cost);
}

/**
 * Cache entries lost to expiry: a request whose cache read fell well below the
 * previous prompt after a gap longer than `tier`, so the prefix was written
 * again. Returns the count and the tokens re-written.
 */
export function expiryRewrites(requests, tier = '5m') {
  const ttl = TTL_SECONDS[tier] * 1000;
  let count = 0;
  let tokens = 0;
  for (let i = 1; i < (requests || []).length; i++) {
    const prev = requests[i - 1];
    const cur = requests[i];
    const prevPrompt = prev.cached + prev.input;
    if (prevPrompt > 5_000 && cur.read < 0.8 * prevPrompt && cur.at - prev.at > ttl) {
      count += 1;
      tokens += prevPrompt - cur.read;
    }
  }
  return { count, tokens };
}

/**
 * The TTL finding: subagents written at the 5-minute tier whose cache expired
 * between requests -- an agent waiting on a build or a test suite -- and what the
 * same requests would have cost at the 1-hour tier.
 *
 * Withheld when the agents already write 1h, when expiry rewrote little, or when
 * the replay says 1h would not be cheaper: a 1h write costs 2x against 1.25x, so
 * agents that never pause are cheaper on 5m, and saying otherwise would be wrong.
 */
export function cacheTtlFinding(agents, { minSaving = 50_000, minShare = 0.05 } = {}) {
  if (!agents?.length) return null;
  const write5m = agents.reduce((sum, a) => sum + (a.write5m || 0), 0);
  const write1h = agents.reduce((sum, a) => sum + (a.write1h || 0), 0);
  if (write5m <= write1h) return null;
  const at5m = agents.reduce((sum, a) => sum + replayTtl(a.requests, '5m'), 0);
  const at1h = agents.reduce((sum, a) => sum + replayTtl(a.requests, '1h'), 0);
  const saving = at5m - at1h;
  if (saving < minSaving || saving < minShare * at5m) return null;
  const expiry = agents.reduce(
    (acc, a) => {
      const e = expiryRewrites(a.requests, '5m');
      return { count: acc.count + e.count, tokens: acc.tokens + e.tokens };
    },
    { count: 0, tokens: 0 }
  );
  const pct = Math.round((100 * saving) / at5m);
  return {
    id: 'subagent-cache-ttl',
    title:
      `${agents.length} subagents wrote their prompt cache at the 5-minute tier, and it expired ` +
      `${expiry.count} times while they waited on long tool calls, re-writing ` +
      `${expiry.tokens.toLocaleString()} tokens. Replayed at the 1-hour tier the same requests cost ` +
      `${pct}% less (${at5m.toLocaleString()} -> ${at1h.toLocaleString()} weighted tokens). ` +
      'token-optimizer sets "subagentPromptCacheTtl": "1h" in ~/.claude/settings.json once finished agents show this ' +
      '(unless you or the environment already set it); token-optimizer-doctor shows who owns it, or set it yourself now.',
    costPerSession: saving,
    savingShare: saving / at5m,
    file: 'subagents',
    remedy: { setting: 'subagentPromptCacheTtl', value: '1h' },
  };
}

/** A compact per-agent table, for the end of the audit report. */
export function renderTally(agents, { limit = 12 } = {}) {
  if (!agents?.length) return '';
  const k = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n));
  const rows = agents.slice(0, limit).map(
    (a) =>
      `  ${a.label.slice(0, 32).padEnd(32)} ${String(a.turns).padStart(5)} ${k(a.baseContext).padStart(7)} ` +
      `${k(a.cacheRead).padStart(8)} ${k(a.cacheWrite).padStart(7)} ${k(a.output).padStart(6)} ${k(a.toolOutput).padStart(7)}`
  );
  const more = agents.length > limit ? `\n  ... and ${agents.length - limit} more` : '';
  return (
    '\nSubagents this session (tokens):\n' +
    `  ${'agent'.padEnd(32)} ${'turns'.padStart(5)} ${'base'.padStart(7)} ${'cacheRd'.padStart(8)} ` +
    `${'cacheWr'.padStart(7)} ${'out'.padStart(6)} ${'toolOut'.padStart(7)}\n` +
    rows.join('\n') +
    more
  );
}
