/**
 * WHAT A COUNT-ONLY TEST WOULD MISS HERE. Every window returns the right NUMBER
 * of rows no matter which rows it picked, and the two mistakes that actually
 * change a reported figure are invisible to a count: a UTC day boundary putting
 * an afternoon's work into tomorrow, and a percentage whose denominator is drawn
 * from a wider population than its numerator. Both are pinned below with a
 * control that moves the other way.
 */

import {
  UNATTRIBUTED,
  buildReport,
  groupBy,
  priceVerifiedDelta,
  startOfLocalDay,
  summarize,
  usd,
  windowBoundaries,
} from '../../../src/savings/windows.js';
import type { AnalyticsEntry } from '../../../src/analytics/analytics-types.js';

/** A row that clears the provenance gate as a reduction. */
function verified(over: Partial<AnalyticsEntry> = {}): AnalyticsEntry {
  const id = String(over.measurementId ?? 'm-1');
  const originalTokens = Number(over.originalTokens ?? 1000);
  const optimizedTokens = Number(over.optimizedTokens ?? 400);
  return {
    hookPhase: 'PostToolUse',
    toolName: 'smart_read',
    mcpServer: 'token-optimizer',
    originalTokens,
    optimizedTokens,
    tokensSaved: originalTokens - optimizedTokens,
    timestamp: '2026-10-01T12:00:00.000Z',
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

/** A row the gate rejects: no provable before-state. */
function unverified(over: Partial<AnalyticsEntry> = {}): AnalyticsEntry {
  return {
    hookPhase: 'PostToolUse',
    toolName: 'smart_read',
    mcpServer: 'token-optimizer',
    originalTokens: 1_000_000,
    optimizedTokens: 1,
    tokensSaved: 999_999,
    timestamp: '2026-10-01T12:00:00.000Z',
    ...over,
  };
}

describe('the local-day boundary', () => {
  it('opens today at midnight on the operator clock, not at midnight UTC', () => {
    const now = new Date(2026, 9, 1, 17, 30, 0);
    const start = startOfLocalDay(now);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getDate()).toBe(1);
    expect(start.getMonth()).toBe(9);
    // THE CONTROL: the same instant read as UTC midnight would be a DIFFERENT
    // instant anywhere but UTC, and this is the comparison that catches a
    // `setUTCHours` creeping in. Under TZ=UTC the two agree, so the assertion
    // is written to hold either way while still failing on a real swap.
    const utcMidnight = Date.parse(
      `${now.toISOString().slice(0, 10)}T00:00:00.000Z`
    );
    expect(start.getTime()).toBe(
      utcMidnight + now.getTimezoneOffset() * 60_000
    );
  });

  it('names four nested windows, widest last', () => {
    const now = new Date(2026, 9, 1, 9, 0, 0);
    const bounds = windowBoundaries(now);
    expect(bounds.map((b) => b.label)).toEqual([
      'Today',
      'Last 7 days',
      'Last 30 days',
      'All time',
    ]);
    expect(bounds[3].since).toBeNull();
    const today = bounds[0].since as Date;
    const week = bounds[1].since as Date;
    const month = bounds[2].since as Date;
    // Seven and thirty CALENDAR days including today, so six and twenty-nine back.
    expect(Math.round((today.getTime() - week.getTime()) / 86_400_000)).toBe(6);
    expect(Math.round((today.getTime() - month.getTime()) / 86_400_000)).toBe(
      29
    );
  });
});

describe('what a window counts', () => {
  const now = new Date(2026, 9, 1, 15, 0, 0);
  const daysAgo = (days: number): string => {
    const at = new Date(now.getTime());
    at.setDate(at.getDate() - days);
    at.setHours(10, 0, 0, 0);
    return at.toISOString();
  };

  it('places a row three days old in the week but not in today', () => {
    const entries = [verified({ measurementId: 'old', timestamp: daysAgo(3) })];
    const report = buildReport(entries, now);
    const [today, week, month, all] = report.windows;
    expect(today.eligibleOperations).toBe(0);
    expect(today.tokensSaved).toBe(0);
    // The same row, found by the three wider windows -- which is what proves
    // the empty "today" above is a boundary and not a dropped record.
    expect(week.tokensSaved).toBe(600);
    expect(month.tokensSaved).toBe(600);
    expect(all.tokensSaved).toBe(600);
  });

  it('takes the percentage denominator from the rows that produced the numerator', () => {
    // A single verified row: 600 saved of 1000 before.
    const alone = summarize([verified()], 'All time', null);
    expect(alone.tokensSaved).toBe(600);
    expect(alone.tokensBefore).toBe(1000);
    expect(alone.savingsPercent).toBeCloseTo(60, 6);

    // Add an unverified row claiming a million original tokens. A denominator
    // drawn from every row would read 0.06%; the gate keeps it at 60%.
    const withNoise = summarize([verified(), unverified()], 'All time', null);
    expect(withNoise.tokensSaved).toBe(600);
    expect(withNoise.tokensBefore).toBe(1000);
    expect(withNoise.savingsPercent).toBeCloseTo(60, 6);
    // The noise row is still counted as an operation that happened.
    expect(withNoise.operations).toBe(2);
    expect(withNoise.eligibleOperations).toBe(1);
  });

  it('keeps an unparseable timestamp out of every dated window and in all time', () => {
    const entries = [verified({ timestamp: 'not-a-date' })];
    const report = buildReport(entries, now);
    expect(report.windows[0].eligibleOperations).toBe(0);
    expect(report.windows[1].eligibleOperations).toBe(0);
    expect(report.windows[2].eligibleOperations).toBe(0);
    expect(report.windows[3].eligibleOperations).toBe(1);
  });

  it('reports an unpriceable window as unpriced rather than as zero dollars', () => {
    const entries = [verified({ model: 'some-model-nobody-published' })];
    const window = summarize(entries, 'All time', null);
    expect(window.tokensSaved).toBe(600);
    expect(window.costUsd).toBeNull();
    expect(window.pricedOperations).toBe(0);
    expect(window.eligibleOperations).toBe(1);
  });

  it('prices a catalogued model, and the price is positive and small', () => {
    const window = summarize([verified()], 'All time', null);
    expect(window.pricedOperations).toBe(1);
    expect(window.costUsd).not.toBeNull();
    expect(window.costUsd as number).toBeGreaterThan(0);
    // 600 uncached input tokens on claude-opus-5 is fractions of a cent, not dollars.
    expect(window.costUsd as number).toBeLessThan(0.01);
  });
});

describe('the breakdowns', () => {
  it('leaves out a model whose rows all failed the gate, rather than listing it at zero', () => {
    const rows = groupBy(
      [
        verified({ measurementId: 'a', model: 'claude-opus-5' }),
        unverified({ model: 'claude-haiku-4-5' }),
      ],
      (entry) => String(entry.model || '')
    );
    expect(rows.map((row) => row.name)).toEqual(['claude-opus-5']);
  });

  it('names an unattributed row instead of grouping it under an empty string', () => {
    const rows = groupBy([verified({ model: '' })], (entry) =>
      String(entry.model || '')
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(UNATTRIBUTED);
  });

  it('orders by saving, then by name so equal rows do not reshuffle between runs', () => {
    const big = verified({
      measurementId: 'big',
      model: 'claude-sonnet-5',
      originalTokens: 5000,
      optimizedTokens: 1000,
    });
    const tieA = verified({ measurementId: 'ta', model: 'aaa-model' });
    const tieB = verified({ measurementId: 'tb', model: 'zzz-model' });
    const first = groupBy([tieB, tieA, big], (e) => String(e.model || ''));
    const second = groupBy([big, tieA, tieB], (e) => String(e.model || ''));
    expect(first.map((r) => r.name)).toEqual([
      'claude-sonnet-5',
      'aaa-model',
      'zzz-model',
    ]);
    // THE POINT OF THE SECOND CALL: a different input order must not change
    // the printed order, or two runs of the command cannot be diffed.
    expect(second.map((r) => r.name)).toEqual(first.map((r) => r.name));
  });

  it('sums two rows of the same model into one line', () => {
    const rows = groupBy(
      [verified({ measurementId: 'one' }), verified({ measurementId: 'two' })],
      (entry) => String(entry.model || '')
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].operations).toBe(2);
    expect(rows[0].tokensSaved).toBe(1200);
  });

  it('counts eligible against total so a report can say what it excluded', () => {
    const report = buildReport(
      [verified(), unverified(), unverified({ timestamp: 'x' })],
      new Date(2026, 9, 1, 12, 0, 0)
    );
    expect(report.totalEntries).toBe(3);
    expect(report.eligibleEntries).toBe(1);
    expect(report.byModel).toHaveLength(1);
    expect(report.byClient.map((r) => r.name)).toEqual(['claude-code']);
  });

  it('prices one row the same way whether it is read as a window or a group', () => {
    const entries = [verified()];
    const window = summarize(entries, 'All time', null);
    const group = groupBy(entries, (e) => String(e.model || ''))[0];
    expect(group.costUsd).toBe(window.costUsd);
    // EQUALITY AT THE PRECISION THE REPORT PUBLISHES, not bit equality with
    // the raw float. `usd` quantizes every published dollar figure so that two
    // readings of the same history cannot disagree in the last digits -- which
    // they otherwise do, because summing the same priced rows in a different
    // order lands parts in 10^15 apart, and a folded day is summed at fold
    // time rather than in the window.
    const raw = priceVerifiedDelta(entries[0]);
    expect(raw).not.toBeNull();
    expect(window.costUsd).toBeCloseTo(Number(raw), 10);
    // AND QUANTIZED, NOT MERELY CLOSE: this row's price is one of the values
    // that is not exactly representable, so a window publishing the raw float
    // would pass the line above and fail this one.
    expect(Number(raw)).not.toBe(usd(Number(raw)));
    expect(window.costUsd).toBe(usd(Number(raw)));
  });
});

describe('an expansion debit', () => {
  /** A row the gate accepts as a DEBIT: context was re-materialized later. */
  function debit(): AnalyticsEntry {
    return {
      hookPhase: 'PostToolUse',
      toolName: 'expand',
      mcpServer: 'token-optimizer',
      originalTokens: 500,
      optimizedTokens: 500,
      tokensSaved: 0,
      timestamp: '2026-10-01T12:00:00.000Z',
      client: 'claude-code',
      model: 'claude-opus-5',
      measurementId: 'd-1',
      metadata: {
        measurementSchemaVersion: 2,
        measurementClass: 'verified-transport-expansion-debit',
        measurementId: 'd-1',
        expansionRef: 'e'.repeat(16),
        creditedMeasurementId: 'm-1',
        returnedSha256: 'f'.repeat(64),
        returnedBytes: 2000,
        provider: 'anthropic',
        pricingRoute: 'anthropic-api',
      },
    };
  }

  it('carries a negative sign through the price', () => {
    const priced = priceVerifiedDelta(debit());
    expect(priced).not.toBeNull();
    expect(priced as number).toBeLessThan(0);
  });

  it('nets against a credit in the same window instead of being dropped', () => {
    const credit = summarize([verified()], 'All time', null);
    const netted = summarize([verified(), debit()], 'All time', null);
    expect(credit.tokensSaved).toBe(600);
    // 600 saved, 500 given back.
    expect(netted.tokensSaved).toBe(100);
    expect(netted.eligibleOperations).toBe(2);
    expect(netted.costUsd as number).toBeLessThan(credit.costUsd as number);
  });
});

describe('the models no price exists for', () => {
  it('names them, and leaves the priced ones out', () => {
    // THE ACTIONABLE HALF OF "(1/2 priced)". The count already told an operator
    // that a figure was partial; only the id tells them which entry is missing
    // from the catalog.
    const report = buildReport(
      [
        verified({ measurementId: 'm-1', model: 'claude-opus-5' }),
        verified({ measurementId: 'm-2', model: 'gemini-pro' }),
      ],
      new Date('2026-10-01T18:00:00.000Z')
    );
    expect(report.unpricedModels).toEqual(['gemini-pro']);
    // Positive control: the priced row really was priced, so the list is short
    // because the catalog knew one of the two and not because nothing priced.
    const all = report.windows.find((window) => window.since === null);
    expect(all?.pricedOperations).toBe(1);
    expect(all?.eligibleOperations).toBe(2);
  });

  it('is empty when every eligible row priced', () => {
    const report = buildReport(
      [verified()],
      new Date('2026-10-01T18:00:00.000Z')
    );
    expect(report.unpricedModels).toEqual([]);
    expect(report.windows[0].costUsd).not.toBeNull();
  });

  it('ignores a row the provenance gate already rejected', () => {
    // An unverified row contributes no token delta, so it has no price to be
    // missing -- naming its model here would send an operator to the catalog
    // for a row that was never going to produce a figure.
    const report = buildReport(
      [verified(), unverified({ model: 'gpt-6-astra' })],
      new Date('2026-10-01T18:00:00.000Z')
    );
    expect(report.unpricedModels).toEqual([]);
    expect(report.totalEntries).toBe(2);
    expect(report.eligibleEntries).toBe(1);
  });

  it('reports a row that named no model at all as unattributed', () => {
    const report = buildReport(
      [verified({ model: '   ', metadata: { model: '' } })],
      new Date('2026-10-01T18:00:00.000Z')
    );
    expect(report.unpricedModels).toEqual([UNATTRIBUTED]);
  });
});
