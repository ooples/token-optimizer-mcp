import { afterAll, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupGrepByFile } from '../../hooks-core/output-compact.mjs';

const root = mkdtempSync(join(tmpdir(), 'grep-group-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const hits = (path, from, n) =>
  Array.from({ length: n }, (_, i) => `${path}:${from + i}:  const value${i} = compute(${i}); // matched line`);

describe('Grep results grouped by file', () => {
  test('states each path once and keeps every line number and line verbatim', () => {
    const a = 'src\\tools\\file-operations\\smart-grep.ts';
    const b = 'C:\\repo\\src\\proxy\\server.ts';
    const text = [...hits(a, 10, 12), ...hits(b, 200, 10)].join('\n');
    const out = groupGrepByFile(text);
    expect(out.split('\n').filter((l) => l === a)).toHaveLength(1);
    expect(out.split('\n').filter((l) => l === b)).toHaveLength(1);
    for (const line of text.split('\n')) {
      const path = line.startsWith(a) ? a : b;
      expect(out).toContain(line.slice(path.length + 1));
    }
    expect(out.length).toBeLessThan(text.length * 0.8);
  });

  test('context lines and separators stay with their file; a path with -N- in it is never split', () => {
    const p = 'docs/release-12-notes.md';
    const text = [
      `${p}-3-before`,
      `${p}:4:match one ${'x'.repeat(60)}`,
      `${p}-5-after`,
      '--',
      `${p}-9-before again`,
      `${p}:10:match two ${'y'.repeat(60)}`,
      ...hits(p, 20, 14),
    ].join('\n');
    const out = groupGrepByFile(text).split('\n');
    // Before the first match the path is not yet known: verbatim.
    expect(out).toContain(`${p}-3-before`);
    expect(out).toContain('5-after');
    expect(out).toContain('--');
    expect(out).toContain('9-before again');
    expect(out).not.toContain('docs/release');
  });

  test('a small or ungroupable result is left alone', () => {
    expect(groupGrepByFile('a.ts:1:x')).toBeNull();
    expect(groupGrepByFile(Array.from({ length: 40 }, (_, i) => `f${i}.ts:1:${'z'.repeat(40)}`).join('\n'))).toBeNull();
  });
});

// THE WIRING: the packaged PostToolUse hook, on a Claude Code Grep result.
describe('through the Claude Code PostToolUse hook', () => {
  test('a content-mode Grep result comes back grouped', () => {
    const workspace = mkdtempSync(join(root, 'ws-'));
    mkdirSync(join(workspace, '.git'));
    const content = [...hits('src/a.ts', 1, 15), ...hits('src/b.ts', 40, 15)].join('\n');
    const r = spawnSync(process.execPath, [join(process.cwd(), 'plugin', 'hooks', 'post-tool.mjs')], {
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
      },
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: `gg-${Date.now()}`,
        cwd: workspace,
        tool_name: 'Grep',
        tool_input: { pattern: 'compute', output_mode: 'content' },
        tool_response: { mode: 'content', numFiles: 2, filenames: [], content, numLines: 30 },
      }),
    });
    const updated = JSON.parse(r.stdout).hookSpecificOutput?.updatedToolOutput;
    expect(updated.content.split('\n')).toContain('src/a.ts');
    expect(updated.content).toContain('1:  const value0 = compute(0); // matched line');
    expect(updated.content.length).toBeLessThan(content.length * 0.9);
  });
});
