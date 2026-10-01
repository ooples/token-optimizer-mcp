/**
 * The CLI is driven through its injected dependencies, so these tests prove
 * the argument contract, the exit statuses and what reaches the operator's
 * screen -- never the analytics database, which no test here opens.
 */

import { main, parseArguments, savingsJson } from '../../../src/savings/cli.js';
import { buildReport } from '../../../src/savings/windows.js';
import {
  createProxyAggregator,
  PROXY_INPUT,
  type ProxyInput,
} from '../../../src/savings/proxy.js';
import type { AccountingRecord } from '../../../src/proxy/accounting.js';
import type { AnalyticsEntry } from '../../../src/analytics/analytics-types.js';
import { MODEL_PRICE_CATALOG } from '../../../src/analytics/provider-pricing.js';
import { OPERATOR_PRICE_TABLE_ENV } from '../../../src/analytics/operator-prices.js';

// Ids this file relies on being absent from the price catalog, guarded by the
// last block below. They used to be real model ids the catalog had not been
// widened to yet, which made every "unpriced" assertion here pass for the
// wrong reason the moment it was.
const UNPRICED_OPENAI = 'gpt-0-not-a-model';
const UNPRICED_GEMINI = 'gemini-0-not-a-model';

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

function proxyRead(
  records: readonly AccountingRecord[],
  path = '/tmp/ledger.jsonl'
): ProxyInput {
  const aggregator = createProxyAggregator();
  for (const record of records) aggregator.add(record);
  return { kind: PROXY_INPUT.Read, path, report: aggregator.report() };
}

/**
 * THE PROXY STATE IS ALWAYS INJECTED, never taken from the environment: the
 * host may well have `TOKEN_OPTIMIZER_PROXY_ACCOUNTING` set, and a test that
 * read it would fold a developer's own traffic into its assertions.
 */
function harness(
  over: {
    entries?: readonly AnalyticsEntry[];
    fail?: Error;
    now?: Date;
    proxy?: ProxyInput;
  } = {}
) {
  let text = '';
  return {
    text: () => text,
    deps: {
      entries: async () => {
        if (over.fail) throw over.fail;
        return over.entries ?? [];
      },
      now: () => over.now ?? new Date(),
      proxy: async () => over.proxy ?? { kind: PROXY_INPUT.NotConfigured },
      write: (chunk: string) => {
        text += chunk;
      },
    },
  };
}

describe('parseArguments', () => {
  it('defaults to ten rows, text output and no help', () => {
    expect(parseArguments([])).toEqual({
      topN: 10,
      json: false,
      help: false,
    });
  });

  it('accepts --top with a positive whole number', () => {
    expect(parseArguments(['--top', '3'])).toMatchObject({ topN: 3 });
  });

  it('refuses --top with no value rather than silently using the default', () => {
    expect(parseArguments(['--top'])).toBe(
      '--top needs a positive whole number'
    );
  });

  it('reads a following flag as a missing value, not as the value', () => {
    expect(parseArguments(['--top', '--json'])).toBe(
      '--top needs a positive whole number'
    );
  });

  it('refuses zero, a negative and a fraction', () => {
    for (const bad of ['0', '-4', '2.5']) {
      expect(parseArguments(['--top', bad])).toBe(
        '--top needs a positive whole number'
      );
    }
    // Positive control: the same flag with a good value is accepted, so the
    // refusals above are about the values and not about the flag being broken.
    expect(parseArguments(['--top', '4'])).toMatchObject({ topN: 4 });
  });

  it('names an unknown argument instead of ignoring it', () => {
    expect(parseArguments(['--week'])).toBe('unknown argument: --week');
  });

  it('takes a proxy ledger path, and refuses the flag with no path', () => {
    expect(parseArguments(['--proxy-ledger', 'x.jsonl'])).toMatchObject({
      proxyLedger: 'x.jsonl',
    });
    expect(parseArguments(['--proxy-ledger'])).toBe(
      '--proxy-ledger needs a path'
    );
    expect(parseArguments(['--proxy-ledger', '--json'])).toBe(
      '--proxy-ledger needs a path'
    );
  });

  it('leaves the ledger unset by default, so the environment decides', () => {
    const parsed = parseArguments([]);
    expect(typeof parsed).not.toBe('string');
    expect(parsed).not.toHaveProperty('proxyLedger');
  });

  it('takes --json and --help', () => {
    expect(parseArguments(['--json'])).toMatchObject({ json: true });
    expect(parseArguments(['--help'])).toMatchObject({ help: true });
    expect(parseArguments(['-h'])).toMatchObject({ help: true });
  });
});

