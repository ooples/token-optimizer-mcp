// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/toolprune.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Learned tool pruning: stop sending the definitions of tools this repository
 * never uses.
 *
 * WHY. Every tool a session loads is sent, schema and all, with every request,
 * and a long session re-reads that prefix hundreds of times. In TokenEconomizer's
 * SWE-Bench traces 16 of 23 loaded tools were never called, and pruning them was
 * the largest single saving of anything they measured (-13% and -18% of task
 * cost on Claude Code, alone). That evidence is the case for building this; what
 * follows is where this implementation goes further.
 *
 * WHAT IT DOES. Finished sessions are folded, in a detached process, into a
 * per-repository record of which tools were called across how many prompts. A
 * tool unused over `evidence` prompts spanning `minSessions` sessions, or over
 * `sessions` sessions of any length, becomes a candidate. Candidates are written
 * as bare-name `permissions.deny` rules into the project's
 * `.claude/settings.local.json` -- verified to remove the tool from the request,
 * the same as `--disallowed-tools` -- and only:
 *
 *   * when every OTHER session of the repository has been idle for
 *     `quietMinutes`. A running session keeps its tools, but a conversation
 *     RESUMED after its tool list changes re-writes its whole history to the
 *     cache instead of reading it. After an idle hour that cache has expired
 *     anyway, so the change costs nothing it would not already have cost;
 *   * never for a tool on the keep list (the file and shell tools the rest of
 *     this package routes through, AskUserQuestion, plan mode, ToolSearch, Skill,
 *     and this package's own MCP tools), nor one the user allowed explicitly;
 *   * never for a tool that was restored -- a restore is permanent.
 *
 * WHERE IT GOES FURTHER THAN THE PRIOR ART.
 *
 *   1. RESTORE IS AUTOMATIC. A wrong prune is noticed, not waited out: a session
 *      whose model called a pruned tool (and got "No such tool available"), or
 *      whose user named one in a prompt, gives it back at the next fold and the
 *      tool is never pruned again. The prior art restores only on command or at
 *      the next re-audit.
 *   2. THE CATALOG NEEDS NO COMMAND. The tool list a fresh session loads is not
 *      in an interactive transcript. It is read from `claude -p`'s stream-json
 *      init event, in the background, and the process is killed before the
 *      model is asked anything -- automatically once per week, rather than on a
 *      command the person has to know to run after every client update.
 *   3. IT NEVER EDITS WHAT IT DID NOT WRITE. Only deny entries it recorded
 *      adding are ever removed; a settings file that is not valid JSON or is a
 *      symlink is never touched (the list stays a proposal and status says why).
 *
 * Configuration (all optional):
 *   TOKEN_OPTIMIZER_TOOLPRUNE=auto|propose|off      default auto
 *   TOKEN_OPTIMIZER_TOOLPRUNE_EVIDENCE=10           prompts unused
 *   TOKEN_OPTIMIZER_TOOLPRUNE_MIN_SESSIONS=2        sessions those prompts span
 *   TOKEN_OPTIMIZER_TOOLPRUNE_SESSIONS=5            or this many sessions
 *   TOKEN_OPTIMIZER_TOOLPRUNE_QUIET_MINUTES=60      idle time before a write
 *   TOKEN_OPTIMIZER_TOOLPRUNE_KEEP=ToolA,ToolB      never prune these
 */

import { spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomically } from './policy.mjs';
import { decide as decideHoldout, holdoutSettings, recordOutcome } from './injection-holdout.mjs';
import { projectRootFor, unrootedRoot, wikiDir } from './wiki.mjs';
import { canonicalPath } from './paths.mjs';

export const TOOLPRUNE_MODES = Object.freeze(['auto', 'propose', 'off']);
export const STORE_FILE = 'toolprune.json';
export const STORE_VERSION = 1;

/** Sessions kept per repository; older ones no longer decide anything. */
export const MAX_SESSIONS = 60;
/** Transcripts larger than this are folded from their last bytes only. */
export const MAX_FOLD_BYTES = 48 * 1024 * 1024;
/** How often the background catalog probe may run. */
export const CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Never pruned, whatever the evidence says. The file and shell tools are what
 * this package's own routing and refusals depend on; the rest are interaction
 * surfaces whose rarity says nothing about their value (a person who asks one
 * question a month still needs AskUserQuestion that day).
 */
export const KEEP = Object.freeze([
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookRead', 'Bash', 'PowerShell', 'Glob', 'Grep',
  'LS', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'ToolSearch', 'Skill', 'Task', 'Agent',
  // A person's reach outside the repository. Pruned, the model does not ask for
  // them -- it falls back to curl or says it cannot search -- so the automatic
  // restore, which waits for a failed call or a typed name, would never fire.
  'WebFetch', 'WebSearch',
]);

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function toolpruneSettings(env = process.env) {
  const mode = String(env.TOKEN_OPTIMIZER_TOOLPRUNE ?? '').trim().toLowerCase();
  return {
    mode: TOOLPRUNE_MODES.includes(mode) ? mode : 'auto',
    evidence: num(env.TOKEN_OPTIMIZER_TOOLPRUNE_EVIDENCE, 10),
    minSessions: num(env.TOKEN_OPTIMIZER_TOOLPRUNE_MIN_SESSIONS, 2),
    sessions: num(env.TOKEN_OPTIMIZER_TOOLPRUNE_SESSIONS, 5),
    quietMinutes: num(env.TOKEN_OPTIMIZER_TOOLPRUNE_QUIET_MINUTES, 60),
    keep: new Set([
      ...KEEP,
      ...String(env.TOKEN_OPTIMIZER_TOOLPRUNE_KEEP ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    ]),
  };
}

/** This package's own MCP tools are never pruned: the hooks route to them. */
export function isOwnTool(name) {
  return /^mcp__.*token[-_]?optimizer.*__/i.test(String(name));
}

// ---------------------------------------------------------------------------
// The per-repository store.

export function emptyStore() {
  return {
    version: STORE_VERSION,
    catalog: { tools: [], probedAt: 0, clientVersion: null },
    sessions: [],
    applied: [],
    restored: [],
    pending: [],
    lastApplyAt: 0,
    blocked: null,
  };
}

export function storePath(dir) {
  return join(dir, STORE_FILE);
}

export function loadStore(dir) {
  try {
    const parsed = JSON.parse(readFileSync(storePath(dir), 'utf8'));
    if (!parsed || parsed.version !== STORE_VERSION) return emptyStore();
    const base = emptyStore();
    return {
      ...base,
      ...parsed,
      catalog: { ...base.catalog, ...(parsed.catalog || {}) },
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      applied: Array.isArray(parsed.applied) ? parsed.applied : [],
      restored: Array.isArray(parsed.restored) ? parsed.restored : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
    };
  } catch {
    return emptyStore();
  }
}

export function saveStore(dir, store) {
  mkdirSync(dir, { recursive: true });
  writeAtomically(storePath(dir), JSON.stringify(store, null, 2));
}

// ---------------------------------------------------------------------------
// Reading one finished session.

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  if (content.some((block) => block?.type === 'tool_result')) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/** A user line the person typed, as opposed to a command echo or a reminder. */
function isPrompt(entry, text) {
  if (entry.isMeta || entry.isSidechain || entry.isCompactSummary) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Anything that opens with a tag was written by the client, not typed:
  // <task-notification>, <command-name>, <system-reminder>, artifact echoes.
  // Measured on a real session: 203 "prompts" by the naive count, 48 typed.
  if (/^<[A-Za-z][\w-]*[\s>/]/.test(trimmed)) return false;
  return !/^This session is being continued from a previous conversation/.test(trimmed);
}

const TOOL_ABSENT = /no such tool available|tool .* (?:is )?not available|unknown tool/i;

/**
 * What one transcript says about tool use: prompts, tools called, tools the
 * model reached for and could not have, and tool names the person typed.
 * Names only; no text leaves this function.
 */
export function sessionUsage(transcriptPath, { maxBytes = MAX_FOLD_BYTES, mentionCandidates = [] } = {}) {
  let text = '';
  try {
    const size = statSync(transcriptPath).size;
    if (size > maxBytes) {
      const buffer = Buffer.alloc(maxBytes);
      const fd = openSyncSafe(transcriptPath);
      if (fd == null) return null;
      try {
        readSyncAt(fd, buffer, size - maxBytes);
      } finally {
        closeSyncSafe(fd);
      }
      text = buffer.toString('utf8');
      text = text.slice(text.indexOf('\n') + 1);
    } else {
      text = readFileSync(transcriptPath, 'utf8');
    }
  } catch {
    return null;
  }

  const used = new Set();
  const absent = new Set();
  const mentioned = new Set();
  const attempted = new Map();
  const watch = mentionCandidates.filter((name) => /^[A-Za-z][\w-]{2,}$/.test(name));
  // Usage per model response. Claude Code writes one response as several rows
  // sharing a message.id, each carrying the usage SO FAR, so only the last row
  // per id counts: summing every row overstated cache reads 1.8x.
  const usageById = new Map();
  let prompts = 0;
  let firstAt = 0;
  let lastAt = 0;
  let sessionId = null;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isSidechain) continue;
    sessionId = sessionId || entry.sessionId || entry.session_id || null;
    const at = Date.parse(entry.timestamp || '') || 0;
    if (at) {
      firstAt = firstAt ? Math.min(firstAt, at) : at;
      lastAt = Math.max(lastAt, at);
    }
    const message = entry.message || entry;
    const role = message.role || entry.type;
    const content = message.content;
    if (role === 'assistant' && message.usage && typeof message.usage === 'object') {
      usageById.set(String(message.id || entry.uuid || usageById.size), message.usage);
    }
    if (role === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
        used.add(block.name);
        if (block.id) attempted.set(String(block.id), block.name);
      }
      continue;
    }
    if (role !== 'user') continue;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'tool_result' || block.is_error !== true) continue;
        const name = attempted.get(String(block.tool_use_id || ''));
        if (!name) continue;
        const body = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
            : '';
        if (TOOL_ABSENT.test(body)) absent.add(name);
      }
    }
    const typed = textOf(content);
    if (!isPrompt(entry, typed)) continue;
    prompts += 1;
    for (const name of watch) {
      if (new RegExp(`\\b${name.replace(/[-]/g, '\\-')}\\b`).test(typed)) mentioned.add(name);
    }
  }

  // A tool that only ever failed as absent was not "used"; it was missing.
  for (const name of absent) used.delete(name);
  let costUnits = 0;
  for (const usage of usageById.values()) costUnits += costUnitsOf(usage);
  return {
    costUnits,
    sessionId: sessionId || basename(transcriptPath).replace(/\.jsonl$/i, ''),
    prompts,
    used: [...used].sort(),
    absent: [...absent].sort(),
    mentioned: [...mentioned].sort(),
    firstAt,
    lastAt,
  };
}

