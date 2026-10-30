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
  unlinkSync,
} from 'node:fs';
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
    if (error?.code === 'ENOENT') return { state: NORMAL };
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
 */
export function withWriteLease(dir, write, env = process.env) {
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
    return { admitted: false, state: { state: FAILED, reason: `lease: ${error?.code || error}` }, id };
  }
  try {
    const state = readState(id, env);
    if (state.state !== NORMAL) return { admitted: false, state, id };
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
