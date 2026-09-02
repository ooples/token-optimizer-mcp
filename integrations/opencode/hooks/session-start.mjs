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
// THE OPT-OUT IS THE ENV VAR, NOT CLAUDE_PLUGIN_ROOT. Gating this on
// CLAUDE_PLUGIN_ROOT was tried and reverted: that variable is set by the Claude
// plugin runtime and by nothing else, while THESE entries are generated for
// codex, cursor, cline, gemini, qwen, copilot, windsurf and kilo -- whose
// installers write the hook and the MCP server config together, and which never
// set it. So the gate silently disabled enforcement-by-default for every one of
// them, and clients.test.mjs caught it across all eight ("denies a large read
// by default through its packaged pre-tool entry" -> received "allow").
//
// The nullish assignment below is what makes a narrower gate unnecessary: it
// assigns only when the variable is null or undefined, so an explicitly EMPTY
// value survives. A host, a user, or a benchmark arm measuring the hooks with
// no server states TOKEN_OPTIMIZER_MCP_CAPABILITIES='' and gets exactly the
// behaviour the gate reached for, without breaking installs that ship a server.
//
// NOTE FOR EDITORS: this whole block is inside a template literal. A backtick
// here terminates the string and the generator dies with a SyntaxError far from
// the cause -- which is exactly what happened writing this comment.
process.env.TOKEN_OPTIMIZER_MCP_CAPABILITIES ??= 'smart_read,smart_write,smart_edit,smart_glob,smart_grep,optimize_session,get_optimization_report,wiki_write,wiki_query';
try {
  const { run } = await import('./lib/adapter.mjs');
  await run('opencode', 'session-start');
} catch (error) {
  try {
    const { recordHookBootstrapFailure } = await import('./lib/observability.mjs');
    recordHookBootstrapFailure('opencode', 'session-start', error);
  } catch {
    // A logger bootstrap failure is the only condition that remains silent.
  }
}
