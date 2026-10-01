/**
 * The CLI is driven through its injected dependencies, so these tests prove
 * the argument contract, the exit statuses and what reaches the operator's
 * screen -- never the analytics database, which no test here opens.
 */

import { main, parseArguments, savingsJson } from '../../../src/savings/cli.js';
import { buildReport } from '../../../src/savings/windows.js';
import type { AnalyticsEntry } from '../../../src/analytics/analytics-types.js';

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

function harness(
  over: {
    entries?: readonly AnalyticsEntry[];
    fail?: Error;
    now?: Date;
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
    // The help text names the scope, so a reader learns what is NOT counted
    // before they run anything and misread the answer.
    expect(text()).toContain('token-optimizer-proxy');
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
    expect(text()).toContain('No verified savings recorded yet.');
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
    expect(out).toContain('token-optimizer-inspect');
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
    expect(text()).toContain('model-c');
    expect(text()).not.toContain('model-a');
  });

  it('emits parseable JSON that carries both definitions it depends on', async () => {
    const { text, deps } = harness({ entries: [verified()] });
    expect(await main(['--json'], deps)).toBe(0);
    const parsed = JSON.parse(text());
    expect(parsed.scope).toBe('mcp-tool-traffic');
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
    const json = savingsJson(report);
    expect(json.windows).toBe(report.windows);
    expect(json.byModel).toBe(report.byModel);
    expect(json.totalEntries).toBe(1);
  });
});
