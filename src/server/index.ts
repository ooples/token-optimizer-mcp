#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dispatchCli } from './cli-dispatch.js';

function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

// Load database-backed server modules only for the default MCP invocation.
if (isEntryPoint()) {
  void (async () => {
    if (!(await dispatchCli(process.argv.slice(2)))) {
      await import('./mcp-server.js');
    }
  })().catch((error: unknown) => {
    console.error(error);
    // Failed startup can leave timers from imported services alive.
    process.exit(1);
  });
}

export { instructionsFor, PLUGIN_INSTRUCTIONS } from './plugin-instructions.js';
