/**
 * A search whose output is already bounded is not an unbounded search.
 *
 * Observed live on 2026-10-20, in one session: `grep -rn x . | head -20` and
 * `grep -rn x .github | head -3` were each routed as "Recursive shell searches
 * return unbounded output", and a built-in Grep with head_limit 20 was redirected
 * to smart_grep. Under assist each is an advisory on every call; under enforce
 * each is a refused turn -- and turns are the measured cost.
 */

import { describe, expect, test } from '@jest/globals';
import { decide, isRecursiveSearch, searchOutputBounded } from '../../hooks-core/decide.mjs';

const TOOLS = new Set(['smart_read', 'smart_grep', 'smart_glob']);
const verdict = (tool_name, tool_input) =>
  decide({ tool_name, tool_input, cwd: process.cwd(), session_id: 'bounded' }, {}, TOOLS);

describe('a recursive search piped into a bound', () => {
  test.each([
    ['head with a count', 'grep -rn gcServer --include=*.yml . | head -20'],
    ['head after cd', 'cd /repo && grep -rn "DOTNET_gcServer" --include=*.ps1 .github | head -3'],
    ['tail', 'rg needle | tail -n 5'],
    ['through a filter, then head', 'grep -rn TODO src | sort | uniq | head'],
    ['a count', 'grep -rn TODO src | wc -l'],
    ['grep -c downstream', 'grep -rn TODO src | grep -c fixme'],
    ['Select-Object -First', 'Get-ChildItem -Recurse | Select-String foo | Select-Object -First 10'],
    // Review on #512: stderr merged before the bound is still bounded.
    ['2>&1 before head', 'grep -rn x . 2>&1 | head -20'],
    ['|& into head', 'grep -rn x . |& head -5'],
    ['tail with a plain count', 'grep -rn x . | tail -n 5'],
  ])('%s is bounded and not routed', (_label, command) => {
    expect(isRecursiveSearch(command)).toBe(true);
    expect(searchOutputBounded(command)).toBe(true);
    expect(verdict('Bash', { command })).toBeNull();
  });
});

describe('what does not bound a search', () => {
  test.each([
    ['nothing downstream', 'grep -rn TODO src'],
    ['a filter that passes everything through', 'grep -rn TODO src | sort'],
    ['head in a LATER command, not the pipeline', 'grep -rn TODO src; head notes.txt'],
    ['head after ||', 'grep -rn TODO src || head notes.txt'],
    ['one bounded search beside an unbounded one', 'grep -rn a src | head; grep -rn b lib'],
    ['a quoted pipe is not a pipe', 'grep -rn "a | head" src'],
    // Review on #512: these print almost everything.
    ['tail -n +N', 'grep -rn x . | tail -n +2'],
    ['tail +N', 'grep -rn x . | tail +2'],
    ['tail --lines=+N', 'grep -rn x . | tail --lines=+2'],
    ['head -n -N', 'grep -rn x . | head -n -1'],
    ['head --lines=-N', 'grep -rn x . | head --lines=-1'],
  ])('%s is still routed', (_label, command) => {
    expect(searchOutputBounded(command)).toBe(false);
    expect(verdict('Bash', { command })?.reason).toMatch(/smart_grep/);
  });

  test('a command with no recursive search is not "bounded"', () => {
    expect(searchOutputBounded('ls | head')).toBe(false);
  });
});

describe('the built-in Grep with an explicit small head_limit', () => {
  const input = { pattern: 'gcServer|GCHeapHardLimit', path: '/repo', glob: '*.{ps1,yml}', output_mode: 'content' };

  test('a limit of 100 lines or fewer is already the bound', () => {
    expect(verdict('Grep', { ...input, head_limit: 20 })).toBeNull();
    expect(verdict('Grep', { ...input, head_limit: 100 })).toBeNull();
  });

  test('no limit, a large one, or a nonsense one is still routed', () => {
    expect(verdict('Grep', input)?.reason).toMatch(/smart_grep/);
    expect(verdict('Grep', { ...input, head_limit: 500 })?.reason).toMatch(/smart_grep/);
    expect(verdict('Grep', { ...input, head_limit: 0 })?.reason).toMatch(/smart_grep/);
    expect(verdict('Grep', { ...input, head_limit: 'all' })?.reason).toMatch(/smart_grep/);
  });
});
