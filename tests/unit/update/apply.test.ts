/**
 * Performing the upgrade -- the half of `update` that changes something.
 *
 * Two assertions here are the load-bearing ones. The anti-drift test pins
 * `upgradeArgv` against `upgradeCommand`, because two hand-written copies of
 * one command is exactly how a tool ends up printing one thing and running
 * another. And every method outside `UPGRADABLE_METHODS` must refuse by name:
 * running `npm install -g` over a source checkout would replace a developer's
 * working tree, and running it for an npx cache entry would report success
 * having upgraded nothing.
 *
 * No test here spawns a package manager. The runner is injected.
 */
import { describe, it, expect } from '@jest/globals';
import {
  UPGRADE_TIMEOUT_MS,
  UpgradeOutcome,
  applyUpdate,
  upgradeArgv,
} from '../../../src/update/apply.js';
import { UpdateState, type UpdateReport } from '../../../src/update/check.js';
import {
  InstallMethod,
  PACKAGE_NAME,
  UPGRADABLE_METHODS,
  upgradeCommand,
} from '../../../src/update/install-method.js';

const ALL_METHODS: readonly InstallMethod[] = Object.freeze([
  InstallMethod.GlobalNpm,
  InstallMethod.NpxCache,
  InstallMethod.ProjectDependency,
  InstallMethod.ClaudePlugin,
  InstallMethod.SourceCheckout,
  InstallMethod.Unknown,
]);

function report(method: InstallMethod, state: UpdateState): UpdateReport {
  return {
    state,
    installed: '7.3.0',
    latest: state === UpdateState.Current ? '7.3.0' : '7.4.0',
    method,
    command: upgradeCommand(method),
    refused: null,
  };
}

/** A runner that records what it was asked to run and succeeds. */
function recorder(stdout = 'added 1 package', stderr = '') {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  return {
    calls,
    run: async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return { stdout, stderr };
    },
  };
}

describe('upgradeArgv', () => {
  it('spells the same command the tool prints, for every install method', () => {
    for (const method of ALL_METHODS) {
      const argv = upgradeArgv(method);
      const printed = upgradeCommand(method);
      if (argv === null) continue;
      expect(argv.join(' ')).toBe(printed);
    }
  });

  it('covers every method the enum has, so a new one cannot be missed', () => {
    expect(ALL_METHODS).toHaveLength(Object.keys(InstallMethod).length);
    const spelled = ALL_METHODS.filter(
      (method) => upgradeArgv(method) !== null
    );
    expect(spelled).toEqual([
      InstallMethod.GlobalNpm,
      InstallMethod.NpxCache,
      InstallMethod.ProjectDependency,
    ]);
  });

  it('names this package and pins the version it installs', () => {
    expect(upgradeArgv(InstallMethod.GlobalNpm)).toEqual([
      'npm',
      'install',
      '-g',
      `${PACKAGE_NAME}@latest`,
    ]);
    expect(upgradeArgv(InstallMethod.ProjectDependency)).toEqual([
      'npm',
      'install',
      `${PACKAGE_NAME}@latest`,
    ]);
  });

  it('never passes an argument that could be read as a flag', () => {
    for (const method of ALL_METHODS) {
      for (const arg of upgradeArgv(method) ?? []) {
        if (arg === '-g' || arg === '-y') continue;
        expect(arg.startsWith('-')).toBe(false);
      }
    }
  });
});

describe('UPGRADABLE_METHODS', () => {
  it('has an argv for every method it admits', () => {
    for (const method of UPGRADABLE_METHODS) {
      expect(upgradeArgv(method)).not.toBeNull();
    }
  });

  it('excludes the npx cache, whose command runs the package rather than upgrading it', () => {
    expect(upgradeArgv(InstallMethod.NpxCache)).not.toBeNull();
    expect(UPGRADABLE_METHODS).not.toContain(InstallMethod.NpxCache);
  });

  it('is frozen, so no caller can widen what this tool will touch', () => {
    expect(Object.isFrozen(UPGRADABLE_METHODS)).toBe(true);
  });
});

describe('applyUpdate', () => {
  it('refuses a source checkout by name, and does not run anything', async () => {
    const { calls, run } = recorder();
    const result = await applyUpdate(
      report(InstallMethod.SourceCheckout, UpdateState.Behind),
      {
        runner: run,
      }
    );
    expect(result.outcome).toBe(UpgradeOutcome.NotOurs);
    expect(result.argv).toBeNull();
    expect(result.message).toContain('source checkout');
    expect(result.message).toContain('pull and rebuild');
    expect(calls).toHaveLength(0);
  });

  it('refuses an npx cache entry and names what to run instead', async () => {
    const result = await applyUpdate(
      report(InstallMethod.NpxCache, UpdateState.Behind),
      {
        runner: recorder().run,
      }
    );
    expect(result.outcome).toBe(UpgradeOutcome.NotOurs);
    expect(result.message).toContain('npx cache entry');
    expect(result.message).toContain(`${PACKAGE_NAME}@latest`);
  });

  it('refuses a plugin install and points at the client that owns it', async () => {
    const result = await applyUpdate(
      report(InstallMethod.ClaudePlugin, UpdateState.Behind),
      {
        runner: recorder().run,
      }
    );
    expect(result.outcome).toBe(UpgradeOutcome.NotOurs);
    expect(result.message).toContain('plugin');
    expect(result.message).toContain('/plugin update token-optimizer');
  });

  it('refuses an install it did not place', async () => {
    const result = await applyUpdate(
      report(InstallMethod.Unknown, UpdateState.Behind),
      {
        runner: recorder().run,
      }
    );
    expect(result.outcome).toBe(UpgradeOutcome.NotOurs);
    expect(result.message).toContain('reinstall it the way you installed it');
  });

  it('refuses every method outside UPGRADABLE_METHODS, with a reason', async () => {
    for (const method of ALL_METHODS) {
      if (UPGRADABLE_METHODS.includes(method)) continue;
      const result = await applyUpdate(report(method, UpdateState.Behind), {
        runner: recorder().run,
      });
      expect(result.outcome).toBe(UpgradeOutcome.NotOurs);
      expect(result.message.length).toBeGreaterThan(20);
    }
  });
});

