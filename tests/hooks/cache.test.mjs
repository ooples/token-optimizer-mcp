/**
 * Prompt-cache economics.
 *
 * The properties under test are the ones that separate this from a cache-health
 * readout: the loss is MEASURED from the client's own record, the cause is
 * ATTRIBUTED to a file and a line with position-dependent pricing, keep-warm is
 * decided in advance by expected value rather than regretted afterwards by a
 * tripwire, the tripwire still exists underneath, and our own contribution to
 * the prefix is stable by construction rather than by hope.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readCacheUsage, cacheHealth, modelSwitchCost, volatileLines, attributeInvalidation,
  stableText, cacheOrdered, transcriptFor, WRITE_MULTIPLIER,
} from '../../hooks-core/cache.mjs';
import {
  gapDistribution, keepWarmDecision, ttlTier, tripwire, shouldKeepWarm,
  recordRefreshOutcome, TIERS, TRIPWIRE_MIN,
} from '../../hooks-core/keepwarm.mjs';
import { record, readMetrics } from '../../hooks-core/metrics.mjs';
import { policyText } from '../../hooks-core/adapter.mjs';

let workspace;
let dir;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'cache-'));
  dir = join(workspace, '.token-optimizer', 'wiki');
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

/** A transcript in the client's own format. */
function transcript(turns) {
  const path = join(workspace, 'transcript.jsonl');
  writeFileSync(path, turns.map((t) => JSON.stringify({
    timestamp: new Date(t.at || Date.now()).toISOString(),
    message: {
      model: t.model || 'claude-opus-5',
      usage: {
        cache_read_input_tokens: t.read || 0,
        cache_creation_input_tokens: t.written || 0,
        input_tokens: t.input || 0,
      },
    },
  })).join('\n') + '\n');
  return path;
}

describe('the loss is measured from the client\'s own record', () => {
  test('hit rate and prefix size come out of the transcript, not out of a model', () => {
    const path = transcript([
      { read: 0, written: 40_000 },
      { read: 40_000, written: 500 },
      { read: 40_500, written: 200 },
    ]);
    const health = cacheHealth(readCacheUsage(path));

    expect(health.turns).toBe(3);
    expect(health.hitRate).toBeGreaterThan(0.6);
    // The number every attribution below is a fraction of.
    expect(health.prefixTokens).toBe(40_700);
  });

  test('savings are priced in plain-token equivalents, so they compare with everything else', () => {
    const health = cacheHealth(readCacheUsage(transcript([{ read: 100_000, written: 0 }])));
    expect(health.savedVersusNoCache).toBe(90_000);
  });

  test('a missing transcript yields nothing rather than invented economics', () => {
    expect(readCacheUsage(null)).toEqual([]);
    expect(cacheHealth([])).toBeNull();
    expect(transcriptFor(join(workspace, 'nope'))).toBeNull();
  });

  test('a truncated tail line is skipped rather than throwing', () => {
    const path = transcript([{ read: 10, written: 10 }]);
    writeFileSync(path, `{"broken":\n${JSON.stringify({ message: { usage: { cache_read_input_tokens: 5 } } })}\n`);
    expect(readCacheUsage(path)).toHaveLength(1);
  });
});

describe('the cause is attributed, because a hit rate is not actionable', () => {
  test('a volatile construct is found with its line and its reason', () => {
    const hits = volatileLines('# Project\nBuilt on 2026-07-30T09:14 by the pipeline\nStable line\n');
    expect(hits[0].line).toBe(2);
    expect(hits[0].why).toMatch(/timestamp/);
  });

  test('a stable file produces nothing', () => {
    expect(volatileLines('# Project\nUse tabs.\nRun the tests.\n')).toHaveLength(0);
  });

  test('the price is the tokens POSITIONED AFTER it, not the size of the construct', () => {
    // The same timestamp is nearly free at the end of a prefix and ruinous near
    // the front, which is why a flat list of cache-breaking constructs is not
    // enough and position has to be part of the finding.
    writeFileSync(join(workspace, 'CLAUDE.md'), 'Generated 2026-07-30T09:14\nrest of the file\n');
    const [hit] = attributeInvalidation(workspace, 47_000);

    expect(hit.file).toBe('CLAUDE.md');
    expect(hit.downstreamTokens).toBe(47_000);
    expect(hit.costPerSession).toBe(Math.round(47_000 * WRITE_MULTIPLIER));
  });

  test('without a measurement it reports the construct WITHOUT a price', () => {
    // Inventing the downstream size would be exactly the false confidence this
    // project criticises elsewhere.
    writeFileSync(join(workspace, 'CLAUDE.md'), 'Generated 2026-07-30T09:14\n');
    const [hit] = attributeInvalidation(workspace, null);
    expect(hit.costPerSession).toBeNull();
  });

  test('the fix for a user file is a proposal with a diff, never an edit', () => {
    writeFileSync(join(workspace, 'CLAUDE.md'), 'Generated 2026-07-30T09:14\n');
    const [hit] = attributeInvalidation(workspace, 1000);
    expect(hit.remedy.kind).toBe('yours');
    expect(hit.remedy.diff).toContain('CLAUDE.md:1');
  });
});

