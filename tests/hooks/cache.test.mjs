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
import { record } from '../../hooks-core/metrics.mjs';
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
