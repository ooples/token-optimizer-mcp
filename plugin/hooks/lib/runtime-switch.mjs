// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/runtime-switch.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Which installed runtime a hook runs from: the session's own, or the newer one
 * `<runtime>/current` names.
 *
 * WHY. Claude Code resolves `${CLAUDE_PLUGIN_ROOT}` once, for the plugin version
 * a session loaded, and keeps it until the session restarts. On 2026-10-26 a
 * long session kept running 7.5.1 hooks for hours after 7.7.1 was installed, so
 * 37 outputs over 6 KB reached the model whole although the installed compactor
 * would have cut them (bench/field/multi-agent-waste.md). An update should take
 * effect on the next tool call, not the next restart.
 *
 * GATED ON A STATE SCHEMA, because the hooks are not stateless. A hook reads
 * what earlier hooks of the same session wrote (STATE_FORMATS below), and a
 * newer runtime that reads an older layout -- or writes one the session's own
 * code then misreads -- breaks the session it was meant to improve. So:
 *
 *   current schema == session schema   every hook runs from current
 *   differs, current ships a migration  session state migrated atomically
 *                                       (temp + rename, backup kept), then switch
 *   differs, no migration               stateful hooks stay on the session's
 *                                       version; pure modules (PURE_MODULES)
 *                                       come from current; the user is told ONCE
 *                                       to restart to finish updating
 *   current OLDER than the state       state restored from its `.schema<N>.bak`
 *                                       (all files, verified), then switch; else
 *                                       stateful hooks stay on the version the
 *                                       state was written by, and the note is
 *                                       shown once
 *
 * OLDER CODE NEVER READS NEWER STATE. Not current, not this copy on a fallback:
 * when no code on the state's schema is installed any more, the state is moved
 * aside (`.quarantine`) and the hooks start it afresh; when even that fails the
 * hook does not run (INERT_HOOK).
 *
 * ONE VERSION PER TOOL CALL. Pre-tool records the version it resolved under the
 * call's tool_use_id and post-tool reuses it, so an update landing between the
 * two cannot run a call's halves on different code.
 *
 * FAIL SAFE, ALWAYS. A missing, half-installed or unloadable current, an
 * import that outlives its budget, any exception here: the hook runs from the
 * session's own version, exactly as before this module existed.
 *
 * CHEAP. One stat of `<runtime>/current` per call. What that pointer resolved to
 * is cached in the state directory keyed by the pointer's mtime and size, so the
 * directory scan and the schema import happen only when the pointer changes.
 *
 * SELF-CONTAINED: node built-ins only. Entry points import this before anything
 * else, and it must load under every runtime that ships it.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The version of every persisted or session-state format the hooks read and
 * write. Bump it, and add a MIGRATIONS entry when one is possible, whenever a
 * format in STATE_FORMATS changes incompatibly.
 */
export const STATE_SCHEMA = 1;

/**
 * Every format STATE_SCHEMA covers, enumerated from the write sites in
 * hooks-core (writeFileSync / appendFileSync / renameSync). Location is relative
 * to the state root (TOKEN_OPTIMIZER_STATE_DIR, else <tmp>/token-optimizer-hooks),
 * a project's wiki directory, ~/.token-optimizer, or the OS temp dir.
 */
/*
 * STATE_FORMATS -- every format STATE_SCHEMA covers (owner | where | what):
 *
 *   policy.mjs | state root: <session>[-<agent>].json | session state: seen, denied, injected, counters, advisories
 *   agent-scope.mjs | state root: agent-scope/<tool_use_id>.json | which agent made a call
 *   runtime-switch.mjs | state root: <session>.runtime.json, runtime-calls/, runtime-current.json | session runtime record, per-call version, pointer cache
 *   authored.mjs | wiki dir | records of files the agent authored
 *   compact-stage.mjs | temp dir | the previous output of a staged command
 *   outline-rewrite.mjs | <tmp>/token-optimizer-compact | outlines substituted for large reads
 *   expand.mjs | wiki dir: artifacts/<digest>.txt | full outputs behind a compacted result
 *   metrics.mjs | wiki dir: metrics.jsonl, balance.jsonl, evidence.jsonl | events, savings balance, evidence
 *   wiki.mjs | wiki dir: graph.jsonl, graph.compact.json, snapshots.jsonl | knowledge graph and file snapshots
 *   pending.mjs | wiki dir: pending queue | harvest work queued for a later turn
 *   harvest.mjs | wiki dir | harvest markers and prompt files
 *   transcript.mjs | wiki dir: transcripts/ | archived turns
 *   routing.mjs | wiki dir: routing-brief.json | routing brief
 *   remedy.mjs | wiki dir: rules file | applied remedies
 *   manifest.mjs | wiki dir: manifest | project manifest
 *   projects.mjs | ~/.token-optimizer/projects.jsonl | known projects
 *   observability.mjs | ~/.token-optimizer/logs/ | hook event log (HOOK_LOG_SCHEMA_VERSION)
 *   quiet-env.mjs | client env file | quiet defaults for shell tools
 *   ignore-self.mjs | project ignore file | keeps our own directory out of searches
 *   ucr-guard.mjs | wiki dir | active UCR guards (ucr.active-guards/1)
 */

