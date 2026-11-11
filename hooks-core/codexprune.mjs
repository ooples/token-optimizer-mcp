/**
 * Learned capability pruning for Codex: switch off the built-in capabilities a
 * repository never uses, so their definitions stop riding on every request.
 *
 * WHY. Codex sends its sub-agent tools (spawn_agent, followup_task, wait_agent,
 * send_message, list_agents, interrupt_agent) and their role instructions with
 * every request. Measured with `codex debug prompt-input` on codex-cli 0.167.0
 * in a trusted project: 72078 bytes of prompt input, 60579 with the two
 * multi-agent switches below written to the project's `.codex/config.toml` --
 * 16% of the standing prefix, re-read on every turn of every session. Across 50
 * real sessions on this machine the sub-agent tools were never called once.
 * tool_suggest, apps and sleep_tool (2026-11-08) cut a further 7.3%, measured
 * from a trusted project's config.toml; see CODEX_CAPABILITIES.
 *
 * HOW IT DIFFERS FROM CLAUDE CODE PRUNING (toolprune.mjs). Codex has no
 * per-tool deny list; it has capability switches. So the unit here is a
 * capability -- a set of tools plus the config keys that remove them -- and
 * the decision is the same evidence rule toolprune uses (unused over
 * `evidence` prompts across `minSessions` sessions, or over `sessions`
 * sessions), on the same store shape, with the same automatic restore: a
 * session in which the capability was used anyway, or whose person asked for
 * it in words ("spawn sub-agents", a screenshot path), gives it back for good.
 *
 * WHERE IT WRITES. A managed block at the top of `<repo>/.codex/config.toml`,
 * as root-level dotted keys. Codex reads project config only for a project
 * marked trusted in `~/.codex/config.toml` (verified: the same file in an
 * untrusted repository changed nothing), so an untrusted project stays a
 * proposal and status says why. The file is never touched when:
 *   * it is tracked by git -- that is the team's config, not this machine's;
 *   * it already configures a table this block needs ([features], [agents]):
 *     TOML forbids defining a table twice, and a broken config.toml would stop
 *     Codex starting at all;
 *   * it is a symlink.
 * A file this module creates is added to `.git/info/exclude`.
 *
 * Codex reads its config when a session starts, so a write never changes a
 * session that is already running; no idle wait is needed.
 *
 * Configuration: the TOKEN_OPTIMIZER_TOOLPRUNE* variables (toolprune.mjs).
 */

import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomically } from './policy.mjs';
import {
  candidates,
  excludeFromGit,
  foldSession,
  loadStore,
  MAX_FOLD_BYTES,
  saveStore,
  takeNotice,
  toolpruneSettings,
} from './toolprune.mjs';

export const CODEX_STORE_FILE = 'codexprune.json';
export const CONFIG_RELATIVE = '.codex/config.toml';
export const BLOCK_BEGIN = '# >>> token-optimizer: capabilities this repository never used. Undo: token-optimizer-learned toolprune restore --codex';
export const BLOCK_END = '# <<< token-optimizer';
/** Sessions older than this are not read at all. */
export const SESSION_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

const COLLABORATION_TOOLS = new Set([
  'spawn_agent', 'followup_task', 'wait_agent', 'send_message', 'list_agents', 'interrupt_agent',
  // Names earlier Codex releases used for the same tools.
  'send_input', 'close_agent', 'resume_agent',
]);

/**
 * The capabilities Codex can switch off, the evidence that one was used, and
 * the words that mean the person wants it. Each `keys` entry is written as
 * `table.key = false`.
 */
