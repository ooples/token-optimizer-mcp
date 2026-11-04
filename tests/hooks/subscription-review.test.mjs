import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadState, saveState } from '../../hooks-core/policy.mjs';
import { isVerificationCommand } from '../../hooks-core/verification.mjs';

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

test.each(['npm test', 'npm run test:unit', 'dotnet build src/Library.csproj', 'cd project && pytest', 'npx vitest run', 'cargo test'])('recognizes verification runner %s', (command) => {
  expect(isVerificationCommand(command)).toBe(true);
});

test.each(['echo npm test', 'cat tests/results.txt', 'test -f output.txt', 'npm test || echo ignored', 'npm test; echo done', 'npm test | cat', 'npm test &'])('rejects misleading verification command %s', (command) => {
  expect(isVerificationCommand(command)).toBe(false);
});

function post(command, exitCode) {
  const module = pathToFileURL(join(process.cwd(), 'hooks-core/adapter.mjs')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {run} from ${JSON.stringify(module)}; await run('codex','post-tool');`], {
    input: JSON.stringify({ session_id: 'actual-verification', cwd: work, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: exitCode ? 'FAIL' : 'PASS', exit_code: exitCode } }),
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
  post('npm test', 0);
  expect(loadState('actual-verification').verifiedEdits).toBe(2);
});
