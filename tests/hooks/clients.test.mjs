/**
 * Cross-client tests.
 *
 * The claim these defend is the one most likely to rot: that every client
 * integration runs the SAME decision engine, and that each one enforces exactly
 * as much as its protocol actually permits -- no more. A client advertised as
 * enforcing that silently only advises is a promise a user discovers is false
 * on their first large read.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalizeTool, normalizePayload } from '../../hooks-core/decide.mjs';
import { CLIENTS } from '../../hooks-core/adapter.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let workspace;
let big;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'to-clients-'));
  big = join(workspace, 'big.ts');
  writeFileSync(big, 'x'.repeat(80_000));
});

afterAll(() => rmSync(workspace, { recursive: true, force: true }));

function runEntry(relativePath, payload, env = {}) {
  const result = spawnSync(process.execPath, [join(ROOT, relativePath)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (!result.stdout.trim()) return { decision: 'allow', reason: '' };
  const parsed = JSON.parse(result.stdout);
  const out = parsed.hookSpecificOutput || parsed;
  return {
    decision: parsed.decision || out.permissionDecision || (out.additionalContext ? 'advise' : 'allow'),
    reason: parsed.reason || out.permissionDecisionReason || out.additionalContext || '',
  };
}

describe('tool names normalize across clients', () => {
  test.each([
    ['read_file', 'Read'], ['view_file', 'Read'], ['open_file', 'Read'],
    ['search_file_content', 'Grep'], ['grep_search', 'Grep'],
    ['find_files', 'Glob'], ['glob_file_search', 'Glob'],
    ['apply_patch', 'Edit'], ['search_replace', 'Edit'],
    ['write_file', 'Write'], ['run_terminal_cmd', 'Bash'],
    ['PowerShell', 'Bash'], ['pwsh', 'Bash'],
  ])('%s -> %s', (alias, canonical) => {
    expect(normalizeTool(alias)).toBe(canonical);
  });

  test('an unknown tool is ignored rather than guessed at', () => {
    expect(normalizeTool('send_email')).toBeNull();
  });
});

describe('payload shapes normalize across clients', () => {
  test('Gemini-style absolute_path and start_line are understood', () => {
    const p = normalizePayload({
      tool: 'read_file',
      args: { absolute_path: '/tmp/x.ts', start_line: 10, end_line: 40 },
      sessionId: 's1',
    });
    expect(p.tool_name).toBe('Read');
    expect(p.tool_input.file_path).toBe('/tmp/x.ts');
    // Paging must survive normalization -- a paged read is already bounded and
    // must not be re-routed into an unbounded one.
    expect(p.tool_input.offset).toBe(10);
  });

  test('Cursor-style target_file is understood', () => {
    expect(normalizePayload({ tool: 'read_file', args: { target_file: '/tmp/y.ts' } })
      .tool_input.file_path).toBe('/tmp/y.ts');
  });
});

describe('enforcement matches protocol capability, exactly', () => {
  test('Codex has a pre-tool veto, so it denies', () => {
    const r = runEntry('integrations/codex/hooks/pre-tool.mjs', {
      session_id: 'codex-1', tool_name: 'read_file', tool_input: { path: big },
    });
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('smart_read');
  });

  test('Gemini BeforeTool denies before execution using its top-level schema', () => {
    const r = runEntry('integrations/gemini/hooks/pre-tool.mjs', {
      session_id: 'gem-1', tool: 'read_file', args: { absolute_path: big },
    });
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('smart_read');
  });

  test('Qwen PreToolUse denies before execution', () => {
    const r = runEntry('integrations/qwen/hooks/pre-tool.mjs', {
      session_id: 'qwen-1', tool_name: 'read_file', tool_input: { file_path: big },
    });
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('smart_read');
  });

  test('Copilot parses string toolArgs and denies before execution', () => {
    const r = runEntry('integrations/copilot/.github/hooks/pre-tool.mjs', {
      sessionId: 'copilot-1', toolName: 'view', toolArgs: JSON.stringify({ path: big }),
    });
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('smart_read');
  });

  test('every client declares its capability explicitly', () => {
    for (const [name, capability] of Object.entries(CLIENTS)) {
      expect(typeof capability.canDeny).toBe('boolean');
      // A client that can deny must declare the protocol shape it emits.
      if (capability.canDeny) expect(capability.denyStyle).toBeTruthy();
    }
  });
});

describe('the vendored core stays identical to its source', () => {
  test('sync check passes', () => {
    // Vendored copies are how each client gets the core into the directory it
    // executes from. Drift there is the exact failure this replaced.
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-hook-core.mjs'), '--check'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
  });
});
