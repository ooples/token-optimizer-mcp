/**
 * `get_optimization_report` -- the graph balance sheet, and the one rule about
 * currency.
 *
 * THE RULE: a dollar figure may appear beside a MEASURED COUNTERFACTUAL and
 * nowhere else. The holdout figure, the consolidation ratio and the calibration
 * verdict are estimates, and pricing an estimate makes this project's headline
 * saving larger for free -- the measurement-bias class that has produced six
 * defects across these plans, every one of them in this project's own favour.
 * So the assertions below are written against the RENDERED TEXT: with a rate
 * configured, the measured line must carry currency and no line that says
 * "estimate" may.
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AnalyticsManager } from '../../src/analytics/analytics-manager.js';
import type {
  AggregatedStats,
  AnalyticsEntry,
} from '../../src/analytics/analytics-types.js';
import { getOptimizationReportTool } from '../../src/tools/analytics/get-optimization-report.js';

const RATE_ENV = 'TOKEN_OPTIMIZER_EFFECTIVE_INPUT_USD_PER_MILLION';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'report-'));
  // A graph of our own, so the section under test does not depend on whatever
  // this developer's own repository happens to have measured today.
  process.env.TOKEN_OPTIMIZER_WIKI_DIR = join(workspace, 'wiki');
  delete process.env[RATE_ENV];
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  delete process.env.TOKEN_OPTIMIZER_WIKI_DIR;
  delete process.env[RATE_ENV];
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
    getHookAnalytics: async () => ({ summary, byHook: noRows }),
    getActionAnalytics: async () => ({ summary, byAction: noRows }),
    getServerAnalytics: async () => ({ summary, byServer: noRows }),
    getEntries: async () => noEntries,
    count: async () => 0,
  }) as unknown as AnalyticsManager;

/**
 * A finding that carries a derivation cost, written with the real graph writer.
 *
 * Needed because the consolidation line has two branches and only this one can
 * carry a price at all -- so a test that never seeds a `derivedCost` asserts the
 * no-currency rule against the branch that could not have broken it.
 */
async function seedFindingWithDerivedCost() {
  const wiki = await import(
    pathToFileURL(join(process.cwd(), 'hooks-core', 'wiki.mjs')).href
  );
  wiki.putNode(process.env.TOKEN_OPTIMIZER_WIKI_DIR, {
    kind: 'finding',
    key: 'expand:seeded',
    claim: 'x'.repeat(200),
    derivedCost: 5_000,
    confidence: 0.7,
  });
}

const run = async () =>
  JSON.parse(await getOptimizationReportTool(manager())({})) as Record<
    string,
    any
  >;

