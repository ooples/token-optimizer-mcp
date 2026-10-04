/**
 * THE COST SPLIT, CHECKED ON NUMBERS WHOSE ANSWER IS KNOWN IN ADVANCE.
 *
 * `cost-split.mjs` reads real transcripts, so its output changes every day and
 * cannot be asserted against a constant. What CAN be asserted is the
 * arithmetic: feed it totals whose split is known by construction and check it
 * reports that split. Every case here is synthetic and offline -- no transcript
 * is read, no credential is touched, nothing depends on the day.
 *
 * The case that matters most is `turnsAfter is reads over writes, exactly`.
 * That single division is the one number this rig can hand the cost model in
 * place of a guess, and the guess it replaces -- 20 turns -- is the model's
 * most sensitive parameter. If the division is wrong, the correction is worse
 * than the guess, because it arrives wearing the authority of a measurement.
 */

import { RATES } from '../compression/cost-model.mjs';
import { zeroTotals } from './transcripts.mjs';
import {
  costOf,
  measure,
  sharesOf,
  turnsAfterFrom,
  writeTtlSplit,
} from './cost-split.mjs';

let failures = 0;
const ok = (name, detail = '') => console.log(`ok  ${name}${detail ? ` -- ${detail}` : ''}`);
const bad = (name, detail) => {
  failures++;
  console.log(`FAIL ${name} -- ${detail}`);
};
const check = (cond, name, detail = '') => (cond ? ok(name, detail) : bad(name, detail || 'false'));
const close = (x, y, tol = 1e-9) => Math.abs(x - y) <= tol;

const totals = (o) => ({ ...zeroTotals(), ...o });

// ---------------------------------------------------------------------------
// 1. The conversion to one unit.
// ---------------------------------------------------------------------------

{
  // Chosen so each of the four lands on a round number: input 100, write
  // 100*1.25 + 100*2.0 = 325, read 1000*0.1 = 100, output 100*5 = 500.
  const c = costOf(
    totals({ input: 100, cacheWrite5m: 100, cacheWrite1h: 100, cacheRead: 1000, output: 100 })
  );
  check(
    c.input === 100 && c.write === 325 && c.read === 100 && c.output === 500,
    'each priced quantity converts at its own published rate',
    `in ${c.input}, write ${c.write}, read ${c.read}, out ${c.output}`
  );
}

{
  // A token is a token: one input token and ten cache-read tokens cost the
  // same, which is the whole reason the unit is what it is.
  const a = costOf(totals({ input: 1 }));
  const b = costOf(totals({ cacheRead: 10 }));
  check(a.input === b.read, 'ten cache reads cost one plain input token', `${a.input} vs ${b.read}`);
}

{
  const s = sharesOf(costOf(totals({ input: 250, cacheRead: 2500, output: 50 })));
  // 250 + 250 + 250 = 750, so three equal thirds.
  check(
    close(s.input, 1 / 3) && close(s.read, 1 / 3) && close(s.output, 1 / 3) && s.total === 750,
    'shares are the cost over the total, and sum to one',
    `${(s.input + s.write + s.read + s.output).toFixed(12)}`
  );
}

{
  const s = sharesOf(costOf(totals({})));
  check(
    s.total === 0 && s.read === 0 && s.output === 0,
    'an empty window is all zeroes rather than a division by zero'
  );
}

{
  // The split must not depend on how the report was assembled, so a window
  // summed in one go and the same traffic summed in parts agree.
  const whole = costOf(totals({ input: 30, cacheWrite1h: 40, cacheRead: 500, output: 60 }));
  const parts = [
    costOf(totals({ input: 10, cacheWrite1h: 15, cacheRead: 200, output: 20 })),
    costOf(totals({ input: 20, cacheWrite1h: 25, cacheRead: 300, output: 40 })),
  ];
  const summed = parts.reduce((a, b) => ({
    input: a.input + b.input,
    write: a.write + b.write,
    read: a.read + b.read,
    output: a.output + b.output,
  }));
  check(
    ['input', 'write', 'read', 'output'].every((k) => close(whole[k], summed[k])),
    'splitting the traffic does not change the split'
  );
}

// ---------------------------------------------------------------------------
// 2. turnsAfter -- the number that replaces the model's worst guess.
// ---------------------------------------------------------------------------

{
  const n = turnsAfterFrom(totals({ cacheWrite1h: 1000, cacheRead: 56020 }));
  check(close(n, 56.02), 'turnsAfter is reads over writes, exactly', `${n}`);
}

{
  // Both TTLs are writes. Charging only one of them would inflate the ratio
  // by however much traffic used the other.
  const n = turnsAfterFrom(totals({ cacheWrite5m: 400, cacheWrite1h: 600, cacheRead: 10000 }));
  check(close(n, 10), 'both write TTLs count as writes', `${n}`);
}

{
  check(
    turnsAfterFrom(totals({ cacheRead: 999 })) === null,
    'no writes gives null, not zero and not Infinity',
    'zero writes means the question was never asked'
  );
}

{
  // The property the model relies on: a handed token costs W + R*N, so the
  // measured N must reproduce the measured cost of the traffic it came from.
  const t = totals({ cacheWrite1h: 1000, cacheRead: 56020 });
  const n = turnsAfterFrom(t);
  const c = costOf(t);
  const modelled = 1000 * (RATES.cacheWrite1h + RATES.cacheRead * n);
  check(
    close(modelled, c.write + c.read, 1e-6),
    'the measured turnsAfter reprices its own traffic exactly',
    `model ${modelled.toFixed(2)} vs measured ${(c.write + c.read).toFixed(2)}`
  );
}

