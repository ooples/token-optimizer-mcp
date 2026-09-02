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
  sessionContext,
  sessionIndex,
  standingRules,
} from './lib/inject.mjs';
import { wikiDir, load, projectRootFor } from './lib/wiki.mjs';
import { episodeMeta, featuresForArm } from './lib/experiment.mjs';
import { join } from 'node:path';
import { beginHookInvocation, noteHookOutput } from './lib/observability.mjs';

// THE BUNDLED INVENTORY IS ASSERTED ONLY FOR AN ACTUAL PLUGIN INSTALL.
//
// This used to run unconditionally, on the grounds that these entry points ship
// beside an MCP declaration for the same package. That holds for a plugin --
// .mcp.json travels with the hooks -- and not otherwise: the script path wires
// hooks through settings.json without the server, a user can drop the server
// and keep the hooks, and the benchmark arm removes the mcp block outright.
//
// In those cases the fabricated list was persisted as PROVEN evidence and the
// model was told to call tools that do not exist. Measured over a debug-sized
// task with no server: 3,450 characters of advice built on the assumption,
// including "Call the token-optimizer MCP tool smart_read" after every repeated
// read -- a failed call and a retry each time, on a benchmark where turns
// dominate cost. Removing it from session-start alone took the debug segment
// from 1.309 to 1.107 and its turns from 2.231 to 2.003.
//
// REVERTED FROM A CLAUDE_PLUGIN_ROOT GATE, for the reason recorded in the
// router: that variable is set by the plugin runtime alone, so the gate turned
// enforcement off for every non-plugin install and clients.test.mjs failed on
// all eight packaged entries.
//
// `??=` is the opt-out. It assigns only when the variable is null or undefined,
// so an explicitly EMPTY value survives -- which is how a benchmark arm, a host
// or a user says "there is no server here" without disabling the default for
// installs that do ship one.
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
// ASSEMBLED IN CACHE ORDER, not in the order the blocks are discovered below.
// This text sits near the FRONT of the prompt prefix, which a cache invalidates
// from the first differing byte onward, so the block that changes most often
// belongs LAST or it re-prices everything behind it every session.
// `sessionContext` sorts by the declared volatility; the numbers and the
// evidence for each are recorded in inject.mjs.
const blocks = [
  {
    id: 'policy',
    volatility: 0,
    text: policyText(true, toolEvidence.names, toolEvidence.proven),
  },
];

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
    if (rules) blocks.push({ id: 'standing', volatility: 1, text: rules });
    const relevantFindingIds = relevantFindingIdsForContext(
      graph,
      sessionTaskContext(payload)
    );
    const index = sessionIndex(dir, graph, {
      episode: episodeMeta({ client: 'claude-code', raw: payload }),
      relevantFindingIds,
    });
    if (index) blocks.push({ id: 'index', volatility: 2, text: index });
  }
} catch {
  // The policy notice must still arrive if the graph is unreadable.
}

// THE SITUATIONAL HALF, LAST -- now stated as a volatility rather than left to
// the order of these statements. Standing rules govern every turn; a restoration
// block speaks only to a session resuming from a compaction and is derived from
// the anchors of the context that was just discarded, so it is never twice the
// same and is the most expensive thing that could sit ahead of anything else.
try {
  const restored = await restoration(payload);
  if (restored)
    blocks.push({ id: 'restoration', volatility: 3, text: restored });
} catch {
  // The policy notice must still arrive if anything above fails.
}

const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: sessionContext(blocks),
    },
  };
const serialized = JSON.stringify(output);
noteHookOutput(output, Buffer.byteLength(serialized, 'utf8'));
process.stdout.write(serialized);
}

main()
  .then(() => invocation.succeed())
  .catch((error) => invocation.fail(error));
