/**
 * Machine-local index of project graph stores.
 *
 * A graph is deliberately stored with the project whose files it describes.
 * That isolation is important for retrieval, but it also means a dashboard
 * cannot honestly describe machine-wide capture unless it knows which stores
 * exist. This registry is that missing directory. It is written by lifecycle
 * hooks and can be backfilled by the explicit discovery command.
 *
 * The browser never receives `root` or `graphDir`. Routes resolve an opaque
 * project id through this server-owned file, so restoring cross-project views
 * does not restore the old arbitrary-path query vulnerability.
 */

import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { canonicalPath, isFsSafePath } from './paths.mjs';

export const PROJECT_REGISTRY_VERSION = 1;

export function projectRegistryPath() {
  return (
    process.env.TOKEN_OPTIMIZER_PROJECT_REGISTRY ||
    join(homedir(), '.token-optimizer', 'projects.jsonl')
  );
}

export function projectIdFor(root) {
  return `project-${createHash('sha256')
    .update(canonicalPath(root))
    .digest('hex')
    .slice(0, 16)}`;
}

function displayName(root) {
  return basename(root) || 'Unnamed project';
}

function acquire(path) {
  const lockPath = `${path}.lock`;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    return null;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      closeSync(openSync(lockPath, 'wx', 0o600));
      return lockPath;
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 5000) unlinkSync(lockPath);
      } catch {
        // The holder may have released it between open and stat; retry.
      }
    }
  }
  return null;
}

function release(lockPath) {
  if (!lockPath) return;
  try {
    unlinkSync(lockPath);
  } catch {
    // A killed process or cleanup race must not fail the hook.
  }
}

/**
 * What this process has already registered, so a repeat never rescans.
 *
 * `registerProject` runs on EVERY tool call and asked one question of the whole
 * registry: have I already registered this project, for this client, recently?
 * Answering it by folding the registry meant reading every record and running
 * TWO existsSync per record -- and the registry is append-only, so every project
 * ever touched made every future call slower.
 *
 * Measured with 4,033 records: a trivial `get_cached` call took 127ms, with a
 * leaf CPU profile attributing 48.8% to existsSync and 20.0% to the path
 * normaliser feeding it. Truncating the registry to 50 records took the same
 * call to 10ms. The cost was the scan, not the tool.
 *
 * A per-process Set answers the repeat case in memory. Bounded by the number of
 * distinct project+client pairs a single process touches, which is small --
 * unlike the registry, which is unbounded over time.
 */
const registeredThisProcess = new Map();


/**
 * Folds the append-only registry into one current entry per canonical project.
 * Malformed, stale-schema, and unsafe records are ignored rather than trusted.
 *
 * STILL A FULL SCAN, deliberately. Its callers -- the dashboard, the fleet
 * auditor, the discovery script -- want the complete folded view and run rarely.
 * The fix for the hot path is not to make this cheaper but to stop calling it
 * from `registerProject`, which never needed the fold.
 */
export function registeredProjects() {
  const path = projectRegistryPath();
  const projects = new Map();
  if (!existsSync(path)) return [];

  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        record.v !== PROJECT_REGISTRY_VERSION ||
        !isFsSafePath(record.root) ||
        !isFsSafePath(record.graphDir)
      ) {
        continue;
      }
      const root = canonicalPath(record.root);
      const graphDir = canonicalPath(record.graphDir);
      // Append-only history can outlive a deleted worktree (especially a
      // short-lived test or CI checkout). A source that no longer exists
      // cannot be captured, and presenting it as a current coverage gap makes
      // the dashboard steadily less truthful over time.
      if (!existsSync(root)) continue;
      // A broad discovery root may contain hundreds of dormant worktrees. They
      // are not capture coverage until a hook has observed them or a graph
      // exists; listing all of them turns the selector into filesystem noise.
      if (
        record.client === 'discovery' &&
        !existsSync(join(graphDir, 'graph.jsonl'))
      ) {
        continue;
      }
      const id = projectIdFor(root);
      if (record.id !== id) continue;

      const previous = projects.get(id);
      projects.set(id, {
        id,
        name: String(record.name || displayName(root)).slice(0, 160),
        root,
        graphDir,
        firstSeenAt: previous?.firstSeenAt || record.at || 0,
        lastSeenAt: Math.max(previous?.lastSeenAt || 0, Number(record.at) || 0),
        clients: [
          ...new Set([
            ...(previous?.clients || []),
            ...(typeof record.client === 'string' && record.client
              ? [record.client.slice(0, 80)]
              : []),
          ]),
        ].sort(),
      });
    }
  } catch {
    return [];
  }

  return [...projects.values()].sort(
    (a, b) => b.lastSeenAt - a.lastSeenAt || a.name.localeCompare(b.name)
  );
}

