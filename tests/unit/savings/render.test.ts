/**
 * THE ONE RULE THE RENDERER HAS TO KEEP is that it must not invent a number the
 * aggregation refused to produce. A null cost is an unknown price, and printing
 * it as `$0.00` would turn "we do not know what that model costs" into "it
 * saved you nothing" -- the same characters, the opposite claim.
 */

import {
  PROXY_SCOPE_NOTE,
  bar,
  count,
  gateNote,
  groupLines,
  money,
  renderSavings,
  windowLine,
} from '../../../src/savings/render.js';
import type {
  SavingsGroup,
  SavingsReport,
  SavingsWindow,
} from '../../../src/savings/windows.js';

function window(over: Partial<SavingsWindow> = {}): SavingsWindow {
  return {
    label: 'Today',
    since: '2026-10-01T00:00:00.000Z',
    operations: 4,
    tokensSaved: 600,
    tokensBefore: 1000,
    savingsPercent: 60,
    costUsd: 0.003,
    pricedOperations: 1,
    eligibleOperations: 1,
    ...over,
  };
}

function group(over: Partial<SavingsGroup> = {}): SavingsGroup {
  return {
    name: 'claude-opus-5',
    operations: 2,
    tokensSaved: 1200,
    costUsd: 0.006,
    pricedOperations: 2,
    eligibleOperations: 2,
    ...over,
  };
}

function report(over: Partial<SavingsReport> = {}): SavingsReport {
  return {
    windows: [window()],
    byModel: [group()],
    byClient: [group({ name: 'claude-code' })],
    totalEntries: 4,
    eligibleEntries: 1,
    ...over,
  };
}

describe('money', () => {
  it('says so when there is no price, and never prints a dollar sign then', () => {
    expect(money(null)).toBe('not priced');
    // The positive control: a known price DOES carry one, so the assertion
    // above is about the null case and not about the formatter being inert.
    expect(money(1.5)).toContain('$');
  });

  it('shows a sub-cent amount rather than rounding a real saving to zero', () => {
    expect(money(0.0031)).toBe('$0.0031');
    expect(money(0.0031)).not.toBe('$0.00');
  });

  it('keeps the sign on a net debit', () => {
    expect(money(-1.25)).toBe('-$1.25');
  });

  it('groups thousands so a large figure is readable', () => {
    expect(money(1234.5)).toBe('$1,234.50');
  });

  it('prints an exact zero as zero, which is a known price and not an unknown one', () => {
    expect(money(0)).toBe('$0.00');
  });
});

describe('bar', () => {
  it('fills in proportion, with both ends pinned', () => {
    expect(bar(0, 10)).toBe('░'.repeat(10));
    expect(bar(100, 10)).toBe('█'.repeat(10));
    expect(bar(50, 10)).toBe('█'.repeat(5) + '░'.repeat(5));
  });

  it('clamps rather than overflowing its width on a nonsense percentage', () => {
    expect(bar(400, 8)).toHaveLength(8);
    expect(bar(-50, 8)).toHaveLength(8);
    expect(bar(Number.NaN, 8)).toHaveLength(8);
  });
});

describe('count', () => {
  it('groups thousands', () => {
    expect(count(1_234_567)).toBe('1,234,567');
  });
});

describe('a window line', () => {
  it('carries the label, the percentage, both token counts and the price', () => {
    const line = windowLine(window());
    expect(line).toContain('Today');
    expect(line).toContain('60.0%');
    expect(line).toContain('saved 600 / 1,000 tokens');
    expect(line).toContain('$0.0030');
  });

  it('discloses the priced fraction when it is not the whole window', () => {
    const line = windowLine(
      window({ pricedOperations: 8, eligibleOperations: 12 })
    );
    expect(line).toContain('(8/12 priced)');
  });

  it('drops the fraction when every eligible operation was priced', () => {
    const line = windowLine(
      window({ pricedOperations: 12, eligibleOperations: 12 })
    );
    expect(line).not.toContain('priced)');
    // Positive control: the price itself is still there, so the absence above
    // is the parenthetical and not the whole figure going missing.
    expect(line).toContain('$');
  });

  it('does not claim a priced fraction of an unpriced window', () => {
    const line = windowLine(
      window({ costUsd: null, pricedOperations: 0, eligibleOperations: 9 })
    );
    expect(line).toContain('not priced');
    expect(line).not.toContain('0/9');
  });
});

