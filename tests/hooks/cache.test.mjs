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

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  readCacheUsage,
  cacheHealth,
  modelSwitchCost,
  volatileLines,
  attributeInvalidation,
  stableText,
  cacheOrdered,
  transcriptFor,
  WRITE_MULTIPLIER,
} from '../../hooks-core/cache.mjs';
import {
  gapDistribution,
  keepWarmDecision,
  ttlTier,
  tripwire,
  shouldKeepWarm,
  recordRefresh,
  recordRefreshOutcome,
  scoreRefreshes,
  observedHitRates,
  TIERS,
  TRIPWIRE_MIN,
  OBSERVATION_FLOOR,
  TURN_GAP_MS,
} from '../../hooks-core/keepwarm.mjs';
import { record, readMetrics, readBalance } from '../../hooks-core/metrics.mjs';
import { policyText } from '../../hooks-core/adapter.mjs';
import { sessionContext } from '../../hooks-core/inject.mjs';
import { putNode } from '../../hooks-core/wiki.mjs';

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
  writeFileSync(
    path,
    turns
      .map((t) =>
        JSON.stringify({
          timestamp: new Date(t.at || Date.now()).toISOString(),
          message: {
            model: t.model || 'claude-opus-5',
            usage: {
              cache_read_input_tokens: t.read || 0,
              cache_creation_input_tokens: t.written || 0,
              input_tokens: t.input || 0,
            },
          },
        })
      )
      .join('\n') + '\n'
  );
  return path;
}

describe("the loss is measured from the client's own record", () => {
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

  test('Anthropic cache discounts stay labeled as cost equivalents', () => {
    const health = cacheHealth(
      readCacheUsage(transcript([{ read: 100_000, written: 0 }]))
    );
    expect(health.provider).toBe('anthropic');
    expect(health.inputCostEquivalentAvoidedVersusUncached).toBe(90_000);
    expect(health.savedVersusNoCache).toBeUndefined();
  });

  test('a missing transcript yields nothing rather than invented economics', () => {
    expect(readCacheUsage(null)).toEqual([]);
    expect(cacheHealth([])).toBeNull();
    expect(transcriptFor(join(workspace, 'nope'))).toBeNull();
  });

  test('a truncated tail line is skipped rather than throwing', () => {
    const path = transcript([{ read: 10, written: 10 }]);
    writeFileSync(
      path,
      `{"broken":\n${JSON.stringify({ message: { usage: { cache_read_input_tokens: 5 } } })}\n`
    );
    expect(readCacheUsage(path)).toHaveLength(1);
  });
});

