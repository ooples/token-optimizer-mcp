import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState } from '../../src/hooks-core/policy.mjs';
import { nextPacedContinuation, quotaWindowPath } from '../../src/hooks-core/quota-pacer.mjs';
import { boardFor, recordReadOnBoard } from '../../src/hooks-core/blackboard.mjs';
import { lineHunks } from '../../src/hooks-core/repeats.mjs';

const work = mkdtempSync(join(tmpdir(), 'quota-review-'));
const prior = process.env.TOKEN_OPTIMIZER_STATE_DIR;
beforeAll(() => { process.env.TOKEN_OPTIMIZER_STATE_DIR = join(work, 'state'); });
afterAll(() => {
  if (prior === undefined) delete process.env.TOKEN_OPTIMIZER_STATE_DIR;
  else process.env.TOKEN_OPTIMIZER_STATE_DIR = prior;
  rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('disabled pacing does not create the quota file', () => {
  expect(nextPacedContinuation({ cwd: work, state: {}, env: {} })).toBeNull();
  expect(existsSync(quotaWindowPath())).toBe(false);
});

test('unverified edits cause only one continuation across separate state loads', () => {
  const state = loadState('verify-once');
  state.edits = 1;
  saveState('verify-once', state);
  const env = { TOKEN_OPTIMIZER_MAXIMIZE_SUBSCRIPTION: '1' };
  const first = loadState('verify-once');
  expect(nextPacedContinuation({ cwd: work, state: first, env })).toContain('without a subsequent passing');
  saveState('verify-once', first);
  expect(nextPacedContinuation({ cwd: work, state: loadState('verify-once'), env })).toBeNull();
});

test('repository files cannot opt into tasks; explicitly configured relative queues can', () => {
  const repo = join(work, 'queued');
  mkdirSync(repo);
  writeFileSync(join(repo, 'STOP_BACKLOG'), '- [ ] Explicit task\n');
  mkdirSync(join(work, '.token-optimizer'));
  writeFileSync(join(work, 'STOP_BACKLOG'), '- [ ] Implicit task\n');
  writeFileSync(join(work, '.token-optimizer/repo-queue.json'), JSON.stringify({ repos: ['queued'] }));
  expect(nextPacedContinuation({ cwd: work, state: {}, env: { TOKEN_OPTIMIZER_MAXIMIZE_SUBSCRIPTION: '1' } })).toBeNull();
  const env = { TOKEN_OPTIMIZER_REPO_QUEUE: 'queued', TOKEN_OPTIMIZER_MAX_CONTINUATIONS: '1' };
  const state = loadState('queue-once');
  expect(nextPacedContinuation({ cwd: work, state, env })).toContain(join(repo, 'STOP_BACKLOG'));
  saveState('queue-once', state);
  expect(nextPacedContinuation({ cwd: work, state: loadState('queue-once'), env })).toBeNull();
  expect(nextPacedContinuation({ cwd: work, state: {}, env: { ...env, TOKEN_OPTIMIZER_MAX_CONTINUATIONS: '0' } })).toBeNull();
});

test('ranged file reads remain distinct and are invalidated after a working-tree edit', () => {
  const file = join(work, 'source.txt');
  writeFileSync(file, 'x'.repeat(1500));
  for (const offset of [1, 20]) {
    expect(recordReadOnBoard({ sessionId: 'range', agent: 'parent', filePath: file, offset, limit: 10, cwd: work, output: 'x'.repeat(1000) })).toBe(true);
  }
  const briefing = boardFor({ sessionId: 'range', agent: 'child' });
  expect(briefing).toContain('offset=1 limit=10');
  expect(briefing).toContain('offset=20 limit=10');
  appendFileSync(file, 'changed');
  expect(boardFor({ sessionId: 'range', agent: 'child' })).toBeNull();
});

test('timing normalization still reports changed compiler lines', () => {
  expect(lineHunks('test train=1.23s\nerror CS0001: before', 'test train=2.34s\nerror CS0001: after')).toEqual([
    { at: 2, added: ['error CS0001: after'], removed: 1 },
  ]);
});

test('repeat replacement follows content when file contains metadata only', async () => {
  const { repeatResponse } = await import('../../src/hooks-core/repeats.mjs');
  const response = { file: { filePath: 'source.txt' }, content: 'x'.repeat(1000) };
  const state = {};
  const args = { tool: 'Read', input: { file_path: 'source.txt' }, response, cwd: work, state };
  expect(repeatResponse({ ...args, call: 1 })).toBeNull();
  const replaced = repeatResponse({ ...args, call: 2 });
  expect(replaced.content).toContain('unchanged since your Read');
  expect(replaced.file).toEqual(response.file);
});
