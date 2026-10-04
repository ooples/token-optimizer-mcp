/**
 * WHERE THE BILL ACTUALLY GOES, AND THE ONE MODEL PARAMETER THAT CAN BE READ
 * OFF IT RATHER THAN GUESSED.
 *
 * `cost-model.mjs` prices a workload in effective input tokens using three
 * published ratios and two guesses about how a session is used. The ratios are
 * fixed. The guesses are `turnsAfter` -- how many turns follow a payload, over
 * which its cached prefix is re-read -- and `baseContextTokens`. Of those,
 * `turnsAfter` is the one that dominates, because it multiplies the cache-read
 * rate, and cache reads turn out to be most of the bill.
 *
 * This file measures both the split and `turnsAfter` from real traffic.
 *
 * HOW `turnsAfter` IS DERIVED, AND WHY IT IS THE SAME QUANTITY THE MODEL MEANS.
 * The model says a handed payload of S tokens costs `S*W` to write into the
 * cache once and `S*R` on each of N following turns that re-read it. So N is
 * reads divided by writes, per token. Summed over all traffic that is exactly
 * `cacheRead / (cacheWrite5m + cacheWrite1h)` -- the number of times an average
 * cached token is re-read before it stops being read. No modelling, no fit: one
 * division over numbers the API itself reports.
 *
 * THREE THINGS THAT WOULD MAKE THAT DIVISION WRONG, AND WHAT EACH DOES TO IT.
 *
 *  - EDGE EFFECTS. Writes near the end of the window have not yet accrued their
 *    reads, and reads near the start belong to writes from before it. Both
 *    shrink with a longer window, so `measure` reports the ratio at several
 *    window lengths and a caller can see whether it has settled. A number that
 *    moves with the window has not.
 *
 *  - RE-WRITES AFTER EXPIRY. A token that falls out of the cache and is written
 *    again counts as two writes, which LOWERS the ratio. That is not an error
 *    to correct: the model charges a write for every write, so reads-per-write
 *    is precisely the cost-relevant quantity even when a token was written
 *    twice. It is the wrong number only if you read it as "how many turns a
 *    token survives", which is a different question.
 *
 *  - TRAFFIC THAT IS NOT AGENT TRAFFIC. A one-shot request with a huge prompt
 *    and no follow-up contributes a write and no reads. This is measured over
 *    whatever the transcripts hold, so it describes THIS user's mix and is
 *    reported per model family rather than as one universal constant.
 *
 * It spends no quota: every input is a local transcript file.
 */

import { pathToFileURL } from 'node:url';

import { RATES } from '../compression/cost-model.mjs';
import { loadRequests, totalsInWindow, zeroTotals } from './transcripts.mjs';

/** The five priced quantities, converted to one common unit. */
export function costOf(totals, rates = RATES) {
  const t = { ...zeroTotals(), ...totals };
  return {
    input: t.input,
    write: t.cacheWrite5m * rates.cacheWrite5m + t.cacheWrite1h * rates.cacheWrite1h,
    read: t.cacheRead * rates.cacheRead,
    output: t.output * rates.outputPerInput,
  };
}

/** The same four, as shares of the total. An empty window is all zeroes. */
export function sharesOf(cost) {
  const total = cost.input + cost.write + cost.read + cost.output;
  if (total === 0) return { input: 0, write: 0, read: 0, output: 0, total: 0 };
  return {
    input: cost.input / total,
    write: cost.write / total,
    read: cost.read / total,
    output: cost.output / total,
    total,
  };
}

/**
 * Reads per written token -- the model's `turnsAfter`, measured.
 *
 * Returns null rather than a number when nothing was written, because zero
 * writes means the question was not asked, not that the answer is zero.
 */
export function turnsAfterFrom(totals) {
  const written = totals.cacheWrite5m + totals.cacheWrite1h;
  if (written === 0) return null;
  return totals.cacheRead / written;
}

