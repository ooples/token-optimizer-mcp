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
export const STATE_FORMATS = Object.freeze([
  { owner: 'policy.mjs', where: 'state root: <session>[-<agent>].json', what: 'session state: seen, denied, injected, counters, advisories' },
  { owner: 'agent-scope.mjs', where: 'state root: agent-scope/<tool_use_id>.json', what: 'which agent made a call' },
  { owner: 'blackboard.mjs', where: 'state root: blackboard/<session>.jsonl', what: 'sibling agents\' read-only results' },
  { owner: 'runtime-switch.mjs', where: 'state root: <session>.runtime.json, runtime-calls/, runtime-current.json', what: 'session runtime record, per-call version, pointer cache' },
  { owner: 'authored.mjs', where: 'wiki dir', what: 'records of files the agent authored' },
  { owner: 'compact-stage.mjs', where: 'temp dir', what: 'the previous output of a staged command' },
  { owner: 'outline-rewrite.mjs', where: '<tmp>/token-optimizer-compact', what: 'outlines substituted for large reads' },
  { owner: 'expand.mjs', where: 'wiki dir: artifacts/<digest>.txt', what: 'full outputs behind a compacted result' },
  { owner: 'metrics.mjs', where: 'wiki dir: metrics.jsonl, balance.jsonl, evidence.jsonl', what: 'events, savings balance, evidence' },
  { owner: 'wiki.mjs', where: 'wiki dir: graph.jsonl, graph.compact.json, snapshots.jsonl', what: 'knowledge graph and file snapshots' },
  { owner: 'pending.mjs', where: 'wiki dir: pending queue', what: 'harvest work queued for a later turn' },
  { owner: 'harvest.mjs', where: 'wiki dir', what: 'harvest markers and prompt files' },
  { owner: 'transcript.mjs', where: 'wiki dir: transcripts/', what: 'archived turns' },
  { owner: 'routing.mjs', where: 'wiki dir: routing-brief.json', what: 'routing brief' },
  { owner: 'remedy.mjs', where: 'wiki dir: rules file', what: 'applied remedies' },
  { owner: 'manifest.mjs', where: 'wiki dir: manifest', what: 'project manifest' },
  { owner: 'projects.mjs', where: '~/.token-optimizer/projects.jsonl', what: 'known projects' },
  { owner: 'observability.mjs', where: '~/.token-optimizer/logs/', what: 'hook event log (HOOK_LOG_SCHEMA_VERSION)' },
  { owner: 'quiet-env.mjs', where: 'client env file', what: 'quiet defaults for shell tools' },
  { owner: 'ignore-self.mjs', where: 'project ignore file', what: 'keeps our own directory out of searches' },
  { owner: 'ucr-guard.mjs', where: 'wiki dir', what: 'active UCR guards (ucr.active-guards/1)' },
]);

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

/** The note shown once to a session pinned to its own version. */
export const RESTART_NOTE =
  'token-optimizer was updated while this session was running; output compaction already uses the new version. Restart the session to finish updating.';

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
  try {
    const timeoutMs = event === 'session-start' || event === 'stop' || event === 'precompact' ? 250 : 1500;
    const payload = parsePayload(await takeStdin({ timeoutMs }));
    const sessionId = payload?.session_id ?? payload?.sessionId ?? payload?.conversation_id ?? null;
    const toolUseId = payload?.tool_use_id ?? payload?.toolUseId ?? null;

    if (event === 'session-start') {
      recordSessionStart(sessionId, { version: self.version, schema: STATE_SCHEMA, hooksDir: selfDir }, env);
      return self;
    }
    if (!hotUpdateEnabled(env) || !sessionId) return self;

    // The second half of a call runs where the first half ran.
    if (toolUseId && event === 'post-tool') {
      const path = callRecordPath(sessionId, toolUseId, env);
      const recorded = readJson(path);
      try {
        unlinkSync(path);
      } catch {
        // No record: pre-tool did not run for this call, or did not switch.
      }
      if (recorded?.hooksDir && runtimeFiles(recorded.hooksDir, entryFile).every((f) => existsSync(f)))
        return { ...self, ...recorded, note: null };
    }

    const session =
      sessionRecord(sessionId, env) ||
      recordSessionStart(sessionId, { version: self.version, schema: STATE_SCHEMA, hooksDir: selfDir }, env);
    const deadline = Number(env.TOKEN_OPTIMIZER_HOOK_DEADLINE_MS) > 0 ? Number(env.TOKEN_OPTIMIZER_HOOK_DEADLINE_MS) : 4200;
    const budget = Math.min(
      Number(env.TOKEN_OPTIMIZER_RESOLVE_BUDGET_MS) > 0 ? Number(env.TOKEN_OPTIMIZER_RESOLVE_BUDGET_MS) : RESOLVE_BUDGET_MS,
      Math.max(0, deadline / 4 - (now() - started))
    );
    const current = await resolveCurrent({ entryRel, entryFile, env, budgetMs: budget });
    let choice = self;
    if (current && current.version !== self.version) {
      const sessionSchema = Number.isInteger(session?.schema) ? session.schema : STATE_SCHEMA;
      if (current.schema === sessionSchema) {
        choice = { hooksDir: current.hooksDir, version: current.version, mode: 'current', note: null, pure: null };
      } else {
        let migrated = false;
        if (current.migratesFrom.includes(sessionSchema)) {
          const module = await within(
            import(pathToFileURL(join(current.hooksDir, 'lib', 'runtime-switch.mjs')).href),
            Math.max(0, budget - (now() - started)),
            null
          );
          migrated = Boolean(module) && migrateSession(sessionId, module.MIGRATIONS, sessionSchema, current.schema, env);
          if (migrated)
            writeAtomic(sessionRecordPath(sessionId, env), {
              ...session,
              schema: current.schema,
              version: current.version,
              migratedFrom: sessionSchema,
            });
        }
        if (migrated) {
          choice = { hooksDir: current.hooksDir, version: current.version, mode: 'current', note: null, pure: null };
        } else {
          const note = session?.noted ? null : RESTART_NOTE;
          if (note) writeAtomic(sessionRecordPath(sessionId, env), { ...session, noted: true });
          choice = { ...self, mode: 'pinned', note, pure: current.hooksDir };
        }
      }
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
    return choice;
  } catch {
    return self;
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
  const priorVersion = process.env.TOKEN_OPTIMIZER_VERSION;
  try {
    const choice = await resolveHook({
      hooksDir: selfDir,
      entryRel,
      entryFile: module.startsWith('impl/') ? module : null,
      event,
      env,
    });
    chosen = await applyResolution(choice);
  } catch {
    chosen = selfDir;
  }
  if (chosen === selfDir) return own();
  try {
    return await import(pathToFileURL(join(chosen, ...module.split('/'))).href);
  } catch (error) {
    // Only a failure to LOAD falls back: a missing module or a parse error is
    // raised at link time, before any of the hook has run. An error thrown while
    // the hook RUNS is the hook's own, and running it a second time from this
    // copy could write a second answer to stdout.
    if (!LOAD_FAILURES.has(error?.code) && !(error instanceof SyntaxError)) throw error;
    globalThis.__tokenOptimizerPure = undefined;
    if (priorVersion === undefined) delete process.env.TOKEN_OPTIMIZER_VERSION;
    else process.env.TOKEN_OPTIMIZER_VERSION = priorVersion;
    return own();
  }
}

