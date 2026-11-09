// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/copilotprune.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Learned tool pruning for GitHub Copilot CLI: leave out the built-in tools a
 * repository never uses, so their definitions stop riding on every request.
 *
 * WHY. Measured on Copilot CLI 1.0.107 (first request of a one-command
 * session, `session.usage_record.inputTokens`): 26,748 tokens with the stock
 * 28-tool catalog, 12,762 with 20 rarely used tools passed to
 * `--excluded-tools` -- 52% of the standing prompt, and AI credits for the
 * session 7.04 -> 3.43. By contrast every setting Copilot persists moved it by
 * single tokens (`disabledMcpServers` for github-mcp-server: +6) or by 560
 * (four user-level switches), so the launch flag is the lever.
 *
 * WHERE IT IS DELIVERED. `--excluded-tools` exists only as a launch flag: no
 * repository or user setting carries it, and a hook cannot add a flag. So the
 * managed launcher (scripts/run-client.mjs, behind the `copilot` shim the
 * installer puts on PATH) asks `copilotExclusions` at launch and appends it.
 * A Copilot started any other way runs with every tool, and its sessions are
 * still learned from.
 *
 * THE DECISION is toolprune's evidence rule on toolprune's store shape: a tool
 * is left out once it went unused for `evidence` prompts across `minSessions`
 * sessions, or for `sessions` sessions. Evidence comes from Copilot's own
 * session log, `<COPILOT_HOME>/session-state/<id>/events.jsonl`:
 *   session.start          data.sessionId, data.context.cwd (which repository)
 *   user.message           data.content (a typed prompt; also the restore words)
 *   tool.execution_start   data.toolName (a tool used)
 * A session that used a tool resets its evidence, so a tool used from an
 * unmanaged launch is no longer a candidate at the next managed one.
 *
 * RESTORE. A left-out tool cannot be called, so "used anyway" can never be
 * seen for it; the restore signal is the person asking for it in words -- its
 * literal name, or the phrases in `MENTIONS`. That gives it back for good
 * (store.restored), as does `token-optimizer-learned toolprune restore
 * --copilot`.
 *
 * NEVER LEFT OUT: the shell, file and search tools every task needs, the
 * sub-agent tools `task` depends on to collect its results, and the tools a
 * person reaches for outside the repository (web_fetch, skill) -- for those
 * the model does not ask, it falls back or gives up, so the restore would never
 * fire. TOKEN_OPTIMIZER_TOOLPRUNE_KEEP adds names.
 *
 * Configuration: the TOKEN_OPTIMIZER_TOOLPRUNE* variables (toolprune.mjs).
 */

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { belongsTo } from './codexprune.mjs';
import {
  candidates,
  evidenceFor,
  foldSession,
  loadStore,
  MAX_FOLD_BYTES,
  saveStore,
  takeNotice,
  toolpruneSettings,
} from './toolprune.mjs';

export const COPILOT_STORE_FILE = 'copilotprune.json';
/** Sessions older than this are not read at all. */
export const SESSION_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
export const UNDO = 'token-optimizer-learned toolprune restore --copilot';

/** The tools Copilot CLI 1.0.107 sends in a `-p` session, captured with `--log-level all`. */
export const COPILOT_CATALOG = Object.freeze([
  'powershell', 'read_powershell', 'stop_powershell', 'list_powershell',
  'view', 'create', 'edit', 'grep', 'glob',
  'web_fetch', 'fetch_copilot_cli_documentation',
  'search_code_subagent', 'semantic_code_search',
  'skill', 'run_dynamic_workflow', 'dynamic_workflows_manage',
  'sql', 'session_store_sql',
  'task', 'read_agent', 'list_agents', 'write_agent',
  'image_generation',
  'github-mcp-server-get_copilot_space', 'github-mcp-server-get_file_contents',
  'github-mcp-server-list_copilot_spaces', 'github-mcp-server-search_code',
  'github-mcp-server-search_users',
]);

export const COPILOT_KEEP = Object.freeze([
  // The shell, on either platform, and its background-session companions.
  'powershell', 'read_powershell', 'write_powershell', 'stop_powershell', 'list_powershell',
  'bash', 'read_bash', 'write_bash', 'stop_bash', 'list_bash',
  'view', 'create', 'edit', 'grep', 'glob',
  // `task` starts sub-agents; these collect and steer them.
  'task', 'read_agent', 'list_agents', 'write_agent',
  // Reach outside the repository: pruned, the model does not ask for them.
  'web_fetch', 'skill',
  // Interactive-session plumbing that is not in the `-p` catalog.
  'ask_user', 'report_intent', 'update_todo',
]);