describe('applyUpdate on an install it can upgrade', () => {
  it('runs the command and reports what it ran plus the output', async () => {
    const { calls, run } = recorder('added 1 package', 'npm warn deprecated');
    const result = await applyUpdate(
      report(InstallMethod.GlobalNpm, UpdateState.Behind),
      {
        runner: run,
      }
    );
    expect(result.outcome).toBe(UpgradeOutcome.Upgraded);
    expect(calls).toEqual([
      { file: 'npm', args: ['install', '-g', `${PACKAGE_NAME}@latest`] },
    ]);
    expect(result.message).toBe(`ran: npm install -g ${PACKAGE_NAME}@latest`);
    expect(result.output).toBe('added 1 package\nnpm warn deprecated');
  });

  it('leaves output null when the command said nothing', async () => {
    const result = await applyUpdate(
      report(InstallMethod.ProjectDependency, UpdateState.Behind),
      {
        runner: recorder('', '').run,
      }
    );
    expect(result.outcome).toBe(UpgradeOutcome.Upgraded);
    expect(result.output).toBe('');
  });

  it('does not reinstall a copy that is already current', async () => {
    const { calls, run } = recorder();
    const result = await applyUpdate(
      report(InstallMethod.GlobalNpm, UpdateState.Current),
      {
        runner: run,
      }
    );
    expect(result.outcome).toBe(UpgradeOutcome.AlreadyCurrent);
    expect(result.message).toContain('--force');
    expect(calls).toHaveLength(0);
  });

  it('reinstalls a current copy when asked with force', async () => {
    const { calls, run } = recorder();
    const result = await applyUpdate(
      report(InstallMethod.GlobalNpm, UpdateState.Current),
      {
        runner: run,
        force: true,
      }
    );
    expect(result.outcome).toBe(UpgradeOutcome.Upgraded);
    expect(calls).toHaveLength(1);
  });

  it('prints the command and runs nothing with dryRun', async () => {
    const { calls, run } = recorder();
    const result = await applyUpdate(
      report(InstallMethod.GlobalNpm, UpdateState.Behind),
      {
        runner: run,
        dryRun: true,
      }
    );
    expect(result.outcome).toBe(UpgradeOutcome.Planned);
    expect(result.message).toBe(
      `would run: npm install -g ${PACKAGE_NAME}@latest`
    );
    expect(calls).toHaveLength(0);
  });

  it('answers AlreadyCurrent before dryRun, so a dry run is not told it would install', async () => {
    const result = await applyUpdate(
      report(InstallMethod.GlobalNpm, UpdateState.Current),
      {
        runner: recorder().run,
        dryRun: true,
      }
    );
    expect(result.outcome).toBe(UpgradeOutcome.AlreadyCurrent);
  });

  it('upgrades when the state is unknown, since a lookup failure is not a reason to stop', async () => {
    const { calls, run } = recorder();
    const result = await applyUpdate(
      report(InstallMethod.GlobalNpm, UpdateState.Unknown),
      {
        runner: run,
      }
    );
    expect(result.outcome).toBe(UpgradeOutcome.Upgraded);
    expect(calls).toHaveLength(1);
  });
});

describe('applyUpdate when the command fails', () => {
  it("reports the command's own stdout and stderr rather than a sentence of ours", async () => {
    const failure = Object.assign(
      new Error('Command failed with exit code 1'),
      {
        stdout: 'npm error code E404',
        stderr: 'npm error 404 Not Found',
      }
    );
    const result = await applyUpdate(
      report(InstallMethod.GlobalNpm, UpdateState.Behind),
      {
        runner: async () => {
          throw failure;
        },
      }
    );
    expect(result.outcome).toBe(UpgradeOutcome.Failed);
    expect(result.message).toContain('Command failed with exit code 1');
    expect(result.output).toBe('npm error code E404\nnpm error 404 Not Found');
    expect(result.argv).toEqual([
      'npm',
      'install',
      '-g',
      `${PACKAGE_NAME}@latest`,
    ]);
  });

  it('still names the command when the failure carried no output', async () => {
    const result = await applyUpdate(
      report(InstallMethod.GlobalNpm, UpdateState.Behind),
      {
        runner: async () => {
          throw new Error('spawn npm ENOENT');
        },
      }
    );
    expect(result.outcome).toBe(UpgradeOutcome.Failed);
    expect(result.message).toContain(`npm install -g ${PACKAGE_NAME}@latest`);
    expect(result.output).toBeNull();
  });

  it('survives a thrown non-error', async () => {
    const result = await applyUpdate(
      report(InstallMethod.GlobalNpm, UpdateState.Behind),
      {
        runner: async () => {
          throw 'nope';
        },
      }
    );
    expect(result.outcome).toBe(UpgradeOutcome.Failed);
    expect(result.message).toContain('nope');
  });
});

describe('UPGRADE_TIMEOUT_MS', () => {
  it('leaves a slow registry room to finish rather than killing a real install', () => {
    expect(UPGRADE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(UPGRADE_TIMEOUT_MS).toBeLessThanOrEqual(600_000);
  });
});
