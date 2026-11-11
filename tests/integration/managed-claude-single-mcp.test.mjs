/**
 * The managed `claude` launcher must not register a second copy of this
 * product's MCP server when the token-optimizer plugin already provides one.
 *
 * Found live: with the plugin enabled, every session launched through the
 * managed launcher listed all 19 tools twice -- `token-optimizer` (from the
 * launcher's `--mcp-config`) beside `plugin:token-optimizer:token-optimizer`.
 */

import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudePluginProvidesMcp, runClient } from '../../src/scripts/run-client.mjs';

const settings = (dir, body) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), typeof body === 'string' ? body : JSON.stringify(body));
};

describe('one token-optimizer MCP server per Claude Code session', () => {
  it('reads the plugin as enabled from user, project and local settings, in precedence order', () => {
    const root = mkdtempSync(join(tmpdir(), 'single-mcp-'));
    try {
      const config = join(root, 'config');
      const project = join(root, 'project');
      const env = { CLAUDE_CONFIG_DIR: config };
      expect(claudePluginProvidesMcp({ env, projectRoot: project })).toBe(false);

      settings(config, { enabledPlugins: { 'token-optimizer@token-optimizer': true } });
      expect(claudePluginProvidesMcp({ env, projectRoot: project })).toBe(true);

      // A project that switches the plugin off wins over the user setting.
      settings(join(project, '.claude'), { enabledPlugins: { 'token-optimizer@token-optimizer': false } });
      expect(claudePluginProvidesMcp({ env, projectRoot: project })).toBe(false);

      // And local settings win over the project's.
      writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'token-optimizer@token-optimizer': true } }));
      expect(claudePluginProvidesMcp({ env, projectRoot: project })).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a settings file that does not parse says nothing, so the server is still registered', () => {
    const root = mkdtempSync(join(tmpdir(), 'single-mcp-'));
    try {
      settings(join(root, 'config'), '{ not json');
      expect(claudePluginProvidesMcp({ env: { CLAUDE_CONFIG_DIR: join(root, 'config') }, projectRoot: root })).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the launcher passes --mcp-config only when the plugin does not provide the server', async () => {
    const root = mkdtempSync(join(tmpdir(), 'single-mcp-'));
    try {
      const out = join(root, 'args.json');
      const script = join(root, 'fake-claude.mjs');
      writeFileSync(script, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`);
      const launch = async (configDir) => {
        expect(
          await runClient('claude', [script], {
            command: process.execPath,
            env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, TOKEN_OPTIMIZER_HOME: root, TOKEN_OPTIMIZER_PROXY: '0' },
          })
        ).toBe(0);
        return JSON.parse(readFileSync(out, 'utf8'));
      };
      const bare = join(root, 'bare');
      mkdirSync(bare, { recursive: true });
      expect(await launch(bare)).toContain('--mcp-config');

      const withPlugin = join(root, 'with-plugin');
      settings(withPlugin, { enabledPlugins: { 'token-optimizer@token-optimizer': true } });
      expect(await launch(withPlugin)).not.toContain('--mcp-config');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
