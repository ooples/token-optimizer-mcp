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
import { execFileSync, spawn } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname, tmpdir } from 'node:os';
import { canonicalPath } from './paths.mjs';
import {
  CUTOVER,
  DRAINING,
  FAILED,
  NORMAL,
  READY,
  controlDir,
  liveLeases,
  movedStoreDir,
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
// How often session start retries a migration that was blocked.
const RETRY_INTERVAL_MS = 60 * 60 * 1000;
const COPY_ATTEMPTS = 3;

/** Where a store lives once migrated. */
export { movedStoreDir };

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
  const lines = ['/.token-optimizer'];
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
  // The newest `at` the destination holds per record id. The store reopens
  // BEFORE the spool is replayed, so a writer can append a newer record for an
  // id directly; the graph folds last-write-wins by position, and appending the
  // older spooled record after it would bring the stale value back.
  const latestIn = new Map();
  const ridsIn = (file) => {
    if (!seen.has(file)) {
      const rids = new Set();
      const latest = new Map();
      latestIn.set(file, latest);
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
          const record = JSON.parse(line);
          const rid = ridOf(record);
          if (rid) rids.add(rid);
          if (typeof record?.id === 'string' && Number.isFinite(record?.at))
            latest.set(record.id, Math.max(latest.get(record.id) ?? 0, record.at));
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
  let superseded = 0;
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
      const record = entry.record;
      const latest = latestIn.get(file);
      if (typeof record?.id === 'string' && Number.isFinite(record?.at) && (latest.get(record.id) ?? 0) > record.at) {
        superseded += 1;
        continue;
      }
      mkdirSync(dirname(join(dest, file)), { recursive: true, mode: 0o700 });
      appendFileSync(join(dest, file), `${JSON.stringify(record)}\n`);
      if (rid) rids.add(rid);
      if (typeof record?.id === 'string' && Number.isFinite(record?.at))
        latest.set(record.id, Math.max(latest.get(record.id) ?? 0, record.at));
      replayed += 1;
    }
  }
  rmSync(dir, { recursive: true, force: true });
  return { replayed, duplicates, superseded };
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
 * One migrator per store at a time (review). Two processes could both pass the
 * `normal` check; the second one's failed fence rename then wrote `normal` while
 * the first was still copying, and writers stopped spooling. The claim is an
 * exclusively created file, taken before the state check and held across every
 * return. A claim whose owner is a dead process on this host is stale.
 */
function withMigrationClaim(id, env, run) {
  const claim = join(controlDir(id, env), 'migrate.claim');
  mkdirSync(controlDir(id, env), { recursive: true, mode: 0o700 });
  const busy = () => ({
    ok: false,
    state: readState(id, env).state,
    blockers: ['another migration of this store is in progress'],
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(claim, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }), {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let owner = null;
      try {
        owner = JSON.parse(readFileSync(claim, 'utf8'));
      } catch {
        // Torn: being written right now, so not stale.
      }
      if (attempt === 0 && owner && !ownerAlive(owner)) {
        rmSync(claim, { force: true });
        continue;
      }
      return busy();
    }
    try {
      return run();
    } finally {
      rmSync(claim, { force: true });
    }
  }
  return busy();
}

/**
 * Migrate the store at `<root>/.token-optimizer` to the per-user store.
 *
 * Returns `{ ok: true, report }` or `{ ok: false, state, blockers }`. A refusal
 * before the fence changes nothing; a failure after it is rolled back.
 */
export function migrate(root, options = {}) {
  const canonical = canonicalPath(root);
  return withMigrationClaim(storeId(join(canonical, '.token-optimizer')), options.env ?? process.env, () =>
    migrateClaimed(canonical, options)
  );
}

function migrateClaimed(
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
  // Whether `dest` was created by this migration. After a MERGE it holds the
  // project's earlier per-user data too, and a rollback must never remove it.
  let createdDest = false;
  try {
    faultAt('publish');
    if (existsSync(dest)) {
      // THE PROJECT ALREADY HAS A PER-USER STORE (review): a release that keeps
      // stores outside projects wrote one, then an older client recreated the
      // in-repo store. Refusing here repeated the whole drain, fence and copy
      // every hour only to fail, and left the per-user data hidden behind the
      // in-repo store. The two are MERGED instead. The merge is idempotent, so
      // a crash in it is completed by recovery, never rolled back.
      setState(id, { state: READY, step: 'merging', root, generation, staged }, env);
      mergeStore(staging, dest);
      faultAt('merged');
      rmSync(staging, { recursive: true, force: true });
    } else {
      // Recorded BEFORE the rename: a crash between it and CUTOVER leaves a
      // `dest` that recovery can then prove this migration made, and remove.
      setState(id, { state: READY, step: 'publish', root, generation, staged }, env);
      renameSync(staging, dest);
      createdDest = true;
    }
    fsyncDir(dirname(dest));
    faultAt('renamed');
    // The manifest is what gc checks the backup against: the moved store's
    // files may legitimately change after the move, the backup's may not.
    // MERGED INTO, not replaced: the record also carries what other code put
    // there -- the repository's first commit that lets a moved repository
    // find its store again.
    let previous = {};
    try {
      previous = JSON.parse(readFileSync(join(control, 'meta.json'), 'utf8'));
    } catch {
      // No record yet.
    }
    atomicJson(join(control, 'meta.json'), {
      ...previous,
      root,
      storeId: id,
      movedAt: now().toISOString(),
      generation,
      manifest: hash,
    });
    setState(id, { state: CUTOVER, step: 'publish', root, generation, staged }, env);
    faultAt('tombstone');
    atomicJson(source, { movedTo: dest, storeId: id, since: now().toISOString(), by: PROTOCOL_VERSION });
  } catch (error) {
    return fail('publish', error, () => {
      // ONLY A DESTINATION THIS MIGRATION CREATED is taken back (review).
      // After a merge, `dest` is the project's existing per-user store plus
      // the merged records: it stays, and a retry merges again (idempotently).
      if (createdDest && existsSync(dest) && !existsSync(staging)) renameSync(dest, staging);
      rmSync(staging, { recursive: true, force: true });
      unfence();
    });
  }

  // 6. Keep the source as a backup, reopen the store, then replay what
  // upgraded writers spooled. Reopening comes FIRST: see settleSpool.
  faultAt('backup');
  const backup = keepBackup(staged, id, generation, env);
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
    if (staged && existsSync(staged)) keepBackup(staged, id, state.generation, env);
    if (!tomb?.movedTo) atomicJson(source, { movedTo: dest, storeId: id, since: new Date().toISOString(), by: PROTOCOL_VERSION });
    excludeFromGit(root);
    setState(id, { state: NORMAL, step: 'done', root, generation: state.generation, recovered: true }, env);
    settleSpool(id, dest, env);
    return { recovered: true, state: NORMAL, completed: true };
  }
  // KILLED WHILE MERGING into an existing per-user store: the merge is
  // idempotent, so it is finished, and the move completed like any other.
  const merging = state.generation && `${dest}.staging-${state.generation}`;
  if (state.state === READY && state.step === 'merging' && merging && existsSync(merging) && existsSync(dest)) {
    mergeStore(merging, dest);
    rmSync(merging, { recursive: true, force: true });
    atomicJson(source, { movedTo: dest, storeId: id, since: new Date().toISOString(), by: PROTOCOL_VERSION });
    if (staged && existsSync(staged)) keepBackup(staged, id, state.generation, env);
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

/**
 * Merge the store copied to `src` into the existing store at `dest`.
 *
 * Append-only logs (`*.jsonl`) gain only the records `dest` lacks: by `rid`, or
 * by the exact line for records an older release wrote without one. A graph
 * record older than the copy `dest` already holds for its id is skipped, since
 * the graph folds last-write-wins by position. Every other file (artifacts,
 * which are content-addressed, rules, caches) is copied only where `dest` has
 * none. Running it twice changes nothing the second time.
 */
function mergeStore(src, dest) {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : entry.isFile() ? [join(dir, entry.name)] : []
    );
  for (const from of walk(src)) {
    const rel = relative(src, from);
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    if (!rel.endsWith('.jsonl')) {
      if (!existsSync(to)) copyFileSync(from, to);
      continue;
    }
    const keys = new Set();
    const latest = new Map();
    let text = '';
    try {
      text = readFileSync(to, 'utf8');
    } catch {
      // Not in dest yet.
    }
    const note = (line, record) => {
      keys.add(typeof record?.rid === 'string' && record.rid ? `rid:${record.rid}` : `line:${line}`);
      if (typeof record?.id === 'string' && Number.isFinite(record?.at))
        latest.set(record.id, Math.max(latest.get(record.id) ?? 0, record.at));
    };
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        note(line, JSON.parse(line));
      } catch {
        // A torn line carries nothing to match.
      }
    }
    const add = [];
    for (const line of readFileSync(from, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const key = typeof record?.rid === 'string' && record.rid ? `rid:${record.rid}` : `line:${line}`;
      if (keys.has(key)) continue;
      if (typeof record?.id === 'string' && Number.isFinite(record?.at) && (latest.get(record.id) ?? 0) > record.at) continue;
      add.push(line);
      note(line, record);
    }
    if (add.length) appendFileSync(to, `${text && !text.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
  }
}

/**
 * Keep the pre-migration store as a backup OUTSIDE the project (#538).
 *
 * Beside the repository it stayed in the project until `gc` -- and for an
 * installed plugin that is a permanent extra change to the bundle whose
 * fingerprint the move exists to stop disturbing. It goes to the store's
 * control directory instead. A rename across volumes fails (EXDEV), so the
 * backup is then copied, checked byte for byte, and the original removed.
 */
function keepBackup(staged, id, generation, env) {
  const backup = join(controlDir(id, env), `backup-${generation}`);
  // A HALF-COPIED BACKUP from an interrupted cross-volume copy would make every
  // later rename fail and wedge recovery. The staged store is still the
  // original, so the partial copy is discarded and made again.
  if (existsSync(staged) && existsSync(backup)) rmSync(backup, { recursive: true, force: true });
  try {
    renameSync(staged, backup);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    copyTree(staged, backup);
    if (!sameTree(treeHash(staged), treeHash(backup))) throw new Error('backup copy does not match the store');
    rmSync(staged, { recursive: true, force: true });
  }
  return backup;
}

/** Every migration backup kept for a store. */
function backupsOf(id, env) {
  const control = controlDir(id, env);
  try {
    return readdirSync(control)
      .filter((name) => name.startsWith('backup-'))
      .map((name) => ({ name, path: join(control, name) }));
  } catch {
    return [];
  }
}

/** Delete a migration backup, but only after re-validating the moved store against it. */
export function gc(root, { env = process.env } = {}) {
  root = canonicalPath(root);
  const tomb = readTombstone(root);
  if (!tomb?.movedTo) return { ok: false, reason: 'store has not been migrated' };
  // Backups kept outside the project (#538), and any an earlier release left
  // beside it.
  const backups = [
    ...backupsOf(tomb.storeId, env),
    ...readdirSync(root)
      .filter((n) => n.startsWith('.token-optimizer.migrated-'))
      .map((name) => ({ name, path: join(root, name) })),
  ];
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(join(controlDir(tomb.storeId, env), 'meta.json'), 'utf8'));
  } catch {
    // No manifest: every file is held to the moved store's contents instead.
  }
  const removed = [];
  for (const { name, path: backup } of backups) {
    // The manifest proves what the copy received. A backup file still matching
    // it was copied, so the moved store only has to still HAVE it: a rules or
    // index file rewritten since the move is not data missing from the move.
    const manifest = meta.generation && name.endsWith(meta.generation) && meta.manifest ? meta.manifest : {};
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
export function resumeIfDue(root, { env = process.env, processes = tokenOptimizerProcesses, background = true } = {}) {
  try {
    root = canonicalPath(root);
    const source = join(root, '.token-optimizer');
    const tomb = readTombstone(root);
    const id = tomb?.storeId ?? storeId(source);
    const control = controlDir(id, env);
    // AN IN-REPO STORE IS MIGRATED AUTOMATICALLY (#538): a session start that
    // finds one is the request. Anything else with no control directory has
    // nothing to finish.
    let inRepo = false;
    try {
      inRepo = !tomb && statSync(source).isDirectory();
    } catch {
      inRepo = false;
    }
    if (!existsSync(control) && !inRepo) return null;
    // A LOCATION THE USER CONFIGURED is theirs. With a store directory set by
    // environment, the in-repo store is what they pointed at -- moving it would
    // pull it out from under their configuration (and from under this very
    // session, which reads it next).
    if (inRepo && STORE_OVERRIDES.some((name) => env[name])) inRepo = false;

    // What a background run finished since the last session start, said once.
    const notice = takeNotice(control);
    const state = readState(id, env);
    const recoverable = state.state !== NORMAL && !ownerAlive(state.owner);
    const spooled = state.state === NORMAL && spoolPending(id, env);
    const wanted = !tomb?.movedTo && inRepo && state.state === NORMAL && retryDue(control);
    if (!recoverable && !spooled && !wanted) return notice;

    // NOT IN THE HOOK (review of #546). A migration copies and hashes the
    // whole store, and recovery may wait up to 30 s for writers' leases; the
    // Codex hooks have 5 s. Killed by the hook timeout mid-copy, a migration was
    // rolled back and retried hourly, for ever. The work runs in a detached
    // process that outlives the hook, under the same claim as any migration.
    if (background) {
      launchBackground(root, env);
      return notice;
    }
    return runDue(root, { env, processes }) ?? notice;
  } catch {
    // Session start must never fail because of a migration.
    return null;
  }
}

/** Environment settings that place a store where the user chose. */
const STORE_OVERRIDES = ['TOKEN_OPTIMIZER_WIKI_DIR', 'TOKEN_OPTIMIZER_UCR_DIR'];

/** Is an automatic migration attempt due? At most hourly while it stays blocked. */
function retryDue(control) {
  try {
    const intent = JSON.parse(readFileSync(join(control, 'intent.json'), 'utf8'));
    return Date.now() - Date.parse(intent.lastTry || intent.requested || 0) >= RETRY_INTERVAL_MS;
  } catch {
    return true;
  }
}

/** Record that an attempt was made now, so the next is an hour away. */
function markTried(control, root) {
  try {
    let intent = { root };
    try {
      intent = JSON.parse(readFileSync(join(control, 'intent.json'), 'utf8'));
    } catch {
      // First attempt.
    }
    atomicJson(join(control, 'intent.json'), { ...intent, lastTry: new Date().toISOString() });
  } catch {
    // Without the mark the next session start simply tries again.
  }
}

/** Leave a one-line notice for the next session start. */
function leaveNotice(control, text) {
  try {
    atomicJson(join(control, 'notice.json'), { text, at: new Date().toISOString() });
  } catch {
    // The work is done either way; only the message is lost.
  }
}

/** Read and remove the pending notice, if any. */
function takeNotice(control) {
  const path = join(control, 'notice.json');
  try {
    const { text } = JSON.parse(readFileSync(path, 'utf8'));
    rmSync(path, { force: true });
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/**
 * Do whatever is due for `root`, synchronously: recover an interrupted move,
 * replay a stray spool, or attempt the automatic migration. Returns the notice
 * for the user, or null. The background process runs this; tests call it
 * directly with `background: false`.
 */
export function runDue(root, { env = process.env, processes = tokenOptimizerProcesses } = {}) {
  root = canonicalPath(root);
  const source = join(root, '.token-optimizer');
  const tomb = readTombstone(root);
  const id = tomb?.storeId ?? storeId(source);
  const control = controlDir(id, env);
  const state = readState(id, env);
  let text = null;
  if (state.state !== NORMAL && !ownerAlive(state.owner)) {
    const done = recover(root, { env });
    if (state.direction === 'restore')
      text = done.completed
        ? `token-optimizer finished moving this project's graph back into ${source} after an interrupted restore. Tell the user once.`
        : `token-optimizer rolled back an interrupted restore; the graph stays in ${movedStoreDir(id, env)}. Tell the user once.`;
    else
      text = done.completed
        ? `token-optimizer finished moving this project's graph to ${movedStoreDir(id, env)} after an interrupted migration. Tell the user once.`
        : `token-optimizer rolled back an interrupted store migration; the graph is unchanged in ${source}. Tell the user once.`;
  } else if (state.state === NORMAL && spoolPending(id, env)) {
    // A spool no maintenance is replaying: a writer outlived the final wait,
    // or the process died between reopening the store and replaying it.
    settleSpool(id, projectStore(root, env), env);
  } else if (!tomb?.movedTo && state.state === NORMAL && retryDue(control) && !STORE_OVERRIDES.some((name) => env[name])) {
    let inRepo = false;
    try {
      inRepo = statSync(source).isDirectory();
    } catch {
      inRepo = false;
    }
    if (inRepo) {
      markTried(control, root);
      const result = migrate(root, { env, processes });
      if (result.ok && !result.report.alreadyMoved)
        text = `token-optimizer moved this project's graph out of the repository, to ${result.report.movedTo}; the old store is kept as ${result.report.backup} until \`token-optimizer-storage gc\`. Tell the user once.`;
    }
  }
  if (text) leaveNotice(control, text);
  return text;
}

/** Start `runDue` for `root` in a detached process that outlives this hook. */
function launchBackground(root, env) {
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--run-due', root], {
      // NOT THE PROJECT'S DIRECTORY. A process holds its working directory
      // open, and on Windows that locks it: the user could not delete or
      // rename their project while the background migration ran (EBUSY).
      cwd: tmpdir(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    child.unref();
  } catch {
    // Not launched: the next session start tries again.
  }
}

// `node migrate.mjs --run-due <root>`: the background half of resumeIfDue.
if (process.argv[2] === '--run-due' && process.argv[3] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  try {
    runDue(process.argv[3]);
  } catch {
    // Nothing to report to: the next session start retries.
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
export function restore(root, options = {}) {
  const canonical = canonicalPath(root);
  const tomb = readTombstone(canonical);
  if (!tomb?.movedTo) return { ok: false, state: NORMAL, blockers: ['store has not been migrated'] };
  return withMigrationClaim(tomb.storeId, options.env ?? process.env, () => restoreClaimed(canonical, options));
}

function restoreClaimed(root, { env = process.env, processes = tokenOptimizerProcesses, now = () => new Date(), faultAt = () => {} } = {}) {
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
