import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  declinedAtBudget,
  evidenceReport,
  evidenceReportMany,
  readEvidence,
  record,
  recordFindingFeedback,
  recordToolOutcome,
} from '../../hooks-core/metrics.mjs';
import { load, wikiDir } from '../../hooks-core/wiki.mjs';
import { writeHarvested } from '../../hooks-core/harvest-write.mjs';
import { ORIGIN_AGENT } from '../../hooks-core/curate.mjs';
import { forCommand, forTouch } from '../../hooks-core/inject.mjs';

let workspace;
let dir;
let anchor;
const previous = {};

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'causal-evidence-'));
  dir = wikiDir(workspace);
  anchor = join(workspace, 'RUNBOOK.md');
  writeFileSync(anchor, '# Runbook\nUse npm test.\n');
  for (const key of [
    'TOKEN_OPTIMIZER_HOLDOUT',
    'TOKEN_OPTIMIZER_INJECTION_COOLDOWN_MS',
    'TOKEN_OPTIMIZER_MIN_EXPECTED_UTILITY',
  ]) previous[key] = process.env[key];
  process.env.TOKEN_OPTIMIZER_HOLDOUT = '0';
  process.env.TOKEN_OPTIMIZER_INJECTION_COOLDOWN_MS = '60000';
  process.env.TOKEN_OPTIMIZER_MIN_EXPECTED_UTILITY = '0';
});

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(workspace, { recursive: true, force: true });
});

function seed(type = 'command', trigger = 'bad-command') {
  return writeHarvested(dir, [{
    type,
    claim: 'Use npm test instead of the unsupported direct probe.',
    evidence: 'The package command passed and the direct probe exited one.',
    applicability: 'When verification uses the unsupported direct probe.',
    confidenceLabel: 'verified',
    confidence: 0.98,
    scope: 'project',
    invalidators: ['package.json test script changes'],
    trigger,
    anchors: [anchor],
  }], { sessionId: 'author', origin: ORIGIN_AGENT, projectRoot: workspace })[0];
}

describe('causal episode tracing', () => {
  test('persists the semantic evidence contract and deduplicates an exact repeat', () => {
    const key = seed();
    const repeated = seed();
    const node = [...load(dir).nodes.values()].find((item) => item.key === key);
    expect(repeated).toBe(key);
    expect(node).toMatchObject({
      evidence: 'The package command passed and the direct probe exited one.',
      applicability: 'When verification uses the unsupported direct probe.',
      confidenceLabel: 'verified',
      scope: 'project',
      invalidators: ['package.json test script changes'],
    });
  });

  test('an exact repeat enriches the existing finding with newly resolvable anchors', () => {
    const key = seed();
    const second = join(workspace, 'package.json');
    writeFileSync(second, '{"scripts":{"test":"jest"}}\n');

    const repeated = writeHarvested(dir, [{
      type: 'command',
      claim: 'Use npm test instead of the unsupported direct probe.',
      evidence: 'The package command passed and the direct probe exited one.',
      applicability: 'When verification uses the unsupported direct probe.',
      confidenceLabel: 'verified',
      confidence: 0.98,
      scope: 'project',
      invalidators: ['package.json test script changes'],
      trigger: 'bad-command',
      anchors: [anchor, second],
    }], { sessionId: 'second-session', origin: ORIGIN_AGENT, projectRoot: workspace })[0];

    const graph = load(dir);
    const finding = [...graph.nodes.values()].find((item) => item.key === key);
    const findingCount = [...graph.nodes.values()].filter(
      (item) => item.kind === 'finding' && item.claim === finding.claim
    ).length;
    const anchors = new Set(
      graph.edges
        .filter((edge) => edge.from === finding.id && edge.edge === 'derived_from')
        .map((edge) => edge.to)
    );

    expect(repeated).toBe(key);
    expect(findingCount).toBe(1);
    expect(anchors.size).toBe(2);
  });

  test('joins a tool outcome to the exact injection id', () => {
    const injection = record(dir, {
      kind: 'inject', episodeId: 'episode-1', sessionId: 'session-1',
      toolCallId: 'call-1', surface: 'command', anchor: 'bad-command',
      findingIds: ['finding-1'], holdout: false, deliveredTokens: 20,
    });
    const outcome = recordToolOutcome(dir, {
      episodeId: 'episode-1', sessionId: 'session-1', toolCallId: 'call-1',
      surface: 'command', anchor: 'bad-command', success: true,
    });

    expect(outcome.injectionId).toBe(injection.injectionId);
    expect(outcome.findingIds).toEqual(['finding-1']);
    expect(outcome.joinMethod).toBe('tool-call-id');
  });

  test('holdouts retain shadow candidates without delivering them', () => {
    const key = seed();
    process.env.TOKEN_OPTIMIZER_HOLDOUT = '1';
    const context = forCommand(dir, load(dir), 'bad-command', {
      sessionId: 's1', episode: { episodeId: 'e1', arm: 'retrieval', client: 'codex' },
    });
    const injection = readEvidence(dir).find((event) => event.kind === 'inject');

    expect(context).toBeNull();
    expect(injection.deliveredTokens).toBe(0);
    expect(injection.findingIds).toEqual([]);
    expect(injection.shadowFindingIds).toEqual([key]);
    expect(injection.shadowTokens).toBeGreaterThan(0);
  });

  test('harm feedback quarantines a finding and a cooldown backs up session state', () => {
    const key = seed('finding', null);
    const first = forTouch(dir, load(dir), anchor, {
      sessionId: 's1', episode: { episodeId: 'e1', arm: 'full' },
    });
    expect(first).toMatch(/Known about/);

    // A fresh in-memory gate simulates a concurrent hook process that did not
    // inherit alreadyInjected; durable evidence still enforces the cooldown.
    const second = forTouch(dir, load(dir), anchor, {
      sessionId: 's1', alreadyInjected: new Set(), episode: { episodeId: 'e1', arm: 'full' },
    });
    expect(second).toBeNull();

    recordFindingFeedback(dir, { findingId: key, rating: 'harmful', episodeId: 'review-1' });
    recordFindingFeedback(dir, { findingId: key, rating: 'harmful', episodeId: 'review-2' });
    const quarantined = forTouch(dir, load(dir), anchor, {
      sessionId: 's2', episode: { episodeId: 'e2', arm: 'full' },
    });
    expect(quarantined).toBeNull();
    const decisions = readEvidence(dir).filter((event) => event.kind === 'retrieval-decision');
    expect(decisions.flatMap((event) => event.rejected).map((item) => item.reason))
      .toEqual(expect.arrayContaining(['cooldown', 'quarantined-harm']));
  });
});

