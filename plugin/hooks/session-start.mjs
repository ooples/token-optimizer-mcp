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

import {
  mode,
  MODE_OFF,
  readPayloadResult,
  loadState,
  saveState,
} from './lib/policy.mjs';
import { policyText, sessionTaskContext } from './lib/adapter.mjs';
import {
  HOOK_MCP_TOOLS,
  optimizerToolEvidence,
  rememberOptimizerTools,
} from './lib/capabilities.mjs';
import { restorationPlan } from './lib/restore.mjs';
import {
  relevantFindingIdsForContext,
  sessionIndex,
  standingRules,
} from './lib/inject.mjs';
import { wikiDir, load, projectRootFor } from './lib/wiki.mjs';
import { episodeMeta, featuresForArm } from './lib/experiment.mjs';
import { join } from 'node:path';
import { beginHookInvocation, noteHookOutput } from './lib/observability.mjs';

// The plugin owns both this hook and its MCP declaration. Claude does not pass
// the registered tool inventory to SessionStart, so make the bundled schemas
// explicit while preserving an explicitly empty host/user override.
process.env.TOKEN_OPTIMIZER_MCP_CAPABILITIES ??= HOOK_MCP_TOOLS.join(',');

const invocation = beginHookInvocation('claude-code', 'session-start');

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
async function restoration(parsed) {
  // `readPayloadResult` returns the PARSED object, not the raw text. Parsing it again
  // throws on `[object Object]`, and the throw is swallowed by the catch below,
  // so the restoration block simply never appeared -- the failure mode a
  // fail-open hook is most likely to hide.
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

// THE TEXT ITSELF LIVES IN THE SHARED CORE. It used to be duplicated here,
// which is exactly the drift the adapter was built to end: an addition to the
// shared policy -- the project briefing, for instance -- reached the other five
// clients and silently skipped Claude Code, the one client most users are on.
// Claude Code keeps its own entry point because its PreToolUse router does more
// than the shared one; the standing notice is not a place it needs to differ.
async function main() {
if (mode() === MODE_OFF) return;
const input = await readPayloadResult({ timeoutMs: 250 });
const payload = input.payload || {};
if (input.payload) invocation.bind(payload, null, input.bytes);
else invocation.noteInput(input.status, input.bytes);
const features = featuresForArm();
const toolEvidence = optimizerToolEvidence(payload);
if (payload.session_id && toolEvidence.proven) {
  const state = loadState(payload.session_id);
  rememberOptimizerTools(state, toolEvidence);
  saveState(payload.session_id, state);
}
const parts = [policyText(true, toolEvidence.names, toolEvidence.proven)];

// THE ALWAYS-ON HALF OF DELIVERY. Trigger-fired injection answers "this
// situation is happening now", which cannot cover a rule about how the work is
// conducted -- by the time a command matched a trigger, a turn governed by that
// rule would already be going wrong. Those have to be present before the first
// tool call or they do nothing.
//
// Deliberately narrow and tightly budgeted: only pinned facts and human-verified
// corrections qualify. An always-on block that grows with the project is how it
// becomes wallpaper, and a model stops reading what it always sees.
try {
  const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dir = wikiDir(projectRootFor(join(cwd, '__session__'), cwd));
  if (features.retrieval) {
    // The index renders claims and freshness state, never snapshot bodies.
    // Skipping the sidecar keeps startup bounded on mature graphs.
    const graph = load(dir);
    const rules = standingRules(dir, graph);
    if (rules) parts.push(rules);
    const relevantFindingIds = relevantFindingIdsForContext(
      graph,
      sessionTaskContext(payload)
    );
    const index = sessionIndex(dir, graph, {
      episode: episodeMeta({ client: 'claude-code', raw: payload }),
      relevantFindingIds,
    });
    if (index) parts.push(index);
  }
} catch {
  // The policy notice must still arrive if the graph is unreadable.
}

// THE SITUATIONAL HALF, LAST. Standing rules govern every turn; restoration
// speaks only to a session resuming from a compaction, so it reads as the more
// specific note after the general one.
try {
  const restored = await restoration(payload);
  if (restored) parts.push(restored);
} catch {
  // The policy notice must still arrive if anything above fails.
}

const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: parts.join('\n\n'),
    },
  };
const serialized = JSON.stringify(output);
noteHookOutput(output, Buffer.byteLength(serialized, 'utf8'));
process.stdout.write(serialized);
}

main()
  .then(() => invocation.succeed())
  .catch((error) => invocation.fail(error));
