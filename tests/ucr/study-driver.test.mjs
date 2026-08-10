import { describe, expect, test } from '@jest/globals';
import {
  STUDY_DRIVER_PROTOCOL,
  UCR_CLIENT_REGISTRY,
  createModelAttestation,
  sha256,
  studyDriverChildEnvironment,
  studyDriverProcessTimeoutMs,
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
        UCR_LIVE_STUDY_MAX_BUDGET_USD: '5',
        UCR_STUDY_DRIVER_ENV_ALLOWLIST:
          'OPENAI_API_KEY,UCR_STUDY_SECRET,UCR_EVIDENCE_PRIVATE_KEY_FILE',
      })
    ).toEqual({
      PATH: 'bin',
      UCR_LIVE_STUDY_MAX_BUDGET_USD: '5',
      OPENAI_API_KEY: 'provider-key',
    });
  });

  test('passes supported provider credentials by default and never evidence secrets', () => {
    expect(
      studyDriverChildEnvironment({
        OPENAI_API_KEY: 'openai',
        ANTHROPIC_API_KEY: 'anthropic',
        GEMINI_API_KEY: 'gemini',
        GOOGLE_CLOUD_PROJECT: 'project',
        UCR_STUDY_SECRET: 'study',
        UCR_TRAFFIC_PSEUDONYM_SECRET: 'traffic',
      })
    ).toEqual({
      ANTHROPIC_API_KEY: 'anthropic',
      GEMINI_API_KEY: 'gemini',
      GOOGLE_CLOUD_PROJECT: 'project',
      OPENAI_API_KEY: 'openai',
    });
  });

  test('budgets the whole multi-invocation driver plus cleanup', () => {
    expect(
      studyDriverProcessTimeoutMs({
        budgets: { timeoutMs: 600_000 },
        expectedProviderInvocations: 3,
      })
    ).toBe(1_830_000);
    expect(
      studyDriverProcessTimeoutMs(
        { budgets: { timeoutMs: 600_000 }, expectedProviderInvocations: 3 },
        { UCR_STUDY_DRIVER_TIMEOUT_MS: '45000' }
      )
    ).toBe(45_000);
  });

  test('requires the planned calls, zero capture calls, and complete telemetry', () => {
    const trial = {
      producerClient: 'codex',
      consumerClient: 'claude-code',
      producerVersion: 'codex-v1',
      consumerVersion: 'claude-v1',
      producerModelVersion: 'gpt-model-v1',
      consumerModelVersion: 'claude-model-v1',
      producerTransport: 'codex-app-server',
      consumerTransport: 'claude-code',
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
        verification: {
          verified: true,
          anchors: [
            { path: 'evidence/current.json', sha256: 'a'.repeat(64) },
          ],
        },
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
          transport: 'codex-app-server',
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
          transport: 'claude-code',
          latencyMs: 10,
          startedAtMs: 11,
          endedAtMs: 21,
        },
      ],
    };
    const attest = ({ client, provider, model, request, source }) =>
      createModelAttestation({
        client,
        provider,
        requestedModel: model,
        effectiveModel: model,
        source,
        providerRequestId: request,
        evidence: { request, model },
      });
    result.invocations[0].modelAttestation = attest({
      client: 'codex',
      provider: 'openai',
      model: 'gpt-model-v1',
      request: 'request-1',
      source: 'codex-app-server/thread-start',
    });
    result.invocations[1].modelAttestation = attest({
      client: 'claude-code',
      provider: 'anthropic',
      model: 'claude-model-v1',
      request: 'request-2',
      source: 'claude-code/stream-json',
    });
    result.semanticHarvest.deltaHash = sha256(delta);
    expect(validateStudyDriverResult(result, trial)).toMatchObject({
      valid: true,
    });
    expect(
      validateStudyDriverResult({ ...result, providerInvocations: 1 }, trial)
        .valid
    ).toBe(false);
    expect(
      validateStudyDriverResult(
        {
          ...result,
          invocations: [
            {
              ...result.invocations[0],
              modelAttestation: {
                ...result.invocations[0].modelAttestation,
                effectiveModel: 'gpt-model-v0',
              },
            },
            result.invocations[1],
          ],
        },
        trial
      ).valid
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
          modelAttestation: attest({
            client: 'claude-code',
            provider: 'anthropic',
            model: 'claude-model-v1',
            request: 'request-3',
            source: 'claude-code/stream-json',
          }),
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
