// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/maintenance.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Maintenance mode for a project store: the coordination half of #542.
 *
 * A store is `<root>/.token-optimizer/`. Moving it (part 3, `storage migrate`)
 * needs a point after which no upgraded writer touches the old copy, and this
 * module provides it:
 *
 *   normal -> draining -> ready -> cutover -> normal      (and `failed`)
 *
 * WRITE LEASES, FAIL-CLOSED. Every upgraded write takes a lease BEFORE it reads
 * the state and drops it after its append, so route selection through completion
 * is covered: a migrator that sets `draining` and then waits for every lease to
 * clear knows that no write admitted under `normal` is still in flight. A lease
 * whose process is dead is ignored, so a crash cannot block a migration forever.
 * A state file that exists but cannot be read is treated as maintenance, never
 * as `normal`.
 *
 * THE SPOOL. A write that finds the store in maintenance is not lost and not
 * written to the old copy: it is appended to a per-store spool outside every
 * store, bounded per store, and reported `queued`. Part 3 replays the spool into
 * the new store after cutover, deduplicated by each record's `rid`. Over the
 * bound the write is `rejected` and reported, never silently dropped.
 *
 * LEGACY WRITERS do not take leases and cannot be stopped from here. They are
 * contained by part 3's filesystem fence and offline check, not by this module;
 * nothing here claims otherwise.
 *
 * State lives OUTSIDE the store (`~/.token-optimizer/projects/<id>/`), because
 * the store directory itself is what gets moved and fenced.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { canonicalPath } from './paths.mjs';
import { newRid, queued, rejected } from './store-write.mjs';

export const NORMAL = 'normal';
export const DRAINING = 'draining';
export const READY = 'ready';
export const CUTOVER = 'cutover';
export const FAILED = 'failed';
export const STATES = Object.freeze([NORMAL, DRAINING, READY, CUTOVER, FAILED]);

/** Spooled bytes allowed per store, across every process. */
export const SPOOL_MAX_BYTES = 4 * 1024 * 1024;

const home = (env = process.env) => env.TOKEN_OPTIMIZER_HOME || join(homedir(), '.token-optimizer');

/**
 * The store a writer's directory belongs to: the nearest `.token-optimizer`
 * ancestor, or the directory itself when a store was pointed elsewhere.
 */
