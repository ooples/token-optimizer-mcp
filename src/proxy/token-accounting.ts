/**
 * WHAT THE PROXY SAVED, IN TOKENS, measured rather than inferred.
 *
 * THE GAP THIS CLOSES. `grep -rn analytics src/proxy/*.ts` returned nothing:
 * the component responsible for the largest savings in the product contributed
 * no row to any savings surface, so `token-optimizer-savings` had to print a
 * line disclaiming its own scope. The proxy knew exactly what it had done --
 * `beforeBytes`, `afterBytes` and the provider's own billed token count for
 * the rewritten body -- and none of it was ever expressed in the unit a bill is
 * denominated in.
 *
 * WHY BOTH SIDES ARE COUNTED LOCALLY. The provider bills for what we sent, so
 * the after-body has an exact, free, authoritative token count. The before-body
 * does not and never can: nobody billed for a request we did not make. The
 * honest measurement is therefore both sides under ONE instrument, which gives
 * a difference whose error largely cancels, plus the provider's count of the
 * after-body as an independent check on that instrument -- a calibration point
 * every single request supplies for free. That is strictly stronger provenance
 * than the MCP tool path, which has no external check at all.
 *
 * WHY A WORKER THREAD, which is not a shape used anywhere else in this package.
 * Tokenizing is linear and not cheap: measured at 0.33ms/KB, so 42ms for a
 * 128KB body and 165ms for a 512KB one. A proxy that blocked its event loop
 * for 165ms per request would add that to every concurrent request and stall
 * the streaming of any other response in flight -- it would make the product
 * slower to measure how much it had saved. The alternatives were all worse: an
 * inline count blocks, a chunked count miscounts at every seam it introduces,
 * and skipping the large bodies would silently drop exactly the requests that
 * matter most.
 *
 * AND THE WALL-CLOCK COST IS ZERO, because the count is started before the
 * request is forwarded and awaited in the usage tap -- it runs inside the
 * upstream round trip, which is always longer.
 *
 * A REFUSAL IS NAMED, NEVER A ZERO. Every path that cannot produce a count
 * says which one it was, and the record carries that word instead of a token
 * figure. A zero here would read as a request the proxy did not improve.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Why a request has no token figures. Each of these is a different operational
 * story and collapsing them into one "unavailable" would make the first
 * question about a gap in the ledger unanswerable.
 */
export const TOKEN_REFUSALS = Object.freeze({
  /** More counts were outstanding than the bound allows; this one was not run. */
  QueueFull: 'queue-full',
  /** The worker could not be started at all -- the count was never attempted. */
  WorkerUnavailable: 'worker-unavailable',
  /** The worker was started and then died or reported an error for this job. */
  WorkerFailed: 'worker-failed',
  /** Accounting was shut down while this count was outstanding. */
  ShutDown: 'shut-down',
} as const);

export type TokenRefusal = (typeof TOKEN_REFUSALS)[keyof typeof TOKEN_REFUSALS];

/**
 * THE INSTRUMENT IS NAMED IN THE RESULT, matching what the MCP path records
 * under `tokenCountMethod`. A token figure whose encoder is unstated cannot be
 * compared with one from anywhere else, including a later version of this file.
 */
export const TOKEN_METHOD = 'tiktoken-gpt-4-compatible-local-estimate';

export type TokenCountResult =
  | {
      readonly measured: true;
      readonly beforeTokens: number;
      readonly afterTokens: number;
      readonly method: string;
    }
  | { readonly measured: false; readonly reason: TokenRefusal };

/**
 * How many counts may be outstanding before the next is refused.
 *
 * BOUNDED BECAUSE THE QUEUE HOLDS PAYLOADS. Each pending job retains both
 * bodies, so an unbounded queue under a burst is an unbounded memory
 * commitment in a long-lived proxy. Eight is roughly a second of work at the
 * largest body sizes we see, which is far longer than a burst of requests from
 * one agent lasts; past that, refusing and saying so is better than growing.
 */
const MAX_PENDING = 8;

/** What the worker is sent and what it sends back. */
interface Job {
  readonly id: number;
  readonly before: string;
  readonly after: string;
}

interface Reply {
  readonly id: number;
  readonly beforeTokens?: number;
  readonly afterTokens?: number;
  readonly error?: string;
}

/** A tokenizer that can be swapped for a synchronous one in tests. */
export interface TokenizerBackend {
  count(before: string, after: string): Promise<{ beforeTokens: number; afterTokens: number }>;
  shutdown(): Promise<void>;
}

