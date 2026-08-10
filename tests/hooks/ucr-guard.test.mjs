import { afterEach, describe, expect, test } from '@jest/globals';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalJson, sha256 } from '../../ucr/index.mjs';
import { evaluateUcrGuards } from '../../hooks-core/ucr-guard.mjs';

const temporary = [];
const environmentKeys = [
  'TOKEN_OPTIMIZER_UCR_DIR',
  'TOKEN_OPTIMIZER_TASK_ID',
  'TOKEN_OPTIMIZER_PROJECT_ID',
  'TOKEN_OPTIMIZER_WORKSPACE_ID',
  'TOKEN_OPTIMIZER_MODE',
  'TOKEN_OPTIMIZER_STATE_DIR',
  'TOKEN_OPTIMIZER_WIKI_DIR',
];
const priorEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]])
);

afterEach(() => {
  while (temporary.length)
    rmSync(temporary.pop(), { recursive: true, force: true });
  for (const key of environmentKeys) {
    if (priorEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = priorEnvironment[key];
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ucr-guard-'));
  temporary.push(root);
  const ucrRoot = join(root, 'ucr');
  const target = join(
    root,
    'integrations',
    'codex',
    'hooks',
    'lib',
    'inject.mjs'
  );
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(ucrRoot, { recursive: true });
  writeFileSync(target, 'generated', 'utf8');
  const body = {
    schemaVersion: 'ucr.active-guards/1',
    guards: [
      {
        id: 'guard:generated-source',
        state: 'active',
        triggers: [
          {
            field: 'path',
            operator: 'matches',
            value: 'integrations.*codex.*hooks.*lib.*inject\\.mjs$',
          },
        ],
        intervention: { type: 'replace-parameters' },
        replacementAction: {
          path: 'hooks-core/inject.mjs',
          then: 'node scripts/verify-hooks.mjs',
        },
        rollback: 'disable this guard',
        failureBehavior: 'advise',
        evidence: ['receipt:verified'],
        scope: {
          taskId: 'task-1',
          projectId: 'project-1',
          workspaceId: 'workspace-1',
        },
        sourceObjectId: 'failure:one',
      },
    ],
    eventDigest: 'events',
  };
  writeFileSync(
    join(ucrRoot, 'active-guards.json'),
    `${canonicalJson({ ...body, indexHash: sha256(body) })}\n`,
    'utf8'
  );
  const env = {
    ...process.env,
    TOKEN_OPTIMIZER_UCR_DIR: ucrRoot,
    TOKEN_OPTIMIZER_TASK_ID: 'task-1',
    TOKEN_OPTIMIZER_PROJECT_ID: 'project-1',
    TOKEN_OPTIMIZER_WORKSPACE_ID: 'workspace-1',
    TOKEN_OPTIMIZER_MODE: 'enforce',
    TOKEN_OPTIMIZER_STATE_DIR: join(root, 'state'),
    TOKEN_OPTIMIZER_WIKI_DIR: join(root, 'wiki'),
  };
  Object.assign(process.env, env);
  return { root, ucrRoot, target, env };
}

describe('materialized UCR guards', () => {
  test('rejects a repeated action before execution and honors exact scope', () => {
    const { target } = fixture();
    const payload = {
      tool_name: 'Edit',
      tool_input: { file_path: target },
    };
    expect(evaluateUcrGuards(payload, [target])).toMatchObject({
      guardId: 'guard:generated-source',
      persistent: true,
      replacementAction: { path: 'hooks-core/inject.mjs' },
    });
    process.env.TOKEN_OPTIMIZER_PROJECT_ID = 'other-project';
    expect(evaluateUcrGuards(payload, [target])).toBeNull();
  });

  test('enforces the same verified guard through every native pre-tool adapter', () => {
    const { root, ucrRoot, target, env } = fixture();
    const common = {
      session_id: 'session-1',
      cwd: root,
      tool_name: 'Edit',
      tool_input: { file_path: target },
    };
    const adapters = [
      ['claude-code', 'plugin/hooks/pretooluse-router.mjs', common],
      ['codex', 'integrations/codex/hooks/pre-tool.mjs', common],
      ['copilot', 'integrations/copilot/.github/hooks/pre-tool.mjs', common],
      ['gemini', 'integrations/gemini/hooks/pre-tool.mjs', common],
      ['qwen', 'integrations/qwen/hooks/pre-tool.mjs', common],
      ['cursor', 'integrations/cursor/hooks/pre-tool.mjs', common],
      [
        'cline',
        'integrations/cline/hooks/token-optimizer/pre-tool.mjs',
        {
          taskId: 'session-1',
          workspaceRoots: [root],
          preToolUse: {
            tool: 'write_file',
            parameters: { file_path: target },
          },
        },
      ],
      ['opencode', 'integrations/opencode/hooks/pre-tool.mjs', common],
      ['kilo', 'integrations/kilo/hooks/pre-tool.mjs', common],
      [
        'windsurf',
        'integrations/windsurf/hooks/pre-tool.mjs',
        {
          trajectory_id: 'session-1',
          agent_action_name: 'write_code',
          tool_info: { file_path: target, working_directory: root },
        },
      ],
    ];
    for (const [client, entry, payload] of adapters) {
      const result = spawnSync(process.execPath, [join(process.cwd(), entry)], {
        cwd: root,
        env,
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      if (!output.includes('Verified prior correction')) {
        throw new Error(`${client} did not enforce the UCR guard: ${output}`);
      }
      expect([0, 2]).toContain(result.status);
      if (client === 'windsurf') expect(result.status).toBe(2);
    }
    const audit = readFileSync(join(ucrRoot, 'guard-audit.jsonl'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(audit).toHaveLength(adapters.length);
    expect(audit.every((row) => row.executed === false)).toBe(true);
  });

  test('fails open when the materialized guard index is tampered', () => {
    const { ucrRoot, target } = fixture();
    appendFileSync(join(ucrRoot, 'active-guards.json'), '{}\n', 'utf8');
    expect(
      evaluateUcrGuards(
        { tool_name: 'Edit', tool_input: { file_path: target } },
        [target]
      )
    ).toBeNull();
  });
});