describe('the cause is attributed, because a hit rate is not actionable', () => {
  test('a volatile construct is found with its line and its reason', () => {
    const hits = volatileLines(
      '# Project\nBuilt on 2026-07-30T09:14 by the pipeline\nStable line\n'
    );
    expect(hits[0].line).toBe(2);
    expect(hits[0].why).toMatch(/timestamp/);
  });

  test('a stable file produces nothing', () => {
    expect(
      volatileLines('# Project\nUse tabs.\nRun the tests.\n')
    ).toHaveLength(0);
  });

  test('the price is the tokens POSITIONED AFTER it, not the size of the construct', () => {
    // The same timestamp is nearly free at the end of a prefix and ruinous near
    // the front, which is why a flat list of cache-breaking constructs is not
    // enough and position has to be part of the finding.
    writeFileSync(
      join(workspace, 'CLAUDE.md'),
      'Generated 2026-07-30T09:14\nrest of the file\n'
    );
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
    const cost = modelSwitchCost(
      readCacheUsage(transcript([{ read: 62_000, written: 0 }]))
    );
    expect(cost.rewriteInputCostEquivalent).toBe(
      Math.round(62_000 * WRITE_MULTIPLIER)
    );
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
    const lines = Array.from({ length: count }, (_, i) =>
      JSON.stringify({ kind: 'read', at: base + i * gapMs })
    );
    writeFileSync(path, lines.join('\n') + '\n');
  };

  test('a gap just past the TTL is exactly what a refresh is for', () => {
    // Seven minutes: the entry would have expired, and one refresh reaches the
    // next turn. This is the only regime where a ping earns anything.
    seedGaps(7 * 60 * 1000);
    const decision = keepWarmDecision({
      prefixTokens: 47_000,
      gaps: gapDistribution(dir),
    });

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
    const decision = keepWarmDecision({
      prefixTokens: 47_000,
      gaps: gapDistribution(dir),
    });
    expect(decision.action).toBe('skip');
  });

  test('gaps far beyond the TTL make it a loss, and it is declined', () => {
    seedGaps(45 * 60 * 1000);
    const decision = keepWarmDecision({
      prefixTokens: 47_000,
      gaps: gapDistribution(dir),
    });
    expect(decision.action).toBe('skip');
    expect(decision.expectedValue).toBeLessThan(0);
  });

  test('a ping is priced as the READ that it is, not as a write', () => {
    // Pricing the refresh as a write -- the obvious-looking model -- overstates
    // its cost more than twelvefold and rejects refreshes worth buying.
    seedGaps(7 * 60 * 1000);
    const decision = keepWarmDecision({
      prefixTokens: 47_000,
      gaps: gapDistribution(dir),
    });
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
    expect(
      ttlTier({ prefixTokens: 47_000, gaps: gapDistribution(dir) })
    ).toBeNull();
  });

  test('with too little history it says so instead of guessing', () => {
    expect(gapDistribution(dir)).toBeNull();
    expect(keepWarmDecision({ prefixTokens: 47_000, gaps: null }).action).toBe(
      'unknown'
    );
  });
});

describe('the tripwire stays underneath the expected-value decision', () => {
  test('it holds its tongue until it has enough refreshes to have an opinion', () => {
    for (let i = 0; i < TRIPWIRE_MIN - 1; i++) {
      recordRefreshOutcome(dir, {
        tier: '5m',
        prefixTokens: 10_000,
        hit: false,
      });
    }
    expect(tripwire(dir).tripped).toBe(false);
    expect(tripwire(dir).reason).toMatch(/refreshes observed/);
  });

  test('sustained losses stop keep-warm and say by how much', () => {
    // Distributions shift -- a user changes working pattern, a project goes
    // quiet -- so the expected-value decision needs a backstop.
    for (let i = 0; i < TRIPWIRE_MIN + 2; i++) {
      recordRefreshOutcome(dir, {
        tier: '5m',
        prefixTokens: 10_000,
        hit: false,
      });
    }
    const trip = tripwire(dir);
    expect(trip.tripped).toBe(true);
    expect(trip.reason).toMatch(/has lost [\d,]+ tokens over \d+ refreshes/);
  });

  test('a tripped wire vetoes an otherwise positive expected value', () => {
    for (let i = 0; i < TRIPWIRE_MIN + 2; i++) {
      recordRefreshOutcome(dir, {
        tier: '5m',
        prefixTokens: 10_000,
        hit: false,
      });
    }
    const out = shouldKeepWarm(dir, { prefixTokens: 47_000 });
    expect(out.action).toBe('skip');
    expect(out.trippedWire).toBe(true);
  });

  test('refreshes that get used are counted as the gain they are', () => {
    for (let i = 0; i < TRIPWIRE_MIN + 2; i++) {
      recordRefreshOutcome(dir, {
        tier: '5m',
        prefixTokens: 10_000,
        hit: true,
      });
    }
    expect(tripwire(dir).tripped).toBe(false);
    expect(tripwire(dir).realised).toBeGreaterThan(0);
  });
});

describe('a refresh finds out whether it bought anything', () => {
  /** A refresh recorded at a chosen moment, as an issuer would record it. */
  const issue = (at, extra = {}) =>
    recordRefresh(dir, {
      tier: '5m',
      prefixTokens: 20_000,
      expectedValue: 1,
      sessionId: 's1',
      at,
      ...extra,
    });

  /** A turn, through the real producer, so both logs see it. */
  const turn = (at, sessionId = 's1') => record(dir, { kind: 'read', at, sessionId });

  const outcomes = () =>
    readBalance(dir).filter((e) => e.kind === 'keepwarm' && e.action === 'outcome');

  test('a turn arriving before expiry is recorded as a hit', () => {
    const at = Date.now() - 10 * 60 * 1000;
    issue(at);
    turn(at + 60_000);

    const summary = scoreRefreshes(dir);
    expect([summary.scored, summary.hits]).toEqual([1, 1]);
    expect(outcomes().map((o) => [o.hit, o.tier])).toEqual([[true, '5m']]);
  });

  test('a window that closed with no turn in it is a real miss', () => {
    const at = Date.now() - 10 * 60 * 1000;
    issue(at);
    // Six minutes later: the 5m entry had already lapsed, so this arrival is
    // evidence the window closed unused rather than evidence of a hit.
    turn(at + 6 * 60 * 1000);

    const summary = scoreRefreshes(dir);
    expect([summary.scored, summary.hits]).toEqual([1, 0]);
    expect(outcomes().map((o) => o.hit)).toEqual([false]);
  });

  test('a hit is not scored before its window closes, or hits would be counted first', () => {
    // RIGHT-CENSORING, which is the way this measurement flatters itself.
    // Scoring a hit the moment it arrives while a miss has to wait out the
    // whole TTL means that at any instant the recorded hits are complete and
    // the recorded misses are not.
    const at = Date.now() - 60_000;
    issue(at);
    turn(at + 10_000);

    const summary = scoreRefreshes(dir);
    expect([summary.scored, summary.pending]).toEqual([0, 1]);
    expect(outcomes()).toEqual([]);
  });

  test('a refresh with no arrival evidence records nothing rather than a miss', () => {
    const at = Date.now() - 10 * 60 * 1000;
    issue(at);

    // The firehose window has moved past the period an answer would need. An
    // absent signal is not a miss: counting it as one biases every rate
    // downward and would eventually switch keep-warm off on no evidence.
    const summary = scoreRefreshes(dir, {
      arrivals: () => [{ kind: 'read', at: Date.now(), sessionId: 's1' }],
    });
    expect([summary.scored, summary.uncovered]).toEqual([0, 1]);
    expect(outcomes()).toEqual([]);
  });

  test('a refresh naming no session is not scored, because no arrival belongs to it', () => {
    const at = Date.now() - 10 * 60 * 1000;
    issue(at, { sessionId: null });
    turn(at + 60_000);

    const summary = scoreRefreshes(dir);
    expect([summary.scored, summary.unattributable]).toEqual([0, 1]);
    expect(outcomes()).toEqual([]);
  });

  test('a refresh that cannot be paired is not scored, or it would be scored forever', () => {
    // No id, so no outcome could ever name it -- and an outcome that names
    // nothing is one more row on the ledger at the end of every turn, forever.
    // Everything else about this refresh is scoreable: the window has closed,
    // the arrival log covers it, and a turn did arrive inside it.
    const at = Date.now() - 10 * 60 * 1000;
    const summary = scoreRefreshes(dir, {
      refreshes: [
        {
          kind: 'keepwarm',
          action: 'refresh',
          tier: '5m',
          prefixTokens: 20_000,
          sessionId: 's1',
          at,
        },
      ],
      arrivals: () => [
        { kind: 'keepwarm', action: 'refresh', at, sessionId: 's1' },
        { kind: 'read', at: at + 60_000, sessionId: 's1' },
      ],
    });
    expect([summary.scored, summary.unattributable]).toEqual([0, 1]);
  });

  test('each refresh is scored once, not once per turn', () => {
    const at = Date.now() - 10 * 60 * 1000;
    issue(at);
    turn(at + 60_000);

    scoreRefreshes(dir);
    expect(scoreRefreshes(dir).scored).toBe(0);
    expect(outcomes()).toHaveLength(1);
  });

  test('the firehose is not read when there is no refresh to score', () => {
    // The dormant cost of this loop is one small file, not a 2 MB tail read on
    // every turn of every session on a machine that never refreshes anything.
    turn(Date.now() - 60_000);
    let reads = 0;
    const summary = scoreRefreshes(dir, {
      arrivals: () => {
        reads += 1;
        return [];
      },
    });
    expect([reads, summary.scored, summary.pending]).toEqual([0, 0, 0]);
  });

  test("keep-warm's own bookkeeping does not count as a turn arrival", () => {
    const at = Date.now() - 10 * 60 * 1000;
    issue(at);
    const summary = scoreRefreshes(dir, {
      arrivals: () => [
        { kind: 'keepwarm', action: 'refresh', at, sessionId: 's1' },
        { kind: 'keepwarm', action: 'outcome', at: at + 60_000, sessionId: 's1' },
      ],
    });
    expect([summary.scored, summary.hits]).toEqual([1, 0]);
  });

  test('a burst inside the same turn is not an arrival', () => {
    const at = Date.now() - 10 * 60 * 1000;
    issue(at);
    turn(at + TURN_GAP_MS - 50);
    turn(at + 6 * 60 * 1000);
    expect(scoreRefreshes(dir).hits).toBe(0);
  });

  test('the window is the tier the refresh was bought at', () => {
    const at = Date.now() - 2 * 60 * 60 * 1000;
    issue(at, { tier: '1h' });
    turn(at + 30 * 60 * 1000);
    const summary = scoreRefreshes(dir);
    expect([summary.scored, summary.hits]).toEqual([1, 1]);
  });

  test('the Stop hook scores refreshes, so the loop has a live call site', () => {
    // THE HALF THAT WAS MISSING. Both recorders were correct, tested and called
    // by nothing, so the decision could never learn. Spawned rather than
    // imported: an in-process call proves the function works, not that anything
    // runs it.
    const project = mkdtempSync(join(tmpdir(), 'kw-stop-'));
    mkdirSync(join(project, '.git'), { recursive: true });
    try {
      const at = Date.now() - 10 * 60 * 1000;
      issue(at);
      turn(at + 60_000);

      const r = spawnSync(
        process.execPath,
        [join(process.cwd(), 'plugin', 'hooks', 'stop.mjs')],
        {
          input: JSON.stringify({ cwd: project, session_id: 'stop-session' }),
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            ...process.env,
            TOKEN_OPTIMIZER_WIKI_DIR: dir,
            TOKEN_OPTIMIZER_SHARED_DIR: dir,
            TOKEN_OPTIMIZER_STATE_DIR: join(project, '.state'),
            TOKEN_OPTIMIZER_PROJECT_REGISTRY: join(project, 'projects.jsonl'),
            CLAUDE_PROJECT_DIR: project,
          },
        }
      );
      expect(r.status).toBe(0);
      expect(outcomes().map((o) => o.hit)).toEqual([true]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('the keep-warm decision reads what the refreshes actually did', () => {
  /** Turns `gapMs` apart, through the real producer. */
  const seedTurns = (gapMs, count = 20) => {
    const base = Date.now() - count * gapMs;
    for (let i = 0; i < count; i++) record(dir, { kind: 'read', at: base + i * gapMs });
  };

  const seedOutcomes = (hits, misses, tier = '5m') => {
    for (let i = 0; i < hits + misses; i++)
      recordRefreshOutcome(dir, { tier, prefixTokens: 20_000, hit: i < hits });
  };

  const observed = () => observedHitRates(readBalance(dir));

  test('ten refreshes that never bought a read stop it recommending one', () => {
    // Gaps just past the TTL: the ping model says refresh, and until now
    // nothing could contradict it.
    seedTurns(7 * 60 * 1000);
    const gaps = gapDistribution(dir);
    expect(keepWarmDecision({ prefixTokens: 20_000, gaps }).action).toBe('refresh');

    seedOutcomes(0, OBSERVATION_FLOOR);
    const decision = keepWarmDecision({ prefixTokens: 20_000, gaps, observed: observed() });
    expect(decision.action).toBe('skip');
    expect(decision.observedHitRate).toBe(0);
    expect(decision.reason).toMatch(/10 observed refreshes/);
  });

  test('an observed hit rate may lower the modelled probability and never raise it', () => {
    // Every gap inside the TTL, so a ping buys nothing: the entry was warm
    // anyway. A recorded `hit` only says a turn arrived before expiry -- it
    // cannot say the ping is what kept the entry alive, so it is an UPPER bound
    // on the ping's value and must never be substituted for the model.
    seedTurns(30_000);
    const gaps = gapDistribution(dir);
    const plain = keepWarmDecision({ prefixTokens: 20_000, gaps });
    expect(plain.action).toBe('skip');

    seedOutcomes(OBSERVATION_FLOOR, 0);
    const withObservations = keepWarmDecision({
      prefixTokens: 20_000,
      gaps,
      observed: observed(),
    });
    expect(withObservations.action).toBe('skip');
    expect(withObservations.probability).toBe(plain.probability);
  });

  test('a perfect observed record cannot make a tier that never pays pay', () => {
    seedTurns(6 * 60 * 60 * 1000);
    seedOutcomes(OBSERVATION_FLOOR, 0);
    expect(
      ttlTier({ prefixTokens: 20_000, gaps: gapDistribution(dir), observed: observed() })
    ).toBeNull();
  });

  test('an observed hit rate moves the tier chooser off the tier that missed', () => {
    seedTurns(30_000);
    expect(ttlTier({ prefixTokens: 20_000, gaps: gapDistribution(dir) }).tier).toBe('5m');

    seedOutcomes(2, OBSERVATION_FLOOR - 2);
    const best = ttlTier({
      prefixTokens: 20_000,
      gaps: gapDistribution(dir),
      observed: observed(),
    });
    // Observations bind the tier they were measured at, and only that tier.
    expect(best.tier).toBe('1h');
  });

  test('when every tier has missed, no tier pays and it says so', () => {
    seedTurns(30_000);
    seedOutcomes(0, OBSERVATION_FLOOR, '5m');
    seedOutcomes(0, OBSERVATION_FLOOR, '1h');
    expect(
      ttlTier({ prefixTokens: 20_000, gaps: gapDistribution(dir), observed: observed() })
    ).toBeNull();
  });

  test('a single unlucky miss cannot switch keep-warm off', () => {
    seedTurns(30_000);
    seedOutcomes(0, 1);
    expect(observed().size).toBe(0);
    expect(shouldKeepWarm(dir, { prefixTokens: 20_000 }).action).toBe('refresh');
  });

  test('the floor is the same evidence the backstop demands', () => {
    seedOutcomes(0, OBSERVATION_FLOOR - 1);
    expect(observed().size).toBe(0);
    seedOutcomes(0, 1);
    expect(observed().get('5m')).toEqual({ refreshes: 10, hits: 0, rate: 0 });
    expect(OBSERVATION_FLOOR).toBe(TRIPWIRE_MIN);
  });

  test('the shipped decision reads the observations without the tripwire doing it', () => {
    seedTurns(30_000);
    expect(shouldKeepWarm(dir, { prefixTokens: 20_000 }).action).toBe('refresh');

    // Two used in ten at each tier. The realised ledger is still POSITIVE, so
    // the backstop has no opinion: if the verdict moves, the decision moved it.
    seedOutcomes(2, OBSERVATION_FLOOR - 2, '5m');
    seedOutcomes(2, OBSERVATION_FLOOR - 2, '1h');
    expect(tripwire(dir).tripped).toBe(false);

    const out = shouldKeepWarm(dir, { prefixTokens: 20_000 });
    expect(out.action).toBe('skip');
    expect(out.trippedWire).toBeUndefined();
  });
});

describe('our own contribution to the prefix is stable by construction', () => {
  test('a volatile line in our own output is dropped, not emitted', () => {
    // We do not merely observe the cache, we write into it. Failing closed is
    // right: missing guidance costs a little, a volatile line costs the prefix.
    const out = stableText(
      'Stable guidance line\nRun 2026-07-30T09:14 found 3 things\nAnother stable line'
    );
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

    const rows = readMetrics(dir).filter(
      (e) => e.kind === 'keepwarm' && e.action === 'outcome'
    );
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
      probabilityWithin: (ms) =>
        ms <= TIERS[0].ms ? 0 : ms <= TIERS[0].ms * 2 ? hitRate : 1,
    };
    expect(keepWarmDecision({ prefixTokens, gaps }).action).toBe('refresh');

    // Now record real outcomes at that rate and ask the tripwire, which reads them back.
    const refreshes = 20;
    for (let i = 0; i < refreshes; i++) {
      recordRefreshOutcome(dir, {
        tier: TIERS[0].name,
        prefixTokens,
        hit: i < Math.round(refreshes * hitRate),
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
      recordRefreshOutcome(dir, {
        tier: TIERS[0].name,
        prefixTokens: 10_000,
        hit: false,
      });
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
    const lines = Array.from({ length: count }, (_, i) =>
      JSON.stringify({ kind: 'read', at: base + i * gapMs })
    );
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
    expect(keepWarmDecision({ prefixTokens: 47_000, gaps }).action).toBe(
      'refresh'
    );

    const verdict = shouldKeepWarm(dir, { prefixTokens: 47_000 });
    expect(verdict.action).toBe('refresh');
    // And the invariant that failed before: no verdict may contradict its own stated reason.
    if (/expected gain/.test(verdict.reason || ''))
      expect(verdict.action).not.toBe('skip');
    if (/expected loss/.test(verdict.reason || ''))
      expect(verdict.action).not.toBe('refresh');
  });

  test('a non-finite turn count cannot produce a refresh built from NaN', () => {
    // Math.max(1, NaN) is NaN, so perTurn was NaN, `NaN >= 1` was false, and the guard PASSED --
    // returning action:'refresh' with expectedValue NaN and "NaN% of gaps land inside 5m".
    const gaps = { probabilityWithin: () => 0.9 };
    const out = ttlTier({
      prefixTokens: 10_000,
      gaps,
      turnsPerSession: Number.NaN,
    });
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
      recordRefreshOutcome(dir, {
        tier: TIERS[0].name,
        prefixTokens: 10_000,
        hit: false,
      });
    }
    // Bury them under more events than the window will hold.
    for (let i = 0; i < 5_200; i++)
      record(dir, { kind: 'read', anchor: `/n${i}.ts`, tokens: 10 });

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
        events.push({
          kind: 'read',
          sessionId: `s${s}`,
          at: base + s * 24 * 3600_000 + i * 60_000,
        });
      }
    }
    record(dir, { kind: 'seed' });
    writeFileSync(
      join(dir, 'metrics.jsonl'),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
    );

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
      kind: 'read',
      sessionId: 'one',
      at: base + i * 90 * 60_000,
    }));
    record(dir, { kind: 'seed' });
    writeFileSync(
      join(dir, 'metrics.jsonl'),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
    );

    const gaps = gapDistribution(dir);
    expect(gaps.median).toBeGreaterThan(60 * 60_000);
    expect(ttlTier({ prefixTokens: 47_000, gaps })).toBeNull(); // and it correctly declines
  });
});

/**
 * The ordering that makes the economics bite.
 *
 * `cacheOrdered` was correct and had zero call sites, so the SessionStart
 * assembly was ordered by whatever sequence its call sites happened to push in.
 * These tests are about the ASSEMBLY, not the sort: a unit test of the sort
 * passed before this was wired and would pass again if the call were deleted.
 *
 * The property that actually costs money is the last one -- a change confined to
 * a volatile block must leave every byte ahead of it identical, because a prefix
 * cache invalidates from the first difference onward.
 */
describe('SessionStart context is assembled in cache order', () => {
  // The numbers are the contract. An earlier draft of this work used 'high' and
  // 'low' strings; those subtract to NaN, every comparison returns false, and
  // Array.prototype.sort leaves the input untouched -- a silent no-op that a
  // test written against an already-sorted input would have passed.
  test('volatility is numeric, and a non-numeric taxonomy would be a silent no-op', () => {
    const numeric = cacheOrdered([
      { id: 'volatile', volatility: 2 },
      { id: 'stable', volatility: 0 },
    ]);
    expect(numeric.map((b) => b.id)).toEqual(['stable', 'volatile']);

    // Documented, not endorsed: this is what the string version would have done.
    const strings = cacheOrdered([
      { id: 'volatile', volatility: 'high' },
      { id: 'stable', volatility: 'low' },
    ]);
    expect(Number('high') - Number('low')).toBeNaN();
    expect(strings.map((b) => b.id)).toEqual(['volatile', 'stable']);
  });

  test('sorts the assembled blocks, so insertion order cannot decide the prefix', () => {
    // Pushed WORST FIRST on purpose. If the assembly merely joined its inputs
    // this would emit the freshest block at the very front of the prefix, which
    // is the expensive arrangement.
    const text = sessionContext([
      { id: 'restoration', volatility: 3, text: 'RESTORATION' },
      { id: 'index', volatility: 2, text: 'INDEX' },
      { id: 'standing', volatility: 1, text: 'STANDING' },
      { id: 'policy', volatility: 0, text: 'POLICY' },
    ]);
    expect(text).toBe('POLICY\n\nSTANDING\n\nINDEX\n\nRESTORATION');
  });

  test('drops empty blocks instead of opening the prefix with a blank line', () => {
    // Fail open: an unreadable graph yields no standing block and no index, and
    // the policy notice must still arrive as the first byte of the prefix.
    expect(
      sessionContext([
        { id: 'index', volatility: 2, text: '' },
        { id: 'policy', volatility: 0, text: 'POLICY' },
        { id: 'standing', volatility: 1, text: '   ' },
        null,
      ])
    ).toBe('POLICY');
    expect(sessionContext([])).toBe('');
  });

  test('a change to a volatile block leaves the stable prefix byte-identical', () => {
    // THIS IS THE CLAIM, tested on the bytes the hook actually emits rather than
    // on the sort. Two sessions over the same graph, differing only in the task
    // text, select different findings for the wiki index. If the ordering works,
    // everything ahead of that index -- policy notice, project briefing and
    // standing rules -- is the same bytes both times, so the cache keeps it.
    const project = mkdtempSync(join(tmpdir(), 'cache-order-'));
    const graphDir = join(project, '.token-optimizer', 'wiki');
    mkdirSync(graphDir, { recursive: true });

    putNode(graphDir, {
      kind: 'finding',
      key: 'p1',
      pinned: true,
      confidence: 0.9,
      claim: 'Build against an isolated worktree, never live WIP.',
    });
    putNode(graphDir, {
      kind: 'finding',
      key: 'runner',
      type: 'command',
      trigger: 'jest',
      confidence: 0.95,
      claim: 'Run npm test, not npx jest; the jest binary ignores our runner settings.',
    });
    putNode(graphDir, {
      kind: 'finding',
      key: 'bundler',
      type: 'command',
      trigger: 'webpack',
      confidence: 0.95,
      claim: 'The webpack bundler emits everything below tools/bundle.',
    });

    const run = (userPrompt) => {
      const r = spawnSync(
        process.execPath,
        [join(process.cwd(), 'plugin', 'hooks', 'session-start.mjs')],
        {
          input: JSON.stringify({ cwd: project, userPrompt }),
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            ...process.env,
            TOKEN_OPTIMIZER_WIKI_DIR: graphDir,
            TOKEN_OPTIMIZER_SHARED_DIR: graphDir,
            TOKEN_OPTIMIZER_PROJECT_REGISTRY: join(project, 'projects.jsonl'),
            CLAUDE_PROJECT_DIR: project,
          },
        }
      );
      expect(r.status).toBe(0);
      return (
        JSON.parse(r.stdout || '{}')?.hookSpecificOutput?.additionalContext || ''
      );
    };

    // Two prompts with NO overlapping terms, so each selects exactly one of the
    // two situational findings and the wiki index genuinely differs between them.
    const first = run('The npx jest runner ignores our settings; fix jest.');
    const second = run('The webpack bundler emits below the wrong bundle root.');

    const MARKER = '# Project wiki';
    for (const out of [first, second]) {
      // Stable-first is an ORDER claim, so assert the order on real output.
      expect(out.indexOf('# Token optimization is active')).toBe(0);
      expect(out.indexOf('# Standing rules')).toBeGreaterThan(0);
      expect(out.indexOf(MARKER)).toBeGreaterThan(out.indexOf('# Standing rules'));
    }

    // The volatile block genuinely differs, or the prefix claim is vacuous.
    expect(first.slice(first.indexOf(MARKER))).not.toBe(
      second.slice(second.indexOf(MARKER))
    );
    expect(first).toContain('npx jest');
    expect(first).not.toContain('webpack bundler');
    expect(second).toContain('webpack bundler');
    expect(second).not.toContain('npx jest');

    // And everything ahead of it is the same bytes, which is what the cache
    // charges for.
    expect(first.slice(0, first.indexOf(MARKER))).toBe(
      second.slice(0, second.indexOf(MARKER))
    );

    try {
      rmSync(project, { recursive: true, force: true });
    } catch {
      /* windows keeps handles open briefly */
    }
  });
});

