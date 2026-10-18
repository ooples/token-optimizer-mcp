/**
 * The deferred recording guidance (#357, M5) reaches only the sessions that can
 * receive it and are meant to.
 *
 * Delivery is once per session, so the flag that says "delivered" must not be
 * spent where nothing is delivered: an experiment arm with harvest off gets no
 * recording instructions at all, and a client that cannot carry context
 * (Windsurf's silent style) must leave the flag unset.
 */
import { afterAll, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLAUDE_POST = join(ROOT, 'plugin', 'hooks', 'post-tool.mjs');
const WINDSURF_POST = join(ROOT, 'integrations', 'windsurf', 'hooks', 'post-tool.mjs');

const scratch = mkdtempSync(join(tmpdir(), 'recording-delivery-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function hook(script, payload, env = {}) {
  const state = mkdtempSync(join(scratch, 'state-'));
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_MODE: 'assist',
      TOKEN_OPTIMIZER_MCP_CAPABILITIES: 'smart_edit,wiki_write',
      TOKEN_OPTIMIZER_WIKI_DIR: join(scratch, 'graph'),
      TOKEN_OPTIMIZER_SHARED_DIR: join(scratch, 'graph'),
      TOKEN_OPTIMIZER_STATE_DIR: state,
      ...env,
    },
  });
  const saved = readdirSync(state)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(state, name), 'utf8')));
  return { stdout: result.stdout, saved };
}

const file = join(scratch, 'edited.ts');
writeFileSync(file, 'export const a = 1;\n');

const claudeEdit = (session) => ({
  hook_event_name: 'PostToolUse',
  session_id: session,
  cwd: scratch,
  tool_name: 'Edit',
  tool_input: { file_path: file, old_string: '1', new_string: '2' },
  tool_response: { success: true },
});

describe('the deferred recording guidance', () => {
  test('arrives on the first edit in the full arm (the control for the tests below)', () => {
    const { stdout, saved } = hook(CLAUDE_POST, claudeEdit('full-arm'));
    expect(stdout).toContain('Record what you work out');
    expect(saved.some((s) => s.recordingGuided === true)).toBe(true);
  });

  test('never arrives in an arm with harvest off, and the flag stays unspent', () => {
    for (const arm of ['optimizer', 'retrieval', 'baseline']) {
      const { stdout, saved } = hook(CLAUDE_POST, claudeEdit(`arm-${arm}`), {
        TOKEN_OPTIMIZER_EXPERIMENT_ARM: arm,
      });
      expect(stdout).not.toContain('Record what you work out');
      expect(saved.some((s) => s.recordingGuided === true)).toBe(false);
    }
  });

  test('is not marked delivered for a client that cannot carry context', () => {
    const { stdout, saved } = hook(WINDSURF_POST, {
      agent_action_name: 'post_write_code',
      trajectory_id: 'windsurf-silent',
      tool_info: { file_path: file, working_directory: scratch, edits: [] },
    });
    expect(stdout.trim()).toBe('');
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.some((s) => s.recordingGuided === true)).toBe(false);
  });
});