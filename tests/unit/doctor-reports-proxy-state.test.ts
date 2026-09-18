import { describe, it, expect } from '@jest/globals';
import { probeProxy } from '../../hooks-core/doctor.mjs';
import { proxyEnvFor, CLIENT_PROXY_ENV } from '../../hooks-core/capabilities.mjs';

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
    // WARN, not FAIL: the handshake identity says which client is connected, not that anyone asked
    // for routed traffic. Only token-optimizer-run sets TOKEN_OPTIMIZER_CLIENT.
    expect(checks[0].warn).toBe(true);
    expect(checks[0].pass).toBe(true);
    expect(detailOf(checks)).toContain('OPENAI_BASE_URL');
    expect(detailOf(checks)).toContain('token-optimizer-run codex');
    expect(detailOf(checks)).not.toContain('no supported way');
  });

  it('does not classify an unidentified MCP host as an unsupported client', () => {
    const checks = probeProxy({});
    expect(checks[0].warn).toBe(true);
    expect(detailOf(checks)).toContain('routing is unverified');
  });

  it('a plain plugin install is not reported as a broken installation', () => {
    // The default install -- /plugin, MCP server, no token-optimizer-run -- never points a client
    // at the proxy. Reporting that as a failure made install_doctor say "Something above is broken"
    // for every user who followed the documented instructions.
    for (const client of ['claude-code', 'codex', 'opencode']) {
      const checks = probeProxy({}, { clientName: client });
      expect(checks[0].pass).toBe(true);
      expect(checks[0].warn).toBe(true);
      expect(detailOf(checks)).toContain('token-optimizer-run');
    }
  });

  it('a whitespace-only TOKEN_OPTIMIZER_CLIENT does not become a client name', () => {
    // Read raw it is falsy for "did someone ask for routing" and truthy as a name, so the lookup
    // found no variable and the report blamed the client instead of the missing route.
    const checks = probeProxy({ TOKEN_OPTIMIZER_CLIENT: '   ' }, { clientName: 'codex' });
    expect(checks[0].warn).toBe(true);
    expect(detailOf(checks)).toContain('OPENAI_BASE_URL');
    expect(detailOf(checks)).not.toContain('no supported way');
  });

  it('accepts a configured client whatever its spacing or case', () => {
    const checks = probeProxy({ TOKEN_OPTIMIZER_CLIENT: '  Claude-Code  ', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8123' });
    expect(checks[0].pass).toBe(true);
    expect(checks[0].warn).toBeFalsy();
  });

  it('does not disclose upstream credentials in diagnostic output', () => {
    const checks = probeProxy({ TOKEN_OPTIMIZER_CLIENT: 'codex', OPENAI_BASE_URL: 'https://secret@example.com/?key=private' });
    expect(checks[0].pass).toBe(false);
    expect(detailOf(checks)).not.toContain('secret');
    expect(detailOf(checks)).not.toContain('private');
  });
  it('says nothing at all when the whole optimizer is off', () => {
    // A proxy note stacked on top of "everything is off" is noise, which is
    // how probeHarvest already treats the same case.
    expect(probeProxy({ TOKEN_OPTIMIZER_PROXY: '1', TOKEN_OPTIMIZER_MODE: 'off' })).toEqual([]);
  });

  it('passes when the proxy is explicitly disabled', () => {
    const checks = probeProxy({ TOKEN_OPTIMIZER_PROXY: '0' });
    expect(checks).toHaveLength(1);
    expect(checks[0].pass).toBe(true);
    expect(detailOf(checks)).toContain('opts out');
  });

  it('FAILS when the proxy is on but the client was never pointed at it', () => {
    // The silent case. Launched through token-optimizer-run (which is what sets
    // TOKEN_OPTIMIZER_CLIENT), so routing was asked for; enabled and unrouted must not read as
    // healthy, and must not be softened to a warning either.
    const checks = probeProxy({ TOKEN_OPTIMIZER_PROXY: '1', TOKEN_OPTIMIZER_CLIENT: 'claude-code' });
    expect(checks[0].pass).toBe(false);
    expect(checks[0].warn).toBeFalsy();
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
    for (const url of ['http://localhost:8123', 'http://[::1]:8123', 'http://127.9.9.9:8123']) {
      const checks = probeProxy({
        TOKEN_OPTIMIZER_PROXY: '1',
        TOKEN_OPTIMIZER_CLIENT: 'claude-code',
        ANTHROPIC_BASE_URL: url,
      });
      expect(checks[0].pass).toBe(true);
    }
  });

  it('FAILS honestly for a client that cannot be redirected at all', () => {
    const checks = probeProxy({ TOKEN_OPTIMIZER_PROXY: '1', TOKEN_OPTIMIZER_CLIENT: 'zed' });
    expect(checks[0].pass).toBe(false);
    expect(detailOf(checks)).toContain('no supported way to redirect');
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
