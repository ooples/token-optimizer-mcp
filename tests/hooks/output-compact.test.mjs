/**
 * Tool output compacted after the call, before the model reads it, with the
 * full output one Read away. Claude Code's PostToolUse updatedToolOutput.
 */
import { describe, test, expect, afterAll } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  compactText,
  compactToolResponse,
  foldOutput,
  isDenseLine,
  isReadLikeCommand,
  selectWithinBudget,
  OUTPUT_COMPACT_MIN_BYTES,
} from '../../hooks-core/output-compact.mjs';

const root = mkdtempSync(join(tmpdir(), 'output-compact-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The shape of the harness's CI logs: 2,400 passing lines, one failure, a summary. */
const ciLog = () => {
  const lines = ['============================= test session starts =============================', 'collected 2412 items'];
  for (let i = 0; i < 2400; i++) {
    lines.push(`pkgs/ledger/tests/test_${['batch', 'window', 'series'][i % 3]}_${i % 60}.py::test_case_${i} PASSED        [${String(Math.floor(i / 24)).padStart(3)}%]`);
    if (i === 1300)
      lines.push('pkgs/ledger/tests/test_core.py::test_round_up FAILED', '', '    def test_round_up():', '>       assert settle(10.239) == 10.24', 'E       assert 10.23 == 10.24', '', 'pkgs/ledger/tests/test_core.py:4: AssertionError');
  }
  lines.push('FAILED pkgs/ledger/tests/test_core.py::test_round_up - assert 10.23 == 10.24', '================ 1 failed, 2411 passed, 24 warnings in 312.44s ================');
  return lines.join('\n');
};

describe('folding and selection', () => {
  test('a 180 KB CI log keeps every failure line and the summary, in a few KB', () => {
    const log = ciLog();
    const out = compactText(log, { command: 'cat ci-logs/ledger.log | tail -n +1 && echo' });
    expect(out).not.toBeNull();
    for (const must of ['test_round_up FAILED', 'E       assert 10.23 == 10.24', 'AssertionError', '1 failed, 2411 passed'])
      expect(out.text).toContain(must);
    expect(Buffer.byteLength(out.text)).toBeLessThan(Buffer.byteLength(log) / 10);
  });

  test('repetitive lines fold to examples plus a count', () => {
    const { text, folded } = foldOutput(ciLog());
    expect(folded).toBeGreaterThan(2000);
    expect(text).toMatch(/\[… \d+ more lines like the above …\]/);
  });

  test('selection never drops a signal line while budget remains, and counts what it drops', () => {
    const body = [...Array(400).keys()].map((i) => (i === 200 ? 'Error: connection refused at db.ts:12' : `line ${i} ${'x'.repeat(60)}`)).join('\n');
    const { text, dropped } = selectWithinBudget(body, 3000);
    expect(text).toContain('Error: connection refused at db.ts:12');
    expect(dropped.length).toBeGreaterThan(300);
  });

  test('a dense machine-generated line is elided to its two ends', () => {
    const minified = 'var a=' + 'x'.repeat(5000) + ';';
    expect(isDenseLine(minified)).toBe(true);
    expect(isDenseLine('{"a": "' + 'x'.repeat(500) + '"}')).toBe(false);
    expect(foldOutput(minified).text.length).toBeLessThan(400);
  });
});

describe('what is left alone', () => {
  test('small output is untouched', () => {
    expect(compactText('x'.repeat(OUTPUT_COMPACT_MIN_BYTES - 1))).toBeNull();
  });

  test('a read-like command is byte-exact up to the read cap, and cut whole-line past it', () => {
    expect(isReadLikeCommand('cd src && cat util.py')).toBe(true);
    expect(isReadLikeCommand("sed -n '1,80p' core.py")).toBe(true);
    expect(isReadLikeCommand('git show HEAD:src/a.ts')).toBe(true);
    expect(isReadLikeCommand('cat a.log | grep ERROR')).toBe(false);
    const file = [...Array(500).keys()].map((i) => `    value_${i} = compute(${i})  # keep`).join('\n');
    expect(compactText(file, { command: 'cat core.py' })).toBeNull();
    const big = [...Array(2000).keys()].map((i) => `    value_${i} = compute(${i})  # keep`).join('\n');
    const out = compactText(big, { command: 'cat core.py' });
    expect(out.readLike).toBe(true);
    // Never folded: every kept line is an exact line of the file, in order.
    const kept = out.text.split('\n');
    expect(big.startsWith(kept.join('\n'))).toBe(true);
  });
});

describe('compactToolResponse', () => {
  test('keeps the Bash response shape and stores the full output where the notice says', () => {
    const dir = join(root, 'wiki');
    mkdirSync(dir, { recursive: true });
    const response = { stdout: ciLog(), stderr: '', interrupted: false, isImage: false, noOutputExpected: false };
    const replaced = compactToolResponse({ tool: 'Bash', input: { command: 'python -m pytest -q' }, response, dir });
    expect(Object.keys(replaced).sort()).toEqual(Object.keys(response).sort());
    expect(replaced.interrupted).toBe(false);
    const path = replaced.stdout.match(/full output: Read (\S+)\]$/)[1];
    expect(readFileSync(path, 'utf8')).toBe(response.stdout);
  });

  test('leaves images, small output and Read alone', () => {
    const dir = join(root, 'wiki2');
    expect(compactToolResponse({ tool: 'Bash', input: {}, response: { stdout: 'ok', stderr: '' }, dir })).toBeNull();
    expect(compactToolResponse({ tool: 'Bash', input: {}, response: { stdout: ciLog(), isImage: true }, dir })).toBeNull();
    expect(compactToolResponse({ tool: 'Read', input: {}, response: { type: 'text', file: { content: ciLog() } }, dir })).toBeNull();
  });
});

// THE WIRING: the packaged Claude Code PostToolUse entry returns updatedToolOutput.
describe('the Claude Code PostToolUse hook', () => {
  test('replaces a large Bash result and names the stored original', () => {
    const workspace = mkdtempSync(join(root, 'ws-'));
    mkdirSync(join(workspace, '.git'));
    const env = { ...process.env, TOKEN_OPTIMIZER_MODE: 'assist',
      TOKEN_OPTIMIZER_STATE_DIR: join(workspace, '.state'), TOKEN_OPTIMIZER_WIKI_DIR: join(workspace, '.wiki'),
      TOKEN_OPTIMIZER_SHARED_DIR: join(workspace, '.wiki'), TOKEN_OPTIMIZER_UCR_DIR: join(workspace, '.ucr') };
    const stdout = ciLog();
    const r = spawnSync(process.execPath, [join(process.cwd(), 'plugin', 'hooks', 'post-tool.mjs')], {
      cwd: workspace, env, encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: `oc-${Date.now()}`, cwd: workspace,
        tool_name: 'Bash', tool_input: { command: 'python -m pytest -q' },
        tool_response: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false } }),
    });
    const out = JSON.parse(r.stdout);
    const updated = out.hookSpecificOutput.updatedToolOutput;
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(updated.stdout).toContain('E       assert 10.23 == 10.24');
    expect(updated.stdout.length).toBeLessThan(stdout.length / 10);
    const path = updated.stdout.match(/full output: Read (\S+)\]$/)[1];
    expect(readFileSync(path, 'utf8')).toBe(stdout);
  });

  test('TOKEN_OPTIMIZER_OUTPUT_COMPACT=0 leaves the result alone', () => {
    const workspace = mkdtempSync(join(root, 'ws-'));
    mkdirSync(join(workspace, '.git'));
    const env = { ...process.env, TOKEN_OPTIMIZER_MODE: 'assist', TOKEN_OPTIMIZER_OUTPUT_COMPACT: '0',
      TOKEN_OPTIMIZER_STATE_DIR: join(workspace, '.state'), TOKEN_OPTIMIZER_WIKI_DIR: join(workspace, '.wiki') };
    const r = spawnSync(process.execPath, [join(process.cwd(), 'plugin', 'hooks', 'post-tool.mjs')], {
      cwd: workspace, env, encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: `oc0-${Date.now()}`, cwd: workspace,
        tool_name: 'Bash', tool_input: { command: 'python -m pytest -q' }, tool_response: { stdout: ciLog(), stderr: '' } }),
    });
    expect(r.stdout.includes('updatedToolOutput')).toBe(false);
  });
});
