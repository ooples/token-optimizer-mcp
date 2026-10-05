/**
 * The rollup is where a wrong number would be invisible.
 *
 * A counter that double-counts, or that keeps a window's counts and adds the
 * next window on top, still produces a plausible-looking event -- bigger
 * numbers, same shape -- and nothing downstream could tell. So these tests
 * assert the arithmetic against hand-computed totals rather than against
 * whatever the module happens to produce, and the reset-after-emit case is
 * checked by emitting twice and reading the SECOND event.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  noteRequest,
  flushRollup,
  pendingCounts,
  resetRollup,
  ROLLUP_EVERY,
} from '../../../src/telemetry/rollup.js';
import { eventsFile } from '../../../src/telemetry/recorder.js';

let home: string;
const optedIn = (): NodeJS.ProcessEnv =>
  ({
    TOKEN_OPTIMIZER_TELEMETRY: '1',
    USERPROFILE: home,
    HOME: home,
  }) as NodeJS.ProcessEnv;
const optedOut = (): NodeJS.ProcessEnv =>
  ({ USERPROFILE: home, HOME: home }) as NodeJS.ProcessEnv;

const request = (extra: Record<string, unknown> = {}) => ({
  beforeBytes: 1000,
  afterBytes: 400,
  compressed: true,
  losslessMode: true,
  ...extra,
});

/** Every line written so far, parsed. */
const written = (env: NodeJS.ProcessEnv): Record<string, unknown>[] => {
  const at = eventsFile(env);
  if (!existsSync(at)) return [];
  return readFileSync(at, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

/** The sanitised properties of one written event. */
const props = (
  env: NodeJS.ProcessEnv,
  index = 0
): Record<string, number | boolean> =>
  written(env)[index]?.properties as Record<string, number | boolean>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'to-rollup-'));
  resetRollup();
});

afterEach(() => {
  resetRollup();
  rmSync(home, { recursive: true, force: true });
});

describe('the rollup window', () => {
  it('writes nothing until the window is full, and then exactly one event', () => {
    const env = optedIn();
    for (let i = 0; i < ROLLUP_EVERY - 1; i += 1) {
      expect(noteRequest(request(), env)).toBeNull();
    }
    // THE LAST ONE IS THE ONE THAT EMITS. Asserting only that an event appears
    // eventually would pass for a module that emitted on every request.
    expect(written(env)).toHaveLength(0);
    const event = noteRequest(request(), env);
    expect(event).not.toBeNull();
    const rows = written(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_type).toBe('proxy_rollup');
  });

  it('totals every request in the window and nothing outside it', () => {
    const env = optedIn();
    // Hand-computed: 200 requests, of which the first three are refusals that
    // grew nothing, and every request injects 10 characters.
    for (let i = 0; i < ROLLUP_EVERY; i += 1) {
      noteRequest(
        request({
          beforeBytes: 100,
          afterBytes: i < 3 ? 100 : 60,
          compressed: i >= 3,
          injectedChars: 10,
          elisions: 2,
        }),
        env
      );
    }
    expect(props(env).requests).toBe(200);
    expect(props(env).bytes_in).toBe(200 * 100);
    expect(props(env).bytes_out).toBe(3 * 100 + 197 * 60);
    expect(props(env).paid).toBe(197);
    expect(props(env).refused).toBe(3);
    expect(props(env).knowledge_injected).toBe(200);
    expect(props(env).injected_chars).toBe(2000);
    expect(props(env).elisions).toBe(400);
    expect(props(env).spilled).toBe(0);
    expect(props(env).final).toBe(false);
  });

  it('starts the next window from zero', () => {
    const env = optedIn();
    for (let i = 0; i < ROLLUP_EVERY; i += 1) noteRequest(request(), env);
    expect(pendingCounts().requests).toBe(0);
    for (let i = 0; i < ROLLUP_EVERY; i += 1) noteRequest(request(), env);
    const rows = written(env);
    expect(rows).toHaveLength(2);
    // THE SECOND EVENT, NOT THE FIRST. A module that never reset would report
    // 400 here while the first event stayed correct, which is exactly the bug
    // a single-window test cannot see.
    expect(props(env, 1).requests).toBe(ROLLUP_EVERY);
    expect(props(env, 1).bytes_in).toBe(ROLLUP_EVERY * 1000);
  });
});

describe('the shutdown rollup', () => {
  it('is a no-op when nothing has been counted', () => {
    const env = optedIn();
    expect(flushRollup(env)).toBeNull();
    expect(written(env)).toHaveLength(0);
  });

  it('writes the partial window and marks it final', () => {
    const env = optedIn();
    noteRequest(request(), env);
    noteRequest(request(), env);
    expect(flushRollup(env)).not.toBeNull();
    expect(props(env).requests).toBe(2);
    expect(props(env).final).toBe(true);
    // AND IT DOES NOT LEAVE THE COUNTS BEHIND. A second shutdown -- two signals
    // arriving, or a close handler running twice -- must not duplicate the row.
    expect(flushRollup(env)).toBeNull();
    expect(written(env)).toHaveLength(1);
  });
});

describe('what it reports about the arm', () => {
  it('records the lossless arm as the proxy ran it', () => {
    const env = optedIn();
    noteRequest(request({ losslessMode: false, spilledBlocks: 4 }), env);
    noteRequest(request({ losslessMode: false, spilledBlocks: 1 }), env);
    flushRollup(env);
    expect(props(env).lossless_mode).toBe(false);
    expect(props(env).spilled).toBe(5);
  });

  it('omits the arm rather than guessing it', () => {
    const env = optedIn();
    // No `losslessMode` on the facts at all -- a caller that never said.
    noteRequest(
      { beforeBytes: 10, afterBytes: 5, compressed: true },
      env
    );
    flushRollup(env);
    // A ROW WAS WRITTEN FIRST. `not.toContain` on an absent event passes for
    // the wrong reason -- it would also pass if the rollup had refused to write
    // at all -- and this test would then keep passing after the arm started
    // being defaulted.
    expect(written(env)).toHaveLength(1);
    expect(props(env).requests).toBe(1);
    expect(Object.keys(props(env))).not.toContain('lossless_mode');
  });
});

describe('consent', () => {
  it('counts without opt-in but writes nothing', () => {
    const env = optedOut();
    for (let i = 0; i < ROLLUP_EVERY; i += 1) {
      expect(noteRequest(request(), env)).toBeNull();
    }
    // COUNTED, NOT WRITTEN. The counters feed the proxy's own log too, so the
    // absence of a file is the assertion -- not the absence of counting.
    expect(written(env)).toHaveLength(0);
    expect(existsSync(eventsFile(env))).toBe(false);
    // The window still turned over, so no session accumulates unbounded state
    // waiting for an opt-in that never comes.
    expect(pendingCounts().requests).toBe(0);
  });

  it('drops a non-finite byte count instead of poisoning the total', () => {
    const env = optedIn();
    noteRequest(request({ beforeBytes: Number.NaN, afterBytes: 400 }), env);
    noteRequest(request({ beforeBytes: 1000, afterBytes: 400 }), env);
    flushRollup(env);
    expect(props(env).bytes_in).toBe(1000);
    expect(Number.isFinite(props(env).bytes_in)).toBe(true);
  });
});
