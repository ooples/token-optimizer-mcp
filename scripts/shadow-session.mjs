#!/usr/bin/env node
/**
 * Runs the enforcement router in SHADOW over real tool calls.
 *
 * Installing the enforcing hooks into a live session and then doing real work
 * would test the product, but a defect would wedge the session doing the
 * testing. Shadow mode gets the same signal without that: the real router,
 * the real decision engine, the real session state -- fed the payloads an
 * actual session produces -- while the caller proceeds regardless.
 *
 * It answers the questions that matter about this product on real work:
 *   - what would have been REFUSED, and was that refusal right?
 *   - how many bytes would the redirect have avoided?
 *   - does anything break on a large real repository?
 *
 * Usage:
 *   node shadow-session.mjs read  <session> <cwd> <file>
 *   node shadow-session.mjs grep  <session> <cwd> <pattern> [path]
 *   node shadow-session.mjs bash  <session> <cwd> <command>
 *   node shadow-session.mjs report <session>
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTER = join(ROOT, 'plugin', 'hooks', 'pretooluse-router.mjs');
const LOG_DIR = join(tmpdir(), 'token-optimizer-shadow');

const [mode, session, cwd, ...rest] = process.argv.slice(2);
const logPath = join(LOG_DIR, `${session}.jsonl`);

function payloadFor() {
  const base = { session_id: session, cwd };
  if (mode === 'read') return { ...base, tool_name: 'Read', tool_input: { file_path: rest[0] } };
  if (mode === 'grep') return { ...base, tool_name: 'Grep', tool_input: { pattern: rest[0], path: rest[1] } };
  if (mode === 'bash') return { ...base, tool_name: 'Bash', tool_input: { command: rest.join(' ') } };
  return null;
}

if (mode === 'report') {
  if (!existsSync(logPath)) {
    console.log('no shadow events recorded');
    process.exit(0);
  }
  const events = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const denied = events.filter((e) => e.decision === 'deny');
  const advised = events.filter((e) => e.decision === 'advise');
  const allowed = events.filter((e) => e.decision === 'allow');

  const bytes = denied.reduce((sum, e) => sum + (e.bytes || 0), 0);

  console.log(`shadow session ${session}`);
  console.log(`  operations   ${events.length}`);
  console.log(`  refused      ${denied.length}`);
  console.log(`  advised      ${advised.length}  (repeat of an already-refused target)`);
  console.log(`  allowed      ${allowed.length}`);
  console.log(`  bytes behind refusals  ${bytes.toLocaleString()} (~${Math.round(bytes / 4).toLocaleString()} tokens)`);
  console.log('');
  for (const e of denied) {
    console.log(`  REFUSED ${e.tool} ${e.target}`);
    console.log(`          -> ${String(e.reason).replace(/\s+/g, ' ').slice(0, 150)}`);
  }
  process.exit(0);
}

const payload = payloadFor();
if (!payload) {
  console.error('unknown mode');
  process.exit(2);
}

const result = spawnSync(process.execPath, [ROUTER], {
  input: JSON.stringify(payload),
  encoding: 'utf8',
  env: { ...process.env, TOKEN_OPTIMIZER_MODE: 'enforce' },
});

let decision = 'allow';
let reason = '';
if (result.stdout && result.stdout.trim()) {
  const out = JSON.parse(result.stdout).hookSpecificOutput || {};
  decision = out.permissionDecision || (out.additionalContext ? 'advise' : 'allow');
  reason = out.permissionDecisionReason || out.additionalContext || '';
}

const target = rest[0] || '';
let bytes = 0;
try {
  if (mode === 'read') bytes = statSync(target).size;
} catch { /* not a file */ }

mkdirSync(LOG_DIR, { recursive: true });
appendFileSync(logPath, JSON.stringify({
  at: Date.now(), tool: payload.tool_name, target, decision, reason, bytes,
}) + '\n');

console.log(`${decision.toUpperCase()}${decision === 'deny' ? ` (${Math.round(bytes / 1024)} KB)` : ''}`);
if (reason) console.log(reason.replace(/\s+/g, ' ').slice(0, 200));
