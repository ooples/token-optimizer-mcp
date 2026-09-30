/**
 * The update check answers three questions, and getting any of them wrong is
 * worse than not asking: a wrong install method hands the reader a command that
 * silently does nothing, a backwards prerelease comparison tells someone on an
 * rc that they are ahead of the release superseding them, and a reassuring
 * "up to date" printed from a failed lookup becomes their evidence that they
 * looked.
 */
import { describe, it, expect } from '@jest/globals';
import {
  InstallMethod,
  detectInstallMethod,
  upgradeCommand,
} from '../../../src/update/install-method.js';
import {
  compareVersions,
  latestUrl,
  latestVersion,
  registryBase,
} from '../../../src/update/latest.js';
import {
  UpdateState,
  checkForUpdate,
  describeUpdate,
} from '../../../src/update/check.js';

const at = (path: string): string => `file:///${path.replace(/\\/g, '/')}`;

const answering = (body: unknown, ok = true): typeof fetch =>
  (async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;

describe('which install this is', () => {
  it('reads a windows global install off its own path', () => {
    expect(
      detectInstallMethod(
        at('C:/Users/x/AppData/Roaming/npm/node_modules/@ooples/token-optimizer-mcp/dist/update')
      )
    ).toBe(InstallMethod.GlobalNpm);
  });

  it('reads a posix global install off its own path', () => {
    expect(
      detectInstallMethod(
        at('/usr/local/lib/node_modules/@ooples/token-optimizer-mcp/dist/update')
      )
    ).toBe(InstallMethod.GlobalNpm);
  });

  it('separates a project dependency from a global one', () => {
    expect(
      detectInstallMethod(
        at('C:/work/app/node_modules/@ooples/token-optimizer-mcp/dist/update')
      )
    ).toBe(InstallMethod.ProjectDependency);
  });

  it('recognises an npx cache entry, which is replaced rather than upgraded', () => {
    expect(
      detectInstallMethod(
        at('C:/Users/x/AppData/Local/npm-cache/_npx/a1b2/node_modules/@ooples/token-optimizer-mcp/dist')
      )
    ).toBe(InstallMethod.NpxCache);
  });

  it('puts a plugin install ahead of the node_modules it also sits in', () => {
    // A plugin copy lives under a node_modules too, so the order of these two
    // checks is the whole behaviour: answering ProjectDependency here hands the
    // reader an npm install that updates a directory the loader never reads.
    expect(
      detectInstallMethod(
        at('C:/Users/x/.claude/plugins/token-optimizer/node_modules/@ooples/token-optimizer-mcp/dist')
      )
    ).toBe(InstallMethod.ClaudePlugin);
  });

  it('calls a checkout a checkout when there is no node_modules above it', () => {
    expect(detectInstallMethod(at('C:/src/token-optimizer-mcp/dist/update'))).toBe(
      InstallMethod.SourceCheckout
    );
  });

  it('answers Unknown for a url that is not a file, rather than throwing', () => {
    expect(detectInstallMethod('https://example.test/dist/update')).toBe(
      InstallMethod.Unknown
    );
  });
});

describe('what it tells the reader to run', () => {
  it('gives each npm-placed install the command that actually moves it', () => {
    expect(upgradeCommand(InstallMethod.GlobalNpm)).toContain('install -g');
    expect(upgradeCommand(InstallMethod.ProjectDependency)).toBe(
      'npm install @ooples/token-optimizer-mcp@latest'
    );
    expect(upgradeCommand(InstallMethod.NpxCache)).toContain('npx');
    expect(upgradeCommand(InstallMethod.ClaudePlugin)).toBe(
      '/plugin update token-optimizer'
    );
  });

  it('suggests nothing for an install it did not place', () => {
    // Printing a plausible `npm install -g` for a git checkout would replace a
    // developer's working tree with a published copy.
    expect(upgradeCommand(InstallMethod.SourceCheckout)).toBeNull();
    expect(upgradeCommand(InstallMethod.Unknown)).toBeNull();
  });
});

describe('ordering two releases', () => {
  it('orders the numbers before anything else', () => {
    expect(compareVersions('7.3.0', '7.4.0')).toBe(-1);
    expect(compareVersions('7.10.0', '7.9.0')).toBe(1);
    expect(compareVersions('7.3.0', '7.3.0')).toBe(0);
  });

  it('sorts a prerelease before the release it leads to', () => {
    expect(compareVersions('7.4.0-rc.1', '7.4.0')).toBe(-1);
    expect(compareVersions('7.4.0', '7.4.0-rc.1')).toBe(1);
  });

  it('compares numeric prerelease identifiers numerically, not as strings', () => {
    expect(compareVersions('7.4.0-rc.2', '7.4.0-rc.10')).toBe(-1);
  });

  it('ignores build metadata, which semver says does not order', () => {
    expect(compareVersions('7.3.0+abc', '7.3.0+zzz')).toBe(0);
  });

  it('refuses a string that is not a version rather than guessing an order', () => {
    expect(compareVersions('unknown', '7.3.0')).toBeNull();
    expect(compareVersions('7.3', '7.3.0')).toBeNull();
  });
});

describe('where it asks', () => {
  it('encodes the scope separator, which is a different route unencoded', () => {
    expect(latestUrl('@ooples/token-optimizer-mcp', {})).toBe(
      'https://registry.npmjs.org/@ooples%2ftoken-optimizer-mcp/latest'
    );
  });

  it('encodes every separator, not just the first one', () => {
    // A valid npm name carries one slash, so a replace that stopped after the
    // first was right for every name this package actually asks about and
    // wrong for the one it was handed. What survives an incomplete encoding is
    // not a malformed URL -- it is a well-formed request to a different path,
    // built out of the tail of whatever name came in.
    expect(latestUrl('@scope/name/extra', {})).toBe(
      'https://registry.npmjs.org/@scope%2fname%2fextra/latest'
    );
  });

  it('control: stopping at the first separator leaves the rest standing', () => {
    // The shape that was there, stated outright, so the case above is known to
    // be testing something: this is what the assertion would have read before.
    expect('@scope/name/extra'.replace('/', '%2f')).toBe('@scope%2fname/extra');
  });

  it('follows a configured https mirror and trims its trailing slash', () => {
    expect(registryBase({ npm_config_registry: 'https://npm.internal.test/' })).toBe(
      'https://npm.internal.test'
    );
  });

  it('ignores a mirror that is not https, which is npm policy and not ours', () => {
    expect(registryBase({ npm_config_registry: 'http://npm.internal.test' })).toBe(
      'https://registry.npmjs.org'
    );
    expect(registryBase({ npm_config_registry: 'not a url' })).toBe(
      'https://registry.npmjs.org'
    );
  });
});

describe('what it refuses to ask', () => {
  it('makes no request at all when DO_NOT_TRACK is set', async () => {
    let called = 0;
    const fetcher = (async () => {
      called += 1;
      return {} as unknown as Response;
    }) as unknown as typeof fetch;
    const got = await latestVersion({ env: { DO_NOT_TRACK: '1' }, fetcher });
    expect(called).toBe(0);
    expect(got.refused).toContain('DO_NOT_TRACK');
  });

  it('honours its own off switch', async () => {
    let called = 0;
    const fetcher = (async () => {
      called += 1;
      return {} as unknown as Response;
    }) as unknown as typeof fetch;
    const got = await latestVersion({
      env: { TOKEN_OPTIMIZER_UPDATE_CHECK: '0' },
      fetcher,
    });
    expect(called).toBe(0);
    expect(got.refused).toContain('disabled');
  });

  it('reports a registry that answers badly instead of inventing a version', async () => {
    const got = await latestVersion({ env: {}, fetcher: answering({}, false) });
    expect(got.version).toBeUndefined();
    expect(got.refused).toContain('500');
  });

  it('reports a body with no version rather than treating it as current', async () => {
    const got = await latestVersion({ env: {}, fetcher: answering({ name: 'x' }) });
    expect(got.refused).toContain('without a version');
  });

  it('turns a thrown request into a reason, since being offline is normal', async () => {
    const fetcher = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;
    const got = await latestVersion({ env: {}, fetcher });
    expect(got.refused).toContain('ENOTFOUND');
  });
});

describe('the line doctor prints', () => {
  const posix = at('/usr/local/lib/node_modules/@ooples/token-optimizer-mcp/dist/update');

  it('names the command when the copy is behind', async () => {
    const report = await checkForUpdate({
      env: {},
      fetcher: answering({ version: '7.4.0' }),
      moduleUrl: posix,
      installed: '7.3.0',
    });
    expect(report.state).toBe(UpdateState.Behind);
    expect(report.command).toBe('npm install -g @ooples/token-optimizer-mcp@latest');
    expect(describeUpdate(report).join('\n')).toContain('npm install -g');
  });

  it('says current only when it actually compared two versions', async () => {
    const report = await checkForUpdate({
      env: {},
      fetcher: answering({ version: '7.3.0' }),
      moduleUrl: posix,
      installed: '7.3.0',
    });
    expect(report.state).toBe(UpdateState.Current);
    expect(report.command).toBeNull();
  });

  it('never claims current from a lookup that failed', async () => {
    const report = await checkForUpdate({
      env: { DO_NOT_TRACK: '1' },
      moduleUrl: posix,
      installed: '7.3.0',
    });
    expect(report.state).toBe(UpdateState.Unknown);
    const said = describeUpdate(report).join('\n');
    expect(said).toContain('unknown');
    expect(said).not.toContain('the published latest');
  });

  it('names an unreadable installed version as ours, not the registry\u2019s fault', async () => {
    const report = await checkForUpdate({
      env: {},
      fetcher: answering({ version: '7.4.0' }),
      moduleUrl: posix,
      installed: 'unknown',
    });
    expect(report.state).toBe(UpdateState.Unknown);
    expect(report.refused).toContain('installed version could not be read');
  });

  it('reports a prerelease as ahead rather than behind', async () => {
    const report = await checkForUpdate({
      env: {},
      fetcher: answering({ version: '7.3.0' }),
      moduleUrl: posix,
      installed: '7.4.0-rc.1',
    });
    expect(report.state).toBe(UpdateState.Ahead);
    expect(report.command).toBeNull();
  });

  it('suggests nothing for a checkout even when it is behind', async () => {
    const report = await checkForUpdate({
      env: {},
      fetcher: answering({ version: '7.4.0' }),
      moduleUrl: at('C:/src/token-optimizer-mcp/dist/update'),
      installed: '7.3.0',
    });
    expect(report.state).toBe(UpdateState.Behind);
    expect(report.command).toBeNull();
    expect(describeUpdate(report).join('\n')).toContain('not one npm placed');
  });
});