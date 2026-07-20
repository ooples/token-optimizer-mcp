#!/usr/bin/env node
/**
 * Cross-platform PreToolUse hook: steer large built-in `Read` calls toward the
 * token-optimizer `smart_read` MCP tool (cached/diffed, far fewer tokens).
 *
 * Runs on macOS/Linux/Windows (plain Node, no shell/PowerShell). It reads the
 * hook payload as JSON on stdin and:
 *   - default: emits a NON-blocking `additionalContext` nudge for large reads.
 *   - if TOKEN_OPTIMIZER_REDIRECT_LARGE_READS=true: DENIES the large read so the
 *     model uses smart_read instead (off by default — never breaks workflows).
 *
 * Why not transparently compress the Read? Claude Code's hook contract can't
 * replace a built-in tool's output (see anthropics/claude-code#32105), so the
 * only lever is to advise/deny at PreToolUse. Small reads pass through untouched.
 */
import { statSync } from 'node:fs';

const THRESHOLD_BYTES = Number(process.env.TOKEN_OPTIMIZER_LARGE_READ_BYTES) || 25_600; // ~25 KB
const REDIRECT = process.env.TOKEN_OPTIMIZER_REDIRECT_LARGE_READS === 'true';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function allow() {
  // No decision — let normal permission flow proceed.
  process.exit(0);
}

const raw = await readStdin();
let payload;
try {
  payload = JSON.parse(raw);
} catch {
  allow();
}

if (!payload || payload.tool_name !== 'Read') allow();

const filePath = payload.tool_input?.file_path;
if (!filePath) allow();

let size = 0;
try {
  const st = statSync(filePath);
  if (!st.isFile()) allow();
  size = st.size;
} catch {
  allow(); // unreadable/nonexistent — nothing to advise
}

if (size < THRESHOLD_BYTES) allow();

const kb = Math.round(size / 1024);
if (REDIRECT) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `This file is ${kb} KB. Use the smart_read MCP tool (smart_read with path="${filePath}") for a cached/diffed, token-optimized read instead of the built-in Read.`,
      },
    })
  );
  process.exit(0);
}

// Default: non-blocking nudge.
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `Tip: ${filePath} is ${kb} KB. Consider the smart_read MCP tool (cached/diffed) to save tokens on large or repeat reads.`,
    },
  })
);
process.exit(0);
