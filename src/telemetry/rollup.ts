/**
 * Usage counters, emitted as one rolled-up event per N requests.
 *
 * ONE EVENT PER REQUEST WAS THE OBVIOUS SHAPE AND IT DOES NOT WORK. The log
 * rotates at 4 MiB and a flush sends at most 500 events, so a busy session would
 * write thousands of rows, upload the first 500 of them and drop the rest -- and
 * the totals computed from that upload would be a sample nobody chose, biased
 * toward the start of every session. Accumulating in memory and emitting a
 * rollup keeps the totals EXACT for every request that happened, at the cost of
 * the per-request distribution, and one rollup per 200 requests means a single
 * 500-event flush covers a hundred thousand requests.
 *
 * WHAT IS LOST IF THE PROCESS DIES: at most the requests since the last rollup.
 * `flushRollup` is called on proxy shutdown to narrow that to zero on a clean
 * exit, and a kill costs under 200 requests' worth of counts -- which is why the
 * emit is periodic rather than only at the end.
 *
 * NOTHING HERE DECIDES CONSENT. Counting happens in memory whatever the policy
 * says, because the counters are also what the proxy's own log reports; `record`
 * is the gate, and it checks the policy itself on every call. A session that
 * never opted in accumulates numbers that are never written anywhere.
 */

import { record, libraryVersion } from './recorder.js';

/** Requests per rollup. See the header for why this is not 1. */
export const ROLLUP_EVERY = 200;

interface Counters {
  requests: number;
  bytes_in: number;
  bytes_out: number;
  paid: number;
  refused: number;
  knowledge_injected: number;
  injected_chars: number;
  elisions: number;
  spilled: number;
}

const zero = (): Counters => ({
  requests: 0,
  bytes_in: 0,
  bytes_out: 0,
  paid: 0,
  refused: 0,
  knowledge_injected: 0,
  injected_chars: 0,
  elisions: 0,
  spilled: 0,
});

let live = zero();

/**
 * Which arm the proxy is running, as of the last request counted.
 *
 * NOT A COUNT, AND NOT DEFAULTED. It is the one field that says whether these
 * byte figures came from the arm where nothing leaves the request or the arm
 * where an elided block is recoverable from a file, and the two are not
 * comparable. `null` means no request has been counted yet, in which case the
 * rollup omits the field rather than asserting the default -- a guessed arm on
 * a real row is worse than a missing one.
 */
let mode: boolean | null = null;

/** One request's facts, as the proxy summary already reports them. */
export interface RequestFacts {
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly compressed: boolean;
  readonly injectedChars?: number;
  readonly elisions?: number;
  readonly spilledBlocks?: number;
  /**
   * True when nothing may leave the request -- the default arm.
   *
   * Mirrors `!options.spill` at the proxy, which is fixed for the life of the
   * process, so every request in a window reports the same value.
   */
  readonly losslessMode?: boolean;
}

const finite = (n: number | undefined): number =>
  typeof n === 'number' && Number.isFinite(n) ? n : 0;

/**
 * Count one request, and emit a rollup when the window is full.
 *
 * Returns the event if one was written, so a caller can assert that the
 * threshold is what triggers an emit rather than inferring it from a file.
 */
export function noteRequest(
  facts: RequestFacts,
  env: NodeJS.ProcessEnv = process.env
): ReturnType<typeof record> {
  live.requests += 1;
  live.bytes_in += finite(facts.beforeBytes);
  live.bytes_out += finite(facts.afterBytes);
  if (facts.compressed && finite(facts.afterBytes) < finite(facts.beforeBytes))
    live.paid += 1;
  if (!facts.compressed) live.refused += 1;
  const injected = finite(facts.injectedChars);
  if (injected > 0) {
    live.knowledge_injected += 1;
    live.injected_chars += injected;
  }
  live.elisions += finite(facts.elisions);
  live.spilled += finite(facts.spilledBlocks);
  if (typeof facts.losslessMode === 'boolean') mode = facts.losslessMode;
  if (live.requests < ROLLUP_EVERY) return null;
  return emit('window', env);
}

/**
 * Write what has accumulated, if anything has. Called at shutdown.
 *
 * `reason` is a COUNT, not a string: the schema admits numbers and booleans
 * only, so "was this the shutdown rollup" is a boolean and not a label that
 * would be silently dropped on the way to disk.
 */
export function flushRollup(
  env: NodeJS.ProcessEnv = process.env
): ReturnType<typeof record> {
  if (live.requests === 0) return null;
  return emit('shutdown', env);
}

function emit(
  which: 'window' | 'shutdown',
  env: NodeJS.ProcessEnv
): ReturnType<typeof record> {
  const counts = live;
  // RESET BEFORE THE WRITE, so a `record` that throws -- it does not, but the
  // whole module is written on the assumption that instrumentation must never
  // double-count -- cannot leave the same requests counted in the next rollup.
  live = zero();
  return record(
    'proxy_rollup',
    libraryVersion(),
    {
      ...counts,
      ...(mode === null ? {} : { lossless_mode: mode }),
      final: which === 'shutdown',
    },
    env
  );
}

/** The counts not yet emitted. For `doctor` and for tests; never for a caller's arithmetic. */
export function pendingCounts(): Readonly<Record<string, number>> {
  return { ...live };
}

/** Drop everything counted so far without writing it. Tests only. */
export function resetRollup(): void {
  live = zero();
  mode = null;
}
