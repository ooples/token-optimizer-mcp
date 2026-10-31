/**
 * WHERE THE TOKENS GO IN MULTI-SESSION, MULTI-AGENT WORK, FROM REAL TRANSCRIPTS.
 *
 * Issue #533 asks for a ranked waste report measured on the v1 workstreams --
 * one main session driving several background agents across three repos. The
 * local Claude Code transcripts record every tool result exactly as the model
 * received it (after our PostToolUse hooks had their say), every hook
 * injection, and every request's usage, so the bill can be decomposed by
 * pattern instead of guessed.
 *
 * TWO NUMBERS PER PATTERN, because a token is paid more than once.
 *
 *   tokens     -- what entered context, chars/4 as everywhere else in hooks-core.
 *   resident   -- tokens x the requests that followed it in the same transcript.
 *                 Every later request re-reads the whole prefix (as cache reads),
 *                 so a 10k-token log read on turn 5 of a 200-turn agent is paid
 *                 ~195 more times. This is the term the cost model calls N, and
 *                 the one a fix early in a session actually moves.
 *
 * "compacted" is the share of a pattern's results that already carry one of our
 * markers (`[token-optimizer:` from output-compact, the read-cache stub), i.e.
 * what the current hooks already handle.
 *
 * ANONYMISED BY CONSTRUCTION. Nothing below prints a path, a command, a doc id
 * or a byte of content: repeat detection keys on a sha1 of the target, and the
 * report holds only pattern names, counts and sizes.
 *
 * Usage:
 *   node bench/field/multi-agent-waste.mjs [--session <uuid>] [--json out.json]
 *     [--since <ISO>] [--until <ISO>] [--verbs]
 *     [--root <dir>]        (default ~/.claude/projects)
 *
 * --session restricts to one main transcript plus its subagents.
 */
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { OUTPUT_COMPACT_MIN_BYTES } from '../../hooks-core/output-compact.mjs';

const est = (n) => Math.ceil(n / 4);
const hash = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const ROOT = opt('--root') || join(homedir(), '.claude', 'projects');
const SESSION = opt('--session');
const JSON_OUT = opt('--json');
/**
 * --since <ISO>: only records at or after this instant. The installed version
 * changes under a long session, and a waste a later release already fixed is not
 * a waste of the current one -- so rank on the window the current release ran.
 */
const SINCE = opt('--since');
/** --until <ISO>: records before this instant only, so a live transcript gives a fixed corpus. */
const UNTIL = opt('--until');
/** --verbs: also print the program name (first word) of unclassified shell commands, by size. */
const VERBS = args.includes('--verbs') ? new Map() : null;

/** Every transcript under ROOT, main sessions and their subagents. */
export function transcripts(root = ROOT, session = SESSION) {
  const out = [];
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        if (session && !p.includes(session)) continue;
        out.push(p);
      }
    }
  };
  walk(root, 0);
  return out;
}

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c && typeof c.text === 'string' ? c.text : c && c.type === 'image' ? '' : ''))
    .join('\n');
};

