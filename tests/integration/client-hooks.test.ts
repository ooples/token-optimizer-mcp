import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(process.cwd());
// The adapter refactor replaced the per-client `token-optimizer-advisor.mjs`
// scripts with thin entry files that call the shared core. These tests assert
// the CURRENT architecture; they previously asserted the advisor files, which
// is why they passed on a stale tree and failed in CI once the files were gone.
const codexSessionStart = join(
  repoRoot,
  'integrations/codex/hooks/session-start.mjs'
);
const codexPreTool = join(repoRoot, 'integrations/codex/hooks/pre-tool.mjs');
const geminiSessionStart = join(
  repoRoot,
  'integrations/gemini/hooks/session-start.mjs'
);
const geminiPreTool = join(repoRoot, 'integrations/gemini/hooks/pre-tool.mjs');
const geminiPostTool = join(
  repoRoot,
  'integrations/gemini/hooks/post-tool.mjs'
);
const copilotSessionStart = join(
  repoRoot,
  'integrations/copilot/.github/hooks/session-start.mjs'
);
const copilotPreTool = join(
  repoRoot,
  'integrations/copilot/.github/hooks/pre-tool.mjs'
);
const legacyPowerShellDispatcher = join(repoRoot, 'hooks/dispatcher.ps1');
const openCodePlugin = join(
  repoRoot,
  'integrations/opencode/.opencode/plugins/token-optimizer.js'
);
const kiloPlugin = join(
  repoRoot,
  'integrations/kilo/.kilo/plugin/token-optimizer.js'
);

function runHook(
  script: string,
  args: string[],
  payload: object,
  env: Record<string, string> = {}
) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      // This suite exercises the registered-tool path. Unknown or empty
      // inventories are covered separately by mcp-capability-negotiation.
      TOKEN_OPTIMIZER_MCP_CAPABILITIES:
        'smart_read,smart_write,smart_edit,smart_glob,smart_grep,wiki_write',
      ...env,
    },
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return result.stdout ? JSON.parse(result.stdout) : undefined;
}

