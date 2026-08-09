import { sha256 } from './protocol.mjs';

export const SEMANTIC_OBJECT_KINDS = Object.freeze([
  'claim',
  'failure',
  'decision',
  'procedure',
  'goal',
  'hypothesis',
  'guard',
]);

const confidenceLabels = new Set(['speculative', 'observed', 'verified']);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-/.+=]{12,}/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
];

const commonRequired = [
  'trigger',
  'applicability',
  'nonApplicability',
  'invalidators',
  'scope',
  'confidence',
  'confidenceLabel',
  'expectedOutcome',
];

const requiredByKind = Object.freeze({
  claim: ['claim', 'evidence'],
  failure: [
    'attemptedAction',
    'observedFailure',
    'rootCause',
    'correction',
    'verificationEvidence',
  ],
  decision: ['decision', 'alternatives', 'reason'],
  procedure: ['steps', 'verificationEvidence'],
  goal: ['desiredState', 'completionEvidence'],
  hypothesis: ['hypothesis', 'discriminatingTests'],
  guard: [
    'attemptedAction',
    'observedFailure',
    'rootCause',
    'correction',
    'verificationEvidence',
    'guard',
  ],
});

function hasValue(value) {
  return (
    value !== undefined &&
    value !== null &&
    value !== '' &&
    (!Array.isArray(value) || value.length > 0)
  );
}

