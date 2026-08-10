import { describe, expect, test } from '@jest/globals';
import {
  BENCHMARK_ARMS,
  BENCHMARK_FAMILIES,
  STUDY_NEGATIVE_ARMS,
  buildFullStudyPlan,
  buildCausalChain,
  freezeBenchmark,
  preRegisterBenchmark,
  releaseMetricCoveragePreflight,
  sha256,
  studyDesignCoverage,
  validateCausalChain,
  validateTrialResult,
  zeroFailureWilsonSampleSize,
} from '../../ucr/index.mjs';

const tasks = BENCHMARK_FAMILIES.map((family, index) => ({
  id: `${family}-${index}`,
  family,
  prompt: `hidden ${family} task`,
  fixture: 'fixture',
  hiddenVariantSpec: { bytes: 16 },
  grader: { requiredState: { passed: true } },
}));
const source = {
  seed: 'study-test',
  arms: BENCHMARK_ARMS,
  tasks,
  pilot: { baselineRate: 0.6, minimumEffect: 0.1, alpha: 0.05, power: 0.8 },
};
const benchmark = freezeBenchmark(source);
const clients = [
  {
    id: 'codex',
    model: 'gpt',
    modelVersion: 'gpt-v1',
    modelFamily: 'openai',
    version: 'codex-v1',
  },
  {
    id: 'claude-code',
    model: 'claude',
    modelVersion: 'claude-v1',
    modelFamily: 'anthropic',
    version: 'claude-v1',
  },
  {
    id: 'gemini',
    model: 'gemini',
    modelVersion: 'gemini-v1',
    modelFamily: 'google',
    version: 'gemini-v1',
  },
];

describe('full effectiveness study design', () => {
  test('covers every family, arm, client direction, and isolation mode', () => {
    const plan = buildFullStudyPlan({
      benchmark,
      clients,
      secret: 'hidden-secret',
      registration: preRegisterBenchmark(source, source.pilot),
    });
    const coverage = studyDesignCoverage(plan);
    expect(coverage).toMatchObject({
      passed: true,
      coverage: { families: 1, arms: 1, clients: 3, modelFamilies: 3 },
    });
    expect(
      new Set(plan.trials.map((trial) => trial.workspaceIsolationId)).size
    ).toBe(plan.trials.length);
    expect(
      plan.trials.every((trial) => trial.hiddenVariantId.length === 24)
    ).toBe(true);
    expect(new Set(plan.trials.map((trial) => trial.sessionMode))).toEqual(
      new Set(['same-session', 'cross-session'])
    );
    expect(coverage.checks).toMatchObject({
      sameSession: true,
      crossSession: true,
    });
    const malformedPlan = structuredClone(plan);
    delete malformedPlan.trials[0].successorAgentIds;
    expect(() => studyDesignCoverage(malformedPlan)).not.toThrow();
    expect(studyDesignCoverage(malformedPlan)).toMatchObject({
      passed: false,
      checks: { executionTopology: false },
    });
  });

  test('preflights every effectiveness and superiority metric source', () => {
    const plan = buildFullStudyPlan({
      benchmark,
      clients,
      secret: 'hidden-secret',
    });
    expect(
      releaseMetricCoveragePreflight({
        plan,
        competitorKinds: [
          'no-memory',
          'full-history',
          'static-instructions',
          'vector-rag',
          'graph-rag',
          'memory-os',
          'vendor-memory',
        ],
        productionStages: [
          'shadow-selection',
          'observe-only',
          'advisory-canary',
          'verification-canary',
          'scoped-enforcement',
        ],
      })
    ).toMatchObject({ passed: true, missingMetrics: [] });
  });

  test('powers one-percent negative-delivery claims instead of relying on zero point estimates', () => {
    const comparisons = clients.length ** 2 * STUDY_NEGATIVE_ARMS.length;
    const requirement = zeroFailureWilsonSampleSize({ comparisons });
    expect(requirement.samples).toBeGreaterThan(1000);
    expect(requirement).toMatchObject({
      comparisons,
      familyAlpha: 0.05,
      method: 'bonferroni-familywise-wilson-zero-failure-upper-bound',
    });
    const repetitions = Math.ceil(requirement.samples / tasks.length);
    const plan = buildFullStudyPlan({
      benchmark,
      clients,
      secret: 'hidden-secret',
      negativeRepetitionsPerCell: repetitions,
    });
    expect(plan.negativeSamplesPerDirectionPerArm).toBeGreaterThanOrEqual(
      requirement.samples
    );
    expect(plan.negativeConfidence.comparisons).toBe(
      plan.directions.length * STUDY_NEGATIVE_ARMS.length
    );
  });

  test('rejects mismatched paired conditions and incomplete causal chains', () => {
    const plan = buildFullStudyPlan({
      benchmark,
      clients,
      secret: 'hidden-secret',
    });
    const runtime = plan.trials.find((trial) => trial.arm === 'runtime');
    const empty = plan.trials.find(
      (trial) => trial.pairId === runtime.pairId && trial.arm === 'empty'
    );
    expect(
      validateTrialResult(
        {
          ...runtime,
          graderVerified: true,
          hiddenVariantId: runtime.hiddenVariantId,
        },
        runtime,
        { ...empty, promptHash: 'different' }
      )
    ).toMatchObject({ valid: false });
    expect(
      validateTrialResult(
        { ...runtime, graderVerified: true, promptHash: 'executed-different' },
        runtime,
        empty
      )
    ).toMatchObject({
      valid: false,
      diagnostics: expect.arrayContaining([
        'executed promptHash differs from the planned trial',
      ]),
    });
    expect(validateCausalChain({ stages: [] })).toMatchObject({ valid: false });
    const chain = buildCausalChain(
      [
        'captured',
        'verified',
        'eligible',
        'retrieved',
        'delivered',
        'used',
        'behaviorChanged',
        'mistakePrevented',
        'taskCorrect',
      ].map((stage, index) => ({
        stage,
        observer: 'host',
        observedAt: index + 1,
        artifact: { stage },
      })),
      {
        controlOutcomeHash: 'control',
        treatmentOutcomeHash: 'treatment',
        pairedPromptHash: 'prompt',
        graderReceiptHash: 'grader',
      }
    );
    expect(validateCausalChain(chain)).toMatchObject({ valid: true });
    const reorderedEvents = [...chain.events].reverse();
    expect(
      validateCausalChain({
        ...chain,
        events: reorderedEvents,
        evidenceLedgerHash: sha256(reorderedEvents),
      })
    ).toMatchObject({ valid: true });
  });
});
