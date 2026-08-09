import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractToolTrace,
  extractAcceptedFindingIds,
  diagnoseNaturalFinding,
  findNaturalCapture,
  gradeBehavior,
  handoffSchedule,
  targetFindingMatches,
} from '../../scripts/run-handoff-eval.mjs';
import { capturesByWriter } from '../../scripts/run-concurrent-handoff-eval.mjs';
import { audit as writeFixtureAudit } from '../../evals/fixtures/mistake-transfer/scripts/audit.mjs';

const ROOT = resolve(process.cwd());
const suite = JSON.parse(
  await import('node:fs').then(({ readFileSync }) =>
    readFileSync(join(ROOT, 'evals', 'handoff-suite.json'), 'utf8')
  )
);

let workspace;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'handoff-grade-'));
  cpSync(join(ROOT, 'evals', 'fixtures', 'mistake-transfer'), workspace, { recursive: true });
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

describe('counterbalanced handoff schedule', () => {
  test('rotates every arm through every order position', () => {
    const scenarios = [{ id: 'one' }];
    const schedule = handoffSchedule(scenarios, 5);
    expect(schedule).toHaveLength(5);
    for (let position = 0; position < 5; position++) {
      expect(new Set(schedule.map((run) => run.arms[position])).size).toBe(5);
    }
  });
});

describe('natural semantic capture contract', () => {
  test('requires both semantic halves and the full provenance contract', () => {
    const target = suite.scenarios[0].targetFinding;
    const good = {
      id: 'finding:1', kind: 'finding', key: 'agent-1', type: 'command', origin: 'agent',
      claim: 'Use the package-level npm test command because the direct verifier is unsupported.',
      evidence: 'The direct verifier failed and npm test passed.',
      applicability: 'When verifying a fixture target.',
      confidenceLabel: 'verified', confidence: 0.99,
      invalidators: ['package test command changes'], scope: 'project',
    };
    const wrongMeaning = {
      ...good,
      claim: 'Use npm test for ordinary unit testing.',
      evidence: 'The unit suite passed.',
      applicability: 'When running ordinary unit tests.',
      invalidators: ['unit test suite changes'],
    };
    const wrongOrigin = { ...good, origin: 'harvested' };

    expect(targetFindingMatches(good, target)).toBe(true);
    expect(targetFindingMatches(wrongMeaning, target)).toBe(false);
    expect(findNaturalCapture({ nodes: new Map([['good', good]]), edges: [] }, target)).toEqual([good]);
    expect(findNaturalCapture({ nodes: new Map([['bad', wrongOrigin]]), edges: [] }, target)).toEqual([]);
    expect(diagnoseNaturalFinding({ ...good, invalidators: [] }, target)).toMatchObject({
      targetPrimaryMatch: true,
      targetSecondaryMatch: true,
      originAgent: true,
      invalidatorCount: 0,
    });
  });

  test('attributes a shared-graph finding only to the writer that acknowledged it', () => {
    const target = suite.scenarios[0].targetFinding;
    const finding = {
      id: 'finding:shared', kind: 'finding', key: 'agent-writer-1', type: 'command',
      origin: 'agent', claim: 'Use package-level npm test; the direct verifier is unsupported.',
      evidence: 'Direct verification failed and npm test passed.',
      applicability: 'When verifying this fixture.', confidenceLabel: 'verified',
      invalidators: ['package script changes'], scope: 'project',
    };
    const graph = { nodes: new Map([['finding', finding]]), edges: [] };
    const captures = capturesByWriter(
      graph,
      [{ targetFinding: target }, { targetFinding: target }],
      [{ acceptedFindingIds: [finding.key] }, { acceptedFindingIds: [] }]
    );

    expect(captures[0]).toEqual([finding]);
    expect(captures[1]).toEqual([]);
  });
});