/**
 * Cache-aware cost of one response in fresh-input-token equivalents, at the
 * ratios every current Claude model bills: cached read 0.1x, 5-minute write
 * 1.25x, 1-hour write 2x, output 5x. A unit, not dollars -- comparisons between
 * sessions of one repository need the ratio, and the ratio is model-independent
 * across the Claude family.
 */
export function costUnitsOf(usage) {
  const n = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
  const creation = usage.cache_creation || {};
  const write1h = n(creation.ephemeral_1h_input_tokens);
  const write5m = creation.ephemeral_5m_input_tokens != null
    ? n(creation.ephemeral_5m_input_tokens)
    : Math.max(0, n(usage.cache_creation_input_tokens) - write1h);
  return (
    n(usage.input_tokens) +
    0.1 * n(usage.cache_read_input_tokens) +
    1.25 * write5m +
    2 * write1h +
    5 * n(usage.output_tokens)
  );
}

// Small fs wrappers so a failed open never throws past sessionUsage.
function openSyncSafe(path) {
  try {
    return openSync(path, 'r');
  } catch {
    return null;
  }
}
function readSyncAt(fd, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const read = readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (!read) break;
    offset += read;
  }
}
function closeSyncSafe(fd) {
  try {
    closeSync(fd);
  } catch {
    // Already closed.
  }
}

