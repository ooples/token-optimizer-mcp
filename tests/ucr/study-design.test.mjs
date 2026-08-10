import { describe, expect, test } from '@jest/globals';
import {
  BENCHMARK_ARMS,
  BENCHMARK_FAMILIES,
  buildFullStudyPlan,
  buildCausalChain,
  freezeBenchmark,
  preRegisterBenchmark,
  releaseMetricCoveragePreflight,
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
  { id: 'codex', model: 'gpt', modelFamily: 'openai' },
  { id: 'claude-code', model: 'claude', modelFamily: 'anthropic' },
  { id: 'gemini', model: 'gemini', modelFamily: 'google' },
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
    expect(new Set(plan.trials.map((trial) => trial.workspaceIsolationId)).size).toBe(
      plan.trials.length
    );
    expect(plan.trials.every((trial) => trial.hiddenVariantId.length === 24)).toBe(
      true
    );
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
    const requirement = zeroFailureWilsonSampleSize();
    expect(requirement.samples).toBeGreaterThan(1000);
    expect(requirement).toMatchObject({
      comparisons: 36,
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
  });
});
