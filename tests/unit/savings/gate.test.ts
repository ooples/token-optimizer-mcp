/**
 * A GATE THAT CANNOT FAIL IS NOT A GATE.
 *
 * This is a check an operator wires into CI and then stops reading, so the only
 * thing that matters is whether it refuses the cases it is supposed to refuse.
 * Four questions, and every one of them has a failing arm here -- a fixture
 * built only from passing arms would leave the refusal paths untested, which is
 * the one defect in a gate that nobody notices until it has been green for a
 * month over traffic it never measured.
 *
 *   Does a half that measured nothing fail, rather than passing at 0 >= 0?
 *
 *   Are the two halves held to the target separately, so a good MCP figure
 *   cannot carry a bad wire figure (or the reverse)?
 *
 *   Does a required client that recorded nothing in the window fail, and is it
 *   told apart from one that recorded traffic and did not save enough?
 *
 *   Is the window the operator named the window that was measured?
 */

import { describe, expect, it } from '@jest/globals';
import {
  GATE_REASON,
  GATE_SCOPE,
  GATE_WINDOW,
  evaluateGate,
  gateJson,
  renderGate,
  type GateVerdict,
} from '../../../src/savings/gate.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProxyAggregator,
  PROXY_INPUT,
  type ProxyInput,
} from '../../../src/savings/proxy.js';
import type { AccountingRecord } from '../../../src/proxy/accounting.js';
import type { AnalyticsEntry } from '../../../src/analytics/analytics-types.js';

const NOW = new Date(2026, 9, 1, 12, 0, 0);

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

const NOT_CONFIGURED: ProxyInput = { kind: PROXY_INPUT.NotConfigured };

const METHOD = 'tiktoken-gpt-4-compatible-local-estimate';

/** A billed, counted ledger row -- the proxy half's own fixture shape. */
function record(beforeTokens: number, afterTokens: number): AccountingRecord {
  return {
    ts: NOW.toISOString(),
    path: '/v1/messages',
    status: 200,
    compressed: true,
    beforeBytes: beforeTokens * 4,
    afterBytes: afterTokens * 4,
    model: 'claude-opus-5',
    usage: { input_tokens: beforeTokens },
    tokens: { measured: true, beforeTokens, afterTokens, method: METHOD },
  };
}

/**
 * A READ ledger, built by the aggregator the product uses.
 *
 * NOT A HAND-WRITTEN REPORT OBJECT. A literal cast to the report type would
 * keep compiling after the real windows gained a field, and the gate would then
 * be tested against a shape the proxy no longer produces.
 */
function wire(records: readonly AccountingRecord[]): ProxyInput {
  const aggregator = createProxyAggregator(NOW);
  for (const one of records) aggregator.add(one);
  return {
    kind: PROXY_INPUT.Read,
    path: join(tmpdir(), 'gate-ledger.jsonl'),
    report: aggregator.report(),
  };
}

/** The whole evaluation, with the MCP rows and the proxy state handed in. */
function gate(
  entries: readonly AnalyticsEntry[],
  proxy: ProxyInput,
  over: Partial<Parameters<typeof evaluateGate>[1]> = {}
): GateVerdict {
  return evaluateGate(
    { entries, rollups: [], proxy, now: NOW },
    {
      targetPercent: 50,
      window: GATE_WINDOW.SevenDays,
      clients: [],
      ...over,
    }
  );
}

/** The one check with this scope, or the one naming this client. */
function only(
  verdict: GateVerdict,
  scope: string,
  name: string | null = null
): GateVerdict['checks'][number] {
  const found = verdict.checks.filter(
    (one) => one.scope === scope && (name === null || one.name === name)
  );
  expect(found).toHaveLength(1);
  return found[0];
}

describe('an unmeasured half fails rather than passing at zero', () => {
  it('fails the MCP half when no eligible operation is in the window', () => {
    const verdict = gate([], NOT_CONFIGURED);
    const mcp = only(verdict, GATE_SCOPE.Mcp);
    expect(mcp.measuredPercent).toBeNull();
    expect(mcp.operations).toBe(0);
    expect(mcp.reason).toBe(GATE_REASON.NoTraffic);
    expect(verdict.passed).toBe(false);
  });

  it('passes the same half once there is traffic above the bar', () => {
    // THE POSITIVE CONTROL for the refusal above: the only difference is a row.
    const verdict = gate([verified()], NOT_CONFIGURED);
    expect(only(verdict, GATE_SCOPE.Mcp).measuredPercent).toBe(60);
    expect(verdict.passed).toBe(true);
  });

  it('never reports a pass with no checks at all', () => {
    const empty: GateVerdict = {
      window: GATE_WINDOW.SevenDays,
      label: 'Last 7 days',
      targetPercent: 50,
      checks: [],
      passed: false,
    };
    expect(renderGate(empty).join('\n')).toContain('nothing was checked');
    expect(gateJson(empty).passed).toBe(false);
  });
});

