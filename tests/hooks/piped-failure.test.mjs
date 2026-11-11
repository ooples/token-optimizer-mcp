/**
 * A runner that failed behind a filter exits 0, so the client records success.
 * piped-failure.mjs recognises it from three conditions that must all hold:
 * a masked pipeline, a runner as its first stage, and a runner's own failure
 * summary in the output.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failureInOutput, maskedRunner } from '../../src/hooks-core/piped-failure.mjs';
import { currentTurn, turnStats } from '../../src/hooks-core/loopguard.mjs';

describe('a masked exit status', () => {
  it.each([
    ['npm test 2>&1 | tail -20', true],
    ['npm.cmd test -- tests/a.test.ts 2>&1 | Select-Object -Last 5', true],
    ['dotnet build --no-restore 2>&1 | grep -E "error|Build"', true],
    ['cd app && npx jest | tee jest.log', true],
    ['FORCE_COLOR=0 pytest -q | tail -3', true],
    ['C:\\tools\\node.exe build.mjs | head', true],
  ])('%s hides the runner’s exit', (command, expected) => {
    expect(maskedRunner(command)).toBe(expected);
  });

  it.each([
    ['npm test', 'no pipe: the runner’s own exit reaches the client'],
    ['set -o pipefail; npm test | tail -5', 'pipefail passes the failure through'],
    ['cat notes.md | head -20', 'not a runner: the text is file content, not a run'],
    ['git log --oneline | head', 'not a runner'],
    ['npm test | node summarize.mjs', 'the last stage is not a filter'],
    ['node -e "console.log(1|2)"', 'the pipe is inside quotes'],
    [undefined, 'no command'],
  ])('%s is not masked (%s)', (command) => {
    expect(maskedRunner(command)).toBe(false);
  });
});

describe('a runner’s failure summary', () => {
  it.each([
    ['Tests:       2 failed, 10 passed, 12 total', 'jest'],
    ['Test Suites: 1 failed, 40 passed, 41 total', 'jest-suites'],
    [' Tests  3 failed | 9 passed (12)', 'vitest'],
    ['===== 2 failed, 31 passed in 4.12s =====', 'pytest'],
    ['FAILED tests/test_api.py::test_login - AssertionError', 'pytest-failed'],
    ["src/a.ts(3,7): error TS2322: Type 'string' is not assignable", 'tsc'],
    ['npm ERR! code ELIFECYCLE', 'npm'],
    ['Build FAILED.', 'msbuild'],
    ['    1 Error(s)', 'msbuild-errors'],
    ['test result: FAILED. 3 passed; 1 failed', 'cargo-test'],
    ['--- FAIL: TestParse (0.00s)', 'go-test'],
    ['Traceback (most recent call last):\n  File "x.py", line 1', 'traceback'],
    ['make: *** [Makefile:12: all] Error 2', 'make'],
    ['\u2716 3 problems (2 errors, 1 warning)', 'eslint'],
  ])('%s is a %s failure', (output, signature) => {
    expect(failureInOutput(`noise before\n${output}\nnoise after`)?.signature).toBe(signature);
  });

  it.each([
    'Tests:       12 passed, 12 total',
    '    0 Error(s)',
    '\u2716 3 problems (0 errors, 3 warnings)',
    '===== 31 passed in 4.12s =====',
    'error handling refactored; all green',
    '',
  ])('%s is not a failure', (output) => {
    expect(failureInOutput(output)).toBeNull();
  });

  it('returns the summary line, which keys the repeat', () => {
    expect(failureInOutput('PASS a\nTests:       1 failed, 3 passed, 4 total\nTime: 2s')).toEqual({
      signature: 'jest',
      line: 'Tests:       1 failed, 3 passed, 4 total',
    });
  });

});

describe('the loop guard sees a red run behind a pipe', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const transcript = (rows) => {
    const dir = mkdtempSync(join(tmpdir(), 'piped-'));
    dirs.push(dir);
    const path = join(dir, 't.jsonl');
    writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return path;
  };
  const prompt = { type: 'user', uuid: 'u1', message: { role: 'user', content: 'fix the tests' } };
  const use = (id, command) => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  });
  const result = (id, content) => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });

  it('counts the same masked failure, run three times, as one repeating failure', () => {
    const red = 'PASS a.test.ts\nTests:       1 failed, 11 passed, 12 total\nTime: 3s';
    const path = transcript([
      prompt,
      use('a', 'npm test 2>&1 | tail -5'),
      result('a', red),
      use('b', 'npm test 2>&1 | tail -5'),
      result('b', red.replace('3s', '4s')),
      use('c', 'npm test 2>&1 | tail -5'),
      result('c', red),
    ]);
    const { calls } = currentTurn(path);
    expect(calls.map((c) => c.ok)).toEqual([false, false, false]);
    const stats = turnStats(calls);
    expect(stats.failures).toBe(3);
    expect(stats.top.count).toBe(3);
  });

  it('needs both halves: a summary read from a file is not a run failing', () => {
    const red = 'Tests:       1 failed, 3 passed, 4 total';
    const path = transcript([prompt, use('a', 'cat jest.log | tail -5'), result('a', red), use('b', 'npm test'), result('b', red)]);
    expect(currentTurn(path).calls.map((c) => c.ok)).toEqual([true, true]);
  });

  it('still reads a passing run behind a pipe as a success', () => {
    const path = transcript([prompt, use('a', 'npm test 2>&1 | tail -5'), result('a', 'Tests:       12 passed, 12 total')]);
    expect(currentTurn(path).calls.map((c) => c.ok)).toEqual([true]);
  });
});
