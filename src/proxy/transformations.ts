/**
 * Keeping the last few request transformations in memory, so an operator can
 * ask what the proxy actually did.
 *
 * WHY THIS EXISTS. `AccountingRecord` already describes a transformation
 * completely -- bytes before and after, the elisions, the deferred tools, the
 * injected knowledge, the provider's own token counts -- and `server.ts` built
 * one per request. But it built one ONLY when `TOKEN_OPTIMIZER_PROXY_ACCOUNTING`
 * named a ledger path, and nothing in the shipped product ever read that ledger
 * back: the two readers are both benchmark scripts. So the proxy knew, to the
 * byte, what it had saved on every request, and there was no way to ask it.
 *
 * A RING, NOT A LOG, AND THAT IS THE PRIVACY ARGUMENT. `server.ts` promises not
 * to store, log or persist a payload, and this keeps that promise rather than
 * carving an exception out of it the way `capture.ts` has to. Every field of an
 * `AccountingRecord` is a count, a duration, a status, a fixed-vocabulary reason
 * or a list of tool NAMES. No message, no system prompt, no tool body and no
 * response text passes through here. It is bounded, it is in memory, and it dies
 * with the process -- so it needs no opt-in, which is the point: a diagnostic
 * nobody has to configure first is one that is there when it is needed.
 *
 * THE LEDGER STILL WINS ON DURABILITY. A ring answers "what just happened"; it
 * cannot answer "what happened on Tuesday". That is the ledger's job, and
 * `token-optimizer-inspect --ledger` reads it. Neither replaces the other.
 */

import type { AccountingRecord } from './accounting.js';

/**
 * How many transformations one listener remembers.
 *
 * Sized against the question, not against the memory. A record is a few hundred
 * bytes, so a hundred of them is noise next to a single request body; the reason
 * not to keep ten thousand is that nobody asks "what did the proxy do four
 * thousand requests ago" without reaching for the durable ledger instead.
 */
export const TRANSFORMATION_CAPACITY = 128;

/** A bounded, in-memory view of what the proxy recently did. */
export interface TransformationLog {
  /** Records one transformation, evicting the oldest when full. */
  readonly record: (entry: AccountingRecord) => void;
  /** The most recent `limit` records, oldest first. */
  readonly recent: (limit?: number) => readonly AccountingRecord[];
  /** How many records are held right now. */
  readonly size: () => number;
  /** How many were evicted, so a reader knows the window is not the whole story. */
  readonly dropped: () => number;
}

/**
 * Creates one log per listener.
 *
 * PER LISTENER RATHER THAN MODULE-LEVEL, because a supervisor runs several
 * proxies in one process -- one per upstream and project pair -- and a shared
 * ring would interleave two conversations' transformations into a single
 * window, each evicting the other's records. The supervisor aggregates them
 * when asked, which it can only do if they were separate to begin with.
 */
export function createTransformationLog(
  capacity: number = TRANSFORMATION_CAPACITY
): TransformationLog {
  // A plain array used as a ring: `head` is where the next write goes, and the
  // buffer is only reordered on read, which happens once per `inspect` call
  // rather than once per request.
  const size = Math.max(1, Math.floor(capacity));
  const buffer: (AccountingRecord | undefined)[] = new Array(size);
  let head = 0;
  let held = 0;
  let evicted = 0;
  return Object.freeze({
    record: (entry: AccountingRecord): void => {
      if (held === size) evicted++;
      buffer[head] = entry;
      head = (head + 1) % size;
      if (held < size) held++;
    },
    recent: (limit = size): readonly AccountingRecord[] => {
      const want = Math.min(Math.max(0, Math.floor(limit)), held);
      const out: AccountingRecord[] = [];
      // Walk backwards from the newest, then reverse, so a `limit` smaller than
      // the window returns the LAST n rather than the first n.
      for (let i = 0; i < want; i++) {
        const entry = buffer[(head - 1 - i + size * 2) % size];
        if (entry !== undefined) out.push(entry);
      }
      out.reverse();
      return Object.freeze(out);
    },
    size: () => held,
    dropped: () => evicted,
  });
}
