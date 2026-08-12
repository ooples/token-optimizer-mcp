#!/usr/bin/env node
// GENERATED FILE -- do not edit. Regenerate with `npm run sync:hooks`.
// Client entry point: names the client and event; all policy lives in the
// shared core so no client can drift its own thresholds or guidance.
// Fail open: a defect in the optimizer must never cost the user a tool call.
// Bootstrap failures are still recorded so fail-open does not become fail-silent.
process.env.TOKEN_OPTIMIZER_VERSION = '5.7.0';
try {
  const { run } = await import('./lib/adapter.mjs');
  await run('windsurf', 'pre-tool');
} catch (error) {
  try {
    const { recordHookBootstrapFailure } = await import('./lib/observability.mjs');
    recordHookBootstrapFailure('windsurf', 'pre-tool', error);
  } catch {
    // A logger bootstrap failure is the only condition that remains silent.
  }
}
