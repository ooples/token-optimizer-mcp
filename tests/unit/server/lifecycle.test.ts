/**
 * Tests for the stdio server shutdown lifecycle (PR #177 + completion).
 *
 * Verifies that every termination path (stdin end/close/error, SIGINT/SIGTERM/
 * SIGHUP) routes through one guarded shutdown that runs cleanup() and exits
 * EXACTLY ONCE — including when multiple events fire for a single disconnect,
 * which is the race the idempotency guard exists to prevent.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';
import { installShutdownHandlers } from '../../../src/server/lifecycle.js';

type MockProc = EventEmitter & { exit: jest.Mock };

function makeProc(): MockProc {
  const proc = new EventEmitter() as MockProc;
  proc.exit = jest.fn();
  return proc;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('installShutdownHandlers', () => {
  let errSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    // Shutdown logs a line to stderr; keep test output clean.
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it('exits with code 0 when stdin ends (the core #177 fix)', async () => {
    const proc = makeProc();
    const stdin = new EventEmitter();
    const cleanup = jest.fn(async () => {});

    installShutdownHandlers({ cleanup, proc, stdin });
    stdin.emit('end');
    await flush();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(0);
  });

  it('runs cleanup + exit EXACTLY ONCE when stdin emits end, then close, then error', async () => {
    const proc = makeProc();
    const stdin = new EventEmitter();
    const cleanup = jest.fn(async () => {});

    installShutdownHandlers({ cleanup, proc, stdin });
    // A single disconnect can surface as several events.
    stdin.emit('end');
    stdin.emit('close');
    stdin.emit('error', new Error('broken pipe'));
    await flush();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledTimes(1);
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'])(
    'shuts down cleanly on %s',
    async (signal) => {
      const proc = makeProc();
      const stdin = new EventEmitter();
      const cleanup = jest.fn(async () => {});

      installShutdownHandlers({ cleanup, proc, stdin });
      proc.emit(signal);
      await flush();

      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(proc.exit).toHaveBeenCalledWith(0);
    }
  );

  it('a signal racing a stdin close still cleans up exactly once', async () => {
    const proc = makeProc();
    const stdin = new EventEmitter();
    const cleanup = jest.fn(async () => {});

    installShutdownHandlers({ cleanup, proc, stdin });
    proc.emit('SIGTERM');
    stdin.emit('close');
    await flush();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledTimes(1);
  });

  it('still exits(0) even if cleanup rejects', async () => {
    const proc = makeProc();
    const stdin = new EventEmitter();
    const cleanup = jest.fn(async () => {
      throw new Error('cleanup failed');
    });

    installShutdownHandlers({ cleanup, proc, stdin });
    stdin.emit('error', new Error('pipe gone'));
    await flush();

    expect(proc.exit).toHaveBeenCalledWith(0);
  });
});
