import { canonicalJson, sha256 } from './protocol.mjs';

export const SEMANTIC_DELTA_MARKERS = Object.freeze({
  start: '<ucr-semantic-delta>',
  end: '</ucr-semantic-delta>',
});

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
    guard: {
      type: 'object',
      properties: {
        triggers: {
          type: 'array',
          minItems: 1,
          maxItems: 1,
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', minLength: 1 },
              operator: {
                type: 'string',
                enum: ['equals', 'contains', 'matches', 'startsWith', 'in'],
              },
              value: { type: 'string', minLength: 1 },
            },
            required: ['field', 'operator', 'value'],
            additionalProperties: false,
          },
        },
        intervention: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['replace-parameters'] },
          },
          required: ['type'],
          additionalProperties: false,
        },
        replacementAction: {
          type: 'object',
          properties: {
            path: { type: 'string', minLength: 1 },
            then: { type: 'string', minLength: 1 },
          },
          required: ['path', 'then'],
          additionalProperties: false,
        },
        rollback: { type: 'string', minLength: 1 },
      },
      required: [
        'triggers',
        'intervention',
        'replacementAction',
        'rollback',
      ],
      additionalProperties: false,
    },
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

function valueAtPath(value, path) {
  return String(path || '')
    .split('.')
    .filter(Boolean)
    .reduce((current, key) => current?.[key], value);
}

function validateEvidenceBindings(semanticObject, bindings = []) {
  const diagnostics = [];
  for (const binding of bindings) {
    const actual = valueAtPath(semanticObject, binding.path);
    if (Object.hasOwn(binding, 'equals') && actual !== binding.equals) {
      diagnostics.push(`${binding.path} does not equal authenticated evidence`);
    }
    if (
      Object.hasOwn(binding, 'includes') &&
      !String(actual || '').includes(String(binding.includes))
    ) {
      diagnostics.push(`${binding.path} omits authenticated evidence`);
    }
    if (
      Array.isArray(binding.oneOf) &&
      !binding.oneOf.some((expected) => actual === expected)
    ) {
      diagnostics.push(`${binding.path} is outside authenticated evidence`);
    }
  }
  return diagnostics;
}

function validateScope(semanticObject, scope) {
  const diagnostics = [];
  for (const field of ['taskId', 'projectId', 'workspaceId']) {
    if (scope?.[field] && semanticObject?.scope?.[field] !== scope[field]) {
      diagnostics.push(`scope.${field} does not match the authenticated scope`);
    }
  }
  return diagnostics;
}

export function extractAuthoredSemanticDelta(raw) {
  const text = String(raw || '');
  const start = text.indexOf(SEMANTIC_DELTA_MARKERS.start);
  const end = text.indexOf(
    SEMANTIC_DELTA_MARKERS.end,
    start + SEMANTIC_DELTA_MARKERS.start.length
  );
  if (start >= 0 && end > start) {
    return parseAuthoredObject(
      text.slice(start + SEMANTIC_DELTA_MARKERS.start.length, end)
    );
  }
  return parseAuthoredObject(text);
}

export function semanticDeltaTokens(semanticObject, tokenCounter = null) {
  const serialized = canonicalJson(semanticObject);
  return tokenCounter
    ? tokenCounter.count(semanticObject)
    : Math.max(1, Math.ceil(serialized.length / 4));
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
  constructor({
    verifyEvidence,
    persist,
    maximumAuthoringAttempts = 2,
    maximumDeltaTokens = 256,
    tokenCounter = null,
  } = {}) {
    if (typeof verifyEvidence !== 'function' || typeof persist !== 'function')
      throw new Error(
        'SemanticHarvestController requires verifyEvidence and persist functions'
      );
    this.verifyEvidence = verifyEvidence;
    this.persist = persist;
    this.maximumAuthoringAttempts = maximumAuthoringAttempts;
    this.maximumDeltaTokens = maximumDeltaTokens;
    this.tokenCounter = tokenCounter;
  }

  /**
   * Activates a semantic delta authored by the model during the work turn that
   * produced the evidence. The host authenticates the completed work and binds
   * critical fields before persistence, so capture adds no model invocation.
   */
  async commitAuthoredDelta({
    kind,
    raw,
    evidenceReceipts,
    evidenceBindings = [],
    taskId,
    sessionId,
    scope,
  }) {
    const startedAt = performance.now();
    const semanticObject = extractAuthoredSemanticDelta(raw);
    const deltaTokens = semanticDeltaTokens(semanticObject, this.tokenCounter);
    if (deltaTokens > this.maximumDeltaTokens) {
      throw new Error(
        `model semantic delta exceeded ${this.maximumDeltaTokens} tokens (${deltaTokens})`
      );
    }

    const verified = await this.verifyEvidence({ evidenceReceipts });
    if (!verified?.valid || !Array.isArray(verified.receipts)) {
      throw new Error('semantic harvest evidence authentication failed');
    }
    const diagnostics = [
      ...validateScope(semanticObject, scope),
      ...validateEvidenceBindings(semanticObject, evidenceBindings),
    ];
    if (diagnostics.length) {
      throw new Error(
        `model semantic delta contradicted authenticated evidence: ${diagnostics.join('; ')}`
      );
    }

    const persisted = await this.persist({
      operation: 'record',
      kind,
      semanticObject,
      evidenceReceipts,
      taskId,
      sessionId,
    });
    if (!persisted?.accepted) {
      throw new Error(
        (persisted?.diagnostics || ['semantic validation failed']).join('; ')
      );
    }
    const receiptBody = {
      schemaVersion: 'ucr.semantic-harvest-receipt/2',
      modelAuthored: true,
      authoredDuringWorkTurn: true,
      evidenceAuthenticatedBeforeActivation: true,
      additionalModelCalls: 0,
      kind,
      taskId,
      deltaTokens,
      hostLatencyMs: performance.now() - startedAt,
      modelOutputHash: sha256(String(raw)),
      semanticObjectHash: sha256(semanticObject),
      activatedObjectId: persisted.object?.id || null,
      eventIds: persisted.eventIds || [],
    };
    return {
      semanticObject,
      persisted,
      receipt: { ...receiptBody, receiptHash: sha256(receiptBody) },
    };
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
          authoredDuringWorkTurn: false,
          evidenceAuthenticatedBeforeActivation: true,
          additionalModelCalls: attempt,
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