describe('a model switch is priced before it is paid, not detected after', () => {
  test('the cost of discarding the warm prefix is stated in advance', () => {
    const cost = modelSwitchCost(readCacheUsage(transcript([{ read: 62_000, written: 0 }])));
    expect(cost.rewriteCost).toBe(Math.round(62_000 * WRITE_MULTIPLIER));
    expect(cost.text).toMatch(/discards a 62,000-token warm prefix/);
  });

  test('a session that already switched is flagged as such', () => {
    const path = transcript([
      { read: 10_000, written: 0, model: 'claude-sonnet-5' },
      { read: 0, written: 10_000, model: 'claude-opus-5' },
    ]);
    expect(modelSwitchCost(readCacheUsage(path)).alreadySwitched).toBe(true);
  });
});

describe('keep-warm is decided in advance, not regretted afterwards', () => {
  /** Seeds events `gapMs` apart so the distribution is known. */
  const seedGaps = (gapMs, count = 20) => {
    const base = Date.now() - count * gapMs;
    const path = join(dir, 'metrics.jsonl');
    record(dir, { kind: 'seed' });
    const lines = Array.from({ length: count }, (_, i) => JSON.stringify({ kind: 'read', at: base + i * gapMs }));
    writeFileSync(path, lines.join('\n') + '\n');
  };

  test('a gap just past the TTL is exactly what a refresh is for', () => {
    // Seven minutes: the entry would have expired, and one refresh reaches the
    // next turn. This is the only regime where a ping earns anything.
    seedGaps(7 * 60 * 1000);
    const decision = keepWarmDecision({ prefixTokens: 47_000, gaps: gapDistribution(dir) });

    expect(decision.action).toBe('refresh');
    // A verdict that cannot be checked is indistinguishable from a bug.
    expect(decision.expectedValue).toBeGreaterThan(0);
    expect(decision.reason).toMatch(/window one 5m refresh covers/);
  });

  test('rapid turns need no refresh, because the cache never goes cold', () => {
    // The trap in the obvious model: short gaps look like the ideal case for
    // keep-warm and are in fact the case where it buys nothing, because every
    // real turn has already refreshed the entry.
    seedGaps(30_000);
    const decision = keepWarmDecision({ prefixTokens: 47_000, gaps: gapDistribution(dir) });
    expect(decision.action).toBe('skip');
  });

  test('gaps far beyond the TTL make it a loss, and it is declined', () => {
    seedGaps(45 * 60 * 1000);
    const decision = keepWarmDecision({ prefixTokens: 47_000, gaps: gapDistribution(dir) });
    expect(decision.action).toBe('skip');
    expect(decision.expectedValue).toBeLessThan(0);
  });

  test('a ping is priced as the READ that it is, not as a write', () => {
    // Pricing the refresh as a write -- the obvious-looking model -- overstates
    // its cost more than twelvefold and rejects refreshes worth buying.
    seedGaps(7 * 60 * 1000);
    const decision = keepWarmDecision({ prefixTokens: 47_000, gaps: gapDistribution(dir) });
    expect(decision.costOfPing).toBe(4700);
  });

  test('the TTL tier is chosen from the same distribution, not set globally', () => {
    // Gaps too long for five minutes but comfortable inside an hour: the longer
    // tier costs twice the write and is still the better buy.
    seedGaps(12 * 60 * 1000);
    const best = ttlTier({ prefixTokens: 47_000, gaps: gapDistribution(dir) });
    expect(best.tier).toBe('1h');
  });

  test('when neither tier pays, the answer is null rather than a default', () => {
    seedGaps(6 * 60 * 60 * 1000);
    expect(ttlTier({ prefixTokens: 47_000, gaps: gapDistribution(dir) })).toBeNull();
  });

  test('with too little history it says so instead of guessing', () => {
    expect(gapDistribution(dir)).toBeNull();
    expect(keepWarmDecision({ prefixTokens: 47_000, gaps: null }).action).toBe('unknown');
  });
});