export function validateSemanticObject(
  kind,
  semantic,
  { allowSecrets = false } = {}
) {
  const diagnostics = [];
  if (!SEMANTIC_OBJECT_KINDS.includes(kind))
    diagnostics.push(`unsupported semantic kind ${kind}`);
  for (const field of [...commonRequired, ...(requiredByKind[kind] || [])]) {
    if (!hasValue(semantic?.[field])) diagnostics.push(`${field} is required`);
  }
  if (
    !Array.isArray(semantic?.applicability) ||
    !semantic.applicability.length
  ) {
    diagnostics.push('applicability must contain positive conditions');
  }
  if (
    !Array.isArray(semantic?.nonApplicability) ||
    !semantic.nonApplicability.length
  ) {
    diagnostics.push('nonApplicability must contain negative conditions');
  }
  if (!Array.isArray(semantic?.invalidators))
    diagnostics.push('invalidators must be an array');
  if (
    !Number.isFinite(semantic?.confidence) ||
    semantic.confidence < 0 ||
    semantic.confidence > 1
  ) {
    diagnostics.push('confidence must be between 0 and 1');
  }
  if (!confidenceLabels.has(semantic?.confidenceLabel)) {
    diagnostics.push(
      'confidenceLabel must be speculative, observed, or verified'
    );
  }
  const serialized = JSON.stringify(semantic || {});
  if (
    !allowSecrets &&
    secretPatterns.some((pattern) => pattern.test(serialized))
  ) {
    diagnostics.push('semantic object appears to contain a secret');
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

function receiptSucceeded(receipt) {
  return (
    receipt &&
    (receipt.type === 'verification.passed' ||
      receipt.type === 'tool.result' ||
      receipt.type === 'outcome.recorded') &&
    (receipt.payload?.passed === true ||
      receipt.payload?.success === true ||
      receipt.payload?.correct === true)
  );
}

export class SemanticCompiler {
  constructor({ eventFactory, receiptVerifier = null }) {
    if (typeof eventFactory !== 'function')
      throw new Error('SemanticCompiler requires eventFactory');
    this.eventFactory = eventFactory;
    this.receiptVerifier = receiptVerifier;
    this.proposals = new Map();
    this.verified = new Map();
    this.reflectedSessions = new Set();
    this.fingerprints = new Map();
    this.costs = [];
  }

  propose(
    kind,
    semantic,
    { producer, proposalId = null, resources = null } = {}
  ) {
    const validation = validateSemanticObject(kind, semantic);
    if (!validation.valid)
      return { accepted: false, diagnostics: validation.diagnostics };
    const fingerprint = sha256({
      kind,
      trigger: semantic.trigger,
      correction: semantic.correction,
      claim: semantic.claim,
      scope: semantic.scope,
      applicability: semantic.applicability,
      nonApplicability: semantic.nonApplicability,
    });
    const duplicateOf = this.fingerprints.get(fingerprint);
    if (duplicateOf)
      return {
        accepted: false,
        duplicate: true,
        duplicateOf,
        diagnostics: [`semantic duplicate of ${duplicateOf}`],
      };
    const id =
      proposalId || `${kind}:${sha256({ producer, semantic }).slice(0, 24)}`;
    const proposal = {
      id,
      type: kind,
      state: 'proposed',
      producer,
      semanticFingerprint: fingerprint,
      ...semantic,
      fieldProvenance: Object.fromEntries(
        Object.keys(semantic).map((field) => [
          field,
          semantic.evidenceReceipts || [],
        ])
      ),
    };
    this.proposals.set(id, proposal);
    this.fingerprints.set(fingerprint, id);
    if (resources) {
      this.costs.push({
        proposalId: id,
        producer,
        inputTokens: resources.inputTokens ?? null,
        outputTokens: resources.outputTokens ?? null,
        latencyMs: resources.latencyMs ?? null,
        costUsd: resources.costUsd ?? null,
      });
    }
    return {
      accepted: true,
      diagnostics: [],
      proposal,
      event: this.eventFactory('finding.proposed', {
        object: proposal,
      }),
    };
  }

  verify(proposalId, receipts, { peerChallenge = null } = {}) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal)
      return { verified: false, diagnostics: ['proposal not found'] };
    const referenced = new Set(proposal.evidenceReceipts || []);
    const successful = receipts.filter((receipt) => {
      if (!referenced.has(receipt.eventId) || !receiptSucceeded(receipt))
        return false;
      return this.receiptVerifier ? this.receiptVerifier(receipt) : true;
    });
    if (!successful.length) {
      return {
        verified: false,
        diagnostics: ['no successful referenced verification receipt'],
      };
    }
    const compiled = {
      ...proposal,
      state: 'verified',
      confidenceLabel: 'verified',
      verificationReceiptIds: successful
        .map((receipt) => receipt.eventId)
        .sort(),
      verificationReceiptHash: sha256(
        successful
          .map((receipt) => ({
            eventId: receipt.eventId,
            type: receipt.type,
            payloadHash: receipt.payloadHash || sha256(receipt.payload || {}),
          }))
          .sort((a, b) => a.eventId.localeCompare(b.eventId))
      ),
      peerChallenge: peerChallenge
        ? {
            author: peerChallenge.author,
            critique: peerChallenge.critique,
            proposedTest: peerChallenge.proposedTest,
          }
        : null,
    };
    this.verified.set(proposalId, compiled);
    return {
      verified: true,
      diagnostics: [],
      object: compiled,
      event: this.eventFactory('finding.verified', {
        object: compiled,
        relations: successful.map((receipt) => ({
          from: proposalId,
          to: `event:${receipt.eventId}`,
          type: 'verified_by',
        })),
      }),
    };
  }

  activate(proposalId) {
    const verified = this.verified.get(proposalId);
    if (!verified)
      return {
        activated: false,
        diagnostics: ['proposal has not been verified'],
      };
    const active = { ...verified, state: 'active' };
    return {
      activated: true,
      diagnostics: [],
      object: active,
      event: this.eventFactory('finding.activated', { object: active }),
    };
  }

  reflectionRequest(sessionId, { lifecycleCanContinue = false } = {}) {
    if (!lifecycleCanContinue) {
      return {
        requested: false,
        reason: 'client requires explicit active-model write',
      };
    }
    if (this.reflectedSessions.has(sessionId)) {
      return {
        requested: false,
        reason: 'completion reflection already requested for session',
      };
    }
    this.reflectedSessions.add(sessionId);
    return {
      requested: true,
      prompt:
        'Record only durable, evidence-backed cognition established by this completed work.',
    };
  }

  resourceUsage() {
    const sum = (field) =>
      this.costs.reduce(
        (total, item) =>
          total + (Number.isFinite(item[field]) ? Number(item[field]) : 0),
        0
      );
    return {
      proposals: this.costs.length,
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      latencyMs: sum('latencyMs'),
      costUsd: sum('costUsd'),
      entries: [...this.costs],
    };
  }
}

