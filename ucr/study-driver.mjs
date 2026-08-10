import { UCR_CLIENT_REGISTRY } from './adapter-sdk.mjs';
import { sha256 } from './protocol.mjs';

export const STUDY_DRIVER_PROTOCOL = 'ucr.study-driver/1';

export function studyDriverEnvironmentKey(client) {
  if (!UCR_CLIENT_REGISTRY[client])
    throw new Error(`unknown UCR study client ${client}`);
  return `UCR_STUDY_DRIVER_${client.toUpperCase().replaceAll('-', '_')}`;
}

export function studyDirectionEnvironmentKey(producer, consumer) {
  for (const client of [producer, consumer])
    if (!UCR_CLIENT_REGISTRY[client])
      throw new Error(`unknown UCR study client ${client}`);
  const normalize = (value) => value.toUpperCase().replaceAll('-', '_');
  return `UCR_STUDY_DIRECTION_${normalize(producer)}_TO_${normalize(consumer)}`;
}

export function studyDriverRegistry() {
  return Object.fromEntries(
    Object.entries(UCR_CLIENT_REGISTRY).map(([client, profile]) => [
      client,
      {
        protocol: STUDY_DRIVER_PROTOCOL,
        environmentKey: studyDriverEnvironmentKey(client),
        lifecycleFamily: profile.family,
        capabilityTier: profile.tier,
        liveStatus: 'requires-executable-certification',
      },
    ])
  );
}

/** Validate host telemetry from the planned predecessor/successor topology. */
export function validateStudyDriverResult(result, trial) {
  const diagnostics = [];
  if (result?.schemaVersion !== STUDY_DRIVER_PROTOCOL)
    diagnostics.push('unsupported study driver protocol');
  if (result?.producerClient !== trial?.producerClient)
    diagnostics.push('producer client mismatch');
  if (result?.consumerClient !== trial?.consumerClient)
    diagnostics.push('consumer client mismatch');
  const expectedInvocations = trial?.expectedProviderInvocations || 2;
  if (result?.providerInvocations !== expectedInvocations)
    diagnostics.push(
      `trial requires exactly ${expectedInvocations} planned provider calls`
    );
  const telemetry = result?.invocations || [];
  const producerInvocations = telemetry.filter(
    (invocation) => invocation?.role === 'producer'
  );
  const consumerInvocations = telemetry.filter((invocation) =>
    String(invocation?.role || '').startsWith('consumer')
  );
  const semanticDelta = result?.semanticHarvest?.delta;
  if (result?.semanticHarvest?.modelAuthored !== true)
    diagnostics.push('active model did not author semantic capture');
  if (
    !semanticDelta ||
    !semanticDelta.type ||
    !semanticDelta.trigger ||
    !semanticDelta.attemptedAction ||
    !semanticDelta.observedFailure ||
    !semanticDelta.rootCause ||
    !semanticDelta.correction ||
    !semanticDelta.verificationEvidence ||
    !semanticDelta.expectedOutcome ||
    !Array.isArray(semanticDelta.applicability) ||
    semanticDelta.applicability.length === 0 ||
    !Array.isArray(semanticDelta.nonApplicability) ||
    semanticDelta.nonApplicability.length === 0 ||
    !Array.isArray(semanticDelta.invalidators) ||
    semanticDelta.invalidators.length === 0 ||
    !Number.isFinite(semanticDelta.confidence) ||
    !Array.isArray(semanticDelta.evidenceRefs) ||
    semanticDelta.evidenceRefs.length === 0
  )
    diagnostics.push('model-authored semantic delta is incomplete');
  if (
    result?.semanticHarvest?.deltaHash !== sha256(semanticDelta || {})
  )
    diagnostics.push('semantic delta hash mismatch');
  if (
    producerInvocations.length !== 1 ||
    result?.semanticHarvest?.authorInvocationId !== producerInvocations[0]?.invocationId
  )
    diagnostics.push('semantic delta is not bound to the producer invocation');
  if (result?.semanticHarvest?.additionalModelCalls !== 0)
    diagnostics.push('semantic capture added a model call');
  if (result?.consumerMcpExposed !== false)
    diagnostics.push('consumer was exposed to the MCP server');
  if (result?.phaseAccounting?.staticSchemaTokens !== 0)
    diagnostics.push('consumer received static MCP schema tokens');
  if (!Array.isArray(result?.actionAudit) || result.actionAudit.length === 0)
    diagnostics.push('host action audit is missing');
  if (result?.actionAuditComplete !== true)
    diagnostics.push('host action audit is incomplete');
  if (!Number.isFinite(result?.totalTokens) || result.totalTokens < 0)
    diagnostics.push('provider-native total token accounting is missing');
  if (!Number.isFinite(result?.latencyMs) || result.latencyMs < 0)
    diagnostics.push('provider latency accounting is missing');
  if (!result?.producerVersion || !result?.consumerVersion)
    diagnostics.push('CLI versions are not pinned in the result');
  if (!result?.modelVersion)
    diagnostics.push('model version is not pinned in the result');
  if (
    telemetry.length !== expectedInvocations ||
    producerInvocations.length !== 1 ||
    consumerInvocations.length !== expectedInvocations - 1 ||
    new Set(telemetry.map((invocation) => invocation?.invocationId)).size !==
      telemetry.length ||
    telemetry.some(
      (invocation) =>
        !invocation?.invocationId ||
        !invocation?.role ||
        !invocation?.providerRequestId ||
        (!String(invocation?.role).startsWith('producer') &&
          !invocation?.agentId) ||
        !invocation?.promptHash ||
        invocation?.usageSource !== 'provider-native' ||
        !Number.isFinite(invocation?.inputTokens) ||
        !Number.isFinite(invocation?.outputTokens) ||
        !Number.isFinite(invocation?.latencyMs) ||
        !Number.isFinite(invocation?.startedAtMs) ||
        !Number.isFinite(invocation?.endedAtMs) ||
        invocation.endedAtMs < invocation.startedAtMs
    )
  )
    diagnostics.push('per-invocation phase telemetry is incomplete');
  const topology = result?.executionTopology || {};
  for (const key of [
    'producerContinuitySessionId',
    'consumerContinuitySessionId',
    'producerProjectId',
    'consumerProjectId',
  ]) {
    if (topology[key] !== trial?.[key])
      diagnostics.push(`execution topology ${key} mismatch`);
  }
  if (
    JSON.stringify(topology.successorAgentIds || []) !==
    JSON.stringify(trial?.successorAgentIds || [])
  )
    diagnostics.push('successor agent topology mismatch');
  if (
    JSON.stringify(consumerInvocations.map((invocation) => invocation.agentId)) !==
    JSON.stringify(trial?.successorAgentIds || [])
  )
    diagnostics.push('consumer invocations are not bound to planned agents');
  const concurrentOverlapObserved =
    consumerInvocations.length > 1 &&
    consumerInvocations.every((left, index) =>
      consumerInvocations.every(
        (right, otherIndex) =>
          index === otherIndex ||
          (left.startedAtMs < right.endedAtMs &&
            right.startedAtMs < left.endedAtMs)
      )
    );
  if (
    trial?.concurrentOverlapRequired === true &&
    (topology.concurrentOverlapObserved !== true || !concurrentOverlapObserved)
  )
    diagnostics.push('concurrent successors did not overlap');
  if (
    result?.delivered === true &&
    result?.deliveryPhase !== 'pre-action'
  )
    diagnostics.push('delivered cognition was not available pre-action');
  return {
    valid: diagnostics.length === 0,
    diagnostics,
    resultHash: sha256(result || {}),
  };
}
