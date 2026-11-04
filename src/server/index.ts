#!/usr/bin/env node

import { dispatchCli } from './cli-dispatch.js';

// Load database-backed server modules only for the default MCP invocation.
void (async () => {
  if (!(await dispatchCli(process.argv.slice(2)))) {
    await import('./mcp-server.js');
  }
})().catch((error: unknown) => {
  console.error(error);
  // Failed startup can leave timers from imported services alive.
  process.exit(1);
});

export { instructionsFor, PLUGIN_INSTRUCTIONS } from './plugin-instructions.js';