/**
 * The worker-backed tokenizer.
 *
 * ONE WORKER, STARTED LAZILY. A proxy that never serves a request should not
 * pay for a thread, and a proxy that serves thousands should not pay for more
 * than one: the work is CPU-bound and serialising it is what keeps the main
 * loop free, which was the entire point.
 *
 * REF'D WHILE IT HAS WORK, UNREF'D WHEN IDLE. An idle accounting thread that
 * kept a finished proxy alive would be a hang caused by a measurement, so the
 * thread starts unref'd -- but a bare `unref` is wrong in the other direction
 * and this was caught by running it: a pending promise does not hold the event
 * loop open, so a process whose only outstanding work was a token count exited
 * before the reply arrived and the count silently never settled. Inside the
 * proxy the listening socket hid that; outside it, the first real invocation
 * printed nothing at all. Holding the reference only while jobs are
 * outstanding is what makes both halves true at once.
 */
function workerBackend(): TokenizerBackend {
  const here = dirname(fileURLToPath(import.meta.url));
  let worker: Worker | null = null;
  let next = 0;
  const waiting = new Map<number, (reply: Reply) => void>();
  let failed: string | null = null;

  /**
   * Holds the event loop open exactly as long as a count is outstanding. Called
   * after every change to `waiting`, so an abandoned job cannot leave the
   * reference held.
   */
  const settleRef = (active: Worker | null): void => {
    if (!active) return;
    if (waiting.size > 0) active.ref();
    else active.unref();
  };

  const fail = (reason: string): void => {
    failed = reason;
    const pending = [...waiting.values()];
    waiting.clear();
    const dead = worker;
    worker = null;
    dead?.unref();
    for (const resolve of pending) resolve({ id: -1, error: reason });
  };

  const ensure = (): Worker | null => {
    if (failed !== null) return null;
    if (worker) return worker;
    try {
      const started = new Worker(join(here, 'token-accounting-worker.js'), {
        /*
         * NONE OF THE PARENT'S FLAGS. A worker inherits `process.execArgv` by
         * default, and some of what a host puts there is fatal in a
         * file-backed thread: a parent run with `--input-type=module` (how
         * `node --input-type=module -e` works, and how the integration suite
         * drives this) hands the thread a flag that may only accompany
         * `--eval`, so the thread died on startup and every count came back
         * `worker-failed`. The counting thread needs no flag from the parent
         * to do its one job, so it is given none, and a host's own node
         * options can no longer cost the ledger its token columns.
         */
        execArgv: [],
      });
      started.on('message', (reply: Reply) => {
        const resolve = waiting.get(reply.id);
        if (resolve) {
          waiting.delete(reply.id);
          settleRef(started);
          resolve(reply);
        }
      });
      // A worker that dies takes its outstanding jobs with it, and each of them
      // has a caller waiting. Settling them as failures is what keeps a dead
      // thread from turning into a stalled ledger.
      started.on('error', (error) => fail(error.message));
      started.on('exit', () => {
        if (waiting.size > 0) fail('worker exited');
        else worker = null;
      });
      // Starts unref'd: a thread with no work must not hold the process.
      started.unref();
      worker = started;
      return started;
    } catch (error) {
      failed = error instanceof Error ? error.message : 'worker could not start';
      return null;
    }
  };

  return {
    async count(before, after) {
      const active = ensure();
      if (!active) throw new Error(failed ?? 'worker unavailable');
      const id = (next += 1);
      const job: Job = { id, before, after };
      const reply = await new Promise<Reply>((resolve) => {
        waiting.set(id, resolve);
        settleRef(active);
        try {
          active.postMessage(job);
        } catch (error) {
          waiting.delete(id);
          settleRef(active);
          resolve({ id, error: error instanceof Error ? error.message : 'post failed' });
        }
      });
      if (
        reply.error !== undefined ||
        typeof reply.beforeTokens !== 'number' ||
        typeof reply.afterTokens !== 'number'
      ) {
        throw new Error(reply.error ?? 'worker returned no counts');
      }
      return { beforeTokens: reply.beforeTokens, afterTokens: reply.afterTokens };
    },
    async shutdown() {
      const active = worker;
      worker = null;
      failed = failed ?? 'shut down';
      if (active) await active.terminate();
    },
  };
}

