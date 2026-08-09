import { createHash, randomBytes } from 'node:crypto';

export const UCR_PROTOCOL_VERSION = '1.0.0';
export const UCR_EVENT_SCHEMA = 'ucr.event/1';

export const EVENT_TYPES = Object.freeze([
  'task.created',
  'task.updated',
  'task.completed',
  'goal.created',
  'goal.updated',
  'goal.completed',
  'hypothesis.proposed',
  'hypothesis.tested',
  'hypothesis.resolved',
  'action.proposed',
  'action.accepted',
  'action.rejected',
  'tool.called',
  'tool.result',
  'observation.recorded',
  'mistake.attempted',
  'mistake.executed',
  'correction.applied',
  'verification.requested',
  'verification.passed',
  'verification.failed',
  'decision.recorded',
  'finding.proposed',
  'finding.verified',
  'finding.activated',
  'checkpoint.created',
  'checkpoint.restored',
  'handoff.requested',
  'handoff.received',
  'feedback.recorded',
  'outcome.recorded',
  'guard.evaluated',
  'guard.intervened',
  'context.candidate',
  'context.delivered',
  'context.expanded',
  'coordination.claimed',
  'coordination.renewed',
  'coordination.released',
  'coordination.conflict',
  'memory.quarantined',
  'memory.revalidated',
]);

export const SENSITIVITY_LABELS = Object.freeze([
  'public',
  'internal',
  'confidential',
  'restricted',
]);

export const CAPABILITY_TIERS = Object.freeze([
  'connected',
  'observed',
  'interceptable',
  'continuable',
  'transactional',
]);

const eventTypes = new Set(EVENT_TYPES);
const sensitivities = new Set(SENSITIVITY_LABELS);
const capabilityTiers = new Set(CAPABILITY_TIERS);

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  const input = Buffer.isBuffer(value)
    ? value
    : Buffer.from(
        typeof value === 'string' ? value : canonicalJson(value),
        'utf8'
      );
  return createHash('sha256').update(input).digest('hex');
}

/** UUIDv7 with a sortable 48-bit millisecond prefix. */
export function uuidv7(now = Date.now(), entropy = randomBytes(10)) {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error('uuidv7 time must be a positive integer');
  if (!Buffer.isBuffer(entropy) || entropy.length < 10) {
    throw new Error('uuidv7 entropy must contain at least 10 bytes');
  }
  const bytes = Buffer.alloc(16);
  let time = BigInt(now);
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  entropy.copy(bytes, 6, 0, 10);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}` +
    `-${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

export class HybridLogicalClock {
  constructor(nodeId, { wallMs = 0, counter = 0 } = {}) {
    if (!nodeId) throw new Error('hybrid logical clock requires nodeId');
    this.nodeId = String(nodeId);
    this.wallMs = Number(wallMs) || 0;
    this.counter = Number(counter) || 0;
  }

  tick(now = Date.now()) {
    const nextWall = Math.max(Number(now), this.wallMs);
    this.counter = nextWall === this.wallMs ? this.counter + 1 : 0;
    this.wallMs = nextWall;
    return this.value();
  }

  observe(remote, now = Date.now()) {
    const parsed = parseHlc(remote);
    const nextWall = Math.max(Number(now), this.wallMs, parsed.wallMs);
    if (nextWall === this.wallMs && nextWall === parsed.wallMs) {
      this.counter = Math.max(this.counter, parsed.counter) + 1;
    } else if (nextWall === this.wallMs) {
      this.counter += 1;
    } else if (nextWall === parsed.wallMs) {
      this.counter = parsed.counter + 1;
    } else {
      this.counter = 0;
    }
    this.wallMs = nextWall;
    return this.value();
  }

  value() {
    return `${String(this.wallMs).padStart(13, '0')}:${String(this.counter).padStart(8, '0')}:${this.nodeId}`;
  }
}

export function parseHlc(value) {
  const match = /^(\d{13}):(\d{8}):(.+)$/.exec(String(value || ''));
  if (!match) throw new Error(`invalid hybrid logical time: ${String(value)}`);
  return {
    wallMs: Number(match[1]),
    counter: Number(match[2]),
    nodeId: match[3],
  };
}

export function compareHlc(left, right) {
  const a = parseHlc(left);
  const b = parseHlc(right);
  return (
    a.wallMs - b.wallMs ||
    a.counter - b.counter ||
    a.nodeId.localeCompare(b.nodeId)
  );
}

function requiredString(value, field, diagnostics) {
  if (typeof value !== 'string' || !value.trim())
    diagnostics.push(`${field} must be a non-empty string`);
}

export function validateEvent(event, { acceptUnknownTypes = true } = {}) {
  const diagnostics = [];
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { valid: false, diagnostics: ['event must be an object'] };
  }
  requiredString(event.schemaVersion, 'schemaVersion', diagnostics);
  if (event.schemaVersion !== UCR_EVENT_SCHEMA) {
    diagnostics.push(
      `unsupported schemaVersion ${JSON.stringify(event.schemaVersion)}`
    );
  }
  requiredString(event.eventId, 'eventId', diagnostics);
  requiredString(event.type, 'type', diagnostics);
  requiredString(event.traceId, 'traceId', diagnostics);
  requiredString(event.idempotencyKey, 'idempotencyKey', diagnostics);
  requiredString(event.payloadHash, 'payloadHash', diagnostics);
  requiredString(event.time?.hlc, 'time.hlc', diagnostics);
  if (!Number.isFinite(event.time?.wallMs))
    diagnostics.push('time.wallMs must be numeric');
  requiredString(event.writer?.id, 'writer.id', diagnostics);
  if (
    !Number.isSafeInteger(event.writer?.sequence) ||
    event.writer.sequence < 0
  ) {
    diagnostics.push('writer.sequence must be a non-negative integer');
  }
  requiredString(event.actor?.agentId, 'actor.agentId', diagnostics);
  requiredString(event.actor?.client, 'actor.client', diagnostics);
  if (!capabilityTiers.has(event.actor?.capabilityTier)) {
    diagnostics.push(
      `actor.capabilityTier must be one of ${CAPABILITY_TIERS.join(', ')}`
    );
  }
  requiredString(event.scope?.sessionId, 'scope.sessionId', diagnostics);
  requiredString(event.scope?.projectId, 'scope.projectId', diagnostics);
  requiredString(event.scope?.workspaceId, 'scope.workspaceId', diagnostics);
  if (!sensitivities.has(event.sensitivity)) {
    diagnostics.push(
      `sensitivity must be one of ${SENSITIVITY_LABELS.join(', ')}`
    );
  }
  if (!Array.isArray(event.causalParents))
    diagnostics.push('causalParents must be an array');
  if (!eventTypes.has(event.type)) {
    if (event.requiredSemantics === true || !acceptUnknownTypes) {
      diagnostics.push(
        `unknown required event type ${JSON.stringify(event.type)}`
      );
    }
  }
  try {
    parseHlc(event.time?.hlc);
  } catch (error) {
    diagnostics.push(error.message);
  }
  if (
    event.payload !== undefined &&
    sha256(event.payload) !== event.payloadHash
  ) {
    diagnostics.push('payloadHash does not match inline payload');
  }
  return {
    valid: diagnostics.length === 0,
    diagnostics,
    unknownType: !eventTypes.has(event.type),
  };
}

