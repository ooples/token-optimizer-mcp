import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson, sha256 } from './protocol.mjs';

export const CHECKPOINT_BOUNDARIES = Object.freeze([
  'plan-approved',
  'edit-batch',
  'validation',
  'delegation',
  'compaction',
  'handoff',
  'session-end',
]);

const required = [
  'checkpointId',
  'goalDag',
  'plan',
  'workspace',
  'attemptedActions',
  'knownFailures',
  'validations',
  'invariants',
  'permissions',
  'ownership',
  'nextSafeAction',
];

export function validateCheckpoint(checkpoint) {
  const diagnostics = [];
  for (const field of required) {
    if (checkpoint?.[field] === undefined || checkpoint?.[field] === null)
      diagnostics.push(`${field} is required`);
  }
  if (!Array.isArray(checkpoint?.goalDag?.nodes))
    diagnostics.push('goalDag.nodes must be an array');
  if (!Array.isArray(checkpoint?.goalDag?.edges))
    diagnostics.push('goalDag.edges must be an array');
  if (!Array.isArray(checkpoint?.plan))
    diagnostics.push('plan must be an array');
  if (!checkpoint?.workspace?.head || !checkpoint?.workspace?.artifactHashes) {
    diagnostics.push('workspace head and artifactHashes are required');
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

export function createCheckpoint(
  input,
  { boundary, producer, now = Date.now() } = {}
) {
  if (!CHECKPOINT_BOUNDARIES.includes(boundary))
    throw new Error(`unknown checkpoint boundary ${boundary}`);
  const body = {
    schemaVersion: 'ucr.checkpoint/1',
    ...input,
    checkpointId:
      input.checkpointId ||
      `checkpoint:${sha256({ producer, now, input }).slice(0, 24)}`,
    producer,
    boundary,
    createdAt: now,
  };
  const validation = validateCheckpoint(body);
  if (!validation.valid)
    throw new Error(`invalid checkpoint: ${validation.diagnostics.join('; ')}`);
  return { ...body, checkpointHash: sha256(body) };
}

export function checkpointCompatibility(checkpoint, current) {
  const mismatches = [];
  const compare = (field, expected, actual, severity = 'stale') => {
    if (expected !== undefined && expected !== actual)
      mismatches.push({ field, expected, actual, severity });
  };
  compare(
    'workspace.head',
    checkpoint.workspace.head,
    current.workspace?.head,
    'refresh-required'
  );
  compare(
    'workspace.dirtyHash',
    checkpoint.workspace.dirtyHash,
    current.workspace?.dirtyHash,
    'refresh-required'
  );
  compare(
    'dependenciesHash',
    checkpoint.dependenciesHash,
    current.dependenciesHash,
    'refresh-required'
  );
  compare(
    'environmentHash',
    checkpoint.environmentHash,
    current.environmentHash,
    'review-required'
  );
  compare('policyHash', checkpoint.policyHash, current.policyHash, 'blocked');
  compare(
    'activeBeliefsHash',
    checkpoint.activeBeliefsHash,
    current.activeBeliefsHash,
    'refresh-required'
  );
  const changedArtifacts = Object.entries(
    checkpoint.workspace.artifactHashes || {}
  )
    .filter(
      ([path, hash]) => current.workspace?.artifactHashes?.[path] !== hash
    )
    .map(([path]) => path);
  if (changedArtifacts.length)
    mismatches.push({
      field: 'workspace.artifactHashes',
      paths: changedArtifacts,
      severity: 'refresh-required',
    });
  return {
    compatible: mismatches.length === 0,
    blocked: mismatches.some((item) => item.severity === 'blocked'),
    stale: mismatches.length > 0,
    mismatches,
  };
}

export function restoreCheckpoint(checkpoint, current, { consumer } = {}) {
  const validation = validateCheckpoint(checkpoint);
  if (!validation.valid)
    return { restored: false, diagnostics: validation.diagnostics };
  const compatibility = checkpointCompatibility(checkpoint, current);
  const rejected = compatibility.mismatches.map((item) => item.field);
  const restored = required.filter(
    (field) =>
      !rejected.some(
        (candidate) => candidate === field || candidate.startsWith(`${field}.`)
      )
  );
  const receipt = {
    schemaVersion: 'ucr.takeover-receipt/1',
    checkpointId: checkpoint.checkpointId,
    consumer,
    compatibility,
    restored,
    rejected,
    refreshed: [],
    actedOn: null,
    nextSafeAction: compatibility.blocked ? null : checkpoint.nextSafeAction,
    createdAt: Date.now(),
  };
  return {
    restored: !compatibility.blocked,
    requiresRefresh: compatibility.stale,
    checkpoint,
    receipt: { ...receipt, receiptHash: sha256(receipt) },
  };
}

export function recordTakeoverAction(receipt, action, { refreshed = [] } = {}) {
  if (!receipt.nextSafeAction && action)
    throw new Error('stale blocked checkpoint cannot authorize an action');
  const next = { ...receipt, refreshed, actedOn: action, actedAt: Date.now() };
  return { ...next, receiptHash: sha256(next) };
}

export class CheckpointStore {
  constructor(root) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  path(checkpointId) {
    return join(this.root, `${sha256(checkpointId)}.json`);
  }

  write(checkpoint) {
    const validation = validateCheckpoint(checkpoint);
    if (!validation.valid) throw new Error(validation.diagnostics.join('; '));
    const path = this.path(checkpoint.checkpointId);
    const temporary = `${path}.partial`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, `${canonicalJson(checkpoint)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    return { path, hash: sha256(checkpoint) };
  }

  read(checkpointId) {
    const path = this.path(checkpointId);
    if (!existsSync(path)) return null;
    const checkpoint = JSON.parse(readFileSync(path, 'utf8'));
    return validateCheckpoint(checkpoint).valid ? checkpoint : null;
  }

  recover() {
    // Atomic rename means a partial is never considered a checkpoint. The
    // caller may safely delete or inspect partial files without losing the
    // last committed checkpoint.
    return {
      committedOnly: true,
      strategy: 'ignore .partial files and replay event log',
    };
  }
}
