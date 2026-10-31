// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/migrate.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Moving a project store out of the repository: the cutover half of #542.
 *
 *   normal -> draining -> ready -> cutover -> normal        (failed on any error)
 *
 * Every step is recorded in the store's maintenance record before it runs, so a
 * migrator that dies at any point leaves a state `recover()` can finish or roll
 * back. The source is never deleted: after cutover it is kept, renamed, as a
 * backup until `gc()` re-validates the new store against it.
 *
 * WHAT MAKES `ready` TRUE. Both of these, never one:
 *
 *  1. OFFLINE CHECK. No process that may be a token-optimizer writer older than
 *     this protocol is running, AND the process list could be read completely.
 *     An enumeration that failed, or that cannot see every process (a
 *     container), is a blocker: inability to detect a writer is not evidence
 *     that none exists.
 *  2. FILESYSTEM FENCE. The store directory is renamed aside and a FILE is put
 *     at its path. Every write a legacy process attempts then fails with
 *     ENOTDIR inside the filesystem itself, and a probe write that must fail
 *     proves it before `ready` is recorded.
 *
 * Upgraded writers are drained through write leases (maintenance.mjs) and spool
 * while the store is in maintenance; the spool is replayed after cutover,
 * deduplicated by each record's `rid`.
 *
 * DURABILITY. Files and directories are fsynced before the route is published.
 * Process-crash safety is tested at every step; power-loss durability is NOT
 * claimed.
 */
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { hostname } from 'node:os';
import { canonicalPath } from './paths.mjs';
import {
  CUTOVER,
  DRAINING,
  FAILED,
  NORMAL,
  READY,
  controlDir,
  liveLeases,
  projectStore,
  readState,
  readTombstone,
  spoolDir,
  storeId,
} from './maintenance.mjs';

export { readTombstone };

/**
 * The store protocol a tombstone was written under. A name, not a release
 * number: which release first ships it is decided at release time, and the
 * offline check judges a writer by its code (takesWriteLeases), not by this.
 */
export const PROTOCOL_VERSION = 'write-leases/1';

const DRAIN_TIMEOUT_MS = 30_000;
const COPY_ATTEMPTS = 3;

/** Where a store lives once migrated. */
export const movedStoreDir = (id, env = process.env) => join(controlDir(id, env), 'store');

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dirname(path));
}