export const CODEX_CAPABILITIES = Object.freeze([
  Object.freeze({
    id: 'multi_agent',
    keys: Object.freeze([['features', 'multi_agent'], ['agents', 'enabled']]),
    tools: COLLABORATION_TOOLS,
    namespace: 'collaboration',
    // Agent-specific phrasing only: a restore is permanent, so "run the tests
    // in parallel" or "spawn a process" must not cost this repository the saving.
    mention: /\b(?:sub-?agents?|multi-?agents?|spawn_agent|spawn[ ](?:an? |some |\d+ |more )?(?:sub-?)?agents?|parallel agents?|agents? in parallel)\b/i,
  }),
  Object.freeze({
    id: 'view_image',
    keys: Object.freeze([['features', 'view_image']]),
    tools: new Set(['view_image']),
    namespace: null,
    itemType: 'ImageView',
    mention: /\.(?:png|jpe?g|gif|webp|bmp)\b|\bscreenshots?\b/i,
  }),
  // Measured with `codex debug prompt-input` on 0.167.0 (71,679 bytes baseline):
  //   tool_suggest -2,159: request_plugin_install plus a <recommended_plugins>
  //     advert for plugins that are NOT installed -- no use to the repository.
  //   apps -4,335: the ChatGPT apps deferred namespaces (mcp__codex_apps__*)
  //     plus that same advert.
  //   sleep_tool -881: the clock.sleep tool.
  // NOT `plugins`: it also drops the skills instructions, which would take
  // this package's own Codex skill with it.
  Object.freeze({
    id: 'tool_suggest',
    keys: Object.freeze([['features', 'tool_suggest']]),
    tools: new Set(['request_plugin_install']),
    namespace: null,
    mention: /\brequest_plugin_install\b|\brecommended plugins?\b|\binstall (?:the |a |an )?[\w.-]+ plugin\b|\bplugins? to install\b/i,
  }),
  Object.freeze({
    id: 'apps',
    keys: Object.freeze([['features', 'apps']]),
    tools: new Set(),
    namespace: null,
    // Calls arrive as `_search_issues` in namespace `mcp__codex_apps__github`.
    namespacePrefix: 'mcp__codex_apps',
    mention: /\bmcp__codex_apps\b|\bchatgpt (?:apps?|spaces?|connectors?)\b|\bcodex apps?\b|\bconnectors?\b/i,
  }),
  Object.freeze({
    id: 'sleep_tool',
    keys: Object.freeze([['features', 'sleep_tool']]),
    tools: new Set(['sleep']),
    namespace: 'clock',
    // Not "wait" or "poll" on their own: the shell can sleep too, and a restore is permanent.
    mention: /\bclock\.sleep\b|\bsleep tool\b|\bwait (?:for )?\d+\s*(?:ms|s|secs?|seconds?|mins?|minutes?)\b/i,
  }),
]);

const capabilityById = new Map(CODEX_CAPABILITIES.map((cap) => [cap.id, cap]));

export function codexHome(env = process.env) {
  return env.CODEX_HOME || join(homedir(), '.codex');
}

