import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, canonicalize, sha256 } from './protocol.mjs';
import { canonicalReplay } from './event-store.mjs';

export const COGNITION_OBJECT_TYPES = Object.freeze([
  'event',
  'artifact',
  'entity',
  'episode',
  'claim',
  'decision',
  'failure',
  'procedure',
  'guard',
  'goal',
  'hypothesis',
  'constraint',
  'checkpoint',
  'outcome',
  // Compatibility objects from the existing wiki projection.
  'file',
  'symbol',
  'task',
  'finding',
]);

export const COGNITION_RELATION_TYPES = Object.freeze([
  'derived_from',
  'verified_by',
  'applies_to',
  'invalidated_by',
  'requires',
  'blocks',
  'causes',
  'claimed_causes',
  'used_in',
  'supersedes',
  'contradicts',
  'owns',
  'generalized_from',
]);

const objectTypes = new Set(COGNITION_OBJECT_TYPES);
const relationTypes = new Set(COGNITION_RELATION_TYPES);

function normalizedInterval(value, fallback) {
  if (!value) return { from: fallback, to: null };
  return {
    from: Number.isFinite(value.from) ? value.from : fallback,
    to: Number.isFinite(value.to) ? value.to : null,
  };
}

function cognitionScope(eventScope, requested) {
  const supplied =
    requested && typeof requested === 'object' && !Array.isArray(requested)
      ? requested
      : {};
  const namedLevel =
    typeof requested === 'string' &&
    [
      'session',
      'workspace',
      'branch',
      'repository',
      'project',
      'user',
      'organization',
      'global',
    ].includes(requested)
      ? requested
      : null;
  const level = supplied.level || namedLevel || 'task';
  const scope = { ...eventScope, ...supplied, level };
  if (level !== 'task') scope.taskId = null;
  if (!['task', 'session'].includes(level)) scope.sessionId = null;
  if (!['task', 'session', 'workspace'].includes(level))
    scope.workspaceId = null;
  if (!['task', 'session', 'workspace', 'branch'].includes(level))
    scope.branch = null;
  return scope;
}

function objectFromEvent(event) {
  const input = event.payload?.object;
  if (!input) return null;
  if (!objectTypes.has(input.type))
    throw new Error(`unknown cognition object type ${input.type}`);
  if (!input.id) throw new Error('cognition object requires id');
  return {
    ...canonicalize(input),
    id: String(input.id),
    type: input.type,
    state: input.state || 'active',
    confidence: input.confidence ?? null,
    validTime: normalizedInterval(input.validTime, event.time.wallMs),
    transactionTime: { from: event.time.wallMs, to: null },
    learnedAt: event.time.wallMs,
    eventId: event.eventId,
    provenance: [
      ...new Set([...(input.provenance || []), event.eventId]),
    ].sort(),
    scope: cognitionScope(event.scope, input.scope),
  };
}

function relationsFromEvent(event) {
  return (event.payload?.relations || []).map((relation, index) => {
    if (!relationTypes.has(relation.type)) {
      throw new Error(`unknown cognition relation type ${relation.type}`);
    }
    if (!relation.from || !relation.to)
      throw new Error('relation requires from and to');
    return {
      ...canonicalize(relation),
      id: relation.id || sha256({ eventId: event.eventId, index, relation }),
      from: String(relation.from),
      to: String(relation.to),
      type: relation.type,
      eventId: event.eventId,
      at: event.time.wallMs,
    };
  });
}

export class CognitionGraph {
  constructor() {
    this.objects = new Map();
    this.history = new Map();
    this.relations = new Map();
    this.events = new Map();
    this.diagnostics = [];
  }

  apply(event) {
    if (this.events.has(event.eventId)) return false;
    this.events.set(event.eventId, event);
    const object = objectFromEvent(event);
    if (object) {
      const prior = this.objects.get(object.id);
      if (prior) {
        prior.transactionTime = {
          ...prior.transactionTime,
          to: event.time.wallMs,
        };
        if (!this.history.has(object.id)) this.history.set(object.id, []);
        this.history.get(object.id).push(prior);
      }
      this.objects.set(object.id, object);
    }
    for (const relation of relationsFromEvent(event)) {
      this.relations.set(relation.id, relation);
      if (['supersedes', 'invalidated_by'].includes(relation.type)) {
        const prior = this.objects.get(relation.to);
        if (prior) {
          const next = {
            ...prior,
            state: relation.type === 'supersedes' ? 'superseded' : 'stale',
            validTime: { ...prior.validTime, to: event.time.wallMs },
            supersededBy:
              relation.type === 'supersedes'
                ? relation.from
                : prior.supersededBy,
            invalidatedBy:
              relation.type === 'invalidated_by'
                ? relation.from
                : prior.invalidatedBy,
          };
          this.objects.set(prior.id, next);
        }
        if (relation.type === 'supersedes') {
          const replacement = this.objects.get(relation.from);
          if (replacement)
            this.objects.set(replacement.id, {
              ...replacement,
              contradicted: false,
            });
        }
      }
      if (relation.type === 'contradicts') {
        for (const id of [relation.from, relation.to]) {
          const item = this.objects.get(id);
          if (item) this.objects.set(id, { ...item, contradicted: true });
        }
      }
    }
    return true;
  }

