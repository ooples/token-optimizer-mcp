/**
 * --verbs prints a program name and nothing else: never an argument, a path or
 * an assignment, so the report stays inside the tool's anonymisation promise.
 */

import { describe, expect, test } from '@jest/globals';
import { programName } from '../../bench/field/multi-agent-waste.mjs';

describe('programName', () => {
  test.each([
    ['dotnet build -c Release', 'dotnet'],
    ['npm.cmd run test', 'npm.cmd'],
    ['export API_TOKEN=abc123', 'export'],
    ['API_TOKEN=abc123 make', '(other)'],
    ['node /home/user/app.js', 'node'],
    ['/home/user/bin/tool --flag', '(other)'],
    ['./script.sh', '(other)'],
  ])('%j -> %j', (cmd, expected) => {
    expect(programName(cmd)).toBe(expected);
  });
});
