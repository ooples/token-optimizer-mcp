// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/subagents.mjs. Regenerate with `npm run sync:hooks`.
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
const charsToTokens = (chars) => Math.round(chars / 4);

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
  const out = { turns: 0, baseContext: 0, cacheRead: 0, cacheWrite: 0, input: 0, output: 0, toolOutput: 0, fixedBlocks: [] };
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
  }
  out.fixedBlocks.sort((a, b) => b.tokens - a.tokens);
  return out;
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
