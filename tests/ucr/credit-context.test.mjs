import { describe, expect, test } from '@jest/globals';
import {
  CognitionGraph,
  ContextVM,
  CreditLedger,
  RetrievalPlanner,
  exactEpisodeJoin,
  outcomeVerdict,
} from '../../ucr/index.mjs';

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
      expect.arrayContaining(['failure', 'lexical'])
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
});
