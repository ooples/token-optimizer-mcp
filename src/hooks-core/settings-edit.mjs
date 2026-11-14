/**
 * One read-modify-write of a JSON settings file, under a lock every
 * token-optimizer writer of that file shares (#568 review).
 *
 * WHY A LOCK, NOT ONLY AN ATOMIC RENAME. The subagent cache tier
 * (agent-ledger.mjs), the main cache tier (main-cache-ttl.mjs) and the skill
 * diet (skill-diet.mjs) each read ~/.claude/settings.json, decide, and write the
 * whole file back. A rename makes each write whole, but a writer that read
 * before another one wrote still replaces that write with its older snapshot:
 * both report success and one setting is lost. Under the lock each edit reads
 * the file fresh, re-checks ownership on what it read, merges and writes, so
 * the next writer always starts from the last one's result.
 *
 * The decision that needs measuring -- scanning transcripts -- happens before
 * the lock is taken; only the read, check, merge and write run under it.
 *
 * Claude Code itself does not take this lock. The window against its writes is
 * the few milliseconds between the fresh read and the rename, not the seconds a
 * transcript scan takes.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let counter = 0;

function acquire(lock, { timeoutMs, staleMs }) {
  const token = `${process.pid}-${Date.now()}-${(counter += 1)}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try {
        writeFileSync(fd, token);
      } finally {
        closeSync(fd);
      }
      return token;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    // A holder that died leaves its lock behind; past staleMs it is abandoned.
    try {
      if (Date.now() - statSync(lock).mtimeMs > staleMs) {
        unlinkSync(lock);
        continue;
      }
    } catch {
      continue; // released between the open and the stat
    }
    if (Date.now() >= deadline) return null;
    pause(25);
  }
}

function release(lock, token) {
  try {
    if (readFileSync(lock, 'utf8') === token) unlinkSync(lock);
  } catch {
    /* already gone */
  }
}

/**
 * Edit the JSON object at `path`.
 *
 * `edit(settings)` gets the freshly read object (`{}` when the file does not
 * exist) and returns `{ next, ...extra }` to write `next`, or `{ skip: reason }`
 * to leave the file alone. It must not mutate `settings`.
 *
 * Returns `{ status, reason, existed, backup, ...extra }`, where `status` is
 * `written`, `skipped`, `unparseable`, `not-object`, `busy` or `failed`. The
 * file is never rewritten unless it parsed as an object. With `backupTag`, the
 * exact prior bytes are kept at `<path>.<backupTag>-<now>.bak` first.
 */
export function editSettings(path, edit, { now = Date.now(), backupTag = null, timeoutMs = 2_000, staleMs = 30_000 } = {}) {
  const lock = `${path}.token-optimizer.lock`;
  let token;
  try {
    mkdirSync(dirname(path), { recursive: true });
    token = acquire(lock, { timeoutMs, staleMs });
  } catch (error) {
    return { status: 'failed', reason: `lock failed: ${error?.message || error}` };
  }
  if (!token) return { status: 'busy', reason: 'settings locked by another writer; tried again next time' };
  try {
    const existed = existsSync(path);
    let raw = null;
    let settings = {};
    if (existed) {
      try {
        raw = readFileSync(path, 'utf8');
        settings = JSON.parse(raw);
      } catch {
        return { status: 'unparseable', reason: 'settings not parseable; never rewritten', existed };
      }
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return { status: 'not-object', reason: 'settings not an object', existed };
      }
    }
    const outcome = edit(settings) || { skip: 'nothing to write' };
    if (outcome.skip) return { status: 'skipped', reason: outcome.skip, existed };
    const { next, ...extra } = outcome;
    const backup = backupTag && raw !== null ? `${path}.${backupTag}-${now}.bak` : null;
    if (backup) writeFileSync(backup, raw);
    const tmp = `${path}.token-optimizer-tmp-${now}-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, path);
    return { status: 'written', reason: 'written', existed, backup, ...extra };
  } catch (error) {
    return { status: 'failed', reason: `write failed: ${error?.message || error}` };
  } finally {
    release(lock, token);
  }
}
