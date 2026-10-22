#!/usr/bin/env node
// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/ask.mjs. Regenerate with `npm run sync:hooks`.
/**
 * repo_ask: "answer, don't read". A question about the repository answered in
 * a few lines from git and GitHub, instead of the 3-6 calls an agent spends
 * reading files to answer it.
 *
 *   repo_ask "where is DEFAULT_KEEP_RELEVANT defined"   definitions, file:line
 *   repo_ask "what calls shareSiblingPrefix"           call sites, file:line
 *   repo_ask "what does ooples/AiDotNet#1159 say"       the issue or PR, bounded
 *   repo_ask "<anything else>"                           matching lines for its keywords
 *
 * A SHELL COMMAND, NOT A TOOL. As an MCP tool it would be deferred in every
 * subagent, and loading a deferred tool re-writes the agent's cached context.
 * The session-start hook defines `repo_ask` in Claude Code's session env file
 * (quiet-env.mjs), which every Bash call of every agent sources.
 */
import { spawnSync } from 'node:child_process';

const BUDGET = 2500;
const MAX_HITS = 15;

const run = (cmd, args) =>
  spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'ignore'] })
    .stdout ?? '';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function bounded(title, lines) {
  const out = [title];
  let used = title.length;
  for (const l of lines) {
    const line = l.length > 220 ? `${l.slice(0, 217)}...` : l;
    if (used + line.length + 1 > BUDGET) {
      out.push(`[... ${lines.length - out.length + 1} more]`);
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out.join('\n');
}

function grep(pattern, extra = []) {
  return run('git', ['-c', 'core.fsmonitor=false', 'grep', '-n', '-I', '--untracked', '-E', ...extra, pattern, '--', '.'])
    .split('\n')
    .filter(Boolean);
}

const DEF = (name) =>
  `(^|[^A-Za-z0-9_])(function|class|def|interface|type|enum|const|let|var|struct|fn|func|public|private|protected|internal|static)\\s+([A-Za-z0-9_<>,\\s]*\\s)?${escape(name)}([^A-Za-z0-9_]|$)|${escape(name)}\\s*[:=]\\s*(function|async|\\()`;

export function answer(question) {
  const q = String(question).trim();
  let m;
  if ((m = /(?:where\s+is|definition\s+of|where'?s|define[sd]?)\s+[`'"]?([A-Za-z_$][\w$.]*)/i.exec(q))) {
    const name = m[1].split('.').pop();
    const hits = grep(DEF(name)).slice(0, MAX_HITS);
    return bounded(`definitions of ${name} (${hits.length}):`, hits.length ? hits : ['none found by name; try what calls / a keyword question']);
  }
  if ((m = /(?:what\s+calls|callers\s+of|who\s+(?:calls|uses)|usages?\s+of|references\s+to)\s+[`'"]?([A-Za-z_$][\w$.]*)/i.exec(q))) {
    const name = m[1].split('.').pop();
    const def = new RegExp(DEF(name));
    // `-w` is the word boundary; boundary classes in the pattern as well made a
    // match end on the next word character and miss every call `name(arg)`.
    const hits = grep(escape(name), ['-w']).filter((l) => !def.test(l.replace(/^[^:]+:\d+:/, '')));
    return bounded(`uses of ${name} (${hits.length}, definitions left out):`, hits.slice(0, MAX_HITS * 2));
  }
  // Bounded and anchored by a lookbehind, so a long run of name characters is
  // scanned once rather than from every position (regex-linearity.test.mjs).
  if ((m = /(?:(?<![\w.-])([\w.-]{1,100})\/([\w.-]{1,100}?))?\s{0,4}#(\d{1,9})\b/.exec(q)) && /\b(issue|pr|pull|say|says|about)\b|#\d/i.test(q)) {
    let [, owner, repo] = m;
    if (!owner) {
      const url = run('git', ['config', '--get', 'remote.origin.url']).trim();
      const r = /[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url);
      if (r) [, owner, repo] = r;
    }
    if (!owner) return 'no owner/repo given and no origin remote to infer one from';
    const raw = run('gh', ['api', `repos/${owner}/${repo}/issues/${m[3]}`]);
    try {
      const it = JSON.parse(raw);
      const body = String(it.body ?? '').trim();
      return bounded(`${owner}/${repo}#${m[3]} (${it.pull_request ? 'pull request' : 'issue'}, ${it.state}): ${it.title}`, (body || '(no description)').split('\n'));
    } catch {
      return `could not fetch ${owner}/${repo}#${m[3]} with gh`;
    }
  }
  const words = [...new Set(q.toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) ?? [])].filter(
    (w) => !['what', 'where', 'which', 'does', 'that', 'this', 'with', 'from', 'about', 'have', 'there', 'repository', 'code'].includes(w)
  );
  if (!words.length) return 'ask about a name, a call, an issue number, or give keywords';
  const hits = grep(words.map(escape).join('|'), ['-i']);
  return bounded(`lines matching ${words.join(', ')} (${hits.length}):`, hits.slice(0, MAX_HITS * 2));
}

if (process.argv[1] && /ask\.mjs$/.test(process.argv[1]) && process.argv.length > 2) {
  process.stdout.write(`${answer(process.argv.slice(2).join(' '))}\n`);
}
