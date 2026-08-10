import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ArtifactStore,
  EventStore,
  HybridLogicalClock,
  canonicalJson,
  canonicalReplay,
  compareHlc,
  createEvent,
  createRunIdentity,
  migrateEvent,
  negotiateProtocol,
  sha256,
  uuidv7,
  validateEvent,
  signEvent,
  verifyEventSignature,
  verifyRunIdentity,
} from '../../ucr/index.mjs';

const actor = {
  agentId: 'agent-a',
  client: 'codex',
  clientVersion: '1',
  model: 'gpt',
  modelVersion: '1',
  capabilityTier: 'continuable',
};
const scope = {
  taskId: 'task-a',
  sessionId: 'session-a',
  projectId: 'project-a',
  workspaceId: 'workspace-a',
};

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ucr-protocol-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function event(sequence, overrides = {}) {
  const clock =
    overrides.clock || new HybridLogicalClock(overrides.writerId || 'writer-a');
  return createEvent({
    type: 'observation.recorded',
    payload: { value: sequence },
    traceId: 'trace-a',
    writer: { id: overrides.writerId || 'writer-a', sequence },
    actor,
    scope,
    clock,
    wallMs: 1_800_000_000_000 + sequence,
    idempotencyKey: overrides.idempotencyKey || `event-${sequence}`,
    ...overrides,
  });
}

describe('universal cognitive event protocol', () => {
  test('creates UUIDv7 identities, hybrid time, hashes, and a valid envelope', () => {
    const created = event(1);
    expect(created.eventId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab]/
    );
    expect(created.payloadHash).toBe(sha256({ value: 1 }));
    expect(validateEvent(created)).toMatchObject({
      valid: true,
      unknownType: false,
    });
  });

  test('orders local and observed remote hybrid clocks deterministically', () => {
    const a = new HybridLogicalClock('a');
    const first = a.tick(100);
    const second = a.tick(100);
    const b = new HybridLogicalClock('b');
    const observed = b.observe(second, 99);
    expect(compareHlc(first, second)).toBeLessThan(0);
    expect(compareHlc(second, observed)).toBeLessThan(0);
  });

  test('keeps unknown optional fields but fails closed on unknown required semantics', () => {
    const optional = event(1, {
      extensions: { futureField: { nested: true } },
    });
    expect(JSON.parse(canonicalJson(optional)).futureField).toEqual({
      nested: true,
    });

    const unknown = event(2, { type: 'future.optional' });
    expect(validateEvent(unknown)).toMatchObject({
      valid: true,
      unknownType: true,
    });
    expect(validateEvent({ ...unknown, requiredSemantics: true }).valid).toBe(
      false
    );
  });

  test('negotiates only a mutually supported protocol version', () => {
    expect(negotiateProtocol(['1.0.0', '1.1.0'], ['0.9.0', '1.0.0'])).toBe(
      '1.0.0'
    );
    expect(negotiateProtocol(['1.0.0'], ['2.0.0'])).toBeNull();
  });

  test('uuid ordering follows wall time for stable prefixes', () => {
    const entropy = Buffer.alloc(10, 1);
    expect(
      uuidv7(100, entropy).localeCompare(uuidv7(101, entropy))
    ).toBeLessThan(0);
  });

  test('attributes resources and artifacts to a signed run and event', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const identity = createRunIdentity(
      {
        runId: 'run-a',
        actor,
        sourceTreeHash: 'a'.repeat(64),
        benchmarkHash: 'b'.repeat(64),
        keyId: 'test-key',
        issuedAt: '2026-08-09T00:00:00.000Z',
      },
      privateKey
    );
    expect(verifyRunIdentity(identity, publicKey)).toBe(true);
    const created = event(3, {
      run: { runId: identity.runId, identityHash: identity.identityHash },
      resources: { inputTokens: 50, capsuleTokens: 10, latencyMs: 20 },
      artifactRefs: [{ uri: `sha256:${'a'.repeat(64)}` }],
    });
    const signed = signEvent(created, privateKey, { keyId: 'test-key' });
    expect(validateEvent(signed).valid).toBe(true);
    expect(verifyEventSignature(signed, publicKey)).toBe(true);
    expect(
      verifyEventSignature(
        { ...signed, resources: { ...signed.resources, inputTokens: 51 } },
        publicKey
      )
    ).toBe(false);
  });

  test('migrates the legacy envelope without discarding unknown fields', () => {
    const migrated = migrateEvent({
      schemaVersion: 'ucr.event/0',
      eventId: 'legacy-event',
      type: 'observation.recorded',
      timestamp: 1_710_000_000_000,
      sequence: 2,
      client: 'legacy-cli',
      payload: { answer: 42 },
      futureOptional: { retained: true },
    });
    expect(validateEvent(migrated).valid).toBe(true);
    expect(migrated).toMatchObject({
      schemaVersion: 'ucr.event/1',
      migratedFrom: 'ucr.event/0',
      futureOptional: { retained: true },
      actor: { client: 'legacy-cli' },
    });
  });
});

describe('event and artifact stores', () => {
  test('deduplicates and replays out-of-order delivery to one canonical stream', () => {
    const first = event(1);
    const second = event(2);
    const duplicate = { ...first, eventId: uuidv7(1_800_000_000_999) };
    const left = canonicalReplay([second, duplicate, first]).events.map(
      (item) => item.idempotencyKey
    );
    const right = canonicalReplay([first, second]).events.map(
      (item) => item.idempotencyKey
    );
    expect(left).toEqual(right);
  });

  test('non-strict replay diagnoses and excludes structurally unsafe events', () => {
    const safeButInvalid = {
      ...event(2),
      payloadHash: 'invalid-but-orderable',
    };
    const replay = canonicalReplay(
      [
        null,
        'text',
        {},
        { eventId: 'missing-ordering-fields' },
        safeButInvalid,
      ],
      { strict: false }
    );

    expect(replay.events).toEqual([safeButInvalid]);
    expect(replay.diagnostics).toHaveLength(5);
    expect(replay.diagnostics.map((item) => item.eventId)).toEqual([
      null,
      null,
      null,
      'missing-ordering-fields',
      safeButInvalid.eventId,
    ]);
  });

  test('persists idempotently and produces a stable digest after compaction', () => {
    const store = new EventStore(join(root, 'events'));
    const first = event(1);
    expect(store.append(first)).toMatchObject({
      accepted: true,
      duplicate: false,
    });
    expect(store.append(first)).toMatchObject({
      accepted: false,
      duplicate: true,
    });
    const before = store.digest();
    expect(store.compact()).toMatchObject({
      compacted: true,
      events: 1,
      hash: before,
    });
    expect(store.digest()).toBe(before);
  });

  test('redacts sensitive payloads without losing metric-safe envelope fields', () => {
    const store = new EventStore(join(root, 'events'));
    store.append(
      event(1, {
        sensitivity: 'restricted',
        payload: { secret: 'value', tokens: 5 },
      })
    );
    const [redacted] = store.exportRedacted();
    expect(redacted.payload).toBeUndefined();
    expect(redacted.payloadRedacted).toBe(true);
    expect(redacted.payloadHash).toHaveLength(64);
  });

  test('stores content by digest and detects address integrity', () => {
    const artifacts = new ArtifactStore(join(root, 'artifacts'));
    const reference = artifacts.put('large tool output', {
      mediaType: 'text/plain',
    });
    expect(reference.uri).toBe(`sha256:${reference.hash}`);
    expect(artifacts.get(reference).toString('utf8')).toBe('large tool output');
  });
});
