import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  evidenceReport,
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
});
