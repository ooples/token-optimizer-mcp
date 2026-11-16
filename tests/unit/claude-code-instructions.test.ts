import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  claudeCodeHooksWired,
  HOOKED_INSTRUCTIONS,
  hookedClientFor,
  hooksWiredFor,
  instructionsFor,
  instructionsForClient,
  PLUGIN_INSTRUCTIONS,
  type HookedClient,
} from '../../src/server/plugin-instructions.js';
// The installer's own merge, so the test recognises exactly what it writes.
// @ts-expect-error -- plain .mjs module without type declarations
import { wire } from '../../src/hooks-core/wire.mjs';

const HOOKS_DIR = '/opt/token-optimizer/src/plugin/hooks';

describe('Claude Code instructions follow the hooks, not only the plugin', () => {
  let dir: string;
  let userDir: string;
  let project: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'to-instructions-'));
    userDir = path.join(dir, 'user');
    project = path.join(dir, 'project');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(path.join(project, '.claude'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    CLAUDECODE: '1',
    CLAUDE_CONFIG_DIR: userDir,
    CLAUDE_PROJECT_DIR: project,
    ...extra,
  });
  const writeSettings = (file: string, settings: unknown) =>
    writeFileSync(file, JSON.stringify(settings));

  it('a script install wired into the user settings gets the short text', async () => {
    writeSettings(path.join(userDir, 'settings.json'), wire({}, HOOKS_DIR));
    const e = env();
    expect(await claudeCodeHooksWired(e)).toBe(true);
    expect(instructionsFor(e, await claudeCodeHooksWired(e))).toBe(
      PLUGIN_INSTRUCTIONS
    );
  });

  it('project settings, shared or local, count too', async () => {
    for (const name of ['settings.json', 'settings.local.json']) {
      const file = path.join(project, '.claude', name);
      writeSettings(file, wire({}, HOOKS_DIR));
      expect(await claudeCodeHooksWired(env())).toBe(true);
      rmSync(file);
    }
  });

  it('another client on the same machine keeps the long text', async () => {
    writeSettings(path.join(userDir, 'settings.json'), wire({}, HOOKS_DIR));
    const cursor = env({ CLAUDECODE: undefined });
    expect(await claudeCodeHooksWired(cursor)).toBe(false);
    expect(instructionsFor(cursor, false)).not.toBe(PLUGIN_INSTRUCTIONS);
  });

  it('Claude Code without our hooks keeps the long text', async () => {
    writeSettings(path.join(userDir, 'settings.json'), {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [{ type: 'command', command: 'node /home/me/my-hook.mjs' }],
          },
        ],
      },
    });
    expect(await claudeCodeHooksWired(env())).toBe(false);
  });

  it('missing or malformed settings mean not wired, never a throw', async () => {
    expect(await claudeCodeHooksWired(env())).toBe(false);
    writeFileSync(path.join(userDir, 'settings.json'), '{not json');
    expect(await claudeCodeHooksWired(env())).toBe(false);
  });

  it('only a PreToolUse entry of ours counts: the short text promises compaction', async () => {
    const wired = wire({}, HOOKS_DIR) as { hooks: Record<string, unknown> };
    writeSettings(path.join(userDir, 'settings.json'), {
      hooks: { SessionStart: wired.hooks.SessionStart },
    });
    expect(await claudeCodeHooksWired(env())).toBe(false);
  });

  it('hooks switched off by disableAllHooks do not count, and the latest file decides', async () => {
    const user = path.join(userDir, 'settings.json');
    const local = path.join(project, '.claude', 'settings.local.json');
    writeSettings(user, { ...wire({}, HOOKS_DIR), disableAllHooks: true });
    expect(await claudeCodeHooksWired(env())).toBe(false);
    // A project-local file re-enabling them outranks the user file.
    writeSettings(local, { disableAllHooks: false });
    expect(await claudeCodeHooksWired(env())).toBe(true);
    // And a project-local disable outranks a user file that wires them.
    writeSettings(user, wire({}, HOOKS_DIR));
    writeSettings(local, { disableAllHooks: true });
    expect(await claudeCodeHooksWired(env())).toBe(false);
  });

  it('a plugin install keeps the short text whatever the settings say', () => {
    expect(instructionsFor({ CLAUDE_PLUGIN_ROOT: '/p' }, false)).toBe(
      PLUGIN_INSTRUCTIONS
    );
  });
});

