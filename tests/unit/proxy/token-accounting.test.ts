/**
 * The token accounting the proxy ledger reports its savings in.
 *
 * WHAT THESE TESTS ARE DEFENDING. The contract that matters is not "the
 * numbers are right" -- a tokenizer is already tested elsewhere -- it is that a
 * count which cannot be produced is NAMED rather than zeroed. A zero in this
 * field reads as a request the proxy did not improve, which is a false
 * measurement; a named refusal reads as a request that was not measured, which
 * is true. So every refusal path here is asserted to produce its own word, and
 * every one of those assertions is paired with a control showing the same
 * accounting measures normally when the path is not taken.
 *
 * The real backend is a worker thread, exercised against the built worker in
 * tests/integration. Here the backend is injected, so these tests are about
 * the bound, the naming and the bookkeeping rather than about threads.
 */

import {
  createTokenAccounting,
  TOKEN_METHOD,
  TOKEN_REFUSALS,
  type TokenizerBackend,
} from '../../../src/proxy/token-accounting.js';

/** Counts whitespace-separated words, which is enough to tell the sides apart. */
function words(): TokenizerBackend {
  return {
    async count(before, after) {
      return {
        beforeTokens: before.split(/\s+/).filter(Boolean).length,
        afterTokens: after.split(/\s+/).filter(Boolean).length,
      };
    },
    async shutdown() {},
  };
}

/** A backend whose jobs never settle until released, to fill the queue. */
function blocking(): TokenizerBackend & { release(): void; outstanding(): number } {
  const held: Array<() => void> = [];
  return {
    async count() {
      await new Promise<void>((resolve) => held.push(resolve));
      return { beforeTokens: 1, afterTokens: 1 };
    },
    async shutdown() {},
    release() {
      for (const resolve of held.splice(0)) resolve();
    },
    outstanding() {
      return held.length;
    },
  };
}

function throwing(message: string): TokenizerBackend {
  return {
    async count() {
      throw new Error(message);
    },
    async shutdown() {},
  };
}

describe('proxy token accounting', () => {
  it('counts both sides under one instrument and names it', async () => {
    const accounting = createTokenAccounting({ backend: words() });

    const result = await accounting.countPair('one two three four', 'one two');

    expect(result.measured).toBe(true);
    if (!result.measured) throw new Error('unreachable');
    expect(result.beforeTokens).toBe(4);
    expect(result.afterTokens).toBe(2);
    // The encoder travels with the figures: a token count whose instrument is
    // unstated cannot be compared with one from any other surface.
    expect(result.method).toBe(TOKEN_METHOD);
  });

  it('counts a Buffer body the same as the string it holds', async () => {
    const accounting = createTokenAccounting({ backend: words() });

    const fromBuffer = await accounting.countPair(
      Buffer.from('alpha beta gamma', 'utf8'),
      Buffer.from('alpha', 'utf8')
    );
    const fromString = await accounting.countPair('alpha beta gamma', 'alpha');

    expect(fromBuffer).toEqual(fromString);
    if (!fromBuffer.measured) throw new Error('unreachable');
    expect(fromBuffer.beforeTokens).toBe(3);
  });

  it('refuses a count past the bound by name, and measures within it', async () => {
    const backend = blocking();
    const accounting = createTokenAccounting({ backend, maxPending: 2 });

    // The control: the first two fit under the bound and are accepted -- they
    // are outstanding at the backend, not refused.
    const first = accounting.countPair('a', 'a');
    const second = accounting.countPair('b', 'b');
    await Promise.resolve();
    expect(backend.outstanding()).toBe(2);

    const third = await accounting.countPair('c', 'c');
    expect(third).toEqual({ measured: false, reason: TOKEN_REFUSALS.QueueFull });
    // The refused one was never handed to the backend, so a refusal costs
    // nothing beyond the refusal itself.
    expect(backend.outstanding()).toBe(2);

    backend.release();
    expect((await first).measured).toBe(true);
    expect((await second).measured).toBe(true);
  });

  it('frees the slot a finished count held', async () => {
    const accounting = createTokenAccounting({ backend: words(), maxPending: 1 });

    const results = [
      await accounting.countPair('x y', 'x'),
      await accounting.countPair('x y', 'x'),
      await accounting.countPair('x y', 'x'),
    ];

    // A bound of one must not mean one count per process: serial requests
    // through a single slot all measure.
    expect(results.every((r) => r.measured)).toBe(true);
    expect(accounting.refusals()[TOKEN_REFUSALS.QueueFull]).toBe(0);
  });

  it('names a backend that could not start, and measures when one can', async () => {
    const unavailable = createTokenAccounting({
      backend: throwing('worker unavailable'),
    });
    const working = createTokenAccounting({ backend: words() });

    const refused = await unavailable.countPair('a b', 'a');
    const measured = await working.countPair('a b', 'a');

    // THE TWO FAILURES ARE DIFFERENT OPERATIONAL STORIES. A thread that never
    // started is a deployment problem; a thread that died is a crash. Both
    // produce no number, so only the word distinguishes them afterwards.
    expect(refused).toEqual({
      measured: false,
      reason: TOKEN_REFUSALS.WorkerUnavailable,
    });
    expect(measured.measured).toBe(true);
  });

  it('names a backend that died mid-job', async () => {
    const accounting = createTokenAccounting({ backend: throwing('worker exited') });

    const refused = await accounting.countPair('a b', 'a');

    expect(refused).toEqual({
      measured: false,
      reason: TOKEN_REFUSALS.WorkerFailed,
    });
  });

  it('refuses after shutdown by name, having measured before it', async () => {
    const accounting = createTokenAccounting({ backend: words() });

    const before = await accounting.countPair('a b', 'a');
    await accounting.shutdown();
    const after = await accounting.countPair('a b', 'a');

    expect(before.measured).toBe(true);
    expect(after).toEqual({ measured: false, reason: TOKEN_REFUSALS.ShutDown });
  });

  it('tallies refusals by reason so a gap in the ledger is explainable', async () => {
    const accounting = createTokenAccounting({ backend: throwing('worker exited') });

    await accounting.countPair('a', 'a');
    await accounting.countPair('b', 'b');
    await accounting.shutdown();
    await accounting.countPair('c', 'c');

    expect(accounting.refusals()).toEqual({
      [TOKEN_REFUSALS.QueueFull]: 0,
      [TOKEN_REFUSALS.WorkerUnavailable]: 0,
      [TOKEN_REFUSALS.WorkerFailed]: 2,
      [TOKEN_REFUSALS.ShutDown]: 1,
    });
  });

  it('returns a tally that later counts cannot mutate', async () => {
    const accounting = createTokenAccounting({ backend: throwing('worker exited') });

    await accounting.countPair('a', 'a');
    const snapshot = accounting.refusals();
    await accounting.countPair('b', 'b');

    // A caller that holds a reading must keep that reading; the live tally has
    // moved on.
    expect(snapshot[TOKEN_REFUSALS.WorkerFailed]).toBe(1);
    expect(accounting.refusals()[TOKEN_REFUSALS.WorkerFailed]).toBe(2);
  });
});