/** Registers one VCS project without ever making a hook fail closed. */
export function registerProject({ root, graphDir, client = 'unknown', name } = {}) {
  if (!isFsSafePath(root) || !isFsSafePath(graphDir)) return null;
  try {
    const canonicalRoot = canonicalPath(root);
    const canonicalGraphDir = canonicalPath(graphDir);
    const isRepository = ['.git', '.hg', '.svn'].some((marker) =>
      existsSync(join(canonicalRoot, marker))
    );
    if (!isRepository) return null;
    const id = projectIdFor(canonicalRoot);
    const now = Date.now();

    // ANSWERED IN MEMORY, NOT BY RESCANNING THE REGISTRY.
    //
    // The question here is narrow -- "have I already appended this exact
    // project+graphDir+client?" -- and folding the entire append-only registry
    // to answer it made every tool call O(registry). See the note on
    // `registeredThisProcess` for the measurement.
    //
    // WHAT THIS GIVES UP, STATED PLAINLY. The old check spanned processes via a
    // one-hour window read from the registry; this one spans only this process.
    // So a short-lived process that starts, registers and exits appends one
    // record where it previously might have appended none.
    //
    // That is the right trade because the registry is a LOG OF OBSERVATIONS,
    // not a set of unique projects: `registeredProjects()` already folds
    // duplicates by id, so an extra record costs one line and changes no
    // answer. The alternative -- reading the whole registry to avoid writing to
    // it -- optimised the wrong direction: it spent 127ms of reads to save an
    // occasional append.
    //
    // Growth is bounded per process by the number of distinct project+client
    // pairs it touches, which is small.
    const key = `${id} ${canonicalGraphDir} ${client}`;
    const already = registeredThisProcess.get(key);
    if (already) return already;

    const path = projectRegistryPath();
    const lockPath = acquire(path);
    if (!lockPath) return null;
    try {
      appendFileSync(
        path,
        `${JSON.stringify({
          v: PROJECT_REGISTRY_VERSION,
          id,
          name: String(name || displayName(canonicalRoot)).slice(0, 160),
          root: canonicalRoot,
          graphDir: canonicalGraphDir,
          client: String(client || 'unknown').slice(0, 80),
          at: now,
        })}\n`,
        { mode: 0o600 }
      );
      try {
        chmodSync(path, 0o600);
      } catch {
        // Windows and some filesystems do not expose POSIX modes.
      }
    } finally {
      release(lockPath);
    }
    const entry = {
      id,
      name: String(name || displayName(canonicalRoot)).slice(0, 160),
      root: canonicalRoot,
      graphDir: canonicalGraphDir,
      firstSeenAt: now,
      lastSeenAt: now,
      clients: [String(client || 'unknown').slice(0, 80)],
    };
    // Recorded only AFTER the append succeeded, so a failed write is retried
    // by the next call rather than being remembered as done.
    registeredThisProcess.set(key, entry);
    return entry;
  } catch {
    return null;
  }
}
