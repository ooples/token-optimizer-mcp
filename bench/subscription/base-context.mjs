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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadRequests } from './transcripts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * WHERE THE MEASUREMENT IS KEPT, so that reading it is not the same act as
 * taking it.
 *
 * The number is a property of an environment and the measurement is only
 * possible inside one: it is read off local agent transcripts, which a CI
 * runner does not have and a second developer has different ones of. Taken
 * afresh on every run, as it was, the cost column of the comparator was a
 * function of whose laptop produced it -- nobody could reproduce the table,
 * and on a machine with no transcripts at all the harness refused outright and
 * took every unrelated instrument down with it.
 *
 * So the measurement is taken once, deliberately, and recorded with enough
 * provenance to be argued with. Re-measuring somewhere else writes a different
 * record, which is a visible diff rather than a silent change of parameter.
 */
export const BASE_CONTEXT_RECORD = join(HERE, 'results', 'base-context.json');

/** The schema version of the record, bumped when a reader must change too. */
export const BASE_CONTEXT_SCHEMA = 1;

/**
 * Where to read the record from, which is the committed one unless a gate says
 * otherwise.
 *
 * A TEST SEAM, and the seam a fork needs anyway. The gates have to exercise the
 * unrecorded path -- a harness that withholds its cost figures instead of dying
 * is a claim about behaviour, and the only honest way to check it is to run with
 * no record present. Renaming the committed file to do that would leave the
 * repository dirty every time a gate crashed mid-run. Overriding the path
 * cannot forge a figure that the record itself does not carry provenance for.
 */
export function baseContextRecordPath() {
  return process.env.BENCH_BASE_CONTEXT_RECORD || BASE_CONTEXT_RECORD;
}

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

/**
 * The measurement, as a record a reader can audit.
 *
 * AGGREGATES ONLY. The distribution is built from per-session samples carrying
 * a session id and a timestamp, and those describe the operator's own work --
 * they do not go in a file that is committed to a public repository. What a
 * reader needs is the shape of the distribution and how many sessions produced
 * it, both of which are counts.
 */
export function baseContextRecord(measured, { now = () => new Date() } = {}) {
  const ready = baseContextReadiness(measured);
  return {
    schema: BASE_CONTEXT_SCHEMA,
    recordedAt: now().toISOString(),
    regenerate: 'node bench/subscription/base-context.mjs --record',
    // WHOSE ENVIRONMENT. Not a path: the home directory of whoever ran it is
    // not a fact about the measurement, and this file is public.
    environment: { agent: 'claude-code', transcriptRoot: '~/.claude/projects' },
    toolchain: { node: process.version },
    sessions: measured.sessions,
    min: measured.min,
    p01: measured.p01,
    p50: measured.p50,
    p99: measured.p99,
    max: measured.max,
    spread: measured.spread,
    readiness: { ready: ready.ready, reason: ready.reason },
  };
}

/**
 * The recorded measurement, re-judged rather than trusted.
 *
 * `readiness.ready` in the file is a note from whoever took the measurement.
 * The bar is re-applied to the recorded counts here, so a record written when
 * MIN_SESSIONS was lower -- or written by hand -- does not get to assert that
 * it passes a bar it does not meet.
 */
export function readBaseContext({
  at = baseContextRecordPath(),
  read = readFileSync,
} = {}) {
  let raw;
  try {
    raw = read(at, 'utf8');
  } catch (error) {
    return {
      record: null,
      ready: false,
      reason:
        error && error.code === 'ENOENT'
          ? `no base-context record at ${at}`
          : `base-context record at ${at} could not be read (${error && error.code})`,
      tokens: null,
    };
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return {
      record: null,
      ready: false,
      reason: `base-context record at ${at} is not JSON`,
      tokens: null,
    };
  }
  if (record.schema !== BASE_CONTEXT_SCHEMA)
    return {
      record,
      ready: false,
      reason:
        `base-context record is schema ${record.schema}, this reader ` +
        `understands ${BASE_CONTEXT_SCHEMA}`,
      tokens: null,
    };
  const judged = baseContextReadiness({
    sessions: record.sessions,
    p50: record.p50,
    spread: record.spread,
  });
  return {
    record,
    ready: judged.ready,
    reason: judged.reason,
    tokens: judged.tokens,
  };
}

/** Write the record, creating `results/` if this is the first one. */
export function writeBaseContextRecord(
  record,
  { at = baseContextRecordPath() } = {}
) {
  mkdirSync(dirname(at), { recursive: true });
  writeFileSync(at, `${JSON.stringify(record, null, 2)}
`, 'utf8');
  return at;
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

  // RECORDING IS AN EXPLICIT ACT. Reading the distribution is free and says
  // nothing about the comparator; writing the file changes the parameter every
  // cost figure in the table is computed with, so it happens only when asked.
  if (process.argv.includes('--record')) {
    if (!ready.ready) {
      console.error(`\nREFUSED to record: ${ready.reason}`);
      process.exit(2);
    }
    const at = writeBaseContextRecord(baseContextRecord(m));
    console.log(`\nrecorded to ${at}`);
  }
}
