/**
 * HOW MANY MORE TURNS A PREFIX IS RE-READ FOR, MEASURED PER CONVERSATION RATHER
 * THAN SUMMED OVER ALL TRAFFIC.
 *
 * `cost-split.mjs` divides all reads by all writes and gets one number -- the
 * corpus-wide `turnsAfter`, around 56. That is the right shape for pricing a
 * workload, where every token is billed the same way whichever conversation it
 * came from. It is the wrong shape for a BET.
 *
 * `JOINED_TURNS_ASSUMED` in `src/compress/strategy.ts` is a bet. The compressor
 * has been handed a conversation it did not start, with a cached prefix the
 * provider is already holding, and has to decide whether rewriting that prefix
 * repays the 1.25x write it costs. Rewriting pays off after enough following
 * turns re-read the cheaper prefix, and loses if the conversation stops first.
 * The loss is not symmetric: betting too LOW refuses a rewrite and forfeits a
 * saving, while betting too HIGH pays for a write nobody re-reads. So the number
 * the guard needs is not the average conversation, it is the WEAKEST one -- a
 * low quantile of the per-conversation distribution.
 *
 * That distribution is what this file measures.
 *
 * WHY WHOLE CONVERSATIONS AND NOT A WINDOW. Slicing by a time window truncates
 * conversations that straddle its edges, and a truncated conversation's ratio is
 * an artefact: its in-window reads belong partly to writes from before the
 * window, and its in-window writes have not yet accrued the reads that follow.
 * Summed over everything those two errors largely cancel, which is why
 * `cost-split.mjs` can window safely. Per conversation they do not cancel -- they
 * manufacture exactly the low outliers this file is looking for. Measured both
 * ways, windowing invents a conversation at 37.5 that does not exist: no whole
 * conversation in the corpus is below 41.1. So this groups every request by its
 * session and takes each conversation entire.
 *
 * WHAT THIS CANNOT SEE, WHICH MATTERS MORE THAN WHAT IT CAN. The corpus is one
 * user's Claude Code transcripts. Every conversation in it is agentic and
 * many-turn -- the smallest is 140 requests. A three-turn chat, the case a high
 * bet would hurt most, is not in here at all. What the corpus does say is that
 * length and horizon are barely related within it: the shortest conversation has
 * nearly the highest ratio, because a short session still re-reads its whole
 * prefix on every turn. The floor it reports is therefore a floor for THIS
 * population, and the constant derived from it is exposed as
 * `tuning.assumedSessionTurns` so a different population can override it.
 *
 * It spends no quota: every input is a local transcript file.
 */

import { pathToFileURL } from 'node:url';

import { loadRequests } from './transcripts.mjs';

/** The published cache rates, as multiples of an input token. */
const WRITE = 1.25;
const READ = 0.1;

/**
 * The share of a cached prefix a rewrite has to remove to break even over
 * `turns` following turns. Keeping costs `READ` on each of `turns + 1` turns;
 * rewriting costs `WRITE` once plus `READ` on each of `turns`, on whatever
 * fraction survives. This is the same arithmetic as `breakEvenRewriteShare` in
 * `src/compress/strategy.ts` and exists here so the derivation can print the bar
 * beside the horizon without importing from `src`.
 */
export function barAt(turns) {
  return 1 - (READ * (turns + 1)) / (WRITE + READ * turns);
}

/** Every conversation in the corpus, each taken entire. */
export function conversationsOf(requests) {
  const bySession = new Map();
  for (const r of requests.values()) {
    // A sidechain is a sub-agent's traffic. It has its own prefix and its own
    // lifetime, and folding it into the parent would attribute its reads to a
    // conversation that never held them.
    if (r.isSidechain || !r.sessionId) continue;
    let s = bySession.get(r.sessionId);
    if (!s) bySession.set(r.sessionId, (s = { id: r.sessionId, requests: 0, read: 0, written: 0, first: r.at, last: r.at }));
    s.requests += 1;
    s.read += r.cacheRead;
    s.written += r.cacheWrite5m + r.cacheWrite1h;
    if (r.at < s.first) s.first = r.at;
    if (r.at > s.last) s.last = r.at;
  }
  return [...bySession.values()]
    .map((s) => ({ ...s, spanHours: (s.last - s.first) / 3.6e6, horizon: s.written > 0 ? s.read / s.written : null }))
    .filter((s) => s.horizon !== null)
    .sort((a, b) => a.horizon - b.horizon);
}

/** Nearest-rank quantile, so every value reported is one a conversation really had. */
export function quantile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export async function measure({ requests = null } = {}) {
  const loaded = requests ?? (await loadRequests()).requests;
  const conversations = conversationsOf(loaded);
  const horizons = conversations.map((c) => c.horizon);
  const read = conversations.reduce((p, c) => p + c.read, 0);
  const written = conversations.reduce((p, c) => p + c.written, 0);
  return {
    at: new Date().toISOString(),
    conversations,
    // The floor is the whole point. p10 is reported beside it to show whether the
    // floor is a lone outlier or the shoulder of a distribution.
    floor: horizons[0] ?? null,
    p10: quantile(horizons, 0.1),
    p25: quantile(horizons, 0.25),
    median: quantile(horizons, 0.5),
    // Token-weighted, which is the quantity `cost-split.mjs` reports. Printed so
    // the two files can be checked against each other.
    pooled: written > 0 ? read / written : null,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const r = await measure();
  console.log(`reads per written token, per conversation, as of ${r.at}\n`);
  console.log('  session     requests    read(M)   written(M)   horizon   bar     span(h)');
  for (const c of r.conversations) {
    console.log(
      `  ${c.id.slice(0, 8)}  ${String(c.requests).padStart(9)}  ${(c.read / 1e6).toFixed(1).padStart(9)}  ` +
        `${(c.written / 1e6).toFixed(2).padStart(10)}  ${c.horizon.toFixed(1).padStart(8)}  ` +
        `${`${(barAt(c.horizon) * 100).toFixed(1)}%`.padStart(6)}  ${c.spanHours.toFixed(1).padStart(8)}`
    );
  }
  console.log(
    `\n${r.conversations.length} conversation(s)   floor ${r.floor.toFixed(1)}   p10 ${r.p10.toFixed(1)}   ` +
      `p25 ${r.p25.toFixed(1)}   median ${r.median.toFixed(1)}   pooled ${r.pooled.toFixed(1)}`
  );
  console.log(
    `the bar a guard betting on the floor would set: ${(barAt(r.floor) * 100).toFixed(1)}%  ` +
      `(betting on the pooled figure instead: ${(barAt(r.pooled) * 100).toFixed(1)}%)`
  );
}