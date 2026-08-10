import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
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
      items: {
        type: 'string',
        pattern: '^[A-Za-z0-9_.-]+(?:[\\\\/][A-Za-z0-9_.-]+)*$',
      },
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

function lastFinite(objects, names) {
  let match = null;
  for (const object of objects)
    visit(object, (value) => {
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
      if (
        value?.structured_output &&
        typeof value.structured_output === 'object'
      )
        candidates.push(JSON.stringify(value.structured_output));
      if (value?.structuredOutput && typeof value.structuredOutput === 'object')
        candidates.push(JSON.stringify(value.structuredOutput));
      if (typeof value?.response === 'string') candidates.push(value.response);
      if (typeof value?.result === 'string') candidates.push(value.result);
      if (
        value?.type === 'item.completed' &&
        value?.item?.type === 'agent_message'
      )
        candidates.push(value.item.text);
    });
  return candidates.filter(Boolean).at(-1) || null;
}

export function parseStructuredModelJson(text) {
  if (text && typeof text === 'object')
    return Array.isArray(text) ? null : text;
  const source = String(text || '').trim();
  const candidates = [
    source,
    source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed;
    } catch {
      // Try the next bounded representation.
    }
  }
  return null;
}

/** Normalize provider-native CLI JSON/JSONL without retaining raw content. */
export function parseLiveCliTelemetry(client, stdout) {
  const objects = jsonValues(stdout);
  const inputTokens = lastFinite(objects, [
    'input_tokens',
    'inputTokens',
    'promptTokenCount',
  ]);
  const cachedInputTokens = lastFinite(objects, [
    'cache_read_input_tokens',
    'cached_input_tokens',
    'cachedInputTokens',
    'cachedContentTokenCount',
  ]);
  const cacheCreationInputTokens = lastFinite(objects, [
    'cache_creation_input_tokens',
    'cacheCreationInputTokens',
  ]);
  const outputTokens = lastFinite(objects, [
    'output_tokens',
    'outputTokens',
    'candidatesTokenCount',
  ]);
  const reportedTotal = lastFinite(objects, [
    'total_tokens',
    'totalTokens',
    'totalTokenCount',
  ]);
  const totalTokens =
    reportedTotal ??
    (inputTokens !== null && outputTokens !== null
      ? inputTokens + outputTokens
      : null);
  // Claude reports newly read and newly created cache tokens outside
  // input_tokens. Codex and Gemini include their cached subset in the prompt
  // total, so adding it there would double-count reconstruction context.
  const effectiveInputTokens =
    client === 'claude-code' && inputTokens !== null
      ? inputTokens + (cachedInputTokens || 0) + (cacheCreationInputTokens || 0)
      : inputTokens;
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
      cacheCreationInputTokens,
      effectiveInputTokens,
      outputTokens,
      totalTokens,
      costUsd: lastFinite(objects, ['total_cost_usd', 'cost_usd', 'costUsd']),
    },
    actionAudit: [
      ...new Map(toolEvents.map((item) => [item.eventHash, item])).values(),
    ],
    outputHash: sha256(String(stdout || '')),
  };
}

function evidencePathCandidates(value) {
  return (
    String(value || '').match(
      /[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+/g
    ) || []
  );
}

/** Ground model-authored capture in path-confined immutable fixture bytes. */
export function verifyStudySemanticEvidence(semanticDelta, workspace) {
  const diagnostics = [];
  const anchors = [];
  const root = realpathSync(workspace);
  const declared = Array.isArray(semanticDelta?.evidenceRefs)
    ? [...new Set(semanticDelta.evidenceRefs.map(String))]
    : [];
  const verifiedDeclared = new Set();
  const candidates = [
    ...declared,
    ...evidencePathCandidates(semanticDelta?.verificationEvidence),
  ];
  for (const candidate of [...new Set(candidates)]) {
    const path = String(candidate).replace(/[.,;:)\]}]+$/g, '');
    if (!path || isAbsolute(path)) {
      diagnostics.push(`rejected non-relative evidence path: ${path}`);
      continue;
    }
    const target = resolve(root, path);
    const relation = relative(root, target);
    if (
      relation === '..' ||
      relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    ) {
      diagnostics.push(`rejected escaping evidence path: ${path}`);
      continue;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      diagnostics.push(`evidence path does not exist: ${path}`);
      continue;
    }
    const realTarget = realpathSync(target);
    const realRelation = relative(root, realTarget);
    if (
      realRelation === '..' ||
      realRelation.startsWith(
        `..${process.platform === 'win32' ? '\\' : '/'}`
      )
    ) {
      diagnostics.push(`evidence symlink escapes workspace: ${path}`);
      continue;
    }
    const bytes = statSync(realTarget).size;
    if (bytes > 1024 * 1024) {
      diagnostics.push(`evidence file exceeds 1 MiB: ${path}`);
      continue;
    }
    anchors.push({
      path: relative(root, realTarget).replaceAll('\\', '/'),
      bytes,
      sha256: sha256(readFileSync(realTarget)),
    });
    if (declared.includes(candidate)) verifiedDeclared.add(candidate);
  }
  const uniqueAnchors = [
    ...new Map(anchors.map((anchor) => [anchor.path, anchor])).values(),
  ];
  if (!uniqueAnchors.length)
    diagnostics.push('capture has no verifiable repository evidence anchor');
  if (!declared.length)
    diagnostics.push('capture declares no repository evidence refs');
  for (const path of declared)
    if (!verifiedDeclared.has(path))
      diagnostics.push(`declared evidence ref was not verified: ${path}`);
  const verified =
    uniqueAnchors.length > 0 &&
    declared.length > 0 &&
    verifiedDeclared.size === declared.length;
  return {
    schemaVersion: 'ucr.semantic-evidence-verification/1',
    verified,
    anchors: uniqueAnchors,
    diagnostics,
    verificationHash: sha256({ anchors: uniqueAnchors, diagnostics }),
  };
}

export function studyArmDecision(
  arm,
  armContext,
  semanticDelta,
  verification = null
) {
  const applicable = ['runtime', 'oracle'].includes(arm);
  const eligible =
    arm === 'oracle' || (arm === 'runtime' && verification?.verified === true);
  const selected = applicable && eligible;
  const delivered = selected;
  const payload =
    arm === 'runtime'
      ? verification?.verified
        ? [
            `Verified predecessor evidence: ${verification.anchors
              .slice(0, 2)
              .map((anchor) => `${anchor.path}#${anchor.sha256.slice(0, 16)}`)
              .join(', ')}.`,
            'Inspect those exact files before acting; predecessor conclusions are not authoritative.',
            semanticDelta?.applicability?.[0]
              ? `Applicability hint: ${semanticDelta.applicability[0]}.`
              : null,
          ]
            .filter(Boolean)
            .join(' ')
        : null
      : arm === 'oracle'
        ? armContext || null
        : null;
  return {
    applicable,
    eligible,
    selected,
    delivered: delivered && Boolean(payload),
    payload,
    stale: arm === 'stale',
    contradictory: arm === 'contradictory',
    harmful: arm === 'harmful',
  };
}
