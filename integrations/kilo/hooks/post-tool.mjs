#!/usr/bin/env node
// GENERATED FILE -- do not edit. Regenerate with `npm run sync:hooks`.
// Client entry point: names the client and event; all policy lives in the
// shared core so no client can drift its own thresholds or guidance.
// Fail open: a defect in the optimizer must never cost the user a tool call.
// Bootstrap failures are still recorded so fail-open does not become fail-silent.
// THE BUNDLED INVENTORY IS ASSERTED FOR EVERY INSTALL THAT DOES NOT OPT OUT.
//
// These entry points ship beside an MCP declaration for the same package, so
// the default is that the server is there. The concern that motivated a gate
// is real -- the script path wires hooks through settings.json without the
// server, a user can drop the server and keep the hooks, and the benchmark arm
// removes the mcp block outright, and in those cases a fabricated list was
// persisted as PROVEN evidence and the model was told to call tools that do
// not exist. Measured over a debug-sized task with no server: 3,450 characters
// of advice built on that assumption, a failed call and a retry each time.
//
// REVERTED FROM A CLAUDE_PLUGIN_ROOT GATE, TWICE NOW. That variable is set by
// the Claude plugin runtime and by nothing else, so gating on it disabled
// enforcement-by-default for every install that is not a plugin -- which is
// all eight clients this generator emits. clients.test.mjs catches it: every
// packaged entry returns "allow" where it must deny. It passes on a developer
// machine only because Claude Code sets the variable, so the gate is invisible
// locally and fails in CI.
//
// The nullish assignment below already provides the opt-out the gate was
// reaching for: it assigns only when the variable is null or undefined, so an
// explicitly EMPTY value
// survives. A benchmark arm measuring the hooks with no server sets
// TOKEN_OPTIMIZER_MCP_CAPABILITIES='' and gets exactly that, without breaking
// installs that genuinely ship the server beside these hooks.
process.env.TOKEN_OPTIMIZER_MCP_CAPABILITIES ??= 'smart_read,smart_write,smart_edit,smart_glob,smart_grep,optimize_session,get_optimization_report,wiki_write,wiki_query';
try {
  const { run } = await import('./lib/adapter.mjs');
  await run('kilo', 'post-tool');
} catch (error) {
  try {
    const { recordHookBootstrapFailure } = await import('./lib/observability.mjs');
    recordHookBootstrapFailure('kilo', 'post-tool', error);
  } catch {
    // A logger bootstrap failure is the only condition that remains silent.
  }
}
