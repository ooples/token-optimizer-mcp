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
  isBuildOrTestCommand,
  isShellSearchCommand,
  BUILD_LOG_MIN_BYTES,
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

describe('a read is judged by the stage that produces the output', () => {
  test('a search, a log or a test run piped into head/tail is not a file read', () => {
    for (const command of [
      'grep -rn TODO src | head -200',
      'git log --oneline | head -100',
      'dotnet test 2>&1 | tail -60',
      'cd repo && git grep -n Foo | head -n 300',
      'Select-String -Path src\\*.cs -Pattern Foo | Select-Object -First 200',
    ])
      expect(isReadLikeCommand(command)).toBe(false);
  });

  test('a read narrowed to a line range is still a read', () => {
    for (const command of [
      'cat src/a.ts | head -50',
      "sed -n '1,80p' core.py | nl",
      'Get-Content src\\A.cs | Select-Object -Skip 100 -First 80',
      '(Get-Content src\\A.cs)[10..50]',
      'cd src; Get-Content a.txt',
      'git show HEAD:src/a.ts | head -40',
      'Get-Content src\\A.cs | Select-Object -Index (10..20)',
      'type notes.txt | more',
    ])
      expect(isReadLikeCommand(command)).toBe(true);
  });

  test('a multi-line command is judged by its last line, CRLF or LF, continuations joined', () => {
    for (const command of [
      'cd C:\\repo\nGet-Content src\\A.cs',
      'cd /repo\r\ncat src/a.ts',
      '$p = "src\\A.cs"\r\nGet-Content $p |\r\n  Select-Object -First 80',
      'Get-Content src\\A.cs `\n  | Select-Object -Skip 10',
    ])
      expect(isReadLikeCommand(command)).toBe(true);
    for (const command of ['cat a.ts\ndotnet test', 'cd /repo\r\ngrep -rn x src | head -50'])
      expect(isReadLikeCommand(command)).toBe(false);
  });

  test('a multi-line read keeps its exact text where a log would be folded', () => {
    const source = Array.from({ length: 300 }, (_, i) => `    var x${i} = Compute(${i});`).join('\n');
    expect(compactText(source, { command: 'cd C:\\repo\nGet-Content src\\A.cs' })).toBeNull();
    expect(compactText(source, { command: 'cd C:\\repo\nGet-Process' })).not.toBeNull();
  });

  test('git show of a commit prints a diff, not a file', () => {
    expect(isReadLikeCommand('git show HEAD~2')).toBe(false);
    expect(isReadLikeCommand('git show --stat abc123')).toBe(false);
    expect(isReadLikeCommand('git show abc123:src/a.ts')).toBe(true);
    expect(isReadLikeCommand('git cat-file -p HEAD:src/a.ts')).toBe(true);
  });

  test('an 8 KB search piped into head is compacted; the same bytes from cat are not', () => {
    const hits = [...Array(160).keys()].map((i) => `src/mod${i % 9}/file${i}.ts:${i + 1}:  const v${i} = compute(${i}); // TODO`).join('\n');
    expect(Buffer.byteLength(hits)).toBeGreaterThan(OUTPUT_COMPACT_MIN_BYTES);
    expect(compactText(hits, { command: 'grep -rn TODO src | head -200' })).not.toBeNull();
    expect(compactText(hits, { command: 'cat notes.txt | head -200' })).toBeNull();
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

/** A 2-6 KB MSBuild run: restore/compile progress around its errors and summary. */
const smallBuildLog = (errors = 1) => {
  const lines = ['  Determining projects to restore...', '  All projects are up-to-date for restore.'];
  for (let i = 0; i < 40; i++) lines.push(`  AiDotNet.Module${i} -> C:\\repo\\src\\Module${i}\\bin\\Debug\\net8.0\\AiDotNet.Module${i}.dll`);
  for (let e = 0; e < errors; e++)
    lines.push(`C:\\repo\\src\\Layers\\Dense${e}.cs(41,17): error CS0103: The name 'weights${e}' does not exist in the current context [C:\\repo\\src\\AiDotNet.csproj]`);
  lines.push('', 'Build FAILED.', '', '    0 Warning(s)', `    ${errors} Error(s)`, '', 'Time Elapsed 00:00:41.27');
  return lines.join('\n');
};

describe('build and test logs are compacted from 2 KB, around their verdict', () => {
  test('recognises build/test commands in any statement, and nothing else', () => {
    for (const c of ['dotnet build src/A.csproj 2>&1 | tail -60', 'cd repo && npm test', 'FOO=1 npm test', './gradlew build', 'git status && make', 'npm.cmd run build', 'npx jest tests/a', 'python -m pytest -q', 'pwsh -File C:\\b\\build.ps1 -Project x', 'cargo test'])
      expect(isBuildOrTestCommand(c)).toBe(true);
    for (const c of ['git status', 'cat build.log', 'grep -rn dotnet .', 'ls testdata', 'grep make notes.txt', 'cat a.txt | grep jest', 'git commit -m "fix: make it work"', 'echo make sure', 'grep -n x build.ps1', 'rg -n tsc src'])
      expect(isBuildOrTestCommand(c)).toBe(false);
  });

  test('a search under the general floor is never folded for naming a build word', () => {
    const notes = Array.from({ length: 70 }, (_, i) => `note ${i}: remember to make the release notes mention item ${i}`).join('\n');
    for (const command of ['grep make notes.txt', 'cat notes.txt | grep jest', 'git log --oneline | grep tsc'])
      expect(compactText(notes, { command })).toBeNull();
  });

  test('a 4 KB build log keeps every error and the summary, in under half the size', () => {
    const log = smallBuildLog();
    expect(Buffer.byteLength(log)).toBeGreaterThan(BUILD_LOG_MIN_BYTES);
    expect(Buffer.byteLength(log)).toBeLessThan(OUTPUT_COMPACT_MIN_BYTES);
    const out = compactText(log, { command: 'dotnet build src/AiDotNet.csproj' });
    expect(out).not.toBeNull();
    for (const must of ["error CS0103: The name 'weights0'", 'Build FAILED.', '1 Error(s)', 'Time Elapsed'])
      expect(out.text).toContain(must);
    expect(Buffer.byteLength(out.text)).toBeLessThan(Buffer.byteLength(log) / 2);
  });

  test('no error line is dropped however many there are, below the general floor', () => {
    const log = smallBuildLog(12);
    expect(Buffer.byteLength(log)).toBeLessThan(OUTPUT_COMPACT_MIN_BYTES);
    const out = compactText(log, { command: 'dotnet build' });
    const kept = out ? out.text : log;
    for (let e = 0; e < 12; e++) expect(kept).toContain(`'weights${e}' does not exist`);
  });

  test('the same 4 KB from a command that is not a build stays whole', () => {
    expect(compactText(smallBuildLog(), { command: 'cat build-output.txt' })).toBeNull();
    expect(compactText(smallBuildLog(), { command: 'git log -p' })).toBeNull();
  });
});

describe("shell searches get the Grep tool's lossless grouping", () => {
  const hits = [
    ...[...Array(30).keys()].map((i) => `src/AiDotNet/NeuralNetworks/Layers/DenseLayer.cs:${100 + i}:    var w${i} = Engine.MatMul(x, weights);`),
    ...[...Array(20).keys()].map((i) => `src/AiDotNet/NeuralNetworks/Layers/ConvLayer.cs:${10 + i}:    var y${i} = Engine.Conv2D(x, kernel);`),
  ].join('\n');

  test('recognises shell search commands', () => {
    for (const c of [
      'grep -rn Engine src',
      'cd repo && git grep -n MatMul | head -200',
      'rg -n Conv2D',
      'Select-String -Path src\\*.cs -Pattern Engine',
      'git -C repo grep -n x',
      'Get-ChildItem -Recurse -Filter *.cs | Select-String Engine',
      'git ls-files | xargs -r grep -n Engine',
      'cd C:\\repo\r\nrg -n Conv2D',
    ])
      expect(isShellSearchCommand(c)).toBe(true);
    for (const c of ['git log --grep fix', 'cat a.txt', 'dotnet test', 'echo grep'])
      expect(isShellSearchCommand(c)).toBe(false);
  });

  test('a 4 KB grep -rn result is grouped by file with every line number and line kept', () => {
    const out = compactToolResponse({ tool: 'Bash', input: { command: 'grep -rn Engine src | head -100' }, response: { stdout: hits, stderr: '' }, dir: root });
    expect(out).not.toBeNull();
    expect(out.stdout.length).toBeLessThan(hits.length * 0.75);
    expect(out.stdout.split('\n').filter((l) => l === 'src/AiDotNet/NeuralNetworks/Layers/DenseLayer.cs')).toHaveLength(1);
    for (const line of hits.split('\n')) expect(out.stdout).toContain(line.slice(line.indexOf('.cs:') + 4));
  });

  test('the same bytes from a command that is not a search are left alone', () => {
    expect(compactToolResponse({ tool: 'Bash', input: { command: 'cat hits.txt' }, response: { stdout: hits, stderr: '' }, dir: root })).toBeNull();
  });
});
