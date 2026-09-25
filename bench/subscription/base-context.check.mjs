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
 */

import { zeroTotals } from './transcripts.mjs';
import {
  MIN_SESSIONS,
  baseContextReadiness,
  firstRequestPerSession,
  measureBaseContext,
  prefixTokensOf,
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

console.log(failures === 0 ? '\nall checks pass' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