describe('the tripwire stays underneath the expected-value decision', () => {
  test('it holds its tongue until it has enough refreshes to have an opinion', () => {
    for (let i = 0; i < TRIPWIRE_MIN - 1; i++) {
      recordRefreshOutcome(dir, { tier: '5m', prefixTokens: 10_000, hit: false });
    }
    expect(tripwire(dir).tripped).toBe(false);
    expect(tripwire(dir).reason).toMatch(/refreshes observed/);
  });

  test('sustained losses stop keep-warm and say by how much', () => {
    // Distributions shift -- a user changes working pattern, a project goes
    // quiet -- so the expected-value decision needs a backstop.
    for (let i = 0; i < TRIPWIRE_MIN + 2; i++) {
      recordRefreshOutcome(dir, { tier: '5m', prefixTokens: 10_000, hit: false });
    }
    const trip = tripwire(dir);
    expect(trip.tripped).toBe(true);
    expect(trip.reason).toMatch(/has lost [\d,]+ tokens over \d+ refreshes/);
  });

  test('a tripped wire vetoes an otherwise positive expected value', () => {
    for (let i = 0; i < TRIPWIRE_MIN + 2; i++) {
      recordRefreshOutcome(dir, { tier: '5m', prefixTokens: 10_000, hit: false });
    }
    const out = shouldKeepWarm(dir, { prefixTokens: 47_000 });
    expect(out.action).toBe('skip');
    expect(out.trippedWire).toBe(true);
  });

  test('refreshes that get used are counted as the gain they are', () => {
    for (let i = 0; i < TRIPWIRE_MIN + 2; i++) {
      recordRefreshOutcome(dir, { tier: '5m', prefixTokens: 10_000, hit: true });
    }
    expect(tripwire(dir).tripped).toBe(false);
    expect(tripwire(dir).realised).toBeGreaterThan(0);
  });
});

describe('our own contribution to the prefix is stable by construction', () => {
  test('a volatile line in our own output is dropped, not emitted', () => {
    // We do not merely observe the cache, we write into it. Failing closed is
    // right: missing guidance costs a little, a volatile line costs the prefix.
    const out = stableText('Stable guidance line\nRun 2026-07-30T09:14 found 3 things\nAnother stable line');
    expect(out.dropped).toBe(1);
    expect(out.text).not.toMatch(/2026-07-30/);
    expect(out.text).toContain('Stable guidance line');
  });

  test('stable text passes through untouched', () => {
    const text = 'These files have never repaid a read: schema.ts';
    expect(stableText(text).text).toBe(text);
  });

  test('the session-start policy we actually emit contains nothing volatile', () => {
    // The regression that matters: this text sits near the front of the prefix
    // of every session in every project.
    expect(volatileLines(policyText(true))).toHaveLength(0);
  });

  test('injections are ordered stable-first so invalidation is confined to the tail', () => {
    const ordered = cacheOrdered([
      { id: 'fresh', fresh: true },
      { id: 'settled', fresh: false },
    ]);
    expect(ordered.map((i) => i.id)).toEqual(['settled', 'fresh']);
  });
});

// --- the two keep-warm ledgers must agree ------------------------------------------