describe('every hooked client gets the short text, not only Claude Code', () => {
  const SHIPPED = path.join(process.cwd(), 'src', 'integrations');
  let dir: string;
  let home: string;
  let project: string;
  const env = {} as NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'to-clients-'));
    home = path.join(dir, 'home');
    project = path.join(dir, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Copies a file this package ships to where its install guide puts it. */
  const ship = (from: string, to: string) => {
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(path.join(SHIPPED, from), to);
  };
  const touch = (file: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{}');
  };
  const wired = (client: HookedClient) =>
    hooksWiredFor(client, { env, home, project });

  // Each install exactly as its guide describes it, from the shipped files.
  const installs: [HookedClient, () => void][] = [
    [
      'codex',
      () =>
        ship('codex/hooks/hooks.json', path.join(home, '.codex', 'hooks.json')),
    ],
    [
      'codex',
      () =>
        touch(
          path.join(
            home,
            '.codex',
            'plugins',
            'cache',
            'market',
            'token-optimizer',
            '7.11.0',
            'hooks',
            'hooks.json'
          )
        ),
    ],
    [
      'copilot',
      () =>
        ship(
          'copilot/.github/hooks/token-optimizer.json',
          path.join(project, '.github', 'hooks', 'token-optimizer.json')
        ),
    ],
    [
      'cursor',
      () =>
        ship('cursor/hooks.json', path.join(project, '.cursor', 'hooks.json')),
    ],
    [
      'windsurf',
      () =>
        ship(
          'windsurf/hooks.json',
          path.join(project, '.windsurf', 'hooks.json')
        ),
    ],
    [
      'cline',
      () =>
        ship(
          'cline/hooks/PreToolUse',
          path.join(project, '.clinerules', 'hooks', 'PreToolUse')
        ),
    ],
    [
      'opencode',
      () =>
        ship(
          'opencode/.opencode/plugins/token-optimizer.js',
          path.join(project, '.opencode', 'plugins', 'token-optimizer.js')
        ),
    ],
    [
      'kilo',
      () =>
        ship(
          'kilo/.kilo/plugin/token-optimizer.js',
          path.join(project, '.kilo', 'plugin', 'token-optimizer.js')
        ),
    ],
    [
      'gemini',
      () =>
        ship(
          'gemini/hooks/hooks.json',
          path.join(
            home,
            '.gemini',
            'extensions',
            'token-optimizer',
            'hooks',
            'hooks.json'
          )
        ),
    ],
    [
      'qwen',
      () =>
        ship(
          'qwen/hooks/hooks.json',
          path.join(
            home,
            '.qwen',
            'extensions',
            'token-optimizer',
            'hooks',
            'hooks.json'
          )
        ),
    ],
  ];

  it.each(installs)(
    '%s: wired by its shipped config, and not before it',
    async (client, install) => {
      expect(await wired(client)).toBe(false);
      install();
      expect(await wired(client)).toBe(true);
    }
  );

  it.each([['gemini'], ['qwen']] as [HookedClient][])(
    '%s: an installed extension with hooks switched off in settings is not wired',
    async (client) => {
      const dot = client === 'gemini' ? '.gemini' : '.qwen';
      ship(
        `${client}/hooks/hooks.json`,
        path.join(
          home,
          dot,
          'extensions',
          'token-optimizer',
          'hooks',
          'hooks.json'
        )
      );
      expect(await wired(client)).toBe(true);
      // User settings switch hooks off.
      mkdirSync(path.join(home, dot), { recursive: true });
      writeFileSync(
        path.join(home, dot, 'settings.json'),
        JSON.stringify({ hooksConfig: { enabled: false } })
      );
      expect(await wired(client)).toBe(false);
      // The workspace file outranks the user file.
      mkdirSync(path.join(project, dot), { recursive: true });
      writeFileSync(
        path.join(project, dot, 'settings.json'),
        JSON.stringify({ hooksConfig: { enabled: true } })
      );
      expect(await wired(client)).toBe(true);
    }
  );

  it("a config that names someone else's hooks is not ours", async () => {
    mkdirSync(path.join(project, '.cursor'), { recursive: true });
    writeFileSync(
      path.join(project, '.cursor', 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          preToolUse: [{ command: 'node .cursor/hooks/other/pre-tool.mjs' }],
        },
      })
    );
    expect(await wired('cursor')).toBe(false);
    // Hook files composed but never named in any config are not wired either.
    touch(path.join(home, '.codex', 'hooks', 'pre-tool.mjs'));
    expect(await wired('codex')).toBe(false);
  });

  it.each([
    ['codex-mcp-client', 'codex'],
    ['gemini-cli-mcp-client', 'gemini'],
    ['qwen-code-mcp-client', 'qwen'],
    ['cursor-vscode', 'cursor'],
    ['windsurf-client', 'windsurf'],
    ['github-copilot-cli', 'copilot'],
    ['opencode', 'opencode'],
    ['kilo-code', 'kilo'],
    ['Cline', 'cline'],
    ['claude-code', 'claude-code'],
    ['roo-cline', null],
    ['zed', null],
    ['', null],
  ])('the handshake name %s is %s', (name, client) => {
    expect(hookedClientFor(name, {})).toBe(client);
  });

  it('each client gets the text that is true for it', async () => {
    ship('cursor/hooks.json', path.join(project, '.cursor', 'hooks.json'));
    const cursor = await instructionsForClient('cursor-vscode', env, {
      home,
      project,
    });
    expect(cursor).toBe(HOOKED_INSTRUCTIONS);
    // No compaction promised and no ToolSearch: only Claude Code does those.
    expect(cursor).not.toMatch(/compacted|ToolSearch/);
    // A hooked client with no hooks here, and an unknown client, keep the long text.
    const codex = await instructionsForClient('codex-mcp-client', env, {
      home,
      project,
    });
    expect(codex).toContain('mandatory routing policy');
    expect(
      await instructionsForClient('zed', env, { home, project })
    ).toContain('mandatory routing policy');
    // A Claude Code plugin install is still decided by its own marker.
    expect(
      await instructionsForClient(
        'anything',
        { CLAUDE_PLUGIN_ROOT: '/p' },
        { home, project }
      )
    ).toBe(PLUGIN_INSTRUCTIONS);
  });
});
