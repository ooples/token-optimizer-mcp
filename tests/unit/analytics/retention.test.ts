/**
 * The analytics store's half of the retention policy.
 *
 * WHAT A ROW COUNT WOULD NOT CATCH. A prune that bounded the database but
 * changed the savings figure would still leave a smaller file behind, so size
 * is not the thing to assert. Three failure modes hide behind a shrinking file:
 *
 *   1. A folded day lands in the wrong report window, because the fold used an
 *      instant where the windows use a local midnight.
 *   2. Two rows that `classifySavings` judged differently merge into one group,
 *      so a debit and a credit cancel instead of being reported separately.
 *   3. A group is priced from its summed tokens rather than per row, which is a
 *      different number wherever a long-context tier applies.
 *
 * So the central assertion here is the WHOLE REPORT, built from the raw rows,
 * against the same report built from what survived the prune plus the totals it
 * wrote. Everything else is one test per failure mode.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteAnalyticsStorage } from '../../../src/analytics/analytics-storage.js';
import type { AnalyticsEntry } from '../../../src/analytics/analytics-types.js';
import { buildReport } from '../../../src/savings/windows.js';
import { retentionDays } from '../../../src/savings/retention.js';

/**
 * The instant every report here is built for, set ahead of the wall clock.
 *
 * AHEAD ON PURPOSE. Writing a row also runs the policy -- that is the point of
 * the last two tests -- and the writer's prune reads the real clock, which it
 * must. A fixture dated in the past would therefore be folded by the write
 * itself, leaving the explicit passes below nothing to fold and no way to tell
 * a working prune from a broken one. Dating the fixture ahead of the clock
 * keeps the writer's prune out of the way while the fold is under test; the
 * windows only ever compare a row against the `now` they are given, so nothing
 * about the arithmetic changes.
 */
const TODAY = new Date();
const NOW = new Date(
  TODAY.getFullYear(),
  TODAY.getMonth(),
  TODAY.getDate() + 90,
  15,
  0,
  0,
  0
);

/** A day far enough back that the policy has to fold it. */
function aged(extra = 1): Date {
  const when = new Date(NOW);
  when.setDate(when.getDate() - retentionDays(NOW) - extra);
  when.setHours(9, 0, 0, 0);
  return when;
}

let dir = '';
let storage: SqliteAnalyticsStorage | null = null;

function open(): SqliteAnalyticsStorage {
  const built = new SqliteAnalyticsStorage(join(dir, 'analytics.db'));
  storage = built;
  return built;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'analytics-retention-'));
});

afterEach(() => {
  storage?.close();
  storage = null;
  rmSync(dir, { recursive: true, force: true });
});

function verified(over: Partial<AnalyticsEntry> = {}): AnalyticsEntry {
  const id = String(over.measurementId ?? 'm-1');
  return {
    hookPhase: 'PostToolUse',
    toolName: 'smart_read',
    mcpServer: 'token-optimizer',
    originalTokens: 1000,
    optimizedTokens: 400,
    tokensSaved: 600,
    timestamp: NOW.toISOString(),
    client: 'claude-code',
    model: 'claude-opus-5',
    savingsMeasured: true,
    ...over,
    measurementId: id,
    metadata: {
      measurementSchemaVersion: 2,
      measurementClass: 'verified-transport-reduction',
      baselineKind: 'materialized-undisclosed-mcp-result',
      measurementId: id,
      baselineSha256: 'a'.repeat(64),
      returnedSha256: 'b'.repeat(64),
      disclosureRef: 'c'.repeat(16),
      baselineBytes: 4000,
      returnedBytes: 1600,
      bytesSaved: 2400,
      provider: 'anthropic',
      pricingRoute: 'anthropic-api',
      ...(over.metadata || {}),
    },
  };
}

/** A debit: the optimizer returned more than the baseline it replaced. */
function expansion(over: Partial<AnalyticsEntry> = {}): AnalyticsEntry {
  return verified({
    originalTokens: 400,
    optimizedTokens: 1000,
    tokensSaved: -600,
    ...over,
    metadata: {
      measurementClass: 'verified-transport-expansion-debit',
      baselineBytes: 1600,
      returnedBytes: 4000,
      bytesSaved: -2400,
      ...(over.metadata || {}),
    },
  });
}

/**
 * Rows whose shapes reach every branch of the fold.
 *
 * TWO AGED DAYS AND TWO LIVE ONES, so a report built after the prune has to
 * agree with one built before it on both sides of the boundary rather than on
 * a single bucket that happens to hold everything.
 */
