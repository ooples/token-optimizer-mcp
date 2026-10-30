/**
 * What a session lost by running hooks older than the installed runtime.
 *
 * A STALE WINDOW is the stretch after a newer runtime was installed and before a
 * session that started earlier reaches its next SessionStart: Claude Code keeps
 * that session on the hooks it loaded. Every tool result in the window is
 * replayed through the newer compactor; results from sessions that already
 * restarted are the "fresh" control.
 *
 * Usage:
 *   node bench/field/stale-hooks.mjs --installed <ISO> --until <ISO> --compactor <newer output-compact.mjs>
 *
 * --installed is when the newer runtime landed (its versions/<v> dir mtime);
 * --until is the next install, or the end of the corpus.
 */
import { createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replayCall } from './compaction-replay.mjs';
import { transcripts } from './multi-agent-waste.mjs';

const opt = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
};

async function* records(file) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      /* a torn last line of a live transcript */
    }
  }
}

async function main() {
  const installed = opt('--installed');
  const until = opt('--until');
  const compactorPath = opt('--compactor');
  if (!installed || !until || !compactorPath) {
    console.error('usage: --installed <ISO> --until <ISO> --compactor <path/to/output-compact.mjs>');
    process.exit(2);
  }
  const { compactToolResponse } = await import(pathToFileURL(resolve(compactorPath)).href);
  const files = [...transcripts(opt('--root') ?? undefined)];

  // Every SessionStart per session id; a subagent's file carries its parent's id.
  const starts = new Map();
  for (const file of files)
    for await (const o of records(file))
      if (o.type === 'attachment' && o.attachment?.hookEvent === 'SessionStart' && o.sessionId && o.timestamp) {
        if (!starts.has(o.sessionId)) starts.set(o.sessionId, []);
        starts.get(o.sessionId).push(o.timestamp);
      }
  for (const list of starts.values()) list.sort();
  const startedBefore = (sessionId, at) => {
    let last = null;
    for (const s of starts.get(sessionId) ?? []) {
      if (s > at) break;
      last = s;
    }
    return last;
  };

  const dir = mkdtempSync(join(tmpdir(), 'stale-hooks-'));
  const rows = new Map();
  const sessions = new Map();
  try {
    for (const file of files) {
      const uses = new Map();
      for await (const o of records(file)) {
        if (!o.timestamp || o.timestamp < installed || o.timestamp >= until) continue;
        if (o.type === 'assistant') {
          for (const c of o.message?.content || [])
            if (c.type === 'tool_use') uses.set(c.id, { name: c.name, input: c.input || {} });
          continue;
        }
        if (o.type !== 'user' || !Array.isArray(o.message?.content)) continue;
        const start = startedBefore(o.sessionId, o.timestamp);
        const side = start !== null && start < installed ? 'stale' : 'fresh';
        for (const c of o.message.content) {
          if (c.type !== 'tool_result') continue;
          const use = uses.get(c.tool_use_id);
          if (!use) continue;
          const r = replayCall({ tool: use.name, input: use.input, response: o.toolUseResult, dir, compactToolResponse });
          if (!r) continue;
          const row = rows.get(side) ?? { results: 0, before: 0, missed: 0, saved: 0 };
          row.results++;
          row.before += r.before;
          // Reached the model whole, and the newer hooks would have shrunk it.
          if (!r.recorded && r.after < r.before) {
            row.missed++;
            row.saved += r.before - r.after;
          }
          rows.set(side, row);
          if (side === 'stale') {
            const s = sessions.get(o.sessionId) ?? { results: 0, saved: 0 };
            s.results++;
            if (!r.recorded && r.after < r.before) s.saved += r.before - r.after;
            sessions.set(o.sessionId, s);
          }
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const tokens = (bytes) => Math.ceil(bytes / 4).toLocaleString('en-US');
  console.log(`window: ${installed} .. ${until}`);
  console.log('| side | results | tokens | compactable by the newer hooks | tokens they would have removed |');
  console.log('|---|---:|---:|---:|---:|');
  for (const [side, r] of rows)
    console.log(`| ${side} | ${r.results} | ${tokens(r.before)} | ${r.missed} | ${tokens(r.saved)} |`);
  for (const [id, s] of sessions)
    console.log(`stale session ${id.slice(0, 8)}: ${s.results} results, ${tokens(s.saved)} tokens`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
