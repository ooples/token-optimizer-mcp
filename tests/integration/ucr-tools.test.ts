import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runUcrTool } from '../../src/server/ucr-tools.js';

let root: string;
let previous: string | undefined;
let previousSecret: string | undefined;
let previousProject: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ucr-tools-'));
  previous = process.env.TOKEN_OPTIMIZER_UCR_DIR;
  previousSecret = process.env.TOKEN_OPTIMIZER_GRADER_SECRET;
  previousProject = process.env.TOKEN_OPTIMIZER_PROJECT_ID;
  process.env.TOKEN_OPTIMIZER_UCR_DIR = root;
  process.env.TOKEN_OPTIMIZER_GRADER_SECRET = 'integration-test-secret';
  process.env.TOKEN_OPTIMIZER_PROJECT_ID = 'ucr-tools-test';
});

afterEach(() => {
  if (previous === undefined) delete process.env.TOKEN_OPTIMIZER_UCR_DIR;
  else process.env.TOKEN_OPTIMIZER_UCR_DIR = previous;
  if (previousSecret === undefined)
    delete process.env.TOKEN_OPTIMIZER_GRADER_SECRET;
  else process.env.TOKEN_OPTIMIZER_GRADER_SECRET = previousSecret;
  if (previousProject === undefined)
    delete process.env.TOKEN_OPTIMIZER_PROJECT_ID;
  else process.env.TOKEN_OPTIMIZER_PROJECT_ID = previousProject;
  rmSync(root, { recursive: true, force: true });
});

function semanticFailure() {
  return {
    trigger: 'a direct generated-output edit',
    attemptedAction: 'edit clients/beta/policy.txt',
    observedFailure: 'regeneration overwrote the change',
    rootCause: 'the file is generated',
    correction: 'edit source/beta-policy.txt and regenerate',
    verificationEvidence: 'sync grader passed',
    applicability: ['the client policy is generated'],
    nonApplicability: ['the target is a source file'],
    invalidators: ['generator manifest changes'],
    scope: 'project',
    confidence: 0.98,
    confidenceLabel: 'observed',
    expectedOutcome: 'source and generated outputs remain synchronized',
  };
}

describe('four-operation UCR MCP runtime', () => {
  test('records verified active-model cognition and pages it back selectively', async () => {
    const { signGraderReceipt } = await import('../../ucr/index.mjs');
    const priorDelivery = await runUcrTool('context_page', {
      query: 'an unrelated empty-graph request',
      taskId: 'earlier-task',
      budget: 128,
    });
    const receipt = signGraderReceipt(
      {
        graderId: 'sync-check',
        passed: true,
        artifactHash: 'a'.repeat(64),
      },
      'integration-test-secret'
    );
    const recorded = await runUcrTool('cognition_record', {
      kind: 'failure',
      semanticObject: semanticFailure(),
      evidenceReceipts: [receipt],
      taskId: 'task',
      sessionId: 'session',
    });
    expect(recorded).toMatchObject({
      accepted: true,
      object: { state: 'active', type: 'failure' },
    });
    expect(recorded.eventIds).toHaveLength(4);
    expect(new Set(recorded.eventIds).size).toBe(4);
    expect(recorded.eventIds).not.toContain(priorDelivery.deliveryEventId);

    const context = await runUcrTool('context_page', {
      query: 'avoid editing the generated policy output',
      taskId: 'task',
      budget: 512,
    });
    expect(context.action).toBe('deliver');
    expect(context.capsules[0].payload).toContain(
      'edit source/beta-policy.txt'
    );
    expect(context.deliveryEventId).toBeTruthy();
    const { EventStore, rebuildGraph } = await import('../../ucr/index.mjs');
    expect(
      rebuildGraph(new EventStore(root).read().events).integrity()
    ).toMatchObject({ valid: true });

    process.env.TOKEN_OPTIMIZER_PROJECT_ID = 'different-project';
    const denied = await runUcrTool('context_page', {
      query: 'avoid editing the generated policy output',
      taskId: 'task',
      budget: 512,
    });
    expect(denied).toMatchObject({ action: 'abstain', capsules: [] });
  });

  test('creates/restores checkpoints and records correctness-first outcomes', async () => {
    const { signGraderReceipt } = await import('../../ucr/index.mjs');
    const checkpoint = {
      goalDag: { nodes: [{ id: 'goal' }], edges: [] },
      plan: [],
      workspace: { head: 'abc', artifactHashes: {} },
      attemptedActions: [],
      knownFailures: [],
      validations: [],
      invariants: [],
      permissions: [],
      ownership: {},
      nextSafeAction: { kind: 'inspect' },
    };
    const created = await runUcrTool('checkpoint_handoff', {
      operation: 'create',
      checkpoint,
      boundary: 'handoff',
    });
    expect(created.created).toBe(true);
    const restored = await runUcrTool('checkpoint_handoff', {
      operation: 'restore',
      checkpoint: created.checkpoint,
      currentState: { workspace: { head: 'abc', artifactHashes: {} } },
      consumer: 'claude',
    });
    expect(restored.restored).toBe(true);

    expect(
      await runUcrTool('outcome_report', {
        episodeId: 'episode',
        outcome: { correct: true, severeHarm: false },
        graderReceipt: signGraderReceipt(
          {
            graderId: 'hidden-end-state',
            passed: true,
            artifactHash: 'b'.repeat(64),
          },
          'integration-test-secret'
        ),
      })
    ).toMatchObject({ recorded: true, outcome: { correct: true } });
  });

  test('rejects model-forged grader receipts', async () => {
    await expect(
      runUcrTool('cognition_record', {
        kind: 'failure',
        semanticObject: semanticFailure(),
        evidenceReceipts: [
          {
            graderId: 'self-asserted',
            passed: true,
            artifactHash: 'c'.repeat(64),
          },
        ],
      })
    ).rejects.toThrow('external deterministic-grader signature');
  });
});
