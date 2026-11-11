#!/usr/bin/env node
/**
 * token-optimizer-statusline: Claude Code status line that records quota usage.
 *
 * Claude Code hands its status-line command a JSON payload that, on a
 * subscription, carries `rate_limits.five_hour` and `rate_limits.seven_day`
 * (`used_percentage`, `resets_at`). Hooks never see those numbers, and the
 * weekly-aware pacer (src/hooks-core/quota-policy.mjs) cannot decide without them,
 * so this records them to a local file and then prints a status line.
 *
 *   --wrap-b64 <b64>  run an existing status-line command with the same input
 *                     and print ITS output, so installing this changes nothing
 *                     the person sees; only the recording is added.
 *
 * Without --wrap it prints a compact quota line: `5h 32% · week 41% (pace 45%)`.
 * It never fails the status line: any error prints what it can and exits 0.
 */

import { spawnSync } from 'node:child_process';
import { quotaLine, recordRateLimits } from '../hooks-core/quota-policy.mjs';

function readStdin() {
  const chunks = [];
  return new Promise((resolve) => {
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function main(argv) {
  const input = await readStdin();
  let payload = null;
  try {
    payload = JSON.parse(input);
  } catch {
    payload = null;
  }
  if (payload) recordRateLimits(payload);
  // The wrapped command travels base64-encoded so no quoting survives or
  // breaks between the settings file, the shell and this argv.
  const wrapIndex = argv.indexOf('--wrap-b64');
  const wrapped = wrapIndex >= 0 && argv[wrapIndex + 1] ? Buffer.from(argv[wrapIndex + 1], 'base64').toString('utf8') : null;
  if (wrapped) {
    const run = spawnSync(wrapped, { input, shell: true, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    process.stdout.write(run.stdout || '');
    return;
  }
  process.stdout.write(`${quotaLine(payload)}\n`);
}

main(process.argv.slice(2)).catch(() => {
  process.stdout.write('token-optimizer\n');
});
