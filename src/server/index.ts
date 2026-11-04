#!/usr/bin/env node

import { dispatchCli } from './cli-dispatch.js';

// Load database-backed server modules only for the default MCP invocation.
if (!(await dispatchCli(process.argv.slice(2)))) {
  await import('./mcp-server.js');
}

export { instructionsFor, PLUGIN_INSTRUCTIONS } from './plugin-instructions.js';
