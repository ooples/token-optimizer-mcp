#!/usr/bin/env node
/**
 * Claude Code Stop adapter -- run the semantic harvest the design specifies.
 *
 * The wiki design says findings are extracted "at Stop and PreCompact" by a
 * cheap model, out of band. The extractor (`lib/harvest.mjs`) was implemented
 * and then imported by nothing: no hook invoked it, and Stop carried no
 * token-optimizer entry at all. The consequence was not a crash but a graph
 * that could serve findings and never acquired any -- 122 file / 132 symbol /
 * 61 task nodes and zero findings on a real project after a full session, with
 * injection, staleness and the metrics all wired and idle behind it.
 *
 * OUT OF BAND IS THE POINT. The extraction is a model call; doing it inline
 * would make the session that did the work pay for summarising itself, which is
 * the cost this whole subsystem exists to avoid. So this spawns a detached
 * worker and returns immediately. Stop is never delayed.
 *
 * IT ALSO REPORTS WHEN IT CANNOT RUN. Harvest requires an API key, and without
 * one `harvestEnabled()` returns false and the module skips silently. Silence
 * was how this stayed invisible: nothing in doctor, audit or waste mentions
 * harvest, so a user sees a graph filling with structural nodes and no findings
 * and has no way to learn why. Saying so once per session is the difference
 * between a disabled feature and a broken one.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mode, MODE_OFF } from './lib/policy.mjs';
import { harvestEnabled, harvestMode } from './lib/harvest.mjs';

/** What to tell the user, per reason the harvest is not running. */
const OFF_REASON = {
  'off:mode': null, // The whole optimizer is off; saying more would be noise.
  'off:not-opted-in':
    'token-optimizer: automatic finding-extraction is OFF. It costs a model call and '
    + 'sends a digest (paths, commands, prompts, conclusions -- never file contents) off '
    + 'this machine, so it is opt-in: set TOKEN_OPTIMIZER_HARVEST=1 with an API key, or '
    + 'point TOKEN_OPTIMIZER_HARVEST_ENDPOINT at a local model to run it free and private. '
    + 'Meanwhile the structural graph and anything written with wiki_write keep working.',
  'off:no-key':
    'token-optimizer: finding-extraction is opted in but has no credential. Set '
    + 'TOKEN_OPTIMIZER_API_KEY, or point TOKEN_OPTIMIZER_HARVEST_ENDPOINT at a local model '
    + 'to run it without one.',
};

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the once-per-session notice is remembered, so Stop does not nag. */
function noticePath(sessionId) {
  const dir = join(process.env.TEMP || process.env.TMPDIR || '.', 'token-optimizer');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort */
  }
  return join(dir, `harvest-notice-${String(sessionId || 'unknown').slice(0, 64)}`);
}

function alreadyNotified(sessionId) {
  const path = noticePath(sessionId);
  try {
    if (existsSync(path)) return true;
    writeFileSync(path, String(Date.now()));
  } catch {
    // If the marker cannot be written, prefer staying quiet over repeating.
    return true;
  }
  return false;
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

  const transcript = payload.transcript_path;
  if (!transcript || !existsSync(transcript)) return;

  if (!harvestEnabled()) {
    // Say it once, name the reason and the variable that changes it, and state
    // what still works. A user who reads this should know exactly what they are
    // and are not getting, and what to do about it.
    const message = OFF_REASON[harvestMode()];
    if (message && !alreadyNotified(payload.session_id)) {
      process.stdout.write(JSON.stringify({ systemMessage: message }));
    }
    return;
  }

  const worker = join(HERE, 'harvest-worker.mjs');
  if (!existsSync(worker)) return;

  // Detached and fully released: the harvest must outlive this hook without
  // holding Stop open for a model round-trip.
  const child = spawn(
    process.execPath,
    [worker, transcript, String(payload.session_id || ''), String(payload.cwd || process.cwd())],
    { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env } }
  );
  child.unref();
}

// Stop must complete whatever happens here.
main()
  .catch(() => {})
  .finally(() => process.exit(0));