describe('the two halves are held to the target separately', () => {
  it('fails on the wire figure even when the MCP figure clears the bar', () => {
    const verdict = gate([verified()], wire([record(1000, 800)]));
    expect(only(verdict, GATE_SCOPE.Mcp).passed).toBe(true);
    const proxy = only(verdict, GATE_SCOPE.Proxy);
    expect(proxy.measuredPercent).toBe(20);
    expect(proxy.passed).toBe(false);
    expect(proxy.reason).toBe(GATE_REASON.BelowTarget);
    expect(verdict.passed).toBe(false);
  });

  it('fails on the MCP figure even when the wire figure clears the bar', () => {
    const verdict = gate(
      [verified({ optimizedTokens: 900, tokensSaved: 100 })],
      wire([record(1000, 250)])
    );
    expect(only(verdict, GATE_SCOPE.Proxy).passed).toBe(true);
    expect(only(verdict, GATE_SCOPE.Mcp).passed).toBe(false);
    expect(verdict.passed).toBe(false);
  });

  it('passes when both halves clear it, which no blend could prove', () => {
    const verdict = gate([verified()], wire([record(1000, 250)]));
    expect(verdict.checks.map((one) => one.passed)).toEqual([true, true]);
    expect(verdict.passed).toBe(true);
  });

  it('checks no proxy half when no ledger was read, and says which it did', () => {
    const verdict = gate([verified()], NOT_CONFIGURED);
    expect(verdict.checks.map((one) => one.scope)).toEqual([GATE_SCOPE.Mcp]);
    expect(verdict.passed).toBe(true);
  });
});

describe('a required client', () => {
  it('fails when it recorded nothing, told apart from saving too little', () => {
    const verdict = gate([verified()], NOT_CONFIGURED, {
      clients: ['codex', 'claude-code'],
    });
    const missing = only(verdict, GATE_SCOPE.Client, 'codex');
    expect(missing.reason).toBe(GATE_REASON.NotRecorded);
    expect(missing.measuredPercent).toBeNull();
    expect(missing.passed).toBe(false);
    // THE CONTROL: the client that did record traffic passes the same check,
    // so the failure above is about that client and not about the flag.
    expect(only(verdict, GATE_SCOPE.Client, 'claude-code').passed).toBe(true);
    expect(verdict.passed).toBe(false);
  });

  it('fails a client that has traffic but is under the bar', () => {
    const verdict = gate(
      [
        verified(),
        verified({
          measurementId: 'm-2',
          client: 'codex',
          optimizedTokens: 900,
          tokensSaved: 100,
        }),
      ],
      NOT_CONFIGURED,
      { clients: ['codex'] }
    );
    const codex = only(verdict, GATE_SCOPE.Client, 'codex');
    expect(codex.measuredPercent).toBe(10);
    expect(codex.operations).toBe(1);
    expect(codex.reason).toBe(GATE_REASON.BelowTarget);
    expect(verdict.passed).toBe(false);
  });

  it('matches the name as the operator typed it, give or take case', () => {
    const verdict = gate([verified()], NOT_CONFIGURED, {
      clients: ['  Claude-Code '],
    });
    expect(only(verdict, GATE_SCOPE.Client, '  Claude-Code ').passed).toBe(
      true
    );
  });

  it('never lets unattributed traffic satisfy a named requirement', () => {
    // A row with no client lands in the `(unattributed)` bucket, and a gate
    // that matched that bucket by name would pass a requirement about a client
    // using traffic it could not attribute to any client at all.
    const verdict = gate([verified({ client: '' })], NOT_CONFIGURED, {
      clients: ['(unattributed)'],
    });
    expect(only(verdict, GATE_SCOPE.Client, '(unattributed)').reason).toBe(
      GATE_REASON.NotRecorded
    );
    expect(verdict.passed).toBe(false);
  });
});

describe('the window the operator named is the window measured', () => {
  /** The same row, eight days old: inside 30 days, outside 7 and today. */
  const older = verified({
    measurementId: 'm-old',
    timestamp: new Date(NOW.getTime() - 8 * 86_400_000).toISOString(),
  });

  it('measures only the named window, for the halves and the clients', () => {
    const seven = gate([older], NOT_CONFIGURED, {
      window: GATE_WINDOW.SevenDays,
      clients: ['claude-code'],
    });
    expect(only(seven, GATE_SCOPE.Mcp).reason).toBe(GATE_REASON.NoTraffic);
    expect(only(seven, GATE_SCOPE.Client, 'claude-code').reason).toBe(
      GATE_REASON.NotRecorded
    );
    expect(seven.passed).toBe(false);

    const thirty = gate([older], NOT_CONFIGURED, {
      window: GATE_WINDOW.ThirtyDays,
      clients: ['claude-code'],
    });
    expect(thirty.label).toBe('Last 30 days');
    expect(only(thirty, GATE_SCOPE.Mcp).measuredPercent).toBe(60);
    expect(thirty.passed).toBe(true);
  });

  it('names the window it measured in its own rendering', () => {
    const verdict = gate([verified()], NOT_CONFIGURED, {
      window: GATE_WINDOW.Today,
    });
    expect(renderGate(verdict)[1]).toContain('Today, target 50.0%');
    expect(gateJson(verdict).window).toBe('today');
    expect(gateJson(verdict).label).toBe('Today');
  });

  it('prints the target beside a check that measured nothing', () => {
    const lines = renderGate(gate([], NOT_CONFIGURED)).join('\n');
    expect(lines).toContain('FAIL');
    expect(lines).toContain('not measured');
    expect(lines).toContain('target 50.0%');
  });
});