// ---------------------------------------------------------------------------
// Folding sessions into evidence.

/**
 * Record one session. Idempotent: folding the same session again replaces its
 * record, so a fold interrupted part-way and retried counts nothing twice.
 */
export function foldSession(store, usage, { now = Date.now() } = {}) {
  if (!usage || !usage.sessionId) return store;
  const others = store.sessions.filter((session) => session.sessionId !== usage.sessionId);
  const record = {
    sessionId: usage.sessionId,
    prompts: usage.prompts,
    used: usage.used,
    endedAt: usage.lastAt || now,
  };
  const sessions = [...others, record]
    .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0))
    .slice(-MAX_SESSIONS);

  // A wrong prune, noticed: given back now and never pruned again.
  const wanted = new Set([...(usage.absent || []), ...(usage.mentioned || [])]);
  const restoreNow = store.applied.filter((name) => wanted.has(name));
  const restored = [...new Set([...store.restored, ...restoreNow])];
  return {
    ...store,
    sessions,
    restored,
    pending: store.pending.filter((name) => !restored.includes(name)),
    autoRestored: [...new Set([...(store.autoRestored || []), ...restoreNow])],
  };
}

/** Evidence for one tool: prompts and sessions since it was last used. */
export function evidenceFor(store, name) {
  let prompts = 0;
  let sessions = 0;
  for (let index = store.sessions.length - 1; index >= 0; index -= 1) {
    const session = store.sessions[index];
    if (session.used.includes(name)) break;
    prompts += session.prompts;
    sessions += 1;
  }
  return { prompts, sessions };
}