/**
 * Migrations this runtime can apply to a session that started on an older
 * schema: `{ [fromSchema]: { to, migrateSessionState(state) => state } }`.
 * Steps chain, so 1 -> 2 -> 3 needs entries for 1 and 2. None yet: schema 1 is
 * the first one declared.
 */
export const MIGRATIONS = Object.freeze({});

/**
 * Modules whose functions keep no state of their own, so a session pinned to
 * its own version still takes them from current. Each must keep its exported
 * names stable across versions.
 */
export const PURE_MODULES = Object.freeze(['output-compact.mjs']);

/**
 * What importForHook returns when no code may run the hook (see selfMayRun):
 * shaped like the adapter module, so an entry calling run() on it does nothing.
 */
export const INERT_HOOK = Object.freeze({ run: async () => undefined });

/** Import errors that happen before a module evaluates. */
const LOAD_FAILURES = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT', 'ERR_INVALID_URL', 'ENOENT']);

/** Default budget for resolving and loading another runtime, in ms. */
export const RESOLVE_BUDGET_MS = 300;

const OFF = /^(0|false|no|off)$/i;
const SAFE = (value) => String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);
const PACKAGE = ['node_modules', '@ooples', 'token-optimizer-mcp'];

export function runtimeDir(env = process.env) {
  return env.TOKEN_OPTIMIZER_RUNTIME || join(homedir(), '.token-optimizer', 'runtime');
}

/** The same root policy.mjs keeps session state under. */
export function stateRoot(env = process.env) {
  return env.TOKEN_OPTIMIZER_STATE_DIR || join(tmpdir(), 'token-optimizer-hooks');
}

/**
 * Whether this process may follow `current` at all. Off by env, and off under
 * jest unless the test named a runtime: a spawned hook in the test suite must
 * run the working tree, never whatever happens to be installed on the machine.
 */
export function hotUpdateEnabled(env = process.env) {
  if (OFF.test(String(env.TOKEN_OPTIMIZER_HOT_UPDATE ?? '').trim())) return false;
  if (env.JEST_WORKER_ID && !env.TOKEN_OPTIMIZER_RUNTIME) return false;
  return true;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Renamed, or never written.
    }
  }
}

const sessionRecordPath = (sessionId, env) => join(stateRoot(env), `${SAFE(sessionId) || 'default'}.runtime.json`);
const callRecordPath = (sessionId, toolUseId, env) =>
  join(stateRoot(env), 'runtime-calls', `${SAFE(sessionId) || 'default'}-${SAFE(toolUseId)}.json`);
const pointerCachePath = (env) => join(stateRoot(env), 'runtime-current.json');

/** The session's record: the version and schema it started with. */
export function sessionRecord(sessionId, env = process.env) {
  return readJson(sessionRecordPath(sessionId, env));
}

/** Written at SessionStart, and lazily by the first hook of a session that predates this module. */
export function recordSessionStart(sessionId, { version, schema = STATE_SCHEMA, hooksDir }, env = process.env) {
  if (!sessionId) return null;
  const record = { version, schema, hooksDir, startedAt: Date.now(), noted: false };
  try {
    writeAtomic(sessionRecordPath(sessionId, env), record);
    pruneCallRecords(env);
  } catch {
    // Without a record the next hook writes one; nothing breaks.
  }
  return record;
}

