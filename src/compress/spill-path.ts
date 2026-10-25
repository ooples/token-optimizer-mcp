/**
 * Where the proxy puts a block it moved out of a request, and what the marker
 * left in its place calls it.
 *
 * THE PATH IS PART OF THE MARKER, AND THE MARKER IS RE-READ ON EVERY LATER
 * TURN. Under the OS temp directory it was
 * `<tmpdir>/token-optimizer-spill/<24 hex>/<16 hex>-block`: 39 tokens of
 * marker on Linux and 51 on Windows (cl100k), against 17 for Alternative A's
 * `<<ccr:hash,kind,size>>`. Every one of those tokens is paid again on every
 * turn the marker stays in context, so a long path is a recurring cost, not a
 * one-off. Here it is `<home>/.tok/<pid>/<15 digits>`, 21-25 tokens.
 *
 * WHY EACH PART IS THE SHAPE IT IS:
 * - `<home>/.tok`, because the reader follows the path with its own `Read`,
 *   which needs an absolute path, and the home directory is the shortest
 *   absolute directory that is private to the user. That is what the
 *   unguessable temp segment bought before: a session fragment in a shared
 *   directory had to be hard to find. The root is created 0700 and each file
 *   0600.
 * - `<pid>`, one directory per proxy, because shutdown deletes it, and a
 *   shared directory would let the first proxy to stop wipe the spills of
 *   every proxy still running. A spill path is a live reference the agent may
 *   still follow. Keying it on the pid also lets a later proxy ASK THE OS
 *   whether the owner is still alive, so a crashed proxy's directory gets
 *   pruned rather than left behind forever.
 * - fifteen DECIMAL digits of an HMAC of the content under a per-process
 *   salt. Content-addressed, because cross-block dedup matches on exact
 *   equality and two paths for the same bytes defeat it. Salted, so the name
 *   is not predictable from the content. Decimal, because a tokenizer splits
 *   hex into about one token per two characters and digits into one per
 *   three: 15 digits (~50 bits) cost 5 tokens where 16 hex digits cost 8.
 */

import { createHmac } from 'node:crypto';
import { join, resolve } from 'node:path';

/** The directory every proxy's spill directory lives under. */
export function spillBase(
  home: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const override = env.TOKEN_OPTIMIZER_SPILL_ROOT?.trim();
  // ABSOLUTE, ALWAYS. The path is handed to the agent's own `Read`, which needs
  // an absolute one, and a relative override would also move with whatever
  // directory the proxy happened to start in.
  return override ? resolve(override) : join(home, '.tok');
}

/**
 * One proxy's spill directory. `instance` counts the proxies this process has
 * started: the first is `<pid>`, and only a process that runs several (a test
 * worker does) pays for a suffix. Without it two proxies in one process would
 * share a directory, and the first to stop would delete the other's live spills.
 */
export function spillRootFor(
  base: string,
  pid: number,
  instance: number = 0
): string {
  return join(base, instance === 0 ? String(pid) : `${pid}-${instance}`);
}

/** The content-addressed file name for one spilled block. */
export function spillName(salt: Buffer, content: string): string {
  const digest = createHmac('sha256', salt).update(content).digest();
  return (digest.readBigUInt64BE(0) % 1_000_000_000_000_000n)
    .toString()
    .padStart(15, '0');
}

/**
 * The directories under `base` whose owning proxy is gone.
 *
 * `alive` is asked rather than a retention age guessed, because only the OS
 * knows whether a proxy still holds references into its directory. A name
 * that is not a pid was not written by a proxy and is left alone.
 *
 * A PID-SHAPED NAME IS NOT PROOF OF OWNERSHIP. TOKEN_OPTIMIZER_SPILL_ROOT can
 * point anywhere, including a shared directory holding numbered directories
 * that are not ours, so a directory is only ever a candidate if `owned` says
 * a proxy marked it (SPILL_OWNER_MARKER, written when the proxy first spills).
 */
export function deadSpillRoots(
  names: readonly string[],
  self: number,
  alive: (pid: number) => boolean,
  owned: (name: string) => boolean
): string[] {
  return names.filter((name) => {
    const owner = /^([1-9]\d*)(?:-[1-9]\d*)?$/.exec(name);
    if (owner === null) return false;
    const pid = Number(owner[1]);
    return pid !== self && !alive(pid) && owned(name);
  });
}

/** The file a proxy writes into its spill directory to mark it as its own. */
export const SPILL_OWNER_MARKER = '.token-optimizer-spill';

/**
 * A spill path of the real shape on a typical machine, for everything that
 * has to price a marker without writing one: the engine's trial run, which
 * decides whether moving a block pays, and the benchmarks, whose recorded
 * token counts are keyed on the exact text and so cannot depend on whose home
 * directory ran them. A 7-digit pid is the longest Linux hands out by default
 * (pid_max 4194304), so this errs toward charging the marker more, not less.
 * A Windows home (`C:\Users\<name>`) is about three tokens longer still.
 */
export function canonicalSpillPath(name: string): string {
  return `/home/user/.tok/4194303/${name}`;
}

/** Whether a process with this pid exists, by asking the OS. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
