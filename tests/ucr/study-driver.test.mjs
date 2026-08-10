import { describe, expect, test } from '@jest/globals';
import {
  STUDY_DRIVER_PROTOCOL,
  UCR_CLIENT_REGISTRY,
  sha256,
  studyDriverChildEnvironment,
  studyDriverRegistry,
  studyDirectionEnvironmentKey,
  validateStudyDriverResult,
} from '../../ucr/index.mjs';

describe('universal live-study driver contract', () => {
  test('publishes the same driver protocol for every registered CLI client', () => {
    const registry = studyDriverRegistry();
    expect(Object.keys(registry).sort()).toEqual(
      Object.keys(UCR_CLIENT_REGISTRY).sort()
    );
    expect(
      Object.values(registry).every(
        (driver) => driver.protocol === STUDY_DRIVER_PROTOCOL
      )
    ).toBe(true);
    expect(studyDirectionEnvironmentKey('claude-code', 'codex')).toBe(
      'UCR_STUDY_DIRECTION_CLAUDE_CODE_TO_CODEX'
    );
  });

  test('passes only allowlisted driver environment without study secrets', () => {
    expect(
      studyDriverChildEnvironment({
        PATH: 'bin',
        OPENAI_API_KEY: 'provider-key',
        UCR_STUDY_SECRET: 'hidden-variant-secret',
        UCR_EVIDENCE_PRIVATE_KEY_FILE: 'private.pem',
        UCR_STUDY_DRIVER_ENV_ALLOWLIST:
          'OPENAI_API_KEY,UCR_STUDY_SECRET,UCR_EVIDENCE_PRIVATE_KEY_FILE',
      })
    ).toEqual({ PATH: 'bin', OPENAI_API_KEY: 'provider-key' });
  });

  test('requires the planned calls, zero capture calls, and complete telemetry', () => {
    const trial = {
      producerClient: 'codex',
      consumerClient: 'claude-code',
      producerVersion: 'codex-v1',
      consumerVersion: 'claude-v1',
      consumerModelVersion: 'claude-model-v1',
      expectedProviderInvocations: 2,
      producerContinuitySessionId: 's1',
      consumerContinuitySessionId: 's2',
      producerProjectId: 'p1',
      consumerProjectId: 'p1',
      successorAgentIds: ['a1'],
      concurrentOverlapRequired: false,
    };
    const delta = {
      type: 'failure',
      trigger: 'generated source edit',
      attemptedAction: 'edited generated source',
      observedFailure: 'generation overwrote the edit',
      rootCause: 'canonical source owns generated output',
      correction: 'edit the canonical input',
      verificationEvidence: 'synchronization passed',
      expectedOutcome: 'generated output remains synchronized',
      applicability: ['generated file detected'],
      nonApplicability: ['source is canonical'],
      invalidators: ['generator ownership changes'],
      confidence: 0.99,
      evidenceRefs: ['receipt:1'],
    };
    const result = {
      schemaVersion: STUDY_DRIVER_PROTOCOL,
      producerClient: 'codex',
      consumerClient: 'claude-code',
      providerInvocations: 2,
      semanticHarvest: {
        modelAuthored: true,
        additionalModelCalls: 0,
        authorInvocationId: 'producer-1',
        delta,
        deltaHash: expect.anything(),
      },
      consumerMcpExposed: false,
      phaseAccounting: { staticSchemaTokens: 0 },
      actionAudit: [{ sequence: 1, executed: true, receipt: 'write-result' }],
      actionAuditComplete: true,
      totalTokens: 100,
      latencyMs: 20,
      producerVersion: 'codex-v1',
      consumerVersion: 'claude-v1',
      modelVersion: 'claude-model-v1',
      executionTopology: {
        producerContinuitySessionId: 's1',
        consumerContinuitySessionId: 's2',
        producerProjectId: 'p1',
        consumerProjectId: 'p1',
        successorAgentIds: ['a1'],
        concurrentOverlapObserved: false,
      },
      invocations: [
        {
          invocationId: 'producer-1',
          role: 'producer',
          providerRequestId: 'request-1',
          promptHash: 'p',
          usageSource: 'provider-native',
          inputTokens: 40,
          outputTokens: 10,
          latencyMs: 10,
          startedAtMs: 0,
          endedAtMs: 10,
        },
        {
          invocationId: 'consumer-1',
          role: 'consumer',
          agentId: 'a1',
          providerRequestId: 'request-2',
          promptHash: 'c',
          usageSource: 'provider-native',
          inputTokens: 40,
          outputTokens: 10,
          latencyMs: 10,
          startedAtMs: 11,
          endedAtMs: 21,
        },
      ],
    };
    result.semanticHarvest.deltaHash = sha256(delta);
    expect(validateStudyDriverResult(result, trial)).toMatchObject({
      valid: true,
    });
    expect(
      validateStudyDriverResult({ ...result, providerInvocations: 1 }, trial)
        .valid
    ).toBe(false);
    expect(
      validateStudyDriverResult(result, {
        ...trial,
        expectedProviderInvocations: undefined,
      }).diagnostics
    ).toContain('trial omits a valid expectedProviderInvocations count');

    const concurrentTrial = {
      ...trial,
      expectedProviderInvocations: 3,
      successorAgentIds: ['a1', 'a2'],
      concurrentOverlapRequired: true,
    };
    const concurrent = {
      ...result,
      providerInvocations: 3,
      executionTopology: {
        ...result.executionTopology,
        successorAgentIds: ['a1', 'a2'],
        concurrentOverlapObserved: true,
      },
      invocations: [
        result.invocations[0],
        { ...result.invocations[1], startedAtMs: 11, endedAtMs: 21 },
        {
          ...result.invocations[1],
          invocationId: 'consumer-2',
          agentId: 'a2',
          providerRequestId: 'request-3',
          startedAtMs: 12,
          endedAtMs: 22,
        },
      ],
    };
    expect(validateStudyDriverResult(concurrent, concurrentTrial).valid).toBe(
      true
    );
    expect(
      validateStudyDriverResult(
        {
          ...concurrent,
          invocations: [
            concurrent.invocations[0],
            { ...concurrent.invocations[1], startedAtMs: 11, endedAtMs: 12 },
            { ...concurrent.invocations[2], startedAtMs: 13, endedAtMs: 14 },
          ],
        },
        concurrentTrial
      ).valid
    ).toBe(false);
  });
});