describe('get_optimization_report and the graph', () => {
  it('shows the graph balance sheet', async () => {
    const report = await run();
    expect(report.graph).toBeDefined();
    expect(report.graph).not.toBeNull();
    // The four sections Task 8 adds, beside the two the sheet already had.
    expect(report.graph.measuredCounterfactual).toBeDefined();
    expect(report.graph.estimatedCausal).toBeDefined();
    expect(report.graph.layer1).not.toBeNull();
    expect(report.graph.layer2).not.toBeNull();
    expect(report.graph.calibration).toBeDefined();
    expect(report.graph.consolidation).toBeDefined();
    expect(report.formatted).toContain('Graph balance sheet');
  });

  it('reports the hit rate beside the balance, which is what #204 asks for', async () => {
    // The issue's acceptance test is "hit rate and token balance", and this
    // block carried only the balance -- what the graph spent and saved, with
    // nothing about whether anything it injected was ever used. A positive
    // balance built on findings nobody read is the overhead this project says
    // it must not become, so the two halves belong in one block.
    const report = await run();
    const line = report.formatted
      .split('\n')
      .find((l: string) => /hit rate\s+:/.test(l));
    expect(line).toBeDefined();
  });

  it('states an unmeasured hit rate rather than printing it as zero', async () => {
    // `referenceNote` returns null when it has nothing honest to say. Rendering
    // that as 0% would read as "nothing is ever used", which is the
    // unknown-becomes-zero error this report corrects everywhere else.
    const report = await run();
    const line = report.formatted
      .split('\n')
      .find((l: string) => /hit rate\s+:/.test(l));
    expect(line).toBeDefined();
    if (/not measurable/.test(String(line))) {
      expect(line).not.toMatch(/\b0%/);
    }
  });

  it('refuses to publish a calibration it cannot compute, with no gap number', async () => {
    const report = await run();
    expect(report.graph.calibration.publishable).toBe(false);
    expect(report.graph.calibration.verdict).toMatch(/not calibrated/);
    // NOT `gap: 0`. A permanent zero reads as "measured, and they agree".
    expect('gap' in report.graph.calibration).toBe(false);
    expect(report.formatted).toMatch(/calibration\s+: not calibrated/);
  });

  it('puts a dollar figure only on measured lines', async () => {
    // A configured rate, so currency is available to every line that asks for
    // it. Without this the test would pass on a machine that simply cannot
    // price anything, which is the vacuous version of this assertion.
    process.env[RATE_ENV] = '3';
    await seedFindingWithDerivedCost();
    const report = await run();
    const lines: string[] = report.formatted.split('\n');

    const estimated = lines.filter((line) => /estimat/i.test(line));
    expect(estimated.length).toBeGreaterThan(0);
    for (const line of estimated) expect(line).not.toMatch(/\$/);

    // And the measured counterfactual DID get its price, so the absence above
    // is a rule and not an inability.
    const measured = lines.find((line) => /measured counterfactual/.test(line));
    expect(measured).toBeDefined();
    expect(measured).toMatch(/\$/);
  });

  it('prices nothing at all when no effective rate is configured', async () => {
    const report = await run();
    const measured = report.formatted
      .split('\n')
      .find((line: string) => /measured counterfactual/.test(line));
    expect(measured).toMatch(/not priced/);
    expect(measured).not.toMatch(/\$/);
  });

  it('labels the consolidation ratio an estimate rather than pricing it', async () => {
    process.env[RATE_ENV] = '3';
    await seedFindingWithDerivedCost();
    const report = await run();
    // THE BRANCH THAT COULD CARRY A PRICE, exercised on purpose.
    expect(report.graph.consolidation.withDerivedCost).toBe(1);
    expect(report.graph.consolidation.basis).toBe('estimate');
    expect(report.graph.consolidation.priced).toBe(false);
    const line = report.formatted
      .split('\n')
      .find((l: string) => /consolidation\s+:/.test(l));
    expect(line).toMatch(/estimate, deliberately not priced/);
    expect(line).not.toMatch(/\$/);
  });

  it('carries the unclassifiable repeat count beside the confirmed waste', async () => {
    // `rereadWaste` reports three groups and this line prints the confirmed one.
    // Its count of repeats it could not judge travels with it, or the figure
    // arrives without the fact that the classification is incomplete.
    const report = await run();
    const line = report.formatted
      .split(String.fromCharCode(10))
      .find((l: string) => /re-read waste/.test(l));
    expect(line).toMatch(/unclassifiable/);
    expect(line).not.toMatch(/\$/);
  });

  it('renders the recall probe, labelled offline, with no rate it cannot support', async () => {
    // The seeded finding has no anchor, so the probe reports one unanchored
    // miss and REFUSES a rate -- the branch a fresh machine actually takes.
    // What the line must never do is print the by-construction check's 1.0.
    process.env[RATE_ENV] = '3';
    await seedFindingWithDerivedCost();
    const report = await run();

    expect(report.graph.recall).toBeDefined();
    expect(report.graph.recall.basis).toBe(
      'offline probe over the current graph'
    );
    expect(report.graph.recall.rate).toBeNull();
    // The tautology is present, separately, and it is 1.0 -- which is exactly
    // why it may not be the thing the rate line prints.
    expect(report.graph.recall.integrity.rate).toBe(0);

    const line = report.formatted
      .split('\n')
      .find((l: string) => /recall \(offline probe\)/.test(l));
    expect(line).toBeDefined();
    expect(line).toMatch(/no rate/);
    expect(line).not.toMatch(/\$/);
    expect(line).not.toMatch(/100(\.0)?%/);
  });

  it('still renders a section for a graph directory that does not exist', async () => {
    // A fresh install has no graph. The section must still appear, carrying its
    // refusal -- a missing directory is not a reason to hide the loop's state,
    // and it is certainly not a reason to break the report.
    process.env.TOKEN_OPTIMIZER_WIKI_DIR = join(
      workspace,
      'nonexistent',
      'wiki'
    );
    const report = await run();
    expect(report.success).toBe(true);
    expect(report.graph).not.toBeNull();
    expect(report.graph.calibration.publishable).toBe(false);
    expect(report.formatted).toContain('Graph balance sheet');
  });
});
