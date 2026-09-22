import { it, expect } from '@jest/globals';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it('isolates native home resolution in the worker and its child processes', () => {
  const expected = process.env.TOKEN_OPTIMIZER_TEST_HOME;
  expect(expected).toBeTruthy();
  expect(resolve(homedir())).toBe(resolve(expected));
  const childHome = execFileSync(
    process.execPath,
    ['-e', "process.stdout.write(require('node:os').homedir())"],
    {
      env: process.env,
      encoding: 'utf8',
      windowsHide: true,
    }
  );
  expect(resolve(childHome)).toBe(resolve(expected));
});
