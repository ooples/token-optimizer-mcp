#!/usr/bin/env node
/**
 * Claude Code PreCompact adapter -- optimize at the moment it matters most.
 *
 * Compaction is when the context window has already filled and the harness is
 * about to discard detail to make room. Anything the optimizer can move out of
 * context BEFORE that point is detail that survives as a retrievable artifact
 * instead of being summarized away.
 *
 * A PROTOCOL CONSTRAINT WORTH STATING PLAINLY: a hook cannot call an MCP tool.
 * Hooks are commands; MCP tools are model-invoked. So this cannot simply "run
 * optimize_session". It does the next best thing that is actually within its
 * power -- invoke the same underlying tool through the package's one-shot CLI
 * wrapper, which exists precisely for out-of-band invocation.
 *
 * When the wrapper is not resolvable (plugin-only installs do not ship it, only
 * global npm installs do) the hook exits silently rather than pretending. It
 * never blocks or delays compaction: the spawn is bounded and fail-open.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mode, MODE_OFF, loadState, clearSeen } from './lib/policy.mjs';
import { linkCoOccurrence } from './lib/inject.mjs';
import { wikiDir, projectRootFor } from './lib/wiki.mjs';

/** Longest compaction may be delayed. Past this the work is abandoned. */
const TIMEOUT_MS =
  Number(process.env.TOKEN_OPTIMIZER_PRECOMPACT_TIMEOUT_MS) || 8000;

function findWrapper() {
  // Plugin installs place the plugin under .../plugin; the wrapper, when
  // present, sits at the package root above it. Global installs resolve it
  // through the package directory directly.
  const roots = [
    process.env.CLAUDE_PLUGIN_ROOT
      ? join(process.env.CLAUDE_PLUGIN_ROOT, '..')
      : null,
    process.env.TOKEN_OPTIMIZER_HOME || null,
  ].filter(Boolean);

  for (const root of roots) {
    const candidate = join(root, 'cli-wrapper.mjs');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function main() {
  if (mode() === MODE_OFF) return;

  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(chunk);

  let payload;
  try {
    payload = JSON.parse(chunks.join(''));
  } catch {
    return;
  }

  // STATE AND CO-OCCURRENCE BEFORE THE WRAPPER CHECK, deliberately.
  //
  // The wrapper is only needed to spawn optimize_session, and plugin-only
  // installs do not ship one -- the hook returns early for them by design. But
  // recording which files were worked on together needs nothing but the graph,
  // so gating it on the wrapper would mean every plugin-only user silently got
  // no `related` edges and therefore no restoration, forever. That is the same
  // shape as the defect this whole change is fixing: a feature present, correct,
  // and unreachable for a reason nobody would think to look for.
  const state = loadState(payload.session_id);
  const seen = Object.keys(state.seen || {});
  const seenCount = seen.length;
  if (seenCount === 0) return;

  // CO-OCCURRENCE, RECORDED AT THE ONE MOMENT IT IS COMPLETE.
  //
  // `linkCoOccurrence` is the only producer of `related` edges, and it was
  // called by nothing -- so the edge kind was declared, the consumer was
  // written, and the graph never contained a single one. This is the natural
  // site: `state.seen` is exactly "the files this session worked on together",
  // which is the signal, and it is whole only once the session is long enough
  // to be compacted.
  //
  // GROUPED BY PROJECT, because the graph is per project. A session that
  // touches two checkouts must write each repository's edges into its own
  // graph, or it invents relationships between files that have never met.
  try {
    const byProject = new Map();
    for (const path of seen) {
      const root = projectRootFor(path, payload.cwd);
      if (!root) continue;
      if (!byProject.has(root)) byProject.set(root, []);
      byProject.get(root).push(path);
    }
    for (const [root, paths] of byProject) {
      // Two files are the minimum that can co-occur; one writes no edge and
      // only costs a graph load.
      if (paths.length < 2) continue;
      linkCoOccurrence(wikiDir(root), payload.session_id, paths);
    }
  } catch {
    // Bookkeeping must never delay or fail a compaction.
  }

  // COMPACTION ENDS THE CLAIM THAT THE CALLER STILL HOLDS THESE FILES.
  //
  // `state.seen` is what licenses the router to refuse a Read with "UNCHANGED
  // since you last read it this session -- use what you already have". That is a
  // statement about the READER's context, and compaction is precisely the event
  // that empties it: the summary survives, the file contents do not.
  //
  // Left uncleared, the hook went on withholding content the model demonstrably no
  // longer had, for the rest of a long session. Cleared here, "seen" means "read
  // since the last compaction", which is the closest honest approximation of
  // "still in context" available to a hook.
  //
  // Deliberately AFTER the co-occurrence write above, which needs the full list.
  //
  // `clearSeen` rather than `saveState({ seen: {} })`: saveState MERGES seen so that
  // concurrent hook processes cannot erase each other's additions, which means it
  // cannot shrink the map at all. The first version of this used saveState and was a
  // silent no-op until a test caught it.
  clearSeen(payload.session_id, payload.transcript_path || null);

  // NOW the wrapper, which only the optimize_session spawn needs. Plugin-only
  // installs stop here having still recorded their co-occurrence above.
  const wrapper = findWrapper();
  if (!wrapper) return;

  await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        wrapper,
        'optimize_session',
        JSON.stringify({ sessionId: payload.session_id }),
      ],
      { stdio: 'ignore', windowsHide: true }
    );
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, TIMEOUT_MS);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  process.stdout.write(
    JSON.stringify({
      systemMessage: `token-optimizer: compressed ${seenCount} tracked file operation(s) before compaction.`,
    })
  );
}

// Compaction must proceed whatever happens here.
main()
  .catch(() => {})
  .finally(() => process.exit(0));
