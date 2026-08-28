/**
 * File discovery that is bounded DURING the walk, not after it.
 *
 * WHY THIS EXISTS. Every traversal in this server used `globSync` or a recursive
 * `readdirSync`, enumerated the entire tree, and only then applied `limit`. On a
 * real machine that is not a slow path, it is an unbounded one: measured on
 * 2026-08-28, a default-ignore glob of a Windows user profile directory ran **178 seconds
 * without completing** and had to be killed, while the same walk capped at 50
 * matches returned in **27 ms**. The tools are advertised as bounded
 * replacements for the built-in `Glob`/`grep`, and the routing policy DENIES the
 * built-ins -- so a tool that hangs where `dir` is instant does not merely
 * perform badly, it strands the caller with no way to do the thing at all.
 *
 * TWO BOUNDS, BECAUSE ONE IS NOT ENOUGH. They fail in different places and
 * neither covers the other:
 *
 *   - The **cap** short-circuits: stop walking once enough matches are in hand.
 *     It is what makes a narrow search on a huge tree instant. It does nothing
 *     when matches are rare, because it is only ever checked on a match.
 *   - The **deadline** is a hard wall-clock stop delivered by `AbortSignal`.
 *     It is what covers `**' + '/*.csproj` over `node_modules`, where the walk
 *     can spend minutes yielding NOTHING and a between-matches check would never
 *     run. Verified: an abort fired at 2 s on a pattern that matched nothing.
 *
 * SYNCHRONOUS TRAVERSAL WAS ITS OWN BUG. `globSync` blocks the event loop, so
 * the server could not answer a cancel, a ping, or anything else while walking.
 * That is why the reported hangs had to be killed rather than timing out. These
 * helpers are async so the loop stays live and the abort can actually be
 * delivered.
 *
 * NOTHING HERE INVENTS A NUMBER. When a bound is hit the result says so and
 * names which one. A caller that gets `truncated: true` knows the set is
 * partial; a caller that gets `false` knows the walk completed.
 */

import { globIterate } from 'glob';
import { readdir } from 'fs/promises';
import { join } from 'path';

/**
 * The default wall-clock budget for one traversal.
 *
 * Chosen against the measurements above rather than by feel: the whole point is
 * to return before the caller's own tool timeout, which is 120 s. Ten seconds
 * completes every in-repository walk measured here (the largest, a 116k-file
 * tree, took 8.6 s) while cutting the pathological home-directory walk short by
 * more than seventeen times over.
 */
export const DEFAULT_TRAVERSAL_DEADLINE_MS = 10_000;

/** Why a traversal stopped early. Absent when it ran to completion. */
export type TruncationReason = 'cap' | 'deadline';

export interface BoundedResult<T> {
  items: T[];
  /** True when a bound stopped the walk, so `items` is a partial set. */
  truncated: boolean;
  /** Which bound stopped it. Absent when `truncated` is false. */
  truncatedBy?: TruncationReason;
  elapsedMs: number;
}

/**
 * The traversal budget, overridable per deployment.
 *
 * A machine with a slow network drive may legitimately need longer, and a
 * caller under a tighter timeout may need less. Invalid values fall back rather
 * than throwing: a malformed environment variable must not break file search.
 */
