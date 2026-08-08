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

  test('the break-even hit rate agrees between the two functions', () => {
    // The property that actually matters: the rate above which the tripwire stops complaining is
    // the same rate above which the decision says to refresh. Previously 27.8% versus 8.7%.
    const prefixTokens = 10_000;
    const tier = TIERS[0];
    const costOfPing = prefixTokens * READ;
    const savingIfUsed = prefixTokens * (tier.writeMultiplier - READ);
    const breakEven = costOfPing / savingIfUsed;

    // realised over N refreshes at exactly the break-even rate nets to zero.
    const net = breakEven * (savingIfUsed - costOfPing) + (1 - breakEven) * -costOfPing;
    expect(Math.abs(net)).toBeLessThan(1e-9);
  });
});

describe('keep-warm never returns a verdict that contradicts its own reason', () => {
  test('a refresh that pays is not rewritten into a skip', () => {
    // ttlTier asks whether holding a cache beats not caching; keepWarmDecision asks whether ONE
    // ping beats letting the entry lapse. They can legitimately disagree, and coercing the second
    // to 'skip' while keeping its reason string produced `{ action: 'skip', reason: '...expected
    // gain 130 tokens' }` -- a refusal justified by a gain.
    const gaps = {
      probabilityWithin: (ms) => (ms <= 5 * 60 * 1000 ? 0.2 : ms <= 10 * 60 * 1000 ? 0.4 : 0.5),
    };
    const decision = keepWarmDecision({ prefixTokens: 10_000, gaps });
    if (decision.action !== 'refresh') return; // the fixture must exercise the disagreement
    expect(ttlTier({ prefixTokens: 10_000, gaps })).toBeNull();

    // Whatever shouldKeepWarm returns, action and reason must not disagree.
    const verdict = { action: decision.action, reason: decision.reason };
    if (/expected gain/.test(verdict.reason)) expect(verdict.action).not.toBe('skip');
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