describe('main', () => {
  it('prints a refusal above the usage and exits 2', async () => {
    const { text, deps } = harness();
    const code = await main(['--week'], deps);
    expect(code).toBe(2);
    const lines = text().trimEnd().split('\n');
    expect(lines[0]).toBe('token-optimizer-savings: unknown argument: --week');
    expect(lines.findIndex((l) => l.startsWith('usage:'))).toBeGreaterThan(0);
  });

  it('prints usage for --help, exits 0 and reads no analytics', async () => {
    let asked = 0;
    const { text, deps } = harness();
    const code = await main(['--help'], {
      ...deps,
      entries: async () => {
        asked++;
        return [];
      },
    });
    expect(code).toBe(0);
    expect(asked).toBe(0);
    expect(text()).toContain('usage: token-optimizer-savings');
    // The help text names BOTH inputs, so a reader knows what is counted
    // before they run anything and misread the answer.
    expect(text()).toContain('MCP analytics database');
    expect(text()).toContain('TOKEN_OPTIMIZER_PROXY_ACCOUNTING');
    expect(text()).toContain('--proxy-ledger');
  });

  it('names the reason when analytics cannot be read, and exits 1', async () => {
    const { text, deps } = harness({
      fail: new Error('SQLITE_CANTOPEN: unable to open database file'),
    });
    const code = await main([], deps);
    expect(code).toBe(1);
    expect(text()).toContain('could not read analytics');
    expect(text()).toContain('SQLITE_CANTOPEN');
  });

  it('treats a ledger with nothing in it as a working install, not a failure', async () => {
    const { text, deps } = harness({ entries: [] });
    const code = await main([], deps);
    expect(code).toBe(0);
    expect(text()).toContain('No verified MCP savings recorded yet.');
    expect(text()).toContain('Nothing has been recorded');
  });

  it('separates "nothing recorded" from "nothing measurable"', async () => {
    const { text, deps } = harness({
      entries: [
        {
          hookPhase: 'PostToolUse',
          toolName: 'smart_read',
          mcpServer: 'token-optimizer',
          originalTokens: 10,
          optimizedTokens: 5,
          tokensSaved: 5,
          timestamp: new Date().toISOString(),
        },
      ],
    });
    const code = await main([], deps);
    expect(code).toBe(0);
    expect(text()).toContain('1 operation was recorded, none with a provable');
    expect(text()).not.toContain('Nothing has been recorded');
  });
});

describe('the rendered report', () => {
  it('shows the windows, the breakdowns and the scope note', async () => {
    const { text, deps } = harness({ entries: [verified()] });
    const code = await main([], deps);
    expect(code).toBe(0);
    const out = text();
    expect(out).toContain('Today');
    expect(out).toContain('Last 7 days');
    expect(out).toContain('All time');
    expect(out).toContain('claude-opus-5');
    expect(out).toContain('claude-code');
    // The inputs block replaced a note disclaiming the proxy's absence; with no
    // ledger configured it says so, and says what to set.
    expect(out).toContain('Inputs:');
    expect(out).toContain('MCP tool traffic');
    expect(out).toContain('TOKEN_OPTIMIZER_PROXY_ACCOUNTING');
  });

  it('honours --top across both breakdowns', async () => {
    const entries = ['a', 'b', 'c'].map((n, i) =>
      verified({
        measurementId: n,
        model: `model-${n}`,
        client: `client-${n}`,
        originalTokens: 1000 * (i + 1),
        optimizedTokens: 100,
        tokensSaved: 1000 * (i + 1) - 100,
      })
    );
    const { text, deps } = harness({ entries });
    expect(await main(['--top', '1'], deps)).toBe(0);
    expect(text()).toContain('and 2 more rows');
    // ASSERTED ON THE BREAKDOWN LINES, not on the whole report. `--top` governs
    // how many rows the table prints; it does not govern the unpriced-model
    // note, which names every such model precisely BECAUSE a truncated table
    // is where one would otherwise disappear.
    const rows = text()
      .split(String.fromCharCode(10))
      .filter((line) => line.startsWith('  model-'));
    expect(rows.some((line) => line.includes('model-c'))).toBe(true);
    expect(rows.some((line) => line.includes('model-a'))).toBe(false);
    // And the truncated row is still accounted for, by name, below the table:
    // none of these three models is in the catalog.
    expect(text()).toContain('model-a, model-b, model-c');
  });

  it('emits parseable JSON that carries both definitions it depends on', async () => {
    const { text, deps } = harness({ entries: [verified()] });
    expect(await main(['--json'], deps)).toBe(0);
    const parsed = JSON.parse(text());
    expect(parsed.scope).toBe('mcp-tool-traffic');
    expect(parsed.proxy.state).toBe('not-configured');
    expect(parsed.proxy.path).toBeNull();
    expect(parsed.windows).toHaveLength(4);
    expect(parsed.windows[3].label).toBe('All time');
    expect(parsed.measurement.windows).toContain('not a partition');
    expect(parsed.pricing.definition).toContain('left unpriced');
    expect(parsed.byModel[0].name).toBe('claude-opus-5');
  });

  it('emits JSON for an empty ledger instead of the prose refusal', async () => {
    const { text, deps } = harness({ entries: [] });
    expect(await main(['--json'], deps)).toBe(0);
    const parsed = JSON.parse(text());
    expect(parsed.totalEntries).toBe(0);
    expect(parsed.eligibleEntries).toBe(0);
    expect(parsed.windows).toHaveLength(4);
  });

  it('uses the injected clock, so "today" is not the machine clock', async () => {
    // The row is stamped now; a clock a year on must find it in all time only.
    const future = new Date();
    future.setFullYear(future.getFullYear() + 1);
    const { text, deps } = harness({ entries: [verified()], now: future });
    expect(await main(['--json'], deps)).toBe(0);
    const parsed = JSON.parse(text());
    expect(parsed.windows[0].eligibleOperations).toBe(0);
    expect(parsed.windows[3].eligibleOperations).toBe(1);
  });
});

