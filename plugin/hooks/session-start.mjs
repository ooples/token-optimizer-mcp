#!/usr/bin/env node
/**
 * Claude Code SessionStart adapter -- states the optimization policy up front.
 *
 * WHY A HOOK AND NOT THE SKILL: skills are model-invoked. The token-optimization
 * skill only enters context once the model has already decided the topic is
 * relevant, which on a normal coding session is never -- the model is thinking
 * about the user's bug, not about its own token consumption. So the skill,
 * however well written, could not establish a default.
 *
 * A SessionStart hook is unconditional. Its additionalContext is present before
 * the first tool call of every session, so preferring optimized tooling is the
 * model's starting assumption rather than a correction issued after the
 * expensive call was already attempted.
 *
 * This pairs with the PreToolUse router: the router is the enforcement, this is
 * the notice. Without the notice the model learns the policy only by being
 * refused, which wastes a turn per tool family.
 */

import { mode, MODE_OFF, readPayload, loadState } from './lib/policy.mjs';
import { policyText } from './lib/adapter.mjs';
import { restorationPlan } from './lib/restore.mjs';
import { wikiDir, load, projectRootFor } from './lib/wiki.mjs';

if (mode() === MODE_OFF) process.exit(0);

/**
 * The restoration block, when this session is resuming from a compaction.
 *
 * `restorationPlan` was written, tested, and called by nothing -- the other half
 * of a feature whose only producer of `related` edges was equally unreachable,
 * so the graph never held one and the plan had nothing to predict from.
 * PreCompact now writes those edges; this is where they are spent.
 *
 * SessionStart is the right site because the plan is explicitly about resuming:
 * a PreCompact hook emits into the context that is ABOUT to be discarded, which
 * is the one place restoration text cannot survive. The `compact` source is the
 * harness telling us exactly this case.
 */
async function restoration() {
  // `readPayload` returns the PARSED object, not the raw text. Parsing it again
  // throws on `[object Object]`, and the throw is swallowed by the catch below,
  // so the restoration block simply never appeared -- the failure mode a
  // fail-open hook is most likely to hide.
  const parsed = await readPayload();
  if (!parsed) return null;

  // Only after a compaction. A cold start has nothing to restore, and paying
  // for this text on every session is the always-on bloat the project measures
  // against elsewhere.
  if (parsed.source !== 'compact') return null;

  const state = loadState(parsed.session_id);
  const seen = Object.keys(state.seen || {});
  if (!seen.length) return null;

  // The graph belongs to the project the FILES are in, not to wherever the
  // client happens to be running. Restoring from the busiest project is the
  // honest choice when a session spans two.
  const counts = new Map();
  for (const path of seen) {
    const root = projectRootFor(path, parsed.cwd);
    if (root) counts.set(root, (counts.get(root) || 0) + 1);
  }
  const root = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!root) return null;

  const dir = wikiDir(root);
  const plan = restorationPlan(dir, load(dir), {
    recentAnchors: seen.slice(-12),
  });
  return plan?.text ?? null;
}

const parts = [policyText(true)];

try {
  const restored = await restoration();
  if (restored) parts.push(restored);
} catch {
  // The policy notice must still arrive if anything above fails.
}

// THE TEXT ITSELF LIVES IN THE SHARED CORE. It used to be duplicated here,
// which is exactly the drift the adapter was built to end: an addition to the
// shared policy -- the project briefing, for instance -- reached the other five
// clients and silently skipped Claude Code, the one client most users are on.
// Claude Code keeps its own entry point because its PreToolUse router does more
// than the shared one; the standing notice is not a place it needs to differ.
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: parts.join('\n\n'),
    },
  })
);
