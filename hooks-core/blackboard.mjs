/**
 * The sibling blackboard: what agents of one session already ran, recorded
 * mechanically and offered to the next agent before it starts discovering.
 *
 * WHY NOT A MODEL'S JOB. Sharing between sibling agents used to depend on one
 * of them deciding to call wiki_write, and in a subagent that is a deferred
 * tool whose load re-writes its cached context. The post-tool hook already
 * sees every result, so it records each read-only command's result here --
 * command, directory, commit, a short digest and where the full output is --
 * at no cost to any model.
 *
 * WHERE IT PAYS, AND WHERE IT CANNOT. Serving a sibling's identical output when
 * a command repeats saves execution, not tokens: the content is the same size
 * either way. Tokens are saved only when an agent learns what was found BEFORE
 * deciding to look, so the board is delivered in a subagent's first-call
 * briefing (duplicate-work detection), ranked by overlap with its task and
 * bounded.
 *
 * Per session: subagents share their parent's session id, and nothing crosses
 * sessions. TOKEN_OPTIMIZER_BLACKBOARD=0 turns it off.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

/** Entries older than this are not offered: the repository may have moved on. */
export const BOARD_TTL_MS = 30 * 60_000;
/** The most a briefing carries from the board. */
export const BOARD_BUDGET = 1500;
const MIN_OUTPUT_CHARS = 200;
const DIGEST_CHARS = 280;

export function boardEnabled(env = process.env) {
  return !/^(0|false|no|off)$/i.test(String(env.TOKEN_OPTIMIZER_BLACKBOARD ?? '').trim());
}

const stateRoot = () => process.env.TOKEN_OPTIMIZER_STATE_DIR || join(tmpdir(), 'token-optimizer-hooks');

export function boardPath(sessionId) {
  const safe = String(sessionId || 'default').replace(/[^A-Za-z0-9_-]/g, '') || 'default';
  return join(stateRoot(), 'blackboard', `${safe}.jsonl`);
}

/** First words of commands that only read. Anything else is never recorded. */
const READ_ONLY =
  /^(?:git\s+(?:log|show|diff|grep|ls-files|ls-tree|status|branch|rev-parse|blame|describe|tag\s+-l|remote\s+-v)|gh\s+(?:issue|pr)\s+(?:view|list|diff|checks)|gh\s+api\s+(?![^|;&]*(?:-X\s*(?:POST|PATCH|PUT|DELETE)|--method|\s-f\s|\s-F\s|--field|--input))|ls|cat|head|tail|grep|rg|find|wc|tree|jq|sed\s+-n|awk\s+(?!.*-i))\b/;
const MUTATES = /(?:^|[^>])>(?!&)|>>|\btee\b|\brm\b|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|-i\b|--in-place|\s-(?:delete|exec(?:dir)?|ok|fprint\w*)\b/;
/** `git branch` and `git tag` list by default and change refs with these. */
const REF_CHANGE = /\s-(?:[dDmMcCf]|-(?:delete|move|copy|force|set-upstream-to|unset-upstream|edit-description))\b/;
const mutates = (p) => MUTATES.test(p) || (/^git\s+(?:branch|tag)\b/.test(p) && REF_CHANGE.test(p));