/** Every tool known to this repository: the probed catalog plus what was used. */
export function knownTools(store) {
  const names = new Set(store.catalog.tools || []);
  for (const session of store.sessions) for (const name of session.used) names.add(name);
  return [...names].sort();
}

/**
 * The tools the evidence says to leave out.
 * @param {object} store
 * @param {object} [settings]
 * @param {Set<string>} [allowedByUser] names the user's own `permissions.allow` lists
 */
export function candidates(store, settings = toolpruneSettings(), allowedByUser = new Set()) {
  const restored = new Set(store.restored);
  const out = [];
  for (const name of knownTools(store)) {
    if (settings.keep.has(name) || isOwnTool(name) || restored.has(name) || allowedByUser.has(name)) continue;
    const { prompts, sessions } = evidenceFor(store, name);
    const byPrompts = prompts >= settings.evidence && sessions >= settings.minSessions;
    const bySessions = sessions >= settings.sessions;
    if (byPrompts || bySessions) out.push({ name, prompts, sessions });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The settings file.

export function settingsPath(root) {
  return join(root, '.claude', 'settings.local.json');
}

/**
 * Read the project-local settings for editing, or say why it cannot be edited.
 * @returns {{ok: true, json: object, existed: boolean} | {ok: false, reason: string}}
 */
export function readSettings(root) {
  const path = settingsPath(root);
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return { ok: false, reason: 'settings.local.json is a symlink' };
  } catch {
    return { ok: true, json: {}, existed: false };
  }
  try {
    const json = JSON.parse(readFileSync(path, 'utf8'));
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return { ok: false, reason: 'settings.local.json is not a JSON object' };
    }
    return { ok: true, json, existed: true };
  } catch {
    return { ok: false, reason: 'settings.local.json is not valid JSON' };
  }
}

