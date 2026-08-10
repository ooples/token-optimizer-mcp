import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { canonicalJson, sha256 } from './protocol.mjs';

export const SCOPE_HIERARCHY = Object.freeze([
  'session',
  'workspace',
  'branch',
  'repository',
  'project',
  'user',
  'organization',
  'global',
]);

const scopeRank = new Map(
  SCOPE_HIERARCHY.map((scope, index) => [scope, index])
);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END/i,
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-/.+=]{8,}/gi,
  /\b(?:gh[pousr]_|sk-)[A-Za-z0-9_-]{16,}\b/g,
];

export function redactSecrets(value) {
  const text = typeof value === 'string' ? value : canonicalJson(value);
  let redacted = text;
  for (const pattern of secretPatterns)
    redacted = redacted.replace(pattern, '[REDACTED]');
  return { redacted, changed: redacted !== text, originalHash: sha256(text) };
}

export function compatibilityPredicate(source, target) {
  const reasons = [];
  const mismatches = [];
  for (const field of [
    'language',
    'framework',
    'operatingSystem',
    'toolchain',
  ]) {
    if (source[field] && target[field] && source[field] !== target[field])
      mismatches.push(field);
    else if (source[field] && target[field])
      reasons.push(`${field}=${source[field]}`);
  }
  if (
    source.frameworkVersion &&
    target.frameworkVersion &&
    String(source.frameworkVersion).split('.')[0] !==
      String(target.frameworkVersion).split('.')[0]
  ) {
    mismatches.push('frameworkVersion');
  }
  if (
    source.policyHash &&
    target.policyHash &&
    source.policyHash !== target.policyHash
  )
    mismatches.push('policyHash');
  if (source.lineage && target.lineage && source.lineage !== target.lineage)
    mismatches.push('lineage');
  return { compatible: mismatches.length === 0, reasons, mismatches };
}

export function taintJoin(...labels) {
  const rank = {
    public: 0,
    internal: 1,
    confidential: 2,
    restricted: 3,
    untrusted: 4,
  };
  return (
    labels.filter(Boolean).sort((a, b) => (rank[b] ?? 4) - (rank[a] ?? 4))[0] ||
    'internal'
  );
}

export function negotiateFederation(source, target) {
  const sharedProtocols = (source.protocolVersions || [])
    .filter((version) => (target.protocolVersions || []).includes(version))
    .sort()
    .reverse();
  const sharedSchemas = (source.schemaVersions || [])
    .filter((version) => (target.schemaVersions || []).includes(version))
    .sort()
    .reverse();
  return {
    compatible: sharedProtocols.length > 0 && sharedSchemas.length > 0,
    protocolVersion: sharedProtocols[0] || null,
    schemaVersion: sharedSchemas[0] || null,
    reasons: [
      ...(sharedProtocols.length ? [] : ['no shared protocol version']),
      ...(sharedSchemas.length ? [] : ['no shared schema version']),
    ],
  };
}

export function federatedContentRisk(value) {
  const text = typeof value === 'string' ? value : canonicalJson(value);
  const patterns = [
    /ignore (?:all )?(?:previous|prior|system) instructions/i,
    /(?:run|execute|invoke) (?:this )?(?:shell|command|tool)/i,
    /reveal (?:the )?(?:secret|token|password|system prompt)/i,
    /<\/?(?:system|assistant|tool)>/i,
  ];
  const matched = patterns
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.source);
  return { safe: matched.length === 0, matched, contentHash: sha256(text) };
}

export class FederationPolicy {
  constructor({
    principal,
    tenantId,
    grants = [],
    revocations = [],
    revokedKeys = [],
    requireAuthentication = false,
  } = {}) {
    this.principal = principal;
    this.tenantId = tenantId;
    this.grants = grants;
    this.revocations = new Set(revocations);
    this.revokedKeys = new Set(revokedKeys);
    this.requireAuthentication = requireAuthentication;
    this.audit = [];
  }

  authorize(object, target, { operation = 'retrieve' } = {}) {
    const compatibility = compatibilityPredicate(
      object.compatibility || {},
      target.compatibility || {}
    );
    const objectScope = object.scope?.level || 'project';
    const requestedScope = target.scope?.level || 'project';
    const grant = this.grants.find(
      (candidate) =>
        candidate.operation === operation &&
        candidate.sourceTenant === object.tenantId &&
        candidate.targetTenant === target.tenantId &&
        scopeRank.get(candidate.maximumScope) >= scopeRank.get(requestedScope)
    );
    const denied = [];
    if (this.requireAuthentication && target.authenticated !== true)
      denied.push('target principal is not authenticated');
    if (
      grant?.principal &&
      target.principal &&
      grant.principal !== target.principal
    )
      denied.push('grant principal mismatch');
    if (this.revocations.has(object.id)) denied.push('object revoked');
    if (!grant) denied.push('no matching federation grant');
    if (!compatibility.compatible)
      denied.push(`incompatible: ${compatibility.mismatches.join(', ')}`);
    if (scopeRank.get(objectScope) < scopeRank.get(requestedScope))
      denied.push('source scope does not authorize requested transfer');
    if (
      object.sensitivity === 'restricted' &&
      object.tenantId !== target.tenantId
    )
      denied.push('restricted data cannot cross tenant');
    const decision = {
      authorized: denied.length === 0,
      objectId: object.id,
      sourceTenant: object.tenantId,
      targetTenant: target.tenantId,
      operation,
      compatibility,
      grantId: grant?.id || null,
      denied,
    };
    this.audit.push({ ...decision, at: Date.now() });
    return decision;
  }