/**
 * Words that mean the person wants a tool, beyond typing its name. Specific on
 * purpose: a restore is permanent, so "the GitHub Actions workflow" must not
 * give back the dynamic-workflow tools, nor "the repo is on GitHub" the
 * github-mcp-server ones.
 */
export const MENTIONS = Object.freeze({
  image_generation: /\b(?:generate|create|draw|make|render)\b[^.\n]{0,40}\b(?:image|picture|logo|icon|illustration)s?\b/i,
  fetch_copilot_cli_documentation: /\bcopilot(?:[ -]cli)?\b[^.\n]{0,40}\b(?:docs?|documentation|help|flags?|options?|settings?|config(?:ure|uration)?)\b/i,
  run_dynamic_workflow: /\bdynamic[ _-]workflows?\b/i,
  dynamic_workflows_manage: /\bdynamic[ _-]workflows?\b/i,
  semantic_code_search: /\bsemantic(?:ally)?\b[^.\n]{0,20}\bsearch/i,
  search_code_subagent: /\bsemantic(?:ally)?\b[^.\n]{0,20}\bsearch/i,
  session_store_sql: /\b(?:session[ _-]store|past sessions?|previous sessions?|session history)\b/i,
  'github-mcp-server-get_copilot_space': /\bcopilot[ -]spaces?\b/i,
  'github-mcp-server-list_copilot_spaces': /\bcopilot[ -]spaces?\b/i,
  'github-mcp-server-search_code': /\bsearch\b[^.\n]{0,30}\bgithub\b|\bgithub (?:code )?search\b/i,
  'github-mcp-server-search_users': /\bgithub users?\b|\bsearch\b[^.\n]{0,30}\busers? on github\b/i,
  'github-mcp-server-get_file_contents': /\bgithub\.com\/[\w.-]+\/[\w.-]+\/(?:blob|tree)\//i,
});

export function copilotHome(env = process.env) {
  return env.COPILOT_HOME || join(homedir(), '.copilot');
}