/** Per-call records are removed by post-tool; one whose post-tool never ran is pruned after a day. */
function pruneCallRecords(env, now = Date.now()) {
  const dir = join(stateRoot(env), 'runtime-calls');
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.slice(0, 2000)) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > 24 * 60 * 60 * 1000) unlinkSync(path);
    } catch {
      // Raced with another prune.
    }
  }
}

/** This copy's version: the publish stamp, else the nearest manifest of ours. */
export function ownVersion(hooksDir, env = process.env) {
  if (env.TOKEN_OPTIMIZER_VERSION) return env.TOKEN_OPTIMIZER_VERSION;
  let dir = hooksDir;
  for (let depth = 0; depth < 6 && dir; depth++) {
    for (const parts of [['package.json'], ['.claude-plugin', 'plugin.json'], ['.codex-plugin', 'plugin.json']]) {
      const manifest = readJson(join(dir, ...parts));
      if (manifest && ['@ooples/token-optimizer-mcp', 'token-optimizer'].includes(manifest.name) && manifest.version)
        return String(manifest.version);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'unknown';
}

/**
 * Reads the whole payload once, so the resolver can see the session and the
 * tool call, and hands it on: policy.mjs readPayloadResult takes it from here
 * instead of reading a stdin that is already drained.
 */
export async function takeStdin({ timeoutMs = 1500, maxBytes = 8_000_000 } = {}) {
  if (globalThis.__tokenOptimizerStdin) return globalThis.__tokenOptimizerStdin;
  const chunks = [];
  let size = 0;
  const result = await new Promise((resolve) => {
    let done = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
      process.stdin.pause();
      resolve({ raw: status === 'received' ? chunks.join('') : null, status, bytes: size });
    };
    const onData = (chunk) => {
      size += Buffer.byteLength(chunk, 'utf8');
      if (size > maxBytes) return finish('too_large');
      chunks.push(chunk);
    };
    const onEnd = () => finish('received');
    const onError = () => finish('input_error');
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
  });
  globalThis.__tokenOptimizerStdin = result;
  return result;
}

function parsePayload(input) {
  if (!input?.raw) return null;
  try {
    return JSON.parse(input.raw);
  } catch {
    return null;
  }
}

/** Everything a runtime needs present before it is trusted to run a hook. */
function runtimeFiles(hooksDir, entryFile) {
  return [
    join(hooksDir, 'lib', 'runtime-switch.mjs'),
    join(hooksDir, 'lib', 'adapter.mjs'),
    join(hooksDir, 'lib', 'policy.mjs'),
    ...(entryFile ? [join(hooksDir, entryFile)] : []),
  ];
}

/** Resolves `promise`, or `fallback` once `ms` have passed. */
function within(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * What `<runtime>/current` resolves to for the hooks directory `entryRel`
 * (relative to the package root, e.g. 'plugin/hooks'). Cached by the pointer's
 * mtime and size; null when current is missing, half-installed or unloadable.
 */
export async function resolveCurrent({ entryRel, entryFile = null, env = process.env, budgetMs = RESOLVE_BUDGET_MS }) {
  const pointer = join(runtimeDir(env), 'current');
  let stat;
  try {
    stat = statSync(pointer);
  } catch {
    return null;
  }
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const key = `${entryRel}|${entryFile ?? ''}`;
  const cache = readJson(pointerCachePath(env)) || {};
  if (cache.stamp === stamp && cache.entries && key in cache.entries) return cache.entries[key];

  let resolved = null;
  try {
    const version = readFileSync(pointer, 'utf8').trim();
    if (/^[\w.+-]{1,64}$/.test(version)) {
      const hooksDir = join(runtimeDir(env), 'versions', version, ...PACKAGE, ...entryRel.split('/'));
      if (runtimeFiles(hooksDir, entryFile).every((file) => existsSync(file))) {
        const module = await within(
          import(pathToFileURL(join(hooksDir, 'lib', 'runtime-switch.mjs')).href),
          budgetMs,
          null
        );
        if (module && Number.isInteger(module.STATE_SCHEMA))
          resolved = {
            version,
            hooksDir,
            schema: module.STATE_SCHEMA,
            migratesFrom: Object.keys(module.MIGRATIONS || {}).map(Number),
          };
      }
    }
  } catch {
    resolved = null;
  }
  try {
    const entries = cache.stamp === stamp ? { ...(cache.entries || {}) } : {};
    // A timeout is not cached: the next call may load it in time.
    if (resolved) entries[key] = resolved;
    writeAtomic(pointerCachePath(env), { stamp, entries });
  } catch {
    // An unwritable cache costs a re-resolve next call, nothing more.
  }
  return resolved;
}

/**
 * Migrates every state file of the session from `from` to `to` with the target
 * runtime's MIGRATIONS. All files or none: each is written to a temp file and
 * renamed over the original, with the original kept as `<file>.schema<from>.bak`;
 * on any failure the backups are restored. Exclusive per session.
 */
export function migrateSession(sessionId, migrations, from, to, env = process.env) {
  const root = stateRoot(env);
  const safe = SAFE(sessionId) || 'default';
  const steps = [];
  for (let schema = from; schema !== to; ) {
    const step = migrations?.[schema];
    if (!step || typeof step.migrateSessionState !== 'function' || !Number.isInteger(step.to) || step.to === schema)
      return false;
    steps.push(step);
    schema = step.to;
    if (steps.length > 32) return false;
  }
  const lock = join(root, `${safe}.migrate.lock`);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(lock);
  } catch {
    // Another hook is migrating, or the root is unwritable: stay pinned this call.
    return false;
  }
  const done = [];
  try {
    const files = readdirSync(root).filter(
      (name) => name === `${safe}.json` || new RegExp(`^${safe}-[a-f0-9]{12}\\.json$`).test(name)
    );
    for (const name of files) {
      const path = join(root, name);
      const backup = `${path}.schema${from}.bak`;
      const before = readFileSync(path, 'utf8');
      let state = JSON.parse(before);
      for (const step of steps) state = step.migrateSessionState(state);
      writeFileSync(backup, before, { mode: 0o600 });
      done.push({ path, backup });
      writeAtomic(path, state);
    }
    return true;
  } catch {
    for (const { path, backup } of done) {
      try {
        writeAtomic(path, readFileSync(backup, 'utf8'));
      } catch {
        // The backup stays on disk for a manual restore.
      }
    }
    return false;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** A session's state files: `<session>.json` and its agents' `<session>-<12 hex>.json`. */
function sessionStateFiles(root, safe) {
  const agent = new RegExp(`^${safe}-[a-f0-9]{12}\\.json$`);
  return readdirSync(root).filter((name) => name === `${safe}.json` || agent.test(name));
}

/** Runs `fn` holding the session's migration lock; false when another hook holds it. */
function withSessionLock(root, safe, fn) {
  const lock = join(root, `${safe}.migrate.lock`);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(lock);
  } catch {
    return false;
  }
  try {
    return fn();
  } catch {
    return false;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Undoes a migration for a runtime on the older schema `to`: every state file
 * of the session goes back to its `<file>.schema<to>.bak`. All files or none,
 * and only when EVERY file has such a backup -- a file written after the
 * migration has no older form to return to. Each backup must parse, each
 * restored file is read back and compared, and any failure puts the newer
 * files back as they were. The backups are removed once restored.
 */
export function restoreSession(sessionId, to, env = process.env) {
  const root = stateRoot(env);
  const safe = SAFE(sessionId) || 'default';
  if (!existsSync(root)) return true;
  return withSessionLock(root, safe, () => {
    const plan = sessionStateFiles(root, safe).map((name) => {
      const path = join(root, name);
      return { path, backup: `${path}.schema${to}.bak` };
    });
    if (!plan.every(({ backup }) => existsSync(backup))) return false;
    const older = plan.map(({ backup }) => readFileSync(backup, 'utf8'));
    for (const text of older) JSON.parse(text);
    const newer = plan.map(({ path }) => readFileSync(path, 'utf8'));
    try {
      plan.forEach(({ path }, i) => {
        writeAtomic(path, older[i]);
        if (readFileSync(path, 'utf8') !== older[i]) throw new Error(`restore of ${path} did not verify`);
      });
    } catch {
      plan.forEach(({ path }, i) => {
        try {
          writeAtomic(path, newer[i]);
        } catch {
          // Left as restored; the record still names the newer schema, so no
          // older hook is sent to it.
        }
      });
      return false;
    }
    for (const { backup } of plan) {
      try {
        unlinkSync(backup);
      } catch {
        // A stale backup is only used when a newer schema is undone again.
      }
    }
    return true;
  });
}

/**
 * Moves a session's state files aside as `<file>.schema<schema>.quarantine`, so
 * code on another schema starts that session's hook state afresh instead of
 * misreading it. All or none.
 */
export function quarantineSession(sessionId, schema, env = process.env) {
  const root = stateRoot(env);
  const safe = SAFE(sessionId) || 'default';
  if (!existsSync(root)) return true;
  return withSessionLock(root, safe, () => {
    const moved = [];
    try {
      for (const name of sessionStateFiles(root, safe)) {
        const path = join(root, name);
        const aside = `${path}.schema${schema}.quarantine`;
        renameSync(path, aside);
        moved.push({ path, aside });
      }
      return true;
    } catch {
      for (const { path, aside } of moved) {
        try {
          renameSync(aside, path);
        } catch {
          // Stays aside: missing state is read as a fresh session.
        }
      }
      return false;
    }
  });
}

/** The note shown once to a session pinned to its own version. */
export const RESTART_NOTE =
  'token-optimizer was updated while this session was running; output compaction already uses the new version. Restart the session to finish updating.';

/** The note shown once when the installed runtime is older than this session's state. */
export const DOWNGRADE_NOTE =
  'token-optimizer was rolled back while this session was running; this session keeps the version its state was written by, or starts its hook state afresh. Restart the session to finish.';

/**
 * Whether THIS copy may run the session's stateful hooks: only when the state
 * is on this copy's schema. Otherwise the state is quarantined first, and when
 * even that fails the hook must not run at all. Never throws.
 */
export function selfMayRun(sessionId, env = process.env) {
  try {
    const record = sessionId ? sessionRecord(sessionId, env) : null;
    if (!record || !Number.isInteger(record.schema) || record.schema === STATE_SCHEMA) return true;
    if (!quarantineSession(sessionId, record.schema, env)) return false;
    writeAtomic(sessionRecordPath(sessionId, env), {
      ...record,
      schema: STATE_SCHEMA,
      quarantinedFrom: record.schema,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Decides which runtime runs this hook. Never throws.
 *
 * @returns {{ hooksDir: string, version: string, mode: 'self'|'current'|'pinned', note: string|null, pure: string|null }}
 *   `pure` is the hooks directory to take PURE_MODULES from when pinned.
 */
export async function resolveHook({
  hooksDir: selfDir,
  entryRel,
  entryFile = null,
  event,
  env = process.env,
  now = Date.now,
}) {
  const started = now();
  const self = { hooksDir: selfDir, version: ownVersion(selfDir, env), mode: 'self', note: null, pure: null };
  let sessionId = null;
  try {
    const timeoutMs = event === 'session-start' || event === 'stop' || event === 'precompact' ? 250 : 1500;
    const payload = parsePayload(await takeStdin({ timeoutMs }));
    sessionId = payload?.session_id ?? payload?.sessionId ?? payload?.conversation_id ?? null;
    const toolUseId = payload?.tool_use_id ?? payload?.toolUseId ?? null;

    if (event === 'session-start') {
      recordSessionStart(sessionId, { version: self.version, schema: STATE_SCHEMA, hooksDir: selfDir }, env);
      return self;
    }
    if (!sessionId) return self;
    const enabled = hotUpdateEnabled(env);

    // The second half of a call runs where the first half ran.
    if (enabled && toolUseId && event === 'post-tool') {
      const path = callRecordPath(sessionId, toolUseId, env);
      const recorded = readJson(path);
      try {
        unlinkSync(path);
      } catch {
        // No record: pre-tool did not run for this call, or did not switch.
      }
      if (recorded?.hooksDir && runtimeFiles(recorded.hooksDir, entryFile).every((f) => existsSync(f)))
        return { ...self, ...recorded, note: null, sessionId };
    }

    // Off (by env, or under jest) a session without a record is left alone:
    // nothing switched it, so its state is on this copy's schema.
    let session = sessionRecord(sessionId, env);
    if (!session && !enabled) return self;
    session ||= recordSessionStart(sessionId, { version: self.version, schema: STATE_SCHEMA, hooksDir: selfDir }, env);
    const stateSchema = Number.isInteger(session?.schema) ? session.schema : STATE_SCHEMA;
    const saveRecord = (fields) => {
      session = { ...session, ...fields };
      writeAtomic(sessionRecordPath(sessionId, env), session);
    };

    let current = null;
    if (enabled) {
      const deadline = Number(env.TOKEN_OPTIMIZER_HOOK_DEADLINE_MS) > 0 ? Number(env.TOKEN_OPTIMIZER_HOOK_DEADLINE_MS) : 4200;
      const budget = Math.min(
        Number(env.TOKEN_OPTIMIZER_RESOLVE_BUDGET_MS) > 0 ? Number(env.TOKEN_OPTIMIZER_RESOLVE_BUDGET_MS) : RESOLVE_BUDGET_MS,
        Math.max(0, deadline / 4 - (now() - started))
      );
      current = await resolveCurrent({ entryRel, entryFile, env, budgetMs: budget });
      if (current && current.version !== self.version && current.schema > stateSchema && current.migratesFrom.includes(stateSchema)) {
        current.migrate = async () => {
          const module = await within(
            import(pathToFileURL(join(current.hooksDir, 'lib', 'runtime-switch.mjs')).href),
            Math.max(0, budget - (now() - started)),
            null
          );
          return Boolean(module) && migrateSession(sessionId, module.MIGRATIONS, stateSchema, current.schema, env);
        };
      }
    }
    // What would run the hook: current when it names another version, else this copy.
    const target =
      current && current.version !== self.version
        ? { hooksDir: current.hooksDir, version: current.version, schema: current.schema, mode: 'current' }
        : { hooksDir: selfDir, version: self.version, schema: STATE_SCHEMA, mode: 'self' };
    const run = (t, note = null) => ({ hooksDir: t.hooksDir, version: t.version, mode: t.mode, note, pure: null });

    let choice;
    if (target.schema === stateSchema) {
      choice = target.mode === 'self' ? self : run(target);
    } else if (target.schema > stateSchema && current?.migrate && (await current.migrate())) {
      saveRecord({ schema: target.schema, version: target.version, hooksDir: target.hooksDir, migratedFrom: stateSchema });
      choice = run(target);
    } else if (target.schema < stateSchema && restoreSession(sessionId, target.schema, env)) {
      // Older code never reads newer state: the state goes back to the form the
      // migration started from, or the hook does not run on this target.
      saveRecord({ schema: target.schema, version: target.version, hooksDir: target.hooksDir, restoredFrom: stateSchema });
      choice = run(target);
    } else {
      // The stateful hooks need code on the state's schema.
      const note = session?.noted ? null : target.schema < stateSchema ? DOWNGRADE_NOTE : RESTART_NOTE;
      const pure = current ? current.hooksDir : null;
      if (stateSchema === STATE_SCHEMA) {
        choice = { ...self, mode: 'pinned', note, pure };
      } else if (
        session?.hooksDir &&
        session.hooksDir !== selfDir &&
        session.version &&
        runtimeFiles(session.hooksDir, entryFile).every((file) => existsSync(file))
      ) {
        choice = { hooksDir: session.hooksDir, version: session.version, mode: 'pinned', note, pure };
      } else if (quarantineSession(sessionId, stateSchema, env)) {
        // No code on the state's schema is left: the hooks start this
        // session's state afresh on the target.
        saveRecord({ schema: target.schema, version: target.version, hooksDir: target.hooksDir, quarantinedFrom: stateSchema });
        choice = run(target, note);
      } else {
        choice = { ...self, mode: 'inert', note, pure: null };
      }
      if (note) saveRecord({ noted: true });
    }
    if (toolUseId && event === 'pre-tool' && choice.mode !== 'self') {
      try {
        writeAtomic(callRecordPath(sessionId, toolUseId, env), {
          hooksDir: choice.hooksDir,
          version: choice.version,
          mode: choice.mode,
          pure: choice.pure,
        });
      } catch {
        // Unrecorded: post-tool resolves for itself, as it did before.
      }
    }
    return { ...choice, sessionId };
  } catch {
    // Even here, this copy runs the hook only on state of its own schema.
    return selfMayRun(sessionId, env) ? { ...self, sessionId } : { ...self, mode: 'inert', sessionId };
  }
}

/**
 * Applies a resolution to this process: the version it reports, the pure
 * modules a pinned session borrows, and the one-time note. Returns the hooks
 * directory to import the hook from.
 */
export async function applyResolution(choice, { budgetMs = RESOLVE_BUDGET_MS } = {}) {
  globalThis.__tokenOptimizerRuntime = { version: choice.version, mode: choice.mode, note: choice.note };
  if (choice.mode !== 'self') process.env.TOKEN_OPTIMIZER_VERSION = choice.version;
  if (choice.mode === 'pinned' && choice.pure) {
    const pure = {};
    for (const name of PURE_MODULES) {
      const module = await within(import(pathToFileURL(join(choice.pure, 'lib', name)).href), budgetMs, null);
      if (module) Object.assign(pure, module);
    }
    globalThis.__tokenOptimizerPure = pure;
  }
  if (choice.note) installNote(choice.note);
  // No code on the session's state schema can run it, and the state could not
  // be moved aside: the hook stays out of the call rather than misread state.
  if (choice.mode === 'inert') return null;
  return choice.hooksDir;
}

/**
 * Delivers the note on this hook's output: merged into the JSON the hook
 * writes, or written alone when the hook writes nothing.
 */
function installNote(note) {
  let delivered = false;
  globalThis.__tokenOptimizerDecorate = (object) => {
    if (delivered || !object || typeof object !== 'object') return object;
    delivered = true;
    return { ...object, systemMessage: object.systemMessage ? `${object.systemMessage}\n${note}` : note };
  };
  process.once('exit', () => {
    if (delivered) return;
    delivered = true;
    try {
      // Synchronous: an exit handler cannot wait for an asynchronous write, and
      // pipes are written synchronously on Windows and Linux.
      writeSync(1, JSON.stringify({ systemMessage: note }));
    } catch {
      // Delivery is best effort.
    }
  });
}

/**
 * What every hook entry point calls: resolve, apply, and import `module`
 * (relative to a hooks directory, e.g. 'lib/adapter.mjs' or
 * 'impl/pretooluse-router.mjs') from the chosen runtime. If that import fails,
 * the session's own copy is imported instead -- the hook always runs.
 *
 * @param {{ here: string, entryRel: string, event: string, module: string }} entry
 *   `here` is the entry's import.meta.url; the hooks directory is its folder.
 */
export async function importForHook({ here, entryRel, event, module, env = process.env }) {
  globalThis.__tokenOptimizerHookStartedAt ??= Date.now();
  const selfDir = dirname(fileURLToPath(here));
  const own = () => import(pathToFileURL(join(selfDir, ...module.split('/'))).href);
  let chosen = selfDir;
  let choice = null;
  const priorVersion = process.env.TOKEN_OPTIMIZER_VERSION;
  try {
    choice = await resolveHook({
      hooksDir: selfDir,
      entryRel,
      entryFile: module.startsWith('impl/') ? module : null,
      event,
      env,
    });
    chosen = await applyResolution(choice);
  } catch {
    chosen = selfMayRun(choice?.sessionId ?? null, env) ? selfDir : null;
  }
  if (chosen === null) return INERT_HOOK;
  if (chosen === selfDir) return own();
  try {
    return await import(pathToFileURL(join(chosen, ...module.split('/'))).href);
  } catch (error) {
    // Only a failure to LOAD falls back: a missing module or a parse error is
    // raised at link time, before any of the hook has run. An error thrown while
    // the hook RUNS is the hook's own, and running it a second time from this
    // copy could write a second answer to stdout.
    if (!LOAD_FAILURES.has(error?.code) && !(error instanceof SyntaxError)) throw error;
    // This copy may be older than the state the chosen runtime was picked for.
    if (!selfMayRun(choice?.sessionId ?? null, env)) return INERT_HOOK;
    globalThis.__tokenOptimizerPure = undefined;
    if (priorVersion === undefined) delete process.env.TOKEN_OPTIMIZER_VERSION;
    else process.env.TOKEN_OPTIMIZER_VERSION = priorVersion;
    return own();
  }
}