function permissionList(json, key) {
  const list = json?.permissions?.[key];
  return Array.isArray(list) ? list.filter((item) => typeof item === 'string') : [];
}

/** Bare tool names the user allowed; an allow is an explicit statement of need. */
export function allowedTools(root) {
  const read = readSettings(root);
  if (!read.ok) return new Set();
  return new Set(permissionList(read.json, 'allow').map((rule) => rule.replace(/\(.*$/, '')));
}

function excludeFromGit(root) {
  const exclude = join(root, '.git', 'info', 'exclude');
  try {
    if (!existsSync(join(root, '.git', 'info'))) return;
    const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (current.split(/\r?\n/).some((line) => line.trim() === '.claude/settings.local.json')) return;
    appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}.claude/settings.local.json\n`);
  } catch {
    // Not a git checkout, or not writable: the file is still correct.
  }
}

/**
 * Make the deny list hold exactly `wanted` among the entries this package owns.
 * Entries the user wrote are never added to `owned` and never removed.
 *
 * @returns {{ok: true, owned: string[], added: string[], removed: string[]} | {ok: false, reason: string}}
 */
export function writeDenyList(root, owned, wanted) {
  const read = readSettings(root);
  if (!read.ok) return read;
  const json = read.json;
  const deny = permissionList(json, 'deny');
  const ownedSet = new Set(owned);
  const wantedSet = new Set(wanted);
  // Ours to remove: owned and no longer wanted.
  const removed = [...ownedSet].filter((name) => !wantedSet.has(name));
  // Ours to add: wanted and not already present (a user rule already denying
  // it stays the user's, and is not adopted).
  const present = new Set(deny);
  const added = [...wantedSet].filter((name) => !present.has(name));
  const keptOwned = [...ownedSet].filter((name) => wantedSet.has(name));
  if (!added.length && !removed.length) {
    return { ok: true, owned: keptOwned, added, removed };
  }
  const nextDeny = [...deny.filter((rule) => !removed.includes(rule)), ...added];
  const next = { ...json, permissions: { ...(json.permissions || {}), deny: nextDeny } };
  try {
    mkdirSync(dirname(settingsPath(root)), { recursive: true });
    writeAtomically(settingsPath(root), `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    return { ok: false, reason: `could not write settings.local.json (${error?.code || 'error'})` };
  }
  if (!read.existed) excludeFromGit(root);
  return { ok: true, owned: [...keptOwned, ...added], added, removed };
}

// ---------------------------------------------------------------------------
// Idleness.

/**
 * Milliseconds since any session of this project other than `currentSession`
 * last wrote its transcript; Infinity when there is none.
 */
export function idleMs(transcriptDir, currentSession, { now = Date.now() } = {}) {
  let latest = 0;
  try {
    for (const name of readdirSync(transcriptDir)) {
      if (!name.endsWith('.jsonl')) continue;
      if (currentSession && name === `${currentSession}.jsonl`) continue;
      try {
        latest = Math.max(latest, statSync(join(transcriptDir, name)).mtimeMs);
      } catch {
        // Removed between the listing and the stat.
      }
    }
  } catch {
    return Infinity;
  }
  return latest ? now - latest : Infinity;
}

// ---------------------------------------------------------------------------
// The decision, run in the background.

/**
 * Fold every finished session not yet folded, then hold or write the deny list.
 *
 * @param {object} args
 * @param {string} args.dir      per-repository state directory
 * @param {string} args.root     repository root (where .claude/ lives)
 * @param {string} args.transcriptDir directory of this project's transcripts
 * @param {string|null} args.currentSession the session that is running now
 * @returns {object} a summary, for status output and tests
 */
