/**
 * Codex performs semantic harvesting itself.
 *
 * PostToolUse records completed mutations. Stop then continues the SAME active
 * model once with a concrete wiki_write prompt; stop_hook_active prevents a
 * continuation loop. No transcript is sent to a second model in this path.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const POST = join(ROOT, 'integrations', 'codex', 'hooks', 'post-tool.mjs');
const STOP = join(ROOT, 'integrations', 'codex', 'hooks', 'stop.mjs');

let workspace;
let env;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'codex-semantic-harvest-'));
  env = {
    ...process.env,
    TOKEN_OPTIMIZER_NUDGE_AFTER: '2',
    TOKEN_OPTIMIZER_STATE_DIR: join(workspace, '.state'),
    TOKEN_OPTIMIZER_WIKI_DIR: join(workspace, '.wiki'),
    TOKEN_OPTIMIZER_SHARED_DIR: join(workspace, '.shared'),
  };
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function run(script, payload) {
  const result = spawnSync(process.execPath, [script], {
    cwd: workspace,
    env,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function editPayload(sessionId, file) {
  return {
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    transcript_path: join(workspace, 'rollout.jsonl'),
    cwd: workspace,
    tool_name: 'apply_patch',
    tool_input: {
      command: `*** Begin Patch\n*** Update File: ${file}\n@@\n-old\n+new\n*** End Patch`,
    },
    tool_response: { status: 'completed' },
  };
}

describe('Codex semantic harvest lifecycle', () => {
  test('tracks completed edits and nudges with their actual file names', () => {
    const first = join(workspace, 'first.ts');
    const second = join(workspace, 'second.ts');
    writeFileSync(first, 'export const first = 1;\n');
    writeFileSync(second, 'export const second = 2;\n');

    expect(run(POST, editPayload('semantic-1', first))).toBeNull();
    const output = run(POST, editPayload('semantic-1', second));

    const context = output.hookSpecificOutput.additionalContext;
    expect(context).toContain('wiki_write');
    expect(context).toContain('first.ts');
    expect(context).toContain('second.ts');
  });

  test('continues gpt-5.6-sol once to perform its own harvest', () => {
    const file = join(workspace, 'decision.ts');
    writeFileSync(file, 'export const selected = true;\n');
    run(POST, editPayload('semantic-2', file));

    const payload = {
      hook_event_name: 'Stop',
      session_id: 'semantic-2',
      transcript_path: join(workspace, 'rollout.jsonl'),
      cwd: workspace,
      model: 'gpt-5.6-sol',
      stop_hook_active: false,
      last_assistant_message: 'Implementation complete.',
    };
    const output = run(STOP, payload);

    expect(output.decision).toBe('block');
    expect(output.reason).toMatch(/active gpt-5\.6-sol model/i);
    expect(output.reason).toContain('wiki_write');
    expect(output.reason).toMatch(/do not delegate/i);

    expect(run(STOP, { ...payload, stop_hook_active: true })).toEqual({});
    // Some clients clear stop_hook_active after the continuation completes.
    // The persisted edit watermark must still prevent a third Stop loop.
    expect(run(STOP, { ...payload, stop_hook_active: false })).toEqual({});
  });

  test('does not interrupt a read-only turn', () => {
    expect(
      run(STOP, {
        hook_event_name: 'Stop',
        session_id: 'read-only',
        cwd: workspace,
        model: 'gpt-5.6-sol',
        stop_hook_active: false,
      })
    ).toEqual({});
  });
});
