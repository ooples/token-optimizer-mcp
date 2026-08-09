import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CheckpointStore,
  CoordinationRuntime,
  checkpointCompatibility,
  compactLogicalHistory,
  consolidationProposals,
  createCheckpoint,
  decayState,
  recordTakeoverAction,
  resolveContradiction,
  restoreCheckpoint,
} from '../../ucr/index.mjs';

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ucr-continuity-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function checkpoint(overrides = {}) {
  return createCheckpoint(
    {
      goalDag: { nodes: [{ id: 'goal' }], edges: [] },
      plan: [{ step: 'fix', state: 'in_progress' }],
      currentHypothesis: 'source is generated',
      decisions: [],
      rejectedAlternatives: [],
      workspace: {
        head: 'abc',
        dirtyHash: 'clean',
        artifactHashes: { 'a.ts': 'h1' },
      },
      edits: [],
      attemptedActions: ['direct verifier'],
      knownFailures: ['direct verifier unsupported'],
      validations: [{ command: 'npm test', passed: true }],
      invariants: ['do not edit generated output'],
      permissions: ['edit workspace'],
      blockers: [],
      ownership: { task: 'agent-a' },
      unresolvedQuestions: [],
      nextSafeAction: { kind: 'edit', path: 'source/a.ts' },
      dependenciesHash: 'deps',
      environmentHash: 'env',
      policyHash: 'policy',
      activeBeliefsHash: 'beliefs',
      ...overrides,
    },
    { boundary: 'handoff', producer: 'codex/gpt', now: 100 }
  );
}

describe('checkpoints and cross-model takeover', () => {
  test('restores verified state without transcript and records a takeover receipt', () => {
    const saved = checkpoint();
    const current = {
      workspace: saved.workspace,
      dependenciesHash: 'deps',
      environmentHash: 'env',
      policyHash: 'policy',
      activeBeliefsHash: 'beliefs',
    };
    expect(checkpointCompatibility(saved, current).compatible).toBe(true);
    const restored = restoreCheckpoint(saved, current, {
      consumer: 'claude/sonnet',
    });
    expect(restored).toMatchObject({ restored: true, requiresRefresh: false });
    expect(
      recordTakeoverAction(restored.receipt, saved.nextSafeAction)
    ).toMatchObject({
      actedOn: saved.nextSafeAction,
    });
  });

  test('detects a stale checkpoint before authorizing an incompatible action', () => {
    const saved = checkpoint();
    const restored = restoreCheckpoint(
      saved,
      {
        workspace: {
          ...saved.workspace,
          head: 'changed',
          artifactHashes: { 'a.ts': 'changed' },
        },
        dependenciesHash: 'deps',
        environmentHash: 'env',
        policyHash: 'different',
        activeBeliefsHash: 'beliefs',
      },
      { consumer: 'gemini' }
    );
    expect(restored).toMatchObject({ restored: false, requiresRefresh: true });
    expect(restored.receipt.nextSafeAction).toBeNull();
  });

  test('writes only complete atomic checkpoints', () => {
    const store = new CheckpointStore(join(root, 'checkpoints'));
    const saved = checkpoint();
    store.write(saved);
    expect(store.read(saved.checkpointId)).toEqual(saved);
    expect(store.recover()).toMatchObject({ committedOnly: true });
  });
});

describe('distributed multi-agent coordination', () => {
  test('uses leases, optimistic versions, explicit conflicts, handoff, and expiry recovery', () => {
    const runtime = new CoordinationRuntime({ leaseMs: 10 });
    runtime.registerAgent({ id: 'a', capabilities: ['code'] });
    runtime.registerAgent({ id: 'b', capabilities: ['code'] });
    runtime.defineTask({
      id: 'task',
      goal: 'fix',
      artifacts: ['a.ts'],
      plannedActions: ['edit'],
    });
    const claimed = runtime.claim('task', 'a', {
      expectedVersion: 0,
      now: 100,
    });
    expect(claimed.claimed).toBe(true);
    expect(runtime.claim('task', 'b', { now: 101 }).conflict).toBeDefined();
    expect(runtime.renew(claimed.lease.leaseId, 'a', 105).renewed).toBe(true);
    expect(runtime.recover(116)).toMatchObject({ recoverableTasks: ['task'] });
    expect(runtime.claim('task', 'b', { now: 117 }).claimed).toBe(true);
  });

  test('suppresses duplicate tasks and coordinates one hundred writers without lost claims', () => {
    const runtime = new CoordinationRuntime();
    for (let index = 0; index < 100; index++) {
      runtime.registerAgent({ id: `agent-${index}`, capabilities: ['worker'] });
      runtime.defineTask({
        id: `task-${index}`,
        goal: `goal-${index}`,
        artifacts: [`f-${index}`],
        plannedActions: ['work'],
      });
    }
    const claims = Array.from({ length: 100 }, (_, index) =>
      runtime.claim(`task-${index}`, `agent-${index}`)
    );
    expect(claims.filter((result) => result.claimed)).toHaveLength(100);
    expect(runtime.snapshot().leases).toHaveLength(100);
    expect(
      runtime.defineTask({
        id: 'duplicate',
        goal: 'goal-1',
        artifacts: ['f-1'],
        plannedActions: ['work'],
      })
    ).toMatchObject({ defined: false, duplicateOf: 'task-1' });
  });
});

describe('consolidation, contradiction, and forgetting', () => {
  const objects = [
    {
      id: 'a',
      type: 'failure',
      state: 'active',
      trigger: 'verify',
      correction: 'npm test',
      confidence: 0.9,
      learnedAt: 1,
    },
    {
      id: 'b',
      type: 'failure',
      state: 'active',
      trigger: 'verify',
      correction: 'npm test',
      confidence: 0.8,
      learnedAt: 2,
    },
  ];

  test('creates separately attributed proposals without upgrading source confidence', () => {
    const [proposal] = consolidationProposals(objects, {
      author: 'consolidator',
    });
    expect(proposal).toMatchObject({
      state: 'speculative',
      author: 'consolidator',
      confidence: 0.8,
    });
    expect(proposal.sourceIds).toEqual(['a', 'b']);
    expect(proposal.verificationReceiptIds).toEqual([]);
  });

  test('retains both contradictory views and resolves only with weighted evidence', () => {
    expect(
      resolveContradiction(objects[0], objects[1], [
        {
          objectId: 'b',
          passed: true,
          receiptId: 'proof-b',
        },
      ])
    ).toMatchObject({
      state: 'resolved',
      activeId: 'b',
      supersededId: 'a',
      retained: ['a', 'b'],
    });
  });

  test('decays low-value memory while preserving dependencies and logical history hashes', () => {
    expect(
      decayState(
        { ...objects[0], confidence: 0, learnedAt: 1 },
        { now: 1e12, utility: -1 }
      )
    ).toBe('tombstoned');
    expect(
      decayState(
        { ...objects[0], confidence: 0, learnedAt: 1 },
        { now: 1e12, utility: -1, dependedOn: true }
      )
    ).toBe('stale');
    const compacted = compactLogicalHistory(objects, []);
    expect(compacted.logicalHistoryHash).toHaveLength(64);
    expect(compacted.canonical.objects).toHaveLength(2);
  });
});