const COMPACT_MARK = /\[token-optimizer: |token-optimizer:.*(unchanged|cached|delta)|File unchanged since last read/i;

/** Strip the leading `cd X &&` and env assignments so the verb is what we classify. */
const verbOf = (command) =>
  String(command || '')
    .replace(/^\s*(cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*)+/g, '')
    .replace(/^\s*((Set-Location|Push-Location|sl)\s+("[^"]*"|'[^']*'|\S+)\s*;\s*)+/gi, '')
    .replace(/^\s*([A-Z_][A-Z0-9_]*=\S*\s+)+/g, '')
    // PowerShell: `$x = Get-Content ...` and `(Get-Content ...)[a..b]` read the same as cat.
    .replace(/^\s*\$[\w:]+\s*=\s*/, '')
    .replace(/^\s*\(+/, '')
    .replace(/^git\s+-C\s+("[^"]*"|\S+)\s+/, 'git ')
    .trim();

/**
 * The pattern a tool call belongs to, and the key two calls must share to count
 * as a repeat of the same target. Order matters: the first match wins.
 */
export function classify(name, input = {}) {
  const n = String(name || '');
  if (n === 'Read')
    return {
      pattern: 'read:file',
      // Same file AND same window: a paged read of the next 200 lines is not a repeat.
      key: `${input.file_path}|${input.offset ?? ''}|${input.limit ?? ''}|${input.pages ?? ''}`,
      file: input.file_path,
    };
  if (n === 'Grep' || n === 'Glob') return { pattern: 'search', key: null };
  if (n === 'Edit' || n === 'Write' || n === 'MultiEdit' || n === 'NotebookEdit')
    return { pattern: 'edit', key: null, edits: input.file_path };
  if (n === 'Agent' || n === 'Task') return { pattern: 'agent:report', key: null };
  if (n === 'TaskOutput' || n === 'SendMessage') return { pattern: 'agent:report', key: null };
  if (n === 'WebFetch' || n === 'WebSearch') return { pattern: 'web', key: input.url || input.query };
  if (/^mcp__.*Docs__(read|query|export)$/.test(n))
    return { pattern: 'docs:read', key: JSON.stringify(input.container?.id ?? input.id ?? input.ref ?? input) };
  if (/^mcp__.*Docs__/.test(n))
    return {
      pattern: 'docs:write',
      key: null,
      docEdit: JSON.stringify(input.container?.id ?? input.id ?? null),
    };
  if (/^mcp__token-optimizer__/.test(n) || /^mcp__plugin_token-optimizer/.test(n))
    return { pattern: 'mcp:token-optimizer', key: null };
  if (/^mcp__/.test(n)) return { pattern: 'mcp:other', key: null };
  if (n === 'Bash' || n === 'PowerShell') {
    const cmd = verbOf(input.command);
    if (/\bgh\s+run\s+(view|watch)\b.*--log/.test(cmd) || /\bgh\s+run\s+view\b.*--log-failed/.test(cmd))
      return { pattern: 'ci:log', key: cmd };
    if (/\bgh\s+run\s+(view|list|watch)\b|\bgh\s+pr\s+checks\b/.test(cmd))
      return { pattern: 'ci:status', key: cmd };
    const ghView = cmd.match(/\bgh\s+(issue|pr)\s+view\s+(\S+)(?:.*?(?:-R|--repo)\s+(\S+))?/);
    if (ghView && !/--json\s+\S*(statusCheck|files)/.test(cmd))
      return { pattern: 'gh:issue-pr-body', key: `${ghView[1]}:${ghView[2]}:${ghView[3] || ''}` };
    if (/\bgh\s+api\b/.test(cmd)) return { pattern: 'gh:api', key: cmd };
    if (/\b(dotnet\s+(build|test|msbuild)|build\.ps1|msbuild|npm(\.cmd)?\s+(test|run\s+\S*(build|test|lint|check))|npx(\.cmd)?\s+(tsc|jest|eslint)|\bjest\b|\btsc\b|cargo\s+(build|test)|pytest|ctest|cmake\s+--build|nvcc)\b/.test(cmd))
      return { pattern: 'build-test:log', key: cmd };
    if (/^(cat|type|head|tail|less|bat|nl|Get-Content|gc)\b|^sed\s+-n\b|^awk\s/.test(cmd)) {
      const file = (cmd.match(/(?:^\S+(?:\s+-\S+)*\s+)(?:'[^']*'\s+)?("[^"]+"|\S+)/) || [])[1];
      return { pattern: 'read:shell', key: cmd, file: file && file.replace(/^"|"$/g, '') };
    }
    if (/^(Get-Content|gc)\b/i.test(cmd))
      return { pattern: 'read:shell', key: cmd, file: (cmd.match(/^\S+\s+(?:-Path\s+)?("[^"]+"|'[^']+'|\S+)/) || [])[1] };
    if (/^git\s+grep\b|^(Select-String|sls|findstr)\b/i.test(cmd)) return { pattern: 'search', key: null };
    if (/^git\s+(diff|show|log)\b/.test(cmd)) return { pattern: 'git:diff-log', key: cmd };
    if (/^(grep|rg|find|ls|dir|Get-ChildItem)\b/.test(cmd)) return { pattern: 'search', key: null };
    return { pattern: 'shell:other', key: null, verb: programName(cmd) };
  }
  return { pattern: `tool:${n}`, key: null };
}

/**
 * The program a command runs, or `(other)`. ONE WORD, AND ONLY A PLAIN NAME: the
 * second word was an argument (`export API_TOKEN=...`, `node /home/u/app.js`),
 * and a first word that is a path or an assignment is not a program name either.
 * Keeps --verbs inside the header's promise that nothing here prints a command.
 */
export function programName(cmd) {
  const first = String(cmd).trim().split(/\s+/)[0] ?? '';
  return /^[A-Za-z][\w.-]{0,23}$/.test(first) ? first : '(other)';
}

/** Folds one transcript into per-pattern rows. */
export async function scan(file, rows, { since = SINCE, until = UNTIL } = {}) {
  const events = []; // { pattern, chars, compacted, at }
  const uses = new Map();
  const seenKey = new Map(); // key -> count
  const lastEditAt = new Map(); // file/doc -> event index of the last edit
  const lastReadAt = new Map(); // file/doc -> event index of the last read
  const injSeen = new Set();
  const requests = new Set();
  let reqIndex = 0;
  const reqOrder = [];
  const boundaries = [];

  const push = (pattern, chars, compacted) => {
    events.push({ pattern, chars, compacted, at: reqIndex });
  };

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
    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      // The client summarised the conversation: nothing before this point is
      // resident any more, so its re-read count stops here.
      boundaries.push(reqIndex);
      continue;
    }
    if (o.type === 'user' && typeof o.message?.content === 'string') {
      if (/^\s*<task-notification>/.test(o.message.content))
        push('agent:report', o.message.content.length, false);
      continue;
    }
    if (o.type === 'assistant') {
      const rid = o.requestId || o.message?.id || o.uuid;
      if (!requests.has(rid)) {
        requests.add(rid);
        reqIndex++;
        reqOrder.push(rid);
      }
      for (const c of o.message?.content || []) {
        if (c.type === 'tool_use') uses.set(c.id, { name: c.name, input: c.input || {}, at: events.length });
      }
      continue;
    }
    if (o.type === 'attachment' && o.attachment) {
      const a = o.attachment;
      if (a.type === 'hook_additional_context') {
        const text = Array.isArray(a.content) ? a.content.join('\n') : String(a.content || '');
        const h = hash(text);
        const dup = injSeen.has(h);
        injSeen.add(h);
        // An injection that repeats lines already injected earlier this session
        // is paid twice. Count line-level duplication, which catches the "Known
        // about X" blocks that differ only in their header.
        let dupLines = 0;
        for (const l of text.split('\n')) {
          const lh = 'L' + hash(l.trim());
          if (l.trim().length > 20) {
            if (injSeen.has(lh)) dupLines += l.length + 1;
            injSeen.add(lh);
          }
        }
        const isOurs = /token-optimizer|Known about|from previous sessions|wiki_write|Token budget|known from previous/i.test(text);
        const p = isOurs ? 'inject:token-optimizer' : 'inject:other-hook';
        if (dup) push(`${p}:repeat`, text.length, false);
        else {
          push(p, text.length - dupLines, false);
          if (dupLines) push(`${p}:repeat`, dupLines, false);
        }
      } else if (a.type === 'instructions') {
        // CLAUDE.md and friends, delivered again to every agent that starts.
        const size = (a.files || []).reduce((s, f) => s + String(f?.content ?? '').length, 0);
        push('inject:claude-md', size || JSON.stringify(a).length, false);
      } else if (a.type === 'skill_listing') {
        push('inject:skill-listing', String(a.content ?? '').length, false);
      } else if (a.type === 'deferred_tools_delta') {
        push('inject:tool-listing', JSON.stringify(a.addedLines ?? a).length, false);
      }
      continue;
    }
    if (o.type !== 'user' || !Array.isArray(o.message?.content)) continue;
    for (const c of o.message.content) {
      if (c.type !== 'tool_result') continue;
      const use = uses.get(c.tool_use_id);
      const chars = textOf(c.content).length;
      const compacted = COMPACT_MARK.test(textOf(c.content));
      if (!use) {
        push('unmatched', chars, compacted);
        continue;
      }
      const cls = classify(use.name, use.input);
      let pattern = cls.pattern;
      const idx = events.length;
      if (cls.edits) lastEditAt.set(cls.edits, idx);
      if (cls.docEdit) lastEditAt.set('doc:' + cls.docEdit, idx);
      const target = cls.pattern === 'docs:read' ? 'doc:' + cls.key : cls.file;
      if (cls.key) {
        const k = cls.pattern + '|' + hash(cls.key);
        const n = seenKey.get(k) || 0;
        seenKey.set(k, n + 1);
        if (n > 0) {
          const editedSince =
            target && lastEditAt.has(target) && lastEditAt.get(target) > (lastReadAt.get(target) ?? -1);
          pattern += editedSince ? ':reread-after-edit' : ':repeat';
        }
      }
      if (target) lastReadAt.set(target, idx);
      if (c.is_error) pattern += ':error';
      push(pattern, chars, compacted);
      if (cls.verb && VERBS) {
        const v = VERBS.get(cls.verb) || { n: 0, chars: 0 };
        v.n++;
        v.chars += chars;
        VERBS.set(cls.verb, v);
      }
    }
  }

  const total = reqIndex;
  const endOf = (at) => {
    for (const b of boundaries) if (b >= at) return b;
    return total;
  };
  for (const e of events) {
    const r = rows.get(e.pattern) || { pattern: e.pattern, n: 0, chars: 0, resident: 0, compacted: 0, compactedChars: 0, max: 0, eligibleChars: 0 };
    r.n++;
    r.chars += e.chars;
    r.max = Math.max(r.max, e.chars);
    if (e.chars >= OUTPUT_COMPACT_MIN_BYTES) r.eligibleChars += e.chars;
    r.resident += est(e.chars) * Math.max(0, endOf(e.at) - e.at);
    if (e.compacted) {
      r.compacted++;
      r.compactedChars += e.chars;
    }
    rows.set(e.pattern, r);
  }
  return { requests: total, events: events.length };
}

async function main() {
  const files = transcripts();
  const rows = new Map();
  let requests = 0;
  let bytes = 0;
  for (const f of files) {
    bytes += statSync(f).size;
    const s = await scan(f, rows);
    requests += s.requests;
  }
  const list = [...rows.values()].map((r) => ({
    ...r,
    tokens: est(r.chars),
    compactedShare: r.n ? r.compacted / r.n : 0,
  }));
  list.sort((a, b) => b.resident - a.resident);
  const totTok = list.reduce((s, r) => s + r.tokens, 0);
  const totRes = list.reduce((s, r) => s + r.resident, 0);
  const fmt = (n) => n.toLocaleString('en-US');
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '-');
  console.log(
    `${files.length} transcripts, ${(bytes / 1e6).toFixed(0)} MB, ${fmt(requests)} requests, ` +
      `${fmt(totTok)} result/injection tokens, ${fmt(totRes)} resident token-requests\n`
  );
  console.log('| # | pattern | n | tokens | % tokens | resident (tok x later requests) | % resident | max single (tok) | tokens in results >= 6 KB | already compacted (n) |');
  console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  list.forEach((r, i) =>
    console.log(
      `| ${i + 1} | ${r.pattern} | ${fmt(r.n)} | ${fmt(r.tokens)} | ${pct(r.tokens, totTok)} | ${fmt(r.resident)} | ${pct(r.resident, totRes)} | ${fmt(est(r.max))} | ${pct(r.eligibleChars, r.chars)} | ${pct(r.compacted, r.n)} |`
    )
  );
  if (VERBS) {
    console.log('\nshell:other by leading words (top 30 by chars)');
    for (const [v, x] of [...VERBS].sort((a, b) => b[1].chars - a[1].chars).slice(0, 30))
      console.log(`  ${v.padEnd(26)} n=${x.n} tokens=${fmt(est(x.chars))}`);
  }
  if (JSON_OUT)
    writeFileSync(JSON_OUT, JSON.stringify({ files: files.length, bytes, requests, totTok, totRes, rows: list }, null, 2));
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('bench/field/multi-agent-waste.mjs'))
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
