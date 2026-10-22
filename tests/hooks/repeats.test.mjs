import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lineHunks, repeatKey, repeatResponse, REPEAT_WINDOW } from '../../hooks-core/repeats.mjs';

const pytest = (failing) =>
  [
    '============================= test session starts =============================',
    ...Array.from({ length: 30 }, (_, i) => `pkgs/case_${i}.py ${i < failing ? 'F' : '.'}`),
    `========================= ${failing} failed, ${30 - failing} passed =========================`,
  ].join('\n');
const bash = (stdout) => ({ stdout, stderr: '', interrupted: false, isImage: false });
const run = (state, call, stdout, command = 'python -m pytest -q') =>
  repeatResponse({ tool: 'Bash', input: { command }, response: bash(stdout), cwd: '/w', call, state, store: () => '/art/x.txt' });

describe('diff-only repeats', () => {
  test('a command whose output did not change is one line naming the earlier call', () => {
    const state = {};
    expect(run(state, 3, pytest(2))).toBeNull();
    const out = run(state, 5, pytest(2));
    expect(out.stdout).toMatch(/^\[identical to the output of this same command at your call #3/);
    expect(out.stdout).toContain('/art/x.txt');
    expect(out.stdout.length).toBeLessThan(200);
  });

  test('a command whose output changed sends only what changed', () => {
    const state = {};
    run(state, 1, pytest(2));
    const out = run(state, 3, pytest(1));
    expect(out.stdout).toMatch(/^\[changed since this command's output at your call #1/);
    expect(out.stdout).toContain('pkgs/case_1.py .');
    expect(out.stdout).toContain('1 failed, 29 passed');
    expect(out.stdout).not.toContain('pkgs/case_20.py');
    expect(out.stdout.length).toBeLessThan(pytest(1).length / 2);
  });

  test('never points at a result that may have left the context', () => {
    const state = {};
    run(state, 1, pytest(2));
    expect(run(state, 1 + REPEAT_WINDOW + 1, pytest(2))).toBeNull();
  });

  test('a different command, directory or small output passes through', () => {
    const state = {};
    run(state, 1, pytest(2));
    expect(run(state, 2, pytest(2), 'python -m pytest -q pkgs/pricing')).toBeNull();
    expect(repeatKey('Bash', { command: 'ls' }, '/a')).not.toBe(repeatKey('Bash', { command: 'ls' }, '/b'));
    run(state, 3, 'ok');
    expect(run(state, 4, 'ok')).toBeNull();
  });

  test('an unchanged re-read is a line; a changed one is passed through whole, since edits are built from it', () => {
    const state = {};
    const file = (content) => ({ type: 'text', file: { filePath: '/w/a.py', content, numLines: content.split('\n').length, startLine: 1, totalLines: 40 } });
    const body = Array.from({ length: 40 }, (_, i) => `line ${i} of the module source`).join('\n');
    const read = (call, content) => repeatResponse({ tool: 'Read', input: { file_path: '/w/a.py' }, response: file(content), call, state });
    expect(read(1, body)).toBeNull();
    expect(read(2, body).file.content).toMatch(/^\[unchanged since your Read of this file at call #1: the same 40 lines/);
    expect(read(3, body.replace('line 7', 'line seven'))).toBeNull();
  });

  test('lineHunks finds separate changes far apart', () => {
    expect(lineHunks(['a', 'b', 'c', 'd', 'e'].join('\n'), ['a', 'B', 'c', 'd', 'E'].join('\n'))).toEqual([
      { at: 2, added: ['B'], removed: 1 },
      { at: 5, added: ['E'], removed: 1 },
    ]);
  });
});

// THE WIRING: the packaged PostToolUse hook, two runs of one command, state kept between them.
describe('through the Claude Code PostToolUse hook', () => {
  const hook = (workspace, sessionId, stdout, extra = {}) =>
    spawnSync(process.execPath, [join(process.cwd(), 'plugin', 'hooks', 'post-tool.mjs')], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        TOKEN_OPTIMIZER_MODE: 'assist',
        TOKEN_OPTIMIZER_STATE_DIR: join(workspace, '.state'),
        TOKEN_OPTIMIZER_WIKI_DIR: join(workspace, '.wiki'),
        TOKEN_OPTIMIZER_SHARED_DIR: join(workspace, '.wiki'),
        TOKEN_OPTIMIZER_UCR_DIR: join(workspace, '.ucr'),
        ...extra,
      },
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        cwd: workspace,
        tool_name: 'Bash',
        tool_input: { command: 'python -m pytest -q' },
        tool_response: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
      }),
    });
  const updated = (r) => (r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput?.updatedToolOutput : undefined);

  test('the second identical run comes back as one line', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'repeats-'));
    mkdirSync(join(workspace, '.git'));
    const session = `rp-${Date.now()}`;
    hook(workspace, session, pytest(2));
    const second = updated(hook(workspace, session, pytest(2)));
    expect(second.stdout).toMatch(/^\[identical to the output of this same command/);
    rmSync(workspace, { recursive: true, force: true });
  });

  test('TOKEN_OPTIMIZER_REPEATS=0 sends it in full', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'repeats-'));
    mkdirSync(join(workspace, '.git'));
    const session = `rp0-${Date.now()}`;
    const off = { TOKEN_OPTIMIZER_REPEATS: '0' };
    hook(workspace, session, pytest(2), off);
    const r = hook(workspace, session, pytest(2), off);
    // The hook ran, and the model gets the original output untouched.
    expect(r.status).toBe(0);
    expect(updated(r)?.stdout ?? pytest(2)).toBe(pytest(2));
    rmSync(workspace, { recursive: true, force: true });
  });
});
