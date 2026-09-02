/**
 * Runtime MCP capability negotiation.
 *
 * Regression: a plugin can be installed while its MCP server is absent from
 * the active model's tool inventory. The hook still claimed the server was
 * connected and denied Grep in favour of `smart_grep`, forcing the model to
 * discover that the replacement did not exist and spend another turn finding
 * a native workaround.
 */
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  optimizerToolEvidence,
  optimizerToolsForHook,
  rememberOptimizerTools,
} from '../../hooks-core/capabilities.mjs';
import { policyText } from '../../hooks-core/adapter.mjs';
import { decide } from '../../hooks-core/decide.mjs';

const ROOT = process.cwd();
const CLAUDE_ROUTER = join(ROOT, 'plugin', 'hooks', 'pretooluse-router.mjs');
const CODEX_ROUTER = join(
  ROOT,
  'integrations',
  'codex',
  'plugin',
  'hooks',
  'pre-tool.mjs'
);

let workspace;
let cleanEnv;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'mcp-capability-'));
  cleanEnv = { ...process.env };
  delete cleanEnv.TOKEN_OPTIMIZER_MCP_CAPABILITIES;
  delete cleanEnv.TOKEN_OPTIMIZER_TOOL_PROFILE;
  cleanEnv.TOKEN_OPTIMIZER_STATE_DIR = join(workspace, '.state');
  cleanEnv.TOKEN_OPTIMIZER_WIKI_DIR = join(workspace, '.wiki');
  cleanEnv.TOKEN_OPTIMIZER_SHARED_DIR = join(workspace, '.shared');
  // These cases are about what a PLUGIN install does with no host inventory,
  // and the bundled list is now asserted only for an actual plugin -- the
  // runtime sets CLAUDE_PLUGIN_ROOT, a settings.json install does not. Setting
  // it here makes the premise the test name already claims explicit; without
  // it these were silently exercising the settings path instead.
  cleanEnv.CLAUDE_PLUGIN_ROOT = join(workspace, 'plugin');
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function run(entry, payload, env = cleanEnv) {
  const result = spawnSync(process.execPath, [entry], {
    cwd: workspace,
    env,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

describe('inventory evidence', () => {
  test('does not infer registration from installation or a tool profile', () => {
    const evidence = optimizerToolEvidence(
      {},
      { TOKEN_OPTIMIZER_TOOL_PROFILE: 'core' }
    );
    expect(evidence.proven).toBe(false);
    expect([...evidence.names]).toEqual([]);
  });

  test('recognizes host-qualified names and exact explicit configuration', () => {
    const evidence = optimizerToolEvidence(
      {
        context: {
          available_tools: [
            { name: 'mcp__token_optimizer__smart_grep' },
            'token-optimizer.wiki_write',
          ],
        },
      },
      {}
    );
    expect(evidence.proven).toBe(true);
    expect([...evidence.names].sort()).toEqual(['smart_grep', 'wiki_write']);
  });

  test('preserves a proven empty inventory in session state', () => {
    const state = {};
    rememberOptimizerTools(
      state,
      optimizerToolEvidence({ available_tools: [] }, {}),
      123
    );
    const restored = optimizerToolsForHook({}, state, {});
    expect(restored.proven).toBe(true);
    expect([...restored.names]).toEqual([]);
  });

  test('a host-reported empty inventory overrides bundled defaults', () => {
    const evidence = optimizerToolEvidence(
      { available_tools: [] },
      { TOKEN_OPTIMIZER_MCP_CAPABILITIES: 'smart_read,smart_grep' }
    );
    expect(evidence.proven).toBe(true);
    expect([...evidence.names]).toEqual([]);
  });
});

describe('fail-open routing', () => {
  const grep = {
    tool_name: 'Grep',
    tool_input: { pattern: 'needle', path: '.' },
  };

  test('the pure router allows native Grep when smart_grep is unproven', () => {
    expect(decide(grep, { seen: {} }, new Set())).toBeNull();
    expect(
      decide(grep, { seen: {} }, new Set(['smart_grep']))?.reason
    ).toContain('smart_grep');
  });

  test.each([
    ['Claude Code plugin', CLAUDE_ROUTER],
    ['Codex plugin', CODEX_ROUTER],
  ])(
    '%s leaves native search available with no registered replacement',
    (_name, entry) => {
      const noServerEnv = {
        ...cleanEnv,
        // Explicit empty inventory overrides the bundled default and models a
        // host that positively reports the MCP server unavailable.
        TOKEN_OPTIMIZER_MCP_CAPABILITIES: '',
      };
      const output = run(entry, {
        session_id: `absent-${_name}`,
        cwd: workspace,
        tool_name: 'Grep',
        tool_input: { pattern: 'needle', path: '.' },
      }, noServerEnv);
      expect(output).toBeNull();
    }
  );

  test.each([
    ['Claude Code plugin', CLAUDE_ROUTER],
    ['Codex plugin', CODEX_ROUTER],
  ])('%s enforces its bundled MCP tools without host inventory', (_name, entry) => {
    const output = run(entry, {
      session_id: `bundled-${_name}`,
      cwd: workspace,
      tool_name: 'Grep',
      tool_input: { pattern: 'needle', path: '.' },
    });
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
      'smart_grep'
    );
  });

  test('Codex denies one unambiguous large read inside a code-mode envelope', () => {
    const large = join(workspace, 'large-code-mode.ts');
    writeFileSync(large, 'export const value = 1;\n'.repeat(2_000));
    const command = `Get-Content -Raw "${large}"`;
    const output = run(CODEX_ROUTER, {
      session_id: 'codex-single-code-mode-read',
      cwd: workspace,
      tool_name: 'functions.exec',
      tool_input: {
        code: `await tools.exec_command({ cmd: ${JSON.stringify(command)} });`,
      },
    });

    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
      'smart_read'
    );
  });

  test('Codex keeps multi-operation code-mode orchestration advisory', () => {
    const large = join(workspace, 'large-multi-operation.ts');
    writeFileSync(large, 'export const value = 1;\n'.repeat(2_000));
    const read = `Get-Content -Raw "${large}"`;
    const output = run(CODEX_ROUTER, {
      session_id: 'codex-multi-code-mode-read',
      cwd: workspace,
      tool_name: 'functions.exec',
      tool_input: {
        code:
          `await tools.exec_command({ cmd: ${JSON.stringify(read)} });` +
          `await tools.exec_command({ cmd: 'git status --short' });`,
      },
    });

    expect(output?.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(output?.hookSpecificOutput?.additionalContext).toContain('smart_read');
  });

  test('positive inventory evidence re-enables the exact replacement only', () => {
    const output = run(CODEX_ROUTER, {
      session_id: 'present',
      cwd: workspace,
      available_tools: ['mcp__token_optimizer__smart_grep'],
      tool_name: 'Grep',
      tool_input: { pattern: 'needle', path: '.' },
    });
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
      'smart_grep'
    );
  });
});

describe('session policy honesty', () => {
  test('does not claim or name unavailable schemas', () => {
    const text = policyText(true, new Set(), false);
    expect(text).toMatch(/no positive evidence/i);
    expect(text).not.toContain('smart_grep');
    expect(text).not.toContain('wiki_write');
    expect(text).toMatch(/native tools/i);
  });

  test('mentions only schemas proven present', () => {
    const text = policyText(true, new Set(['smart_grep', 'wiki_write']), true);
    expect(text).toContain('smart_grep');
    expect(text).toContain('wiki_write');
    expect(text).not.toContain('smart_read');
  });
});
