/**
 * `get_optimization_report` puts agent overhead beside the saving (#567).
 *
 * The report's "verified saved" counts trimmed tool output only, so a session
 * that spawned five agents reported the same saving as one that worked solo.
 * These tests seed the agent ledger the SubagentStop hook writes and read the
 * rendered report.
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalyticsManager } from '../../src/analytics/analytics-manager.js';
import type {
  AggregatedStats,
  AnalyticsEntry,
} from '../../src/analytics/analytics-types.js';
import { getOptimizationReportTool } from '../../src/tools/analytics/get-optimization-report.js';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'report-agents-'));
  process.env.TOKEN_OPTIMIZER_HOME = join(workspace, 'home');
  process.env.TOKEN_OPTIMIZER_WIKI_DIR = join(workspace, 'wiki');
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  delete process.env.TOKEN_OPTIMIZER_HOME;
  delete process.env.TOKEN_OPTIMIZER_WIKI_DIR;
});

const summary = {
  totalOperations: 0,
  totalOriginalTokens: 0,
  totalOptimizedTokens: 0,
  totalTokensSaved: 0,
};
const noRows: AggregatedStats[] = [];
const noEntries: AnalyticsEntry[] = [];
const manager = () =>
  ({
    aggregateEntries: () => ({
      hook: { summary, byHook: noRows },
      action: { summary, byAction: noRows },
      server: { summary, byServer: noRows },
    }),
    getEntries: async () => noEntries,
    count: async () => 0,
  }) as unknown as AnalyticsManager;

/** An agent of 10 turns on a 40k base that lost its cache 9 times at 5m. */
function row(at: number, sessionId = 's') {
  return {
    at,
    sessionId,
    agentId: `a${at}`,
    turns: 10,
    baseContext: 40_000,
    cacheRead: 0,
    cacheWrite: 445_000,
    input: 30,
    output: 400,
    toolOutput: 5_000,
    write5m: 445_000,
    write1h: 0,
    at5m: 556_280,
    at1h: 117_300,
    expiries: 9,
    expiryTokens: 400_000,
  };
}

function seed(rows: object[], ttl?: object) {
  const home = process.env.TOKEN_OPTIMIZER_HOME as string;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'agents.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (ttl) writeFileSync(join(home, 'subagent-cache-ttl.json'), JSON.stringify(ttl));
}

async function report(args: { startDate?: string; endDate?: string; sessionId?: string } = {}) {
  return JSON.parse(await getOptimizationReportTool(manager())(args));
}

describe('agent overhead in the savings report', () => {
  it('shows the agents, their starting context, and the cache they lost', async () => {
    const now = Date.now();
    seed([row(now - 1000), row(now - 2000)]);
    const out = await report();
    expect(out.agents.agents).toBe(2);
    // 2 agents x 0.1 x 40k x 9 re-reads.
    expect(out.agents.fixedReread).toBe(72_000);
    expect(out.agents.expiries).toBe(18);
    expect(out.agents.expiryRewrite).toBe(1_000_000);
    expect(out.agents.avoidableAt1h).toBe(2 * (556_280 - 117_300));
    expect(out.formatted).toContain('Agent overhead');
    expect(out.formatted).toContain('the 1h tier would have saved');
  });

  it('says when the setting was written, and when the user undid it', async () => {
    const now = Date.now();
    seed([row(now)], { at: now, value: '1h', evidence: { agents: 3 } });
    expect((await report()).formatted).toContain('set to 1h');
    seed([row(now)], { at: now, value: '1h', evidence: { agents: 3 }, undoneAt: now });
    expect((await report()).formatted).toContain('undone by you');
  });

  it('honours the date range', async () => {
    const old = Date.parse('2026-01-01T00:00:00Z');
    seed([row(Date.now())]);
    const out = await report({ startDate: '2026-01-01', endDate: new Date(old + 1000).toISOString() });
    expect(out.agents).toBeNull();
  });

  it('a session report counts only the agents that session started (#568 review)', async () => {
    const now = Date.now();
    seed([row(now - 3000, 'one'), row(now - 2000, 'one'), row(now - 1000, 'two'), { ...row(now), sessionId: null }]);
    expect((await report({ sessionId: 'one' })).agents.agents).toBe(2);
    expect((await report({ sessionId: 'two' })).agents.agents).toBe(1);
    expect((await report({ sessionId: 'none' })).agents).toBeNull();
    expect((await report()).agents.agents).toBe(4);
  });

  it('has no section, and no error, without a ledger', async () => {
    const out = await report();
    expect(out.success).toBe(true);
    expect(out.agents).toBeNull();
    expect(out.formatted).not.toContain('Agent overhead');
  });
});
