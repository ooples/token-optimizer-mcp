/**
 * REPLAYS REAL SHELL AND GREP RESULTS THROUGH THE COMPACTOR, FOR A BEFORE/AFTER.
 *
 * multi-agent-waste.mjs ranks where the tokens went. This answers the follow-up
 * question for each fix: how many of those tokens would the PostToolUse
 * compactor in THIS working tree have kept out of context? Run it on the base
 * commit, apply the change, run it again -- the difference is the measured
 * saving, on the same recorded outputs, with nothing re-executed.
 *
 * WHAT IT FEEDS THE COMPACTOR is exactly what the hook receives: the
 * `toolUseResult` the transcript stores beside each tool_result ({stdout,
 * stderr} for Bash/PowerShell, {mode, content, ...} for Grep) and the
 * `tool_use` input that produced it. A result that already carries our marker
 * was compacted when it was recorded; its raw text is gone, so it is counted at
 * its recorded size on both sides and reported separately rather than guessed.
 *
 * Artifacts the compactor captures go to a throwaway directory (--artifacts,
 * default under the OS temp dir) that is removed at the end.
 *
 * Usage:
 *   node bench/field/compaction-replay.mjs [--session <uuid>] [--since <ISO>] [--until <ISO>]
 *     [--root <dir>] [--json out.json] [--artifacts <dir>]
 *
 * Prints one row per pattern (multi-agent-waste.mjs's classifier): results,
 * tokens as produced, tokens after this tree's compactor, and the share removed.
 */
import { mkdtempSync, rmSync, writeFileSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactToolResponse } from '../../hooks-core/output-compact.mjs';
import { classify, transcripts } from './multi-agent-waste.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const est = (n) => Math.ceil(n / 4);
const MARK = '[token-optimizer: ';

/** The text of a Bash/PowerShell or Grep response, as the model would read it. */
export function responseText(tool, response) {
  if (!response || typeof response !== 'object') return '';
  if (tool === 'Grep') return typeof response.content === 'string' ? response.content : '';
  const out = typeof response.stdout === 'string' ? response.stdout : '';
  const err = typeof response.stderr === 'string' ? response.stderr : '';
  return err ? `${out}\n${err}` : out;
}

/**
 * One recorded call through the compactor. Returns null for a call this harness
 * does not replay (another tool, or a response without the hook's shape).
 */
export function replayCall({ tool, input, response, dir }) {
  if (tool !== 'Bash' && tool !== 'PowerShell' && tool !== 'Grep') return null;
  if (tool === 'Grep' ? typeof response?.content !== 'string' : typeof response?.stdout !== 'string')
    return null;
  const before = responseText(tool, response);
  if (before.includes(MARK)) return { before: before.length, after: before.length, recorded: true };
  const replaced = compactToolResponse({ tool, input, response, dir, sessionId: 'replay' });
  const after = replaced ? responseText(tool, replaced) : before;
  return { before: before.length, after: after.length, recorded: false };
}

async function main() {
  const since = opt('--since');
  // A live session keeps appending; a fixed --until is what makes two runs comparable.
  const until = opt('--until');
  const artifacts = opt('--artifacts') || mkdtempSync(join(tmpdir(), 'compaction-replay-'));
  const rows = new Map();
  const bump = (pattern, r) => {
    const row = rows.get(pattern) || { pattern, n: 0, before: 0, after: 0, changed: 0, recorded: 0 };
    row.n++;
    row.before += r.before;
    row.after += r.after;
    if (r.after !== r.before) row.changed++;
    if (r.recorded) row.recorded++;
    rows.set(pattern, row);
  };
  try {
    for (const file of transcripts(opt('--root'), opt('--session'))) {
      const uses = new Map();
      const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (since && typeof o.timestamp === 'string' && o.timestamp < since) continue;
        if (until && typeof o.timestamp === 'string' && o.timestamp >= until) continue;
        if (o.type === 'assistant') {
          for (const c of o.message?.content || [])
            if (c.type === 'tool_use') uses.set(c.id, { name: c.name, input: c.input || {} });
          continue;
        }
        if (o.type !== 'user' || !Array.isArray(o.message?.content)) continue;
        for (const c of o.message.content) {
          if (c.type !== 'tool_result') continue;
          const use = uses.get(c.tool_use_id);
          if (!use) continue;
          const r = replayCall({ tool: use.name, input: use.input, response: o.toolUseResult, dir: artifacts });
          if (!r) continue;
          bump(classify(use.name, use.input).pattern.split(':').slice(0, 2).join(':'), r);
          bump('TOTAL', r);
        }
      }
    }
  } finally {
    if (!opt('--artifacts')) rmSync(artifacts, { recursive: true, force: true });
  }
  const list = [...rows.values()].sort((a, b) => (a.pattern === 'TOTAL' ? 1 : b.pattern === 'TOTAL' ? -1 : b.before - a.before));
  const fmt = (n) => n.toLocaleString('en-US');
  console.log('| pattern | results | tokens produced | tokens after compactor | removed | results changed | compacted when recorded |');
  console.log('|---|---:|---:|---:|---:|---:|---:|');
  for (const r of list)
    console.log(
      `| ${r.pattern} | ${fmt(r.n)} | ${fmt(est(r.before))} | ${fmt(est(r.after))} | ${r.before ? ((100 * (r.before - r.after)) / r.before).toFixed(1) : '0.0'}% | ${fmt(r.changed)} | ${fmt(r.recorded)} |`
    );
  const out = opt('--json');
  if (out) writeFileSync(out, JSON.stringify(list, null, 2));
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('bench/field/compaction-replay.mjs'))
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
