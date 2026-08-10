import { sha256 } from './protocol.mjs';

export const MODEL_ATTESTATION_PROTOCOL = 'ucr.model-attestation/1';

const TRUSTED_SOURCES = new Map([
  ['antigravity/stream-json', { client: 'gemini', provider: 'google' }],
  [
    'claude-code/stream-json',
    { client: 'claude-code', provider: 'anthropic' },
  ],
  ['codex-app-server/thread-start', { client: 'codex', provider: 'openai' }],
  ['gemini-cli/stream-json', { client: 'gemini', provider: 'google' }],
]);

/** Bind a planned model to provider-native execution telemetry. */
export function createModelAttestation({
  client,
  provider,
  requestedModel,
  effectiveModel,
  source,
  providerRequestId,
  evidence,
  reroutes = [],
}) {
  const normalizedReroutes = Array.isArray(reroutes)
    ? reroutes.map((reroute) => ({
        fromModel: reroute?.fromModel || null,
        toModel: reroute?.toModel || null,
        reason: reroute?.reason || null,
      }))
    : [];
  const binding = {
    client,
    provider,
    requestedModel,
    effectiveModel,
    source,
    providerRequestId,
    reroutes: normalizedReroutes,
    evidenceHash: sha256(evidence || {}),
  };
  return {
    schemaVersion: MODEL_ATTESTATION_PROTOCOL,
    ...binding,
    attestationHash: sha256(binding),
  };
}

/** Fail closed unless the provider-native record proves the frozen model. */
export function validateModelAttestation(
  attestation,
  { client, requestedModel, providerRequestId } = {}
) {
  const diagnostics = [];
  if (attestation?.schemaVersion !== MODEL_ATTESTATION_PROTOCOL)
    diagnostics.push('unsupported model attestation protocol');
  const trustedSource = TRUSTED_SOURCES.get(attestation?.source);
  if (!trustedSource)
    diagnostics.push('model attestation source is not trusted');
  else {
    if (trustedSource.client !== attestation?.client)
      diagnostics.push('model attestation source/client mismatch');
    if (trustedSource.provider !== attestation?.provider)
      diagnostics.push('model attestation source/provider mismatch');
  }
  if (attestation?.client !== client)
    diagnostics.push('model attestation client mismatch');
  if (!attestation?.provider)
    diagnostics.push('model attestation provider is missing');
  if (attestation?.requestedModel !== requestedModel)
    diagnostics.push('model attestation requested model mismatch');
  if (attestation?.effectiveModel !== requestedModel)
    diagnostics.push('provider effective model differs from frozen model');
  if (!attestation?.providerRequestId)
    diagnostics.push('model attestation provider request id is missing');
  if (
    !providerRequestId ||
    attestation?.providerRequestId !== providerRequestId
  )
    diagnostics.push('model attestation is not bound to provider request');
  if (!attestation?.evidenceHash)
    diagnostics.push('model attestation evidence hash is missing');
  if (attestation?.reroutes?.length)
    diagnostics.push('provider rerouted the frozen model');
  const { attestationHash, schemaVersion: _schemaVersion, ...binding } =
    attestation || {};
  if (!attestationHash || attestationHash !== sha256(binding))
    diagnostics.push('model attestation hash mismatch');
  return { valid: diagnostics.length === 0, diagnostics };
}