describe('native CLI hook integrations', () => {
  let fixtureDir: string;
  let largeFile: string;
  let smallFile: string;

  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'token-optimizer-hooks-'));
    largeFile = join(fixtureDir, 'large.txt');
    smallFile = join(fixtureDir, 'small.txt');
    writeFileSync(largeFile, 'x'.repeat(30_000));
    writeFileSync(smallFile, 'small');

    for (const [client, source] of [
      ['opencode', join(repoRoot, 'integrations/opencode/hooks')],
      ['kilo', join(repoRoot, 'integrations/kilo/hooks')],
    ] as const) {
      const destination = join(
        fixtureDir,
        `.${client}`,
        'hooks',
        'token-optimizer'
      );
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination, { recursive: true });
    }
  });

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('injects session guidance using each client output schema', () => {
    const codex = runHook(codexSessionStart, [], {
      hook_event_name: 'SessionStart',
      cwd: fixtureDir,
    });
    const copilot = runHook(copilotSessionStart, [], {
      source: 'startup',
      cwd: fixtureDir,
    });
    const gemini = runHook(geminiSessionStart, [], {
      hook_event_name: 'SessionStart',
      cwd: fixtureDir,
    });

    expect(codex.hookSpecificOutput.additionalContext).toContain('smart_read');
    expect(copilot.additionalContext).toContain('smart_read');
    expect(gemini.hookSpecificOutput.additionalContext).toContain('smart_read');
  });

  it('keeps small and partial reads unchanged', () => {
    const smallCodex = runHook(codexPreTool, [], {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: smallFile },
      cwd: fixtureDir,
    });
    const partialGemini = runHook(geminiPostTool, [], {
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: largeFile, limit: 20 },
      cwd: fixtureDir,
    });

    expect(smallCodex).toBeUndefined();
    expect(partialGemini).toBeUndefined();
  });

  it('enforces every native large-read route before execution', () => {
    const codex = runHook(codexPreTool, [], {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: largeFile },
      cwd: fixtureDir,
      session_id: 'tier-check',
    });
    const gemini = runHook(geminiPreTool, [], {
      session_id: 'gemini-tier-check',
      cwd: fixtureDir,
      tool: 'read_file',
      args: { absolute_path: largeFile },
    });
    const copilot = runHook(copilotPreTool, [], {
      sessionId: 'copilot-tier-check',
      toolName: 'view',
      toolArgs: JSON.stringify({ path: largeFile }),
      cwd: fixtureDir,
    });
    const copilotAdvisory = runHook(
      copilotPreTool,
      [],
      {
        sessionId: 'copilot-advisory',
        toolName: 'view',
        toolArgs: JSON.stringify({ path: largeFile }),
        cwd: fixtureDir,
      },
      { TOKEN_OPTIMIZER_MODE: 'advise' }
    );

    expect(codex.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(codex.hookSpecificOutput.permissionDecisionReason).toContain(
      'smart_read'
    );

    expect(gemini.decision).toBe('deny');
    expect(gemini.reason).toContain('smart_read');
    expect(copilot.permissionDecision).toBe('deny');
    expect(copilot.permissionDecisionReason).toContain('smart_read');
    expect(copilotAdvisory.additionalContext).toContain('smart_read');
  });

  it('states the escape hatch in every refusal', () => {
    // Enforcement that hides its own disable is coercive, and the person who
    // needs it is mid-refusal rather than reading the README.
    const codex = runHook(codexPreTool, [], {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: largeFile },
      cwd: fixtureDir,
      // A fresh session: a target is refused ONCE and a repeat is allowed
      // through, so reusing a session id here would exercise loop-breaking
      // rather than the refusal text.
      session_id: 'escape-hatch',
    });

    expect(codex.hookSpecificOutput.permissionDecisionReason).toContain(
      'TOKEN_OPTIMIZER_MODE=off'
    );
  });

  it('ships one shared core to every client, byte for byte', () => {
    // The invariant that replaced "these two advisor scripts are identical":
    // every client runs the SAME decision logic, copied by scripts/sync-hook-core.mjs.
    // A client whose lib has drifted is a client with its own thresholds.
    // The synced copies carry a two-line "GENERATED FILE" banner, so the
    // comparison is of the logic beneath it rather than of the whole file.
    const stripBanner = (text: string) =>
      text
        .split('\n')
        .filter(
          (line, index) =>
            !(
              index < 2 &&
              (line.startsWith('// GENERATED FILE') ||
                line.startsWith('// Source of truth'))
            )
        )
        .join('\n');
    const core = stripBanner(
      readFileSync(join(repoRoot, 'hooks-core/decide.mjs'), 'utf8')
    );
    const clients = [
      'plugin/hooks/lib/decide.mjs',
      'integrations/codex/hooks/lib/decide.mjs',
      'integrations/codex/plugin/hooks/lib/decide.mjs',
      'integrations/gemini/hooks/lib/decide.mjs',
      'integrations/opencode/hooks/lib/decide.mjs',
      'integrations/qwen/hooks/lib/decide.mjs',
    ];

    for (const client of clients) {
      expect(stripBanner(readFileSync(join(repoRoot, client), 'utf8'))).toBe(
        core
      );
    }
  });

  it('loads valid hook manifests whose commands resolve to shipped scripts', () => {
    const manifests = [
      join(repoRoot, 'integrations/codex/plugin/hooks/hooks.json'),
      join(repoRoot, 'integrations/copilot/.github/hooks/token-optimizer.json'),
      join(repoRoot, 'hooks/hooks.json'),
    ];

    for (const manifest of manifests) {
      expect(() => JSON.parse(readFileSync(manifest, 'utf8'))).not.toThrow();
      expect(dirname(manifest)).toBeTruthy();
    }

    const pluginRoot = join(repoRoot, 'integrations/codex/plugin');
    const pluginManifest = JSON.parse(
      readFileSync(join(pluginRoot, 'hooks/hooks.json'), 'utf8')
    );
    const standaloneManifest = JSON.parse(
      readFileSync(
        join(repoRoot, 'integrations/codex/hooks/hooks.json'),
        'utf8'
      )
    );
    const pluginHooks = Object.values(pluginManifest.hooks).flatMap(
      (groups: any) => groups.flatMap((group: any) => group.hooks)
    ) as Array<{ command: string; commandWindows: string }>;

    expect(pluginHooks).toHaveLength(4);
    expect(pluginManifest.hooks.SessionStart[0].matcher).toBe(
      standaloneManifest.hooks.SessionStart[0].matcher
    );
    expect(pluginManifest.hooks.PreToolUse[0].matcher).toBe(
      standaloneManifest.hooks.PreToolUse[0].matcher
    );
    expect(pluginManifest.hooks.PostToolUse[0].matcher).toBe(
      standaloneManifest.hooks.PostToolUse[0].matcher
    );
    expect(pluginManifest.hooks.Stop).toBeDefined();
    for (const hook of pluginHooks) {
      const relative = hook.command.match(
        /\$\{PLUGIN_ROOT\}\/([^\"]+\.mjs)/
      )?.[1];
      expect(relative).toBeTruthy();
      expect(existsSync(join(pluginRoot, relative!))).toBe(true);
      expect(hook.commandWindows).toContain(relative!.replaceAll('/', '\\'));
    }

    const geminiExtensionManifest = JSON.parse(
      readFileSync(join(repoRoot, 'hooks/hooks.json'), 'utf8')
    );
    expect(geminiExtensionManifest.hooks.BeforeTool).toBeDefined();
    expect(geminiExtensionManifest.hooks.AfterAgent).toBeDefined();
    const geminiCommands = Object.values(geminiExtensionManifest.hooks).flatMap(
      (groups: any) =>
        groups.flatMap((group: any) =>
          group.hooks.map((hook: any) => hook.command as string)
        )
    );
    expect(geminiCommands).toHaveLength(4);
    expect(geminiCommands.join('\n')).not.toContain(
      'gemini-token-optimizer-advisor.mjs'
    );
    for (const command of geminiCommands) {
      const relative = command.match(
        /\$\{extensionPath\}\$\{\/\}(.+\.mjs)/
      )?.[1];
      expect(relative).toBeTruthy();
      expect(
        existsSync(join(repoRoot, relative!.replaceAll('${/}', '/')))
      ).toBe(true);
    }
  });

  it('observes Claude Code PowerShell calls on Windows', () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'plugin/hooks/hooks.json'), 'utf8')
    );
    expect(manifest.hooks.PreToolUse[0].matcher).toContain('PowerShell');
    expect(manifest.hooks.PostToolUse[0].matcher).toContain('PowerShell');
  });

  const windowsIt = process.platform === 'win32' ? it : it.skip;
  windowsIt('enforces large legacy PowerShell reads by default', () => {
    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        legacyPowerShellDispatcher,
        '-Phase',
        'PreToolUse',
      ],
      {
        cwd: repoRoot,
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: largeFile },
          cwd: fixtureDir,
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKEN_OPTIMIZER_LARGE_READ_BYTES: '1000',
          TOKEN_OPTIMIZER_MODE: '',
        },
      }
    );

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('smart_read'),
    });
    expect(result.stdout).toContain('TOKEN_OPTIMIZER_MODE=off');
  });

  it('ships a Codex plugin MCP config that Codex can discover', () => {
    const config = JSON.parse(
      readFileSync(
        join(repoRoot, 'integrations/codex/plugin/.mcp.json'),
        'utf8'
      )
    );

    expect(config.mcp_servers).toBeUndefined();
    expect(config.mcpServers?.['token-optimizer']).toEqual({
      command: 'npx',
      args: ['-y', '@ooples/token-optimizer-mcp@latest'],
      required: true,
      startup_timeout_sec: 30,
      tool_timeout_sec: 120,
    });
  });

  it('ships matching Codex plugin and standalone entry points', () => {
    for (const entry of [
      'session-start.mjs',
      'pre-tool.mjs',
      'post-tool.mjs',
      'stop.mjs',
    ]) {
      const standalone = readFileSync(
        join(repoRoot, 'integrations/codex/hooks', entry),
        'utf8'
      );
      const plugin = readFileSync(
        join(repoRoot, 'integrations/codex/plugin/hooks', entry),
        'utf8'
      );
      expect(plugin).toBe(standalone);
    }
  });

  it('preserves guidance through OpenCode compaction', async () => {
    const pluginModule = (await import(
      `${pathToFileURL(openCodePlugin).href}?test=${Date.now()}`
    )) as {
      TokenOptimizerPlugin: (context: {
        directory: string;
      }) => Promise<Record<string, (...args: any[]) => Promise<void>>>;
    };
    const hooks = await pluginModule.TokenOptimizerPlugin({
      directory: fixtureDir,
    });
    const compactionOutput = { context: [] as string[] };

    await hooks['experimental.session.compacting']({}, compactionOutput);
    expect(compactionOutput.context.join('\n')).toContain('smart_read');
  });

  it.each([
    ['OpenCode', openCodePlugin],
    ['Kilo', kiloPlugin],
  ])(
    '%s executes its staged shared hook and enforces by default',
    async (_name, pluginPath) => {
      const previousMode = process.env.TOKEN_OPTIMIZER_MODE;
      const previousCapabilities = process.env.TOKEN_OPTIMIZER_MCP_CAPABILITIES;
      delete process.env.TOKEN_OPTIMIZER_MODE;
      delete process.env.TOKEN_OPTIMIZER_MCP_CAPABILITIES;

      try {
        const pluginModule = (await import(
          `${pathToFileURL(pluginPath).href}?test=${Date.now()}`
        )) as {
          TokenOptimizerPlugin: (context: {
            directory: string;
          }) => Promise<Record<string, (...args: any[]) => Promise<void>>>;
        };
        const hooks = await pluginModule.TokenOptimizerPlugin({
          directory: fixtureDir,
        });

        await expect(
          hooks['tool.execute.before'](
            { tool: 'read', sessionID: `default-${_name}` },
            { args: { filePath: largeFile } }
          )
        ).rejects.toThrow('smart_read');

        process.env.TOKEN_OPTIMIZER_MODE = 'advise';
        await expect(
          hooks['tool.execute.before'](
            { tool: 'read', sessionID: `advise-${_name}` },
            { args: { filePath: largeFile } }
          )
        ).resolves.toBeUndefined();

        delete process.env.TOKEN_OPTIMIZER_MODE;
        process.env.TOKEN_OPTIMIZER_MCP_CAPABILITIES = '';
        await expect(
          hooks['tool.execute.before'](
            { tool: 'read', sessionID: `empty-${_name}` },
            { args: { filePath: largeFile } }
          )
        ).resolves.toBeUndefined();
      } finally {
        if (previousMode === undefined) {
          delete process.env.TOKEN_OPTIMIZER_MODE;
        } else {
          process.env.TOKEN_OPTIMIZER_MODE = previousMode;
        }
        if (previousCapabilities === undefined) {
          delete process.env.TOKEN_OPTIMIZER_MCP_CAPABILITIES;
        } else {
          process.env.TOKEN_OPTIMIZER_MCP_CAPABILITIES = previousCapabilities;
        }
      }
    }
  );
});
