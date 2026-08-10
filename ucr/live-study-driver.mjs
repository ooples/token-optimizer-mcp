import { sha256 } from './protocol.mjs';

export const LIVE_STUDY_SEMANTIC_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'type',
    'trigger',
    'attemptedAction',
    'observedFailure',
    'rootCause',
    'correction',
    'verificationEvidence',
    'expectedOutcome',
    'applicability',
    'nonApplicability',
    'invalidators',
    'confidence',
    'evidenceRefs',
  ],
  properties: {
    type: { type: 'string', enum: ['failure'] },
    trigger: { type: 'string', minLength: 1 },
    attemptedAction: { type: 'string', minLength: 1 },
    observedFailure: { type: 'string', minLength: 1 },
    rootCause: { type: 'string', minLength: 1 },
    correction: { type: 'string', minLength: 1 },
    verificationEvidence: { type: 'string', minLength: 1 },
    expectedOutcome: { type: 'string', minLength: 1 },
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
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidenceRefs: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
  },
});

function jsonValues(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const values = [];
  for (const line of lines) {
    try {
      values.push(JSON.parse(line));
    } catch {
      // A CLI may mix status text with JSONL.
    }
  }
  if (!values.length) {
    try {
      values.push(JSON.parse(String(text || '')));
    } catch {
      // The caller will retain the missing structured-output diagnostic.
    }
  }
  return values;
}

function visit(value, callback) {
  if (!value || typeof value !== 'object') return;
  callback(value);
  for (const item of Object.values(value)) visit(item, callback);
}

function firstFinite(objects, names) {
  let match = null;
  for (const object of objects)
    visit(object, (value) => {
      if (match !== null) return;
      for (const name of names)
        if (Number.isFinite(value?.[name])) {
          match = Number(value[name]);
          return;
        }
    });
  return match;
}

function firstString(objects, names) {
  let match = null;
  for (const object of objects)
    visit(object, (value) => {
      if (match !== null) return;
      for (const name of names)
        if (typeof value?.[name] === 'string' && value[name].trim()) {
          match = value[name].trim();
          return;
        }
    });
  return match;
}

function candidateText(objects) {
  const candidates = [];
  for (const object of objects)
    visit(object, (value) => {
      if (typeof value?.structured_output === 'object')
        candidates.push(JSON.stringify(value.structured_output));
      if (typeof value?.structuredOutput === 'object')
        candidates.push(JSON.stringify(value.structuredOutput));
      if (typeof value?.response === 'string') candidates.push(value.response);
      if (typeof value?.result === 'string') candidates.push(value.result);
      if (
        value?.type === 'item.completed' &&
        value?.item?.type === 'agent_message'
      )
        candidates.push(value.item.text);
      if (value?.type === 'result' && typeof value?.result === 'string')
        candidates.push(value.result);
    });
  return candidates.filter(Boolean).at(-1) || null;
}

export function parseStructuredModelJson(text) {
  if (text && typeof text === 'object') return text;
  const source = String(text || '').trim();
  const candidates = [
    source,
    source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''),
  ];
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(source.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next bounded representation.
    }
  }
  return null;
}

/** Normalize provider-native CLI JSON/JSONL without retaining raw content. */
export function parseLiveCliTelemetry(client, stdout) {
  const objects = jsonValues(stdout);
  const inputTokens = firstFinite(objects, [
    'input_tokens',
    'inputTokens',
    'promptTokenCount',
  ]);
  const cachedInputTokens = firstFinite(objects, [
    'cache_read_input_tokens',
    'cached_input_tokens',
    'cachedInputTokens',
    'cachedContentTokenCount',
  ]);
  const outputTokens = firstFinite(objects, [
    'output_tokens',
    'outputTokens',
    'candidatesTokenCount',
  ]);
  const reportedTotal = firstFinite(objects, [
    'total_tokens',
    'totalTokens',
    'totalTokenCount',
  ]);
  const totalTokens =
    reportedTotal ??
    (inputTokens !== null && outputTokens !== null
      ? inputTokens + outputTokens
      : null);
  const toolEvents = [];
  for (const object of objects)
    visit(object, (value) => {
      const type = String(value?.type || '');
      if (
        /tool|command|file_change|write|edit/i.test(type) &&
        !/result$/i.test(type)
      )
        toolEvents.push({ type, eventHash: sha256(value) });
    });
  const providerRequestId = firstString(objects, [
    'request_id',
    'requestId',
    'session_id',
    'sessionId',
    'thread_id',
    'threadId',
  ]);
  return {
    client,
    finalText: candidateText(objects),
    structuredOutput: parseStructuredModelJson(candidateText(objects)),
    providerRequestId,
    model: firstString(objects, ['model', 'model_id', 'modelId']),
    usage: {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens,
      costUsd: firstFinite(objects, ['total_cost_usd', 'cost_usd', 'costUsd']),
    },
    actionAudit: [
      ...new Map(toolEvents.map((item) => [item.eventHash, item])).values(),
    ],
    outputHash: sha256(String(stdout || '')),
  };
}

export function studyArmDecision(arm, armContext, semanticDelta) {
  const applicable = ['runtime', 'oracle'].includes(arm);
  const selected = applicable;
  const delivered = applicable;
  const payload =
    arm === 'runtime'
      ? semanticDelta
        ? `Verified active-model cognition: ${semanticDelta.correction}. Evidence: ${semanticDelta.verificationEvidence}.`
        : null
      : arm === 'oracle'
        ? armContext || null
        : null;
  return {
    applicable,
    eligible: applicable,
    selected,
    delivered: delivered && Boolean(payload),
    payload,
    stale: arm === 'stale',
    contradictory: arm === 'contradictory',
    harmful: arm === 'harmful',
  };
}
