#!/usr/bin/env node
/**
 * Entry point: resolves which installed runtime runs this hook
 * (lib/runtime-switch.mjs), then runs impl/agent-spawn.mjs from it. When the resolver
 * cannot be loaded at all, this copy's own impl runs, exactly as before.
 */
let importForHook = null;
try {
  ({ importForHook } = await import('./lib/runtime-switch.mjs'));
} catch {
  // Fall through to this copy's own hook.
}
if (importForHook)
  await importForHook({ here: import.meta.url, entryRel: 'src/plugin/hooks', event: 'pre-tool', module: 'impl/agent-spawn.mjs' });
else await import('./impl/agent-spawn.mjs');