describe('savingsJson', () => {
  it('reports the same figures the text rendering is built from', () => {
    const report = buildReport([verified()], new Date());
    const json = savingsJson(report, { kind: PROXY_INPUT.NotConfigured });
    expect(json.windows).toBe(report.windows);
    expect(json.byModel).toBe(report.byModel);
    expect(json.totalEntries).toBe(1);
  });

  it('reports where the operator table was read and what it contributed', () => {
    // A CONSUMER HAS TO BE ABLE TO TELL THE TWO SOURCES APART. Folding an
    // operator-supplied rate into the same column as a rate we can cite, with
    // nothing in the document saying which is which, is the exact confusion
    // this whole table was built to avoid.
    const report = buildReport([verified()], new Date());
    const json = savingsJson(report, { kind: PROXY_INPUT.NotConfigured }, {
      path: '/rates.json',
      contracts: 3,
      error: null,
    });
    expect(json.pricing.operatorTable.env).toBe(OPERATOR_PRICE_TABLE_ENV);
    expect(json.pricing.operatorTable.path).toBe('/rates.json');
    expect(json.pricing.operatorTable.contracts).toBe(3);
    expect(json.pricing.operatorTable.error).toBeNull();
  });

  it('reports a refused table as a refusal, not as an absent one', () => {
    // The two states produce the same money -- none from the table -- and a
    // document that cannot distinguish them hides a typo in the path as
    // nothing at all.
    const report = buildReport([verified()], new Date());
    const refused = savingsJson(report, { kind: PROXY_INPUT.NotConfigured }, {
      path: '/rates.json',
      contracts: 0,
      error: 'models[0] (x): "output" must be a number',
    });
    expect(refused.pricing.operatorTable.error).toContain('"output"');
    expect(refused.pricing.operatorTable.contracts).toBe(0);
    // Positive control: no table named reads as no path AND no error.
    const none = savingsJson(report, { kind: PROXY_INPUT.NotConfigured }, {
      path: null,
      contracts: 0,
      error: null,
    });
    expect(none.pricing.operatorTable.path).toBeNull();
    expect(none.pricing.operatorTable.error).toBeNull();
  });
});

describe('the proxy as a second input', () => {
  it('prints a proxy section with its own windows and model rows', async () => {
    const { text, deps } = harness({
      entries: [verified()],
      proxy: proxyRead([proxyRecord()]),
    });
    expect(await main([], deps)).toBe(0);
    const out = text();
    expect(out).toContain('Proxy wire traffic');
    expect(out).toContain('gpt-5.6-sol');
    // Positive control: the MCP section is still there, so the two sections are
    // additions to each other and not one replacing the other.
    expect(out).toContain('MCP tool traffic');
    expect(out).toContain('claude-opus-5');
  });

  it('prints the proxy section even when no MCP row is measurable', async () => {
    // THE DEFECT THIS FEATURE EXISTS FOR. An install that routes everything
    // through the proxy has no analytics rows at all, and the old command
    // answered it with a flat "nothing recorded".
    const { text, deps } = harness({
      entries: [],
      proxy: proxyRead([proxyRecord()]),
    });
    expect(await main([], deps)).toBe(0);
    const out = text();
    expect(out).toContain('No verified MCP savings recorded yet.');
    expect(out).toContain('Proxy wire traffic');
    expect(out).toContain('750 / 1,000');
  });

  it('names each state of the ledger it could not read', async () => {
    const states: readonly [ProxyInput, string][] = [
      [{ kind: PROXY_INPUT.NotConfigured }, 'not configured'],
      [
        { kind: PROXY_INPUT.Missing, path: '/l.jsonl' },
        'nothing written there yet',
      ],
      [
        { kind: PROXY_INPUT.Unreadable, path: '/l.jsonl', reason: 'EACCES' },
        'could not be read: EACCES',
      ],
    ];
    for (const [proxy, expected] of states) {
      const { text, deps } = harness({ entries: [verified()], proxy });
      expect(await main([], deps)).toBe(0);
      expect(text()).toContain(expected);
      expect(text()).not.toContain('Proxy wire traffic  /l.jsonl -- 1');
    }
    // Positive control: a ledger that WAS read reports what it held instead.
    const { text, deps } = harness({
      entries: [verified()],
      proxy: proxyRead([proxyRecord()], '/l.jsonl'),
    });
    expect(await main([], deps)).toBe(0);
    expect(text()).toContain('/l.jsonl -- 1 request read, 1 measurable');
  });
});