function spread(): AnalyticsEntry[] {
  return [
    verified({ measurementId: 'live-1' }),
    verified({
      measurementId: 'live-2',
      model: 'claude-sonnet-5',
      timestamp: new Date(NOW.getTime() - 3 * 86_400_000).toISOString(),
    }),
    verified({ measurementId: 'old-1', timestamp: aged(1).toISOString() }),
    verified({
      measurementId: 'old-2',
      toolName: 'smart_grep',
      timestamp: aged(1).toISOString(),
    }),
    expansion({ measurementId: 'old-3', timestamp: aged(1).toISOString() }),
    verified({
      measurementId: 'old-4',
      model: 'gemini-0-not-a-model',
      timestamp: aged(2).toISOString(),
    }),
    verified({
      measurementId: 'old-5',
      client: 'codex',
      timestamp: aged(2).toISOString(),
    }),
  ];
}

/**
 * Everything the report says, minus the fields that describe its own sources.
 *
 * The fold counters are expected to differ -- they are the disclosure that a
 * fold happened. Every other figure has to be identical.
 */
function figures(report: ReturnType<typeof buildReport>) {
  const { foldedOperations, foldedDays, ...rest } = report;
  void foldedOperations;
  void foldedDays;
  return rest;
}

async function reportAfterPrune(
  db: SqliteAnalyticsStorage
): Promise<ReturnType<typeof buildReport>> {
  const rows = await db.queryByDateRange(
    '0001-01-01T00:00:00.000Z',
    '9999-12-31T00:00:00.000Z'
  );
  return buildReport(rows, NOW, await db.getRollups());
}

describe('the analytics store under retention', () => {
  it('reports the same figures the rows reported', async () => {
    const rows = spread();
    const before = buildReport(rows, NOW);
    const db = open();
    await db.saveBatch(rows);

    const folded = await db.pruneOldEntries(NOW);
    expect(folded).toBe(5);
    // AND THE SURVIVORS ARE THE LIVE ONES, which is what makes the equality
    // below a statement about the fold rather than about a no-op.
    expect(await db.count()).toBe(2);

    const after = await reportAfterPrune(db);
    // THE WHOLE REPORT, not a figure from it: every window, every grouping and
    // every counter -- because a fold that moved one day into the wrong window
    // would leave most of them right.
    expect(figures(after)).toEqual(figures(before));
    expect(after.foldedOperations).toBe(5);
    expect(after.foldedDays).toBe(2);
  });

  it('keeps a debit from cancelling a credit it was never grouped with', async () => {
    // THE SAME DAY, TOOL, MODEL AND TOKEN COUNTS -- only the measured class
    // differs. If the class were not part of the fold key these two would merge
    // into one group whose net delta is zero, and the report would lose both
    // the credit and the debit at once.
    const credit = verified({
      measurementId: 'c',
      timestamp: aged(1).toISOString(),
    });
    const debit = expansion({
      measurementId: 'd',
      timestamp: aged(1).toISOString(),
      originalTokens: 1000,
      optimizedTokens: 400,
    });
    const before = buildReport([credit, debit], NOW);
    // A POSITIVE CONTROL ON THE FIXTURE: these two rows have to disagree about
    // their savings, or the test below would pass with the key removed.
    expect(before.windows[3].tokensSaved).not.toBe(0);

    const db = open();
    await db.saveBatch([credit, debit]);
    await db.pruneOldEntries(NOW);

    const rollups = await db.getRollups();
    expect(rollups).toHaveLength(2);
    expect(figures(await reportAfterPrune(db))).toEqual(figures(before));
  });

  it('folds a late row into the day it belongs to without losing the first fold', async () => {
    const first = verified({
      measurementId: 'f',
      timestamp: aged(1).toISOString(),
    });
    const late = verified({
      measurementId: 'l',
      timestamp: aged(1).toISOString(),
    });
    const before = buildReport([first, late], NOW);

    const db = open();
    await db.saveBatch([first]);
    await db.pruneOldEntries(NOW);
    // A SECOND PASS OVER A DAY THAT IS ALREADY A TOTAL. The upsert has to add
    // to what is stored; writing over it would discard the first pass.
    await db.saveBatch([late]);
    await db.pruneOldEntries(NOW);

    const rollups = await db.getRollups();
    expect(rollups).toHaveLength(1);
    expect(rollups[0].operations).toBe(2);
    expect(figures(await reportAfterPrune(db))).toEqual(figures(before));
  });

  it('does not count a day twice when the prune runs again', async () => {
    const rows = spread();
    const before = buildReport(rows, NOW);
    const db = open();
    await db.saveBatch(rows);

    await db.pruneOldEntries(NOW);
    const once = await reportAfterPrune(db);
    expect(await db.pruneOldEntries(NOW)).toBe(0);
    const twice = await reportAfterPrune(db);

    expect(figures(once)).toEqual(figures(before));
    expect(twice).toEqual(once);
  });

  it('still names a model it cannot price after that day is folded', async () => {
    const unpriced = verified({
      measurementId: 'u',
      model: 'gemini-0-not-a-model',
      timestamp: aged(1).toISOString(),
    });
    const before = buildReport([unpriced], NOW);
    expect(before.unpricedModels).toContain('gemini-0-not-a-model');

    const db = open();
    await db.saveBatch([unpriced]);
    await db.pruneOldEntries(NOW);

    const after = await reportAfterPrune(db);
    // AN UNPRICED MODEL THAT VANISHED WITH ITS ROWS would leave the report
    // claiming a complete dollar figure it cannot support.
    expect(after.unpricedModels).toEqual(before.unpricedModels);
  });

  it('leaves everything inside the window alone', async () => {
    // THE CONTROL ARM for every test above: the prune is driven by age, so a
    // store holding nothing aged has to come out of it untouched.
    const rows = [
      verified({ measurementId: 'a' }),
      verified({
        measurementId: 'b',
        timestamp: new Date(NOW.getTime() - 3 * 86_400_000).toISOString(),
      }),
    ];
    const db = open();
    await db.saveBatch(rows);

    expect(await db.pruneOldEntries(NOW)).toBe(0);
    expect(await db.count()).toBe(2);
    expect(await db.getRollups()).toEqual([]);
    const after = await reportAfterPrune(db);
    expect(after.foldedOperations).toBe(0);
    expect(after.foldedDays).toBe(0);
    expect(figures(after)).toEqual(figures(buildReport(rows, NOW)));
  });

  it('bounds a store that was already too old on the first write', async () => {
    // THE STATE THE POLICY EXISTS FOR: a database that grew under a build with
    // no retention at all. Nothing here asks for a prune -- a store that only
    // folded when asked would stay unbounded in every process that never asks.
    //
    // THE ONE FIXTURE DATED AGAINST THE WALL CLOCK, because the writer's prune
    // reads that clock and this is the test that the writer prunes at all.
    const longAgo = (back: number): string => {
      const when = new Date(TODAY);
      when.setDate(when.getDate() - retentionDays(TODAY) - back);
      return when.toISOString();
    };
    const db = open();
    await db.saveBatch([
      verified({ measurementId: 'o1', timestamp: longAgo(1) }),
      verified({ measurementId: 'o2', timestamp: longAgo(2) }),
    ]);
    db.close();
    storage = null;

    const reopened = open();
    await reopened.saveBatch([
      verified({ measurementId: 'fresh', timestamp: TODAY.toISOString() }),
    ]);

    expect(await reopened.count()).toBe(1);
    expect(await reopened.getRollups()).toHaveLength(2);
  });

  it('folds more rows than one batch holds', async () => {
    // BATCHED ON PURPOSE, so a year of rows does not have to be resident to be
    // folded -- which means the loop that advances between batches is load
    // bearing, and a loop that stopped after the first one would silently
    // leave most of the store behind.
    const rows: AnalyticsEntry[] = [];
    for (let index = 0; index < 2500; index++) {
      rows.push(
        verified({
          measurementId: `b-${index}`,
          timestamp: aged(1 + (index % 3)).toISOString(),
        })
      );
    }
    const before = buildReport(rows, NOW);
    const db = open();
    await db.saveBatch(rows);

    expect(await db.pruneOldEntries(NOW)).toBe(2500);
    expect(await db.count()).toBe(0);
    const after = await reportAfterPrune(db);
    expect(after.foldedOperations).toBe(2500);
    expect(after.foldedDays).toBe(3);
    expect(figures(after)).toEqual(figures(before));
  });
});

