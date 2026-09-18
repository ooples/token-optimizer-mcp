import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activateShells,
  bashLoginProfile,
} from '../../scripts/managed-shell.mjs';
import { replaceProfile } from '../../scripts/profile-file.mjs';
import { codexRoute } from '../../scripts/run-client.mjs';
import { claudeRoute } from '../../scripts/claude-routing.mjs';
import { claudeManagedRouting } from '../../scripts/managed-policy.mjs';

function fixture(fn) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'optimizer-adversary-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
describe('managed installation adversarial review', () => {
  it('preserves routing controlled by managed files, drop-ins and Windows registry', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'optimizer-managed-policy-'));
    try {
      const options = { directory: dir, platform: 'linux' };
      expect(await claudeManagedRouting(options)).toBe(false);
      fs.writeFileSync(
        join(dir, 'managed-settings.json'),
        JSON.stringify({ permissions: { deny: ['Read(secret)'] } })
      );
      expect(await claudeManagedRouting(options)).toBe(false);
      fs.mkdirSync(join(dir, 'managed-settings.d'));
      fs.writeFileSync(
        join(dir, 'managed-settings.d/20-routing.json'),
        JSON.stringify({
          env: { ANTHROPIC_BASE_URL: 'https://managed.example' },
        })
      );
      expect(await claudeManagedRouting(options)).toBe(true);
      fs.unlinkSync(join(dir, 'managed-settings.d/20-routing.json'));
      expect(
        await claudeManagedRouting({
          ...options,
          platform: 'win32',
          registry: async (hive) =>
            hive === 'HKLM' ? { env: { CLAUDE_CODE_USE_VERTEX: '1' } } : {},
        })
      ).toBe(true);
      expect(
        await claudeManagedRouting({
          ...options,
          platform: 'win32',
          registry: async () => ({}),
        })
      ).toBe(false);
      fs.writeFileSync(join(dir, 'managed-settings.json'), '{invalid');
      expect(await claudeManagedRouting(options)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('preserves first-party Claude tool search without overriding explicit choices', () =>
    fixture((dir) => {
      const args = ['--setting-sources', ''];
      expect(claudeRoute(args, {}, dir).preserveToolSearch).toBe(true);
      expect(
        claudeRoute(args, { ENABLE_TOOL_SEARCH: 'false' }, dir)
          .preserveToolSearch
      ).toBe(false);
      expect(
        claudeRoute(
          args,
          { ANTHROPIC_BASE_URL: 'https://gateway.example' },
          dir
        ).preserveToolSearch
      ).toBe(false);
      expect(
        claudeRoute(
          [...args, '--settings', '{"env":{"ENABLE_TOOL_SEARCH":"auto:5"}}'],
          {},
          dir
        ).preserveToolSearch
      ).toBe(false);
    }));

  it('does not create a higher-priority Bash login profile', () =>
    fixture((dir) => {
      fs.writeFileSync(join(dir, '.profile'), 'export KEEP_THIS=value');
      expect(bashLoginProfile(dir)).toBe(join(dir, '.profile'));
      fs.writeFileSync(join(dir, '.bash_login'), '# existing login');
      expect(bashLoginProfile(dir)).toBe(join(dir, '.bash_login'));
    }));

  it('never guesses an OpenAI API destination for unknown keyring authentication', () =>
    fixture((dir) => {
      fs.writeFileSync(
        join(dir, 'config.toml'),
        'cli_auth_credentials_store="keyring"\n'
      );
      expect(codexRoute([], { CODEX_HOME: dir })).toEqual({ native: true });
    }));
  it('honors Claude settings precedence and provider modes without exposing auth', () =>
    fixture((dir) => {
      fs.mkdirSync(join(dir, '.claude'));
      fs.writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: 'https://user.example',
            ANTHROPIC_API_KEY: 'synthetic-only',
          },
        })
      );
      fs.writeFileSync(
        join(dir, '.claude/settings.json'),
        JSON.stringify({
          env: { ANTHROPIC_BASE_URL: 'https://project.example' },
        })
      );
      const env = {
        CLAUDE_CONFIG_DIR: dir,
        ANTHROPIC_BASE_URL: 'https://shell.example',
      };
      expect(claudeRoute([], env, dir).upstream).toBe(
        'https://project.example'
      );
      expect(
        claudeRoute(['--setting-sources', 'user'], env, dir).upstream
      ).toBe('https://user.example');
      expect(claudeRoute(['--setting-sources', ''], env, dir).upstream).toBe(
        'https://shell.example'
      );
      const route = claudeRoute(
        [
          '--settings',
          JSON.stringify({
            env: { CLAUDE_CODE_USE_VERTEX: '1' },
            permissions: { allow: ['Read'] },
          }),
        ],
        env,
        dir
      );
      expect(route.external).toBe(true);
      expect(route.explicit.permissions.allow).toEqual(['Read']);
      expect(JSON.stringify(route)).not.toContain('synthetic-only');
    }));
  it('preserves UTF-16 PowerShell profiles and byte-faithful backups', () =>
    fixture((dir) => {
      const path = join(dir, 'profile.ps1');
      const original = Buffer.concat([
        Buffer.from([255, 254]),
        Buffer.from('# café\r\n$custom = 123\r\n', 'utf16le'),
      ]);
      fs.writeFileSync(path, original);
      const env = { TOKEN_OPTIMIZER_SHELL_PROFILES: JSON.stringify([path]), TOKEN_OPTIMIZER_MANAGED_CLIENTS: 'claude,codex,opencode' };
      activateShells({ env });
      expect(fs.readFileSync(path).subarray(0, original.length)).toEqual(
        original
      );
      expect(fs.readFileSync(`${path}.before-token-optimizer`)).toEqual(
        original
      );
      expect(activateShells({ env })).toEqual([]);
      activateShells({ env, remove: true });
      expect(fs.readFileSync(path).subarray(0, original.length)).toEqual(
        original
      );
    }));

  it('leaves every profile unchanged if an activation block has user edits', () =>
    fixture((dir) => {
      const a = join(dir, 'a.ps1'),
        b = join(dir, 'b.ps1');
      const env = { TOKEN_OPTIMIZER_SHELL_PROFILES: JSON.stringify([a, b]), TOKEN_OPTIMIZER_MANAGED_CLIENTS: 'claude,codex,opencode' };
      activateShells({ env });
      fs.writeFileSync(
        b,
        fs
          .readFileSync(b, 'utf8')
          .replace(
            'function global:codex',
            '# my modification\nfunction global:codex'
          )
      );
      const before = [a, b].map((p) => fs.readFileSync(p));
      expect(() => activateShells({ env, remove: true })).toThrow('was edited');
      expect([a, b].map((p) => fs.readFileSync(p))).toEqual(before);
      expect(() => activateShells({ env })).toThrow('was edited');
    }));

  it('preserves the original after partial disk-full writes and releases its lock', () =>
    fixture((dir) => {
      const path = join(dir, 'profile.ps1'),
        original = Buffer.from('# indispensable user settings');
      fs.writeFileSync(path, original);
      const io = {
        ...fs,
        writeFileSync(fd, bytes) {
          if (typeof bytes === 'string') return fs.writeFileSync(fd, bytes);
          fs.writeSync(fd, bytes.subarray(0, 3));
          throw Object.assign(new Error('full'), { code: 'ENOSPC' });
        },
      };
      expect(() =>
        replaceProfile(path, original, Buffer.from('replacement'), io)
      ).toThrow('full');
      expect(fs.readFileSync(path)).toEqual(original);
      expect(fs.readdirSync(dir)).toEqual(['profile.ps1']);
      replaceProfile(path, original, Buffer.from('valid update'));
      expect(fs.readFileSync(path, 'utf8')).toBe('valid update');
    }));

  it('rejects concurrent changes instead of silently overwriting them', () =>
    fixture((dir) => {
      const path = join(dir, 'profile.ps1');
      fs.writeFileSync(path, 'newer user settings');
      expect(() =>
        replaceProfile(path, Buffer.from('old'), Buffer.from('ours'))
      ).toThrow('changed during installation');
      expect(fs.readFileSync(path, 'utf8')).toBe('newer user settings');
    }));

  it('honors current profile files and unquoted provider overrides', () =>
    fixture((dir) => {
      fs.writeFileSync(join(dir, 'config.toml'), 'model_provider="openai"\n');
      fs.writeFileSync(
        join(dir, 'company.config.toml'),
        'model_provider="company"\n[model_providers.company]\nbase_url="https://company.example/v1"\nenv_key="COMPANY_KEY"\n'
      );
      const routed = codexRoute(
        ['--profile=company', '-cmodel_provider=company'],
        { CODEX_HOME: dir }
      );
      expect(routed.id).toBe('company');
      expect(routed.upstream).toBe('https://company.example/v1');
      expect(routed.provider.env_key).toBe('COMPANY_KEY');
    }));
});