export function traversalDeadlineMs(override?: number): number {
  if (
    typeof override === 'number' &&
    Number.isFinite(override) &&
    override > 0
  ) {
    return override;
  }
  const fromEnv = Number(process.env.TOKEN_OPTIMIZER_TRAVERSAL_DEADLINE_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_TRAVERSAL_DEADLINE_MS;
}

export interface BoundedGlobOptions {
  cwd: string;
  absolute?: boolean;
  ignore?: string[];
  nodir?: boolean;
  dot?: boolean;
  /**
   * Stop after this many ACCEPTED paths.
   *
   * Counted after `accept`, not before, so a caller filtering by extension gets
   * `cap` files it wanted rather than `cap` candidates it mostly discards.
   */
  cap?: number;
  deadlineMs?: number;
  /** Applied during the walk so filtering cannot be defeated by the cap. */
  accept?: (path: string) => boolean;
}

/**
 * `glob`, bounded.
 *
 * An abort is a RESULT, not an error: the caller asked for what could be found
 * in the time allowed, and partial-with-a-flag is the answer. Any other failure
 * still throws, because a permissions error or a bad pattern is not a bound
 * being hit and must not be disguised as one.
 */
export async function boundedGlob(
  pattern: string,
  options: BoundedGlobOptions
): Promise<BoundedResult<string>> {
  const started = Date.now();
  const cap = options.cap ?? Infinity;
  const deadline = traversalDeadlineMs(options.deadlineMs);
  const accept = options.accept;

  const items: string[] = [];
  let truncatedBy: TruncationReason | undefined;

  const controller = new AbortController();
  // `unref` so a pending deadline can never hold the process open on its own;
  // the `clearTimeout` below is what normally retires it.
  const timer = setTimeout(() => controller.abort(), deadline);
  timer.unref?.();

  try {
    for await (const entry of globIterate(pattern, {
      cwd: options.cwd,
      absolute: options.absolute,
      ignore: options.ignore,
      nodir: options.nodir,
      dot: options.dot,
      signal: controller.signal,
    })) {
      const path = String(entry);
      if (accept && !accept(path)) continue;
      items.push(path);
      if (items.length >= cap) {
        truncatedBy = 'cap';
        break;
      }
    }
  } catch (error) {
    if (!isAbort(error)) throw error;
    truncatedBy = 'deadline';
  } finally {
    clearTimeout(timer);
  }

  return {
    items,
    truncated: truncatedBy !== undefined,
    truncatedBy,
    elapsedMs: Date.now() - started,
  };
}

/** Mutable truncation state for a streaming walk, since a generator cannot return one. */
export interface StreamState {
  truncated: boolean;
  truncatedBy?: TruncationReason;
}

/**
 * The same walk, yielded one path at a time.
 *
 * WHY A STREAM AND NOT JUST A CAP. `boundedGlob` collects before returning, so a
 * consumer that stops early still paid for the whole discovery. `smart_grep`
 * does exactly that -- it must decide whether to stop from the MATCHES it finds
 * while reading, which it cannot know until it has read. Measured on a 12,000
 * file tree: a `limit: 5` grep took 5,985 ms against 10,266 ms exhaustive,
 * because discovery ran to completion before the first file was opened. Reading
 * as paths arrive makes the cap actually short-circuit.
 *
 * Truncation is reported through `state` because a generator's return value is
 * not observable from `for await`.
 */
export async function* boundedGlobStream(
  pattern: string,
  options: BoundedGlobOptions,
  state: StreamState
): AsyncGenerator<string> {
  const deadline = traversalDeadlineMs(options.deadlineMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadline);
  timer.unref?.();

  try {
    for await (const entry of globIterate(pattern, {
      cwd: options.cwd,
      absolute: options.absolute,
      ignore: options.ignore,
      nodir: options.nodir,
      dot: options.dot,
      signal: controller.signal,
    })) {
      const path = String(entry);
      if (options.accept && !options.accept(path)) continue;
      yield path;
    }
  } catch (error) {
    if (!isAbort(error)) throw error;
    state.truncated = true;
    state.truncatedBy = 'deadline';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An abort, however the runtime chose to spell it.
 *
 * Node reports this as an `AbortError` with code `ABORT_ERR`, but `glob` passes
 * the signal down to `path-scurry` and the surfaced shape has changed across
 * versions. Matching on several spellings is deliberate: mistaking an abort for
 * a real failure would turn a bounded partial result into a thrown error, which
 * is the failure mode this whole module exists to remove.
 */
function isAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'AbortError' ||
    candidate.code === 'ABORT_ERR' ||
    candidate.name === 'DOMException'
  );
}

export interface BoundedWalkOptions {
  /** Directory names never descended into. Pruned, not filtered afterwards. */
  prune?: (directoryName: string, fullPath: string) => boolean;
  /** Files kept. Called once per file; the cap counts only what it accepts. */
  accept?: (fullPath: string, fileName: string) => boolean;
  cap?: number;
  deadlineMs?: number;
}

/**
 * A recursive directory walk with the same two bounds.
 *
 * For the tools that hand-roll `readdirSync` recursion rather than using `glob`.
 * PRUNING IS THE POINT: skipping a directory after enumerating it still paid for
 * enumerating it, and `node_modules` is where that bill comes due.
 *
 * Breadth-first via an explicit queue rather than recursion, so a deep or
 * symlink-looped tree cannot exhaust the stack -- and `withFileTypes` keeps
 * symlinked directories from being descended, which is what turns a junction
 * into an infinite walk on Windows.
 */
export async function boundedWalk(
  root: string,
  options: BoundedWalkOptions = {}
): Promise<BoundedResult<string>> {
  const started = Date.now();
  const cap = options.cap ?? Infinity;
  const deadline = traversalDeadlineMs(options.deadlineMs);
  const expiresAt = started + deadline;

  const items: string[] = [];
  let truncatedBy: TruncationReason | undefined;
  const queue: string[] = [root];

  while (queue.length > 0) {
    if (Date.now() >= expiresAt) {
      truncatedBy = 'deadline';
      break;
    }

    const dir = queue.shift() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // An unreadable directory is not a reason to abandon the search.
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (options.prune?.(entry.name, fullPath)) continue;
        queue.push(fullPath);
        continue;
      }
      // Anything that is not a real file or directory -- a symlink, a junction,
      // a device -- is not followed. On Windows a junction reports as a
      // directory to `stat` but not to `withFileTypes`, and following one is how
      // a shared `node_modules` turns a walk into a loop.
      if (!entry.isFile()) continue;
      if (options.accept && !options.accept(fullPath, entry.name)) continue;
      items.push(fullPath);
      if (items.length >= cap) {
        truncatedBy = 'cap';
        break;
      }
    }

    if (truncatedBy) break;
  }

  return {
    items,
    truncated: truncatedBy !== undefined,
    truncatedBy,
    elapsedMs: Date.now() - started,
  };
}
