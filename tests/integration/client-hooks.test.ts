import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  existsSync,
  mkdtempSync,
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
const geminiPostTool = join(
  repoRoot,
  'integrations/gemini/hooks/post-tool.mjs'
);
const copilotHook = join(
  repoRoot,
  'integrations/copilot/.github/hooks/token-optimizer-advisor.mjs'
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
  });

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('injects session guidance using each client output schema', () => {
    const codex = runHook(codexSessionStart, [], {
      hook_event_name: 'SessionStart',
      cwd: fixtureDir,
    });
    const copilot = runHook(copilotHook, ['session-start'], {
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

  it('enforces where a pre-execution veto exists and advises where it does not', () => {
    // THE TIER DISTINCTION, which is a statement of protocol fact rather than a
    // preference: Codex has a pre-tool hook and can refuse before the tokens are
    // spent; Gemini's only tool hook fires after the read is already paid for,
    // so it can advise about the next call and nothing more.
    const codex = runHook(codexPreTool, [], {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: largeFile },
      cwd: fixtureDir,
      session_id: 'tier-check',
    });
    const gemini = runHook(geminiPostTool, [], {
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: largeFile },
      cwd: fixtureDir,
    });
    const copilot = runHook(copilotHook, ['after-read'], {
      toolName: 'view',
      toolArgs: JSON.stringify({ path: largeFile }),
      cwd: fixtureDir,
    });

    expect(codex.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(codex.hookSpecificOutput.permissionDecisionReason).toContain(
      'smart_read'
    );

    expect(gemini.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(gemini.hookSpecificOutput.additionalContext).toContain('smart_read');
    expect(copilot.additionalContext).toContain('smart_read');
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
  });

  it('observes Claude Code PowerShell calls on Windows', () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'plugin/hooks/hooks.json'), 'utf8')
    );
    expect(manifest.hooks.PreToolUse[0].matcher).toContain('PowerShell');
    expect(manifest.hooks.PostToolUse[0].matcher).toContain('PowerShell');
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

  it('preserves guidance through OpenCode compaction and supports strict routing', async () => {
    const pluginPath = join(
      repoRoot,
      'integrations/opencode/.opencode/plugins/token-optimizer.js'
    );
    const previous = process.env.TOKEN_OPTIMIZER_REDIRECT_LARGE_READS;
    process.env.TOKEN_OPTIMIZER_REDIRECT_LARGE_READS = 'true';

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
      const compactionOutput = { context: [] as string[] };

      await hooks['experimental.session.compacting']({}, compactionOutput);
      expect(compactionOutput.context.join('\n')).toContain('smart_read');

      await expect(
        hooks['tool.execute.before'](
          { tool: 'read' },
          { args: { filePath: largeFile } }
        )
      ).rejects.toThrow('Use token-optimizer smart_read');
    } finally {
      if (previous === undefined) {
        delete process.env.TOKEN_OPTIMIZER_REDIRECT_LARGE_READS;
      } else {
        process.env.TOKEN_OPTIMIZER_REDIRECT_LARGE_READS = previous;
      }
    }
  });
});
