/**
 * The real non-Claude entry points deliver and capture graph data.
 *
 * Unit-testing forTouch is insufficient: the defect this guards was that the
 * universal adapter never called it. These tests spawn the scripts installed
 * by each CLI and inspect the exact JSON its host/model receives.
 */
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  load,
  putNode,
  putNodeWithEdges,
  wikiDir,
} from '../../hooks-core/wiki.mjs';
import { canonicalPath } from '../../hooks-core/paths.mjs';

const ROOT = process.cwd();
const CLIENTS = [
  {
    name: 'Cline',
    entry: 'integrations/cline/hooks/token-optimizer/pre-tool.mjs',
    payload: (session, cwd, command) => ({
      taskId: session,
      workspaceRoots: [cwd],
      preToolUse: { tool: 'execute_command', parameters: { command } },
    }),
    context: (out) => out?.contextModification,
  },
  {
    name: 'Codex',
    entry: 'integrations/codex/hooks/pre-tool.mjs',
    payload: (session, cwd, command) => ({
      session_id: session,
      cwd,
      tool_name: 'Bash',
      tool_input: { command },
    }),
    context: (out) => out?.hookSpecificOutput?.additionalContext,
  },
  {
    name: 'Gemini',
    entry: 'integrations/gemini/hooks/pre-tool.mjs',
    payload: (session, cwd, command) => ({
      session_id: session,
      cwd,
      tool_name: 'run_shell_command',
      tool_input: { command },
    }),
    context: (out) => out?.hookSpecificOutput?.additionalContext,
  },
  {
    name: 'Qwen',
    entry: 'integrations/qwen/hooks/pre-tool.mjs',
    payload: (session, cwd, command) => ({
      session_id: session,
      cwd,
      tool_name: 'run_shell_command',
      tool_input: { command },
    }),
    context: (out) => out?.hookSpecificOutput?.additionalContext,
  },
  {
    name: 'Copilot',
    entry: 'integrations/copilot/.github/hooks/pre-tool.mjs',
    payload: (session, cwd, command) => ({
      sessionId: session,
      cwd,
      toolName: 'bash',
      toolArgs: JSON.stringify({ command }),
    }),
    context: (out) => out?.additionalContext,
  },
  {
    name: 'Cursor',
    entry: 'integrations/cursor/hooks/pre-tool.mjs',
    payload: (session, cwd, command) => ({
      conversation_id: session,
      cwd,
      tool_name: 'Bash',
      tool_input: { command },
    }),
    context: (out) => out?.agent_message,
  },
  {
    name: 'Kilo',
    entry: 'integrations/kilo/hooks/pre-tool.mjs',
    payload: (session, cwd, command) => ({
      session_id: session,
      cwd,
      tool_name: 'bash',
      tool_input: { command },
    }),
    context: (out) => out?.hookSpecificOutput?.additionalContext,
  },
];

let project;
let dir;
let anchor;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'adapter-injection-'));
  mkdirSync(join(project, '.git'), { recursive: true });
  dir = wikiDir(project);
  anchor = join(project, 'package.json');
  writeFileSync(anchor, '{"scripts":{"test":"node --test"}}\n');
  const fileId = putNode(dir, { kind: 'file', key: anchor, hash: 'abc' });
  putNodeWithEdges(
    dir,
    {
      kind: 'finding',
      key: 'use-project-test',
      claim: 'Run npm test; direct npx jest skips the project ESM setup.',
      type: 'command',
      trigger: '\\bnpx\\s+jest\\b',
      confidence: 0.95,
      origin: 'agent',
    },
    [{ edge: 'derived_from', to: fileId }]
  );
});

afterEach(() => rmSync(project, { recursive: true, force: true }));

function run(client, payload) {
  const result = spawnSync(process.execPath, [join(ROOT, client.entry)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_STATE_DIR: join(project, '.state'),
      TOKEN_OPTIMIZER_WIKI_DIR: dir,
      TOKEN_OPTIMIZER_SHARED_DIR: dir,
    },
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

describe.each(CLIENTS)('$name adapter', (client) => {
  test('injects an applicable cross-session finding into the active model', () => {
    const session = `${client.name}-${Date.now()}-${Math.random()}`;
    const output = run(
      client,
      client.payload(session, project, 'npx jest tests/unit')
    );
    expect(client.context(output)).toContain('Run npm test');
  });

  test('structurally captures ordinary file touches', () => {
    const session = `${client.name}-capture-${Date.now()}-${Math.random()}`;
    run(
      client,
      client.payload(session, project, `node ${JSON.stringify(anchor)}`)
    );
    const graph = load(dir);
    expect(
      [...graph.nodes.values()].some(
        (node) => node.kind === 'file' && node.key === canonicalPath(anchor)
      )
    ).toBe(true);
    expect(
      [...graph.nodes.values()].some(
        (node) => node.kind === 'task' && node.key === session
      )
    ).toBe(true);
  });
});

describe('Windsurf adapter', () => {
  test('uses the documented exit-2 veto before a large read', () => {
    const large = join(project, 'large.ts');
    writeFileSync(large, 'x'.repeat(80_000));
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'integrations/windsurf/hooks/pre-tool.mjs')],
      {
        input: JSON.stringify({
          agent_action_name: 'pre_read_code',
          trajectory_id: 'windsurf-deny',
          tool_info: { file_path: large },
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKEN_OPTIMIZER_MCP_CAPABILITIES: 'smart_read',
          TOKEN_OPTIMIZER_STATE_DIR: join(project, '.state'),
        },
      }
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('smart_read');
  });

  test('captures a completed write through Windsurf post_write_code', () => {
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'integrations/windsurf/hooks/post-tool.mjs')],
      {
        input: JSON.stringify({
          agent_action_name: 'post_write_code',
          trajectory_id: 'windsurf-capture',
          tool_info: { file_path: anchor },
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKEN_OPTIMIZER_STATE_DIR: join(project, '.state'),
          TOKEN_OPTIMIZER_WIKI_DIR: dir,
          TOKEN_OPTIMIZER_SHARED_DIR: dir,
        },
      }
    );
    expect(result.status).toBe(0);
    const graph = load(dir);
    expect(
      [...graph.nodes.values()].some(
        (node) => node.kind === 'task' && node.key === 'windsurf-capture'
      )
    ).toBe(true);
  });
});
