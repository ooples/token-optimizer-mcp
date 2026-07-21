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

function parseArgs(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function isPartialRead(args) {
  return [
    'offset',
    'limit',
    'lineStart',
    'lineEnd',
    'start_line',
    'end_line',
  ].some((key) => args[key] !== undefined);
}

function largeRead(payload) {
  const args = parseArgs(payload.toolArgs);
  if (isPartialRead(args)) return undefined;

  const requestedPath = args.file_path ?? args.filePath ?? args.path;
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    return undefined;
  }

  const absolutePath = isAbsolute(requestedPath)
    ? requestedPath
    : resolve(payload.cwd || process.cwd(), requestedPath);

  try {
    const stats = statSync(absolutePath);
    if (!stats.isFile() || stats.size < threshold) return undefined;
    return { absolutePath, size: stats.size };
  } catch {
    return undefined;
  }
}

const raw = await readStdin();
let payload;
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0);
}

if (mode === 'session-start') {
  process.stdout.write(JSON.stringify({ additionalContext: guidance }));
  process.exit(0);
}

if (payload?.toolName !== 'view') process.exit(0);

const read = largeRead(payload);
if (!read) process.exit(0);

const kb = Math.round(read.size / 1024);
const message = `${read.absolutePath} is ${kb} KB. Use token-optimizer smart_read with path="${read.absolutePath}" for cached, diff-based repeat reads.`;

if (mode === 'before-read' && redirect) {
  process.stdout.write(
    JSON.stringify({
      permissionDecision: 'deny',
      permissionDecisionReason: message,
    })
  );
} else if (mode === 'after-read') {
  process.stdout.write(
    JSON.stringify({
      additionalContext: `Token Optimizer suggestion: ${message}`,
    })
  );
}
