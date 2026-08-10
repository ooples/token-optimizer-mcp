import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HybridLogicalClock,
  createEvent,
  migrateWikiGraph,
  rebuildGraph,
  readProjection,
  writeProjection,
} from '../../ucr/index.mjs';

const actor = {
  agentId: 'agent',
  client: 'codex',
  capabilityTier: 'continuable',
};
const scope = {
  sessionId: 'session',
  projectId: 'project',
  workspaceId: 'workspace',
};
const clock = () => new HybridLogicalClock('writer');
let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ucr-graph-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function make(sequence, type, payload) {
  return createEvent({
    type,
    payload,
    actor,
    scope,
    clock: clock(),
    writer: { id: 'writer', sequence },
    traceId: 'trace',
    wallMs: 1_700_000_000_000 + sequence,
    idempotencyKey: `graph-${sequence}`,
  });
}

describe('typed temporal causal graph', () => {
  test('rebuilds byte-equivalently from shuffled event delivery', () => {
    const events = [
      make(1, 'finding.activated', {
        object: {
          id: 'claim:a',
          type: 'claim',
          claim: 'Use npm test',
          confidence: 0.9,
        },
      }),
      make(2, 'verification.passed', {
        object: { id: 'proof:a', type: 'outcome', correct: true },
        relations: [{ from: 'claim:a', to: 'proof:a', type: 'verified_by' }],
      }),
    ];
    expect(rebuildGraph(events).digest()).toBe(
      rebuildGraph([...events].reverse()).digest()
    );
  });

  test('retains contradictory and superseded beliefs with bitemporal history', () => {
    const original = make(1, 'finding.activated', {
      object: {
        id: 'claim:old',
        type: 'claim',
        claim: 'old rule',
        confidence: 0.9,
      },
    });
    const contrary = make(2, 'finding.activated', {
      object: {
        id: 'claim:new',
        type: 'claim',
        claim: 'new rule',
        confidence: 0.95,
      },
      relations: [
        { from: 'claim:new', to: 'claim:old', type: 'contradicts' },
        { from: 'claim:new', to: 'claim:old', type: 'supersedes' },
      ],
    });
    const graph = rebuildGraph([contrary, original]);
    expect(graph.objects.get('claim:old')).toMatchObject({
      state: 'superseded',
      contradicted: true,
    });
    expect(graph.objects.get('claim:new')).toMatchObject({
      state: 'active',
      contradicted: false,
    });
    expect(graph.related('claim:old').map((relation) => relation.type)).toEqual(
      expect.arrayContaining(['contradicts', 'supersedes'])
    );
    expect(
      graph.object('claim:old', { at: original.time.wallMs })
    ).not.toBeNull();
    expect(graph.activeBeliefs()).toEqual([
      expect.objectContaining({ id: 'claim:new' }),
    ]);
  });

  test('writes a transactional projection with its canonical digest', () => {
    const graph = rebuildGraph([
      make(1, 'observation.recorded', {
        object: { id: 'entity:a', type: 'entity', title: 'A' },
      }),
    ]);
    const path = join(root, 'projection.json');
    const written = writeProjection(path, graph);
    expect(readProjection(path).hash).toBe(written.hash);
    expect(graph.integrity()).toMatchObject({
      valid: true,
      objects: 1,
      events: 1,
    });
  });

  test('migrates existing wiki nodes without broadening project scope', () => {
    const wiki = {
      nodes: new Map([
        [
          'finding:a',
          {
            id: 'finding:a',
            kind: 'finding',
            key: 'a',
            claim: 'A',
            projectId: 'repo-a',
          },
        ],
      ]),
      edges: [],
    };
    const events = migrateWikiGraph(wiki, {
      eventFactory: ({ sequence, type, payload }) =>
        make(sequence, type, payload),
    });
    const graph = rebuildGraph(events);
    expect(graph.objects.get('finding:a').scope.projectId).toBe('repo-a');
    expect(
      graph.activeBeliefs({ scope: { projectId: 'repo-a' } })
    ).toHaveLength(1);
    expect(graph.activeBeliefs({ scope: { projectId: 'other' } })).toHaveLength(
      0
    );
  });
});
