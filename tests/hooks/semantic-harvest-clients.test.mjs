/** The active model, not a detached model, performs semantic harvesting. */
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const CLIENTS = [
  { name: 'Claude Code', root: 'plugin/hooks', decision: 'block' },
  {
    name: 'Codex', root: 'integrations/codex/hooks', decision: 'block',
    result: { tool_response: { status: 'completed' } },
  },
  {
    name: 'Copilot', root: 'integrations/copilot/.github/hooks', decision: 'block',
    result: { toolResult: { resultType: 'success', textResultForLlm: 'ok' } },
  },
  {
    name: 'Gemini', root: 'integrations/gemini/hooks', decision: 'deny',
    result: { tool_response: { llmContent: 'ok' } },
  },
  { name: 'Qwen', root: 'integrations/qwen/hooks', decision: 'block' },
  {
    name: 'Cursor', root: 'integrations/cursor/hooks', followup: true,
    result: { success: true },
  },
];

let workspace;
let env;
let edited;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'semantic-clients-'));
  edited = join(workspace, 'decision.ts');
  writeFileSync(edited, 'export const choice = true;\n');
  env = {
    ...process.env,
    TOKEN_OPTIMIZER_STATE_DIR: join(workspace, '.state'),
    TOKEN_OPTIMIZER_WIKI_DIR: join(workspace, '.wiki'),
    TOKEN_OPTIMIZER_SHARED_DIR: join(workspace, '.shared'),
  };
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function run(root, entry, payload) {
  const result = spawnSync(process.execPath, [join(ROOT, root, `${entry}.mjs`)], {
    cwd: workspace,
    env,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

describe.each(CLIENTS)('$name semantic lifecycle', (client) => {
  test('continues the same active model once after completed edits', () => {
    const session = `${client.name}-${Date.now()}-${Math.random()}`;
    run(client.root, 'post-tool', {
      session_id: session,
      conversation_id: session,
      sessionId: session,
      cwd: workspace,
      tool_name: 'write_file',
      toolName: 'write_file',
      tool_input: { file_path: edited, content: 'export const choice = true;\n' },
      toolArgs: JSON.stringify({ path: edited, content: 'export const choice = true;\n' }),
      ...(client.result || {}),
    });

    const stop = {
      session_id: session,
      conversation_id: session,
      sessionId: session,
      cwd: workspace,
      model: 'active-model',
      stop_hook_active: false,
      loop_count: 0,
    };
    const output = run(client.root, 'stop', stop);
    const prompt = client.followup ? output.followup_message : output.reason;
    expect(prompt).toContain('wiki_write');
    expect(prompt).toMatch(/active active-model model/i);
    expect(prompt).toMatch(/do not delegate/i);
    if (!client.followup) expect(output.decision).toBe(client.decision);

    const guarded = run(client.root, 'stop', {
      ...stop,
      stop_hook_active: true,
      loop_count: 1,
    });
    expect(guarded).toEqual({});

    const persisted = run(client.root, 'stop', {
      ...stop,
      stop_hook_active: false,
      loop_count: 0,
    });
    expect(persisted).toEqual({});
  });
});

describe.each([
  {
    name: 'Codex plugin', root: 'integrations/codex/plugin/hooks',
    failed: { tool_response: { status: 'failed' } },
  },
  {
    name: 'Gemini', root: 'integrations/gemini/hooks',
    failed: { tool_response: { error: { message: 'write failed' } } },
  },
])('$name failed mutation', (client) => {
  test('does not arm semantic harvest after an unsuccessful edit', () => {
    const session = `failed-${client.name}-${Date.now()}-${Math.random()}`;
    run(client.root, 'post-tool', {
      session_id: session,
      cwd: workspace,
      tool_name: 'write_file',
      tool_input: { file_path: edited, content: 'not written' },
      ...client.failed,
    });

    expect(run(client.root, 'stop', {
      session_id: session,
      cwd: workspace,
      model: 'active-model',
      stop_hook_active: false,
    })).toEqual({});
  });
});

describe('rules-only clients', () => {
  test.each(['roo', 'zed', 'amp', 'continue', 'crush', 'droid'])(
    '%s requires the active model to harvest without delegation',
    (client) => {
      const candidates = ['token-optimizer.md', 'AGENTS.md'];
      const file = candidates
        .map((name) => join(ROOT, 'integrations', client, name))
        .find((path) => {
          try { return Boolean(readFileSync(path, 'utf8')); } catch { return false; }
        });
      const rules = readFileSync(file, 'utf8');
      expect(rules).toContain('wiki_write');
      expect(rules).toMatch(/active model/i);
      expect(rules).toMatch(/do not delegate/i);
    }
  );
});
