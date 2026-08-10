import { afterEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CognitionGraph,
  ContextVM,
  CreditLedger,
  RetrievalPlanner,
  exactEpisodeJoin,
  outcomeVerdict,
  ablationEffect,
  quarantineLatency,
  WorkingSetStore,
  createTiktokenCounter,
  calibrateRetrievalRouter,
} from '../../ucr/index.mjs';

const temporary = [];
afterEach(() => {
  while (temporary.length)
    rmSync(temporary.pop(), { recursive: true, force: true });
});

function joinedEpisode(overrides = {}) {
  const events = [
    { kind: 'candidate', episodeId: 'e1', objectId: 'memory:a' },
    {
      kind: 'delivery',
      episodeId: 'e1',
      deliveryId: 'd1',
      objectIds: ['memory:a'],
    },
    { kind: 'action', episodeId: 'e1', actionId: 'a1', deliveryId: 'd1' },
    {
      kind: 'outcome',
      episodeId: 'e1',
      outcomeId: 'o1',
      actionId: 'a1',
      graderId: 'g1',
    },
    ...(overrides.events || []),
  ];
  return exactEpisodeJoin(events, 'e1');
}

describe('causal credit and quarantine', () => {
  test('refuses confounded or ungraded joins', () => {
    const confounded = exactEpisodeJoin(
      [
        {
          kind: 'delivery',
          episodeId: 'e',
          deliveryId: 'd1',
          objectIds: ['m'],
        },
        {
          kind: 'delivery',
          episodeId: 'e',
          deliveryId: 'd2',
          objectIds: ['m'],
        },
        { kind: 'action', episodeId: 'e', actionId: 'a', deliveryId: 'd1' },
        { kind: 'outcome', episodeId: 'e', outcomeId: 'o', actionId: 'a' },
      ],
      'e'
    );
    expect(confounded.valid).toBe(false);
    expect(confounded.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining('deterministic grader'),
        expect.stringContaining('more than once'),
      ])
    );
  });

  test('never labels token savings a win when correctness regresses', () => {
    expect(
      outcomeVerdict(
        { correct: false, tokens: 10 },
        { correct: true, tokens: 100 }
      )
    ).toBe('failed');
  });

  test('quarantines one severe regression before another selection', () => {
    const ledger = new CreditLedger();
    expect(
      ledger.record({
        objectId: 'memory:a',
        context: { client: 'codex' },
        baseline: { correct: true, tokens: 100 },
        outcome: { correct: false, severeHarm: true, tokens: 10 },
        join: joinedEpisode(),
      })
    ).toMatchObject({ recorded: true, quarantined: true });
    expect(ledger.selection(['memory:a'], { client: 'codex' })).toMatchObject({
      action: 'abstain',
    });
    expect(ledger.utility('memory:a')).toMatchObject({
      samples: 1,
      harmful: 1,
    });
  });

  test('publishes distributions with uncertainty and sample size', () => {
    const ledger = new CreditLedger();
    for (let index = 0; index < 6; index++) {
      ledger.record({
        objectId: 'memory:good',
        context: { client: 'codex' },
        baseline: { correct: false, mistakeExecuted: true, tokens: 100 },
        outcome: { correct: true, mistakeExecuted: false, tokens: 50 },
        join: joinedEpisode(),
      });
    }
    expect(
      ledger.selection(['memory:good'], { client: 'codex' })
    ).toMatchObject({
      action: 'deliver',
      objectIds: ['memory:good'],
    });
    expect(ledger.utility('memory:good').correctness).toMatchObject({
      samples: 6,
      mean: 1,
    });
  });

  test('measures attributable ablations and quarantine before redelivery', () => {
    const rows = Array.from({ length: 6 }, (_, index) => [
      {
        pairId: `p${index}`,
        objectId: 'memory:a',
        variant: 'ablated',
        correct: 0,
      },
      {
        pairId: `p${index}`,
        objectId: 'memory:a',
        variant: 'included',
        correct: 1,
      },
    ]).flat();
    expect(ablationEffect(rows, 'memory:a')).toMatchObject({
      pairs: 6,
      mean: 1,
      attributable: true,
    });
    expect(
      quarantineLatency(
        [
          { objectId: 'memory:a', severeHarm: true, at: 100 },
          { objectId: 'memory:a', kind: 'quarantine', at: 101 },
          { objectId: 'memory:a', kind: 'delivery', at: 102 },
        ],
        'memory:a'
      )
    ).toMatchObject({ latencyMs: 1, beforeNextDelivery: true });
  });
});