describe('keep-warm scores refreshes with the model it bought them under', () => {
  const READ = 0.1;

  test('a realised outcome matches what keepWarmDecision predicted', () => {
    // THE DEFECT: keepWarmDecision prices a refresh as a PING that READS the prefix
    // (costOfPing = prefixTokens * READ_MULTIPLIER) and warns in its own comment that pricing it
    // as a write "overstates its cost by more than twelvefold". recordRefreshOutcome then scored
    // the very same refresh as a re-WRITE. The two disagreed in the direction that kills the
    // feature: mean realised was negative below a 27.8% hit rate while the decision's model makes
    // the ping pay above 8.7%, so for any project in that band the tripwire accumulated a negative
    // balance and permanently disabled a policy that was genuinely paying -- reporting it as
    // "keep-warm has lost N tokens ... stopping". The backstop fired on its own accounting error.
    const prefixTokens = 10_000;
    const tier = TIERS[0];

    recordRefreshOutcome(dir, { tier: tier.name, prefixTokens, hit: true });
    recordRefreshOutcome(dir, { tier: tier.name, prefixTokens, hit: false });

    const rows = readMetrics(dir).filter((e) => e.kind === 'keepwarm' && e.action === 'outcome');
    const hit = rows.find((r) => r.hit);
    const miss = rows.find((r) => !r.hit);

    // Exactly the decision's arithmetic: saving-if-used minus the cost of the ping, and on a miss
    // the cost of the ping alone.
    const costOfPing = prefixTokens * READ;
    const savingIfUsed = prefixTokens * (tier.writeMultiplier - READ);
    expect(hit.realised).toBe(Math.round(savingIfUsed - costOfPing));
    expect(miss.realised).toBe(Math.round(-costOfPing));
  });

  test('the tripwire does not stop a policy the decision says is paying', () => {
    // THE PROPERTY, exercised through both production functions rather than restated as local
    // arithmetic. A hit rate the decision calls profitable must not accumulate a negative realised
    // balance in the tripwire. At the old pricing the two disagreed between 8.7% and 27.8%, so
    // every rate in that band tripped the wire on a policy that was genuinely paying.
    const prefixTokens = 10_000;
    const hitRate = 0.15; // inside the old disagreement band

    // What the decision thinks of a gap profile with that much of its mass in the refresh window.
    const gaps = {
      probabilityWithin: (ms) => (ms <= TIERS[0].ms ? 0 : ms <= TIERS[0].ms * 2 ? hitRate : 1),
    };
    expect(keepWarmDecision({ prefixTokens, gaps }).action).toBe('refresh');

    // Now record real outcomes at that rate and ask the tripwire, which reads them back.
    const refreshes = 20;
    for (let i = 0; i < refreshes; i++) {
      recordRefreshOutcome(dir, {
        tier: TIERS[0].name, prefixTokens, hit: i < Math.round(refreshes * hitRate),
      });
    }
    const trip = tripwire(dir);
    expect(trip.observed).toBeGreaterThanOrEqual(TRIPWIRE_MIN);
    expect(trip.tripped).toBe(false);
    expect(trip.realised).toBeGreaterThan(0);
  });

  test('and it still stops one that is genuinely losing', () => {
    // The guard must not have been turned into a rubber stamp: below the true break-even the wire
    // still fires, which is the whole reason it exists.
    for (let i = 0; i < 20; i++) {
      recordRefreshOutcome(dir, { tier: TIERS[0].name, prefixTokens: 10_000, hit: false });
    }
    const trip = tripwire(dir);
    expect(trip.tripped).toBe(true);
    expect(trip.realised).toBeLessThan(0);
  });
});

describe('keep-warm never returns a verdict that contradicts its own reason', () => {
  /** Seeds events `gapMs` apart so the distribution is known. Same helper as above, re-scoped. */
  const seedGaps = (gapMs, count = 20) => {
    const base = Date.now() - count * gapMs;
    const path = join(dir, 'metrics.jsonl');
    record(dir, { kind: 'seed' });
    const lines = Array.from({ length: count }, (_, i) => JSON.stringify({ kind: 'read', at: base + i * gapMs }));
    writeFileSync(path, lines.join('\n') + '\n');
  };

  test('a refresh that pays is not rewritten into a skip', () => {
    // ttlTier asks whether holding a cache beats not caching; keepWarmDecision asks whether ONE
    // ping beats letting the entry lapse. They can legitimately disagree, and coercing the second
    // to 'skip' while keeping its reason string produced `{ action: 'skip', reason: '...expected
    // gain 130 tokens' }` -- a refusal justified by a gain.
    // Driven through shouldKeepWarm with real recorded events, not a hand-built verdict -- the
    // first version of this test constructed the object itself and so could pass while the
    // production path regressed.
    //
    // A MIXED distribution, because a uniform one cannot produce the disagreement. Uniform 9m gaps
    // make the 1h tier cheap (every gap lands inside it), so ttlTier pays and there is nothing to
    // disagree about. What is needed is a profile where NO tier pays across the session as a whole
    // -- most gaps are hours long -- while a real slice still sits in the 5m-to-10m window that one
    // ping reaches. 30% at seven minutes, 70% at three hours.
    const mixed = [];
    let at = Date.now() - 300 * 60 * 1000;
    for (let i = 0; i < 30; i++) {
      at += (i % 10 < 3 ? 7 : 180) * 60 * 1000;
      mixed.push(JSON.stringify({ kind: 'read', at }));
    }
    record(dir, { kind: 'seed' });
    writeFileSync(join(dir, 'metrics.jsonl'), `${mixed.join('\n')}\n`);

    const gaps = gapDistribution(dir);
    expect(ttlTier({ prefixTokens: 47_000, gaps })).toBeNull();
    expect(keepWarmDecision({ prefixTokens: 47_000, gaps }).action).toBe('refresh');

    const verdict = shouldKeepWarm(dir, { prefixTokens: 47_000 });
    expect(verdict.action).toBe('refresh');
    // And the invariant that failed before: no verdict may contradict its own stated reason.
    if (/expected gain/.test(verdict.reason || '')) expect(verdict.action).not.toBe('skip');
    if (/expected loss/.test(verdict.reason || '')) expect(verdict.action).not.toBe('refresh');
  });

  test('a non-finite turn count cannot produce a refresh built from NaN', () => {
    // Math.max(1, NaN) is NaN, so perTurn was NaN, `NaN >= 1` was false, and the guard PASSED --
    // returning action:'refresh' with expectedValue NaN and "NaN% of gaps land inside 5m".
    const gaps = { probabilityWithin: () => 0.9 };
    const out = ttlTier({ prefixTokens: 10_000, gaps, turnsPerSession: Number.NaN });
    if (out) {
      expect(Number.isFinite(out.expectedValue)).toBe(true);
      expect(Number.isFinite(out.expectedCostPerTurn)).toBe(true);
      expect(out.reason).not.toMatch(/NaN/);
    }
  });
});

