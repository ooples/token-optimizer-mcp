import { describe, expect, test } from '@jest/globals';
import {
  GuardRuntime,
  SemanticCompiler,
  guardReceipt,
  mistakeImmunityTemplate,
  semanticQuality,
  semanticApplicability,
  semanticFieldTrace,
  validateSemanticObject,
  verifyGuardReceipt,
} from '../../ucr/index.mjs';

let sequence = 0;
const eventFactory = (type, payload) => ({
  eventId: `event-${++sequence}`,
  type,
  payload,
});

function failure(overrides = {}) {
  return {
    trigger: 'editing a generated policy file',
    attemptedAction: 'edit clients/beta/policy.txt',
    observedFailure: 'regeneration overwrote the edit',
    rootCause: 'the client file is generated',
    correction: 'edit source/beta-policy.txt and regenerate',
    verificationEvidence: 'sync-check passed',
    evidenceReceipts: ['receipt-1'],
    evidence: 'tool trace and sync receipt',
    applicability: ['the target path is generated from source/beta-policy.txt'],
    nonApplicability: ['the target file is not generated'],
    invalidators: ['generator manifest changes'],
    scope: 'project',
    confidence: 0.98,
    confidenceLabel: 'observed',
    expectedOutcome: 'generated clients remain synchronized',
    ...overrides,
  };
}

describe('model-native semantic compiler', () => {
  test('rejects unsupported verified semantics and secret leakage', () => {
    expect(
      validateSemanticObject('failure', failure({ rootCause: '' })).valid
    ).toBe(false);
    expect(
      validateSemanticObject(
        'failure',
        failure({ evidence: 'api_key=abcdefghijklmnop' })
      ).valid
    ).toBe(false);
  });

  test('requires propose, successful receipt verification, then activation', () => {
    const compiler = new SemanticCompiler({ eventFactory });
    const proposed = compiler.propose('failure', failure(), {
      producer: 'codex/gpt',
    });
    expect(proposed.accepted).toBe(true);
    expect(compiler.activate(proposed.proposal.id).activated).toBe(false);
    expect(
      compiler.verify(proposed.proposal.id, [
        {
          eventId: 'receipt-1',
          type: 'verification.failed',
          payload: { passed: false },
        },
      ]).verified
    ).toBe(false);

    const verified = compiler.verify(
      proposed.proposal.id,
      [
        {
          eventId: 'receipt-1',
          type: 'verification.passed',
          payload: { passed: true },
        },
      ],
      {
        peerChallenge: {
          author: 'claude',
          critique: 'check generator version',
          proposedTest: 'sync',
        },
      }
    );
    expect(verified).toMatchObject({
      verified: true,
      object: { confidenceLabel: 'verified' },
    });
    expect(compiler.activate(proposed.proposal.id)).toMatchObject({
      activated: true,
      object: { state: 'active', producer: 'codex/gpt' },
    });
    expect(semanticQuality([verified.object])).toMatchObject({
      positiveApplicabilityRate: 1,
      negativeApplicabilityRate: 1,
      verifiedReceiptCoverage: 1,
    });
  });

  test('completion reflection is active-model owned and loop protected', () => {
    const compiler = new SemanticCompiler({ eventFactory });
    expect(compiler.reflectionRequest('s1')).toMatchObject({
      requested: false,
    });
    expect(
      compiler.reflectionRequest('s1', { lifecycleCanContinue: true })
    ).toMatchObject({ requested: true });
    expect(
      compiler.reflectionRequest('s1', { lifecycleCanContinue: true })
    ).toMatchObject({ requested: false });
  });

  test('deduplicates semantics, attributes harvest cost, and scores hard negatives', () => {
    const compiler = new SemanticCompiler({ eventFactory });
    const proposed = compiler.propose('failure', failure(), {
      producer: 'codex/gpt',
      resources: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
    });
    expect(compiler.propose('failure', failure(), { producer: 'claude' })).toMatchObject({
      accepted: false,
      duplicate: true,
      duplicateOf: proposed.proposal.id,
    });
    expect(compiler.resourceUsage()).toMatchObject({
      proposals: 1,
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.01,
    });
    expect(
      semanticApplicability(proposed.proposal, {
        task: 'edit source/beta-policy because target path is generated',
      }).applicable
    ).toBe(true);
    const quality = semanticQuality([proposed.proposal], [
      {
        objectId: proposed.proposal.id,
        expectedApplicable: false,
        context: { task: 'ordinary read of a hand-authored file' },
      },
    ]);
    expect(quality).toMatchObject({
      hardNegativeCases: 1,
      overgeneralizationRate: 0,
    });
    expect(semanticFieldTrace(proposed.proposal).every((row) => row.traceable)).toBe(
      true
    );
  });

  test('creates one canonical correction chain and supersedes stale versions', () => {
    const firstCompiler = new SemanticCompiler({ eventFactory });
    const first = firstCompiler.propose('failure', failure(), {
      producer: 'codex/gpt',
    });
    firstCompiler.verify(first.proposal.id, [
      {
        eventId: 'receipt-1',
        type: 'verification.passed',
        payload: { passed: true },
      },
    ]);
    const active = firstCompiler.activate(first.proposal.id).object;

    const nextCompiler = new SemanticCompiler({
      eventFactory,
      existingObjects: [active],
    });
    expect(
      nextCompiler.propose('failure', failure(), { producer: 'claude' })
    ).toMatchObject({
      accepted: false,
      duplicate: true,
      duplicateOf: active.id,
    });

    const next = nextCompiler.propose(
      'failure',
      failure({ correction: 'edit source/beta-policy-v2.txt and regenerate' }),
      { producer: 'claude' }
    );
    expect(next.proposal.supersedes).toBe(active.id);
    nextCompiler.verify(next.proposal.id, [
      {
        eventId: 'receipt-1',
        type: 'verification.passed',
        payload: { passed: true },
      },
    ]);
    const activated = nextCompiler.activate(next.proposal.id);
    expect(activated.event.payload.relations).toEqual([
      { from: next.proposal.id, to: active.id, type: 'supersedes' },
    ]);
  });
});