describe('the proxy in the JSON', () => {
  it('carries the unpriced models on both halves, separately', async () => {
    // A CONSUMER HAS TO BE ABLE TO TELL WHICH HALF LOST THE PRICE, since the
    // two read different sources and only one of them may be missing an entry.
    const { text, deps } = harness({
      entries: [verified({ model: UNPRICED_GEMINI })],
      proxy: proxyRead([proxyRecord({ model: UNPRICED_OPENAI })], '/l.jsonl'),
    });
    expect(await main(['--json'], deps)).toBe(0);
    const parsed = JSON.parse(text());
    expect(parsed.unpricedModels).toEqual([UNPRICED_GEMINI]);
    expect(parsed.proxy.unpricedModels).toEqual([UNPRICED_OPENAI]);
  });

  it('widens the scope and carries the proxy figures and definitions', async () => {
    const { text, deps } = harness({
      entries: [verified()],
      proxy: proxyRead([proxyRecord()], '/l.jsonl'),
    });
    expect(await main(['--json'], deps)).toBe(0);
    const parsed = JSON.parse(text());
    expect(parsed.scope).toBe('mcp-tool-traffic+proxy-wire-traffic');
    expect(parsed.proxy.state).toBe('read');
    expect(parsed.proxy.path).toBe('/l.jsonl');
    expect(parsed.proxy.windows[3].tokensSaved).toBe(750);
    expect(parsed.proxy.measurement.pricing).toContain('tiered rate');
    expect(parsed.proxy.measurement.calibration).toContain('never averaged');
  });

  it('carries the reason a ledger could not be read, and no figures', async () => {
    const { text, deps } = harness({
      entries: [verified()],
      proxy: {
        kind: PROXY_INPUT.Unreadable,
        path: '/l.jsonl',
        reason: 'EACCES: permission denied',
      },
    });
    expect(await main(['--json'], deps)).toBe(0);
    const parsed = JSON.parse(text());
    expect(parsed.scope).toBe('mcp-tool-traffic');
    expect(parsed.proxy.reason).toContain('EACCES');
    expect(parsed.proxy.windows).toBeUndefined();
    // Positive control: a read ledger on the same path does carry them.
    const second = harness({
      entries: [verified()],
      proxy: proxyRead([proxyRecord()], '/l.jsonl'),
    });
    expect(await main(['--json'], second.deps)).toBe(0);
    expect(JSON.parse(second.text()).proxy.windows).toHaveLength(4);
  });

  it('passes --proxy-ledger through to the loader, overriding the default', async () => {
    const seen: (string | undefined)[] = [];
    const { deps } = harness({ entries: [verified()] });
    const spy = {
      ...deps,
      proxy: async (path: string | undefined) => {
        seen.push(path);
        return { kind: PROXY_INPUT.NotConfigured } as ProxyInput;
      },
    };
    expect(await main(['--proxy-ledger', '/given.jsonl'], spy)).toBe(0);
    expect(await main([], spy)).toBe(0);
    expect(seen).toEqual(['/given.jsonl', undefined]);
  });
});

describe('the ids these fixtures rely on being absent', () => {
  it('names models the catalog really does not carry', () => {
    for (const id of [UNPRICED_OPENAI, UNPRICED_GEMINI]) {
      expect(MODEL_PRICE_CATALOG.some((row) => row.model === id)).toBe(false);
    }
    // The positive control: the ids they are contrasted with ARE priced.
    for (const id of ['gpt-5.6-sol', 'claude-opus-5']) {
      expect(MODEL_PRICE_CATALOG.some((row) => row.model === id)).toBe(true);
    }
  });
});