/** This package's own MCP tools, as Copilot names them (`<server>-<tool>`). */
function isOwnCopilotTool(name) {
  return /^token[-_]?optimizer[-_]/i.test(String(name));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `text` asks for `name`: its literal name, or one of its phrases. */
export function mentions(text, name) {
  if (!text) return false;
  if (new RegExp(`(?<![\\w-])${escapeRegExp(name)}(?![\\w-])`, 'i').test(text)) return true;
  return Boolean(MENTIONS[name]?.test(text));
}

function readHead(path, bytes = 64 * 1024) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The session id and working directory from an events log's `session.start`. */
export function sessionMeta(path) {
  const head = readHead(path);
  for (const line of head.split('\n')) {
    if (!line.includes('"session.start"')) continue;
    try {
      const entry = JSON.parse(line);
      const id = entry?.data?.sessionId;
      const cwd = entry?.data?.context?.cwd;
      return id && cwd ? { id: String(id), cwd: String(cwd) } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * What one Copilot session says: typed prompts, tools used, and tools among
 * `mentionCandidates` the person asked for. Names only; no text leaves here.
 */
export function copilotSessionUsage(path, { maxBytes = MAX_FOLD_BYTES, mentionCandidates = [] } = {}) {
  let text;
  try {
    const size = statSync(path).size;
    text = size > maxBytes ? readFileSync(path, 'utf8').slice(-maxBytes) : readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const used = new Set();
  const mentioned = new Set();
  let prompts = 0;
  let lastAt = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(entry.timestamp || '');
    if (Number.isFinite(at)) lastAt = Math.max(lastAt, at);
    if (entry.type === 'tool.execution_start') {
      const name = entry.data?.toolName;
      if (typeof name === 'string' && name) used.add(name);
    } else if (entry.type === 'user.message') {
      prompts += 1;
      const said = typeof entry.data?.content === 'string' ? entry.data.content : '';
      for (const name of mentionCandidates) if (mentions(said, name)) mentioned.add(name);
    }
  }
  return { prompts, used: [...used], mentioned: [...mentioned], lastAt };
}

/** Every session log under `stateDir` touched within `maxAgeMs`, newest last. */
export function listSessions(stateDir, { now = Date.now(), maxAgeMs = SESSION_MAX_AGE_MS } = {}) {
  let entries;
  try {
    entries = readdirSync(stateDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(stateDir, entry.name, 'events.jsonl');
    try {
      const mtimeMs = statSync(path).mtimeMs;
      if (now - mtimeMs <= maxAgeMs) out.push({ path, mtimeMs });
    } catch {
      // A session that never got as far as a request has no events log.
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function copilotSettings(env) {
  const settings = toolpruneSettings(env);
  return { ...settings, keep: new Set([...settings.keep, ...COPILOT_KEEP]) };
}

/**
 * Fold this repository's new Copilot sessions and decide what to leave out.
 * Returns the names to pass to `--excluded-tools` (empty unless mode is auto).
 */
export function runCopilotFold({ dir, root, env = process.env, stateDir = join(copilotHome(env), 'session-state'), now = Date.now() }) {
  const settings = copilotSettings(env);
  let store = loadStore(dir, COPILOT_STORE_FILE);
  store.catalog = {
    tools: [...new Set([...COPILOT_CATALOG, ...(store.catalog.tools || [])])].sort(),
    probedAt: now,
    clientVersion: null,
  };
  const folded = new Map(store.sessions.map((session) => [session.sessionId, session.endedAt || 0]));
  let foldedNow = 0;
  for (const { path, mtimeMs } of listSessions(stateDir, { now })) {
    const meta = sessionMeta(path);
    if (!meta || !belongsTo(meta.cwd, root)) continue;
    if (folded.has(meta.id) && folded.get(meta.id) >= mtimeMs - 1000) continue;
    const usage = copilotSessionUsage(path, { mentionCandidates: store.applied });
    if (!usage || usage.prompts === 0) continue;
    store = foldSession(store, { ...usage, sessionId: meta.id, absent: [], lastAt: Math.max(usage.lastAt, mtimeMs) }, { now });
    foldedNow += 1;
  }
  // candidates() already skips restored names.
  const target = settings.mode === 'off'
    ? []
    : candidates(store, settings)
        .map((item) => item.name)
        .filter((name) => !isOwnCopilotTool(name));
  const previous = new Set(store.applied);
  const exclude = settings.mode === 'auto' ? target : [];
  const added = exclude.filter((name) => !previous.has(name));
  const removed = store.applied.filter((name) => !exclude.includes(name));
  store.applied = exclude;
  store.pending = settings.mode === 'propose' ? target : [];
  store.blocked = null;
  if (added.length || removed.length) store.lastChange = { at: now, added, removed };
  saveStore(dir, store, COPILOT_STORE_FILE);
  return { mode: settings.mode, folded: foldedNow, exclude, pending: store.pending, restored: store.restored };
}

/** What `token-optimizer-learned status` shows for Copilot. Read-only. */
export function copilotStatus(dir, env = process.env) {
  const store = loadStore(dir, COPILOT_STORE_FILE);
  return {
    sessionsFolded: store.sessions.length,
    applied: store.applied.map((name) => ({ name, ...evidenceFor(store, name) })),
    pending: store.pending.map((name) => ({ name, ...evidenceFor(store, name) })),
    restored: store.restored,
    mode: copilotSettings(env).mode,
  };
}

/** Give tools back by hand (`names` empty = every tool left out now). Never left out again. */
export function restoreCopilot({ dir, names = [] }) {
  const store = loadStore(dir, COPILOT_STORE_FILE);
  const giveBack = names.length ? names : [...store.applied];
  store.restored = [...new Set([...store.restored, ...giveBack])];
  store.applied = store.applied.filter((name) => !store.restored.includes(name));
  store.pending = store.pending.filter((name) => !store.restored.includes(name));
  saveStore(dir, store, COPILOT_STORE_FILE);
  return { ok: true, restored: giveBack };
}

export function takeCopilotNotice(dir, options = {}) {
  return takeNotice(dir, { ...options, file: COPILOT_STORE_FILE, what: 'Copilot tool', undo: UNDO });
}

/** True when the person already chose the tool set on this command line. */
export function choosesOwnTools(args) {
  const switches = args.indexOf('--') < 0 ? args : args.slice(0, args.indexOf('--'));
  return switches.some((arg) => /^--(?:available|excluded)-tools(?:=|$)/.test(String(arg)));
}

/**
 * The `--excluded-tools` arguments for a managed Copilot launch, plus the line
 * to show the person when the set changed. Never throws: a failure here must
 * cost the saving, not the launch.
 */
export function copilotExclusions({ args = [], env = process.env, dir, root, stateDir }) {
  try {
    // A token-optimizer side call (harvest) is not this repository's work.
    if (!dir || !root || env.TOKEN_OPTIMIZER_SIDECALL || choosesOwnTools(args)) return { args: [], notice: null };
    if (String(env.TOKEN_OPTIMIZER_MODE ?? '').trim().toLowerCase() === 'off') return { args: [], notice: null };
    const result = runCopilotFold({ dir, root, env, ...(stateDir ? { stateDir } : {}) });
    const notice = takeCopilotNotice(dir);
    // Variadic flag: the names run to the end of the list, which is why the
    // launcher appends this last (before any `--`).
    return { args: result.exclude.length ? ['--excluded-tools', ...result.exclude] : [], notice };
  } catch {
    return { args: [], notice: null };
  }
}