export function runFold({ dir, root, transcriptDir, currentSession = null, env = process.env, now = Date.now() }) {
  const settings = toolpruneSettings(env);
  const holdout = holdoutSettings(env);
  let store = loadStore(dir);
  const folded = new Map(store.sessions.map((session) => [session.sessionId, session.endedAt || 0]));
  let foldedNow = 0;
  try {
    for (const name of readdirSync(transcriptDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = name.replace(/\.jsonl$/i, '');
      if (sessionId === currentSession) continue;
      const path = join(transcriptDir, name);
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (folded.has(sessionId) && folded.get(sessionId) >= mtime - 1000) continue;
      const usage = sessionUsage(path, { mentionCandidates: store.applied });
      if (!usage || usage.prompts === 0) continue;
      usage.sessionId = sessionId;
      store = foldSession(store, usage, { now });
      if (holdout.enabled) {
        recordOutcome(dir, { sessionId, costUnits: usage.costUnits, prompts: usage.prompts, endedAt: usage.lastAt || mtime }, holdout);
      }
      foldedNow += 1;
    }
  } catch {
    // No transcript directory: nothing to learn from yet.
  }

  if (holdout.enabled && foldedNow) decideHoldout(dir, { now });
  if (settings.mode === 'off') {
    saveStore(dir, store);
    return { mode: 'off', folded: foldedNow };
  }

  const wanted = candidates(store, settings, allowedTools(root)).map((item) => item.name);
  // What is applied and still wanted stays; what is newly wanted waits for idle.
  const restored = new Set(store.restored);
  const keepApplied = store.applied.filter((name) => wanted.includes(name) && !restored.has(name));
  const newlyWanted = wanted.filter((name) => !store.applied.includes(name));
  store.pending = newlyWanted;
  store.blocked = null;

  // EVERY session counts, the one that launched this fold included. A deny
  // rule reaches sessions that are already running (verified on 2.1.319), so a
  // write while any of them is live changes its tool list mid-conversation and
  // re-writes its cached prefix. The launching session is always live, so a
  // fold started at a session start never writes a new prune itself; the
  // detached waiter (`waitAndApply`) writes it once everything has gone quiet.
  const quiet = idleMs(transcriptDir, null, { now }) >= settings.quietMinutes * 60_000;
  const mustRemove = store.applied.some((name) => !keepApplied.includes(name));
  // Removing a prune is done at once, even with sessions live: it costs at most
  // one cache re-write, and a wrongly pruned tool costs a failed call in every
  // session it stays missing from.
  if (settings.mode === 'auto' && (mustRemove || (quiet && newlyWanted.length))) {
    const target = quiet ? [...keepApplied, ...newlyWanted] : keepApplied;
    const result = writeDenyList(root, store.applied, target);
    if (result.ok) {
      store.applied = result.owned;
      store.pending = wanted.filter((name) => !store.applied.includes(name));
      store.lastApplyAt = now;
      store.lastChange = { at: now, added: result.added, removed: result.removed };
    } else {
      store.blocked = result.reason;
    }
  }
  saveStore(dir, store);
  return {
    mode: settings.mode,
    folded: foldedNow,
    applied: store.applied,
    pending: store.pending,
    restored: store.restored,
    blocked: store.blocked,
  };
}

/** Give tools back by hand (`names` empty = all). Never pruned again. */
export function restoreTools({ dir, root, names = [] }) {
  const store = loadStore(dir);
  const giveBack = names.length ? store.applied.filter((name) => names.includes(name)) : [...store.applied];
  const result = writeDenyList(root, store.applied, store.applied.filter((name) => !giveBack.includes(name)));
  if (!result.ok) return result;
  store.applied = result.owned;
  store.restored = [...new Set([...store.restored, ...giveBack, ...names])];
  store.pending = store.pending.filter((name) => !store.restored.includes(name));
  saveStore(dir, store);
  return { ok: true, restored: giveBack };
}

// ---------------------------------------------------------------------------
// The catalog probe.

/**
 * The tool list a fresh `claude -p` session loads, from its stream-json init
 * event. The child is killed as soon as the event arrives, before any model
 * call, so the probe costs neither money nor quota.
 */
export function probeCatalog({ cli = 'claude', timeoutMs = 60_000, env = process.env } = {}) {
  return new Promise((resolveProbe) => {
    let child;
    let settled = false;
    let buffered = '';
    const workdir = tmpdir();
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (process.platform === 'win32' && child?.pid) {
          spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
        } else {
          child?.kill('SIGKILL');
        }
      } catch {
        // Already gone.
      }
      resolveProbe(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      child = spawn(
        cli,
        // One-word prompt: under `shell: true` (needed for the .cmd shim on
        // Windows) arguments are joined unquoted, so a phrase would split.
        ['-p', 'OK', '--output-format', 'stream-json', '--verbose', '--max-turns', '1'],
        {
          cwd: workdir,
          env: { ...env, TOKEN_OPTIMIZER_SIDECALL: '1' },
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          shell: process.platform === 'win32',
        }
      );
    } catch {
      finish(null);
      return;
    }
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdout.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      let index;
      while ((index = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        try {
          const event = JSON.parse(line);
          if (event?.type === 'system' && event?.subtype === 'init' && Array.isArray(event.tools)) {
            finish({ tools: event.tools.filter((name) => typeof name === 'string'), clientVersion: event.claude_code_version ?? null });
            return;
          }
        } catch {
          // Not a JSON line.
        }
      }
    });
  });
}

