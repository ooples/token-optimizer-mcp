#!/usr/bin/env node

import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const mode = process.argv[2];
const threshold =
  Number(process.env.TOKEN_OPTIMIZER_LARGE_READ_BYTES) || 25_600;
const redirect = process.env.TOKEN_OPTIMIZER_REDIRECT_LARGE_READS === 'true';

const guidance =
  'Use the token-optimizer MCP for large or repeated operations: smart_read for large/repeated files, smart_glob or smart_grep for noisy searches, optimize_text for bulky output, optimize_session before context gets tight, and get_optimization_report for savings. Built-in tools remain appropriate for small one-off operations.';

function readStdin() {
  return new Promise((resolveInput) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (input += chunk));
    process.stdin.on('end', () => resolveInput(input));
    process.stdin.on('error', () => resolveInput(input));
  });
}

function isPartialRead(args) {
  return ['offset', 'limit', 'start_line', 'end_line'].some(
    (key) => args[key] !== undefined
  );
}

const raw = await readStdin();
let payload;
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0);
}

if (mode === 'session-start') {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { additionalContext: guidance } })
  );
  process.exit(0);
}

if (mode !== 'after-read' || payload?.tool_name !== 'read_file') {
  process.exit(0);
}

const args = payload.tool_input ?? {};
if (isPartialRead(args)) process.exit(0);

const requestedPath = args.file_path;
if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
  process.exit(0);
}

const absolutePath = isAbsolute(requestedPath)
  ? requestedPath
  : resolve(payload.cwd || process.cwd(), requestedPath);

let size;
try {
  const stats = statSync(absolutePath);
  if (!stats.isFile() || stats.size < threshold) process.exit(0);
  size = stats.size;
} catch {
  process.exit(0);
}

const kb = Math.round(size / 1024);
const message = `${absolutePath} is ${kb} KB. Token Optimizer can cache it and return only diffs on repeat reads.`;

if (redirect) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        tailToolCallRequest: {
          name: 'mcp_token-optimizer_smart_read',
          args: { path: absolutePath },
        },
      },
    })
  );
} else {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        additionalContext: `Token Optimizer suggestion: ${message} Use smart_read for this file on the next read.`,
      },
    })
  );
}
