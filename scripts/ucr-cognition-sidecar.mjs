#!/usr/bin/env node

const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 512 * 1024)
    throw new Error('cognition sidecar request exceeds 512 KiB');
  chunks.push(chunk);
}

const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (!['verify-evidence', 'record'].includes(request.operation))
  throw new Error('unsupported cognition sidecar operation');
const { runUcrTool } = await import('../dist/server/ucr-tools.js');
const result = await runUcrTool('cognition_record', request);
process.stdout.write(JSON.stringify(result));