/** Whether a catalog probe is due for this store. */
export function catalogDue(store, { now = Date.now() } = {}) {
  return !store.catalog.probedAt || now - store.catalog.probedAt > CATALOG_MAX_AGE_MS;
}

// ---------------------------------------------------------------------------
// Hook entry points.

/**
 * Called at SessionStart (Claude Code). Launches the fold, and the catalog
 * probe when due, in a detached process that outlives the hook. Returns at
 * once; the session start never waits on a transcript scan.
 */
export function scheduleFold({ dir, root, transcriptPath, sessionId, env = process.env }) {
  if (toolpruneSettings(env).mode === 'off' && !holdoutSettings(env).enabled) return false;
  if (env.TOKEN_OPTIMIZER_SIDECALL) return false;
  if (!transcriptPath || !root || !dir) return false;
  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), '--fold', dir, root, dirname(transcriptPath), sessionId || ''],
      { cwd: tmpdir(), detached: true, stdio: 'ignore', windowsHide: true, env: { ...env } }
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * One line for the session start, only when something changed since it was
 * last announced -- and then marked announced, so it is said once.
 */
export function takeNotice(dir, { now = Date.now() } = {}) {
  const store = loadStore(dir);
  const change = store.lastChange;
  const fresh = change && change.at > (store.announcedAt || 0);
  const auto = store.autoRestored || [];
  const parts = [];
  if (fresh && change.added?.length) {
    parts.push(`left out ${change.added.length} tool(s) unused in this repository: ${change.added.join(', ')}`);
  }
  if (fresh && change.removed?.length) parts.push(`gave back ${change.removed.join(', ')}`);
  if (auto.length) parts.push(`restored ${auto.join(', ')} after a session needed it`);
  if (!parts.length) return null;
  store.announcedAt = now;
  store.autoRestored = [];
  try {
    saveStore(dir, store);
  } catch {
    // Unsaved: it is said again next session, which is the safe direction.
  }
  return `token-optimizer tool pruning: ${parts.join('; ')}. Undo: token-optimizer-learned toolprune restore.`;
}

export const WAITER_FILE = 'toolprune.waiter';
export const WAIT_POLL_MS = 5 * 60 * 1000;
export const WAIT_MAX_MS = 24 * 60 * 60 * 1000;

