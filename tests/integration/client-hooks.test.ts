import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(process.cwd());
const codexHook = join(
  repoRoot,
  'integrations/codex/plugin/hooks/token-optimizer-advisor.mjs'
);
const copilotHook = join(
  repoRoot,
  'integrations/copilot/.github/hooks/token-optimizer-advisor.mjs'
);
const geminiHook = join(repoRoot, 'hooks/gemini-token-optimizer-advisor.mjs');

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
    env: { ...process.env, ...env },
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
    const codex = runHook(codexHook, [], {
      hook_event_name: 'SessionStart',
      cwd: fixtureDir,
    });
    const copilot = runHook(copilotHook, ['session-start'], {
      source: 'startup',
      cwd: fixtureDir,
    });
    const gemini = runHook(geminiHook, ['session-start'], {
      hook_event_name: 'SessionStart',
      cwd: fixtureDir,
    });

    expect(codex.hookSpecificOutput.additionalContext).toContain('smart_read');
    expect(copilot.additionalContext).toContain('smart_read');
    expect(gemini.hookSpecificOutput.additionalContext).toContain('smart_read');
  });

  it('keeps small and partial reads unchanged', () => {
    const smallCodex = runHook(codexHook, [], {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: smallFile },
      cwd: fixtureDir,
    });
    const partialGemini = runHook(geminiHook, ['after-read'], {
      hook_event_name: 'AfterTool',
      tool_name: 'read_file',
      tool_input: { file_path: largeFile, limit: 20 },
      cwd: fixtureDir,
    });

    expect(smallCodex).toBeUndefined();
    expect(partialGemini).toBeUndefined();
  });

  it('advises on large reads without blocking by default', () => {
    const codex = runHook(codexHook, [], {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: largeFile },
      cwd: fixtureDir,
    });
    const copilot = runHook(copilotHook, ['after-read'], {
      toolName: 'view',
      toolArgs: JSON.stringify({ path: largeFile }),
      cwd: fixtureDir,
    });
    const gemini = runHook(geminiHook, ['after-read'], {
      hook_event_name: 'AfterTool',
      tool_name: 'read_file',
      tool_input: { file_path: largeFile },
      cwd: fixtureDir,
    });

    expect(codex.hookSpecificOutput.additionalContext).toContain('29 KB');
    expect(copilot.additionalContext).toContain('29 KB');
    expect(gemini.hookSpecificOutput.additionalContext).toContain('29 KB');
  });

  it('uses each client native redirect mechanism when explicitly enabled', () => {
    const env = { TOKEN_OPTIMIZER_REDIRECT_LARGE_READS: 'true' };
    const codex = runHook(
      codexHook,
      [],
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: largeFile },
        cwd: fixtureDir,
      },
      env
    );
    const copilot = runHook(
      copilotHook,
      ['before-read'],
      {
        toolName: 'view',
        toolArgs: { path: largeFile },
        cwd: fixtureDir,
      },
      env
    );
    const gemini = runHook(
      geminiHook,
      ['after-read'],
      {
        hook_event_name: 'AfterTool',
        tool_name: 'read_file',
        tool_input: { file_path: largeFile },
        cwd: fixtureDir,
      },
      env
    );

    expect(codex.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(copilot.permissionDecision).toBe('deny');
    expect(gemini.hookSpecificOutput.tailToolCallRequest).toEqual({
      name: 'mcp_token-optimizer_smart_read',
      args: { path: largeFile },
    });
  });

  it('ships matching Gemini hooks in the root and standalone extension', () => {
    const rootHooks = readFileSync(join(repoRoot, 'hooks/hooks.json'), 'utf8');
    const standaloneHooks = readFileSync(
      join(repoRoot, 'integrations/gemini/hooks/hooks.json'),
      'utf8'
    );
    const rootScript = readFileSync(geminiHook, 'utf8');
    const standaloneScript = readFileSync(
      join(
        repoRoot,
        'integrations/gemini/hooks/gemini-token-optimizer-advisor.mjs'
      ),
      'utf8'
    );

    expect(JSON.parse(rootHooks)).toEqual(JSON.parse(standaloneHooks));
    expect(rootScript).toBe(standaloneScript);
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
  });

  it('ships matching Codex plugin and standalone hook logic', () => {
    const standalone = readFileSync(
      join(repoRoot, 'integrations/codex/hooks/token-optimizer-advisor.mjs'),
      'utf8'
    );
    expect(readFileSync(codexHook, 'utf8')).toBe(standalone);
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