// Windows paths compare case-insensitively; Codex lower-cases its trust keys there.
const norm = (path) => {
  const full = resolvePath(String(path)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? full.toLowerCase() : full;
};

/**
 * True when a session launched in `cwd` belongs to the project at `root`:
 * `cwd` is inside it and no nearer repository claims it first. Without the
 * second rule a home-directory store would fold every repository's sessions.
 */
export function belongsTo(cwd, root) {
  const target = norm(root);
  // An unrooted launch directory (learnedLocation) owns only its own sessions.
  if (!existsSync(join(root, '.git'))) return norm(cwd) === target;
  let current = resolvePath(String(cwd));
  for (let depth = 0; depth < 64; depth += 1) {
    if (norm(current) === target) return true;
    if (existsSync(join(current, '.git'))) return false;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Reading one rollout.

function readHead(path, bytes = 512 * 1024) {
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

/** The session id and working directory from a rollout's first line. */
export function rolloutMeta(path) {
  const head = readHead(path);
  const newline = head.indexOf('\n');
  if (newline < 0) return null;
  try {
    const first = JSON.parse(head.slice(0, newline));
    if (first?.type !== 'session_meta') return null;
    const id = first.payload?.id ?? first.payload?.session_id;
    const cwd = first.payload?.cwd;
    return id && cwd ? { id: String(id), cwd: String(cwd) } : null;
  } catch {
    return null;
  }
}

function bareName(name) {
  const text = String(name || '');
  const dot = text.lastIndexOf('.');
  return dot >= 0 ? text.slice(dot + 1) : text;
}

function namespaceOf(name) {
  const text = String(name || '');
  const dot = text.lastIndexOf('.');
  return dot >= 0 ? text.slice(0, dot) : '';
}

/** Which capability a tool call belongs to, or null. */
export function capabilityOfCall(name, namespace = '') {
  const space = namespace || namespaceOf(name);
  const bare = bareName(name);
  for (const cap of CODEX_CAPABILITIES) {
    if (cap.namespacePrefix && (String(space).startsWith(cap.namespacePrefix) || String(name).startsWith(cap.namespacePrefix))) return cap.id;
  }
  // An MCP server's own `send_message` is not a sub-agent tool.
  if (String(space).startsWith('mcp__') || String(name).startsWith('mcp__')) return null;
  for (const cap of CODEX_CAPABILITIES) {
    if (!cap.tools.has(bare)) continue;
    if (space && cap.namespace && space !== cap.namespace && space !== 'functions') continue;
    return cap.id;
  }
  return null;
}

function promptText(item) {
  const content = Array.isArray(item?.content) ? item.content : [];
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

const IMAGE_BLOCK = /^(?:image|local_image|input_image)$/;

/**
 * What one Codex rollout says: typed prompts, capabilities used, and
 * capabilities among `mentionCandidates` the person asked for. Ids only; no
 * text leaves this function.
 */
export function codexSessionUsage(path, { maxBytes = MAX_FOLD_BYTES, mentionCandidates = [] } = {}) {
  let text;
  try {
    const size = statSync(path).size;
    text = size > maxBytes ? readFileSync(path, 'utf8').slice(-maxBytes) : readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const used = new Set();
  const mentioned = new Set();
  const watch = mentionCandidates.map((id) => capabilityById.get(id)).filter(Boolean);
  let typed = 0;
  let fallbackPrompts = 0;
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
    const payload = entry.payload || {};
    if (entry.type === 'response_item') {
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        const cap = capabilityOfCall(payload.name, payload.namespace);
        if (cap) used.add(cap);
      } else if (payload.type === 'message' && payload.role === 'user') {
        // Older rollouts carry no UserMessage item; count user messages that
        // are not client-written context (AGENTS.md, <environment_context>).
        const body = (Array.isArray(payload.content) ? payload.content : [])
          .map((block) => (typeof block?.text === 'string' ? block.text : ''))
          .join('\n')
          .trim();
        if (body && !/^(?:<|# AGENTS\.md instructions)/.test(body)) fallbackPrompts += 1;
      }
      continue;
    }
    if (entry.type !== 'event_msg' || payload.type !== 'item_completed') continue;
    const item = payload.item || {};
    if (item.type === 'UserMessage') {
      typed += 1;
      const said = promptText(item);
      const withImage = (item.content || []).some((block) => IMAGE_BLOCK.test(String(block?.type)));
      for (const cap of watch) {
        if (cap.mention.test(said) || (cap.id === 'view_image' && withImage)) mentioned.add(cap.id);
      }
      continue;
    }
    for (const cap of CODEX_CAPABILITIES) {
      if (cap.itemType && item.type === cap.itemType) used.add(cap.id);
    }
    // Namespaced tools run inside code mode surface as Extension items whose
    // kind is "<namespace>.<tool>".
    if (item.type === 'Extension' && typeof item.kind === 'string') {
      const cap = capabilityOfCall(item.kind);
      if (cap) used.add(cap);
    }
    if (/^Collab/i.test(String(item.type))) used.add('multi_agent');
  }
  return { prompts: typed || fallbackPrompts, used: [...used], mentioned: [...mentioned], lastAt };
}

/** Every rollout under `sessionsDir` touched within `maxAgeMs`, newest last. */
export function listRollouts(sessionsDir, { now = Date.now(), maxAgeMs = SESSION_MAX_AGE_MS } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 4) walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const mtimeMs = statSync(path).mtimeMs;
          if (now - mtimeMs <= maxAgeMs) out.push({ path, mtimeMs });
        } catch {
          // Removed while listing.
        }
      }
    }
  };
  walk(sessionsDir, 0);
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

// ---------------------------------------------------------------------------
// Trust and the config file.

/** Whether `~/.codex/config.toml` marks exactly this project root trusted. */
export function isTrusted(root, { home = codexHome() } = {}) {
  let text;
  try {
    text = readFileSync(join(home, 'config.toml'), 'utf8');
  } catch {
    return false;
  }
  const want = norm(root);
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = line.match(/^\[\s*projects\.(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\s*\]$/);
    if (header) {
      const key = header[1] ?? header[2].replace(/\\\\/g, '\\');
      current = norm(key) === want ? 'match' : null;
      continue;
    }
    if (line.startsWith('[')) {
      current = null;
      continue;
    }
    if (current === 'match' && /^trust_level\s*=\s*["']trusted["']/.test(line)) return true;
  }
  return false;
}

export function configPath(root) {
  return join(root, '.codex', 'config.toml');
}

function isTracked(root, relative) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', relative], { cwd: root, stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** Split a config file into the user's text and the ids our block switches off. */
export function parseConfig(text) {
  // A CRLF file stays CRLF: a restore must give back exactly what was there.
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const begin = lines.findIndex((line) => line.startsWith(BLOCK_BEGIN.slice(0, 30)));
  const end = begin >= 0 ? lines.findIndex((line, index) => index > begin && line.trim() === BLOCK_END) : -1;
  if (begin < 0 || end < 0) return { user: text, owned: [], eol };
  const block = lines.slice(begin + 1, end);
  const owned = CODEX_CAPABILITIES.filter((cap) =>
    cap.keys.every(([table, key]) => block.some((line) => line.trim() === `${table}.${key} = false`))
  ).map((cap) => cap.id);
  // The block is followed by one separating blank line when there is user text.
  const rest = lines.slice(end + 1);
  if (begin === 0 && rest.length > 1 && rest[0] === '') rest.shift();
  const user = [...lines.slice(0, begin), ...rest].join(eol);
  return { user, owned, eol };
}

/** The tables of `capIds` the user's own text already defines, if any. */
export function conflictingTables(userText, capIds) {
  const tables = new Set(capIds.flatMap((id) => capabilityById.get(id)?.keys.map(([table]) => table) || []));
  const hits = [];
  for (const table of tables) {
    const header = new RegExp(`^\\s*\\[\\s*${table}\\s*[\\].]`, 'm');
    const dotted = new RegExp(`^\\s*${table}\\s*[.=]`, 'm');
    if (header.test(userText) || dotted.test(userText)) hits.push(table);
  }
  return hits;
}

export function renderBlock(capIds, eol = '\n') {
  if (!capIds.length) return '';
  const lines = [BLOCK_BEGIN];
  for (const id of capIds) {
    for (const [table, key] of capabilityById.get(id)?.keys || []) lines.push(`${table}.${key} = false`);
  }
  lines.push(BLOCK_END);
  return `${lines.join(eol)}${eol}`;
}

/**
 * Make the managed block switch off exactly `wanted`. The block found in the
 * file, not a remembered list, is what counts as already applied.
 * @returns {{ok: true, owned: string[], added: string[], removed: string[], skipped: string[], reason?: string} | {ok: false, reason: string}}
 */
export function writeCodexConfig(root, wanted, { home = codexHome(), checkTracked = isTracked } = {}) {
  const path = configPath(root);
  // Launched from the home directory, the "project" file is the global one.
  // A block there would switch the capability off in every repository, on the
  // evidence of this one; that is not this module's call to make.
  if (norm(path) === norm(join(home, 'config.toml'))) {
    return { ok: false, reason: 'the project config here is the global ~/.codex/config.toml' };
  }
  let existed = false;
  let text = '';
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return { ok: false, reason: '.codex/config.toml is a symlink' };
    existed = true;
    text = readFileSync(path, 'utf8');
  } catch {
    // Not there yet.
  }
  const parsed = parseConfig(text);
  const ownedNow = parsed.owned;
  // A capability whose table the user's own text defines cannot be written:
  // TOML forbids defining a table twice, and Codex refuses to start on an
  // invalid config. That includes one already in the block -- if the user has
  // since added a [features] table, the block entry is taken out, which is
  // what keeps their Codex starting.
  const skipped = CODEX_CAPABILITIES.map((cap) => cap.id).filter(
    (id) => wanted.includes(id) && conflictingTables(parsed.user, [id]).length
  );
  const target = CODEX_CAPABILITIES.map((cap) => cap.id).filter((id) => wanted.includes(id) && !skipped.includes(id));
  const added = target.filter((id) => !ownedNow.includes(id));
  const removed = ownedNow.filter((id) => !target.includes(id));
  const note = skipped.length
    ? { reason: `.codex/config.toml already configures [${conflictingTables(parsed.user, skipped).join('], [')}]` }
    : {};
  if (!added.length && !removed.length) return { ok: true, owned: ownedNow, added, removed, skipped, ...note };
  if (added.length) {
    if (!isTrusted(root, { home })) return { ok: false, reason: 'Codex does not trust this project, so it would ignore .codex/config.toml' };
    if (existed && checkTracked(root, CONFIG_RELATIVE)) return { ok: false, reason: '.codex/config.toml is tracked by git' };
  }
  // Root-level dotted keys must come before the first table header, so the
  // block always goes at the very top.
  const separator = target.length && parsed.user ? parsed.eol : '';
  const next = `${renderBlock(target, parsed.eol)}${separator}${parsed.user}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeAtomically(path, next);
  } catch (error) {
    return { ok: false, reason: `could not write .codex/config.toml (${error?.code || 'error'})` };
  }
  if (!existed) excludeFromGit(root, CONFIG_RELATIVE);
  return { ok: true, owned: target, added, removed, skipped, ...note };
}

// ---------------------------------------------------------------------------
// The decision.

export function runCodexFold({ dir, root, sessionsDir = join(codexHome(), 'sessions'), env = process.env, home = codexHome(env), now = Date.now(), checkTracked }) {
  const settings = toolpruneSettings(env);
  let store = loadStore(dir, CODEX_STORE_FILE);
  store.catalog = { tools: CODEX_CAPABILITIES.map((cap) => cap.id), probedAt: now, clientVersion: null };
  const folded = new Map(store.sessions.map((session) => [session.sessionId, session.endedAt || 0]));
  let foldedNow = 0;
  for (const { path, mtimeMs } of listRollouts(sessionsDir, { now })) {
    const meta = rolloutMeta(path);
    if (!meta || !belongsTo(meta.cwd, root)) continue;
    if (folded.has(meta.id) && folded.get(meta.id) >= mtimeMs - 1000) continue;
    const usage = codexSessionUsage(path, { mentionCandidates: store.applied });
    if (!usage || usage.prompts === 0) continue;
    // Used while switched off means the switch did not hold or the person
    // turned it back on: either way it is wanted, so it is given back.
    const absent = usage.used.filter((id) => store.applied.includes(id));
    store = foldSession(store, { ...usage, sessionId: meta.id, absent, lastAt: Math.max(usage.lastAt, mtimeMs) }, { now });
    foldedNow += 1;
  }
  if (settings.mode === 'off') {
    saveStore(dir, store, CODEX_STORE_FILE);
    return { mode: 'off', folded: foldedNow };
  }
  const wanted = candidates(store, settings).map((item) => item.name);
  const restored = new Set(store.restored);
  const target = wanted.filter((id) => !restored.has(id));
  store.pending = target.filter((id) => !store.applied.includes(id));
  store.blocked = null;
  // Always reconciled against the file, not the remembered list: a block the
  // person deleted by hand, or a [features] table they added since, is seen.
  if (settings.mode === 'auto') {
    const result = writeCodexConfig(root, target, { home, ...(checkTracked ? { checkTracked } : {}) });
    if (result.ok) {
      store.applied = result.owned;
      store.pending = target.filter((id) => !store.applied.includes(id));
      store.blocked = result.reason || null;
      if (result.added.length || result.removed.length) {
        store.lastApplyAt = now;
        store.lastChange = { at: now, added: result.added, removed: result.removed };
      }
    } else {
      store.blocked = result.reason;
    }
  }
  saveStore(dir, store, CODEX_STORE_FILE);
  return { mode: settings.mode, folded: foldedNow, applied: store.applied, pending: store.pending, restored: store.restored, blocked: store.blocked };
}

/** Give capabilities back by hand (`ids` empty = all). Never pruned again. */
export function restoreCodex({ dir, root, ids = [], home = codexHome() }) {
  const store = loadStore(dir, CODEX_STORE_FILE);
  const giveBack = ids.length ? store.applied.filter((id) => ids.includes(id)) : [...store.applied];
  const result = writeCodexConfig(root, store.applied.filter((id) => !giveBack.includes(id)), { home });
  if (!result.ok) return result;
  store.applied = result.owned;
  store.restored = [...new Set([...store.restored, ...giveBack, ...ids])];
  store.pending = store.pending.filter((id) => !store.restored.includes(id));
  saveStore(dir, store, CODEX_STORE_FILE);
  return { ok: true, restored: giveBack };
}

export function takeCodexNotice(dir, options = {}) {
  return takeNotice(dir, {
    ...options,
    file: CODEX_STORE_FILE,
    what: 'Codex capability',
    undo: 'token-optimizer-learned toolprune restore --codex',
  });
}

/** Called at a Codex SessionStart: folds in a detached process, returns at once. */
export function scheduleCodexFold({ dir, root, env = process.env }) {
  if (toolpruneSettings(env).mode === 'off' || env.TOKEN_OPTIMIZER_SIDECALL || !dir || !root) return false;
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--fold', dir, root], {
      cwd: tmpdir(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...env },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

if (process.argv[2] === '--fold' && process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  try {
    runCodexFold({ dir: process.argv[3], root: process.argv[4] });
  } catch {
    // The next session start retries.
  }
}
