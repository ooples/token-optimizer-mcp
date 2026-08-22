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
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalizeTool, normalizePayload } from '../../hooks-core/decide.mjs';
import { CLIENTS, normalizeClientPayload } from '../../hooks-core/adapter.mjs';
import {
  CAPABILITY_TIERS,
  CLIENT_CAPABILITIES,
} from '../../hooks-core/capabilities.mjs';

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
  const childEnv = { ...process.env, ...env };
  if (
    !Object.prototype.hasOwnProperty.call(
      env,
      'TOKEN_OPTIMIZER_MCP_CAPABILITIES'
    )
  ) {
    // The default-on test must prove the packaged entry establishes its own
    // bundled contract rather than inheriting evidence from the test runner.
    delete childEnv.TOKEN_OPTIMIZER_MCP_CAPABILITIES;
  }
  const result = spawnSync(process.execPath, [join(ROOT, relativePath)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: childEnv,
  });
  if (!result.stdout.trim())
    return {
      decision: result.status === 2 ? 'deny' : 'allow',
      reason: result.stderr || '',
      status: result.status,
    };
  const parsed = JSON.parse(result.stdout.trim());
  const out = parsed.hookSpecificOutput || parsed;
  return {
    decision:
      parsed.decision ||
      out.permissionDecision ||
      out.permission ||
      (out.cancel ? 'deny' : null) ||
      (out.additionalContext ? 'advise' : 'allow'),
    reason:
      parsed.reason ||
      out.permissionDecisionReason ||
      out.errorMessage ||
      out.agent_message ||
      out.additionalContext ||
      '',
    status: result.status,
  };
}

const nativeCommandClients = [
  {
    client: 'claude-code',
    entry: 'plugin/hooks/pretooluse-router.mjs',
    payload: (session) => ({
      session_id: session,
      cwd: workspace,
      tool_name: 'Read',
      tool_input: { file_path: big },
    }),
  },
  {
    client: 'codex',
    entry: 'integrations/codex/hooks/pre-tool.mjs',
    payload: (session) => ({
      session_id: session,
      cwd: workspace,
      tool_name: 'read_file',
      tool_input: { path: big },
    }),
  },
  {
    client: 'copilot',
    entry: 'integrations/copilot/.github/hooks/pre-tool.mjs',
    payload: (session) => ({
      sessionId: session,
      cwd: workspace,
      toolName: 'view',
      toolArgs: JSON.stringify({ path: big }),
    }),
  },
  {
    client: 'gemini',
    entry: 'integrations/gemini/hooks/pre-tool.mjs',
    payload: (session) => ({
      session_id: session,
      cwd: workspace,
      tool: 'read_file',
      args: { absolute_path: big },
    }),
  },
  {
    client: 'qwen',
    entry: 'integrations/qwen/hooks/pre-tool.mjs',
    payload: (session) => ({
      session_id: session,
      cwd: workspace,
      tool_name: 'read_file',
      tool_input: { file_path: big },
    }),
  },
  {
    client: 'cursor',
    entry: 'integrations/cursor/hooks/pre-tool.mjs',
    payload: (session) => ({
      session_id: session,
      cwd: workspace,
      tool_name: 'read_file',
      tool_input: { path: big },
    }),
  },
  {
    client: 'cline',
    entry: 'integrations/cline/hooks/token-optimizer/pre-tool.mjs',
    payload: (session) => ({
      taskId: session,
      workspaceRoots: [workspace],
      preToolUse: { tool: 'read_file', parameters: { path: big } },
    }),
  },
  {
    client: 'windsurf',
    entry: 'integrations/windsurf/hooks/pre-tool.mjs',
    payload: (session) => ({
      trajectory_id: session,
      agent_action_name: 'pre_read_code',
      tool_info: { file_path: big, working_directory: workspace },
    }),
  },
];