/** Take the per-repository waiter slot; false when a live waiter already holds it. */
export function takeWaiter(dir, { now = Date.now() } = {}) {
  const path = join(dir, WAITER_FILE);
  try {
    const held = JSON.parse(readFileSync(path, 'utf8'));
    if (held && now - (held.heartbeat || 0) < WAIT_POLL_MS * 2 && held.pid !== process.pid) return false;
  } catch {
    // Free.
  }
  try {
    mkdirSync(dir, { recursive: true });
    writeAtomically(path, JSON.stringify({ pid: process.pid, heartbeat: now }));
    return true;
  } catch {
    return false;
  }
}

function releaseWaiter(dir) {
  try {
    const held = JSON.parse(readFileSync(join(dir, WAITER_FILE), 'utf8'));
    if (held?.pid === process.pid) writeAtomically(join(dir, WAITER_FILE), JSON.stringify({ pid: 0, heartbeat: 0 }));
  } catch {
    // Nothing held.
  }
}

/**
 * Hold a pending deny list until every session of the repository has been idle
 * for the quiet period, then write it. One waiter per repository; gives up after
 * a day, and the next session start tries again.
 */
export async function waitAndApply({ dir, root, transcriptDir, env = process.env, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), clock = Date.now }) {
  if (toolpruneSettings(env).mode !== 'auto') return null;
  const started = clock();
  if (!takeWaiter(dir, { now: started })) return null;
  try {
    for (;;) {
      const summary = runFold({ dir, root, transcriptDir, currentSession: null, env, now: clock() });
      if (!summary.pending?.length || summary.blocked || clock() - started > WAIT_MAX_MS) return summary;
      await sleep(WAIT_POLL_MS);
      if (!takeWaiter(dir, { now: clock() })) return summary;
    }
  } finally {
    releaseWaiter(dir);
  }
}

async function backgroundMain(argv) {
  const [dir, root, transcriptDir, currentSession] = argv;
  const store = loadStore(dir);
  if (toolpruneSettings().mode !== 'off' && catalogDue(store)) {
    const probed = await probeCatalog();
    if (probed && probed.tools.length) {
      const latest = loadStore(dir);
      latest.catalog = { tools: probed.tools, probedAt: Date.now(), clientVersion: probed.clientVersion };
      saveStore(dir, latest);
    } else {
      // Record the attempt so a machine without the CLI is not probed every session.
      const latest = loadStore(dir);
      latest.catalog = { ...latest.catalog, probedAt: Date.now() };
      saveStore(dir, latest);
    }
  }
  const summary = runFold({ dir, root, transcriptDir, currentSession: currentSession || null });
  if (summary.pending?.length) await waitAndApply({ dir, root, transcriptDir });
}

if (process.argv[2] === '--fold' && process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  backgroundMain(process.argv.slice(3)).catch(() => {
    // Nothing to report to: the next session start retries.
  });
}

/**
 * Where the learned controls keep their state, and which directory's
 * `.claude/settings.local.json` the deny list goes into.
 *
 * A session started outside any repository -- a home directory is the common
 * case -- has no project root, and every such session would otherwise share
 * one synthetic store while Claude Code reads a different settings file for
 * each launch directory. Measured on Claude Code 2.1.319: with the launch
 * directory set to the home directory, `~/.claude/settings.local.json` is that
 * session's project-local file and a deny rule there removes the tool. So an
 * unrooted session is keyed on its launch directory, with its own store.
 */
export function learnedLocation(cwd) {
  const root = projectRootFor(join(cwd, '__session__'), cwd);
  const dir = wikiDir(root);
  if (canonicalPath(root) !== canonicalPath(unrootedRoot())) return { root, dir, unrooted: false };
  return {
    root: cwd,
    dir: join(dir, 'learned', String(canonicalPath(cwd)).replace(/[^A-Za-z0-9]/g, '-').slice(0, 120)),
    unrooted: true,
  };
}
