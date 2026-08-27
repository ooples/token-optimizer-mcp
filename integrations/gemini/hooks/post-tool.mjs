#!/usr/bin/env node
// GENERATED FILE -- do not edit. Regenerate with `npm run sync:hooks`.
// Client entry point: names the client and event; all policy lives in the
// shared core so no client can drift its own thresholds or guidance.
// Fail open: a defect in the optimizer must never cost the user a tool call.
// Bootstrap failures are still recorded so fail-open does not become fail-silent.
// These entry points ship beside an MCP declaration for this same package. Hosts
// do not expose their registered tool inventory to hook payloads, so make that
// bundled contract explicit. An explicit empty value still wins and fails open.
process.env.TOKEN_OPTIMIZER_MCP_CAPABILITIES ??= 'smart_read,smart_write,smart_edit,smart_glob,smart_grep,optimize_session,get_optimization_report,wiki_write,wiki_query';
try {
  const { run } = await import('./lib/adapter.mjs');
  await run('gemini', 'post-tool');
} catch (error) {
  try {
    const { recordHookBootstrapFailure } = await import('./lib/observability.mjs');
    recordHookBootstrapFailure('gemini', 'post-tool', error);
  } catch {
    // A logger bootstrap failure is the only condition that remains silent.
  }
}