describe('the backstop can actually reach its own threshold', () => {
  test('outcomes survive a firehose long enough to have evicted them', () => {
    // THE DEFECT: tripwire read through readMetrics, whose window is 5000 events and 2 MB. There
    // is one keepwarm outcome per refresh, in a log dominated by reads and captures, so the ten
    // TRIPWIRE_MIN demands aged out before the tenth was written. It returned
    // "only N/10 refreshes observed" for the life of the project, and shouldKeepWarm could never
    // be vetoed -- a guard that cannot reach its own threshold is not a guard.
    for (let i = 0; i < TRIPWIRE_MIN + 2; i++) {
      recordRefreshOutcome(dir, { tier: TIERS[0].name, prefixTokens: 10_000, hit: false });
    }
    // Bury them under more events than the window will hold.
    for (let i = 0; i < 5_200; i++) record(dir, { kind: 'read', anchor: `/n${i}.ts`, tokens: 10 });

    const windowed = readMetrics(dir).filter((e) => e.kind === 'keepwarm');
    expect(windowed.length).toBeLessThan(TRIPWIRE_MIN); // the window really did evict them

    const trip = tripwire(dir);
    expect(trip.observed).toBe(TRIPWIRE_MIN + 2);
    expect(trip.tripped).toBe(true);
  });
});

describe('a gap between two sessions is not a gap between turns', () => {
  test('an overnight boundary does not enter the distribution', () => {
    // THE DEFECT: every timestamp in the log was sorted and differenced, so the interval between
    // the last event of one session and the first of the next -- routinely sixteen hours -- was
    // counted as a turn gap. That dominated p90/p99 and diluted probabilityWithin in the
    // conservative direction, so ttlTier returned "neither tier pays" on projects where it would
    // have paid. Silent, because the bias only ever declines to act.
    const base = Date.now() - 48 * 60 * 60 * 1000;
    const events = [];
    for (let s = 0; s < 2; s++) {
      for (let i = 0; i < 6; i++) {
        events.push({ kind: 'read', sessionId: `s${s}`, at: base + s * 24 * 3600_000 + i * 60_000 });
      }
    }
    record(dir, { kind: 'seed' });
    writeFileSync(join(dir, 'metrics.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);

    const gaps = gapDistribution(dir);
    expect(gaps).not.toBeNull();
    // Ten one-minute gaps within the two sessions, and no 24-hour one between them.
    expect(gaps.count).toBe(10);
    expect(gaps.p99).toBeLessThan(2 * 60_000);
  });

  test('a long gap INSIDE a session is kept, because it is real evidence', () => {
    // Dropping these would bias the answer the other way -- making keep-warm look better than it
    // is, which is the direction this project cares about most.
    const base = Date.now() - 10 * 60 * 60 * 1000;
    const events = Array.from({ length: 8 }, (_, i) => ({
      kind: 'read', sessionId: 'one', at: base + i * 90 * 60_000,
    }));
    record(dir, { kind: 'seed' });
    writeFileSync(join(dir, 'metrics.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);

    const gaps = gapDistribution(dir);
    expect(gaps.median).toBeGreaterThan(60 * 60_000);
    expect(ttlTier({ prefixTokens: 47_000, gaps })).toBeNull(); // and it correctly declines
  });
});