describe('a breakdown', () => {
  it('renders nothing at all for an empty breakdown, not an empty heading', () => {
    expect(groupLines('\nCost avoided per model:', [], 10)).toEqual([]);
  });

  it('truncates to the requested depth and says how many were left', () => {
    const rows = [
      group({ name: 'a', tokensSaved: 30 }),
      group({ name: 'b', tokensSaved: 20 }),
      group({ name: 'c', tokensSaved: 10 }),
    ];
    const lines = groupLines('models:', rows, 2);
    expect(lines[0]).toBe('models:');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain('and 1 more row');
  });

  it('says "rows" when more than one was cut', () => {
    const rows = [1, 2, 3, 4].map((n) => group({ name: `m${n}` }));
    expect(groupLines('models:', rows, 1).at(-1)).toContain('and 3 more rows');
  });
});

describe('the scope and gate notes', () => {
  it('names the proxy, because a missing input reads as a measurement of zero', () => {
    expect(PROXY_SCOPE_NOTE).toContain('token-optimizer-proxy');
    expect(PROXY_SCOPE_NOTE).toContain('token-optimizer-inspect');
  });

  it('says how many rows were excluded and out of how many', () => {
    expect(gateNote(report({ totalEntries: 100, eligibleEntries: 12 }))).toBe(
      '88 of 100 recorded operations carry no provable before-state and are excluded from every figure above.'
    );
  });

  it('says nothing when every row counted', () => {
    expect(gateNote(report({ totalEntries: 12, eligibleEntries: 12 }))).toBe(
      ''
    );
  });

  it('agrees the noun with the total and the verbs with the skipped count', () => {
    expect(gateNote(report({ totalEntries: 1, eligibleEntries: 0 }))).toBe(
      '1 of 1 recorded operation carries no provable before-state and is excluded from every figure above.'
    );
    // One skipped out of many: the noun goes plural, the verbs stay singular.
    expect(gateNote(report({ totalEntries: 9, eligibleEntries: 8 }))).toBe(
      '1 of 9 recorded operations carries no provable before-state and is excluded from every figure above.'
    );
  });
});

describe('the whole report', () => {
  it('puts the windows above the breakdowns and the scope note last', () => {
    const text = renderSavings(report(), { topN: 10 });
    const lines = text.split('\n');
    const todayAt = lines.findIndex((l) => l.startsWith('Today'));
    const modelAt = lines.findIndex((l) => l === 'Cost avoided per model:');
    const clientAt = lines.findIndex((l) => l === 'Savings by client:');
    const noteAt = lines.findIndex((l) => l === PROXY_SCOPE_NOTE);
    expect(todayAt).toBeGreaterThanOrEqual(0);
    expect(modelAt).toBeGreaterThan(todayAt);
    expect(clientAt).toBeGreaterThan(modelAt);
    expect(noteAt).toBeGreaterThan(clientAt);
  });

  it('leaves no line carrying trailing whitespace', () => {
    for (const line of renderSavings(report(), { topN: 10 }).split('\n')) {
      expect(line).toBe(line.replace(/\s+$/, ''));
    }
  });

  it('omits the gate note when nothing was excluded, keeping the scope note', () => {
    const text = renderSavings(
      report({ totalEntries: 1, eligibleEntries: 1 }),
      { topN: 10 }
    );
    expect(text).not.toContain('no provable before-state');
    expect(text).toContain(PROXY_SCOPE_NOTE);
  });
});
