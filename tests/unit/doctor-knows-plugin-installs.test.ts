import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// @ts-expect-error -- hooks-core ships as plain ESM with no type declarations.
import {
  detectInstall,
  checklist,
  probeVersion,
} from '../../hooks-core/doctor.mjs';

/**
 * The doctor was written for the script-install path and is blind to plugin
 * installs, which is how the product is actually distributed.
 *
 * Three separate consequences, all observed live on a working 5.3.6 install:
 *
 *   1. "hooks wired into settings: FAIL / no token-optimizer entries found".
 *      Plugin hooks are declared in the plugin's own hooks.json; there is
 *      nothing in settings.json to find, and never will be.
 *   2. "install manifest present: FAIL / no record of what was installed".
 *      Only install-hooks.* writes that manifest. A plugin install has none.
 *   3. `probeEnforcement` resolves the hook binary from the npm package root, so
 *      it validated the 5.3.5 copy bundled with the MCP server while the hooks
 *      Claude Code actually ran came from the plugin cache at 5.3.6 -- 37 files
 *      different. The doctor passed enforcement for a build that was not the one
 *      in use.
 *
 * Two false failures trained the user to distrust a 7/9 score, and the one check
 * that would have caught the real problem -- the installed plugin sitting at
 * 5.0.2 while 5.3.6 was available -- did not exist at all. That skew is the
 * whole "installed it and saved nothing" failure mode: 5.0.2 shipped a single
 * advisory hook, so the plugin was present, listed, and saving nothing.
 */

const PLUGIN_ID = 'token-optimizer@token-optimizer';

let fixture: string;

/** A plugins dir shaped like Claude Code's, with the given installed version. */
function givenPluginInstall(
  installedVersion: string,
  availableVersion: string
) {
  const pluginsDir = join(fixture, '.claude', 'plugins');
  const installPath = join(
    pluginsDir,
    'cache',
    'token-optimizer',
    'token-optimizer',
    installedVersion
  );
  mkdirSync(join(installPath, 'hooks', 'lib'), { recursive: true });
  for (const f of [
    'pretooluse-router.mjs',
    'session-start.mjs',
    'precompact-optimize.mjs',
  ]) {
    writeFileSync(join(installPath, 'hooks', f), '// hook\n');
  }
  writeFileSync(join(installPath, 'hooks', 'hooks.json'), '{}\n');

  writeFileSync(
    join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify({
      version: 1,
      plugins: {
        [PLUGIN_ID]: [
          { scope: 'user', installPath, version: installedVersion },
        ],
      },
    })
  );

  const marketplace = join(
    pluginsDir,
    'marketplaces',
    'token-optimizer',
    'plugin',
    '.claude-plugin'
  );
  mkdirSync(marketplace, { recursive: true });
  writeFileSync(
    join(marketplace, 'plugin.json'),
    JSON.stringify({ name: 'token-optimizer', version: availableVersion })
  );

  return { pluginsDir, installPath };
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'doctor-install-'));
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe('detectInstall', () => {
  it('recognises a plugin install', () => {
    const { pluginsDir } = givenPluginInstall('5.3.6', '5.3.6');
    expect(detectInstall({ pluginsDir, root: fixture }).method).toBe('plugin');
  });

  it('reports the installed and available versions separately', () => {
    // These diverge whenever the marketplace has been updated but the installed
    // record has not -- the state that shipped a dead advisory hook.
    const { pluginsDir } = givenPluginInstall('5.0.2', '5.3.6');
    const install = detectInstall({ pluginsDir, root: fixture });

    expect(install.installedVersion).toBe('5.0.2');
    expect(install.availableVersion).toBe('5.3.6');
  });

  it('points the hooks directory at the plugin, not the npm package', () => {
    // The bug that made enforcement PASS for a build that was not running.
    const { pluginsDir, installPath } = givenPluginInstall('5.3.6', '5.3.6');
    const install = detectInstall({ pluginsDir, root: fixture });

    expect(install.hooksDir).toBe(join(installPath, 'hooks'));
  });

  it('falls back to the package tree when there is no plugin install', () => {
    const pluginsDir = join(fixture, 'no-such-plugins-dir');
    const install = detectInstall({ pluginsDir, root: fixture });

    expect(install.method).not.toBe('plugin');
    expect(install.hooksDir).toBe(join(fixture, 'plugin', 'hooks'));
  });
});

