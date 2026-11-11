/**
 * Is a Claude Code session running with more context than its settings configure?
 *
 * Every turn re-reads the whole context from cache, so the context a session
 * carries is what each turn costs. On one machine (2026-10) cache reads were
 * about 99% of all tokens, and sessions averaged 490-550K tokens of context
 * per turn because they compacted only at about 965K. This package's proxy
 * had written `autoCompactWindow: 400000` (src/proxy/compact-window.ts); a
 * session started afterwards reported "10.7k / 400k", but the sessions already
 * running kept the window they started with -- Claude Code reads it once, at
 * session start -- so the lever did nothing for them, and nothing said so.
 * This compares a session's actual context, read from its transcript, with the
 * window its settings configure.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** Above the window by more than this is not rounding. */
const SLACK = 1.02;
const TAIL_BYTES = 512 * 1024;
/** The in-session check runs on every this-many tool calls. */
export const CHECK_EVERY_CALLS = 50;

/**
 * A window as Claude Code accepts it: a number of tokens, or "400k", "1M", or
 * a bare number under 1000 as thousands ("200"). "auto", or anything else, is
 * null: no configured window to compare against.
 */
function parseWindow(value) {
  if (typeof value === 'number')
    return value > 0 ? (value < 1000 ? value * 1000 : value) : null;
  if (typeof value !== 'string') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([km])?\s*$/i.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]?.toLowerCase();
  if (unit === 'k') return Math.round(n * 1000);
  if (unit === 'm') return Math.round(n * 1_000_000);
  return n < 1000 ? Math.round(n * 1000) : Math.round(n);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The configured window for a session in `cwd` on `model`, in tokens, or null
 * when it is "auto" or cannot be told. The environment variable takes
 * precedence, as Claude Code says when both are set; then project-local,
 * project and user settings. A per-model setting for another model makes the
 * answer unknowable here, so it is null rather than a guess.
 */
