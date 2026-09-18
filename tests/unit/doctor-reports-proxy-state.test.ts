import { describe, it, expect } from '@jest/globals';
import { createServer } from 'node:http';
import { probeProxy, probeSupervisor } from '../../hooks-core/doctor.mjs';
import {
  proxyEnvFor,
  CLIENT_PROXY_ENV,
} from '../../hooks-core/capabilities.mjs';

/**
 * The proxy's failure mode is silence, which is what this reports on.
 *
 * TOKEN_OPTIMIZER_PROXY=1 with the client never pointed at the proxy is the
 * state that costs a user everything and tells them nothing: traffic goes
 * straight to the provider, no savings appear, and no error is raised. A
 * diagnostic that only said "proxy: on" would confirm the wrong half.
 */

const detailOf = (checks: Array<Record<string, unknown>>): string =>
  checks.map((c) => JSON.stringify(c)).join(' ');

describe('probeProxy', () => {
  it('uses the MCP handshake identity when the client environment was filtered', () => {
    const checks = probeProxy({}, { clientName: 'codex-mcp' });
    expect(checks[0].pass).toBe(false);
    expect(detailOf(checks)).toContain('OPENAI_BASE_URL');
    expect(detailOf(checks)).toContain('token-optimizer-run codex');
    expect(detailOf(checks)).not.toContain('no supported way');
  });

  it('does not classify an unidentified MCP host as an unsupported client', () => {
    const checks = probeProxy({});
    expect(checks[0].pass).toBe(false);
    expect(detailOf(checks)).toContain('routing is unverified');
  });

  it('does not disclose upstream credentials in diagnostic output', () => {
    const checks = probeProxy({
      TOKEN_OPTIMIZER_CLIENT: 'codex',
      OPENAI_BASE_URL: 'https://secret@example.com/?key=private',
    });
    expect(checks[0].pass).toBe(false);
    expect(detailOf(checks)).not.toContain('secret');
    expect(detailOf(checks)).not.toContain('private');
  });
  it('says nothing at all when the whole optimizer is off', () => {
    // A proxy note stacked on top of "everything is off" is noise, which is
    // how probeHarvest already treats the same case.
    expect(
      probeProxy({ TOKEN_OPTIMIZER_PROXY: '1', TOKEN_OPTIMIZER_MODE: 'off' })
    ).toEqual([]);
  });

  it('passes when the proxy is explicitly disabled', () => {
    const checks = probeProxy({ TOKEN_OPTIMIZER_PROXY: '0' });
    expect(checks).toHaveLength(1);
    expect(checks[0].pass).toBe(true);
    expect(detailOf(checks)).toContain('opts out');
  });

  it('FAILS when the proxy is on but the client was never pointed at it', () => {
    // The silent case. Enabled and unrouted must not read as healthy.
    const checks = probeProxy({
      TOKEN_OPTIMIZER_PROXY: '1',
      TOKEN_OPTIMIZER_CLIENT: 'claude-code',
    });
    expect(checks[0].pass).toBe(false);
    expect(detailOf(checks)).toContain('ANTHROPIC_BASE_URL');
    expect(detailOf(checks)).toContain('straight to the provider');
  });

  it('FAILS when the variable points somewhere that is not loopback', () => {
    // Pointing a client at a remote "proxy" is not a configuration we can
    // vouch for, and the real proxy binds loopback only.
    const checks = probeProxy({
      TOKEN_OPTIMIZER_PROXY: '1',
      TOKEN_OPTIMIZER_CLIENT: 'claude-code',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
    expect(checks[0].pass).toBe(false);
  });

  it('passes when the proxy is on and the client is routed to loopback', () => {
    const checks = probeProxy({
      TOKEN_OPTIMIZER_PROXY: '1',
      TOKEN_OPTIMIZER_CLIENT: 'claude-code',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8123',
    });
    expect(checks[0].pass).toBe(true);
    expect(detailOf(checks)).toContain('cached prefix is never rewritten');
  });

  it('rejects a host that merely STARTS with localhost', () => {
    // `localhost.attacker.example` is a registrable domain someone else owns.
    // The prefix test this replaces accepted it, so the diagnostic reported
    // traffic safely routed through a local proxy while it was being sent
    // elsewhere with the user's provider credentials attached.
    const checks = probeProxy({
      TOKEN_OPTIMIZER_PROXY: '1',
      TOKEN_OPTIMIZER_CLIENT: 'claude-code',
      ANTHROPIC_BASE_URL: 'http://localhost.attacker.example',
    });
    expect(checks[0].pass).toBe(false);
  });

  it('rejects a host smuggled behind userinfo', () => {
    // Everything before the `@` is userinfo: the host here is the attacker.
    const checks = probeProxy({
      TOKEN_OPTIMIZER_PROXY: '1',
      TOKEN_OPTIMIZER_CLIENT: 'claude-code',
      ANTHROPIC_BASE_URL: 'http://localhost@attacker.example',
    });
    expect(checks[0].pass).toBe(false);
  });

  it('accepts the other genuine loopback spellings', () => {
    // The rejection tests above would pass just as well against a check that
    // rejected everything, so the real forms have to be pinned too.
    for (const url of [
      'http://localhost:8123',
      'http://[::1]:8123',
      'http://127.9.9.9:8123',
    ]) {
      const checks = probeProxy({
        TOKEN_OPTIMIZER_PROXY: '1',
        TOKEN_OPTIMIZER_CLIENT: 'claude-code',
        ANTHROPIC_BASE_URL: url,
      });
      expect(checks[0].pass).toBe(true);
    }
  });

  it('states, without failing, that a client cannot be redirected at all', () => {
    // CHANGED DELIBERATELY, from a failed check to a stated limitation. Zed, Cursor, Cline,
    // Windsurf, Kilo and Roo run the assistant inside the editor process and expose no documented
    // way to redirect its model traffic, so no action by the user could ever make this check pass.
    // Failing it told those users their installation was broken when it was working as designed,
    // and -- worse for a diagnostic -- made a real failure indistinguishable from a property of
    // their editor. It is still reported, and it is still the same explanation.
    const checks = probeProxy({
      TOKEN_OPTIMIZER_PROXY: '1',
      TOKEN_OPTIMIZER_CLIENT: 'zed',
    });
    expect(checks[0].pass).toBe(true);
    expect(checks[0].warn).toBe(true);
    expect(detailOf(checks)).toContain('no supported way');
    expect(checks[0].name).toContain('cannot serve this client');
  });
});

describe('the proxy client table', () => {
  it('covers every supported client with a variable or an explicit null', () => {
    // Same rule as CLIENT_HARVEST_CLI: an omission and a deliberate null must
    // not look alike.
    expect(Object.keys(CLIENT_PROXY_ENV)).toHaveLength(16);
  });

  it('normalises the client key, like every other lookup here', () => {
    expect(proxyEnvFor('CLAUDE-CODE')).toBe('ANTHROPIC_BASE_URL');
    expect(proxyEnvFor('claude-code')).toBe('ANTHROPIC_BASE_URL');
  });

  it('does not reach the prototype', () => {
    for (const key of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(proxyEnvFor(key)).toBeNull();
    }
  });
});

describe('probeSupervisor', () => {
  /**
   * The failure that on-by-default routing can cause, and that nothing else can see.
   *
   * Once a client's own configuration names a loopback URL, probeProxy reads that variable and can
   * only tell that it LOOKS routed. If the proxy behind it is gone -- killed, crashed, uninstalled
   * without our uninstaller -- the client cannot reach its provider at all, and every other check in
   * the report still passes. So this one connects.
   */
  const withServer = async (
    run: (url: string) => Promise<void>
  ): Promise<void> => {
    const server = createServer((_req, res) => res.end('{}'));
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      await run(url);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };

  it('fails when the client is pointed at a loopback port nothing answers', async () => {
    // A port that was bound and then released: exactly the state a dead supervisor leaves behind.
    let dead = '';
    await withServer(async (url) => {
      dead = url;
    });
    const checks = await probeSupervisor(
      {
        TOKEN_OPTIMIZER_PROXY: '1',
        TOKEN_OPTIMIZER_CLIENT: 'claude-code',
        ANTHROPIC_BASE_URL: dead,
      },
      {}
    );
    const failure = checks.find((check) => !check.pass);
    expect(failure).toBeDefined();
    expect(JSON.stringify(failure)).toContain('nothing listening');
    expect(JSON.stringify(failure)).toContain('token-optimizer-uninstall');
  }, 20_000);

  it('says nothing when the route is alive', async () => {
    await withServer(async (url) => {
      const checks = await probeSupervisor(
        {
          TOKEN_OPTIMIZER_PROXY: '1',
          TOKEN_OPTIMIZER_CLIENT: 'claude-code',
          ANTHROPIC_BASE_URL: url,
        },
        {}
      );
      expect(checks.filter((check) => !check.pass)).toEqual([]);
    });
  }, 20_000);

  it('adds no standing warning to an install that simply has no daemon', async () => {
    // A session launched through token-optimizer-run carries its own proxy and needs no daemon, and
    // a client that is not routed at all is already reported by probeProxy with the remedy. Saying
    // it again here would mark working installs as warning forever.
    const checks = await probeSupervisor(
      { TOKEN_OPTIMIZER_PROXY: '1', TOKEN_OPTIMIZER_PROXY_CONTROL_PORT: '1' },
      {}
    );
    expect(checks).toEqual([]);
  }, 20_000);

  it('stays silent when the product is off', async () => {
    expect(await probeSupervisor({ TOKEN_OPTIMIZER_MODE: 'off' }, {})).toEqual(
      []
    );
    expect(await probeSupervisor({ TOKEN_OPTIMIZER_PROXY: '0' }, {})).toEqual(
      []
    );
  });
});