const rulesOnlyClients = {
  roo: 'integrations/roo/token-optimizer.md',
  zed: 'integrations/zed/AGENTS.md',
  amp: 'integrations/amp/AGENTS.md',
  continue: 'integrations/continue/token-optimizer.md',
  crush: 'integrations/crush/AGENTS.md',
  droid: 'integrations/droid/AGENTS.md',
};

describe('tool names normalize across clients', () => {
  test.each([
    ['read_file', 'Read'],
    ['view_file', 'Read'],
    ['open_file', 'Read'],
    ['search_file_content', 'Grep'],
    ['grep_search', 'Grep'],
    ['find_files', 'Glob'],
    ['glob_file_search', 'Glob'],
    ['apply_patch', 'Edit'],
    ['search_replace', 'Edit'],
    ['write_file', 'Write'],
    ['run_terminal_cmd', 'Bash'],
    ['PowerShell', 'Bash'],
    ['pwsh', 'Bash'],
  ])('%s -> %s', (alias, canonical) => {
    expect(normalizeTool(alias)).toBe(canonical);
  });

  test('an unknown tool is ignored rather than guessed at', () => {
    expect(normalizeTool('send_email')).toBeNull();
  });
});

describe('payload shapes normalize across clients', () => {
  test('Codex code-mode envelopes expose nested mutations without hard-failing the host script', () => {
    const raw = normalizeClientPayload('codex', 'post-tool', {
      tool_name: 'functions.exec',
      tool_input: {
        code: 'const patch = "*** Update File: src/a.ts\\n"; await tools.apply_patch(patch);',
      },
    });
    const payload = normalizePayload(raw);

    expect(payload.tool_name).toBe('Edit');
    expect(payload.tool_input.code_mode_envelope).toBe(true);
    expect(payload.tool_input.command).toContain('*** Update File: src/a.ts');
  });

  test('Codex code mode extracts nested shell commands but ignores non-filesystem orchestration', () => {
    const command = normalizePayload(
      normalizeClientPayload('codex', 'pre-tool', {
        tool_name: 'functions.exec',
        tool_input: {
          code: 'const task = "git status --short"; await tools.exec_command({ cmd: task });',
        },
      })
    );
    const web = normalizePayload(
      normalizeClientPayload('codex', 'pre-tool', {
        tool_name: 'functions.exec',
        tool_input: { code: 'await tools.web__run({search_query:[{q:"x"}]});' },
      })
    );

    expect(command.tool_name).toBe('Bash');
    expect(command.tool_input.command).toBe('git status --short');
    expect(command.tool_input.code_mode_single_shell_command).toBe(true);
    expect(web.tool_name).toBeNull();
  });

  test('Codex marks multi-command code-mode orchestration as unsafe to veto wholesale', () => {
    const payload = normalizePayload(
      normalizeClientPayload('codex', 'pre-tool', {
        tool_name: 'functions.exec',
        tool_input: {
          code: "await tools.exec_command({ cmd: 'Get-Content -Raw large.ts' }); await tools.exec_command({ cmd: 'git status --short' });",
        },
      })
    );

    expect(payload.tool_name).toBe('Bash');
    expect(payload.tool_input.code_mode_envelope).toBe(true);
    expect(payload.tool_input.code_mode_single_shell_command).toBe(false);
  });

  test('Codex code mode decodes quoted Windows paths without losing backslashes', () => {
    const payload = normalizePayload(
      normalizeClientPayload('codex', 'pre-tool', {
        tool_name: 'functions.exec',
        tool_input: {
          code: String.raw`const task = 'Get-Content C:\\Users\\cheat\\project\\file.cs'; await tools.exec_command({ cmd: task });`,
        },
      })
    );

    expect(payload.tool_name).toBe('Bash');
    expect(payload.tool_input.command).toBe(
      'Get-Content C:\\Users\\cheat\\project\\file.cs'
    );
  });

  test('Codex code mode decodes bounded escapes without evaluating interpolation', () => {
    const escaped = normalizePayload(
      normalizeClientPayload('codex', 'pre-tool', {
        tool_name: 'functions.exec',
        tool_input: {
          code: String.raw`await tools.exec_command({ cmd: 'first\nsecond\x21' });`,
        },
      })
    );
    const interpolated = normalizePayload(
      normalizeClientPayload('codex', 'pre-tool', {
        tool_name: 'functions.exec',
        tool_input: {
          code: 'const value = `git ${unsafe}`; await tools.exec_command({ cmd: value });',
        },
      })
    );

    expect(escaped.tool_input.command).toBe('first\nsecond!');
    expect(interpolated.tool_name).toBeNull();
  });

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
    expect(
      normalizePayload({
        tool: 'read_file',
        args: { target_file: '/tmp/y.ts' },
      }).tool_input.file_path
    ).toBe('/tmp/y.ts');
  });
});