describe('executable memory guard runtime', () => {
  const guard = mistakeImmunityTemplate('generated-source', {
    generatedPattern: 'clients[/\\\\]beta[/\\\\]policy\\.txt$',
    sourcePath: 'source/beta-policy.txt',
    regenerateCommand: 'npm run sync',
    scope: { projectId: 'project-a' },
    evidence: ['receipt-1'],
  });

  test('simulates positive and adversarial negative traces before activation', () => {
    const runtime = new GuardRuntime({ mode: 'shadow' });
    expect(runtime.register(guard).registered).toBe(true);
    expect(
      runtime.simulate(guard.id, [
        {
          expected: true,
          action: { path: 'clients/beta/policy.txt' },
          context: { projectId: 'project-a' },
        },
        {
          expected: false,
          action: { path: 'source/beta-policy.txt' },
          context: { projectId: 'project-a' },
        },
        {
          expected: false,
          action: { path: 'clients/beta/policy.txt' },
          context: { projectId: 'project-b' },
        },
      ])
    ).toMatchObject({ safeToActivate: true, falsePositiveRate: 0 });
  });

  test('enforces only with capability and policy, preserving emergency disable', () => {
    const runtime = new GuardRuntime({
      mode: 'deny',
      policy: { allowDeny: true },
    });
    runtime.register(guard);
    const action = { path: 'clients/beta/policy.txt' };
    expect(
      runtime.evaluate(action, {
        projectId: 'project-a',
        capabilityTier: 'transactional',
      })
    ).toMatchObject({ decision: 'deny' });
    expect(
      runtime.evaluate(action, {
        projectId: 'project-a',
        capabilityTier: 'connected',
      })
    ).toMatchObject({ decision: 'allow', interventions: [{ mode: 'advise' }] });
    expect(
      runtime.evaluate(action, {
        projectId: 'project-a',
        capabilityTier: 'transactional',
        emergencyDisable: true,
      })
    ).toMatchObject({ decision: 'allow', disabled: true });
  });

  test('signs guard provenance without granting code execution', () => {
    const receipt = guardReceipt(guard, 'project-secret');
    expect(verifyGuardReceipt(guard, 'project-secret', receipt)).toBe(true);
    expect(
      verifyGuardReceipt(
        { ...guard, rollback: 'changed' },
        'project-secret',
        receipt
      )
    ).toBe(false);
  });

  test('can downgrade and disable a guard without losing its audit history', () => {
    const runtime = new GuardRuntime({
      mode: 'deny',
      policy: { allowDeny: true },
    });
    runtime.register(guard);
    expect(runtime.setMode('advise')).toEqual({ prior: 'deny', mode: 'advise' });
    expect(runtime.disableGuard(guard.id, 'negative canary').disabled).toBe(true);
    expect(
      runtime.evaluate(
        { path: 'clients/beta/policy.txt' },
        { projectId: 'project-a', capabilityTier: 'transactional' }
      ).matches
    ).toEqual([]);
    expect(runtime.enableGuard(guard.id).enabled).toBe(true);
    expect(runtime.audit.map((item) => item.kind)).toEqual(
      expect.arrayContaining(['mode-change', 'guard-disabled', 'guard-enabled'])
    );
  });
});