/** fsync a directory where the platform allows it (not Windows). */
function fsyncDir(dir) {
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Some filesystems refuse a directory fsync; the file fsyncs still hold.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function setState(id, record, env) {
  atomicJson(join(controlDir(id, env), 'maintenance.json'), {
    ...record,
    at: new Date().toISOString(),
    owner: { pid: process.pid, host: hostname() },
  });
}


/**
 * Every running process whose command line names token-optimizer, with the
 * version its path shows, and whether the list could be read completely.
 */
/** Every process listing goes through here, so no listing ever opens a console window. */
function listProcesses(command, args, options) {
  return execFileSync(command, args, { ...options, windowsHide: true });
}

export function tokenOptimizerProcesses({ run = listProcesses, platform = process.platform } = {}) {
  let lines;
  try {
    if (platform === 'win32') {
      lines = String(
        run(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
          ],
          { encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 * 1024 }
        )
      ).split(/\r?\n/);
    } else {
      lines = String(
        run('ps', ['-axww', '-o', 'pid=', '-o', 'command='], {
          encoding: 'utf8',
          timeout: 20_000,
          maxBuffer: 64 * 1024 * 1024,
        })
      )
        .split('\n')
        .map((l) => l.trim().replace(/^(\d+)\s+/, '$1\t'));
    }
  } catch (error) {
    return { complete: false, reason: `process list unreadable: ${error?.code || error?.message || error}`, found: [] };
  }
  // A container sees only its own namespace: a writer in another container on
  // the same volume is invisible, so the list cannot be called complete.
  if (platform === 'linux' && (existsSync('/.dockerenv') || existsSync('/run/.containerenv'))) {
    return { complete: false, reason: 'running in a container: other namespaces are invisible', found: [] };
  }
  const found = [];
  for (const line of lines) {
    const [pidText, command = ''] = line.split('\t');
    const pid = Number.parseInt(pidText, 10);
    if (!pid || pid === process.pid || !/token[-_]?optimizer/i.test(command)) continue;
    // ONLY A NODE PROCESS RUNNING A TOKEN-OPTIMIZER SCRIPT can write a store.
    // A shell whose command text merely mentions the name -- a hook wrapper, a
    // `cd` into this repository -- is not a writer; the node process it starts
    // is listed in its own right. Measured on one machine: 30 of 31 matches
    // were such shells, and every one of them blocked the migration.
    const exe = (/^"([^"]+)"|^(\S+)/.exec(command.trim()) || [])
      .slice(1)
      .find(Boolean);
    if (!/(^|[\\/])node(\.exe)?$/i.test(exe || '')) continue;
    if (!/token[-_]?optimizer[^\s"]*\.(m?js|cjs)\b/i.test(command)) continue;
    // The version a process runs is in its path: the plugin cache
    // (.../token-optimizer/<v>/...) or the managed runtime (versions/<v>/...).
    const m = /token-optimizer[\\/](\d+\.\d+\.\d+)[\\/]|versions[\\/](\d+\.\d+\.\d+)[\\/]/i.exec(command);
    found.push({
      pid,
      version: m ? m[1] || m[2] : null,
      leases: takesWriteLeases(scriptPath(command)),
      command: command.slice(0, 200),
    });
  }
  return { complete: true, found };
}

/** Reasons the offline check fails; empty means it holds. */
export function offlineBlockers(processes) {
  if (!processes.complete) return [processes.reason];
  return processes.found
    .filter((p) => p.leases !== true)
    .map((p) => `pid ${p.pid} runs token-optimizer ${p.version ?? '(unknown version)'}, whose code takes no write leases`);
}

/** The script a node command line runs, or null. */
function scriptPath(command) {
  // TOKENISED, NOT MATCHED. A single regex for "executable, flags, then the
  // script" nested a repeated `\S+` group before another `\S+`, which
  // backtracks exponentially on a crafted command line (CodeQL), and the
  // process list is not trusted input.
  const words = [];
  const text = String(command).trim();
  let i = 0;
  while (i < text.length && words.length < 64) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    if (text[i] === '"') {
      const end = text.indexOf('"', i + 1);
      const stop = end === -1 ? text.length : end;
      words.push(text.slice(i + 1, stop));
      i = stop + 1;
    } else {
      let j = i;
      while (j < text.length && !/\s/.test(text[j])) j++;
      words.push(text.slice(i, j));
      i = j;
    }
  }
  // words[0] is node itself; the script is the first non-flag argument.
  for (const word of words.slice(1)) {
    if (word.startsWith('-')) continue;
    return /\.(?:m?js|cjs)$/i.test(word) ? word : null;
  }
  return null;
}

/**
 * Whether the code a process runs takes write leases, judged from the code
 * itself rather than its version number.
 *
 * A VERSION FLOOR WAS WRONG HERE. The lease protocol ships in whichever release
 * first contains it, and that is decided at release time: a floor of "7.8.0"
 * would have counted a 7.8.0 that shipped without leases as safe, and the
 * migration would then have moved a store under a live writer. Instead the
 * installed package next to the running script is inspected: it takes leases
 * when its `maintenance.mjs` exports `withWriteLease`. Anything that cannot be
 * found or read counts as legacy -- inability to tell is not an all-clear.
 */