/**
 * A count in flight, with its result readable synchronously once it arrives.
 *
 * WHY `settled` EXISTS. The ledger row was written synchronously the moment the
 * provider's usage settled, and attaching a token count must not quietly turn
 * that into a deferred write -- a row that lands a tick later is a row that is
 * not there yet for anything reading the file, and it reorders against rows
 * from paths that never await anything. In the normal case the count finishes
 * well inside the upstream round trip, so the caller can read it here and stay
 * synchronous; `done` is the fallback for the case where the round trip beat
 * the count, which a local upstream can do.
 */
export interface PendingCount {
  /** The result, or null while the count is still running. */
  settled(): TokenCountResult | null;
  readonly done: Promise<TokenCountResult>;
}

/** Wraps a count so its result can be read without awaiting. */
export function trackCount(count: Promise<TokenCountResult>): PendingCount {
  let result: TokenCountResult | null = null;
  const done = count.then((value) => {
    result = value;
    return value;
  });
  return {
    settled: () => result,
    done,
  };
}

export interface TokenAccounting {
  /**
   * Count both bodies under one instrument. Never throws, never blocks the
   * caller's loop for the duration of the count.
   */
  countPair(before: Buffer | string, after: Buffer | string): Promise<TokenCountResult>;
  /**
   * Starts the thread and the encoder before any request needs them.
   *
   * WITHOUT THIS THE FIRST PROXIED REQUEST PAYS FOR THE INSTRUMENT: measured at
   * ~190ms for thread start plus tiktoken's one-time table load, against ~32ms
   * to count a 216KB body afterwards. That is the one request guaranteed to
   * have its count arrive after its response, and on a short-lived proxy it
   * could be the only request there is.
   */
  warmUp(): void;
  /** Counts refused so far, by reason, for whoever asks why the ledger has gaps. */
  refusals(): Readonly<Record<TokenRefusal, number>>;
  shutdown(): Promise<void>;
}

export interface TokenAccountingOptions {
  /** Swapped in tests; the default runs the count on a worker thread. */
  readonly backend?: TokenizerBackend;
  readonly maxPending?: number;
}

export function createTokenAccounting(
  options: TokenAccountingOptions = {}
): TokenAccounting {
  const backend = options.backend ?? workerBackend();
  const maxPending = options.maxPending ?? MAX_PENDING;
  const refused: Record<TokenRefusal, number> = {
    [TOKEN_REFUSALS.QueueFull]: 0,
    [TOKEN_REFUSALS.WorkerUnavailable]: 0,
    [TOKEN_REFUSALS.WorkerFailed]: 0,
    [TOKEN_REFUSALS.ShutDown]: 0,
  };
  let pending = 0;
  let stopped = false;

  const refuse = (reason: TokenRefusal): TokenCountResult => {
    refused[reason] += 1;
    return { measured: false, reason };
  };

  return {
    warmUp() {
      // Deliberately unawaited and deliberately ignored: a warm-up that failed
      // tells us nothing a real count will not tell us again, with a name.
      void backend.count('warm', 'warm').catch(() => undefined);
    },
    async countPair(before, after) {
      if (stopped) return refuse(TOKEN_REFUSALS.ShutDown);
      // CHECKED BEFORE THE BODIES ARE CONVERTED, so a refused request never
      // pays for the string it was not going to count.
      if (pending >= maxPending) return refuse(TOKEN_REFUSALS.QueueFull);
      pending += 1;
      try {
        const counts = await backend.count(
          typeof before === 'string' ? before : before.toString('utf8'),
          typeof after === 'string' ? after : after.toString('utf8')
        );
        return {
          measured: true,
          beforeTokens: counts.beforeTokens,
          afterTokens: counts.afterTokens,
          method: TOKEN_METHOD,
        };
      } catch (error) {
        // THE FAILURES ARE DISTINGUISHED because they mean different things to
        // whoever is looking: a thread that never started is a deployment
        // problem, a thread that died is a crash worth finding, and a count
        // abandoned at shutdown is neither.
        const message = error instanceof Error ? error.message : '';
        if (/shut down/i.test(message)) return refuse(TOKEN_REFUSALS.ShutDown);
        return refuse(
          /unavailable|could not start/i.test(message)
            ? TOKEN_REFUSALS.WorkerUnavailable
            : TOKEN_REFUSALS.WorkerFailed
        );
      } finally {
        pending -= 1;
      }
    },
    refusals() {
      return { ...refused };
    },
    async shutdown() {
      stopped = true;
      await backend.shutdown();
    },
  };
}