function conditionMatch(condition, context) {
  if (typeof condition === 'string') {
    const text = JSON.stringify(context).toLowerCase();
    const normalized = condition.toLowerCase();
    if (/\b(?:not|never|without)\b/.test(normalized) !== /\b(?:not|never|without)\b/.test(text))
      return false;
    const terms = normalized
      .split(/[^a-z0-9]+/)
      .filter(
        (word) =>
          word.length > 2 &&
          !['the', 'and', 'from', 'this', 'that', 'with'].includes(word)
      );
    return (
      terms.length > 0 &&
      terms.filter((word) => text.includes(word)).length / terms.length >= 0.6
    );
  }
  const actual = String(condition?.field || '')
    .split('.')
    .reduce((value, key) => value?.[key], context);
  if (condition?.operator === 'equals') return actual === condition.value;
  if (condition?.operator === 'contains')
    return String(actual || '').includes(String(condition.value));
  if (condition?.operator === 'in')
    return Array.isArray(condition.value) && condition.value.includes(actual);
  if (condition?.operator === 'matches') {
    try {
      return new RegExp(String(condition.value), condition.flags || '').test(
        String(actual || '')
      );
    } catch {
      return false;
    }
  }
  return false;
}

export function semanticApplicability(object, context) {
  const positive = object?.applicability || [];
  const negative = object?.nonApplicability || [];
  const positiveMatch = positive.some((condition) =>
    conditionMatch(condition, context)
  );
  const negativeMatch = negative.some((condition) =>
    conditionMatch(condition, context)
  );
  return {
    applicable: positiveMatch && !negativeMatch,
    positiveMatch,
    negativeMatch,
    abstained: !positiveMatch || negativeMatch,
  };
}

export function semanticQuality(objects, fixtures = []) {
  const total = objects.length;
  const count = (predicate) => objects.filter(predicate).length;
  const cases = fixtures.flatMap((fixture) =>
    objects
      .filter(
        (object) => !fixture.objectId || fixture.objectId === object.id
      )
      .map((object) => ({
        expected: Boolean(fixture.expectedApplicable),
        actual: semanticApplicability(object, fixture.context || {}).applicable,
      }))
  );
  const negatives = cases.filter((item) => !item.expected);
  const positives = cases.filter((item) => item.expected);
  return {
    total,
    positiveApplicabilityRate: total
      ? count((item) => item.applicability?.length > 0) / total
      : null,
    negativeApplicabilityRate: total
      ? count((item) => item.nonApplicability?.length > 0) / total
      : null,
    verifiedReceiptCoverage: total
      ? count((item) => item.verificationReceiptIds?.length > 0) / total
      : null,
    duplicateRate: total
      ? 1 -
        new Set(
          objects.map((item) =>
            sha256({
              type: item.type,
              trigger: item.trigger,
              correction: item.correction,
              claim: item.claim,
            })
          )
        ).size /
          total
      : null,
    hardNegativeCases: negatives.length,
    overgeneralizationRate: negatives.length
      ? negatives.filter((item) => item.actual).length / negatives.length
      : null,
    applicabilityRecall: positives.length
      ? positives.filter((item) => item.actual).length / positives.length
      : null,
  };
}

export function semanticFieldTrace(object) {
  const provenance = object?.fieldProvenance || {};
  return Object.keys(provenance)
    .map((field) => ({
      field,
      evidenceReceiptIds: [...new Set(provenance[field] || [])].sort(),
      traceable: (provenance[field] || []).length > 0,
    }));
}
