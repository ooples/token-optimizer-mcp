// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/seed.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Indexing the project before the first turn.
 *
 * WHY THE GRAPH WAS USELESS WHEN IT MATTERED. Capture runs on PreToolUse: a
 * file enters the graph when the model touches it. That makes the graph a
 * record of what the model has ALREADY SEEN, and a record of what it has
 * already seen can never tell it something it does not know. The one moment an
 * index is worth a turn -- the model is about to search for a symbol it has not
 * met -- is precisely the moment the graph is empty about that symbol.
 *
 * The benchmark makes this total rather than merely weak: the rig hands every
 * run a throwaway HOME (runner.py:129), so nothing survives a task and every
 * session starts from nothing. But the same hole exists for a real user on
 * their first session in a repository, and that is the case this fixes. It is
 * not a benchmark accommodation.
 *
 * WHY THIS IS HONEST AND NOT HARNESS-GAMING. Nothing is persisted between runs
 * and no competitor's throwaway HOME is treated differently from ours. The work
 * is local filesystem traversal inside a hook: it reads the project the user
 * already gave us and costs zero tokens. What changes is only WHEN the index
 * is built -- before the model needs it rather than after.
 *
 * WHY IT CANNOT INFLATE THE PROMPT. Seeding writes file and symbol nodes plus
 * `contains`, `imports` and `calls` edges. It writes no FINDINGS, and every
 * SessionStart block is finding-driven: `sessionIndex` returns null unless
 * `n.kind === 'finding'` matches a task signal, and `standingRules` renders
 * pinned and human-verified findings only. So a seeded graph adds nothing to
 * the prefix. It is read later, on demand, by `adviseSearch`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { indexFile } from './staleness.mjs';
import { withBatchedWrites, isSharedDir } from './wiki.mjs';
import { isFsSafePath } from './paths.mjs';
import { languageOf } from './symbols.mjs';

/**
 * The kill switch, separate from the wiki's own.
 *
 * Seeding is the one part of capture that does work the user did not ask for at
 * a moment they are waiting -- so it gets an off switch that does not require
 * disabling the graph entirely, and the A/B arm that measures whether it was
 * worth anything needs exactly this.
 */
export function seedDisabled(env = process.env) {
  const raw = String(env.TOKEN_OPTIMIZER_SEED || '').trim().toLowerCase();
  return raw === '0' || raw === 'off' || raw === 'false' || raw === 'no';
}

/**
 * Directories never worth walking.
 *
 * Dependencies and build output dwarf a project's own source and answer no
 * question the model will ask about the code it was sent here to change. Left
 * in, `node_modules` alone would exhaust every budget below before reaching the
 * first source file -- the index would be large, slow and about somebody else's
 * code.
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  'coverage', 'vendor', '.next', '.nuxt', '.cache', '.venv', 'venv',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'bin', 'obj',
  '.gradle', '.idea', '.vscode', 'tmp', 'temp',
]);

/** Files past this size are skipped: a generated bundle is not structure. */
const MAX_FILE_BYTES = 256 * 1024;

/** How much of a project to index. */
export const DEFAULT_MAX_FILES = 300;

/**
 * How long SessionStart may spend on this.
 *
 * A HARD DEADLINE, NOT A TARGET. This runs before the user's first turn is
 * answered, so overrunning it is visible latency on every session in every
 * repository -- including the monorepo whose tree is large enough that the file
 * cap alone would not stop us in time. Partial is fine: an index of the first
 * 300 files is worth most of what a complete one is, and a session that starts
 * late to deliver it is worth nothing.
 */
export const DEFAULT_BUDGET_MS = 1_200;

/**
 * Walk `root`, indexing source files into the graph at `dir`.
 *
 * Breadth-first, so a wide shallow project is covered before a deep one is
 * descended. Depth-first would spend the whole budget inside the first
 * subdirectory it entered, which on most repositories means indexing one
 * package thoroughly and the other twenty not at all.
 */