export function storeRoot(dir) {
  let at = canonicalPath(dir);
  for (let i = 0; i < 6 && at; i++) {
    // A MOVED store (`<home>/projects/<id>/store`) is its own root: walking on
    // would reach the home `.token-optimizer` and give every moved store one id.
    if (basename(at) === 'store' && basename(dirname(dirname(at))) === 'projects') return at;
    if (basename(at) === '.token-optimizer') return at;
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  return canonicalPath(dir);
}

/**
 * A store's identity: sha256 of its canonical path, case-folded where the
 * filesystem is case-insensitive, so `C:\Repo` and `c:\repo` are one store.
 */
export function storeId(dir, platform = process.platform) {
  const root = storeRoot(dir);
  // A moved store keeps the id it was migrated under, so its maintenance
  // record, leases and spool are the same ones before and after the move.
  const moved = /\/projects\/([0-9a-f]{16})\/store$/.exec(root);
  if (moved) return moved[1];
  const key = platform === 'win32' || platform === 'darwin' ? root.toLowerCase() : root;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export const controlDir = (id, env = process.env) => join(home(env), 'projects', id);
const statePath = (id, env) => join(controlDir(id, env), 'maintenance.json');
const leaseDir = (id, env) => join(controlDir(id, env), 'leases');
export const spoolDir = (id, env = process.env) => join(home(env), 'spool', id);

/**
 * The store's maintenance state. No file is `normal`; a file that cannot be
 * read or names no known state is `failed` -- maintenance, never normal.
 */
export function readState(id, env = process.env) {
  let text;
  try {
    text = readFileSync(statePath(id, env), 'utf8');
  } catch (error) {
    // ENOTDIR: a path component is a file, so no record can exist there
    // (POSIX reports it; Windows reports ENOENT for the same layout).
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { state: NORMAL };
    return { state: FAILED, reason: `state unreadable: ${error?.code || error}` };
  }
  try {
    const parsed = JSON.parse(text);
    if (STATES.includes(parsed?.state)) return parsed;
  } catch {
    // Fall through: a torn or foreign file is not permission to write.
  }
  return { state: FAILED, reason: 'state file is not a maintenance record' };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

let leaseCounter = 0;

/**
 * Run `write` under a lease, if the store is in normal operation.
 *
 * Returns `{ admitted: true, value }` when the write ran, or
 * `{ admitted: false, state }` when the store is in maintenance and the caller
 * must spool. If the lease itself cannot be created the write is not admitted:
 * a migrator could not see it, so it must not touch the store.
 *
 * `queue(state)`, when given, runs in place of `write` while the store is in
 * maintenance, STILL UNDER THE LEASE, and its result is `value`. That is what
 * makes a spool append safe against the final replay: the migrator returns the
 * store to normal, waits for the leases held at that moment, and only then
 * detaches the spool -- so no append admitted under maintenance can land after
 * it. A queue run after the lease is dropped could.
 */
export function withWriteLease(dir, write, env = process.env, { queue = null } = {}) {
  const id = storeId(dir);
  const leases = leaseDir(id, env);
  const lease = join(leases, `${process.pid}-${(leaseCounter += 1)}.lease`);
  try {
    mkdirSync(leases, { recursive: true, mode: 0o700 });
    closeSync(openSync(lease, 'wx', 0o600));
  } catch (error) {
    // NO CONTROL DIRECTORY CAN MEAN NO MAINTENANCE. A sandbox that may not write
    // outside the workspace (Codex's, for one) cannot create the lease -- and a
    // migrator cannot have created this store's maintenance record there either,
    // since it needs the same directory. When the record provably does not
    // exist, the write is admitted without a lease. Any other failure, or a
    // record that exists, keeps the store closed: the migrator would not see
    // this write.
    if (!existsSync(controlDir(id, env)) && readState(id, env).state === NORMAL) {
      return { admitted: true, value: write(), id, unleased: true };
    }
    // No lease to hold: the queue runs bare. Its spool lives under the same
    // home the lease could not be created in, so it is normally refused too.
    const state = { state: FAILED, reason: `lease: ${error?.code || error}` };
    return { admitted: false, state, id, value: queue?.(state) };
  }
  try {
    const state = readState(id, env);
    if (state.state !== NORMAL) return { admitted: false, state, id, value: queue?.(state) };
    return { admitted: true, value: write(), id };
  } finally {
    try {
      unlinkSync(lease);
    } catch {
      // Already gone; a stale lease from a dead pid is ignored anyway.
    }
  }
}

/** Leases held by live processes other than `exceptPid`. */
export function liveLeases(id, env = process.env, exceptPid = null) {
  let names = [];
  try {
    names = readdirSync(leaseDir(id, env));
  } catch {
    return [];
  }
  return names.filter((name) => {
    const pid = Number.parseInt(name, 10);
    return pid !== exceptPid && pidAlive(pid);
  });
}

function spoolBytes(id, env) {
  let total = 0;
  try {
    for (const name of readdirSync(spoolDir(id, env))) {
      try {
        total += statSync(join(spoolDir(id, env), name)).size;
      } catch {
        // Raced with a replay that removed it.
      }
    }
  } catch {
    // No spool yet.
  }
  return total;
}

/** The tombstone left at `<root>/.token-optimizer` by a migration, or null. */
export function readTombstone(root) {
  const path = join(root, '.token-optimizer');
  try {
    if (!statSync(path).isFile()) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Where a project's store lives: `<root>/.token-optimizer`, or wherever its
 * tombstone says it moved. Every path into a project store is built from this,
 * so after a migration upgraded writers follow the move instead of failing
 * against the fence. One stat in the common case (no tombstone).
 */
export function projectStore(root, env = process.env) {
  const inRepo = join(root, '.token-optimizer');
  const tomb = readTombstone(root);
  if (tomb && typeof tomb.movedTo === 'string') return tomb.movedTo;
  // MID-MIGRATION the store's path is a fence FILE. Readers are pointed at the
  // staged copy, which holds exactly the store's data until the move publishes;
  // writers never reach it, because every write takes a lease and the store is
  // in maintenance, so they spool. Without this, a session starting while its
  // store was being moved read nothing at all.
  if (tomb && tomb.state === 'migrating' && typeof tomb.generation === 'string') {
    const staged = `${inRepo}.migrating-${tomb.generation}`;
    try {
      if (statSync(staged).isDirectory()) return staged;
    } catch {
      // Published or rolled back meanwhile: the in-repo path, as below.
    }
  }
  // THE OPTIMIZER'S OWN DIRECTORIES keep their layout: the unrooted bucket is
  // `<home>/unrooted/.token-optimizer`, and redirecting it would move it to a
  // second place every reader of the unrooted graph would miss.
  const base = canonicalPath(home(env));
  const at = canonicalPath(root);
  if (at === base || at.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return inRepo;
  // AN EXISTING IN-REPO STORE is used until it is migrated (session start does
  // that once no older writer runs), so nothing it holds goes missing meanwhile.
  try {
    if (statSync(inRepo).isDirectory()) return inRepo;
  } catch {
    // None: a new store.
  }
  // A NEW STORE IS NEVER CREATED INSIDE THE PROJECT (#538). Writing there
  // changed the fingerprint of whatever the directory was -- an installed
  // Codex plugin's bundle, which then demanded hook re-approval after every
  // read -- and put machine-local agent output in the user's tree.
  return newStoreDir(root, env);
}

/** The per-user store for `root`, with the record that names its project. */
function newStoreDir(root, env) {
  const id = storeId(join(root, '.token-optimizer'));
  const dir = movedStoreDir(id, env);
  const meta = join(controlDir(id, env), 'meta.json');
  try {
    if (!existsSync(meta)) {
      // Writable first: where the record cannot be kept (a sandbox that may
      // not write the home directory), every hook call would otherwise spawn
      // git again, since the missing record is what triggers this.
      mkdirSync(join(home(env), 'projects'), { recursive: true, mode: 0o700 });
      const rootCommit = repositoryRootCommit(root);
      // A REPOSITORY MOVED TO A NEW PATH keeps its graph. An in-repo store
      // travelled with its directory; one keyed by path would not, so a store
      // whose recorded root no longer exists, for the same repository (its
      // first commit), is adopted here instead of starting empty. Only an
      // orphan is adopted: a clone that still exists at its old path keeps its
      // own store.
      if (rootCommit && adoptOrphanedStore(id, root, rootCommit, env)) return dir;
      mkdirSync(controlDir(id, env), { recursive: true, mode: 0o700 });
      // EXCLUSIVE: two hooks starting on a new project at once must not have
      // the second overwrite the first's record (and an adoption it recorded).
      writeFileSync(
        meta,
        JSON.stringify({ root: canonicalPath(root), storeId: id, rootCommit, createdAt: new Date().toISOString() }),
        { flag: 'wx' }
      );
    }
  } catch {
    // The record names the project for dashboards; a store works without it.
  }
  return dir;
}

/** The repository's first commit, or null when it is not a git repository. */
function repositoryRootCommit(root) {
  try {
    // THE REPOSITORY'S OWN TOP LEVEL ONLY (review). From a subdirectory -- or
    // a project inside a dotfiles repository around the home directory -- git
    // answers for the ENCLOSING repository, so unrelated roots shared its
    // first commit and one project could adopt another's graph.
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    const fold = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
    if (!top || fold(canonicalPath(top)) !== fold(canonicalPath(root))) return null;
    const out = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    // A repository with several roots (merged histories) is identified by the
    // smallest, so every clone agrees on it.
    const roots = out.split(/\s+/).filter((h) => /^[0-9a-f]{40,64}$/.test(h)).sort();
    return roots[0] ?? null;
  } catch {
    return null;
  }
}

/** Move an orphaned store of the same repository to `id`. True when adopted. */
function adoptOrphanedStore(id, root, rootCommit, env) {
  const projects = join(home(env), 'projects');
  let names = [];
  try {
    names = readdirSync(projects);
  } catch {
    return false;
  }
  for (const name of names) {
    if (name === id) continue;
    const metaPath = join(projects, name, 'meta.json');
    let meta;
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    } catch {
      continue;
    }
    // GONE, NOT UNREACHABLE. A repository on an unplugged drive or an
    // unmounted share also "does not exist"; adopting its store would take it
    // from that repository the next time the drive is back. Only a root whose
    // parent directory is present and which itself is not, was moved or deleted.
    if (meta.rootCommit !== rootCommit || !meta.root || existsSync(meta.root) || !existsSync(dirname(meta.root)))
      continue;
    // A store in maintenance is never moved from under its migrator.
    if (readState(name, env).state !== NORMAL) continue;
    try {
      renameSync(join(projects, name), controlDir(id, env));
      writeFileSync(
        join(controlDir(id, env), 'meta.json'),
        JSON.stringify({ ...meta, root: canonicalPath(root), storeId: id, adoptedFrom: { storeId: name, root: meta.root } })
      );
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Where a project's store lives outside its repository. */
export const movedStoreDir = (id, env = process.env) => join(controlDir(id, env), 'store');

/** The project root a per-user store belongs to, from its record, or null. */
export function storeProjectRoot(storeDir) {
  // The per-user layout exactly: `<home>/projects/<16 hex>/store[/...]`. A
  // looser pattern took the LAST `store` segment, which a store's own
  // subdirectories can contain.
  const m = /^(.*[\\/]projects[\\/][0-9a-f]{16})[\\/]store(?:[\\/]|$)/.exec(String(storeDir || ''));
  if (!m) return null;
  try {
    return JSON.parse(readFileSync(join(m[1], 'meta.json'), 'utf8')).root ?? null;
  } catch {
    return null;
  }
}

/** A path inside the store, relative to its root (`wiki/graph.jsonl`), for the spool. */
export function storeRelative(dir, file) {
  const root = storeRoot(dir);
  const path = canonicalPath(file);
  return path.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? path.slice(root.length + 1) : path;
}

/**
 * Spool records for a store in maintenance. `file` is the store-relative file
 * they belong to (`wiki/graph.jsonl`), so a replay can route them.
 */
export function spool(dir, file, records, state, env = process.env) {
  const id = storeId(dir);
  const lines = records
    .map((record) =>
      JSON.stringify({ file, record: record?.rid ? record : { ...record, rid: newRid() } })
    )
    .join('\n');
  const payload = `${lines}\n`;
  if (spoolBytes(id, env) + Buffer.byteLength(payload) > SPOOL_MAX_BYTES) {
    return rejected({
      store: dir,
      op: 'spool',
      file,
      reason: `store is ${state.state} and its spool is over ${SPOOL_MAX_BYTES} bytes`,
    });
  }
  try {
    mkdirSync(spoolDir(id, env), { recursive: true, mode: 0o700 });
    appendFileSync(join(spoolDir(id, env), `${process.pid}.jsonl`), payload, { mode: 0o600 });
    return queued(`store ${state.state}`);
  } catch (error) {
    return rejected({ store: dir, op: 'spool', file, error });
  }
}