describe('enforcement matches protocol capability, exactly', () => {
  test.each(nativeCommandClients)(
    '$client denies a large read by default through its packaged pre-tool entry',
    ({ client, entry, payload }) => {
      const r = runEntry(entry, payload(`fleet-default-${client}`));
      expect(r.decision).toBe('deny');
      expect(r.reason).toContain('smart_read');
    }
  );

  test.each(nativeCommandClients)(
    '$client fails open when the optimizer inventory is explicitly empty',
    ({ client, entry, payload }) => {
      const r = runEntry(entry, payload(`fleet-empty-${client}`), {
        TOKEN_OPTIMIZER_MCP_CAPABILITIES: '',
      });
      expect(r.decision).not.toBe('deny');
    }
  );

  test.each(nativeCommandClients)(
    '$client honors the explicit advisory-mode escape hatch',
    ({ client, entry, payload }) => {
      const r = runEntry(entry, payload(`fleet-advise-${client}`), {
        TOKEN_OPTIMIZER_MODE: 'advise',
      });
      expect(r.decision).not.toBe('deny');
    }
  );

  test('every native command-hook client is exercised by the fleet probes', () => {
    const inProcessClients = new Set(['opencode', 'kilo']);
    const expected = Object.keys(CLIENTS)
      .filter((client) => !inProcessClients.has(client))
      .sort();
    expect(nativeCommandClients.map(({ client }) => client).sort()).toEqual(
      expected
    );
  });

  test('every rules-only client ships mandatory always-on routing instructions', () => {
    const expected = Object.entries(CLIENT_CAPABILITIES)
      .filter(([, capability]) => capability.tier === CAPABILITY_TIERS.RULES)
      .map(([client]) => client)
      .sort();
    expect(Object.keys(rulesOnlyClients).sort()).toEqual(expected);

    for (const [client, relativePath] of Object.entries(rulesOnlyClients)) {
      const rules = readFileSync(join(ROOT, relativePath), 'utf8');
      expect(rules).toContain('MUST use the token-optimizer MCP tools');
      expect(rules).toContain('mandatory routing policy');
      expect(rules).toContain('has no packaged pre-execution bridge');
      expect(client).toBeTruthy();
    }
  });

  test('every client declares its capability explicitly', () => {
    for (const [name, capability] of Object.entries(CLIENTS)) {
      expect(typeof capability.canDeny).toBe('boolean');
      // A client that can deny must declare the protocol shape it emits.
      if (capability.canDeny) expect(capability.denyStyle).toBeTruthy();
    }
  });

  test('all registered clients are covered by native or mandatory-rule probes', () => {
    const covered = new Set([
      ...nativeCommandClients.map(({ client }) => client),
      'opencode',
      'kilo',
      ...Object.keys(rulesOnlyClients),
    ]);
    expect([...covered].sort()).toEqual(
      Object.keys(CLIENT_CAPABILITIES).sort()
    );
  });
});

describe('the vendored core stays identical to its source', () => {
  test('sync check passes', () => {
    // Vendored copies are how each client gets the core into the directory it
    // executes from. Drift there is the exact failure this replaced.
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'sync-hook-core.mjs'), '--check'],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(0);
  });
});
