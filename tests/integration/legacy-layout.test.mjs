import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  ensureLegacyLayout,
  LEGACY_ENTRIES,
} from '../../src/scripts/legacy-layout.mjs';
import { repairManagedInstall } from '../../src/scripts/repair-managed-install.mjs';

// The root of this package moved under src/ in the release after 7.10.0. Code
// from older versions -- hooks an older installer wrote into settings.json, hook
// copies installed into clients, managed launchers -- names the old paths in an
// installed package and cannot be changed. These tests hold the two things that
// keep it working: the aliases, and the repair that moves settings onto the new
// layout.

const HOOKS = [
  'session-start.mjs',
  'pretooluse-router.mjs',
  'agent-scope.mjs',
  'post-tool.mjs',
  'post-tool-failure.mjs',
  'precompact-optimize.mjs',
  'stop.mjs',
];

/** An installed package in the current layout: everything under src/. */
function installedPackage(dir, version = '9.0.0') {
  fs.mkdirSync(join(dir, 'src', 'plugin', 'hooks'), { recursive: true });
  fs.mkdirSync(join(dir, 'src', 'integrations', 'codex', 'hooks'), { recursive: true });
  fs.mkdirSync(join(dir, 'src', 'scripts'), { recursive: true });
  fs.mkdirSync(join(dir, 'src', 'hooks-core'), { recursive: true });
  fs.writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@ooples/token-optimizer-mcp', version })
  );
  for (const hook of HOOKS)
    fs.writeFileSync(join(dir, 'src', 'plugin', 'hooks', hook), `// ${hook}\n`);
  fs.writeFileSync(join(dir, 'src', 'integrations', 'codex', 'hooks', 'pre-tool.mjs'), '// codex\n');
  fs.writeFileSync(join(dir, 'src', 'scripts', 'run-client.mjs'), '// run-client\n');
  fs.writeFileSync(join(dir, 'src', 'hooks-core', 'wiki.mjs'), '// wiki\n');
  return dir;
}

