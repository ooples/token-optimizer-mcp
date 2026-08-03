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
import { tmpdir } from 'node:os';
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

/**
 * A session id reduced to something that cannot leave the marker directory.
 *
 * The id arrives in the hook payload, so it is external input, and it was being
 * interpolated straight into a path: a value containing separators or `..` would
 * have placed (and later read) the marker anywhere on disk. Everything outside a
 * conservative allowlist becomes an underscore, which keeps ordinary uuids
 * readable while making traversal unrepresentable rather than merely unlikely.
 */
function markerName(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  // A name of only dots would still resolve to a directory entry.
  const cleaned = /^[.]+$/.test(safe) ? 'unknown' : safe;
  return `harvest-notice-${cleaned.slice(0, 64)}`;
}

/** Where the once-per-session notice is remembered, so Stop does not nag. */
function noticePath(sessionId) {
  // os.tmpdir() rather than the TEMP/TMPDIR chain: the chain fell back to '.',
  // which scatters marker files through whatever repository the session happens
  // to be in.
  const dir = join(tmpdir(), 'token-optimizer');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort */
  }
  return join(dir, markerName(sessionId));
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

/** Minimum gap between harvests of one session. */
const HARVEST_INTERVAL_MS =
  Number(process.env.TOKEN_OPTIMIZER_HARVEST_INTERVAL_MS) > 0
    ? Number(process.env.TOKEN_OPTIMIZER_HARVEST_INTERVAL_MS)
    : 10 * 60 * 1000;

/**
 * True when this session has not been harvested recently, and records that it
 * is about to be.
 *
 * Deliberately marks only when a harvest actually starts: touching it on every
 * Stop would let a run of skipped turns keep pushing the next harvest away.
 */
function dueForHarvest(sessionId) {
  const marker = join(dirname(noticePath(sessionId)), `harvest-last-${markerName(sessionId)}`);
  try {
    const last = Number(readFileSync(marker, 'utf8'));
    if (Number.isFinite(last) && Date.now() - last < HARVEST_INTERVAL_MS) return false;
  } catch {
    // No marker yet, or unreadable -- treat as due.
  }
  try {
    writeFileSync(marker, String(Date.now()));
  } catch {
    // If the marker cannot be written the debounce degrades to off rather than
    // blocking the harvest entirely.
  }
  return true;
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
      // AWAIT THE WRITE. The finally below used to call process.exit(0), which
      // discards anything still buffered -- so on a pipe that had filled, the
      // one notice explaining why no findings exist was the thing most likely
      // to be dropped. Resolve on the callback, or on drain when the write is
      // buffered, before returning.
      await new Promise((resolve) => {
        const flushed = process.stdout.write(
          JSON.stringify({ systemMessage: message }),
          () => resolve()
        );
        if (!flushed) process.stdout.once('drain', resolve);
      });
    }
    return;
  }

  const worker = join(HERE, 'harvest-worker.mjs');
  if (!existsSync(worker)) return;

  // DEBOUNCE. Stop fires at the end of every assistant turn, so a talkative
  // session would spawn a model call per turn -- each re-reading an overlapping
  // transcript and re-extracting most of the same findings. The marker is
  // touched only when a harvest is actually started, so a skipped turn does not
  // push the next one further away.
  if (!dueForHarvest(payload.session_id)) return;

  // Detached and fully released: the harvest must outlive this hook without
  // holding Stop open for a model round-trip.
  const child = spawn(
    process.execPath,
    [worker, transcript, String(payload.session_id || ''), String(payload.cwd || process.cwd())],
    { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env } }
  );
  child.unref();
}

// Stop must complete whatever happens here -- but exitCode rather than exit(),
// so a buffered stdout notice is flushed on natural termination instead of being
// truncated. The detached worker is already unref'd, so nothing holds the loop
// open once main resolves.
main()
  .catch(() => {})
  .finally(() => {
    process.exitCode = 0;
  });
