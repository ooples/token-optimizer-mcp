/**
 * The outcome of a write to a project store, and where a failed one is reported.
 *
 * WHY THIS EXISTS (#542). Every writer into `<root>/.token-optimizer/` swallowed
 * its own errors -- correctly, because the store is an optimization and must
 * never fail the user's tool call -- and then reported success anyway. putNode
 * returned an id after appendAll had caught ENOTDIR and written nothing, so a
 * caller could not tell a persisted record from a discarded one, and nothing
 * told an operator that a store had stopped accepting writes.
 *
 * The contract every store writer now follows:
 *
 *   persisted  the bytes reached the file (appendFileSync / rename returned)
 *   queued     accepted, not yet on disk: buffered for a batch flush, or (with
 *              maintenance mode) spooled for replay after cutover
 *   rejected   nothing was written; `reason` and `code` say why
 *
 * A rejected write is never silent. It is reported once per store, operation
 * and error code per process on stderr, and appended to a bounded failure log
 * outside every project store. If that log cannot be written either, stderr is
 * the only report: this module does not promise durable reporting when no
 * durable channel can be written.
 *
 * Failing to write is still never a thrown error. Callers keep working; they
 * just stop being told that something happened when it did not.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PERSISTED = 'persisted';
export const QUEUED = 'queued';
export const REJECTED = 'rejected';

/**
 * A record id unique across processes and machines.
 *
 * Graph nodes fold last-write-wins, so writing one twice is harmless. Metrics
 * and evidence are append-only COUNTS: a replay after a migration or a spool
 * flush would double them. `rid` is what a replay dedupes on.
 */
export function newRid() {
  return randomBytes(8).toString('hex');
}

/** Stamp each record with a `rid` unless it already carries one. */
export function withRids(records) {
  return records.map((record) => (record && record.rid ? record : { ...record, rid: newRid() }));
}

export const persisted = () => ({ outcome: PERSISTED });
export const queued = (reason) => ({ outcome: QUEUED, reason });

/** Where failed writes are logged: per user, outside every project store. */
export function failureLogPath(env = process.env) {
  const base = env.TOKEN_OPTIMIZER_HOME || join(homedir(), '.token-optimizer');
  return join(base, 'write-failures.jsonl');
}

// One megabyte, then the log rotates once. Bounded on purpose: a store that
// rejects every write in a long session must not fill the disk with reports.
const FAILURE_LOG_MAX_BYTES = 1024 * 1024;

const reported = new Set();

/**
 * A rejected outcome, reported.
 *
 * `quiet` is for a refusal the user asked for (the graph switched off): it is
 * still `rejected`, because nothing was written, but it is not an error.
 *
 * @param {{store: string, op: string, file?: string, error?: unknown, reason?: string, quiet?: boolean}} what
 */
export function rejected({ store, op, file, error, reason, quiet = false }) {
  const code = (error && typeof error === 'object' && error.code) || undefined;
  const why = reason || (error instanceof Error ? error.message : String(error ?? 'unknown'));
  const outcome = { outcome: REJECTED, reason: why, ...(code ? { code } : {}) };
  if (quiet) return outcome;

  const key = `${store}\u0000${op}\u0000${code ?? why}`;
  if (reported.has(key)) return outcome;
  reported.add(key);
  try {
    process.stderr.write(
      `[token-optimizer] ${op} rejected for store ${store}${file ? ` (${file})` : ''}: ${code ? `${code} ` : ''}${why}\n`
    );
  } catch {
    // No stderr either: the outcome object is all that is left.
  }
  try {
    const log = failureLogPath();
    mkdirSync(join(log, '..'), { recursive: true, mode: 0o700 });
    try {
      if (statSync(log).size > FAILURE_LOG_MAX_BYTES) renameSync(log, `${log}.1`);
    } catch {
      // No log yet.
    }
    appendFileSync(
      log,
      `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, store, op, file, code, reason: why })}\n`,
      { mode: 0o600 }
    );
  } catch {
    // The report channel itself failed. stderr above is the only report, and
    // nothing here claims otherwise.
  }
  return outcome;
}

/** Whether an outcome means the caller may treat the record as accepted. */
export const accepted = (outcome) => outcome?.outcome === PERSISTED || outcome?.outcome === QUEUED;