export function takesWriteLeases(script) {
  // ABSOLUTE ONLY. A relative path -- or a Windows path read on POSIX, where
  // `C:/x` is relative -- resolves against the current directory, and the walk
  // up from there finds whatever maintenance.mjs sits beside the caller.
  if (!script || !isAbsolute(script)) return false;
  let dir = dirname(script);
  for (let i = 0; i < 8 && dir; i++) {
    for (const candidate of [join(dir, 'maintenance.mjs'), join(dir, 'lib', 'maintenance.mjs'), join(dir, 'hooks-core', 'maintenance.mjs')]) {
      try {
        if (readFileSync(candidate, 'utf8').includes('export function withWriteLease')) return true;
      } catch {
        // Not here.
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return false;
}

/** sha256 of every file under `dir`, keyed by relative path. */
function treeHash(dir) {
  const out = {};
  const walk = (at) => {
    for (const name of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, name.name);
      if (name.isDirectory()) walk(path);
      else if (name.isFile()) out[relative(dir, path).replace(/\\/g, '/')] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

function copyTree(from, to) {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, name.name);
    const dst = join(to, name.name);
    if (name.isDirectory()) copyTree(src, dst);
    else if (name.isFile()) {
      copyFileSync(src, dst);
      const fd = openSync(dst, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }
  fsyncDir(to);
}

const sameTree = (a, b) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

/** Keep the tombstone and backup out of `git status`, in the clone's local exclude file. */
function excludeFromGit(root) {
  let gitDir = join(root, '.git');
  try {
    if (statSync(gitDir).isFile()) {
      // A worktree or submodule: `.git` names the real directory.
      const m = /gitdir:\s*(.+)/.exec(readFileSync(gitDir, 'utf8'));
      if (!m) return null;
      gitDir = canonicalPath(m[1].trim(), root);
      const common = join(gitDir, 'commondir');
      if (existsSync(common)) gitDir = canonicalPath(readFileSync(common, 'utf8').trim(), gitDir);
    }
  } catch {
    return null;
  }
  const exclude = join(gitDir, 'info', 'exclude');
  const lines = ['/.token-optimizer', '/.token-optimizer.migrated-*'];
  try {
    const have = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    const missing = lines.filter((l) => !have.split(/\r?\n/).includes(l));
    if (!missing.length) return [];
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${have && !have.endsWith('\n') ? '\n' : ''}# token-optimizer store tombstone and backup\n${missing.join('\n')}\n`);
    return missing;
  } catch {
    return null;
  }
}

/** A record's dedupe key: its `rid`, when that is a non-empty string. */
const ridOf = (record) => (typeof record?.rid === 'string' && record.rid ? record.rid : null);

/** Replay one spool directory into `dest`, skipping rids already present, then remove it. */
function replaySpoolDir(dir, dest) {
  const seen = new Map();
  const ridsIn = (file) => {
    if (!seen.has(file)) {
      const rids = new Set();
      let text = '';
      try {
        text = readFileSync(join(dest, file), 'utf8');
      } catch {
        // No such file yet.
      }
      // PARSED, not pattern-matched: a metrics rid is `<base36>-<hex>`, which
      // a hex-only pattern never saw, so every replay re-added every metric.
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rid = ridOf(JSON.parse(line));
          if (rid) rids.add(rid);
        } catch {
          // A torn last line carries no usable rid.
        }
      }
      seen.set(file, rids);
    }
    return seen.get(file);
  };
  let replayed = 0;
  let duplicates = 0;
  for (const name of readdirSync(dir).sort()) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const file = String(entry.file || '').replace(/\\/g, '/');
      if (!file || file.startsWith('..') || /^[a-z]:|^\//i.test(file)) continue;
      const rids = ridsIn(file);
      const rid = ridOf(entry.record);
      if (rid && rids.has(rid)) {
        duplicates += 1;
        continue;
      }
      mkdirSync(dirname(join(dest, file)), { recursive: true, mode: 0o700 });
      appendFileSync(join(dest, file), `${JSON.stringify(entry.record)}\n`);
      if (rid) rids.add(rid);
      replayed += 1;
    }
  }
  rmSync(dir, { recursive: true, force: true });
  return { replayed, duplicates };
}

/**
 * Hand a store's spool to `dest`, race-free. Call it only once the state is
 * back to NORMAL, so no new write spools.
 *
 * A writer that saw maintenance spools UNDER its lease (`withWriteLease`'s
 * `queue`), so once every lease held at the switch has cleared no spool append
 * can follow. Only then is the spool detached, in one rename, and replayed: an
 * append could otherwise land after the last read and sit in the spool for
 * good. A detached spool a crash left behind is replayed as well; the rid
 * dedupe makes a second pass harmless. A writer that outlives the wait spools
 * into a fresh directory, which the next session start replays.
 */
function settleSpool(id, dest, env, timeoutMs = DRAIN_TIMEOUT_MS) {
  const held = new Set(liveLeases(id, env, process.pid));
  const deadline = Date.now() + timeoutMs;
  while (held.size && liveLeases(id, env, process.pid).some((name) => held.has(name)) && Date.now() <= deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  const dir = spoolDir(id, env);
  try {
    renameSync(dir, `${dir}.replay-${Date.now()}-${process.pid}`);
  } catch (error) {
    // Nothing spooled is the common case. Anything else leaves the spool where
    // it is, for the next session start, rather than reading it while live.
    if (error?.code !== 'ENOENT') return { replayed: 0, duplicates: 0, spoolLeft: true };
  }
  let replayed = 0;
  let duplicates = 0;
  const parent = dirname(dir);
  for (const name of existsSync(parent) ? readdirSync(parent).sort() : []) {
    if (!name.startsWith(`${id}.replay-`)) continue;
    const r = replaySpoolDir(join(parent, name), dest);
    replayed += r.replayed;
    duplicates += r.duplicates;
  }
  return { replayed, duplicates };
}

/** A spool, live or detached, that no maintenance is in progress to replay. */
function spoolPending(id, env) {
  const dir = spoolDir(id, env);
  if (existsSync(dir)) return true;
  const parent = dirname(dir);
  return existsSync(parent) && readdirSync(parent).some((name) => name.startsWith(`${id}.replay-`));
}

/**
 * Migrate the store at `<root>/.token-optimizer` to the per-user store.
 *
 * Returns `{ ok: true, report }` or `{ ok: false, state, blockers }`. A refusal
 * before the fence changes nothing; a failure after it is rolled back.
 */
export function migrate(
  root,
  {
    env = process.env,
    processes = tokenOptimizerProcesses,
    now = () => new Date(),
    drainTimeoutMs = DRAIN_TIMEOUT_MS,
    // Called at each step boundary: the fault-injection tests throw (disk
    // full, EACCES) or kill the process here, and nothing else ever sets it.
    faultAt = () => {},
  } = {}
) {
  root = canonicalPath(root);
  const source = join(root, '.token-optimizer');
  const tomb = readTombstone(root);
  if (tomb?.movedTo) return { ok: true, report: { alreadyMoved: true, ...tomb } };
  // A FILE without `movedTo` is the fence of a migration that never finished:
  // the store is aside, not moved, and only recovery knows which way to go.
  if (tomb)
    return {
      ok: false,
      state: readState(tomb.storeId ?? storeId(source), env).state,
      blockers: [`an interrupted migration left its fence at ${source}; run \`token-optimizer-storage recover\``],
    };
  if (!existsSync(source)) return { ok: false, state: NORMAL, blockers: ['no store at ' + source] };
  const id = storeId(source);
  const control = controlDir(id, env);
  const current = readState(id, env);
  if (current.state !== NORMAL) return { ok: false, state: current.state, blockers: [`store is already ${current.state}`] };

  // 1. Offline check, before anything changes.
  const blockers = offlineBlockers(processes());
  if (blockers.length) {
    atomicJson(join(control, 'intent.json'), { root, requested: now().toISOString(), blockers });
    return { ok: false, state: NORMAL, blockers };
  }

  const generation = `${now().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const staged = `${source}.migrating-${generation}`;
  const dest = movedStoreDir(id, env);
  const fail = (step, error, rollback) => {
    try {
      rollback?.();
      setState(id, { state: NORMAL, previous: FAILED, step, reason: String(error?.message || error) }, env);
    } catch (inner) {
      setState(id, { state: FAILED, step, reason: `${error?.message || error}; rollback: ${inner?.message || inner}`, staged }, env);
      return { ok: false, state: FAILED, blockers: [`${step}: ${error?.message || error}`, `rollback failed: ${inner?.message || inner}`] };
    }
    // What writers spooled while it drained belongs to the store they found,
    // which the rollback has just put back. A short wait: a drain that timed
    // out did so on a lease that is still held, and whatever outlives this
    // wait is replayed at the next session start.
    try {
      settleSpool(id, source, env, Math.min(drainTimeoutMs, 1000));
    } catch {
      // Left for the next session start; the rollback itself succeeded.
    }
    return { ok: false, state: NORMAL, blockers: [`${step}: ${error?.message || error}`] };
  };

  // 2. Close admission and drain upgraded writers.
  setState(id, { state: DRAINING, step: 'drain', root, generation }, env);
  const deadline = Date.now() + drainTimeoutMs;
  while (liveLeases(id, env, process.pid).length) {
    if (Date.now() > deadline) return fail('drain', new Error(`writers still hold leases after ${drainTimeoutMs} ms`));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }

  // 3. Fence: move the store aside, put a FILE at its path, prove it blocks.
  try {
    faultAt('fence');
    renameSync(source, staged);
  } catch (error) {
    return fail('fence-rename', error);
  }
  const unfence = () => {
    rmSync(source, { force: true });
    renameSync(staged, source);
  };
  try {
    atomicJson(source, { state: 'migrating', storeId: id, generation, since: now().toISOString() });
    let blocked = false;
    try {
      mkdirSync(join(source, 'wiki'), { recursive: true });
    } catch {
      blocked = true;
    }
    if (!blocked) throw new Error('probe write was not blocked by the fence');
  } catch (error) {
    return fail('fence', error, unfence);
  }
  setState(id, { state: READY, step: 'copy', root, generation, staged }, env);

  // 4. Copy until the source is quiet, then validate byte for byte.
  const staging = `${dest}.staging-${generation}`;
  let hash;
  try {
    faultAt('copy');
    let attempt = 0;
    for (;;) {
      attempt += 1;
      hash = treeHash(staged);
      rmSync(staging, { recursive: true, force: true });
      copyTree(staged, staging);
      faultAt('copied', { staged, attempt });
      // A legacy append opened before the rename can still land in the moved
      // directory. If the source changed during the copy, copy again.
      if (sameTree(hash, treeHash(staged))) break;
      if (attempt >= COPY_ATTEMPTS) throw new Error('source kept changing during the copy');
    }
    if (!sameTree(hash, treeHash(staging))) throw new Error('copy does not match the source');
  } catch (error) {
    return fail('copy', error, () => {
      rmSync(staging, { recursive: true, force: true });
      unfence();
    });
  }

  // 5. Publish: one rename makes the new store authoritative.
  try {
    faultAt('publish');
    if (existsSync(dest)) throw new Error(`a store already exists at ${dest}`);
    // Recorded BEFORE the rename: a crash between it and CUTOVER leaves a
    // `dest` that recovery can then prove this migration made, and remove.
    setState(id, { state: READY, step: 'publish', root, generation, staged }, env);
    renameSync(staging, dest);
    fsyncDir(dirname(dest));
    faultAt('renamed');
    // The manifest is what gc checks the backup against: the moved store's
    // files may legitimately change after the move, the backup's may not.
    atomicJson(join(control, 'meta.json'), { root, storeId: id, movedAt: now().toISOString(), generation, manifest: hash });
    setState(id, { state: CUTOVER, step: 'publish', root, generation, staged }, env);
    faultAt('tombstone');
    atomicJson(source, { movedTo: dest, storeId: id, since: now().toISOString(), by: PROTOCOL_VERSION });
  } catch (error) {
    return fail('publish', error, () => {
      if (existsSync(dest) && !existsSync(staging)) renameSync(dest, staging);
      rmSync(staging, { recursive: true, force: true });
      unfence();
    });
  }

  // 6. Keep the source as a backup, reopen the store, then replay what
  // upgraded writers spooled. Reopening comes FIRST: see settleSpool.
  faultAt('backup');
  const backup = `${source}.migrated-${generation}`;
  renameSync(staged, backup);
  const excluded = excludeFromGit(root);
  rmSync(join(control, 'intent.json'), { force: true });
  faultAt('replay');
  setState(id, { state: NORMAL, step: 'done', root, generation }, env);
  const replay = settleSpool(id, dest, env);
  return {
    ok: true,
    report: { root, storeId: id, movedTo: dest, backup, files: Object.keys(hash).length, ...replay, gitExclude: excluded },
  };
}

/**
 * Finish or undo a migration a crash interrupted, from its recorded step.
 * Before publish: roll back. After publish: complete.
 */
export function recover(root, { env = process.env } = {}) {
  root = canonicalPath(root);
  const source = join(root, '.token-optimizer');
  const tomb = readTombstone(root);
  const id = tomb?.storeId ?? storeId(source);
  const state = readState(id, env);
  if (state.state === NORMAL) return { recovered: false, state: NORMAL };
  if (state.direction === 'restore') return recoverRestore(root, id, state, env);
  const staged = state.staged || (state.generation && `${source}.migrating-${state.generation}`);
  const dest = movedStoreDir(id, env);
  if (state.state === CUTOVER || (tomb?.movedTo && existsSync(dest))) {
    if (staged && existsSync(staged)) renameSync(staged, `${source}.migrated-${state.generation}`);
    if (!tomb?.movedTo) atomicJson(source, { movedTo: dest, storeId: id, since: new Date().toISOString(), by: PROTOCOL_VERSION });
    excludeFromGit(root);
    setState(id, { state: NORMAL, step: 'done', root, generation: state.generation, recovered: true }, env);
    settleSpool(id, dest, env);
    return { recovered: true, state: NORMAL, completed: true };
  }
  // KILLED INSIDE PUBLISH, between the rename and CUTOVER: `dest` is this
  // migration's copy -- the step was recorded before the rename, and the
  // staging directory it was renamed from is gone. Anything else at `dest`
  // was not made here and is left alone.
  const staging = state.generation && `${dest}.staging-${state.generation}`;
  if (state.state === READY && state.step === 'publish' && staging && !existsSync(staging) && existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
  if (staged && existsSync(staged)) {
    rmSync(source, { force: true });
    renameSync(staged, source);
  }
  for (const name of existsSync(dirname(dest)) ? readdirSync(dirname(dest)) : []) {
    if (name.startsWith('store.staging-')) rmSync(join(dirname(dest), name), { recursive: true, force: true });
  }
  setState(id, { state: NORMAL, step: 'rolled-back', root, generation: state.generation, recovered: true }, env);
  settleSpool(id, source, env);
  return { recovered: true, state: NORMAL, completed: false };
}

/** Delete a migration backup, but only after re-validating the moved store against it. */
export function gc(root, { env = process.env } = {}) {
  root = canonicalPath(root);
  const tomb = readTombstone(root);
  if (!tomb?.movedTo) return { ok: false, reason: 'store has not been migrated' };
  const backups = readdirSync(root).filter((n) => n.startsWith('.token-optimizer.migrated-'));
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(join(controlDir(tomb.storeId, env), 'meta.json'), 'utf8'));
  } catch {
    // No manifest: every file is held to the moved store's contents instead.
  }
  const removed = [];
  for (const name of backups) {
    const backup = join(root, name);
    // The manifest proves what the copy received. A backup file still matching
    // it was copied, so the moved store only has to still HAVE it: a rules or
    // index file rewritten since the move is not data missing from the move.
    const manifest = name === `.token-optimizer.migrated-${meta.generation}` && meta.manifest ? meta.manifest : {};
    const moved = treeHash(tomb.movedTo);
    const missing = Object.entries(treeHash(backup)).filter(([file, sum]) => {
      if (!moved[file]) return true;
      if (moved[file] === sum) return false;
      // Append-only logs may have grown since: every original byte must still
      // be there at the front.
      if (file.endsWith('.jsonl')) {
        const was = readFileSync(join(backup, file));
        const now = readFileSync(join(tomb.movedTo, file));
        return !now.subarray(0, was.length).equals(was);
      }
      // Anything else changed: fine if the backup holds exactly what was
      // copied; a backup that differs from the copy holds bytes the move lacks.
      return manifest[file] !== sum;
    });
    if (missing.length) return { ok: false, reason: `moved store lacks ${missing.length} file(s) of ${name}`, missing: missing.map(([f]) => f) };
    rmSync(backup, { recursive: true, force: true });
    removed.push(name);
  }
  return { ok: true, removed };
}

function ownerAlive(owner) {
  if (!owner || owner.host !== hostname()) return true; // another host's process: cannot tell, assume alive
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Called at session start: finish what an earlier migration left.
 *
 * - A migration whose owner process died mid-way is recovered (rolled back
 *   before publish, completed after).
 * - A migration that was refused and recorded its intent is retried; it
 *   completes the first time the offline check and the fence both hold.
 *
 * Returns a one-line notice for the session, or null. Costs one stat when there
 * is nothing to do; enumerates processes only when an intent is pending.
 */
export function resumeIfDue(root, { env = process.env, processes = tokenOptimizerProcesses } = {}) {
  try {
    root = canonicalPath(root);
    const source = join(root, '.token-optimizer');
    const tomb = readTombstone(root);
    const id = tomb?.storeId ?? storeId(source);
    const control = controlDir(id, env);
    if (!existsSync(control)) return null;
    const state = readState(id, env);
    // FIRST, an interrupted move in either direction -- a restore leaves the
    // tombstone in place until its last step, so this comes before the check
    // that a moved store needs nothing.
    if (state.state !== NORMAL && !ownerAlive(state.owner)) {
      const done = recover(root, { env });
      if (state.direction === 'restore')
        return done.completed
          ? `token-optimizer finished moving this project's graph back into ${source} after an interrupted restore. Tell the user once.`
          : `token-optimizer rolled back an interrupted restore; the graph stays in ${movedStoreDir(id, env)}. Tell the user once.`;
      return done.completed
        ? `token-optimizer finished moving this project's graph to ${movedStoreDir(id, env)} after an interrupted migration. Tell the user once.`
        : `token-optimizer rolled back an interrupted store migration; the graph is unchanged in ${source}. Tell the user once.`;
    }
    // A spool no maintenance is replaying: a writer outlived the final wait, or
    // the process died between reopening the store and replaying it.
    if (state.state === NORMAL && spoolPending(id, env)) settleSpool(id, projectStore(root), env);
    if (tomb?.movedTo) return null;
    if (!existsSync(join(control, 'intent.json')) || state.state !== NORMAL) return null;
    const result = migrate(root, { env, processes });
    return result.ok
      ? `token-optimizer moved this project's graph to ${result.report.movedTo}, as requested earlier; the old store is kept as ${result.report.backup} until \`token-optimizer-storage gc\`. Tell the user once.`
      : null;
  } catch {
    // Session start must never fail because of a migration.
    return null;
  }
}

/**
 * Move a migrated store back into its repository: the same machinery in reverse.
 *
 * The moved store stays authoritative until one step: the tombstone FILE is
 * swapped for the restored DIRECTORY. Before that step a crash rolls back to the
 * moved store; after it, recovery completes. Writes made after the original
 * move are kept, because the moved store is what is copied. The moved store is
 * kept as `store.restored-<generation>` until removed by hand.
 */
export function restore(root, { env = process.env, processes = tokenOptimizerProcesses, now = () => new Date(), faultAt = () => {} } = {}) {
  root = canonicalPath(root);
  const marker = join(root, '.token-optimizer');
  const tomb = readTombstone(root);
  if (!tomb?.movedTo) return { ok: false, state: NORMAL, blockers: ['store has not been migrated'] };
  const id = tomb.storeId;
  const moved = tomb.movedTo;
  if (readState(id, env).state !== NORMAL) return { ok: false, state: readState(id, env).state, blockers: ['store is in maintenance'] };
  // The same two conditions as a migration: while a pre-7.8 writer runs, it is
  // the tombstone that keeps it out of the repository, and it is about to go.
  const blockers = offlineBlockers(processes());
  if (blockers.length) return { ok: false, state: NORMAL, blockers };

  const generation = `${now().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const staging = `${marker}.restoring-${generation}`;
  setState(id, { state: DRAINING, direction: 'restore', step: 'drain', root, generation, staging }, env);
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (liveLeases(id, env, process.pid).length) {
    if (Date.now() > deadline) {
      setState(id, { state: NORMAL, previous: FAILED, direction: 'restore', step: 'drain', reason: 'writers still hold leases' }, env);
      return { ok: false, state: NORMAL, blockers: ['drain: writers still hold leases after 30 s'] };
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  try {
    faultAt('copy');
    copyTree(moved, staging);
    if (!sameTree(treeHash(moved), treeHash(staging))) throw new Error('copy does not match the moved store');
    setState(id, { state: CUTOVER, direction: 'restore', step: 'swap', root, generation, staging }, env);
    faultAt('swap');
    // THE ONE NON-ATOMIC STEP: a file cannot be renamed over a directory.
    // Recovery from `swap` with no marker present completes the rename.
    rmSync(marker, { force: true });
    faultAt('tombstone-removed');
    renameSync(staging, marker);
  } catch (error) {
    // A swap that removed the tombstone and then failed to rename would leave
    // the moved store undiscoverable: put the tombstone back first.
    if (!existsSync(marker)) atomicJson(marker, tomb);
    rmSync(staging, { recursive: true, force: true });
    setState(id, { state: NORMAL, previous: FAILED, direction: 'restore', reason: String(error?.message || error) }, env);
    try {
      settleSpool(id, moved, env, 1000);
    } catch {
      // Left for the next session start.
    }
    return { ok: false, state: NORMAL, blockers: [`restore: ${error?.message || error}`] };
  }
  return finishRestore(root, id, generation, env);
}

function finishRestore(root, id, generation, env) {
  const marker = join(root, '.token-optimizer');
  const moved = movedStoreDir(id, env);
  const kept = `${moved}.restored-${generation}`;
  if (existsSync(moved)) renameSync(moved, kept);
  setState(id, { state: NORMAL, direction: 'restore', step: 'done', root, generation }, env);
  const replay = settleSpool(id, marker, env);
  return { ok: true, report: { root, restoredTo: marker, movedStoreKept: kept, ...replay } };
}

function recoverRestore(root, id, state, env) {
  const marker = join(root, '.token-optimizer');
  const staging = state.staging;
  let markerIsDir = false;
  try {
    markerIsDir = statSync(marker).isDirectory();
  } catch {
    // Absent: the crash fell between removing the tombstone and the rename.
  }
  if (state.state === CUTOVER && staging && existsSync(staging) && !markerIsDir) {
    rmSync(marker, { force: true });
    renameSync(staging, marker);
    markerIsDir = true;
  }
  if (markerIsDir) {
    finishRestore(root, id, state.generation, env);
    return { recovered: true, state: NORMAL, completed: true };
  }
  if (staging) rmSync(staging, { recursive: true, force: true });
  if (!existsSync(marker))
    atomicJson(marker, { movedTo: movedStoreDir(id, env), storeId: id, since: new Date().toISOString(), by: PROTOCOL_VERSION });
  setState(id, { state: NORMAL, direction: 'restore', step: 'rolled-back', root, recovered: true }, env);
  settleSpool(id, movedStoreDir(id, env), env);
  return { recovered: true, state: NORMAL, completed: false };
}
