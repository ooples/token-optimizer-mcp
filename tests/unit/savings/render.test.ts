/**
 * THE ONE RULE THE RENDERER HAS TO KEEP is that it must not invent a number the
 * aggregation refused to produce. A null cost is an unknown price, and printing
 * it as `$0.00` would turn "we do not know what that model costs" into "it
 * saved you nothing" -- the same characters, the opposite claim.
 */

import {
  INPUTS_NOTE,
  asSavingsWindow,
  bar,
  calibrationLine,
  deferralLine,
  latencyLine,
  withheldLine,
  outputLines,
  count,
  gateNote,
  groupLines,
  inputLines,
  money,
  priceTableNote,
  proxyGateNote,
  renderProxySavings,
  renderSavings,
  unpricedNote,
  windowLine,
} from '../../../src/savings/render.js';
import { OPERATOR_PRICE_TABLE_ENV } from '../../../src/analytics/operator-prices.js';
import type { OperatorPriceTableStatus } from '../../../src/analytics/operator-prices.js';
import {
  PROXY_INPUT,
  type ProxyInput,
  type ProxySavingsReport,
  type ProxySavingsWindow,
} from '../../../src/savings/proxy.js';
import {
  OUTPUT_EVIDENCE,
  type OutputSavingsEstimate,
  type OutputWaste,
} from '../../../src/proxy/output-savings.js';
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
    unpricedModels: [],
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
  it('names both inputs, because a missing one reads as a measurement of zero', () => {
    expect(INPUTS_NOTE).toContain('MCP analytics database');
    expect(INPUTS_NOTE).toContain('token-optimizer-proxy');
    expect(INPUTS_NOTE).toContain('TOKEN_OPTIMIZER_PROXY_ACCOUNTING');
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

// NO OPERATOR TABLE CONFIGURED is the shape every one of these fixtures
// renders under, so the note below is the only thing that puts that line on
// the page and the rest of the report is unaffected by it.
const NO_TABLE: OperatorPriceTableStatus = {
  path: null,
  contracts: 0,
  error: null,
};

describe('the whole report', () => {
  const notConfigured: ProxyInput = { kind: PROXY_INPUT.NotConfigured };

  it('puts the windows above the breakdowns and the inputs block last', () => {
    const text = renderSavings(report(), {
      topN: 10,
      proxy: notConfigured,
      priceTable: NO_TABLE,
    });
    const lines = text.split('\n');
    const sectionAt = lines.findIndex((l) => l === 'MCP tool traffic');
    const todayAt = lines.findIndex((l) => l.startsWith('Today'));
    const modelAt = lines.findIndex((l) => l === 'Cost avoided per model:');
    const clientAt = lines.findIndex((l) => l === 'Savings by client:');
    const inputsAt = lines.findIndex((l) => l === 'Inputs:');
    expect(sectionAt).toBeGreaterThanOrEqual(0);
    expect(todayAt).toBeGreaterThan(sectionAt);
    expect(modelAt).toBeGreaterThan(todayAt);
    expect(clientAt).toBeGreaterThan(modelAt);
    expect(inputsAt).toBeGreaterThan(clientAt);
  });

  it('leaves no line carrying trailing whitespace', () => {
    for (const line of renderSavings(report(), {
      topN: 10,
      proxy: notConfigured,
      priceTable: NO_TABLE,
    }).split('\n')) {
      expect(line).toBe(line.replace(/\s+$/, ''));
    }
  });

  it('omits the gate note when nothing was excluded, keeping the inputs', () => {
    const text = renderSavings(
      report({ totalEntries: 1, eligibleEntries: 1 }),
      {
        topN: 10,
        proxy: notConfigured,
        priceTable: NO_TABLE,
      }
    );
    expect(text).not.toContain('no provable before-state');
    expect(text).toContain('Inputs:');
  });

  it('omits the proxy section entirely when its ledger was not read', () => {
    const text = renderSavings(report(), {
      topN: 10,
      proxy: notConfigured,
      priceTable: NO_TABLE,
    });
    // The inputs block names the proxy either way; the SECTION is a line of
    // its own, and that is what must be absent.
    expect(text.split(chr10)).not.toContain('Proxy wire traffic');
    expect(text).not.toContain('Encoder check');
    // Positive control: a read ledger puts the section in.
    const withProxy = renderSavings(report(), {
      topN: 10,
      proxy: {
        kind: PROXY_INPUT.Read,
        path: '/l.jsonl',
        report: proxyReport(),
      },
      priceTable: NO_TABLE,
    });
    expect(withProxy.split(chr10)).toContain('Proxy wire traffic');
    expect(withProxy).toContain('Encoder check');
  });
});

/** A newline, written without an escape the tooling can collapse. */
const chr10 = String.fromCharCode(10);

function proxyWindow(
  over: Partial<ProxySavingsWindow> = {}
): ProxySavingsWindow {
  return {
    label: 'All time',
    since: null,
    requests: 6,
    billedRequests: 5,
    countedRequests: 4,
    pricedRequests: 3,
    calibratedRequests: 2,
    tokensSaved: 750,
    tokensBefore: 1000,
    savingsPercent: 75,
    costUsd: 0.02,
    oursTokens: 500,
    billedTokens: 480,
    timedRequests: 5,
    transformMsMean: 2.4,
    transformMsP50: { ms: 3, exceeded: false },
    transformMsP95: { ms: 20, exceeded: false },
    transformMsMax: 18.75,
    upstreamMsMean: 1840,
    outputEstimated: outputEstimate(),
    outputMeasured: null,
    outputWaste: null,
    deferralMeasured: null,
    ...over,
  };
}

/**
 * BUILT BY SPREADING, so a field added to the estimate shows up here as a tsc
 * error rather than as `undefined` reaching a `toFixed` at runtime -- `tsc -p
 * tsconfig.json` excludes this directory, and an incomplete literal here would
 * compile clean and fail only when the suite runs.
 */
function outputEstimate(
  over: Partial<OutputSavingsEstimate> = {}
): OutputSavingsEstimate {
  return {
    evidence: OUTPUT_EVIDENCE.Estimated,
    tokens: 1300,
    baselineTokens: 2400,
    percent: 54.1666,
    interval: { lowPercent: 31.04, highPercent: 77.29 },
    requests: 3,
    strata: 2,
    pooledRequests: 0,
    ...over,
  };
}

function outputWasteOf(over: Partial<OutputWaste> = {}): OutputWaste {
  return {
    evidence: OUTPUT_EVIDENCE.ObservedWaste,
    meanRatio: 0.3125,
    interval: { lowRatio: 0.21, highRatio: 0.414 },
    requests: 12,
    ...over,
  };
}

function proxyReport(
  over: Partial<ProxySavingsReport> = {}
): ProxySavingsReport {
  return {
    windows: [proxyWindow()],
    byModel: [
      {
        name: 'gpt-5.6-sol',
        operations: 4,
        tokensSaved: 750,
        costUsd: 0.02,
        pricedOperations: 3,
        eligibleOperations: 4,
      },
    ],
    totalRecords: 6,
    measuredRecords: 4,
    unbilledRecords: 1,
    uncountedRecords: 1,
    skippedLines: 0,
    unpricedModels: [],
    ...over,
  };
}

describe('the proxy section', () => {
  it('prints a proxy window through the same formatter as an MCP one', () => {
    const adapted = asSavingsWindow(proxyWindow());
    expect(adapted.operations).toBe(4);
    expect(adapted.pricedOperations).toBe(3);
    expect(adapted.eligibleOperations).toBe(4);
    expect(windowLine(adapted)).toBe(
      windowLine({
        label: 'All time',
        since: null,
        operations: 4,
        tokensSaved: 750,
        tokensBefore: 1000,
        savingsPercent: 75,
        costUsd: 0.02,
        pricedOperations: 3,
        eligibleOperations: 4,
      })
    );
  });

  it('reports the encoder gap as a pair, not as a ratio of ratios', () => {
    const line = calibrationLine(proxyReport());
    expect(line).toContain('we counted 500 prompt tokens');
    expect(line).toContain('billed 480');
    expect(line).toContain('+4.2%');
    expect(line).toContain('over 2 requests it priced');
  });

  it('signs the gap when our count reads low', () => {
    const line = calibrationLine(
      proxyReport({
        windows: [proxyWindow({ oursTokens: 480, billedTokens: 500 })],
      })
    );
    expect(line).toContain('-4.0%');
    // Positive control: the high-reading case still prints a plus.
    expect(calibrationLine(proxyReport())).toContain('+4.2%');
  });

  it('says nothing when no request was calibrated', () => {
    expect(
      calibrationLine(
        proxyReport({ windows: [proxyWindow({ calibratedRequests: 0 })] })
      )
    ).toBe('');
    // Positive control: the same report with a calibrated request speaks.
    expect(calibrationLine(proxyReport())).not.toBe('');
  });

  it('takes the calibration from all time, never from one window', () => {
    const line = calibrationLine(
      proxyReport({
        windows: [
          proxyWindow({ label: 'Today', since: '2026-10-01T00:00:00.000Z' }),
          proxyWindow({ oursTokens: 9000, billedTokens: 9000 }),
        ],
      })
    );
    expect(line).toContain('9,000');
    expect(line).not.toContain('500 prompt tokens');
  });
});

describe('the proxy gate note', () => {
  it('names the unbilled and the uncounted rows separately', () => {
    expect(proxyGateNote(proxyReport())).toBe(
      '1 request was never billed (no 2xx response) and 1 billed request carries no token count -- are excluded from every proxy figure above.'
    );
  });

  it('agrees the verbs with each count on its own', () => {
    expect(
      proxyGateNote(proxyReport({ unbilledRecords: 3, uncountedRecords: 0 }))
    ).toBe(
      '3 requests were never billed (no 2xx response) -- is excluded from every proxy figure above.'
    );
    expect(
      proxyGateNote(proxyReport({ unbilledRecords: 0, uncountedRecords: 2 }))
    ).toBe(
      '2 billed requests carry no token count -- is excluded from every proxy figure above.'
    );
  });

  it('says nothing when every request counted', () => {
    expect(
      proxyGateNote(proxyReport({ unbilledRecords: 0, uncountedRecords: 0 }))
    ).toBe('');
    // Positive control: one unbilled row brings the note back.
    expect(proxyGateNote(proxyReport({ uncountedRecords: 0 }))).not.toBe('');
  });

  it('puts the windows, the models, the check and the gate in that order', () => {
    const lines = renderProxySavings(proxyReport(), { topN: 10 });
    const text = lines.join('\u000a').split('\u000a');
    const headingAt = text.findIndex((l) => l === 'Proxy wire traffic');
    const windowAt = text.findIndex((l) => l.startsWith('All time'));
    const modelAt = text.findIndex((l) => l === 'Cost avoided per model:');
    const checkAt = text.findIndex((l) => l.startsWith('Encoder check'));
    const gateAt = text.findIndex((l) => l.includes('never billed'));
    expect(headingAt).toBeGreaterThanOrEqual(0);
    expect(windowAt).toBeGreaterThan(headingAt);
    expect(modelAt).toBeGreaterThan(windowAt);
    expect(checkAt).toBeGreaterThan(modelAt);
    expect(gateAt).toBeGreaterThan(checkAt);
  });
});

describe('the inputs block', () => {
  const mcp = report({ totalEntries: 100, eligibleEntries: 12 });

  it('states the MCP input and how much of it was measurable', () => {
    const lines = inputLines(mcp, { kind: PROXY_INPUT.NotConfigured });
    expect(lines[0]).toBe('Inputs:');
    expect(lines[1]).toContain('MCP tool traffic');
    expect(lines[1]).toContain('100 operations read, 12 measurable');
  });

  it('tells an operator how to add the proxy input when it is unset', () => {
    const lines = inputLines(mcp, { kind: PROXY_INPUT.NotConfigured });
    expect(lines[2]).toContain('not configured');
    expect(lines[2]).toContain('TOKEN_OPTIMIZER_PROXY_ACCOUNTING');
  });

  it('separates a ledger that is empty from one that cannot be read', () => {
    expect(
      inputLines(mcp, { kind: PROXY_INPUT.Missing, path: '/l.jsonl' })[2]
    ).toContain('/l.jsonl -- nothing written there yet');
    expect(
      inputLines(mcp, {
        kind: PROXY_INPUT.Unreadable,
        path: '/l.jsonl',
        reason: 'EACCES: permission denied',
      })[2]
    ).toContain('could not be read: EACCES: permission denied');
  });

  it('reports what a read ledger held, and the lines it could not parse', () => {
    const read = (over: Partial<ProxySavingsReport> = {}): string =>
      inputLines(mcp, {
        kind: PROXY_INPUT.Read,
        path: '/l.jsonl',
        report: proxyReport(over),
      })[2];
    expect(read()).toContain('/l.jsonl -- 6 requests read, 4 measurable');
    expect(read()).not.toContain('skipped');
    expect(read({ skippedLines: 2 })).toContain('2 unparseable lines skipped');
    expect(read({ skippedLines: 1 })).toContain('1 unparseable line skipped');
  });

  it('starts both sources in one column, so the states are comparable', () => {
    const lines = inputLines(mcp, {
      kind: PROXY_INPUT.Read,
      path: '/l.jsonl',
      report: proxyReport(),
    });
    expect(lines[1].indexOf('analytics database')).toBe(
      lines[2].indexOf('/l.jsonl')
    );
    // Positive control: the shorter label really is the one being padded, so
    // the agreement above is padding and not a coincidence of two lengths.
    expect(lines[1]).toContain('MCP tool traffic  ');
  });

  it('counts one operation in the singular', () => {
    expect(
      inputLines(report({ totalEntries: 1, eligibleEntries: 1 }), {
        kind: PROXY_INPUT.NotConfigured,
      })[1]
    ).toContain('1 operation read');
    // Positive control: two go back to the plural.
    expect(
      inputLines(report({ totalEntries: 2, eligibleEntries: 1 }), {
        kind: PROXY_INPUT.NotConfigured,
      })[1]
    ).toContain('2 operations read');
  });
});

describe('the note for models with no catalog price', () => {
  const chr10b = String.fromCharCode(10);

  it('names every model, and says which column is affected', () => {
    expect(unpricedNote(['gemini-pro'])).toBe(
      'No catalog price for 1 model (gemini-pro), so its tokens count toward ' +
        'the percentages above but not the money.'
    );
    // Both agreements move with the count, so a two-model note cannot read
    // "1 models ... its tokens".
    expect(unpricedNote(['gemini-pro', 'gpt-6-astra'])).toBe(
      'No catalog price for 2 models (gemini-pro, gpt-6-astra), so their ' +
        'tokens count toward the percentages above but not the money.'
    );
  });

  it('says nothing when the catalog priced everything', () => {
    expect(unpricedNote([])).toBe('');
    // Positive control: the formatter is not simply returning '' always.
    expect(unpricedNote(['x'])).not.toBe('');
  });

  it('appears under the MCP table when that half has an unpriced model', () => {
    const text = renderSavings(report({ unpricedModels: ['gemini-pro'] }), {
      topN: 10,
      proxy: { kind: PROXY_INPUT.NotConfigured },
      priceTable: NO_TABLE,
    });
    const lines = text.split(chr10b);
    expect(lines).toContain(unpricedNote(['gemini-pro']));
    // Positive control: the same render without the gap omits the line, so the
    // assertion above is about the field and not about the renderer always
    // appending a sentence.
    const clean = renderSavings(report(), {
      topN: 10,
      proxy: { kind: PROXY_INPUT.NotConfigured },
      priceTable: NO_TABLE,
    });
    expect(clean.split(chr10b)).not.toContain(unpricedNote(['gemini-pro']));
  });

  it('appears under the proxy table independently of the MCP half', () => {
    // THE TWO HALVES CONSULT THE SAME CATALOG BUT NOT THE SAME ROWS: a ledger
    // can name a model the analytics database never saw, so the note has to be
    // able to appear under one table and not the other.
    const lines = renderProxySavings(
      proxyReport({ unpricedModels: ['gpt-6-astra'] }),
      { topN: 10 }
    );
    expect(lines).toContain(unpricedNote(['gpt-6-astra']));
    expect(renderProxySavings(proxyReport(), { topN: 10 })).not.toContain(
      unpricedNote(['gpt-6-astra'])
    );
  });
});

describe('the price-table note', () => {
  /**
   * THREE DIFFERENT FACTS SHARE ONE LINE, so what matters is that the right one
   * wins. A refused table outranks everything: a typo in the path otherwise
   * reads as a handful of models that merely happen to be unpriced, and the
   * operator goes looking for the missing money in the wrong place.
   */
  it('names the refusal and its reason ahead of anything else', () => {
    const note = priceTableNote(
      {
        path: '/rates.json',
        contracts: 0,
        error: 'models[0] (x): "output" must be a number',
      },
      3
    );
    expect(note).toContain('/rates.json');
    expect(note).toContain('was refused');
    expect(note).toContain('"output" must be a number');
    // Positive control: the invitation is what the SAME unpriced count prints
    // when no table was named, so the refusal really did take precedence.
    expect(
      priceTableNote({ path: null, contracts: 0, error: null }, 3)
    ).toContain(OPERATOR_PRICE_TABLE_ENV);
  });

  it('counts the rates a loaded table contributed and labels them as the operators own', () => {
    const note = priceTableNote(
      { path: '/rates.json', contracts: 4, error: null },
      0
    );
    expect(note).toContain('4 rates');
    expect(note).toContain('/rates.json');
    expect(note).toContain('labelled as yours');
    // The singular is a real branch, not a cosmetic one: "1 rates" is the
    // tell-tale of a count pasted into a sentence without being read.
    expect(
      priceTableNote({ path: '/rates.json', contracts: 1, error: null }, 0)
    ).toContain('1 rate came from');
  });

  it('invites a table only while something is actually unpriced', () => {
    const invited = priceTableNote(
      { path: null, contracts: 0, error: null },
      2
    );
    expect(invited).toContain(OPERATOR_PRICE_TABLE_ENV);
    expect(invited).toContain('nothing is ever charged at a default rate');
    // NOTHING TO SAY IS SAID WITH NOTHING. Every model priced and no table
    // configured is the ordinary case, and advertising an env var there would
    // put a line on every report that no reader needs.
    expect(priceTableNote({ path: null, contracts: 0, error: null }, 0)).toBe(
      ''
    );
  });

  it('puts the line on the report itself, not only in the helper', () => {
    // The helper could be perfect and never be called. This is the wiring.
    const loaded = renderSavings(report(), {
      topN: 10,
      proxy: { kind: PROXY_INPUT.NotConfigured },
      priceTable: { path: '/rates.json', contracts: 2, error: null },
    });
    expect(loaded).toContain('/rates.json');
    expect(
      renderSavings(report(), {
        topN: 10,
        proxy: { kind: PROXY_INPUT.NotConfigured },
        priceTable: NO_TABLE,
      })
    ).not.toContain('/rates.json');
  });

  it('counts unpriced models under the proxy table toward the invitation', () => {
    // THE INVITATION IS ABOUT THE WHOLE PAGE. A ledger can name a model the
    // analytics database never saw, so a gap that exists only under the proxy
    // table still has to offer the operator the way to close it.
    const proxyOnly = renderSavings(report(), {
      topN: 10,
      proxy: {
        kind: PROXY_INPUT.Read,
        path: '/l.jsonl',
        report: proxyReport({ unpricedModels: ['gpt-6-astra'] }),
      },
      priceTable: NO_TABLE,
    });
    expect(proxyOnly).toContain(OPERATOR_PRICE_TABLE_ENV);
    // Positive control: the same render with no gap on either half stays quiet.
    expect(
      renderSavings(report(), {
        topN: 10,
        proxy: {
          kind: PROXY_INPUT.Read,
          path: '/l.jsonl',
          report: proxyReport(),
        },
        priceTable: NO_TABLE,
      })
    ).not.toContain(OPERATOR_PRICE_TABLE_ENV);
  });
});

/**
 * The line that keeps the report from arguing one side of a trade.
 *
 * WHAT THESE PIN IS THE WORDING, not the arithmetic -- `retention.test.ts`
 * holds the figures to the fold. A quantile the histogram can only bound has to
 * read as a bound in the text an operator quotes, and a ledger with no timings
 * has to say so out loud: a missing latency line beside a large saving is read
 * as a saving that cost nothing.
 */
describe('the latency the saving cost', () => {
  it('prints our transform beside the call it sits in front of', () => {
    const line = latencyLine(proxyReport());

    expect(line).toContain('our transform added 2.4 ms per request on average');
    // A BOUND, NOT A VALUE: the histogram knows the bucket, not the position
    // inside it, so "under" is the strongest honest word here.
    expect(line).toContain('median under 3.0 ms');
    expect(line).toContain('95th under 20 ms');
    expect(line).toContain('slowest 18.8 ms');
    // THE SCALE OUR SHARE IS READ AGAINST.
    expect(line).toContain('upstream call averaging 1840 ms');
    expect(line).toContain('over 5 timed requests');
  });

  it('marks the open bucket as exceeded rather than measured', () => {
    const line = latencyLine(
      proxyReport({
        windows: [
          proxyWindow({ transformMsP95: { ms: 2000, exceeded: true } }),
        ],
      })
    );

    // THE CONTROL: the closed median still reads as a bound in the same line,
    // so this is the open bucket being distinguished and not the whole line
    // changing shape.
    expect(line).toContain('median under 3.0 ms');
    expect(line).toContain('95th over 2000 ms');
    expect(line).not.toContain('95th under');
  });

  it('says the latency is unrecorded instead of saying it was free', () => {
    const line = latencyLine(
      proxyReport({
        windows: [
          proxyWindow({
            timedRequests: 0,
            transformMsMean: null,
            transformMsP50: null,
            transformMsP95: null,
            transformMsMax: null,
            upstreamMsMean: null,
          }),
        ],
      })
    );

    expect(line).toBe(
      'Latency cost: not recorded -- this ledger carries no request timings.'
    );
    // THE CONTROL: a report with no requests at all prints nothing, so the
    // sentence above is a disclosure about a ledger that was read, not the
    // default text of an empty one.
    expect(
      latencyLine(proxyReport({ windows: [proxyWindow({ requests: 0 })] }))
    ).toBe('');
  });
});

describe('rendering the output-token tiers', () => {
  it('names the evidence inside the sentence, not in a footnote', () => {
    const [line] = outputLines(proxyReport());
    expect(line).toContain('estimated, from requests we did not compress');
    expect(line).toContain('1,300 fewer output tokens');
    expect(line).toContain('54.2% (95% CI 31.0% to 77.3%)');
    expect(line).toContain('over 3 requests in 2 strata');
    expect(line).toContain('the band covers sampling noise');
  });

  it('prints a cost as a cost, never as a zero or a silence', () => {
    const [line] = outputLines(
      proxyReport({
        windows: [
          proxyWindow({
            outputEstimated: outputEstimate({
              tokens: -400,
              percent: -16.67,
              interval: { lowPercent: -40.2, highPercent: 6.9 },
            }),
          }),
        ],
      })
    );
    expect(line).toContain('400 more output tokens');
    expect(line).toContain('-16.7% (95% CI -40.2% to 6.9%)');
    // POSITIVE CONTROL: the saving direction reads the other way on the same
    // renderer, so `more` is not simply the only word it knows.
    expect(outputLines(proxyReport())[0]).toContain('fewer output tokens');
  });

  it('prints the measured tier only when a holdout actually ran', () => {
    expect(outputLines(proxyReport())).toHaveLength(1);
    const lines = outputLines(
      proxyReport({
        windows: [
          proxyWindow({
            outputMeasured: outputEstimate({
              evidence: OUTPUT_EVIDENCE.Measured,
              tokens: 200,
            }),
          }),
        ],
      })
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(
      "measured, from the shaper's randomized holdout"
    );
    expect(lines[1]).toContain(
      'the only output figure here that is a measurement'
    );
  });

  it('says a missing interval is missing instead of implying certainty', () => {
    const [line] = outputLines(
      proxyReport({
        windows: [
          proxyWindow({
            outputEstimated: outputEstimate({
              interval: null,
              requests: 1,
              strata: 1,
              pooledRequests: 1,
            }),
          }),
        ],
      })
    );
    expect(line).toContain('no interval: too few requests per stratum');
    expect(line).toContain('over 1 request in 1 stratum');
    expect(line).toContain('1 of those requests sit in a stratum seen once');
    // POSITIVE CONTROL: neither disclosure appears when the spread is real, so
    // they are conditional on the estimate and not pasted onto every line.
    const full = outputLines(proxyReport())[0];
    expect(full).not.toContain('no interval');
    expect(full).not.toContain('borrowed from the pool');
  });

  it('reports nothing at all when no request reached the tier', () => {
    expect(
      outputLines(
        proxyReport({
          windows: [
            proxyWindow({ outputEstimated: outputEstimate({ requests: 0 }) }),
          ],
        })
      )
    ).toEqual([]);
    // POSITIVE CONTROL: a report with no all-time window is also empty, and the
    // default report is not -- so neither emptiness is the renderer refusing
    // every input.
    expect(outputLines(proxyReport({ windows: [] }))).toEqual([]);
    expect(outputLines(proxyReport())).not.toEqual([]);
  });

  it('puts both tiers into the rendered proxy section', () => {
    const text = renderProxySavings(
      proxyReport({
        windows: [
          proxyWindow({
            outputMeasured: outputEstimate({
              evidence: OUTPUT_EVIDENCE.Measured,
            }),
          }),
        ],
      }),
      { topN: 3 }
    ).join('\n');
    expect(text).toContain('Output tokens (estimated');
    expect(text).toContain('Output tokens (measured');
  });
});

describe('rendering the output-waste tier', () => {
  it('names it waste and never converts it to tokens', () => {
    const lines = outputLines(
      proxyReport({ windows: [proxyWindow({ outputWaste: outputWasteOf() })] })
    );
    const line = lines[lines.length - 1] ?? '';
    expect(line).toContain('Output waste (observed, no counterfactual)');
    expect(line).toContain('31.3% (95% CI 21.0% to 41.4%)');
    expect(line).toContain('over 12 scanned replies');
    expect(line).toContain('Not a saving');
    // NO TOKEN FIGURE IN THIS LINE, deliberately: a share with no
    // counterfactual must not be presentable as tokens anybody saved.
    expect(line).not.toContain('token');
  });

  it('prints nothing when the opt-in scanner never ran', () => {
    expect(outputLines(proxyReport()).join('\n')).not.toContain('Output waste');
    // POSITIVE CONTROL: the same renderer does print it when there is a figure.
    expect(
      outputLines(
        proxyReport({
          windows: [proxyWindow({ outputWaste: outputWasteOf() })],
        })
      ).join('\n')
    ).toContain('Output waste');
  });

  it('omits the band rather than implying one when it has no spread', () => {
    const lines = outputLines(
      proxyReport({
        windows: [
          proxyWindow({
            outputWaste: outputWasteOf({ interval: null, requests: 1 }),
          }),
        ],
      })
    );
    const line = lines[lines.length - 1] ?? '';
    expect(line).not.toContain('95% CI');
    expect(line).toContain('over 1 scanned reply');
  });
});

/**
 * THE PROMPT-SIDE LINE, WHOSE WHOLE JOB IS TO NOT BE READ AS AN OUTPUT SAVING
 * AND TO NOT BE ADDED TO THE HEADLINE. It is the tool-deferral holdout's
 * figure: input tokens, measured by the provider, confirming part of a saving
 * the table above already counted.
 */
describe('the deferral holdout line', () => {
  const windowWith = (estimate: OutputSavingsEstimate | null) =>
    proxyReport({ windows: [proxyWindow({ deferralMeasured: estimate })] });

  it('says prompt tokens, never output tokens', () => {
    const line = deferralLine(
      windowWith(
        outputEstimate({ evidence: OUTPUT_EVIDENCE.Measured, tokens: 6284 })
      )
    );
    expect(line).toContain('6,284 fewer prompt tokens');
    // THE FAILURE THIS FORBIDS IS A TEMPLATE TELLING A LIE. The formatter had
    // the word `output` welded into its sentence, so routing a prompt-side
    // figure through it would have printed "6,284 fewer output tokens" --
    // a false statement about the other half of the bill, produced by nobody.
    expect(line).not.toContain('output');
    // POSITIVE CONTROL: the output tiers still say output through the same
    // formatter, so the word was parameterized rather than deleted.
    expect(outputLines(proxyReport({ windows: [proxyWindow()] }))[0]).toContain(
      'output tokens'
    );
  });

  it('names itself a confirmation rather than an addition', () => {
    const line = deferralLine(
      windowWith(outputEstimate({ evidence: OUTPUT_EVIDENCE.Measured }))
    );
    expect(line).toContain('tool-deferral holdout');
    expect(line).toContain('confirms part of the saving already counted above');
  });

  it('prints nothing when no holdout ran', () => {
    // SILENCE, NOT A ZERO. A holdout costs its control arm real money and is
    // off by default, so the usual state is no experiment -- and an operator
    // who never started one must not read a line saying deferral saved
    // nothing.
    expect(deferralLine(windowWith(null))).toBe('');
    // POSITIVE CONTROL: the same report with an estimate does print.
    expect(deferralLine(windowWith(outputEstimate()))).not.toBe('');
  });

  it('prints nothing when the arms exist but hold no requests', () => {
    expect(deferralLine(windowWith(outputEstimate({ requests: 0 })))).toBe('');
  });

  it('reaches the rendered proxy section', () => {
    const lines = renderProxySavings(
      windowWith(outputEstimate({ evidence: OUTPUT_EVIDENCE.Measured })),
      { topN: 3 }
    );
    expect(lines.some((line) => line.includes('tool-deferral holdout'))).toBe(
      true
    );
    // POSITIVE CONTROL: it is absent from the same section without the figure.
    const without = renderProxySavings(windowWith(null), { topN: 3 });
    expect(without.some((line) => line.includes('tool-deferral holdout'))).toBe(
      false
    );
  });
});

describe('withheldLine', () => {
  it('names how much the arm held back, over how many requests', () => {
    const line = withheldLine(
      proxyReport({
        windows: [proxyWindow({ requests: 1323, withheldUnits: 75 })],
      })
    );
    expect(line).toContain('75');
    expect(line).toContain('1,323');
  });

  it('says nothing when the arm held nothing back', () => {
    // SILENT RATHER THAN ZERO. The arm is opt-in, so "0 units withheld" would
    // appear on every report of every operator who never enabled it -- saying
    // nothing and training people to skip the section it sits in.
    expect(
      withheldLine(
        proxyReport({
          windows: [proxyWindow({ requests: 1323, withheldUnits: 0 })],
        })
      )
    ).toBe('');
  });

  it('says nothing when there is no all-time window', () => {
    expect(withheldLine(proxyReport({ windows: [] }))).toBe('');
  });

  it('does not claim a saving', () => {
    // THE RESTRAINT IS THE POINT. What withholding is worth depends on how
    // often the content is asked for again, and that rate is not in this
    // ledger -- retrievals arrive as tool results and are counted on the
    // telemetry rollup. A dollar figure here would be a projection dressed as
    // a measurement, so the line states the limit instead.
    const line = withheldLine(
      proxyReport({
        windows: [proxyWindow({ requests: 100, withheldUnits: 10 })],
      })
    );
    expect(line).not.toMatch(/\$/);
    expect(line).toContain('depends on how often');
  });
});