describe('old-layout aliases in an installed package', () => {
  let base;
  beforeEach(() => {
    base = fs.mkdtempSync(join(tmpdir(), 'to-legacy-'));
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('makes every path an older version names resolve to the file under src/', () => {
    const pkg = installedPackage(join(base, 'pkg'));
    expect(ensureLegacyLayout(pkg).sort()).toEqual([...LEGACY_ENTRIES].sort());
    // The exact paths older code runs, read through the alias.
    expect(fs.readFileSync(join(pkg, 'plugin', 'hooks', 'stop.mjs'), 'utf8')).toBe('// stop.mjs\n');
    expect(fs.readFileSync(join(pkg, 'integrations', 'codex', 'hooks', 'pre-tool.mjs'), 'utf8')).toBe('// codex\n');
    expect(fs.readFileSync(join(pkg, 'scripts', 'run-client.mjs'), 'utf8')).toBe('// run-client\n');
    expect(fs.readFileSync(join(pkg, 'hooks-core', 'wiki.mjs'), 'utf8')).toBe('// wiki\n');
    // One set of files: an edit through the new path is what the old path reads.
    fs.writeFileSync(join(pkg, 'src', 'plugin', 'hooks', 'stop.mjs'), '// changed\n');
    expect(fs.readFileSync(join(pkg, 'plugin', 'hooks', 'stop.mjs'), 'utf8')).toBe('// changed\n');
  });

  it('runs an old-layout hook path end to end', () => {
    const pkg = installedPackage(join(base, 'pkg'));
    fs.writeFileSync(join(pkg, 'src', 'plugin', 'hooks', 'stop.mjs'), "process.stdout.write('ran');\n");
    ensureLegacyLayout(pkg);
    const out = execFileSync(process.execPath, [join(pkg, 'plugin', 'hooks', 'stop.mjs')], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(out).toBe('ran');
  });

  it('is idempotent', () => {
    const pkg = installedPackage(join(base, 'pkg'));
    ensureLegacyLayout(pkg);
    expect(ensureLegacyLayout(pkg)).toEqual([]);
  });

  it('does nothing in a git checkout', () => {
    const pkg = installedPackage(join(base, 'pkg'));
    fs.writeFileSync(join(pkg, '.git'), 'gitdir: elsewhere\n');
    expect(ensureLegacyLayout(pkg)).toEqual([]);
    for (const name of LEGACY_ENTRIES) expect(fs.existsSync(join(pkg, name))).toBe(false);
  });

  it('never replaces a real directory at an old path', () => {
    const pkg = installedPackage(join(base, 'pkg'));
    fs.mkdirSync(join(pkg, 'plugin'));
    fs.writeFileSync(join(pkg, 'plugin', 'mine.txt'), 'keep');
    expect(ensureLegacyLayout(pkg)).not.toContain('plugin');
    expect(fs.readFileSync(join(pkg, 'plugin', 'mine.txt'), 'utf8')).toBe('keep');
  });

  it('replaces an alias that no longer resolves, as a renamed package leaves one', () => {
    const staging = installedPackage(join(base, 'staging'));
    ensureLegacyLayout(staging);
    const final = join(base, 'versions', '9.0.0');
    fs.mkdirSync(join(base, 'versions'));
    fs.renameSync(staging, final);
    ensureLegacyLayout(final);
    // Wherever the first set pointed, the healed set reads the renamed package.
    expect(fs.realpathSync(join(final, 'plugin'))).toBe(fs.realpathSync(join(final, 'src', 'plugin')));
    expect(fs.readFileSync(join(final, 'plugin', 'hooks', 'stop.mjs'), 'utf8')).toBe('// stop.mjs\n');
  });

  it('runs from the command line, as the launcher and postinstall call it', () => {
    const pkg = installedPackage(join(base, 'pkg'));
    execFileSync(process.execPath, ['src/scripts/legacy-layout.mjs', pkg], { windowsHide: true });
    expect(fs.existsSync(join(pkg, 'scripts', 'run-client.mjs'))).toBe(true);
  });
});

describe('the repair moves an older install onto the new layout', () => {
  let base;
  beforeEach(() => {
    base = fs.mkdtempSync(join(tmpdir(), 'to-legacy-repair-'));
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const env = { TOKEN_OPTIMIZER_MANAGED_CLIENTS: '0' };
  const hookCommand = (path) => `node "${path.replaceAll('\\', '/')}" --token-optimizer-hook`;
  const settingsWith = (settingsPath, command) =>
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } })
    );
  const stopCommand = (settingsPath) =>
    JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.Stop[0].hooks[0].command;

  it('rewrites an old-layout hook path in the same package, upgraded in place', () => {
    const pkg = installedPackage(join(base, 'pkg'));
    const settingsPath = join(base, 'settings.json');
    settingsWith(settingsPath, hookCommand(join(pkg, 'plugin', 'hooks', 'stop.mjs')));
    expect(repairManagedInstall({ root: pkg, env, settingsPath, profiles: () => [] })).toContain(settingsPath);
    expect(stopCommand(settingsPath)).toBe(hookCommand(join(pkg, 'src', 'plugin', 'hooks', 'stop.mjs')));
    // And leaves it alone once it is current.
    expect(repairManagedInstall({ root: pkg, env, settingsPath, profiles: () => [] })).toEqual([]);
  });

  it.each(HOOKS)('moves %s, so no hook the installer wires is left on an alias', (hook) => {
    // FOUND BY A REAL 7.10.0 UPGRADE. The matcher's list of hook names predated
    // post-tool-failure.mjs, so that one entry stayed on the old path while the
    // other six moved -- working only through the alias.
    const pkg = installedPackage(join(base, 'pkg'));
    const settingsPath = join(base, 'settings.json');
    settingsWith(settingsPath, hookCommand(join(pkg, 'plugin', 'hooks', hook)));
    repairManagedInstall({ root: pkg, env, settingsPath, profiles: () => [] });
    expect(stopCommand(settingsPath)).toBe(hookCommand(join(pkg, 'src', 'plugin', 'hooks', hook)));
  });

  it('moves an older package in the old layout to this one in the new layout', () => {
    const old = join(base, 'old');
    fs.mkdirSync(join(old, 'plugin', 'hooks'), { recursive: true });
    fs.writeFileSync(join(old, 'package.json'), JSON.stringify({ name: '@ooples/token-optimizer-mcp', version: '7.10.0' }));
    fs.writeFileSync(join(old, 'plugin', 'hooks', 'stop.mjs'), '');
    const pkg = installedPackage(join(base, 'pkg'));
    const settingsPath = join(base, 'settings.json');
    settingsWith(settingsPath, hookCommand(join(old, 'plugin', 'hooks', 'stop.mjs')));
    repairManagedInstall({ root: pkg, env, settingsPath, profiles: () => [] });
    expect(stopCommand(settingsPath)).toBe(hookCommand(join(pkg, 'src', 'plugin', 'hooks', 'stop.mjs')));
  });

  it('does not move a newer package back', () => {
    const newer = installedPackage(join(base, 'newer'), '99.0.0');
    const pkg = installedPackage(join(base, 'pkg'), '9.0.0');
    const settingsPath = join(base, 'settings.json');
    const command = hookCommand(join(newer, 'src', 'plugin', 'hooks', 'stop.mjs'));
    settingsWith(settingsPath, command);
    repairManagedInstall({ root: pkg, env, settingsPath, profiles: () => [] });
    expect(stopCommand(settingsPath)).toBe(command);
  });
});