/**
 * The one thing the fold could still get wrong, which no total would reveal.
 *
 * AN EXPANSION DEBIT IS LINKED TO ITS CREDIT BY A LOOKUP THROUGH RAW ROWS.
 * `record-tool-analytics` resolves an incoming `expansionRef` to the
 * `measurementId` of the verified row that carries the matching
 * `disclosureRef`, and `hasConsistentExpansionDebit` refuses the debit without
 * it. A folded day has no per-row refs, so if a row could age out while its
 * pointer was still expandable, the debit would silently reclassify and the
 * dashboard would report MORE saved than it earned -- the one direction a wrong
 * figure must never move.
 *
 * IT CANNOT, BECAUSE THE POINTER DIES FIRST: the artifact store serves a ref
 * for `ARTIFACT_TTL_MS`, and rows are kept for longer than that. This pins the
 * ordering rather than the two numbers, so changing either constant fails here
 * instead of opening the seam.
 */
describe('the expansion-credit link outlives the pointer that needs it', () => {
  it('keeps rows at least as long as a disclosure ref can be expanded', async () => {
    const expand = (await import('../../../hooks-core/expand.mjs')) as {
      ARTIFACT_TTL_MS: number;
    };
    const pointerDays = expand.ARTIFACT_TTL_MS / 86_400_000;

    // POSITIVE CONTROL: both figures are real day counts, so the comparison
    // below is a real ordering rather than something trivially true of zero.
    expect(pointerDays).toBeGreaterThan(1);

    // Checked across a year, because the window is read off the report's own
    // local-day boundaries and a month length or a clock change moves them.
    for (let day = 0; day < 365; day += 1) {
      const when = new Date(2026, 0, 1 + day, 13, 0, 0, 0);
      expect(retentionDays(when)).toBeGreaterThanOrEqual(pointerDays);
    }
  });
});