function configuredWindow({
  cwd = process.cwd(),
  model = null,
  env = process.env,
  home = homedir(),
} = {}) {
  if (env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
    return parseWindow(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  const configDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const sources = [
    join(cwd, '.claude', 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'),
    join(configDir, 'settings.json'),
  ].map(readJson);
  for (const settings of sources) {
    if (!settings || typeof settings !== 'object') continue;
    const perModel = settings.modelSettings;
    if (perModel && typeof perModel === 'object') {
      if (model && perModel[model]?.autoCompactWindow !== undefined)
        return parseWindow(perModel[model].autoCompactWindow);
      if (
        Object.values(perModel).some(
          (entry) => entry?.autoCompactWindow !== undefined
        )
      )
        return null;
    }
    if (settings.autoCompactWindow !== undefined)
      return parseWindow(settings.autoCompactWindow);
  }
  return null;
}

function tail(path) {
  let fd;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, TAIL_BYTES);
    if (!length) return '';
    fd = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The session's context as of its last model response -- input plus cache
 * reads and writes -- with that response's model and the session's cwd.
 * Null without a readable usage record.
 */
function sessionContext(transcriptPath) {
  if (!transcriptPath) return null;
  const lines = tail(transcriptPath).split('\n');
  let cwd = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"usage"') && !(cwd === null && line.includes('"cwd"')))
      continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (cwd === null && typeof record.cwd === 'string') cwd = record.cwd;
    const usage = record.type === 'assistant' ? record.message?.usage : null;
    if (!usage) continue;
    const tokens =
      (Number(usage.input_tokens) || 0) +
      (Number(usage.cache_read_input_tokens) || 0) +
      (Number(usage.cache_creation_input_tokens) || 0);
    // A synthetic message carries zeros; it says nothing about the context.
    if (!tokens) continue;
    return {
      tokens,
      model: record.message?.model ?? null,
      cwd: cwd ?? record.cwd ?? null,
    };
  }
  return null;
}

const k = (n) => `${Math.round(n / 1000)}K`;

/** The session's own notice, or null while it is within its configured window. */
export function overWindowNotice(
  transcriptPath,
  { env = process.env, home = homedir() } = {}
) {
  const context = sessionContext(transcriptPath);
  if (!context) return null;
  const window = configuredWindow({
    cwd: context.cwd ?? process.cwd(),
    model: context.model,
    env,
    home,
  });
  if (!window || context.tokens <= window * SLACK) return null;
  return (
    `This session's context is ${k(context.tokens)} tokens, above the ${k(window)} autoCompactWindow ` +
    'configured for Claude Code: most likely it started before that setting, as a session reads the window when it starts. ' +
    `Every turn re-reads the whole context, so each costs about ${(context.tokens / window).toFixed(1)}x what it would ` +
    'within the window. Tell the user once: run /compact now, or restart Claude Code and resume the session to apply the window.'
  );
}

/** Signal 0 only checks the pid exists; EPERM means it does, under another user. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * The sessions Claude Code is running now, from its registry:
 * `<config>/sessions/<pid>.json` names each live process's CURRENT session.
 * A transcript's recency cannot say this: after /clear the conversation just
 * cleared is recent and no longer running (review on #552), and a session whose
 * process exited is recent too. Null when there is no registry to read.
 */
function runningSessionIds(config) {
  let names;
  try {
    names = readdirSync(join(config, 'sessions')).filter((name) =>
      /^\d+\.json$/.test(name)
    );
  } catch {
    return null;
  }
  const ids = new Set();
  for (const name of names) {
    let entry;
    try {
      entry = JSON.parse(readFileSync(join(config, 'sessions', name), 'utf8'));
    } catch {
      continue;
    }
    if (typeof entry?.sessionId === 'string' && pidAlive(Number(entry.pid)))
      ids.add(entry.sessionId);
  }
  return ids;
}

/**
 * Other running sessions above their configured window. Their transcripts sit
 * beside this one: `<config>/projects/<project>/<session>.jsonl`. Without
 * Claude Code's session registry nothing says which are running, so nothing is
 * reported.
 */
function sessionsOverWindow(
  transcriptPath,
  { env = process.env, home = homedir() } = {}
) {
  if (!transcriptPath) return [];
  const projects = dirname(dirname(transcriptPath));
  const running = runningSessionIds(dirname(projects));
  if (!running) return [];
  running.delete(basename(transcriptPath, '.jsonl'));
  if (!running.size) return [];
  let dirs = [];
  try {
    dirs = readdirSync(projects, { withFileTypes: true }).filter((d) =>
      d.isDirectory()
    );
  } catch {
    return [];
  }
  const over = [];
  for (const id of running) {
    const dir = dirs.find((d) =>
      existsSync(join(projects, d.name, `${id}.jsonl`))
    );
    if (!dir) continue;
    const path = join(projects, dir.name, `${id}.jsonl`);
    const context = sessionContext(path);
    if (!context?.cwd) continue;
    const window = configuredWindow({
      cwd: context.cwd,
      model: context.model,
      env,
      home,
    });
    if (window && context.tokens > window * SLACK)
      over.push({ path, tokens: context.tokens, window });
  }
  return over.sort((a, b) => b.tokens - a.tokens);
}

/** The session-start notice about other sessions, or null when none is over. */
export function otherSessionsNotice(transcriptPath, options = {}) {
  const over = sessionsOverWindow(transcriptPath, options);
  if (!over.length) return null;
  const [largest] = over;
  const count =
    over.length === 1
      ? 'Another Claude Code session'
      : `${over.length} other Claude Code sessions`;
  return (
    `${count} on this machine ${over.length === 1 ? 'is' : 'are'} above the configured autoCompactWindow: ` +
    `the largest is at ${k(largest.tokens)} tokens against ${k(largest.window)}. Most likely they started before the setting and ` +
    'keep the window they started with, and each of their turns re-reads the whole context. Tell the user once: ' +
    'run /compact in them, or restart Claude Code and resume them to apply the window.'
  );
}