export function seedProject(dir, root, {
  maxFiles = DEFAULT_MAX_FILES,
  budgetMs = DEFAULT_BUDGET_MS,
  now = Date.now,
} = {}) {
  const deadline = now() + budgetMs;
  let files = 0;
  let symbols = 0;

  if (typeof root !== 'string' || !root || !isFsSafePath(root)) {
    return { files: 0, symbols: 0, stopped: 'unusable-root' };
  }

  // THE SHARED LESSON TIER IS NOT AN INDEX. `sharedDir` holds only lessons that
  // hold in ANY repository -- deliberately per machine, per user, following the
  // person rather than the code. File and symbol nodes are the opposite kind of
  // fact, and seeding a project's structure into it would put one checkout's
  // paths into every other checkout's briefing.
  //
  // AN UNROOTED PROJECT IS SEEDED, and that is a considered reversal. A
  // directory with no VCS marker resolves to one machine-level store shared by
  // every unrooted session on the host, which looks like the same pollution --
  // and blocking it here was the first attempt. But blocking is the wrong
  // instrument twice over: it would disable the feature entirely for anyone
  // working outside a repository, and it does not actually fix the hazard,
  // since ordinary capture writes to that same store already and a rooted graph
  // can hold foreign files through resolved imports.
  //
  // The hazard is serving a symbol from an unrelated tree, so it is fixed where
  // it happens: `adviseSearch` takes a scope and reports nothing outside it.
  // Growth is bounded separately by `alreadySeeded`, which sees a store that is
  // already populated and declines to add to it.
  if (isSharedDir(dir)) {
    return { files: 0, symbols: 0, stopped: 'shared-tier' };
  }

  const queue = [root];
  let stopped = 'complete';

  // ONE APPEND FOR THE WHOLE SEED. Unbatched, each of the ~900 records a
  // 26-file index produces costs a lock, an append, a compaction check and an
  // unlink -- 1.3 ms apiece, which spent the entire deadline on a tenth of the
  // tree. The batch is the difference between an index and a stub.
  return withBatchedWrites(dir, () => {
  while (queue.length) {
    if (files >= maxFiles) { stopped = 'file-cap'; break; }
    if (now() >= deadline) { stopped = 'deadline'; break; }

    const current = queue.shift();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // An unreadable directory is one directory, never the whole seed.
      continue;
    }

    for (const entry of entries) {
      if (files >= maxFiles || now() >= deadline) break;

      const name = entry.name;
      // A dotfile directory we do not explicitly want is skipped wholesale:
      // they are configuration and caches, and `.git` in particular is large
      // enough to consume the entire budget on objects nobody can read.
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
        queue.push(join(current, name));
        continue;
      }
      if (!entry.isFile()) continue;
      // A symlink reported as a file can point outside the project or back into
      // it; either way `languageOf` and the size check below decide, and the
      // cycle risk lives in the directory branch, which never enqueues one.
      if (!languageOf(name)) continue;

      const path = join(current, name);
      if (!isFsSafePath(path)) continue;

      try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
        // ONE READ, handed to indexFile, which would otherwise open it again.
        const source = readFileSync(path, 'utf8');
        const node = indexFile(dir, path, source, { snapshots: false });
        if (node) {
          files += 1;
          symbols += countSymbols(source);
        }
      } catch {
        // A file that cannot be read or parsed costs one file.
      }
    }
  }

  return { files, symbols, stopped };
  });
}

/**
 * A cheap proxy for how much structure a file contributed.
 *
 * Reporting the real figure would mean extracting symbols a second time, and
 * this number exists only for the diagnostic line -- nothing decides on it.
 */
function countSymbols(source) {
  let count = 0;
  for (const _ of source.matchAll(/^[ \t]*(?:export\s+)?(?:async\s+)?(?:function|class|def|fn|func|type|interface)\b/gm)) {
    count += 1;
  }
  return count;
}

/**
 * Has this graph already been indexed?
 *
 * Seeding a warm graph is wasted work, and on a real user's second session the
 * graph is warm. The test is deliberately the NODE COUNT rather than a marker
 * file: a marker records that we ran, while the count records that there is
 * something there, and those come apart exactly when it matters -- a seed that
 * hit its deadline after four files, or a graph deleted underneath us.
 */
export function alreadySeeded(graph, threshold = 40) {
  let count = 0;
  for (const node of graph.nodes.values()) {
    if (node.kind === 'file' || node.kind === 'symbol') count += 1;
    if (count >= threshold) return true;
  }
  return false;
}
