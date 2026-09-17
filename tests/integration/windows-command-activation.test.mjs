import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { activateWindowsCommands } from '../../scripts/windows-commands.mjs';
import { repairCodexStartup } from '../../scripts/codex-startup.mjs';

function fixture(fn) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'optimizer-command-'));
  let path = 'existing;other';
  const options = { root: resolve('.'), directory, platform: 'win32', env: {}, registry: {
    read: () => path, write: (value) => { path = value; },
  } };
  try { fn(options); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

describe('Windows managed commands', () => {
  it('rolls back launchers and ownership when PATH installation fails', () => fixture((options) => {
    options.registry.write = () => { throw new Error('registry is read-only'); };
    expect(() => activateWindowsCommands(options)).toThrow('activation failed');
    expect(fs.readdirSync(options.directory)).toEqual([]);
    expect(options.registry.read()).toBe('existing;other');
  }));
  it('installs idempotently and removes only its own PATH entry', () => fixture((options) => {
    activateWindowsCommands(options);
    expect(options.registry.read()).toBe(`${options.directory};existing;other`);
    expect(activateWindowsCommands(options)).toEqual([]);
    options.registry.write(`${options.registry.read()};later`);
    activateWindowsCommands({ ...options, remove: true, apply: false });
    expect(fs.existsSync(join(options.directory, 'codex.cmd'))).toBe(true);
    activateWindowsCommands({ ...options, remove: true });
    expect(options.registry.read()).toBe('existing;other;later');
    expect(fs.existsSync(join(options.directory, 'codex.cmd'))).toBe(false);
  }));

  it('refuses changed launchers before changing any file or PATH', () => fixture((options) => {
    activateWindowsCommands(options);
    const file = join(options.directory, 'opencode.cmd');
    fs.appendFileSync(file, 'rem my change\n');
    const original = fs.readFileSync(join(options.directory, 'claude.cmd'));
    expect(() => activateWindowsCommands({ ...options, remove: true })).toThrow('edited');
    expect(fs.readFileSync(join(options.directory, 'claude.cmd'))).toEqual(original);
    expect(options.registry.read()).toContain(options.directory);
  }));

  (process.platform === 'win32' ? it : it.skip)('runs from cmd without a profile or recursion and preserves arguments', () => fixture((options) => {
    const fakeRoot = join(options.directory, 'package');
    fs.mkdirSync(join(fakeRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(join(fakeRoot, 'scripts/run-client.mjs'), 'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode=7;');
    activateWindowsCommands({ ...options, root: fakeRoot });
    try {
      execFileSync('cmd.exe', ['/d', '/s', '/c', 'codex "space & literal"'], {
        cwd: options.directory, windowsHide: true, windowsVerbatimArguments: true, encoding: 'utf8',
      });
      throw new Error('Expected child exit status 7');
    } catch (error) {
      expect(error.status).toBe(7);
      expect(JSON.parse(error.stdout)).toEqual(['codex', 'space & literal']);
    }
  }));
});

describe('Codex startup installation', () => {
  it('repairs only the existing registration and preserves comments and unrelated settings', () => fixture(({ directory }) => {
    const file = join(directory, 'config.toml');
    const before = '# keep\nmodel="existing"\n[mcp_servers."token-optimizer"]\ncommand="node"\n[mcp_servers.other]\ncommand="other"\n';
    fs.writeFileSync(file, before);
    expect(repairCodexStartup(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(before.replace('command="node"', 'startup_timeout_sec = 60\ncommand="node"'));
    expect(repairCodexStartup(file)).toBe(false);
    expect(fs.readFileSync(`${file}.before-token-optimizer-startup`, 'utf8')).toBe(before);
  }));

  it('respects explicit startup budgets and refuses malformed TOML', () => fixture(({ directory }) => {
    const file = join(directory, 'config.toml');
    for (const budget of ['startup_timeout_sec=12', 'startup_timeout_ms=12000']) {
      const before = `[mcp_servers.token-optimizer]\n${budget}\n`;
      fs.writeFileSync(file, before);
      expect(repairCodexStartup(file)).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    }
    fs.writeFileSync(file, '[broken');
    expect(() => repairCodexStartup(file)).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('[broken');
  }));
});