  revoke(objectId, reason) {
    this.revocations.add(objectId);
    this.audit.push({ operation: 'revoke', objectId, reason, at: Date.now() });
  }

  revokeKey(keyId, reason) {
    this.revokedKeys.add(keyId);
    this.audit.push({ operation: 'revoke-key', keyId, reason, at: Date.now() });
  }
}

export function signedBundle(bundle, privateKey, { keyId = null } = {}) {
  const body = {
    schemaVersion: 'ucr.federation-bundle/1',
    ...bundle,
    keyId: keyId || bundle.keyId || null,
    bundleHash: sha256(bundle),
  };
  const key =
    privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey);
  const signature = sign(null, Buffer.from(canonicalJson(body)), key).toString(
    'base64'
  );
  return { ...body, signature };
}

export function verifyBundle(bundle, publicKey, policy, target) {
  const { signature, ...body } = bundle;
  const key =
    publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey);
  const validSignature = verify(
    null,
    Buffer.from(canonicalJson(body)),
    key,
    Buffer.from(signature || '', 'base64')
  );
  const keyRevoked = Boolean(bundle.keyId && policy.revokedKeys.has(bundle.keyId));
  const objects = bundle.objects || [];
  const decisions = objects.map((object) =>
    policy.authorize(object, target, {
      operation: object.type === 'guard' ? 'execute-guard' : 'retrieve',
    })
  );
  return {
    valid:
      validSignature &&
      !keyRevoked &&
      decisions.every((decision) => decision.authorized),
    validSignature,
    keyRevoked,
    decisions,
    executable:
      validSignature &&
      !keyRevoked &&
      decisions.every((decision) => decision.authorized) &&
      objects
        .filter((object) => object.type === 'guard')
        .every((guard) => guard.executableAuthorized === true),
  };
}

export function safeFederatedCapsule(object, authorization) {
  if (!authorization?.authorized) return null;
  const redaction = redactSecrets({
    claim: object.claim,
    correction: object.correction,
    applicability: object.applicability,
  });
  if (redaction.changed) return null;
  const risk = federatedContentRisk(redaction.redacted);
  if (!risk.safe) return null;
  return {
    objectId: object.id,
    sourceProject: object.scope?.projectId,
    authorizedBy: authorization.grantId,
    compatibility: authorization.compatibility.reasons,
    taint: taintJoin(object.sensitivity, object.taint),
    content: JSON.parse(redaction.redacted),
    contentIsData: true,
    executable: false,
    contentRisk: risk,
  };
}

export function signedRevocation(revocation, privateKey) {
  if (!revocation?.objectId && !revocation?.keyId)
    throw new Error('revocation requires objectId or keyId');
  const body = {
    schemaVersion: 'ucr.revocation/1',
    ...revocation,
  };
  return {
    ...body,
    signature: sign(
      null,
      Buffer.from(canonicalJson(body)),
      privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey)
    ).toString('base64'),
  };
}

export function applySignedRevocation(revocation, publicKey, policy) {
  const { signature, ...body } = revocation || {};
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(canonicalJson(body)),
      publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey),
      Buffer.from(signature || '', 'base64')
    );
  } catch {
    valid = false;
  }
  if (!valid) return { applied: false, reason: 'invalid revocation signature' };
  if (body.objectId) policy.revoke(body.objectId, body.reason || 'signed revocation');
  if (body.keyId) policy.revokeKey(body.keyId, body.reason || 'signed revocation');
  return { applied: true, objectId: body.objectId || null, keyId: body.keyId || null };
}

export function federationRedTeam(cases) {
  const results = cases.map((item) => {
    const risk = federatedContentRisk(item.content);
    const secret = redactSecrets(item.content);
    const rejected = !risk.safe || secret.changed;
    return { id: item.id, expectedReject: item.expectedReject, rejected, risk, secret };
  });
  const falseAccepts = results.filter(
    (item) => item.expectedReject && !item.rejected
  ).length;
  const falseRejects = results.filter(
    (item) => !item.expectedReject && item.rejected
  ).length;
  return {
    cases: results.length,
    falseAccepts,
    falseRejects,
    passed: results.length > 0 && falseAccepts === 0 && falseRejects === 0,
    results,
  };
}
