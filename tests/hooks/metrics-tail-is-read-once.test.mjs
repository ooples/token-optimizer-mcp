/**
 * The shared tail reader, and the two things it must never break.
 *
 * `readAll` and `scanForBalance` were near-identical copies of the same
 * read-and-parse, and both run inside a single fleet_audit against the same
 * metrics.jsonl. Leaf CPU on a 5.4 MB file: readAll 15.8%, scanForBalance
 * 16.3%, plus readFileUtf8 9.5%, Buffer.slice 6.0%, readFileSync 4.5% -- about
 * half the tool, doing the same work twice. They now share one read and one
 * JSON.parse, which took fleet_audit from ~290 ms to ~140 ms.
 *
 * Sharing introduced exactly two ways to be wrong, and this file exists for
 * them:
 *
 *   1. THE EVENT WINDOW. `scanForBalance` deliberately does not window by event
 *      count. An earlier fix routed it through `readAll`, inherited readAll's
 *      MAX_EVENTS window, and the holdout measurement it existed to repair
 *      stayed at zero on 122 real graphs. The shared piece must be the I/O and
 *      the parse ONLY -- never the policy.
 *
 *   2. STALENESS. The parse is memoised on (size, mtime). A memo that fails to
 *      notice an append would serve a stale event log, and every measurement
 *      built on it would quietly stop moving.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const CORE = (name) =>
  pathToFileURL(join(process.cwd(), 'hooks-core', name)).href;

let dir;
let readMetrics;
let readBalance;

beforeEach(async () => {
  ({ readMetrics, readBalance } = await import(CORE('metrics.mjs')));
  dir = mkdtempSync(join(tmpdir(), 'metrics-tail-'));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
});

/** Writes `count` plain events, then returns the path they went to. */
const metricsFile = () => join(dir, 'metrics.jsonl');

const seed = (count, make) => {
  const path = metricsFile();
  const lines = [];
  for (let i = 0; i < count; i++) lines.push(JSON.stringify(make(i)));
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
};

describe('the memoised tail notices the file changing', () => {
  it('serves an appended record rather than the previous parse', () => {
    seed(3, (i) => ({ kind: 'read', anchor: `/a${i}.ts`, at: 1000 + i }));

    const before = readMetrics(dir);
    expect(before.map((e) => e.anchor)).toEqual(['/a0.ts', '/a1.ts', '/a2.ts']);

    appendFileSync(
      metricsFile(),
      `${JSON.stringify({ kind: 'read', anchor: '/appended.ts', at: 2000 })}\n`
    );

    // The whole risk the memo introduces. A stale answer here is silent: every
    // measurement built on the event log would simply stop moving.
    const after = readMetrics(dir);
    expect(after.map((e) => e.anchor)).toEqual([
      '/a0.ts',
      '/a1.ts',
      '/a2.ts',
      '/appended.ts',
    ]);
  });

  it('notices a rewrite that leaves the file the same length', () => {
    // Size alone is not enough to key a memo. Same byte count, different
    // content -- only the mtime separates them.
    const path = seed(1, () => ({ kind: 'read', anchor: '/aaa.ts', at: 1000 }));
    expect(readMetrics(dir).map((e) => e.anchor)).toEqual(['/aaa.ts']);

    const rewritten = JSON.stringify({ kind: 'read', anchor: '/bbb.ts', at: 1000 });
    writeFileSync(path, `${rewritten}\n`);

    expect(readMetrics(dir).map((e) => e.anchor)).toEqual(['/bbb.ts']);
  });

  it('hands each caller its own array, so one cannot corrupt the next', () => {
    seed(3, (i) => ({ kind: 'read', anchor: `/a${i}.ts`, at: 1000 + i }));

    const first = readMetrics(dir);
    first.length = 0;
    first.push({ kind: 'forged' });

    // Reaching into a shared memo would make this return the forged array.
    expect(readMetrics(dir).map((e) => e.anchor)).toEqual([
      '/a0.ts',
      '/a1.ts',
      '/a2.ts',
    ]);
  });
});

describe('sharing the read did not share the event window', () => {
  it('keeps counting balance events past the window readAll applies', () => {
    // THE REGRESSION THIS GUARDS. readAll windows to MAX_EVENTS (5000);
    // scanForBalance must not. Routing it through readAll once before left the
    // holdout measurement reading zero on 122 real graphs, because the balance
    // records it needed were older than the window.
    //
    // Written against the REAL constant rather than an env override: the window
    // is read once at module load, so lowering it needs a fresh module
    // evaluation that jest's ESM registry does not reliably give. 5,020 short
    // lines cost a few milliseconds, and the test then states the property
    // exactly as production runs it.
    const lines = [];
    // The balance records go FIRST, so the window is guaranteed to cut past them.
    for (let i = 0; i < 10; i++) {
      lines.push(
        JSON.stringify({
          // A REAL member of BALANCE_KINDS. The first draft of this used
          // `holdout-assignment`, which the scan legitimately ignores, so the
          // fixture could not discriminate: it reported zero either way.
          kind: 'inject',
          id: `b${i}`,
          sessionId: `s${i}`,
          at: 1000 + i,
        })
      );
    }
    for (let i = 0; i < 5010; i++) {
      lines.push(
        JSON.stringify({ kind: 'read', anchor: `/r${i}.ts`, at: 2000 + i })
      );
    }
    writeFileSync(metricsFile(), `${lines.join('\n')}\n`);

    // readAll's window really is in force, and it really did cut past the
    // holdout records -- without this the assertion below proves nothing.
    const windowed = readMetrics(dir);
    expect(windowed).toHaveLength(5000);
    expect(windowed.filter((e) => e.kind === 'inject')).toHaveLength(0);

    // And the balance scan still sees every one of them behind that window.
    const balance = readBalance(dir);
    expect(balance.filter((e) => e.kind === 'inject')).toHaveLength(10);
  });
});
