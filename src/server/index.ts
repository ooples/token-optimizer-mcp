#!/usr/bin/env node

import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dispatchCli } from './cli-dispatch.js';

async function isEntryPoint(): Promise<boolean> {
  if (!process.argv[1]) return false;
  try {
    const [entry, module] = await Promise.all([
      realpath(process.argv[1]),
      realpath(fileURLToPath(import.meta.url)),
    ]);
    return entry === module;
  } catch {
    return false;
  }
}

// Load database-backed server modules only for the default MCP invocation.
void (async () => {
  if (!(await isEntryPoint())) return;
  if (!(await dispatchCli(process.argv.slice(2)))) {
    await import('./mcp-server.js');
  }
})().catch((error: unknown) => {
  console.error(error);
  // Failed startup can leave timers from imported services alive.
  process.exit(1);
});

export { instructionsFor, PLUGIN_INSTRUCTIONS } from './plugin-instructions.js';
