/**
 * WHERE THE p=0 GAP ACTUALLY IS.
 *
 * The recorded head-to-head says their engine is 917,472 tokens -- $4.59 a
 * session at $5/Mtok -- under our referencing arm when nothing is fetched. That
 * is the one column this work exists to win, and before spending any effort on
 * it the number has to be decomposed: a gap in the payload is attacked by
 * compressing better, a gap in cache accounting is attacked by charging
 * correctly, and a gap in residency is attacked by keeping things in context for
 * fewer turns. They are three different projects and the arithmetic says which
 * one it is.
 *
 * It is `handed`, entirely. At p=0 only `c0` is charged, and with no cached
 * prefix `c0` collapses to `handed * (W + R*N)` -- one constant, 7.6, that both
 * arms satisfy to four significant figures. So the gap is exactly the
 * 120,720-token payload difference and nothing else, which rules out the cache
 * accounting as a cause and leaves residency as the only term large enough to
 * close it without compressing a single additional byte.
 *
 * This file is the standing version of that audit. It fails if the constant
 * moves, if either arm stops satisfying the identity (which would mean a cached
 * prefix appeared, or some other term started contributing), or if the residual
 * on the gap stops being zero.
 */
import { DEFAULTS, costLine } from './cost-model.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORD = join(HERE, 'headroom', 'results', 'head-to-head.json');

let failures = 0;
const ok = (name, detail) => console.log(`ok   ${name} -- ${detail}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`FAIL ${name} -- ${detail}`);
};
const eq = (name, got, want) =>
  got === want ? ok(name, `${got}`) : bad(name, `got ${got}, want ${want}`);

const record = JSON.parse(readFileSync(RECORD, 'utf-8'));
const { cost } = record.totals;
const handed = cost.handedTokens;
const p0 = cost.session.p0;
const num = (value) => Number(String(value).replace(/[^0-9.-]/g, ''));

// --- the constant, read rather than inferred -------------------------------
// Derived by subtraction it would be circular: the identity below would hold by
// construction whatever the record said. `cacheWrite` is 2 and `cacheRead` 0.1
// in DEFAULTS, and `turnsAfter` 56 is the measured session length.
const W = DEFAULTS.cacheWrite;
const R = DEFAULTS.cacheRead;
const N = DEFAULTS.turnsAfter;
const PER_TOKEN = W + R * N;
eq('a token in context costs W + R*N', Number(PER_TOKEN.toFixed(4)), 7.6);
// The residency half is what a shorter lifetime would scale, so its size
// relative to the whole is the ceiling on that approach.
eq(
  'residency is the dominant half of that',
  Number(((R * N) / PER_TOKEN).toFixed(3)),
  0.737
);

// --- p=0 is the handed payload, times that constant ------------------------
for (const arm of ['ours', 'theirs']) {
  const predicted = Math.round(num(handed[arm]) * PER_TOKEN);
  const recorded = num(p0[arm]);
  // Exact, not close. `c0` has no other term when `cachedPrefix` is zero, so a
  // discrepancy means some term this audit does not know about is contributing
  // and the decomposition below cannot be trusted.
  eq(`p0 ${arm} is handed * ${PER_TOKEN.toFixed(1)}`, recorded, predicted);
}

// --- and therefore the gap is the payload difference, with no residual -----
const gap = num(p0.ours) - num(p0.theirs);
const payloadGap = num(handed.ours) - num(handed.theirs);
eq(
  'the p0 gap is the payload gap, times the constant',
  gap,
  Math.round(payloadGap * PER_TOKEN)
);
ok(
  'so no part of the p0 gap is cache accounting',
  `${gap} token(s) = ${payloadGap} payload token(s) * ${PER_TOKEN.toFixed(1)}`
);

// --- what it would take to close it ----------------------------------------
// Two independent routes, both stated as the number they have to reach so that
// neither can be claimed without it.
//
//   by payload:   hand back no more than theirs does
//   by residency: keep a token in context for k turns instead of N
//
// The residency route needs no additional compression at all, which is why it
// is the one the effort leads with.
const neededHanded = Math.floor(num(p0.theirs) / PER_TOKEN);
ok(
  'route 1, by payload',
  `${num(handed.ours)} -> ${neededHanded} handed token(s), a ${(((num(handed.ours) - neededHanded) / num(handed.ours)) * 100).toFixed(1)}% further reduction`
);
const neededLifetime = (num(p0.theirs) / num(handed.ours) - W) / R;
ok(
  'route 2, by residency',
  `average lifetime ${N} -> under ${neededLifetime.toFixed(1)} turn(s), at the same payload`
);

// --- the control arm -------------------------------------------------------
// THE IDENTITY ABOVE MUST BE ABLE TO FAIL. `costLine` with a cached prefix
// produces a number the `handed * constant` form does not predict, so a run
// where every assertion passes is a fact about the record and not about an
// identity that holds for any input.
const params = {
  ...DEFAULTS,
  baseContextTokens: num(record.totals.cost.session.baseContextTokens),
};
const plain = costLine({ handed: 1000, params }).c0;
const prefixed = costLine({ handed: 1000, cachedPrefix: 1000, params }).c0;
eq('a payload with no cached prefix matches the form', plain, 1000 * PER_TOKEN);
if (prefixed === plain)
  bad(
    'a cached prefix changes the answer',
    'it does not, so the identity cannot discriminate'
  );
else
  ok(
    'a cached prefix changes the answer',
    `${plain} -> ${prefixed}, so p0 matching the form means cachedPrefix is 0`
  );

console.log(
  failures === 0
    ? '\nthe p=0 gap is the handed payload, with no residual'
    : `\n${failures} assertion(s) failed`
);
process.exitCode = failures === 0 ? 0 : 1;
