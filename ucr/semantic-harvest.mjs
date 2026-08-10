import { canonicalJson, sha256 } from './protocol.mjs';

export const SEMANTIC_HARVEST_FAILURE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    trigger: { type: 'string', minLength: 1 },
    attemptedAction: { type: 'string', minLength: 1 },
    observedFailure: { type: 'string', minLength: 1 },
    rootCause: { type: 'string', minLength: 1 },
    correction: { type: 'string', minLength: 1 },
    verificationEvidence: { type: 'string', minLength: 1 },
    applicability: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    nonApplicability: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    invalidators: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    scope: {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 1 },
        projectId: { type: 'string', minLength: 1 },
        workspaceId: { type: 'string', minLength: 1 },
      },
      required: ['taskId', 'projectId', 'workspaceId'],
      additionalProperties: false,
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    confidenceLabel: { type: 'string', enum: ['verified'] },
    expectedOutcome: { type: 'string', minLength: 1 },
  },
  required: [
    'trigger',
    'attemptedAction',
    'observedFailure',
    'rootCause',
    'correction',
    'verificationEvidence',
    'applicability',
    'nonApplicability',
    'invalidators',
    'scope',
    'confidence',
    'confidenceLabel',
    'expectedOutcome',
  ],
  additionalProperties: false,
});

function parseAuthoredObject(raw) {
  const text = String(raw || '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new Error(`model semantic harvest was not JSON: ${error.message}`);
  }
  const semanticObject = parsed?.semanticObject || parsed;
  if (
    !semanticObject ||
    typeof semanticObject !== 'object' ||
    Array.isArray(semanticObject)
  ) {
    throw new Error('model semantic harvest must be one JSON object');
  }
  return semanticObject;
}

function authoringPrompt({ kind, verifiedEvidence, taskId, scope, feedback }) {
  return [
    'You are the active model performing semantic harvesting from externally authenticated benchmark evidence.',
    'This evidence is not your personal session history. Represent it as an external verified observation; do not invent events or provenance.',
    `Authenticated evidence: ${canonicalJson(verifiedEvidence)}`,
    `Author one kind=${kind} semantic object for task ${taskId}.`,
    `Use this exact scope boundary: ${canonicalJson(scope)}.`,
    'Return only one JSON object, without prose or a code fence.',
    'It must include trigger, applicability (non-empty), nonApplicability (non-empty), invalidators (non-empty), scope, confidence, confidenceLabel, and expectedOutcome.',
    'For failure include attemptedAction, observedFailure, rootCause, correction, and verificationEvidence. Preserve the concrete failed and corrected values from the authenticated observations.',
    'confidenceLabel must be verified. Applicability must identify only this task; nonApplicability must exclude every other task.',
    feedback ? `Correct the prior rejected output: ${feedback}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Keeps semantic interpretation model-led while making authentication and
 * persistence deterministic. The model authors bytes; the host verifies the
 * evidence first and persists only the exact parsed object after validation.
 */
export class SemanticHarvestController {
  constructor({ verifyEvidence, persist, maximumAuthoringAttempts = 2 } = {}) {
    if (typeof verifyEvidence !== 'function' || typeof persist !== 'function')
      throw new Error(
        'SemanticHarvestController requires verifyEvidence and persist functions'
      );
    this.verifyEvidence = verifyEvidence;
    this.persist = persist;
    this.maximumAuthoringAttempts = maximumAuthoringAttempts;
  }

  async harvest(
    { kind, evidenceReceipts, taskId, sessionId, scope },
    invokeModel
  ) {
    if (typeof invokeModel !== 'function')
      throw new Error('semantic harvest requires an active-model invoker');
    const verified = await this.verifyEvidence({ evidenceReceipts });
    if (!verified?.valid || !Array.isArray(verified.receipts))
      throw new Error('semantic harvest evidence authentication failed');

    let feedback = null;
    let lastError = null;
    for (let attempt = 1; attempt <= this.maximumAuthoringAttempts; attempt++) {
      const prompt = authoringPrompt({
        kind,
        verifiedEvidence: verified.receipts,
        taskId,
        scope,
        feedback,
      });
      let raw;
      let semanticObject;
      try {
        raw = await invokeModel({ prompt, attempt });
        semanticObject = parseAuthoredObject(raw);
      } catch (error) {
        lastError = error;
        feedback = error.message;
        continue;
      }
      const persisted = await this.persist({
        operation: 'record',
        kind,
        semanticObject,
        evidenceReceipts,
        taskId,
        sessionId,
      });
      if (persisted?.accepted) {
        const receiptBody = {
          schemaVersion: 'ucr.semantic-harvest-receipt/1',
          modelAuthored: true,
          evidenceAuthenticatedBeforeAuthoring: true,
          kind,
          taskId,
          attempts: attempt,
          modelOutputHash: sha256(String(raw)),
          semanticObjectHash: sha256(semanticObject),
          activatedObjectId: persisted.object?.id || null,
          eventIds: persisted.eventIds || [],
        };
        return {
          semanticObject,
          persisted,
          receipt: {
            ...receiptBody,
            receiptHash: sha256(receiptBody),
          },
        };
      }
      feedback = (persisted?.diagnostics || ['semantic validation failed']).join(
        '; '
      );
      lastError = new Error(feedback);
    }
    throw new Error(
      `model-authored semantic harvest failed after ${this.maximumAuthoringAttempts} attempts: ${lastError?.message || feedback}`
    );
  }
}
