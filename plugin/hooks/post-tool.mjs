#!/usr/bin/env node
// GENERATED FILE -- do not edit. Regenerate with `npm run sync:hooks`.
// Client entry point: names the client and event; all policy lives in the
// shared core so no client can drift its own thresholds or guidance.
// Fail open: a defect in the optimizer must never cost the user a tool call.
// Bootstrap failures are still recorded so fail-open does not become fail-silent.
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
// CLAUDE_PLUGIN_ROOT is what tells the two apart: the plugin runtime sets it,
// a settings.json install does not. decide.mjs states the rule this protects --
// never convert install intent into a claim that an MCP tool exists.
if (process.env.CLAUDE_PLUGIN_ROOT)
  process.env.TOKEN_OPTIMIZER_MCP_CAPABILITIES ??= 'smart_read,smart_write,smart_edit,smart_glob,smart_grep,optimize_session,get_optimization_report,wiki_write,wiki_query';
try {
  const { run } = await import('./lib/adapter.mjs');
  await run('claude-code', 'post-tool');
} catch (error) {
  try {
    const { recordHookBootstrapFailure } = await import('./lib/observability.mjs');
    recordHookBootstrapFailure('claude-code', 'post-tool', error);
  } catch {
    // A logger bootstrap failure is the only condition that remains silent.
  }
}
