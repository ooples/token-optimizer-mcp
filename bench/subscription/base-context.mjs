/**
 * HOW MUCH CONTEXT EVERY TURN CARRIES BEFORE THE PAYLOAD, MEASURED.
 *
 * `cost-model.mjs` adds `baseContextTokens` to every turn for every arm: the
 * system prompt, the tool schemas and the conversation so far. It shipped as a
 * hardcoded 12000, which is a guess, and it is not a harmless one -- the same
 * constant sits in the numerator and the denominator of every savings ratio.
 *
 * WHICH WAY THE GUESS MOVES THE CLAIM. The constant is added to both the
 * compressed and uncompressed side, so a LARGER base pushes the ratio toward 1
 * and a SMALLER base pushes it away. Understating base context therefore
 * inflates every savings figure we publish. A guess is not neutral here; it is
 * a thumb, and 12000 turns out to be 4.5-6x under what this machine actually
 * carries.
 *
 * HOW IT IS READ OFF THE TRANSCRIPTS. Every session's FIRST request is the one
 * that has no prior conversation in it, so what the model read on that request
 * is the prefix: system prompt, tool schemas, and the first user turn. All four
 * priced quantities count, because a token costs whether it arrived as input,
 * as a cache write or as a cache read -- on this machine the first request of a
 * session reports `input: 2`, meaning essentially the whole prefix arrived as
 * cached content and a measurement that looked only at `input` would read zero.
 *
 * WHAT IT OVERSTATES, AND WHY THAT IS THE SAFE DIRECTION. The first user turn
 * is included and is not really "base" context. That makes this an upper bound
 * on the fixed overhead, and an upper bound pushes the savings claim DOWN. The
 * error therefore runs against us, which is the only direction a benchmark of
 * our own product may round in.
 *
 * IT IS ENVIRONMENT-SPECIFIC AND NOT PORTABLE. This machine loads roughly 80
 * MCP tools; another will differ by tens of thousands of tokens. That is why
 * the number is measured per environment and why `baseContextReadiness` refuses
 * rather than falling back to a default.
 *
 * It spends no quota: every input is a local transcript file.
 */

import { pathToFileURL } from 'node:url';

import { loadRequests } from './transcripts.mjs';

/** Sessions needed before a spread across them means anything. */
export const MIN_SESSIONS = 5;

/** Everything the model read on one request, however it was billed. */
export const prefixTokensOf = (r) =>
  (r.input ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite5m ?? 0) + (r.cacheWrite1h ?? 0);

/** The earliest-stamped request of each session. */
export function firstRequestPerSession(requests) {
  const first = new Map();
  for (const r of requests.values()) {
    if (!r.sessionId || typeof r.at !== 'number' || !Number.isFinite(r.at)) continue;
    // A sidechain is a sub-agent with its own prefix, not the session's.
    if (r.isSidechain) continue;
    const held = first.get(r.sessionId);
    if (!held || r.at < held.at) first.set(r.sessionId, r);
  }
  return first;
}

const quantile = (sorted, q) =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/**
 * The prefix every session started with, as a distribution.
 *
 * A distribution and not a mean: the number is used as a constant in a ratio,
 * and a caller that cannot see the spread cannot tell a settled environment
 * from one whose sessions differ by a factor of two.
 */
export function measureBaseContext({ requests }) {
  const first = firstRequestPerSession(requests);
  const samples = [...first.values()]
    .map((r) => ({ sessionId: r.sessionId, at: r.at, tokens: prefixTokensOf(r), input: r.input ?? 0 }))
    .filter((s) => s.tokens > 0);
  const sorted = samples.map((s) => s.tokens).sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  return {
    sessions: samples.length,
    min: sorted[0] ?? null,
    p01: quantile(sorted, 0.01),
    p50: median,
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? null,
    // The spread across sessions, as a fraction of the median. A caller reads
    // this to decide whether one constant describes this environment at all.
    spread: median ? (sorted[sorted.length - 1] - sorted[0]) / median : null,
    samples,
  };
}

/**
 * Whether this environment has been measured well enough to quote a cost claim.
 *
 * Mirrors `weeklyClaimReadiness` in calibrate.mjs, and for the same reason: a
 * claim that rests on an unmeasured parameter should refuse to print rather
 * than print with a default that nobody can audit.
 */
export function baseContextReadiness(measured) {
  if (!measured || measured.sessions === 0)
    return { ready: false, reason: 'no session has a first request with a measurable prefix', tokens: null };
  if (measured.sessions < MIN_SESSIONS)
    return {
      ready: false,
      reason: `only ${measured.sessions} session(s) measured, ${MIN_SESSIONS} needed before a spread means anything`,
      tokens: null,
    };
  return {
    ready: true,
    reason: `${measured.sessions} sessions, median ${measured.p50} tokens, spread ${(measured.spread * 100).toFixed(0)}% of the median`,
    // THE MEDIAN, NOT THE MEAN. One outsized session -- a resumed conversation,
    // a session that loaded an extra server -- drags a mean and does not move a
    // median, and this constant is meant to describe the typical session.
    tokens: measured.p50,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { requests } = await loadRequests();
  const m = measureBaseContext({ requests });
  const ready = baseContextReadiness(m);
  console.log(`base context, measured over ${m.sessions} sessions' first request\n`);
  console.log(`  min ${m.min}   p01 ${m.p01}   p50 ${m.p50}   p99 ${m.p99}   max ${m.max}`);
  console.log(`  spread ${m.spread === null ? 'n/a' : `${(m.spread * 100).toFixed(0)}% of the median`}`);
  console.log(`\n${ready.ready ? 'READY' : 'NOT READY'}: ${ready.reason}`);
  if (ready.ready) console.log(`\nbaseContextTokens: ${ready.tokens}`);
}
