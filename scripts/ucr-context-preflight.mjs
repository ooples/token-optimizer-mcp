#!/usr/bin/env node

// Deliberately runs outside the model process. The adapter pays for one bounded
// graph page, while the consumer receives neither the MCP server instructions
// nor any tool schemas and therefore cannot skip retrieval.

const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 64 * 1024) throw new Error('preflight request exceeds 64 KiB');
  chunks.push(chunk);
}

const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const { runUcrTool } = await import('../dist/server/ucr-tools.js');
const result = await runUcrTool('context_page', request);
process.stdout.write(JSON.stringify(result));
