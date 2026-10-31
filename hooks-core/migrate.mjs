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
import { dirname, join, relative } from 'node:path';
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

/** Compare dotted versions; a missing part counts as 0. */
export function olderThan(version, floor) {
  const a = String(version).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const b = String(floor).split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  return false;
}

/**
 * Every running process whose command line names token-optimizer, with the
 * version its path shows, and whether the list could be read completely.
 */
export function tokenOptimizerProcesses({ run = execFileSync, platform = process.platform } = {}) {
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
          { encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
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
  const m = /(?:^"[^"]+"|^\S+)\s+(?:--?\S+\s+)*("([^"]+\.(?:m?js|cjs))"|(\S+\.(?:m?js|cjs)))/i.exec(command.trim());
  return m ? m[2] || m[3] : null;
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
  if (!script) return false;
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

/** Replay a store's spool into the moved store, skipping rids already present. */
function replaySpool(id, dest, env) {
  const dir = spoolDir(id, env);
  if (!existsSync(dir)) return { replayed: 0, duplicates: 0 };
  const seen = new Map();
  const ridsIn = (file) => {
    if (!seen.has(file)) {
      const rids = new Set();
      try {
        for (const line of readFileSync(join(dest, file), 'utf8').split('\n')) {
          const rid = /"rid":"([0-9a-f]+)"/.exec(line)?.[1];
          if (rid) rids.add(rid);
        }
      } catch {
        // No such file yet.
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
      if (entry.record?.rid && rids.has(entry.record.rid)) {
        duplicates += 1;
        continue;
      }
      mkdirSync(dirname(join(dest, file)), { recursive: true, mode: 0o700 });
      appendFileSync(join(dest, file), `${JSON.stringify(entry.record)}\n`);
      if (entry.record?.rid) rids.add(entry.record.rid);
      replayed += 1;
    }
  }
  rmSync(dir, { recursive: true, force: true });
  return { replayed, duplicates };
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
  if (readTombstone(root)) return { ok: true, report: { alreadyMoved: true, ...readTombstone(root) } };
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
    renameSync(staging, dest);
    fsyncDir(dirname(dest));
    atomicJson(join(control, 'meta.json'), { root, storeId: id, movedAt: now().toISOString() });
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

  // 6. Replay what upgraded writers spooled, keep the source as a backup.
  faultAt('replay');
  const replay = replaySpool(id, dest, env);
  faultAt('backup');
  const backup = `${source}.migrated-${generation}`;
  renameSync(staged, backup);
  const excluded = excludeFromGit(root);
  rmSync(join(control, 'intent.json'), { force: true });
  setState(id, { state: NORMAL, step: 'done', root, generation }, env);
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
    replaySpool(id, dest, env);
    if (staged && existsSync(staged)) renameSync(staged, `${source}.migrated-${state.generation}`);
    if (!tomb?.movedTo) atomicJson(source, { movedTo: dest, storeId: id, since: new Date().toISOString(), by: PROTOCOL_VERSION });
    excludeFromGit(root);
    setState(id, { state: NORMAL, step: 'done', root, generation: state.generation, recovered: true }, env);
    return { recovered: true, state: NORMAL, completed: true };
  }
  if (staged && existsSync(staged)) {
    rmSync(source, { force: true });
    renameSync(staged, source);
  }
  for (const name of existsSync(dirname(dest)) ? readdirSync(dirname(dest)) : []) {
    if (name.startsWith('store.staging-')) rmSync(join(dirname(dest), name), { recursive: true, force: true });
  }
  setState(id, { state: NORMAL, step: 'rolled-back', root, generation: state.generation, recovered: true }, env);
  return { recovered: true, state: NORMAL, completed: false };
}

/** Delete a migration backup, but only after re-validating the moved store against it. */
export function gc(root, { env = process.env } = {}) {
  root = canonicalPath(root);
  const tomb = readTombstone(root);
  if (!tomb?.movedTo) return { ok: false, reason: 'store has not been migrated' };
  const backups = readdirSync(root).filter((n) => n.startsWith('.token-optimizer.migrated-'));
  const removed = [];
  for (const name of backups) {
    const backup = join(root, name);
    const moved = treeHash(tomb.movedTo);
    const missing = Object.entries(treeHash(backup)).filter(([file, sum]) => {
      // Append-only logs may have grown since: every original byte must still
      // be there at the front. Anything else must match exactly.
      if (!moved[file]) return true;
      if (moved[file] === sum) return false;
      const was = readFileSync(join(backup, file));
      const now = readFileSync(join(tomb.movedTo, file));
      return !(file.endsWith('.jsonl') && now.subarray(0, was.length).equals(was));
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
    renameSync(staging, marker);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    setState(id, { state: NORMAL, previous: FAILED, direction: 'restore', reason: String(error?.message || error) }, env);
    return { ok: false, state: NORMAL, blockers: [`restore: ${error?.message || error}`] };
  }
  return finishRestore(root, id, generation, env);
}

function finishRestore(root, id, generation, env) {
  const marker = join(root, '.token-optimizer');
  const moved = movedStoreDir(id, env);
  const replay = replaySpool(id, marker, env);
  const kept = `${moved}.restored-${generation}`;
  if (existsSync(moved)) renameSync(moved, kept);
  setState(id, { state: NORMAL, direction: 'restore', step: 'done', root, generation }, env);
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
  return { recovered: true, state: NORMAL, completed: false };
}