  applyAll(events) {
    const replay = canonicalReplay(events);
    this.diagnostics.push(...replay.diagnostics);
    replay.events.forEach((event) => this.apply(event));
    return this;
  }

  object(id, { at = null, learnedAt = null } = {}) {
    const versions = [
      ...(this.history.get(id) || []),
      this.objects.get(id),
    ].filter(Boolean);
    return (
      [...versions].reverse().find((item) => {
        const valid =
          at === null ||
          (item.validTime.from <= at &&
            (item.validTime.to === null || at < item.validTime.to));
        const known =
          learnedAt === null ||
          (item.transactionTime.from <= learnedAt &&
            (item.transactionTime.to === null ||
              learnedAt < item.transactionTime.to));
        return valid && known;
      }) || null
    );
  }

  related(id, types = COGNITION_RELATION_TYPES) {
    const allowed = new Set(types);
    return [...this.relations.values()].filter(
      (relation) =>
        allowed.has(relation.type) &&
        (relation.from === id || relation.to === id)
    );
  }

  activeBeliefs({ at = Date.now(), scope = null, minimumConfidence = 0 } = {}) {
    return [...this.objects.values()].filter(
      (object) =>
        ['claim', 'finding', 'constraint', 'procedure', 'guard'].includes(
          object.type
        ) &&
        object.state === 'active' &&
        !object.contradicted &&
        object.validTime.from <= at &&
        (object.validTime.to === null || at < object.validTime.to) &&
        (object.confidence ?? 0) >= minimumConfidence &&
        (!scope ||
          Object.entries(scope).every(
            ([key, value]) => object.scope?.[key] === value
          ))
    );
  }

  lexical(query) {
    const terms = String(query)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    return [...this.objects.values()]
      .map((object) => {
        const text = canonicalJson({
          claim: object.claim,
          title: object.title,
          applicability: object.applicability,
          evidence: object.evidence,
          tags: object.tags,
        }).toLowerCase();
        const matches = terms.filter((term) => text.includes(term)).length;
        return { object, score: terms.length ? matches / terms.length : 0 };
      })
      .filter((item) => item.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.object.id.localeCompare(b.object.id)
      );
  }

  snapshot() {
    return canonicalize({
      schemaVersion: 'ucr.graph/1',
      objects: [...this.objects.values()].sort((a, b) =>
        a.id.localeCompare(b.id)
      ),
      history: [...this.history.entries()].sort(([a], [b]) =>
        a.localeCompare(b)
      ),
      relations: [...this.relations.values()].sort((a, b) =>
        a.id.localeCompare(b.id)
      ),
      eventIds: [...this.events.keys()].sort(),
      diagnostics: this.diagnostics,
    });
  }

  digest() {
    return sha256(this.snapshot());
  }

  integrity() {
    const endpointExists = (id) =>
      this.objects.has(id) ||
      (String(id).startsWith('event:') &&
        this.events.has(String(id).slice('event:'.length)));
    const orphaned = [...this.relations.values()].filter(
      (relation) =>
        !endpointExists(relation.from) || !endpointExists(relation.to)
    );
    return {
      valid: orphaned.length === 0 && this.diagnostics.length === 0,
      objects: this.objects.size,
      relations: this.relations.size,
      events: this.events.size,
      orphaned,
      diagnostics: this.diagnostics,
    };
  }
}

export function rebuildGraph(events) {
  return new CognitionGraph().applyAll(events);
}

export function writeProjection(path, graph) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.next`;
  writeFileSync(temporary, `${canonicalJson(graph.snapshot())}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
  return {
    path,
    hash: graph.digest(),
    objects: graph.objects.size,
    relations: graph.relations.size,
  };
}

export function readProjection(path) {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return { projection: parsed, hash: sha256(parsed) };
}

export function migrateWikiGraph(wikiGraph, { eventFactory } = {}) {
  if (typeof eventFactory !== 'function')
    throw new Error('migration requires eventFactory');
  const events = [];
  let sequence = 0;
  const nodes =
    wikiGraph?.nodes instanceof Map
      ? [...wikiGraph.nodes.values()]
      : Object.values(wikiGraph?.nodes || {});
  for (const node of nodes.sort((a, b) =>
    String(a.id || a.key).localeCompare(String(b.id || b.key))
  )) {
    const type = objectTypes.has(node.kind)
      ? node.kind
      : node.kind === 'finding'
        ? 'finding'
        : 'entity';
    events.push(
      eventFactory({
        sequence: sequence++,
        type:
          node.kind === 'finding'
            ? 'finding.activated'
            : 'observation.recorded',
        payload: {
          object: {
            ...node,
            id: node.id || `${type}:${node.key}`,
            type,
            scope: { projectId: node.projectId || 'current-project' },
          },
        },
      })
    );
  }
  for (const edge of wikiGraph?.edges || []) {
    if (!relationTypes.has(edge.type)) continue;
    events.push(
      eventFactory({
        sequence: sequence++,
        type: 'observation.recorded',
        payload: {
          relations: [{ from: edge.from, to: edge.to, type: edge.type }],
        },
      })
    );
  }
  return events;
}