describe('paired evidence report', () => {
  test('pools raw events across project graphs before estimating cohorts', () => {
    const secondWorkspace = mkdtempSync(join(tmpdir(), 'causal-evidence-second-'));
    const secondDir = wikiDir(secondWorkspace);
    try {
      for (let pair = 1; pair <= 5; pair++) {
        record(dir, {
          kind: 'eval-run', taskId: 'cross-project', pairId: `p${pair}`,
          arm: 'baseline', client: 'codex', model: 'model-a', correct: true,
          totalTokens: 1000, toolCalls: 10,
        });
        record(secondDir, {
          kind: 'eval-run', taskId: 'cross-project', pairId: `p${pair}`,
          arm: 'full', client: 'codex', model: 'model-a', correct: true,
          totalTokens: 600, toolCalls: 6,
        });
      }

      const report = evidenceReportMany([dir, secondDir]);
      const full = report.cohorts[0].effects.find((effect) =>
        effect.arm === 'full' && effect.controlArm === 'baseline'
      );
      expect(full.pairs).toBe(5);
      expect(full.totalTokensSaved.mean).toBe(400);
      expect(report.sourceCoverage).toEqual({
        projects: 2,
        projectsWithEvidence: 2,
        projectsWithoutEvidence: 0,
      });
    } finally {
      rmSync(secondWorkspace, { recursive: true, force: true });
    }
  });

  test('keeps four arms separate and reports a bootstrap interval from matched pairs', () => {
    for (let pair = 1; pair <= 5; pair++) {
      for (const [arm, tokens, calls] of [
        ['baseline', 1000 + pair, 10],
        ['optimizer', 900 + pair, 9],
        ['retrieval', 750 + pair, 7],
        ['full', 600 + pair, 6],
      ]) {
        record(dir, {
          kind: 'eval-run', taskId: 'recovery', pairId: `p${pair}`, arm,
          client: 'codex', clientVersion: '1.0', model: 'model-a', modelVersion: '2026-08',
          correct: true, totalTokens: tokens, toolCalls: calls, latencyMs: tokens,
          uncachedInputTokens: tokens - 10, cachedInputTokens: 0, outputTokens: 10,
        });
      }
    }

    const report = evidenceReport(dir);
    expect(report.cohorts).toHaveLength(1);
    expect(report.summary.evidenceStatus).toBe('causal estimates available');
    expect(report.cohorts[0].arms.full.correctness.rate).toBe(1);
    const optimizer = report.cohorts[0].effects.find((effect) =>
      effect.arm === 'optimizer' && effect.controlArm === 'baseline'
    );
    const retrieval = report.cohorts[0].effects.find((effect) =>
      effect.arm === 'retrieval' && effect.controlArm === 'optimizer'
    );
    const harvest = report.cohorts[0].effects.find((effect) =>
      effect.arm === 'full' && effect.controlArm === 'retrieval'
    );
    const full = report.cohorts[0].effects.find((effect) =>
      effect.arm === 'full' && effect.controlArm === 'baseline'
    );
    expect(optimizer.totalTokensSaved.mean).toBe(100);
    expect(retrieval.totalTokensSaved.mean).toBe(150);
    expect(harvest.totalTokensSaved.mean).toBe(150);
    expect(full.pairs).toBe(5);
    expect(full.totalTokensSaved.mean).toBe(400);
    expect(full.totalTokensSaved.low).toBeGreaterThan(0);
    expect(report.methodology.deterministicChecksAreCausalProof).toBe(false);
  });

  test('keeps natural transfer distinct from oracle and enforces every claim gate', () => {
    for (let pair = 1; pair <= 10; pair++) {
      for (const arm of ['empty', 'natural', 'oracle', 'irrelevant', 'stale']) {
        const prevented = ['natural', 'oracle'].includes(arm);
        record(dir, {
          kind: 'handoff-run',
          pairId: `h${pair}`,
          scenarioId: 'verification-entry-point',
          arm,
          producer: {
            client: 'codex', model: 'gpt-5.6-sol', captureSuccess: true,
          },
          consumer: {
            client: 'claude-code', model: 'claude-sonnet-5',
            correct: true, firstPass: prevented,
            mistakeAttempted: !prevented, mistakeExecuted: !prevented,
            totalTokens: prevented ? 800 : 1000,
            toolCalls: prevented ? 5 : 7,
            failedToolCalls: prevented ? 0 : 1,
            latencyMs: prevented ? 8000 : 10000,
          },
          delivery: {
            delivered: ['natural', 'oracle', 'stale'].includes(arm),
            beforeFirstExecutedMistake: arm === 'natural',
          },
        });
      }
    }

    const report = evidenceReport(dir);
    expect(report.summary.handoffRuns).toBe(50);
    expect(report.transferCohorts).toHaveLength(1);
    const cohort = report.transferCohorts[0];
    expect(cohort.captureRate).toBe(1);
    expect(cohort.arms.empty.mistakeExecuted.rate).toBe(1);
    expect(cohort.arms.natural.mistakeExecuted.rate).toBe(0);
    expect(cohort.effects.naturalVsEmpty.executedMistakesPrevented.low).toBe(1);
    expect(cohort.effects.naturalVsOracle.executedMistakesPrevented.mean).toBe(0);
    expect(cohort.arms.irrelevant.delivery.rate).toBe(0);
    expect(cohort.evidenceStatus).toBe('pre-registered transfer gates passed');
  });

  test('fails transfer gates when control evidence is absent or irrelevant content is delivered', () => {
    for (let pair = 1; pair <= 10; pair++) {
      for (const arm of ['empty', 'natural', 'irrelevant']) {
        record(dir, {
          kind: 'handoff-run', pairId: `negative-${pair}`,
          scenarioId: 'verification-entry-point', arm,
          producer: { client: 'codex', model: 'gpt-5.6-sol', captureSuccess: true },
          consumer: {
            client: 'claude-code', model: 'claude-sonnet-5', correct: true,
            mistakeExecuted: arm === 'empty',
          },
          delivery: {
            delivered: arm !== 'empty',
            beforeFirstExecutedMistake: arm === 'natural',
          },
        });
      }
    }

    const cohort = evidenceReport(dir).transferCohorts[0];
    expect(cohort.gates.negativeControls).toBe(false);
    expect(cohort.evidenceStatus).toMatch(/insufficient or failed/);
  });

  test('filters handoff arms from the top-level arm field', () => {
    for (const arm of ['empty', 'natural']) {
      record(dir, {
        kind: 'handoff-run', pairId: 'filter-1', scenarioId: 'filter-task', arm,
        producer: { client: 'codex', arm: 'nested-producer-value' },
        consumer: { client: 'claude-code', arm: 'nested-consumer-value' },
      });
    }
    const filtered = evidenceReport(dir, { filters: { arm: 'natural' } });
    expect(filtered.summary.handoffRuns).toBe(1);
    expect(filtered.transferCohorts[0].arms.natural.runs).toBe(1);
    expect(filtered.transferCohorts[0].arms.empty.runs).toBe(0);
  });

  test('reports concurrent graph integrity separately from consumer behavior', () => {
    for (const arm of ['empty', 'natural']) {
      record(dir, {
        kind: 'concurrency-run', pairId: 'c1', arm, writerCount: 3,
        captureSuccesses: 3,
        integrity: {
          zeroLoss: true, parseable: true, orphanedFindings: 0,
        },
        delivery: { expected: arm === 'natural' ? 3 : 0, delivered: arm === 'natural' ? 3 : 0 },
        consumer: {
          client: 'claude-code', model: 'claude-sonnet-5', correct: true,
          firstPass: arm === 'natural', mistakeExecuted: arm === 'empty',
        },
      });
    }

    const report = evidenceReport(dir);
    expect(report.summary.concurrencyRuns).toBe(2);
    expect(report.concurrency).toMatchObject({
      naturalRuns: 1,
      writers: 3,
      captureRate: 1,
      integrityPassRate: 1,
      deliveryCoverage: 1,
    });
    expect(report.concurrency.effect.executedMistakesPrevented.mean).toBe(1);
  });
});