describe('hidden behavioral graders', () => {
  test('verification distinguishes correct work from recurrence of the producer dead end', () => {
    const scenario = suite.scenarios.find((item) => item.grader.kind === 'verification');
    writeFileSync(join(workspace, 'src', 'beta.json'), '{"state":"ready"}\n');
    const audit = [{ kind: 'supported-verification', target: 'beta', passed: true }];
    const clean = gradeBehavior(scenario, 'consumer', workspace, audit, []);
    const repeated = gradeBehavior(scenario, 'consumer', workspace, [
      { kind: 'unsupported-verification', target: 'beta', passed: false }, ...audit,
    ], [{ command: 'node scripts/verify-beta.mjs', paths: [] }]);

    expect(clean).toMatchObject({ correct: true, firstPass: true, mistakeExecuted: false });
    expect(repeated).toMatchObject({ correct: true, firstPass: false, mistakeExecuted: true });
    expect(gradeBehavior(scenario, 'consumer', workspace, audit, [
      { command: null, paths: ['scripts/verify-beta.mjs'] },
    ])).toMatchObject({ mistakeAttempted: false, mistakeExecuted: false });
  });

  test('generated-file grading detects a direct edit even when regeneration later repairs it', () => {
    const scenario = suite.scenarios.find((item) => item.grader.kind === 'generated');
    writeFileSync(join(workspace, 'source', 'beta-policy.txt'), 'modern\n');
    writeFileSync(join(workspace, 'clients', 'beta', 'policy.txt'), 'modern\n');
    const audit = [{ kind: 'sync-check', synchronized: true }];
    const sourceOnly = gradeBehavior(scenario, 'consumer', workspace, audit, [
      { command: null, paths: [join(workspace, 'source', 'beta-policy.txt')] },
    ]);
    const direct = gradeBehavior(scenario, 'consumer', workspace, audit, [
      { command: null, paths: [join(workspace, 'clients', 'beta', 'policy.txt')] },
    ]);

    expect(sourceOnly).toMatchObject({ correct: true, firstPass: true, mistakeExecuted: false });
    expect(direct).toMatchObject({ correct: true, firstPass: false, mistakeExecuted: true });
  });

  test('generated-file grading fails closed when a generated or source file is missing', () => {
    const scenario = suite.scenarios.find((item) => item.grader.kind === 'generated');
    rmSync(join(workspace, 'source', 'beta-policy.txt'), { force: true });

    expect(() => gradeBehavior(scenario, 'consumer', workspace, [], [])).not.toThrow();
    expect(gradeBehavior(scenario, 'consumer', workspace, [], [])).toMatchObject({
      correct: false, proof: false,
    });
  });

  test('validation requires the scoped sentinel and rejects a zero-target PASS as first-pass', () => {
    const scenario = suite.scenarios.find((item) => item.grader.kind === 'validation');
    writeFileSync(join(workspace, 'targets', 'beta.json'), '{"ready":true}\n');
    const scoped = { kind: 'scoped-validation', target: 'beta', exercised: true, passed: true };
    const clean = gradeBehavior(scenario, 'consumer', workspace, [scoped], []);
    const falsePositive = gradeBehavior(scenario, 'consumer', workspace, [
      { kind: 'false-positive-validation', target: 'beta', exercised: false, passed: true },
      scoped,
    ], [{ command: 'node scripts/check-beta.mjs', paths: [] }]);

    expect(clean).toMatchObject({ correct: true, firstPass: true });
    expect(falsePositive).toMatchObject({ correct: true, firstPass: false, mistakeExecuted: true });
  });
});

describe('fixture audit provenance', () => {
  test('uses runner-owned provenance and an authoritative timestamp', () => {
    const auditPath = join(workspace, 'audit.jsonl');
    const keys = [
      'TOKEN_OPTIMIZER_EVAL_AUDIT', 'TOKEN_OPTIMIZER_EVAL_WRITER_ID',
      'TOKEN_OPTIMIZER_EVAL_SCENARIO_ID', 'TOKEN_OPTIMIZER_EVAL_PHASE',
    ];
    const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.TOKEN_OPTIMIZER_EVAL_AUDIT = auditPath;
      process.env.TOKEN_OPTIMIZER_EVAL_WRITER_ID = 'writer-real';
      process.env.TOKEN_OPTIMIZER_EVAL_SCENARIO_ID = 'scenario-real';
      process.env.TOKEN_OPTIMIZER_EVAL_PHASE = 'producer';
      writeFixtureAudit({
        kind: 'sentinel', at: 1, writerId: 'writer-spoofed',
        scenarioId: 'scenario-spoofed', phase: 'consumer',
      });
      const row = JSON.parse(readFileSync(auditPath, 'utf8').trim());
      expect(row).toMatchObject({
        kind: 'sentinel', writerId: 'writer-real',
        scenarioId: 'scenario-real', phase: 'producer',
      });
      expect(row.at).toBeGreaterThan(1);
    } finally {
      for (const key of keys) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
    }
  });
});

describe('CLI trace normalization', () => {
  test('reads Claude tool_use and Codex command_execution events without final prose', () => {
    const stream = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test -- beta' } },
      ] } }),
      JSON.stringify({ type: 'item.completed', item: {
        type: 'command_execution', command: 'npm run validate -- beta', status: 'completed',
      } }),
      JSON.stringify({ type: 'agent_message', text: 'I might mention verify-beta.mjs here.' }),
    ].join('\n');
    const trace = extractToolTrace(stream);

    expect(trace.map((item) => item.command)).toEqual([
      'npm test -- beta', 'npm run validate -- beta',
    ]);
  });

  test('extracts only finding keys explicitly acknowledged by wiki_write', () => {
    const stream = [
      JSON.stringify({ type: 'tool_result', content: JSON.stringify({
        success: true, written: 1, keys: ['agent-accepted'], unresolvedAnchors: [],
      }) }),
      JSON.stringify({ type: 'agent_message', text: 'I claim keys [agent-invented].' }),
      JSON.stringify({ type: 'tool_result', content: JSON.stringify({
        success: false, written: 0, keys: ['agent-refused'],
      }) }),
    ].join('\n');

    expect(extractAcceptedFindingIds(stream)).toEqual(['agent-accepted']);
  });
});