describe('adaptive retrieval and context virtual machine', () => {
  function graph() {
    const graph = new CognitionGraph();
    graph.objects.set('failure:a', {
      id: 'failure:a',
      type: 'failure',
      state: 'active',
      confidence: 0.98,
      learnedAt: Date.now(),
      claim: 'Direct verifier is unsupported; use npm test.',
      correction: 'Use npm test',
      applicability: ['verification'],
      nonApplicability: ['ordinary reads'],
      provenance: ['event:a'],
      expectedUtility: 0.8,
    });
    graph.objects.set('claim:stale', {
      id: 'claim:stale',
      type: 'claim',
      state: 'stale',
      confidence: 1,
      learnedAt: Date.now(),
      claim: 'Use the old verifier.',
    });
    return graph;
  }

  test('uses multiple kernels and explains exclusions and paths', () => {
    const planner = new RetrievalPlanner({
      graph: graph(),
      compatibility: (object, context) => ({
        compatible: context.projectId === 'project-a',
        reasons:
          context.projectId === 'project-a'
            ? ['same project']
            : ['project mismatch'],
      }),
    });
    const result = planner.plan('avoid the verifier failure', {
      projectId: 'project-a',
    });
    expect(result.action).toBe('deliver');
    expect(result.candidates[0].kernels).toEqual(
      expect.arrayContaining(['failure', 'bm25'])
    );
    expect(result.explanation.family).toBe('failure');
    expect(
      planner.plan('avoid the verifier failure', { projectId: 'other' }).action
    ).toBe('abstain');
    expect(
      planner.plan('database migration failure', { projectId: 'project-a' })
        .action
    ).toBe('abstain');
  });

  test('calibrates kernel routing from labelled retrieval outcomes', () => {
    const rows = Array.from({ length: 5 }, (_, index) => [
      {
        family: 'failure',
        kernel: 'bm25',
        selected: true,
        relevant: true,
        index,
      },
      {
        family: 'failure',
        kernel: 'temporal',
        selected: true,
        relevant: false,
        index,
      },
    ]).flat();
    const calibration = calibrateRetrievalRouter(rows);
    expect(calibration.routes.failure[0]).toBe('bm25');
    expect(calibration.scores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kernel: 'bm25', precision: 1, recall: 1 }),
      ])
    );
  });

  test('retrieves exact task-scoped cognition across query paraphrases', () => {
    const scoped = graph();
    scoped.objects.set('failure:scoped', {
      id: 'failure:scoped',
      type: 'failure',
      state: 'active',
      confidence: 0.95,
      learnedAt: Date.now(),
      correction: 'Apply GREEN-1',
      applicability: ['only takeover-42'],
      nonApplicability: ['every other task'],
      scope: {
        taskId: 'takeover-42',
        projectId: 'project-a',
        workspaceId: 'workspace-a',
      },
    });
    const planner = new RetrievalPlanner({ graph: scoped });
    const result = planner.plan('continue from where the other agent stopped', {
      taskId: 'takeover-42',
      projectId: 'project-a',
      workspaceId: 'workspace-a',
    });
    expect(result.action).toBe('deliver');
    expect(result.candidates[0]).toMatchObject({
      objectId: 'failure:scoped',
      kernels: expect.arrayContaining(['scope']),
    });
    expect(
      planner.plan('continue from where the other agent stopped', {
        taskId: 'different-task',
      }).candidates
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectId: 'failure:scoped' }),
      ])
    );
  });

  test('pages bounded capsules, supports an empty result, and caches raw expansion', () => {
    const planner = new RetrievalPlanner({ graph: graph() });
    let reads = 0;
    const vm = new ContextVM({
      planner,
      hardMaximumTokens: 128,
      artifactResolver: () => {
        reads += 1;
        return 'raw artifact';
      },
    });
    const page = vm.page('verifier failure', {
      taskId: 'task',
      stateHash: 'v1',
      trigger: 'command',
    });
    expect(page.action).toBe('deliver');
    expect(page.tokens).toBeLessThanOrEqual(128);
    expect(page.capsules[0]).toMatchObject({
      tier: 'L3',
      objectIds: ['failure:a'],
    });
    expect(vm.page('nothing matches zzz', {}, { budget: 0 })).toMatchObject({
      action: 'abstain',
      tokens: 0,
    });
    expect(vm.expand('sha256:a')).toMatchObject({
      cached: false,
      content: 'raw artifact',
    });
    expect(vm.expand('sha256:a')).toMatchObject({
      cached: true,
      content: 'raw artifact',
    });
    expect(reads).toBe(1);
  });

  test('invalidates working context when task state changes', () => {
    const vm = new ContextVM({
      planner: new RetrievalPlanner({ graph: graph() }),
    });
    vm.page('verifier failure', { taskId: 'task', stateHash: 'v1' });
    expect(vm.retain('task', 'v1')).not.toBeNull();
    expect(vm.retain('task', 'v2')).toBeNull();
  });

  test('uses native token accounting, zero-work startup, deltas, and persistent working sets', () => {
    const root = mkdtempSync(join(tmpdir(), 'ucr-context-vm-'));
    temporary.push(root);
    const tokenCounter = createTiktokenCounter();
    try {
      const store = new WorkingSetStore(join(root, 'working-sets.json'));
      const vm = new ContextVM({
        planner: new RetrievalPlanner({ graph: graph() }),
        tokenCounter,
        workingSetStore: store,
      });
      expect(vm.sessionStart()).toMatchObject({ calls: 0, tokens: 0 });
      const first = vm.page('verifier failure', {
        taskId: 'task',
        stateHash: 'v1',
        delta: true,
      });
      const second = vm.page('verifier failure', {
        taskId: 'task',
        stateHash: 'v1',
        delta: true,
      });
      expect(first.tokenAccounting).toBe('tiktoken:cl100k_base');
      expect(first.transmittedTokens).toBeGreaterThan(0);
      expect(second).toMatchObject({ transmittedTokens: 0 });
      const resumed = new ContextVM({
        planner: new RetrievalPlanner({ graph: graph() }),
        tokenCounter,
        workingSetStore: store,
      });
      expect(resumed.retain('task', 'v1')).not.toBeNull();
      expect(vm.metrics()).toMatchObject({ startupCalls: 0, startupTokens: 0 });
    } finally {
      tokenCounter.close();
    }
  });
});
