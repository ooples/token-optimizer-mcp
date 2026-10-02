/**
 * The flat table, checked for the four things a spreadsheet can get wrong.
 *
 * Does a cell say what the report said; does an unmeasured figure stay empty
 * rather than becoming a zero somebody then sums; does a name out of recorded
 * traffic stay text rather than becoming a formula; and does the proxy half
 * appear only when its ledger was actually read.
 */

import { describe, expect, it } from '@jest/globals';
import { main, SAVINGS_FORMAT } from '../../../src/savings/cli.js';
import {
  csvCell,
  CSV_FIELDS,
  CSV_SECTION,
  CSV_SOURCE,
  renderSavingsCsv,
  savingsCsvRows,
} from '../../../src/savings/csv.js';
import { buildReport } from '../../../src/savings/windows.js';
import {
  createProxyAggregator,
  PROXY_INPUT,
  type ProxyInput,
} from '../../../src/savings/proxy.js';
import type { AccountingRecord } from '../../../src/proxy/accounting.js';
import type { AnalyticsEntry } from '../../../src/analytics/analytics-types.js';

const NOT_CONFIGURED: ProxyInput = { kind: PROXY_INPUT.NotConfigured };

function verified(over: Partial<AnalyticsEntry> = {}): AnalyticsEntry {
  const id = String(over.measurementId ?? 'm-1');
  return {
    hookPhase: 'PostToolUse',
    toolName: 'smart_read',
    mcpServer: 'token-optimizer',
    originalTokens: 1000,
    optimizedTokens: 400,
    tokensSaved: 600,
    timestamp: new Date().toISOString(),
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

function proxyRead(records: readonly AccountingRecord[]): ProxyInput {
  const aggregator = createProxyAggregator();
  for (const record of records) aggregator.add(record);
  return {
    kind: PROXY_INPUT.Read,
    path: '/tmp/ledger.jsonl',
    report: aggregator.report(),
  };
}

/** One proxied request that saved 750 of 1000 prompt tokens on a priced model. */
function proxyRecord(over: Partial<AccountingRecord> = {}): AccountingRecord {
  return {
    ts: new Date().toISOString(),
    method: 'POST',
    path: '/v1/chat/completions',
    status: 200,
    model: 'gpt-5.6-sol',
    beforeBytes: 4000,
    afterBytes: 1000,
    usage: { input_tokens: 240 },
    tokens: {
      measured: true,
      beforeTokens: 1000,
      afterTokens: 250,
      method: 'tiktoken-gpt-4-compatible-local-estimate',
    },
    ...over,
  } as AccountingRecord;
}

const cells = (line: string): readonly string[] => line.split(',');
const column = (lines: readonly string[], name: string): readonly string[] => {
  const at = CSV_FIELDS.indexOf(name as (typeof CSV_FIELDS)[number]);
  expect(at).toBeGreaterThanOrEqual(0);
  return lines.slice(1).map((line) => cells(line)[at]);
};

describe('a cell', () => {
  it('encodes per RFC 4180, and tells nothing from zero', () => {
    expect(csvCell('claude-opus-5')).toBe('claude-opus-5');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(12.5)).toBe('12.5');
    // THE DISTINCTION THIS FORMAT EXISTS TO KEEP. An unpriced window has no
    // dollar figure; writing 0 would be a measurement nobody made.
    expect(csvCell(null)).toBe('');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(' padded ')).toBe('" padded "');
  });

  it('keeps a name that opens like a formula as text', () => {
    // A model or client name comes out of recorded traffic, and a spreadsheet
    // EXECUTES a cell that opens with one of these.
    for (const lead of ['=', '+', '-', '@']) {
      expect(csvCell(`${lead}cmd()`)).toBe(`'${lead}cmd()`);
    }
    // A tab needs the guard but not the quotes: RFC 4180 quotes a comma, a
    // double quote and a line break, and nothing else.
    expect(csvCell('\tcmd')).toBe("'\tcmd");
    expect(csvCell('\rcmd')).toBe('"\'\rcmd"');
    // THE CONTROL: an ordinary name is not touched, so the guard above is not
    // simply prefixing everything.
    expect(csvCell('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(csvCell('(unattributed)')).toBe('(unattributed)');
  });
});

describe('the flat table', () => {
  it('leads with the column order and writes one line per row', () => {
    const report = buildReport([verified()], new Date(), []);
    const lines = renderSavingsCsv(report, NOT_CONFIGURED);
    expect(lines[0]).toBe(CSV_FIELDS.join(','));
    expect(lines).toHaveLength(
      savingsCsvRows(report, NOT_CONFIGURED).length + 1
    );
    // EVERY LINE HAS EVERY COLUMN, which is what a reader addressing cells by
    // header name depends on and what a dropped null would break.
    for (const line of lines) {
      expect(cells(line)).toHaveLength(CSV_FIELDS.length);
    }
  });

  it('copies the figures the report computed, rather than recomputing them', () => {
    const report = buildReport([verified()], new Date(), []);
    const rows = savingsCsvRows(report, NOT_CONFIGURED);
    const windows = rows.filter((row) => row.section === CSV_SECTION.Window);
    expect(windows).toHaveLength(report.windows.length);
    for (const [at, window] of report.windows.entries()) {
      expect(windows[at]).toMatchObject({
        source: CSV_SOURCE.Mcp,
        name: window.label,
        since: window.since,
        operations: window.operations,
        tokens_before: window.tokensBefore,
        tokens_saved: window.tokensSaved,
        savings_percent: window.savingsPercent,
        cost_usd: window.costUsd,
      });
    }
  });

  it('leaves a breakdown row empty where a group has no such figure', () => {
    const report = buildReport([verified()], new Date(), []);
    const rows = savingsCsvRows(report, NOT_CONFIGURED);
    const model = rows.find((row) => row.section === CSV_SECTION.ByModel);
    expect(model?.name).toBe('claude-opus-5');
    // A GROUP SPANS EVERY WINDOW, so it has no opening instant -- an empty
    // cell, not a zero and not a borrowed window's.
    expect(model?.since).toBeNull();
    // THE CONTROL: the figures a group does have are present and non-zero, so
    // the null above is not simply an unpopulated row. The before-state is
    // among them: a group carries the denominator of the same rows its saving
    // came from, which is what lets a client be held to a percentage.
    expect(model?.tokens_before).toBe(1000);
    expect(model?.savings_percent).toBe(60);
    expect(model?.tokens_saved).toBe(600);
    expect(model?.operations).toBe(1);
    const client = rows.find((row) => row.section === CSV_SECTION.ByClient);
    expect(client?.name).toBe('claude-code');
  });
});

describe('the proxy half', () => {
  it('appears only when its ledger was read', () => {
    const report = buildReport([verified()], new Date(), []);
    const absent = savingsCsvRows(report, NOT_CONFIGURED);
    expect(absent.some((row) => row.source === CSV_SOURCE.Proxy)).toBe(false);
    expect(
      savingsCsvRows(report, {
        kind: PROXY_INPUT.Unreadable,
        path: '/tmp/ledger.jsonl',
        reason: 'ENOENT',
      }).some((row) => row.source === CSV_SOURCE.Proxy)
    ).toBe(false);
    // A ROW OF ZEROS WOULD READ AS A MEASURED ZERO once it is in a
    // spreadsheet, so an unread ledger contributes nothing at all -- and the
    // read one has to contribute something, or this assertion proves nothing.
    const present = savingsCsvRows(report, proxyRead([proxyRecord()]));
    const proxied = present.filter((row) => row.source === CSV_SOURCE.Proxy);
    expect(proxied.length).toBeGreaterThan(0);
    expect(
      proxied.find((row) => row.section === CSV_SECTION.ByModel)?.name
    ).toBe('gpt-5.6-sol');
  });

  it('reports a proxied request at the counted-request grain', () => {
    const report = buildReport([], new Date(), []);
    const rows = savingsCsvRows(report, proxyRead([proxyRecord()]));
    const all = rows.find(
      (row) => row.source === CSV_SOURCE.Proxy && row.since === null
    );
    // The all-time window: one counted request, 750 of 1000 prompt tokens.
    expect(all?.operations).toBe(1);
    expect(all?.tokens_before).toBe(1000);
    expect(all?.tokens_saved).toBe(750);
  });
});

describe('the command', () => {
  it('writes the table for --format csv and nothing else', async () => {
    let text = '';
    const status = await main(['--format', SAVINGS_FORMAT.Csv], {
      analytics: async () => ({ entries: [verified()], rollups: [] }),
      proxy: async () => proxyRead([proxyRecord()]),
      write: (chunk: string) => {
        text += chunk;
      },
    });
    expect(status).toBe(0);
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toBe(CSV_FIELDS.join(','));
    // NO PROSE AROUND THE TABLE. The notes, the price-table warning and the
    // advice all belong to the text rendering; a parser gets columns only.
    for (const line of lines) {
      expect(cells(line)).toHaveLength(CSV_FIELDS.length);
    }
    expect(column(lines, 'source')).toContain(CSV_SOURCE.Proxy);
    expect(text).not.toContain('No verified');
  });

  it('answers an empty store with a header and no rows', async () => {
    let text = '';
    const status = await main(['--format', 'csv'], {
      analytics: async () => ({ entries: [], rollups: [] }),
      proxy: async () => NOT_CONFIGURED,
      write: (chunk: string) => {
        text += chunk;
      },
    });
    expect(status).toBe(0);
    // THE HEADER STAYS THE HEADER so a stored series can be appended to, and
    // the advice the text rendering prints here is not a row.
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toBe(CSV_FIELDS.join(','));
    expect(lines.filter((line) => line.length > 0)).toHaveLength(1);
    expect(text).not.toContain('Nothing has been recorded');
  });
});

describe('the measurable-half rule', () => {
  it('withholds the MCP half when nothing has a provable before-state', () => {
    const unproven = verified({ savingsMeasured: false, metadata: {} });
    const report = buildReport([unproven], new Date(), []);
    expect(report.totalEntries).toBe(1);
    expect(report.eligibleEntries).toBe(0);
    expect(savingsCsvRows(report, NOT_CONFIGURED)).toHaveLength(0);
    // THE CONTROL: the same shape of row WITH a before-state does appear, so
    // the refusal above is about the measurement and not about the fixture.
    expect(
      savingsCsvRows(buildReport([verified()], new Date(), []), NOT_CONFIGURED)
        .length
    ).toBeGreaterThan(0);
  });

  it('keeps the proxy half when only the MCP half is unmeasured', () => {
    // A FRESH INSTALL THAT ROUTED EVERYTHING THROUGH THE PROXY. Withholding
    // the whole table here would be the defect the text rendering already had.
    const rows = savingsCsvRows(
      buildReport([], new Date(), []),
      proxyRead([proxyRecord()])
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.source === CSV_SOURCE.Proxy)).toBe(true);
  });

  it('writes nested windows, which a reader must not sum', () => {
    const report = buildReport([verified()], new Date(), []);
    const windows = savingsCsvRows(report, NOT_CONFIGURED).filter(
      (row) => row.section === CSV_SECTION.Window
    );
    const allTime = windows.find((row) => row.since === null);
    const summed = windows.reduce(
      (total, row) => total + Number(row.tokens_saved ?? 0),
      0
    );
    // One operation, counted once per window it falls inside: the sum is a
    // multiple of the all-time figure, which is why the header note says so.
    expect(allTime?.tokens_saved).toBe(600);
    expect(summed).toBe(600 * windows.length);
  });
});
