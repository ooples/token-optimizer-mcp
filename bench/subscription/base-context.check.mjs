/**
 * THE BASE-CONTEXT MEASUREMENT, CHECKED ON SESSIONS WHOSE ANSWER IS KNOWN.
 *
 * Every case is synthetic and offline: no transcript is read, so a failure
 * means the measurement is wrong and never that this machine's traffic moved.
 *
 * The case that matters most is `a first request billed almost entirely as
 * cache is still measured in full`. On this machine a session's first request
 * reports `input: 2` and carries its whole 65k prefix as cache writes and
 * reads. A measurement that looked at `input` alone would read 2 tokens,
 * conclude the prefix was negligible, and inflate every savings ratio that the
 * constant divides into.
 *
 * AND THEN THE RECORD, which is where the measurement actually reaches the
 * comparator. The number used to be re-measured from local transcripts on every
 * run, so the published cost column was a figure only one laptop could produce
 * and the whole harness exited 2 anywhere else. It is now taken once and
 * committed, which buys reproducibility and creates three new ways to be wrong:
 * a record can be hand-edited or stale, a record is a PUBLIC file built from the
 * operator's own sessions, and a missing record must withhold the cost figures
 * and nothing else. The first two are checked at the bottom of this file; the
 * third is behavioural and is checked where the scorer is, in
 * bench/compression/known-answer/scorer.check.mjs.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { zeroTotals } from './transcripts.mjs';
import {
  BASE_CONTEXT_RECORD,
  BASE_CONTEXT_SCHEMA,
  MIN_SESSIONS,
  baseContextReadiness,
  baseContextRecord,
  baseContextRecordPath,
  firstRequestPerSession,
  measureBaseContext,
  prefixTokensOf,
  readBaseContext,
  writeBaseContextRecord,
} from './base-context.mjs';

let failures = 0;
// CONDITION FIRST, matching cost-split.check.mjs. calibrate.check.mjs takes the
// name first; calling one with the other's order binds the message to `ok`,
// which is always truthy, and every case prints "ok" unevaluated.
const check = (ok, name, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
};

{
  const before = failures;
  const say = console.log;
  console.log = () => {};
  check(false, 'self-test');
  console.log = say;
  const caught = failures === before + 1;
  failures = before;
  if (!caught) {
    console.log('FAIL the check helper cannot detect a failure -- every result below is void');
    process.exit(1);
  }
  console.log('ok   the check helper reports a false condition as a failure');
}

const T0 = Date.parse('2026-09-25T12:00:00Z');
const req = (id, sessionId, minutes, u = {}) => [
  id,
  { at: T0 + minutes * 60000, sessionId, isSidechain: false, ...zeroTotals(), ...u },
];
const mapOf = (...entries) => new Map(entries);

// ---------------------------------------------------------------------------
// 1. Which request is the prefix.
// ---------------------------------------------------------------------------

{
  const reqs = mapOf(
    req('late', 's1', 10, { cacheRead: 999 }),
    req('first', 's1', 0, { cacheRead: 500 }),
    req('mid', 's1', 5, { cacheRead: 700 })
  );
  const first = firstRequestPerSession(reqs);
  check(first.size === 1 && prefixTokensOf(first.get('s1')) === 500, 'the earliest request of a session is the prefix', `${prefixTokensOf(first.get('s1'))}`);
}

{
  // A sub-agent carries its own prefix, not the session's, and there are many
  // of them -- counting them would drag the median toward the sidechain's size.
  const reqs = mapOf(
    ['side', { at: T0 - 60000, sessionId: 's1', isSidechain: true, ...zeroTotals(), cacheRead: 10 }],
    req('real', 's1', 0, { cacheRead: 500 })
  );
  check(prefixTokensOf(firstRequestPerSession(reqs).get('s1')) === 500, 'a sidechain is not the session prefix, even when it is earlier');
}

{
  const reqs = mapOf(
    ['nosession', { at: T0, sessionId: null, ...zeroTotals(), cacheRead: 9999 }],
    ['undated', { at: null, sessionId: 's9', ...zeroTotals(), cacheRead: 9999 }],
    req('real', 's1', 0, { cacheRead: 500 })
  );
  const first = firstRequestPerSession(reqs);
  check(first.size === 1 && first.has('s1'), 'a request with no session or no timestamp is not a prefix', `${first.size}`);
}

// ---------------------------------------------------------------------------
// 2. What counts as a token. This is the case the whole module exists for.
// ---------------------------------------------------------------------------

{
  // THE REAL SHAPE ON THIS MACHINE: input 2, everything else cached. A
  // measurement that read `input` alone would call this a 2-token prefix.
  const r = { input: 2, cacheRead: 40000, cacheWrite5m: 20000, cacheWrite1h: 5063 };
  check(prefixTokensOf(r) === 65065, 'a first request billed almost entirely as cache is still measured in full', `${prefixTokensOf(r)}`);
  check(prefixTokensOf(r) !== r.input, 'and is not the `input` field, which reads 2 here', `${r.input}`);
}

{
  check(prefixTokensOf({}) === 0, 'a request with no usage at all is zero, not NaN');
}

// ---------------------------------------------------------------------------
// 3. The distribution, and the refusal.
// ---------------------------------------------------------------------------

const sessions = (...sizes) =>
  mapOf(...sizes.map((n, i) => req(`r${i}`, `s${i}`, 0, { cacheRead: n })));

{
  const m = measureBaseContext({ requests: sessions(100, 200, 300, 400, 500) });
  check(m.sessions === 5 && m.min === 100 && m.max === 500 && m.p50 === 300, 'the distribution is reported, not just a single number', `p50 ${m.p50}`);
  check(m.spread === (500 - 100) / 300, 'the spread is the range over the median', `${m.spread.toFixed(3)}`);
}

{
  // A mean would be dragged to 2280 by the one resumed session; the median
  // stays where the typical session is.
  const m = measureBaseContext({ requests: sessions(100, 200, 300, 400, 10400) });
  const ready = baseContextReadiness(m);
  check(ready.ready === true && ready.tokens === 300, 'one outsized session does not move the number', `${ready.tokens}`);
}

{
  const m = measureBaseContext({ requests: sessions(100, 200) });
  const ready = baseContextReadiness(m);
  check(ready.ready === false, `fewer than ${MIN_SESSIONS} sessions is not a measurement`);
  check(ready.tokens === null, 'and offers no number to fall back on', `${ready.tokens}`);
}

{
  const ready = baseContextReadiness(measureBaseContext({ requests: new Map() }));
  check(ready.ready === false && ready.tokens === null, 'no traffic refuses, with null rather than zero');
  check(/no session/.test(ready.reason), 'and says why', ready.reason);
}

{
  // A prefix of zero tokens is not a sample -- it is a request whose usage the
  // transcript did not record, and counting it would drag the median down,
  // which is the direction that inflates the savings claim.
  const m = measureBaseContext({ requests: sessions(0, 0, 100, 200, 300, 400, 500) });
  check(m.sessions === 5 && m.p50 === 300, 'a zero-token prefix is dropped, not counted as a small session', `${m.sessions} sessions, p50 ${m.p50}`);
}

// ---------------------------------------------------------------- THE RECORD
// Everything above is the measurement. This is the file it is kept in, which is
// what the comparator actually reads -- and which is committed to a public
// repository, so it has two jobs: be auditable, and carry nothing about whose
// sessions produced it.
console.log('');

{
  const live = readBaseContext({ at: BASE_CONTEXT_RECORD });
  check(
    live.ready,
    'the committed record passes the readiness bar',
    live.ready ? `${live.record.sessions} sessions, ${live.tokens} tokens` : live.reason
  );
  if (live.record) {
    check(
      live.record.schema === BASE_CONTEXT_SCHEMA,
      'and is the schema this reader understands',
      `record ${live.record.schema}, reader ${BASE_CONTEXT_SCHEMA}`
    );
    // THE PUBLISHED PARAMETER IS THE RECORDED MEDIAN. A reader comparing the
    // comparator's banner with this file has to land on the same figure, or the
    // banner is naming a number it did not use.
    check(
      live.tokens === live.record.p50,
      'and the parameter the harness uses is the recorded median',
      `tokens ${live.tokens}, p50 ${live.record.p50}`
    );
    check(
      typeof live.record.recordedAt === 'string' &&
        !Number.isNaN(Date.parse(live.record.recordedAt)) &&
        String(live.record.regenerate).includes('--record'),
      'and says when it was taken and how to take it again',
      `${live.record.recordedAt}, ${live.record.regenerate}`
    );
  }
}

{
  // AGAINST THE RAW BYTES, not the parsed keys: a sample list nested one field
  // deeper would walk straight past a key check, and the case nobody thought of
  // is the whole point of this assertion.
  const raw = readFileSync(BASE_CONTEXT_RECORD, 'utf8');
  for (const [needle, what] of [
    ['samples', 'per-session sample list'],
    ['sessionId', 'session id'],
    ['C:' + String.fromCharCode(92) + 'Users', 'Windows home path'],
    ['/home/', 'POSIX home path'],
    ['/Users/', 'macOS home path'],
  ])
    check(!raw.includes(needle), `the public record carries no ${what}`, `looked for ${needle}`);
  check(
    JSON.parse(raw).environment.transcriptRoot === '~/.claude/projects',
    'and names the transcript root without expanding it',
    JSON.parse(raw).environment.transcriptRoot
  );
  // AND THE WRITER IS WHAT KEEPS IT THAT WAY. The assertions above would go
  // green against a record written before a `samples` field was added back to
  // the builder, so the builder is handed a measurement that HAS samples.
  const measured = measureBaseContext({ requests: sessions(100, 200, 300, 400, 500) });
  const built = baseContextRecord(measured);
  check(
    measured.samples.length === 5 && !('samples' in built),
    'and the builder drops the per-session samples it was given',
    `handed ${measured.samples.length}, recorded [${Object.keys(built).join(',')}]`
  );
}
// THE READER RE-JUDGES, IN BOTH DIRECTIONS. `readiness` inside the file is a
// note from whoever took the measurement; the bar is re-applied to the recorded
// counts, so a record written when MIN_SESSIONS was lower -- or written by hand
// -- does not get to assert that it passes a bar it does not meet. A reader that
// simply refused everything would pass a one-sided check, so the accepting arm
// is here too.
{
  const tmp = mkdtempSync(join(tmpdir(), 'base-context-record-'));
  try {
    const at = join(tmp, 'rec.json');
    /** A record that ASSERTS it is ready. Whether it is, is the reader's call. */
    const claiming = (n) => ({
      schema: BASE_CONTEXT_SCHEMA,
      recordedAt: '2026-01-01T00:00:00.000Z',
      regenerate: 'node bench/subscription/base-context.mjs --record',
      environment: { agent: 'claude-code', transcriptRoot: '~/.claude/projects' },
      toolchain: { node: 'v0.0.0' },
      sessions: n,
      min: 100,
      p01: 100,
      p50: 200,
      p99: 300,
      max: 300,
      spread: 1,
      readiness: { ready: true, reason: 'a note from whoever wrote this file' },
    });

    writeFileSync(at, JSON.stringify(claiming(MIN_SESSIONS - 1)), 'utf8');
    const thin = readBaseContext({ at });
    check(
      thin.ready === false && thin.tokens === null,
      `a record claiming ready on ${MIN_SESSIONS - 1} sessions is refused`,
      thin.reason
    );
    writeFileSync(at, JSON.stringify(claiming(MIN_SESSIONS)), 'utf8');
    const fat = readBaseContext({ at });
    check(
      fat.ready === true && fat.tokens === 200,
      'and the same record at the bar is accepted',
      `tokens ${fat.tokens}`
    );
    writeFileSync(
      at,
      JSON.stringify({ ...claiming(MIN_SESSIONS), readiness: { ready: false, reason: 'no' } }),
      'utf8'
    );
    check(
      readBaseContext({ at }).ready === true,
      'and a passing record that claims NOT ready is still accepted',
      'the recorded counts decide, not the note in the file'
    );

    // EVERY REFUSAL, FIRED RATHER THAN ASSUMED.
    const missing = readBaseContext({ at: join(tmp, 'nope.json') });
    check(
      missing.ready === false && /no base-context record at/.test(missing.reason),
      'a missing record names the path it looked at',
      missing.reason
    );
    writeFileSync(at, 'not json at all', 'utf8');
    check(
      /is not JSON/.test(readBaseContext({ at }).reason),
      'a record that is not JSON is refused as such',
      readBaseContext({ at }).reason
    );
    writeFileSync(
      at,
      JSON.stringify({ ...claiming(MIN_SESSIONS), schema: BASE_CONTEXT_SCHEMA + 1 }),
      'utf8'
    );
    const future = readBaseContext({ at });
    check(
      future.ready === false && /schema/.test(future.reason),
      'a record from a newer schema is refused rather than read anyway',
      future.reason
    );
    const unreadable = readBaseContext({ at: tmp });
    check(
      unreadable.ready === false && /could not be read/.test(unreadable.reason),
      'and an unreadable path is refused with its error code',
      unreadable.reason
    );

    // THE SEAM THE GATES WITHHOLD THROUGH. The scorer's unpriced arm runs in a
    // child process, so it has to be told where the record is NOT; renaming the
    // committed file to arrange that would leave the repository dirty whenever
    // a gate crashed mid-run.
    const before = process.env.BENCH_BASE_CONTEXT_RECORD;
    try {
      process.env.BENCH_BASE_CONTEXT_RECORD = join(tmp, 'absent.json');
      check(
        baseContextRecordPath() === join(tmp, 'absent.json') && !readBaseContext().ready,
        'an overridden record path is honoured by the default reader',
        readBaseContext().reason
      );
      delete process.env.BENCH_BASE_CONTEXT_RECORD;
      check(
        baseContextRecordPath() === BASE_CONTEXT_RECORD && readBaseContext().ready,
        'and without the override it reads the committed record'
      );
    } finally {
      if (before === undefined) delete process.env.BENCH_BASE_CONTEXT_RECORD;
      else process.env.BENCH_BASE_CONTEXT_RECORD = before;
    }

    // AND THE WRITER ROUND-TRIPS. A record nobody can read back would refuse
    // every cost figure the first time it mattered.
    const round = join(tmp, 'results', 'rec.json');
    writeBaseContextRecord(baseContextRecord(claiming(MIN_SESSIONS)), { at: round });
    const back = readBaseContext({ at: round });
    check(
      back.ready === true && back.tokens === 200,
      'a freshly written record reads back ready, results/ created if need be',
      `tokens ${back.tokens}`
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? '\nall checks pass' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
