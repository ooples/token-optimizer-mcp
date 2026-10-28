#!/usr/bin/env node
/**
 * Entry point: resolves which installed runtime runs this hook
 * (lib/runtime-switch.mjs), then runs impl/agent-scope.mjs from it. When the resolver
 * cannot be loaded at all, this copy's own impl runs, exactly as before.
 */
let importForHook = null;
try {
  ({ importForHook } = await import('./lib/runtime-switch.mjs'));
} catch {
  // Fall through to this copy's own hook.
}
if (importForHook)
  await importForHook({ here: import.meta.url, entryRel: 'plugin/hooks', event: 'pre-tool', module: 'impl/agent-scope.mjs' });
else await import('./impl/agent-scope.mjs');
