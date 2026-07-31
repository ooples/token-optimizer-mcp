#!/usr/bin/env node
/**
 * Claude Code PreCompact adapter -- optimize at the moment it matters most.
 *
 * Compaction is when the context window has already filled and the harness is
 * about to discard detail to make room. Anything the optimizer can move out of
 * context BEFORE that point is detail that survives as a retrievable artifact
 * instead of being summarized away.
 *
 * A PROTOCOL CONSTRAINT WORTH STATING PLAINLY: a hook cannot call an MCP tool.
 * Hooks are commands; MCP tools are model-invoked. So this cannot simply "run
 * optimize_session". It does the next best thing that is actually within its
 * power -- invoke the same underlying tool through the package's one-shot CLI
 * wrapper, which exists precisely for out-of-band invocation.
 *
 * When the wrapper is not resolvable (plugin-only installs do not ship it, only
 * global npm installs do) the hook exits silently rather than pretending. It
 * never blocks or delays compaction: the spawn is bounded and fail-open.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mode, MODE_OFF, loadState } from './lib/policy.mjs';

/** Longest compaction may be delayed. Past this the work is abandoned. */
const TIMEOUT_MS = Number(process.env.TOKEN_OPTIMIZER_PRECOMPACT_TIMEOUT_MS) || 8000;

function findWrapper() {
  // Plugin installs place the plugin under .../plugin; the wrapper, when
  // present, sits at the package root above it. Global installs resolve it
  // through the package directory directly.
  const roots = [
    process.env.CLAUDE_PLUGIN_ROOT ? join(process.env.CLAUDE_PLUGIN_ROOT, '..') : null,
    process.env.TOKEN_OPTIMIZER_HOME || null,
  ].filter(Boolean);

  for (const root of roots) {
    const candidate = join(root, 'cli-wrapper.mjs');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function main() {
  if (mode() === MODE_OFF) return;

  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(chunk);

  let payload;
  try {
    payload = JSON.parse(chunks.join(''));
  } catch {
    return;
  }

  const wrapper = findWrapper();
  if (!wrapper) return;

  // Only worth spawning if this session actually accumulated file operations.
  const state = loadState(payload.session_id);
  const seenCount = Object.keys(state.seen || {}).length;
  if (seenCount === 0) return;

  await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [wrapper, 'optimize_session', JSON.stringify({ sessionId: payload.session_id })],
      { stdio: 'ignore', windowsHide: true }
    );
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, TIMEOUT_MS);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
    child.on('error', () => { clearTimeout(timer); resolve(); });
  });

  process.stdout.write(JSON.stringify({
    systemMessage: `token-optimizer: compressed ${seenCount} tracked file operation(s) before compaction.`,
  }));
}

// Compaction must proceed whatever happens here.
main().catch(() => {}).finally(() => process.exit(0));
