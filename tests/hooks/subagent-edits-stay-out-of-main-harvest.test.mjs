/**
 * A subagent's edits are not the coordinating session's work.
 *
 * Claude Code sends a subagent's hook events with the PARENT's transcript_path
 * and the subagent's own agent_id. Scoped on the transcript alone, every edit an
 * agent made was counted into the main session's state, and the main session's
 * Stop asked it to harvest files it never touched -- on every idle turn while
 * its agents worked, observed live with two background agents.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const POST = join(ROOT, 'plugin', 'hooks', 'post-tool.mjs');
const STOP = join(ROOT, 'plugin', 'hooks', 'stop.mjs');

let workspace;
let env;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'subagent-harvest-'));
  env = {
    ...process.env,
    TOKEN_OPTIMIZER_MCP_CAPABILITIES: 'wiki_write',
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
  return result.stdout ? JSON.parse(result.stdout) : null;
}

const transcript = () => join(workspace, 'session.jsonl');

function edit(sessionId, file, agentId) {
  writeFileSync(file, 'export const x = 1;\n');
  return run(POST, {
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    transcript_path: transcript(),
    ...(agentId ? { agent_id: agentId, agent_type: 'general-purpose' } : {}),
    cwd: workspace,
    tool_name: 'Edit',
    tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
    tool_response: { filePath: file, success: true },
  });
}

function stop(sessionId) {
  return run(STOP, {
    hook_event_name: 'Stop',
    session_id: sessionId,
    transcript_path: transcript(),
    cwd: workspace,
    stop_hook_active: false,
  });
}

describe("a subagent's edits stay out of the main session's harvest", () => {
  test('the main Stop does not ask about files only a subagent edited', () => {
    edit('coordinator', join(workspace, 'AgentOnly.cs'), 'agent-1');
    const output = stop('coordinator');
    expect(JSON.stringify(output ?? {})).not.toContain('AgentOnly.cs');
    expect(output?.decision).not.toBe('block');
  });

  test("the main session's own edit is still harvested, the positive control", () => {
    edit('coordinator', join(workspace, 'AgentOnly.cs'), 'agent-1');
    edit('coordinator', join(workspace, 'MainOwn.cs'));
    const output = stop('coordinator');
    expect(output?.decision).toBe('block');
    expect(output.reason).toContain('MainOwn.cs');
    expect(output.reason).not.toContain('AgentOnly.cs');
  });
});