/** What fraction of writes took the 1-hour TTL, which bills at 2.0 not 1.25. */
export function writeTtlSplit(totals) {
  const written = totals.cacheWrite5m + totals.cacheWrite1h;
  if (written === 0) return { written: 0, oneHourShare: null, blendedRate: null };
  const oneHourShare = totals.cacheWrite1h / written;
  return {
    written,
    oneHourShare,
    blendedRate:
      (totals.cacheWrite5m * RATES.cacheWrite5m + totals.cacheWrite1h * RATES.cacheWrite1h) / written,
  };
}

export const WINDOW_DAYS = Object.freeze([1, 3, 7, 14, 30]);

/**
 * Measure the split, `turnsAfter` and the TTL mix over several window lengths.
 *
 * The several windows are the point. One number from one window is a claim
 * nobody can check; the same number from five nested windows either settles or
 * visibly does not, and `stable` says which.
 */
export async function measure({ now = Date.now(), windowDays = WINDOW_DAYS, requests = null } = {}) {
  const loaded = requests ?? (await loadRequests()).requests;
  const windows = [];
  for (const days of windowDays) {
    const { all, byFamily } = totalsInWindow(loaded, now - days * 864e5, now);
    windows.push({
      days,
      totals: all,
      cost: costOf(all),
      shares: sharesOf(costOf(all)),
      turnsAfter: turnsAfterFrom(all),
      ttl: writeTtlSplit(all),
      byFamily: Object.fromEntries(
        Object.entries(byFamily).map(([f, t]) => [
          f,
          { totals: t, shares: sharesOf(costOf(t)), turnsAfter: turnsAfterFrom(t) },
        ])
      ),
    });
  }

  // "Settled" means the longest windows agree with each other, not that every
  // window agrees -- a 1-day window on bursty traffic legitimately differs.
  const tail = windows.filter((w) => w.days >= 7 && w.turnsAfter !== null).map((w) => w.turnsAfter);
  const spread =
    tail.length < 2 ? null : (Math.max(...tail) - Math.min(...tail)) / (tail.reduce((a, b) => a + b, 0) / tail.length);

  return {
    at: new Date(now).toISOString(),
    windows,
    turnsAfter: windows.find((w) => w.days === 7)?.turnsAfter ?? null,
    spreadAcrossLongWindows: spread,
    stable: spread !== null && spread < 0.15,
  };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const m = (x) => `${(x / 1e6).toFixed(2)}M`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const r = await measure();
  console.log(`cost split in effective input tokens, as of ${r.at}\n`);
  console.log('window   requests      total     input     write      read    output | reads/write');
  for (const w of r.windows) {
    if (w.shares.total === 0) continue;
    console.log(
      `${String(w.days).padStart(3)}d ${String(w.totals.requests).padStart(10)} ` +
        `${m(w.shares.total).padStart(10)} ${pct(w.shares.input).padStart(9)} ` +
        `${pct(w.shares.write).padStart(9)} ${pct(w.shares.read).padStart(9)} ` +
        `${pct(w.shares.output).padStart(9)} | ` +
        `${w.turnsAfter === null ? '    n/a' : w.turnsAfter.toFixed(2).padStart(7)}`
    );
  }
  const seven = r.windows.find((w) => w.days === 7);
  if (seven && seven.ttl.written > 0) {
    console.log(
      `\nwrite TTL: ${pct(seven.ttl.oneHourShare)} of ${seven.ttl.written} written tokens took the ` +
        `1-hour rate, blending to ${seven.ttl.blendedRate.toFixed(4)}x`
    );
  }
  if (seven) {
    const think = seven.totals.output === 0 ? null : seven.totals.thinking / seven.totals.output;
    if (think !== null) console.log(`thinking is ${pct(think)} of output tokens`);
  }
  console.log(
    `\nturnsAfter, measured: ${r.turnsAfter === null ? 'n/a' : r.turnsAfter.toFixed(1)}` +
      `  (${r.stable ? 'settled' : 'NOT settled'} across the 7d+ windows, spread ` +
      `${r.spreadAcrossLongWindows === null ? 'n/a' : pct(r.spreadAcrossLongWindows)})`
  );
}
