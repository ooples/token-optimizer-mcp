import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadState, saveState } from '../../src/hooks-core/policy.mjs';
import { isVerificationCommand } from '../../src/hooks-core/verification.mjs';
import { verificationSucceeded } from '../../src/hooks-core/adapter.mjs';

const work = mkdtempSync(join(tmpdir(), 'subscription-review-'));
const prior = process.env.TOKEN_OPTIMIZER_STATE_DIR;
beforeAll(() => { process.env.TOKEN_OPTIMIZER_STATE_DIR = join(work, 'state'); });
afterAll(() => {
  if (prior === undefined) delete process.env.TOKEN_OPTIMIZER_STATE_DIR;
  else process.env.TOKEN_OPTIMIZER_STATE_DIR = prior;
  rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('verification and continuation fields survive stale concurrent state saves', () => {
  const session = 'state-merge';
  const stale = loadState(session);
  const current = loadState(session);
  Object.assign(current, { edits: 4, verifiedEdits: 4, verificationContinued: true, backlogContinuations: 3, nightlySweepContinued: true });
  saveState(session, current);
  saveState(session, stale);
  expect(loadState(session)).toMatchObject({ edits: 4, verifiedEdits: 4, verificationContinued: true, backlogContinuations: 3, nightlySweepContinued: true });
});

test.each(['pytest -v', 'go test -v ./...', 'cargo test -v', 'npx jest --verbose', 'npm test 2>&1', 'npm test &> results.log', 'npm test', 'npm run test:unit', 'dotnet build src/Library.csproj', 'cd project && pytest', 'npx vitest run', 'cargo test'])('recognizes verification runner %s', (command) => {
  expect(isVerificationCommand(command)).toBe(true);
});

test.each(['pytest -V', 'pytest -h', 'npx jest -v', 'npx vitest -v', 'npx tsc -v', 'npm test -v', 'npx jest --listTests', 'pytest --collect-only', 'npm test -- --help', 'npx tsc --showConfig', 'npm test 2>&1 &', 'echo npm test', 'cat tests/results.txt', 'test -f output.txt', 'npm test || echo ignored', 'npm test; echo done', 'npm test | cat', 'npm test &'])('rejects misleading verification command %s', (command) => {
  expect(isVerificationCommand(command)).toBe(false);
});

function post(command, exitCode, response) {
  const module = pathToFileURL(join(process.cwd(), 'src/hooks-core/adapter.mjs')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {run} from ${JSON.stringify(module)}; await run('codex','post-tool');`], {
    input: JSON.stringify({ session_id: 'actual-verification', cwd: work, tool_name: 'Bash', tool_input: { command }, tool_response: response ?? { stdout: exitCode ? 'FAIL' : 'PASS', exit_code: exitCode } }),
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, TOKEN_OPTIMIZER_MODE: 'assist', TOKEN_OPTIMIZER_HOLDOUT: '0', TOKEN_OPTIMIZER_HOME: join(work, 'home'), TOKEN_OPTIMIZER_WIKI_DIR: join(work, 'wiki'), TOKEN_OPTIMIZER_MAXIMIZE_SUBSCRIPTION: '0' },
  });
  expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
}

test('actual post-tool processes accept a passing test and reject failed or unrelated commands', () => {
  const state = loadState('actual-verification');
  state.edits = 2;
  saveState('actual-verification', state);
  post('npm test', 1);
  expect(loadState('actual-verification').verifiedEdits).toBe(0);
  post('echo npm test', 0);
  expect(loadState('actual-verification').verifiedEdits).toBe(0);
  for (const command of ['npm test || true', 'npm test; echo done', 'npm test | tee log']) {
    post(command, 0);
    expect(loadState('actual-verification').verifiedEdits).toBe(0);
  }
  post('npx jest --listTests', 0);
  expect(loadState('actual-verification').verifiedEdits).toBe(0);
  post('npm test', undefined, { stdout: 'Tests: 1 failed' });
  expect(loadState('actual-verification').verifiedEdits).toBe(0);
  post('npm test', 0, { stdout: 'FAIL', exit_code: 0, isError: true });
  expect(loadState('actual-verification').verifiedEdits).toBe(0);
  post('npm test 2>&1', 0);
  expect(loadState('actual-verification').verifiedEdits).toBe(2);
});

test.each([
  [{ tool_response: { stdout: 'Tests: 1 failed' } }, false],
  [{ tool_response: { status: 'completed', stdout: 'Tests: 1 failed' } }, false],
  [{ tool_response: { success: true } }, true],
  [{ tool_response: { status: 'passed' } }, true],
  [{ success: true, tool_response: { exit_code: 1 } }, false],
  [{ tool_response: { success: false, exit_code: 0 } }, false],
  [{ status: 'failed', tool_response: { exit_code: 0 } }, false],
  [{ postToolUse: { success: true } }, true],
  [{ tool_response: { exit_code: 0 }, postToolUse: { exitCode: 1 } }, false],
  [{ exit_code: 0, tool_response: { exitCode: '1' } }, false],
  [{ tool_response: { exit_code: 0, exitCode: 1 } }, false],
  [{ tool_response: { exit_code: 0 }, postToolUse: { exitCode: '0' } }, true],
])('verification requires affirmative, noncontradictory success: %j', (raw, expected) => {
  expect(verificationSucceeded(raw)).toBe(expected);
});

function stop(session, limit, explicit = true) {
  const module = pathToFileURL(join(process.cwd(), 'src/hooks-core/adapter.mjs')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {run} from ${JSON.stringify(module)}; await run('codex','stop');`], {
    input: JSON.stringify({ session_id: session, cwd: work }), encoding: 'utf8', windowsHide: true,
    env: { ...process.env, TOKEN_OPTIMIZER_MODE: 'assist', TOKEN_OPTIMIZER_HOLDOUT: '0', TOKEN_OPTIMIZER_HOME: join(work, 'home'), TOKEN_OPTIMIZER_WIKI_DIR: join(work, 'wiki'), TOKEN_OPTIMIZER_MAXIMIZE_SUBSCRIPTION: '1', TOKEN_OPTIMIZER_MAX_CONTINUATIONS: String(limit), TOKEN_OPTIMIZER_STOP_BACKLOG: explicit ? join(work, 'STOP_BACKLOG') : '' },
  });
  expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
  return child.stdout;
}

test('explicit zero disables backlog work and repository files cannot opt in', () => {
  writeFileSync(join(work, 'STOP_BACKLOG'), '- [ ] explicit queued task\n');
  expect(stop('zero-limit', 0)).not.toContain('explicit queued task');
  expect(loadState('zero-limit').backlogContinuations).toBe(0);
  expect(stop('implicit-backlog', 1, false)).not.toContain('explicit queued task');
  expect(loadState('implicit-backlog').backlogContinuations).toBe(0);
});

test('a configured backlog limit survives fresh Stop processes', () => {
  writeFileSync(join(work, 'STOP_BACKLOG'), '- [ ] explicit queued task\n');
  expect(stop('one-limit', 1)).toContain('explicit queued task');
  expect(stop('one-limit', 1)).not.toContain('explicit queued task');
  expect(loadState('one-limit').backlogContinuations).toBe(1);
});
