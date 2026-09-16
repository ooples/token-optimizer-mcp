import { test, expect } from '@jest/globals';
import {
  groupMatrix,
  matchAudits,
  auditedPilot,
  reduction,
} from '../../../bench/live/report-validation.mjs';
import { monitorHostMemory } from '../../../bench/live/host-memory.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runReport = (script, args) =>
  spawnSync(process.execPath, ['bench/live/' + script, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
const jsonFile = (dir, name, value) =>
  writeFile(join(dir, name), JSON.stringify(value));

test('follow-up report retains a campaign that produced no artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'incomplete-report-'));
  await jsonFile(dir, 'followup-plan.json', {
    scope: 'test',
    cases: [{ id: 'failed', seedOffset: 0 }],
  });
  await jsonFile(dir, 'followup-execution.json', [
    { id: 'failed', raw: null, exit: 1, auditExit: null, costExit: null },
  ]);
  await jsonFile(dir, 'loss-audit.json', {
    scenario: { usdPerMillion: { uncached: 10, cached: 1, output: 50 } },
    cases: [{ id: 'failed', costDifferenceUsd: 1 }],
  });
  const run = runReport('loss-followup-report.mjs', [dir]);
  expect(run.status).toBe(0);
  const result = JSON.parse(
    await readFile(join(dir, 'followup-summary.json'), 'utf8')
  );
  expect(result.planned).toBe(1);
  expect(result.complete).toBe(0);
  expect(result.costReductionCompletePairs).toBeNull();
  expect(result.cases[0].arms.proxy.estimatedUsd).toBeNull();
  expect(result.cases[0].arms.headroom.verdict).toBe('INCOMPLETE');
});

test('replay tools reject corpora containing no Responses requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'empty-replay-'));
  await mkdir(join(dir, 'json-1-proxy'));
  const capture = join(dir, 'json-1-proxy', 'requests.jsonl');
  await writeFile(
    capture,
    JSON.stringify({ path: '/messages', body: '{}' }) + '\n'
  );
  await jsonFile(
    dir,
    'results.json',
    ['proxy', 'headroom'].map((arm) => ({
      task: 'json',
      rep: 1,
      arm,
      usage: { input: 0, cached: 0, output: 0 },
    }))
  );
  for (const [script, args] of [
    ['cost-gap-audit.mjs', [dir, 'json', '1', join(dir, 'cost.json')]],
    ['response-cache-replay.mjs', [dir, join(dir, 'cache.json')]],
    [
      'sharing-profile-check.mjs',
      ['dist/proxy/responses.js', capture, join(dir, 'sharing.json')],
    ],
  ]) {
    const run = runReport(script, args);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('No matching Responses captures');
  }
});

test('performance report rejects an unexpected group with the correct total count', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'invalid-matrix-'));
  const records = [0, 1, 2].flatMap((round) =>
    ['proxy', 'headroom', 'control'].flatMap((arm) =>
      ['logs', 'json', 'code'].flatMap((task) =>
        ['repeated', 'unique'].map((mode) => ({
          round,
          arm,
          task,
          mode,
          samples: [{}],
        }))
      )
    )
  );
  records[0].task = 'unexpected';
  await jsonFile(dir, 'results.json', {
    complete: true,
    repetitions: 1,
    records,
  });
  const run = runReport('local-proxy-performance-report.mjs', [dir]);
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain('Incomplete local comparison');
});

test('a replacement or duplicate group cannot satisfy a complete matrix', () => {
  const dimensions = { round: [0, 1], arm: ['proxy', 'headroom'] };
  const rows = [0, 1].flatMap((round) =>
    dimensions.arm.map((arm) => ({ round, arm, samples: [{}] }))
  );
  expect(groupMatrix(rows, dimensions, 1)).toBe(true);
  expect(
    groupMatrix(
      [...rows.slice(0, 3), { ...rows[3], arm: 'unexpected' }],
      dimensions,
      1
    )
  ).toBe(false);
  expect(groupMatrix([...rows.slice(0, 3), rows[0]], dimensions, 1)).toBe(
    false
  );
  expect(groupMatrix(rows, dimensions, 2)).toBe(false);
});
test('audit identities and verdicts control reporting and pilot selection', () => {
  const rows = ['proxy', 'headroom'].map((arm) => ({
    task: 'json',
    rep: 1,
    arm,
    verdict: 'PASS',
  }));
  const audit = rows.map((r) => ({
    ...r,
    verdict: r.arm === 'proxy' ? 'FAIL' : 'PASS',
  }));
  expect(auditedPilot(rows, audit, { valid: true }).map((r) => r.arm)).toEqual([
    'headroom',
  ]);
  expect(auditedPilot(rows, audit, { valid: false })).toEqual([]);
  expect(() => matchAudits(rows, [audit[0], audit[0]])).toThrow();
  expect(() => matchAudits(rows, [audit[0]])).toThrow();
  expect(matchAudits(rows, [...audit].reverse())[0].verdict).toBe('FAIL');
});
test('zero baselines are explicit and invalid arithmetic is rejected', () => {
  expect(reduction(0, 0)).toBeNull();
  expect(reduction(2, 0)).toBeNull();
  expect(reduction(1, 2)).toBe(0.5);
  expect(() => reduction(Infinity, 2)).toThrow();
  expect(() => reduction(2, -1)).toThrow();
});
test('memory-monitor stderr is diagnostic while valid telemetry remains fresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-review-'));
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0);
  };
  const monitor = await monitorHostMemory(dir, {
    platform: 'win32',
    spawnProcess: () => {
      setTimeout(() => {
        child.stderr.write('transient diagnostic');
        child.stdout.write(
          JSON.stringify({
            at: new Date().toISOString(),
            committedBytes: 0,
            commitLimitBytes: 8 * 1024 ** 3,
            availablePhysicalBytes: 4 * 1024 ** 3,
          }) + '\n'
        );
      }, 10);
      return child;
    },
  });
  try {
    await expect(monitor.assertReady('attempt')).resolves.toBeUndefined();
  } finally {
    await monitor.stop();
  }
  expect(await readFile(join(dir, 'host-memory.jsonl'), 'utf8')).toContain(
    'transient diagnostic'
  );
  await expect(monitor.assertReady('after-exit')).rejects.toThrow('preflight');
});
