// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/projects.mjs. Regenerate with `npm run sync:hooks`.
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
 * Folds the append-only registry into one current entry per canonical project.
 * Malformed, stale-schema, and unsafe records are ignored rather than trusted.
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
    const recent = registeredProjects().find(
      (project) =>
        project.id === id &&
        project.graphDir === canonicalGraphDir &&
        project.clients.includes(client) &&
        now - project.lastSeenAt < 60 * 60 * 1000
    );
    if (recent) return recent;

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
    return {
      id,
      name: String(name || displayName(canonicalRoot)).slice(0, 160),
      root: canonicalRoot,
      graphDir: canonicalGraphDir,
      firstSeenAt: now,
      lastSeenAt: now,
      clients: [String(client || 'unknown').slice(0, 80)],
    };
  } catch {
    return null;
  }
}