describe('what the budget turned away', () => {
  // `retrieval-decision` records were written from four call sites in
  // inject.mjs and read by nothing -- a producer with no reader, which is one
  // of the three sub-classes tests/hooks/census.test.mjs exists to catch, and
  // the one it caught on its first run. These assertions drive the REAL
  // rejection path rather than hand-writing records, so they fail if the
  // reasons or the record shape drift.
  //
  // HOLDOUT PINNED at the top of this file. forTouch consults the stratified
  // holdout, so without `TOKEN_OPTIMIZER_HOLDOUT=0` these fail intermittently
  // when the anchor lands in the withheld arm and nothing is assessed at all.

  test('counts nothing on a graph where retrieval never declined anything', () => {
    // The honest zero. A budget that has turned nothing away must not be
    // indistinguishable from one that was never consulted.
    const declined = declinedAtBudget(dir);
    expect(declined).toMatchObject({ decisions: 0, declined: 0, distinctFindings: 0 });
    expect(declined.byReason).toEqual([]);
  });

  test('counts a cooldown rejection and names the reason', () => {
    seed('finding', null);
    expect(
      forTouch(dir, load(dir), anchor, {
        sessionId: 's1', episode: { episodeId: 'e1', arm: 'full' },
      })
    ).toMatch(/Known about/);
    // A concurrent hook process with no in-memory gate: durable evidence still
    // enforces the cooldown, and that rejection is what gets recorded.
    expect(
      forTouch(dir, load(dir), anchor, {
        sessionId: 's1', alreadyInjected: new Set(), episode: { episodeId: 'e1', arm: 'full' },
      })
    ).toBeNull();

    const declined = declinedAtBudget(dir);
    expect(declined.declined).toBeGreaterThan(0);
    expect(declined.distinctFindings).toBe(1);
    expect(declined.byReason.map((r) => r.reason)).toContain('cooldown');
  });

  test('separates a quarantined finding from a cooled-down one', () => {
    const key = seed('finding', null);
    forTouch(dir, load(dir), anchor, {
      sessionId: 's1', episode: { episodeId: 'e1', arm: 'full' },
    });
    forTouch(dir, load(dir), anchor, {
      sessionId: 's1', alreadyInjected: new Set(), episode: { episodeId: 'e1', arm: 'full' },
    });
    recordFindingFeedback(dir, { findingId: key, rating: 'harmful', episodeId: 'review-1' });
    recordFindingFeedback(dir, { findingId: key, rating: 'harmful', episodeId: 'review-2' });
    forTouch(dir, load(dir), anchor, {
      sessionId: 's2', episode: { episodeId: 'e2', arm: 'full' },
    });

    const reasons = declinedAtBudget(dir).byReason.map((r) => r.reason);
    expect(reasons).toEqual(expect.arrayContaining(['cooldown', 'quarantined-harm']));
    // Ranked, so the audit's "top 3" is the top 3 rather than the first 3.
    const counts = declinedAtBudget(dir).byReason.map((r) => r.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  test('counts an unlabelled rejection rather than dropping it', () => {
    // An unknown reason is still a finding the model did not get. Reporting a
    // smaller number than the truth would understate exactly the cost this
    // reader exists to surface.
    record(dir, {
      kind: 'retrieval-decision',
      surface: 'file',
      anchor,
      rejected: [{ key: 'no-reason-given' }],
    });
    const declined = declinedAtBudget(dir);
    expect(declined.declined).toBe(1);
    expect(declined.byReason).toEqual([{ reason: 'unspecified', count: 1 }]);
  });
});
