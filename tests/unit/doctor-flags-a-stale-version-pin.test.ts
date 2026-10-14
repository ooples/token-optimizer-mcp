import { describe, it, expect } from '@jest/globals';
import { probeVersion, semverBelow } from '../../hooks-core/doctor.mjs';

/**
 * #499's real cause. smart_read's unasked pagination had been fixed for days,
 * yet two agents hit it: a user-level TOKEN_OPTIMIZER_VERSION=7.0.0 pinned the
 * MCP server below the 7.5.0 plugin, and nothing said so. The pin is honoured
 * -- a pin is a pin -- but it must be reported.
 */

type Check = { name: string; pass: boolean; detail?: string };
const named = (checks: Check[], name: string): Check | undefined =>
  checks.find((c) => c.name === name);
const LABEL = 'the served version is not pinned below the plugin';
const install = { method: 'plugin', installedVersion: '7.5.0', sameTree: true };

describe('a version pin below the plugin is reported (#499)', () => {
  it('fails when the pin is older than the installed plugin', () => {
    const check = named(probeVersion({ install, pin: '7.0.0' }), LABEL);
    expect(check).toMatchObject({ pass: false });
    expect(check?.detail).toContain('7.0.0');
    expect(check?.detail).toContain('7.5.0');
  });

  it('says nothing about a pin at or above the plugin', () => {
    expect(
      named(probeVersion({ install, pin: '7.5.0' }), LABEL)
    ).toBeUndefined();
    expect(
      named(probeVersion({ install, pin: '7.6.0' }), LABEL)
    ).toBeUndefined();
  });

  it('says nothing when there is no pin', () => {
    expect(named(probeVersion({ install, pin: '' }), LABEL)).toBeUndefined();
  });

  it('compares against the diagnosed package when the plugin cache is a different tree', () => {
    // An older plugin cache must not hide a pin that starves a newer package.
    const split = {
      method: 'plugin',
      installedVersion: '7.0.0',
      packageVersion: '7.5.0',
      sameTree: false,
    };
    expect(
      named(probeVersion({ install: split, pin: '7.0.0' }), LABEL)
    ).toMatchObject({
      pass: false,
    });
  });
  it('is checked for a non-plugin install too, against the package version', () => {
    const npx = { method: 'npx', packageVersion: '7.5.0' };
    expect(
      named(probeVersion({ install: npx, pin: '7.0.0' }), LABEL)
    ).toMatchObject({
      pass: false,
    });
  });
});

describe('pins are ordered by SemVer precedence (#497 review)', () => {
  it('reports a prerelease pin below its own release', () => {
    expect(
      named(probeVersion({ install, pin: '7.5.0-rc.1' }), LABEL)
    ).toMatchObject({
      pass: false,
    });
  });

  it.each([
    ['7.5.0-rc.1', '7.5.0', true],
    ['7.5.0', '7.5.0-rc.1', false],
    ['7.5.0-rc.1', '7.5.0-rc.2', true],
    ['7.5.0-rc.2', '7.5.0-rc.10', true],
    ['7.5.0-alpha', '7.5.0-alpha.1', true],
    ['7.5.0-1', '7.5.0-alpha', true],
    ['7.0.0', '7.5.0', true],
    ['7.10.0', '7.9.0', false],
    ['7.5.0', '7.5.0', false],
  ])('%s below %s is %s', (a, b, below) => {
    expect(semverBelow(a, b)).toBe(below);
  });
});