{
  // The model's default is 20 and this traffic says otherwise, so the check
  // that matters is that the gap is not an artefact of the arithmetic: at the
  // measured ratio, reads must be the share of write+read that was observed.
  const n = 56.02;
  const readShare = (RATES.cacheRead * n) / (RATES.cacheWrite1h + RATES.cacheRead * n);
  check(
    close(readShare, 0.7369, 5e-4),
    'at 56 reads per write, reads are 73.7% of the cached cost',
    `${(readShare * 100).toFixed(2)}%`
  );
}

// ---------------------------------------------------------------------------
// 3. The write TTL, which decides the write rate.
// ---------------------------------------------------------------------------

{
  const s = writeTtlSplit(totals({ cacheWrite1h: 1000 }));
  check(
    s.oneHourShare === 1 && close(s.blendedRate, RATES.cacheWrite1h),
    'all-1-hour traffic blends to exactly the 1-hour rate',
    `${s.blendedRate}x`
  );
}

{
  const s = writeTtlSplit(totals({ cacheWrite5m: 1000 }));
  check(
    s.oneHourShare === 0 && close(s.blendedRate, RATES.cacheWrite5m),
    'all-5-minute traffic blends to exactly the 5-minute rate',
    `${s.blendedRate}x`
  );
}

{
  const s = writeTtlSplit(totals({ cacheWrite5m: 500, cacheWrite1h: 500 }));
  check(
    close(s.blendedRate, (RATES.cacheWrite5m + RATES.cacheWrite1h) / 2),
    'a half-and-half mix blends to the midpoint',
    `${s.blendedRate}x`
  );
}

{
  const s = writeTtlSplit(totals({}));
  check(s.written === 0 && s.oneHourShare === null, 'no writes gives no TTL claim');
}

// ---------------------------------------------------------------------------
// 4. measure() -- the windows, driven by a synthetic request set.
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-09-25T12:00:00Z');
/** One request, `daysAgo` before NOW, with the given usage. */
const req = (id, daysAgo, u) => [
  id,
  { at: NOW - daysAgo * 864e5, family: 'opus', ...zeroTotals(), ...u },
];

{
  // Every day for 20 days, one request with a fixed 30 reads per write. Every
  // window must therefore report exactly 30, whatever its length.
  const reqs = new Map(
    Array.from({ length: 20 }, (_, i) =>
      req(`r${i}`, i + 0.5, { cacheWrite1h: 100, cacheRead: 3000, output: 10 })
    )
  );
  const r = await measure({ now: NOW, requests: reqs });
  const all = r.windows.filter((w) => w.totals.requests > 0);
  check(
    all.length === 5 && all.every((w) => close(w.turnsAfter, 30)),
    'a constant ratio reads the same at every window length',
    all.map((w) => `${w.days}d:${w.turnsAfter.toFixed(1)}`).join(' ')
  );
  check(r.stable === true, 'constant traffic is reported as settled', `spread ${r.spreadAcrossLongWindows}`);

  // And the windows really are nested: a longer one holds at least as much.
  const counts = r.windows.map((w) => w.totals.requests);
  check(
    counts.every((c, i) => i === 0 || c >= counts[i - 1]),
    'a longer window contains everything a shorter one did',
    counts.join(' <= ')
  );
}

{
  // Traffic whose ratio changed a week ago: the short windows see the new
  // regime, the long ones a blend. `stable` must say so rather than averaging
  // the two into a confident wrong number.
  const reqs = new Map([
    ...Array.from({ length: 6 }, (_, i) => req(`new${i}`, i + 0.5, { cacheWrite1h: 100, cacheRead: 1000 })),
    ...Array.from({ length: 20 }, (_, i) => req(`old${i}`, i + 9.5, { cacheWrite1h: 100, cacheRead: 9000 })),
  ]);
  const r = await measure({ now: NOW, requests: reqs });
  check(
    r.stable === false && r.spreadAcrossLongWindows > 0.15,
    'a regime change is reported as not settled',
    `7d ${r.windows.find((w) => w.days === 7).turnsAfter.toFixed(1)}, ` +
      `30d ${r.windows.find((w) => w.days === 30).turnsAfter.toFixed(1)}, ` +
      `spread ${(r.spreadAcrossLongWindows * 100).toFixed(1)}%`
  );
}

{
  // A request stamped in the future, and one with no timestamp, must not be
  // counted -- `totalsInWindow` excludes both, and the split must not move.
  const base = [req('a', 1, { cacheWrite1h: 100, cacheRead: 2000 })];
  const clean = await measure({ now: NOW, requests: new Map(base) });
  const dirty = await measure({
    now: NOW,
    requests: new Map([
      ...base,
      req('future', -5, { cacheWrite1h: 9999, cacheRead: 0 }),
      ['undated', { at: null, family: 'opus', ...zeroTotals(), cacheWrite1h: 9999 }],
    ]),
  });
  check(
    clean.turnsAfter === dirty.turnsAfter,
    'a future-stamped or undated request changes nothing',
    `${clean.turnsAfter} both ways`
  );
}

{
  const r = await measure({ now: NOW, requests: new Map() });
  check(
    r.turnsAfter === null && r.stable === false,
    'no traffic is not a measurement',
    'null turnsAfter, not settled'
  );
}

console.log(failures === 0 ? '\nall checks pass' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
