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
import { brotliCompressSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
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

// --- and WHERE in the payload it is: per-unit verbosity -------------------
// NOT THE MARKER SYNTAX, which was the first guess and was wrong. Re-encoding
// `[... 400 lines -> src/a.ts:12-400]` to its tightest collision-safe form
// saves 2 tokens of 17, so closing a 120,720-token gap that way would need some
// 60,000 markers -- far more than the payload holds, for a decoder-visible
// format change.
//
// The record says where it actually is. We keep FEWER units in context than
// they do and still hand back more tokens, so each unit we keep is far more
// verbose. Match their per-unit size at our own unit count and we land under
// their whole payload, with no change to what we drop, no extra round trip and
// no decoder risk.
const ret = record.totals.retention;
const unitsOurs = num(ret.inContext.ours);
const unitsTheirs = num(ret.inContext.theirs);
const perUnitOurs = num(handed.ours) / unitsOurs;
const perUnitTheirs = num(handed.theirs) / unitsTheirs;
if (!(unitsOurs < unitsTheirs))
  bad(
    'we keep fewer units in context than they do',
    `${unitsOurs} is not fewer than ${unitsTheirs}, so the verbosity reading below does not follow`
  );
else
  ok(
    'we keep fewer units in context than they do',
    `${unitsOurs} against ${unitsTheirs}`
  );
eq(
  'yet each unit we keep is heavier',
  Number((perUnitOurs / perUnitTheirs).toFixed(2)),
  1.7
);
// AND WHY THEIR UNITS ARE SMALL, WHICH THE RATIO ALONE DOES NOT SAY. Ranked by
// where they beat us, the gap is entirely bulk machine output:
// codebase-exploration 14.2% against their 99.6%, raw-build-log 47.7% against
// 99.8%, then search-results, grep-output, sre-debugging, database-rows,
// log-entries, api-responses. A 99.8% reduction on a build log is not a compact
// rendering, it is the log withheld behind a handle -- their deferral arm, free
// at p=0 only because nothing is fetched.
//
// So "match their per-unit size" must NOT be read as "defer what they defer":
// that is the 18 round trips this work exists to avoid. The honest route is that
// repetitive machine output is reconstructible to a few percent with no fetch at
// all -- a template plus its parameters -- and we are leaving most of that on
// the table on exactly the nine workloads where they look unbeatable.
const bulk = Object.values(record.workloads)
  .map((w) => ({
    name: w.name,
    ours: num((w.tokens || {}).ours),
    theirs: num((w.tokens || {}).theirs),
  }))
  .filter((w) => w.theirs - w.ours > 25);
if (bulk.length === 0)
  bad(
    'the gap is concentrated, not spread',
    'no workload is more than 25 points behind, so there is no concentration to attack'
  );
else
  ok(
    'the gap is concentrated in bulk machine output',
    `${bulk.length} workload(s) more than 25 points behind, worst ${bulk.sort((a, b) => b.theirs - b.ours - (a.theirs - a.ours))[0].name}`
  );

ok(
  'route 3, by per-unit size',
  `${perUnitOurs.toFixed(1)} -> ${perUnitTheirs.toFixed(1)} tokens per unit puts us at ${Math.round(unitsOurs * perUnitTheirs)}, under their ${num(handed.theirs)}`
);
ok(
  'which at p=0 would read',
  `${Math.round(unitsOurs * perUnitTheirs * PER_TOKEN)} against their ${num(p0.theirs)}`
);

// --- is 14.2% a tuning miss, or a missing capability? ---------------------
// A MISSING CAPABILITY, and the headroom is measured rather than assumed.
// Generic brotli -- no semantic understanding of code at all -- takes the
// corpus entries down by 74.6% to 87.2%, where our worst workload manages
// 14.2%. The redundancy is demonstrably there and we are not taking it.
//
// Brotli itself is not the fix: its output is binary and a prompt has to be
// text the model can read. But its ratio is a legitimate BOUND on how much
// redundancy a text-expressible encoding -- a template plus its parameters, a
// run-length back-reference, a shared session dictionary -- could reach. And
// every one of those is lossless and needs no fetch, which is exactly what this
// arm promises and what their deferral cannot claim.
// ON THE FIXTURES THAT ACTUALLY LOSE, which the first version of this did not
// do: it measured `corpus.snapshot.json` -- our own generated sources -- and
// compared the ratio against a workload whose input it had never looked at.
// These are the eighteen the comparison is run over, so the headroom is the
// headroom on the contested rows and not on something else.
//
// It is not gzip's ratio that is remarkable, it is who it beats. On
// sre-debugging brotli reaches 95.1% where their DEFERRAL arm reaches 90.5%,
// and on search-results 93.0% against their 96.2%. A lossless encoding can
// therefore beat, or very nearly beat, an engine that withholds the content
// outright -- while needing none of the 18 round trips that buys them.
const natives = join(HERE, '..', '..', 'hr-corpus', 'natives-18.json');
if (!existsSync(natives)) {
  ok(
    'their fixture corpus is not vendored here',
    'skipping the redundancy bound; run with hr-corpus present to measure it'
  );
}
const entries = existsSync(natives)
  ? JSON.parse(readFileSync(natives, 'utf-8'))
  : [];
const list = Array.isArray(entries)
  ? entries
  : Object.entries(entries).map(([name, value]) => ({
      name,
      ...(typeof value === 'object' ? value : { text: value }),
    }));
const ratios = list.map((entry) => {
  const text = String(
    entry.text ?? entry.content ?? entry.payload ?? JSON.stringify(entry)
  );
  const bytes = Buffer.from(text, 'utf8');
  return 1 - brotliCompressSync(bytes).length / bytes.length;
});
const floor = ratios.length ? Math.min(...ratios) : 1;
// THE WORST WORKLOAD WHERE THEY BEAT US, not the worst overall. One workload
// reads 0.2% for both arms -- content neither engine can compress, so it is no
// evidence about headroom either way, and comparing brotli against it would
// claim a gap that is really just incompressible input.
const worst = Object.values(record.workloads)
  .map((w) => ({
    ours: num((w.tokens || {}).ours),
    theirs: num((w.tokens || {}).theirs),
  }))
  .filter((w) => w.theirs > w.ours)
  .sort((a, b) => a.ours - b.ours)[0].ours;
if (!(floor > worst / 100))
  bad(
    'generic lossless compression beats our worst workload',
    `brotli floor ${(floor * 100).toFixed(1)}% is not above our ${worst}%, so there is no measured headroom to claim`
  );
else
  ok(
    'generic lossless compression beats our worst workload',
    `brotli reaches ${(floor * 100).toFixed(1)}%-${(Math.max(...ratios) * 100).toFixed(1)}% where we manage ${worst}%`
  );

// --- and the headroom is INSIDE a block, not across blocks ---------------
// WHICH RULES OUT THE OBVIOUS SUSPECT. The worst fixture is three messages --
// 36,518 chars, 89, then 101,206 -- and two large user turns that each re-read
// source invite the reading that the second repeats the first, which a
// per-block compressor structurally cannot see.
//
// It does not. Compressed separately the three come to 24,512 bytes; compressed
// together, 24,042 -- so only 1.9% of the redundancy is cross-message. Each
// message is individually 75.8% and 84.6% compressible. The headroom is intra
// block, which is exactly what `compressBlock` already has the scope to take,
// and it is taking 14.2% of an available 82.6%.
//
// So this is not a missing cross-block pass, and widening the dedup scope would
// buy 1.9%. It is the single-block compressor being weak on bulk machine
// output, which is the narrowest and most actionable form this finding can take.
if (ratios.length) {
  const worstFixture = list.find((e) => e.name === 'codebase-exploration');
  const parts = worstFixture
    ? Object.keys(worstFixture)
        .filter((k) => /^[0-9]+$/.test(k))
        .map((k) => worstFixture[k])
        .map((m) =>
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        )
    : [];
  if (parts.length < 2)
    bad(
      'the worst fixture has parts to compare',
      `found ${parts.length}, so cross-block redundancy cannot be measured and the intra-block reading does not follow`
    );
  else {
    const size = (text) => brotliCompressSync(Buffer.from(text, 'utf8')).length;
    const apart = parts.reduce((sum, part) => sum + size(part), 0);
    const together = size(parts.join(String.fromCharCode(10)));
    const across = 1 - together / apart;
    eq(
      'cross-block redundancy is negligible',
      Number((across * 100).toFixed(1)) < 5,
      true
    );
    ok(
      'so the headroom is inside a block',
      `${(across * 100).toFixed(1)}% across ${parts.length} parts, where the whole fixture is ${(ratios[list.indexOf(worstFixture)] * 100).toFixed(1)}% compressible`
    );
  }
}

// --- route 4: the capability exists, on the OTHER SURFACE -----------------
// AND IT IS NOT A SELECTOR BUG, which is how this first read. The `body`
// reading beside `ours` is not a rival strategy the selector could have picked:
// it is the PROXY arm, which rewrites the whole outgoing request body, where
// `ours` is the referencing arm operating on tool replies
// (head-to-head.mjs:1189 and the note at :1486). They are two deployment
// surfaces, not two options at one decision point, so "pick the better arm" is
// not a flag flip -- it means routing through a proxy that has to be running
// and configured, and the arm carries a ~15-token envelope the others do not.
//
// What it does establish is that the COMPRESSION is not the missing piece. On 7
// of 18 workloads the proxy arm takes a mean 28 points more than the referencing
// arm off the same bytes: agentic-conversation 25.1% against 70.5%,
// sre-debugging 49.3% against 86.6%, codebase-exploration 14.2% against 42.7%.
// The worst fixture in the comparison is one where our own code already produces
// a 3x better answer somewhere else in the system.
//
// Weighted by payload and scaled so the referencing sum reproduces the recorded
// handed total, the better-of-the-two per workload is about 350,016 against
// 442,276 -- 76% of the 120,720-token gap. It would still not finish: p=0 would
// read about 2,660,000 against their 2,443,826, and the rest has to come from
// the intra-block headroom where 82.6% is available and 14.2% is taken.
//
// This is an ESTIMATE, not a measurement. It reuses per-workload percentages
// rather than re-running with either surface changed, and the two were measured
// independently rather than composed -- a payload cannot be rewritten twice and
// have both savings. It ranks the work; nothing is published off it.
if (ratios.length || true) {
  const armed = Object.values(record.workloads)
    .map((w) => ({
      name: w.name,
      payload: num(w.payload),
      ours: num((w.tokens || {}).ours),
      body:
        (w.tokens || {}).body === undefined
          ? num((w.tokens || {}).ours)
          : num(w.tokens.body),
    }))
    .filter((w) => Number.isFinite(w.ours));
  const beaten = armed.filter((w) => w.body > w.ours + 0.5);
  if (beaten.length === 0)
    bad(
      'the proxy arm sometimes beats the referencing arm',
      'it never does, so there is no headroom to borrow from it'
    );
  else
    ok(
      'the proxy arm beats the referencing arm on the same bytes',
      `on ${beaten.length} of ${armed.length} workload(s), mean ${(beaten.reduce((sum, w) => sum + (w.body - w.ours), 0) / beaten.length).toFixed(1)} points left behind, worst ${beaten.sort((a, b) => b.body - b.ours - (a.body - a.ours))[0].name}`
    );
  const held = (pick) =>
    armed.reduce((sum, w) => sum + w.payload * (1 - pick(w) / 100), 0);
  const scale = num(handed.ours) / held((w) => w.ours);
  const bestOf = Math.round(held((w) => Math.max(w.ours, w.body)) * scale);
  ok(
    'route 4, by bringing that compression to the referencing arm',
    `${num(handed.ours)} -> about ${bestOf} handed, ${(((num(handed.ours) - bestOf) / (num(handed.ours) - num(handed.theirs))) * 100).toFixed(0)}% of the gap, estimated not measured`
  );
}

// --- the cost model erases our one structural advantage -----------------
// `cachedPrefix` IS ZERO FOR EVERY ARM, which the identity at the top of this
// file proves rather than assumes: both totals are `handed * 7.6` exactly, and
// a cached token costs `R*(N+1)` = 5.7 instead. So the model charges all three
// arms as if the provider never caches anything.
//
// That is not neutral between them. The referencing arm APPENDS -- a tool reply
// lands at the end of the transcript and the prefix before it is untouched --
// so a real cached prefix survives it. The proxy arm cannot: head-to-head.mjs
// at :735 records that its output shares exactly 57 characters with its input
// on every row that compresses, the `{"model":...,"messages":` envelope and
// nothing more, because it rebuilds the request with `JSON.stringify`. In the
// harness's own words, it "can leave a prefix alone in every sense that matters
// and still destroy the cache hit on the way out". Their deferral arm rewrites
// context too, by withholding from it.
//
// Crediting a prefix that genuinely survives is therefore worth, at the limit,
// the difference between the two rates on our whole payload -- and it is not
// flattering ourselves, it is what the provider bills. It must be MEASURED
// though, not assumed: the credit is only for the prefix that is byte-identical
// turn to turn, which is what :735 measures for the proxy arm and what nothing
// yet measures for ours.
const cachedRate = R * (N + 1);
const atCachedRate = Math.round(num(handed.ours) * cachedRate);
if (!(cachedRate < PER_TOKEN))
  bad(
    'a cached token is cheaper than a fresh one',
    `${cachedRate} is not below ${PER_TOKEN}, so there is nothing to win by preserving a prefix`
  );
else
  ok(
    'a cached token is cheaper than a fresh one',
    `${cachedRate} against ${PER_TOKEN.toFixed(1)}, a ${(((PER_TOKEN - cachedRate) / PER_TOKEN) * 100).toFixed(0)}% discount the model gives nobody`
  );
ok(
  'route 2, revived: credit the prefix that really survives',
  `at the cached rate our payload reads ${atCachedRate} against their ${num(p0.theirs)}, an upper bound of ${num(p0.ours) - atCachedRate} token(s) -- claimable only for the prefix measured byte-identical`
);

// --- the fetch term is a READ, and that is correct ------------------------
// SETTLED BY OBSERVATION, HAVING FIRST BEEN ASSERTED WRONGLY. The claim was
// that `cost-model.mjs` undercharges a fetch by pricing cache invalidation as a
// read, and that correcting it would hand us p=1 on arithmetic. It would -- if
// expansion were SPLICED back into the position the marker occupies, which
// invalidates every cached token after it and costs W on the whole suffix.
//
// Neither engine splices. Ours returns expanded content from the `expand` tool,
// so it arrives as a new tool result at the END of the transcript. Theirs
// exposes `retrieve()` (headroom/cache/compression_store.py:435), which its
// caller invokes the same way. Appending invalidates nothing, so one extra
// request re-reading the prefix is exactly what happens and `(R/b) * (B +
// handed)` is exactly what it costs.
//
// So p=1 is NOT ours on arithmetic and needs engineering. This assertion is the
// standing version of that: it fails if the fetch term is ever re-rated as a
// write, which would need a splicing engine to justify it.
const fetchTerm = costLine({ handed: 1000, blocks: [500], params });
const perFetchShare =
  (DEFAULTS.cacheRead / DEFAULTS.fetchBatch) *
  (num(record.totals.cost.session.baseContextTokens) + 1000);
const residency = 500 * (W + R * Math.max(0, N - N / 2));
eq(
  'a fetched block pays a read for the prefix, not a write',
  Math.round(fetchTerm.c1),
  Math.round(
    DEFAULTS.fetchCallTokens * DEFAULTS.outputPerInput +
      residency +
      perFetchShare
  )
);
ok(
  'because both engines append rather than splice',
  'ours via the expand tool, theirs via compression_store.retrieve'
);

// --- AND THE WHOLE COLUMN IS IN THE WRONG CURRENCY -----------------------
// THIS SUPERSEDES EVERY ROUTE ABOVE. head-to-head.mjs pins
// `ENCODING_NAME = 'cl100k_base'` at :303 and counts with it at :332, and the
// line it publishes at :1724 says so outright. cl100k_base is OpenAI's
// tokenizer. Nothing in this comparison is billed by OpenAI, and the claim the
// numbers support is about what a CLAUDE subscription spends -- for which the
// only authority is Anthropic's `count_tokens`, which `currency.mjs` already
// serves from a recorded fixture so CI stays offline.
//
// The tools bench was moved onto that currency and eleven of its published
// ranges moved with it. I then wrote that the compression bench had been moved
// first and was the reason to move the tools bench; that was wrong. It has not
// been moved.
//
// The two encodings do not differ by a constant -- they split code and
// punctuation differently -- so a ratio taken under one is not preserved under
// the other. Every token figure in the recorded head-to-head is therefore
// provisional: ours 44.4%, theirs 59.6%, handed 442,276 against 321,556, the
// 917,472-token gap and the $4.59 that follows from it. The gap could be
// larger, smaller, or the other way round, and no route above can be scored
// until the currency is right.
//
// Deliberately a FAILURE rather than a note. A target measured in the wrong
// unit is worse than no target, and this one has been quoted in a pull request
// description as the thing to beat.
const recordedEncoding = record.harness?.encoding ?? 'cl100k_base';
if (/cl100k|o200k|tiktoken/i.test(String(recordedEncoding)))
  bad(
    'the comparison is denominated in Anthropic count_tokens',
    `it is '${recordedEncoding}', an OpenAI encoding, so every token figure here is provisional -- see head-to-head.mjs:303`
  );
else
  ok(
    'the comparison is denominated in Anthropic count_tokens',
    String(recordedEncoding)
  );

console.log(
  failures === 0
    ? '\nthe p=0 gap is the handed payload, with no residual'
    : `\n${failures} assertion(s) failed`
);
process.exitCode = failures === 0 ? 0 : 1;
