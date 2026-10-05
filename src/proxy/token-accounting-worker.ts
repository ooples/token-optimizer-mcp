/**
 * The thread that does the counting. See token-accounting.ts for why this is a
 * thread at all: tokenizing is 0.33ms/KB, and a proxy that blocked its event
 * loop for 165ms per request to measure its own savings would be slower for
 * having measured them.
 *
 * NOTHING IS WRITTEN, LOGGED OR RETAINED HERE. Two bodies arrive, two integers
 * go back. The counter's own cache is bounded at 512 entries / 8MB with FIFO
 * eviction (see TokenCounter), which is what makes a resident instance safe in
 * a long-lived thread fed a stream of distinct conversations.
 */

import { parentPort } from 'node:worker_threads';
import { TokenCounter } from '../core/token-counter.js';

interface Job {
  readonly id: number;
  readonly before: string;
  readonly after: string;
}

const port = parentPort;
if (port) {
  const counter = new TokenCounter();
  port.on('message', (job: Job) => {
    try {
      port.postMessage({
        id: job.id,
        beforeTokens: counter.count(job.before).tokens,
        afterTokens: counter.count(job.after).tokens,
      });
    } catch (error) {
      // The caller settles on this rather than waiting forever; a tokenizer
      // that cannot read one body must not strand the request behind it.
      port.postMessage({
        id: job.id,
        error: error instanceof Error ? error.message : 'count failed',
      });
    }
  });
}
