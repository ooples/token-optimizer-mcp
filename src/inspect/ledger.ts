/**
 * Reading the durable side: an accounting ledger written by the proxy.
 *
 * WHY BOTH THIS AND THE LIVE RING. The ring in `proxy/transformations.ts`
 * answers "what just happened" with no configuration at all, and loses
 * everything when the proxy stops. The ledger answers "what happened on
 * Tuesday" but only for an operator who set `TOKEN_OPTIMIZER_PROXY_ACCOUNTING`
 * before Tuesday. Neither is a substitute for the other, so `inspect` reads
 * whichever the caller asks for.
 *
 * STREAMED, NOT SLURPED, AND BOUNDED. A ledger accumulates one line per
 * request for as long as it is configured, which in a long-lived session is
 * megabytes. Reading it whole to show the last ten records would make the
 * diagnostic the most expensive thing in the session, so this streams and keeps
 * a ring of the last `last` parsed records.
 *
 * A TORN OR FOREIGN LINE IS SKIPPED, NOT FATAL. `appendRecord` writes
 * synchronously precisely so lines are whole, but a ledger can also be
 * truncated by a disk filling or concatenated by hand, and refusing to show
 * nine good records because the tenth is half-written would be the wrong
 * trade. The count of skipped lines is returned so the reader is told.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { AccountingRecord } from '../proxy/accounting.js';

/** What a ledger read found, including what it could not parse. */
export interface LedgerRead {
  readonly records: readonly AccountingRecord[];
  readonly skipped: number;
}

/**
 * Whether a parsed line is a record rather than some other JSON.
 *
 * CHECKS THE FIELDS A RENDERER DEREFERENCES, not every field of the interface.
 * The optional ones are optional in the type too, and demanding them would
 * reject a record written by an older version of this package over a field
 * that had not been added yet -- which is exactly the ledger a reader is most
 * likely to be looking at when something went wrong.
 */
export function looksLikeRecord(value: unknown): value is AccountingRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.ts === 'string' &&
    typeof record.path === 'string' &&
    typeof record.status === 'number' &&
    typeof record.compressed === 'boolean' &&
    typeof record.beforeBytes === 'number' &&
    typeof record.afterBytes === 'number'
  );
}

/** The last `last` records of a JSONL ledger, oldest first. */
export async function readLedger(path: string, last = 10): Promise<LedgerRead> {
  const want = Math.max(1, Math.floor(last));
  const kept: AccountingRecord[] = [];
  let skipped = 0;
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const text = line.trim();
    if (text === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      skipped++;
      continue;
    }
    if (!looksLikeRecord(parsed)) {
      skipped++;
      continue;
    }
    kept.push(parsed);
    // Trimmed as we go rather than at the end, so the peak is the window and
    // not the file.
    if (kept.length > want) kept.shift();
  }
  return { records: Object.freeze(kept), skipped };
}