export function createEvent({
  type,
  payload = {},
  payloadRef = null,
  traceId = uuidv7(),
  causalParents = [],
  writer,
  actor,
  scope,
  clock,
  wallMs = Date.now(),
  idempotencyKey,
  sensitivity = 'internal',
  requiredSemantics = false,
  extensions = {},
} = {}) {
  if (!(clock instanceof HybridLogicalClock)) {
    throw new Error('createEvent requires a HybridLogicalClock');
  }
  const event = {
    ...extensions,
    schemaVersion: UCR_EVENT_SCHEMA,
    protocolVersion: UCR_PROTOCOL_VERSION,
    eventId: uuidv7(wallMs),
    type,
    traceId,
    causalParents: [...new Set(causalParents)].sort(),
    writer: { id: writer?.id, sequence: writer?.sequence },
    time: { hlc: clock.tick(wallMs), wallMs },
    idempotencyKey:
      idempotencyKey ||
      sha256({
        type,
        traceId,
        writerId: writer?.id,
        sequence: writer?.sequence,
        payload,
      }),
    actor: {
      agentId: actor?.agentId,
      client: actor?.client,
      clientVersion: actor?.clientVersion ?? null,
      model: actor?.model ?? null,
      modelVersion: actor?.modelVersion ?? null,
      capabilityTier: actor?.capabilityTier,
    },
    scope: {
      taskId: scope?.taskId ?? null,
      sessionId: scope?.sessionId,
      projectId: scope?.projectId,
      workspaceId: scope?.workspaceId,
      branch: scope?.branch ?? null,
    },
    sensitivity,
    requiredSemantics: Boolean(requiredSemantics),
    payloadHash: sha256(payload),
    payloadRef,
    payload,
  };
  const validation = validateEvent(event);
  if (!validation.valid)
    throw new Error(`invalid UCR event: ${validation.diagnostics.join('; ')}`);
  return event;
}

export function negotiateProtocol(localVersions, remoteVersions) {
  const local = new Set(localVersions);
  const shared = remoteVersions
    .filter((version) => local.has(version))
    .sort()
    .reverse();
  return shared[0] || null;
}

export function canonicalEvent(event) {
  const validation = validateEvent(event);
  if (!validation.valid) throw new Error(validation.diagnostics.join('; '));
  return canonicalize(event);
}