/** The command with a leading `cd <dir> &&` taken off, and that directory. */
export function splitCd(command, cwd = '') {
  const m = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*([\s\S]+)$/.exec(String(command));
  if (!m) return { command: String(command).trim(), cwd };
  const dir = m[1].replace(/^["']|["']$/g, '');
  return { command: m[2].trim(), cwd: cwd ? resolve(cwd, dir) : dir };
}

export function isReadOnlyCommand(command) {
  const parts = String(command)
    // Split on the operators alone and trim after: a `\s*` around them is
    // quadratic on a long run of whitespace (regex-linearity.test.mjs).
    .split(/&&|\|\||;|\|/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every((p) => READ_ONLY.test(p) && !mutates(p));
}

/** The commit checked out in the repository containing `dir`, read from disk, or null. */
export function gitHead(dir) {
  try {
    let at = resolve(dir);
    for (let i = 0; i < 40; i++) {
      const dotGit = join(at, '.git');
      if (existsSync(dotGit)) {
        let gitDir = dotGit;
        if (!statSync(dotGit).isDirectory()) {
          const m = /gitdir:\s*(.+)/.exec(readFileSync(dotGit, 'utf8'));
          if (!m) return null;
          gitDir = resolve(at, m[1].trim());
        }
        const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
        if (!ref) return head.slice(0, 40);
        const common = existsSync(join(gitDir, 'commondir'))
          ? resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim())
          : gitDir;
        for (const base of [gitDir, common]) {
          const file = join(base, ref);
          if (existsSync(file)) return readFileSync(file, 'utf8').trim().slice(0, 40);
        }
        const packed = join(common, 'packed-refs');
        if (existsSync(packed)) {
          const line = readFileSync(packed, 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
          if (line) return line.slice(0, 40);
        }
        return null;
      }
      const up = dirname(at);
      if (up === at) return null;
      at = up;
    }
  } catch {
    return null;
  }
  return null;
}

function digestOf(output) {
  const lines = String(output).split('\n').filter((l) => l.trim());
  const head = lines.slice(0, 4).join(' | ');
  const tail = lines.length > 6 ? ` | … | ${lines.slice(-2).join(' | ')}` : '';
  const text = `${head}${tail}`.replace(/\s+/g, ' ');
  return text.length > DIGEST_CHARS ? `${text.slice(0, DIGEST_CHARS - 1)}…` : text;
}

/** Record one result. Silently does nothing for anything but a read-only command. */
export function recordOnBoard({ sessionId, agent = '', command, cwd = '', output, artifact = null, now = Date.now() }) {
  if (!boardEnabled() || !sessionId || typeof output !== 'string' || output.length < MIN_OUTPUT_CHARS) return false;
  const split = splitCd(command, cwd);
  if (!isReadOnlyCommand(split.command)) return false;
  const head = split.cwd ? gitHead(split.cwd) : null;
  const key = createHash('sha256').update(`${split.cwd}\n${head}\n${split.command}`).digest('hex').slice(0, 16);
  const entry = { key, at: now, agent, command: split.command, cwd: split.cwd, head, chars: output.length, digest: digestOf(output), artifact };
  try {
    const file = boardPath(sessionId);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
    return true;
  } catch {
    return false;
  }
}

const words = (text) => new Set(String(text).toLowerCase().match(/[a-z0-9_.#/-]{3,}/g) ?? []);

/**
 * What this agent's siblings already ran, for its first-call briefing: other
 * agents' entries only, the latest per command, ranked by overlap with the
 * task, bounded by BOARD_BUDGET. Null when there is nothing to offer.
 */
export function boardFor({ sessionId, agent = '', task = '', now = Date.now() }) {
  if (!boardEnabled() || !sessionId) return null;
  let raw;
  try {
    raw = readFileSync(boardPath(sessionId), 'utf8');
  } catch {
    return null;
  }
  const latest = new Map();
  for (const line of raw.split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e?.key || e.agent === agent || now - e.at > BOARD_TTL_MS) continue;
    if (!latest.has(e.key) || latest.get(e.key).at < e.at) latest.set(e.key, e);
  }
  if (!latest.size) return null;
  const want = words(task);
  const ranked = [...latest.values()]
    .map((e) => ({ e, score: [...words(`${e.command} ${e.digest}`)].filter((w) => want.has(w)).length }))
    .sort((a, b) => b.score - a.score || b.e.at - a.e.at);
  const lines = [];
  let used = 0;
  for (const { e } of ranked) {
    const age = Math.max(1, Math.round((now - e.at) / 60_000));
    const line = `- \`${e.command}\`${e.cwd ? ` in ${e.cwd}` : ''}${e.head ? ` @${e.head.slice(0, 8)}` : ''}, ${age} min ago, ${e.chars} chars: ${e.digest}${e.artifact ? ` (full: Read ${e.artifact})` : ''}`;
    if (used + line.length > BOARD_BUDGET) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length
    ? `# Already run by sibling agents in this session\nTheir results, newest first by relevance to your task. Reuse one instead of re-running it when it answers what you need.\n${lines.join('\n')}`
    : null;
}