describe('probeVersion', () => {
  it('fails when the installed plugin is behind what is available', () => {
    const { pluginsDir } = givenPluginInstall('5.0.2', '5.3.6');
    const [check] = probeVersion({
      install: detectInstall({ pluginsDir, root: fixture }),
    });

    expect(check.pass).toBe(false);
    expect(check.detail).toContain('5.0.2');
    expect(check.detail).toContain('5.3.6');
  });

  it('passes when installed matches available', () => {
    const { pluginsDir } = givenPluginInstall('5.3.6', '5.3.6');
    const [check] = probeVersion({
      install: detectInstall({ pluginsDir, root: fixture }),
    });

    expect(check.pass).toBe(true);
  });
});

describe('checklist on a plugin install', () => {
  const names = (checks: Array<{ name: string }>) => checks.map((c) => c.name);
  const failedNames = (checks: Array<{ name: string; pass: boolean }>) =>
    checks.filter((c) => !c.pass).map((c) => c.name);

  it('does not demand settings.json entries', () => {
    const { pluginsDir } = givenPluginInstall('5.3.6', '5.3.6');
    const install = detectInstall({ pluginsDir, root: fixture });
    // No settings file at all: a plugin install does not need one.
    const checks = checklist({
      root: fixture,
      settingsPath: join(fixture, 'settings.json'),
      install,
    });

    expect(failedNames(checks)).not.toContain('hooks wired into settings');
    expect(failedNames(checks)).not.toContain('settings file present');
  });

  it('does not demand an install manifest', () => {
    const { pluginsDir } = givenPluginInstall('5.3.6', '5.3.6');
    const install = detectInstall({ pluginsDir, root: fixture });
    const checks = checklist({
      root: fixture,
      settingsPath: undefined,
      install,
    });

    expect(failedNames(checks)).not.toContain('install manifest present');
  });

  it('still reports how the plugin is installed, so the score is explicable', () => {
    // Silently dropping the checks would leave a user unable to tell whether
    // they were skipped or passed. The report has to say which path it took.
    const { pluginsDir } = givenPluginInstall('5.3.6', '5.3.6');
    const install = detectInstall({ pluginsDir, root: fixture });
    const checks = checklist({
      root: fixture,
      settingsPath: undefined,
      install,
    });

    expect(names(checks)).toContain('install method');
  });
});

describe('the doctor cannot pass on a broken install', () => {
  it('a plugin record whose hooks directory is gone does not fall back to the package copy', () => {
    // THE DEFECT: hooksDir fell back to the npm package's own plugin/hooks, which ships with
    // every install (it is in package.json `files`). So the binary-present checks passed, the
    // enforcement probe ran THAT copy and got a real deny back, and the report said
    // "Enforcement is live" -- while Claude Code loads from installPath, which is gone, and
    // enforces nothing. The file's own header records this exact defect as fixed once before.
    const { pluginsDir, installPath } = givenPluginInstall('5.3.6', '5.3.6');
    rmSync(join(installPath, 'hooks'), { recursive: true, force: true });

    const install = detectInstall({ pluginsDir, root: fixture });
    expect(install.method).toBe('plugin');
    // Points at the plugin path that is missing, not at a copy that happens to work.
    expect(install.hooksDir).toContain('5.3.6');
    expect(existsSync(install.hooksDir)).toBe(false);

    // And the checklist must therefore FAIL rather than report the binary present.
    const binaryCheck = checklist({ install, root: fixture })
      .find((c: { name: string }) => c.name === 'hook binary present');
    expect(binaryCheck?.pass).toBe(false);
  });
});
