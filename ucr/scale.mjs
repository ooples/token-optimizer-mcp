import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { canonicalJson, sha256, validateEvent } from './protocol.mjs';

export class StreamingGraphProjection {
  constructor({ validate = true } = {}) {
    this.validate = validate;
    this.acceptedEvents = 0;
    this.duplicates = 0;
    this.diagnostics = [];
    this.idempotencyKeys = new Set();
    this.writerSequences = new Map();
    this.objects = new Map();
    this.relations = new Map();
    this.eventDigest = createHash('sha256');
  }

  apply(event) {
    if (this.validate) {
      const validation = validateEvent(event);
      if (!validation.valid) {
        this.diagnostics.push({
          eventId: event?.eventId || null,
          errors: validation.diagnostics,
        });
        return false;
      }
    }
    if (this.idempotencyKeys.has(event.idempotencyKey)) {
      this.duplicates += 1;
      return false;
    }
    const priorSequence = this.writerSequences.get(event.writer.id);
    if (
      priorSequence !== undefined &&
      event.writer.sequence !== priorSequence + 1
    ) {
      this.diagnostics.push({
        eventId: event.eventId,
        errors: [
          `writer sequence gap: expected ${priorSequence + 1}, received ${event.writer.sequence}`,
        ],
      });
      return false;
    }
    this.idempotencyKeys.add(event.idempotencyKey);
    this.writerSequences.set(event.writer.id, event.writer.sequence);
    this.acceptedEvents += 1;
    this.eventDigest.update(canonicalJson(event));
    const object = event.payload?.object;
    if (object?.id) this.objects.set(object.id, { ...object, eventId: event.eventId });
    for (const [index, relation] of (event.payload?.relations || []).entries()) {
      const id = relation.id || sha256({ eventId: event.eventId, index, relation });
      this.relations.set(id, { ...relation, id });
    }
    return true;
  }

  finish() {
    const endpoints = new Set(this.objects.keys());
    const orphaned = [...this.relations.values()].filter(
      (relation) => !endpoints.has(relation.from) || !endpoints.has(relation.to)
    );
    return {
      acceptedEvents: this.acceptedEvents,
      duplicates: this.duplicates,
      writers: this.writerSequences.size,
      objects: this.objects.size,
      relations: this.relations.size,
      orphaned: orphaned.length,
      diagnostics: this.diagnostics,
      streamHash: this.eventDigest.digest('hex'),
      projectionHash: sha256({
        objects: [...this.objects.values()].sort((a, b) =>
          String(a.id).localeCompare(String(b.id))
        ),
        relations: [...this.relations.values()].sort((a, b) =>
          String(a.id).localeCompare(String(b.id))
        ),
        acceptedEvents: this.acceptedEvents,
      }),
    };
  }
}

export function syntheticScaleEvent(index, { objectCount = 4096 } = {}) {
  const wallMs = 1_710_000_000_000 + index;
  const objectId = `entity:${index % objectCount}`;
  const payload = {
    object: {
      id: objectId,
      type: 'entity',
      state: 'active',
      title: `synthetic entity ${index % objectCount}`,
      revision: Math.floor(index / objectCount),
    },
  };
  return {
    schemaVersion: 'ucr.event/1',
    protocolVersion: '1.0.0',
    eventId: `scale-event-${String(index).padStart(12, '0')}`,
    type: 'observation.recorded',
    traceId: 'scale-million-event-run',
    causalParents: [],
    writer: { id: 'scale-writer', sequence: index },
    time: {
      hlc: `${String(wallMs).padStart(13, '0')}:00000000:scale-writer`,
      wallMs,
    },
    idempotencyKey: `scale-${index}`,
    actor: {
      agentId: 'scale-agent',
      client: 'benchmark',
      clientVersion: '1',
      model: null,
      modelVersion: null,
      capabilityTier: 'transactional',
    },
    scope: {
      taskId: 'scale-task',
      sessionId: 'scale-session',
      projectId: 'scale-project',
      workspaceId: 'scale-workspace',
      branch: null,
    },
    sensitivity: 'internal',
    requiredSemantics: false,
    payloadHash: sha256(payload),
    payloadRef: null,
    payload,
    resources: {},
    artifactRefs: [],
  };
}

export function benchmarkGraphProjection({
  eventCount = 1_000_000,
  objectCount = 4096,
  maximumMs = 120_000,
  maximumRssBytes = 768 * 1024 * 1024,
} = {}) {
  if (!Number.isSafeInteger(eventCount) || eventCount < 1)
    throw new Error('eventCount must be a positive integer');
  const beforeRss = process.memoryUsage().rss;
  const started = performance.now();
  const projector = new StreamingGraphProjection();
  for (let index = 0; index < eventCount; index++) {
    projector.apply(syntheticScaleEvent(index, { objectCount }));
  }
  const projection = projector.finish();
  const elapsedMs = performance.now() - started;
  const afterRss = process.memoryUsage().rss;
  const rssDeltaBytes = Math.max(0, afterRss - beforeRss);
  return {
    schemaVersion: 'ucr.graph-scale/1',
    eventCount,
    objectCount,
    maximumMs,
    maximumRssBytes,
    elapsedMs,
    eventsPerSecond: eventCount / (elapsedMs / 1000),
    rssDeltaBytes,
    projection,
    passed:
      projection.acceptedEvents === eventCount &&
      projection.orphaned === 0 &&
      projection.diagnostics.length === 0 &&
      elapsedMs <= maximumMs &&
      rssDeltaBytes <= maximumRssBytes,
  };
}
