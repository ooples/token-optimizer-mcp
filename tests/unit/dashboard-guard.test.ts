/**
 * The three defences on the dashboard, each tested against the attack it exists to stop.
 *
 * A guard that is never exercised against a hostile request is a comment. Each case below is
 * written as the attacker's request, not as a happy path with a flag flipped.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import {
  TOKEN_HEADER,
  capabilityToken,
  corsOrigin,
  dashboardHost,
  hostGuard,
  injectToken,
  isExposed,
  requireCapability,
  resetCapabilityToken,
  tokenPath,
} from '../../src/server/dashboard-guard.js';

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dashboard-guard-'));
  env = { TOKEN_OPTIMIZER_HOME: home };
  resetCapabilityToken();
});

afterEach(() => {
  resetCapabilityToken();
  rmSync(home, { recursive: true, force: true });
});

/** A request/response pair that records what the middleware did to it. */
function exchange(method: string, headers: Record<string, string>) {
  const res = {
    statusCode: 0,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  let passed = false;
  return {
    req: { method, headers } as unknown as Request,
    res: res as unknown as Response,
    next: () => {
      passed = true;
    },
    get passed() {
      return passed;
    },
    get status() {
      return res.statusCode;
    },
    get body() {
      return res.body as { code?: string } | null;
    },
  };
}

describe('binding', () => {
  it('defaults to loopback rather than every interface', () => {
    expect(dashboardHost({})).toBe('127.0.0.1');
    expect(isExposed({})).toBe(false);
  });

  it('lets someone opt into network exposure deliberately', () => {
    const on = { TOKEN_OPTIMIZER_DASHBOARD_HOST: '0.0.0.0' };
    expect(dashboardHost(on)).toBe('0.0.0.0');
    expect(isExposed(on)).toBe(true);
  });
});

describe('the DNS-rebinding defence', () => {
  it('refuses a request whose Host is an attacker-controlled name', () => {
    // THE WHOLE POINT. evil.example resolves to 127.0.0.1, so the connection really does arrive on
    // loopback and the browser really does treat it as same-origin -- Origin and Host agree, and a
    // guard that compares them to each other passes it. Only a fixed list catches this.
    const x = exchange('POST', { host: 'evil.example:3100' });
    hostGuard(env)(x.req, x.res, x.next);
    expect(x.passed).toBe(false);
    expect(x.status).toBe(403);
    expect(x.body?.code).toBe('host-not-allowed');
  });

  it('allows the hostnames the dashboard is actually served on', () => {
    for (const host of ['localhost:3100', '127.0.0.1:3100', '[::1]:3100']) {
      const x = exchange('GET', { host });
      hostGuard(env)(x.req, x.res, x.next);
      expect(x.passed).toBe(true);
    }
  });

  it('stands down when the operator asked for network exposure', () => {
    // Otherwise every legitimate request to a deliberately exposed dashboard would be refused.
    const x = exchange('POST', { host: 'build-box.lan:3100' });
    hostGuard({ ...env, TOKEN_OPTIMIZER_DASHBOARD_HOST: '0.0.0.0' })(
      x.req,
      x.res,
      x.next
    );
    expect(x.passed).toBe(true);
  });
});

describe('the capability token', () => {
  it('refuses a mutating request that cannot produce it', () => {
    const x = exchange('POST', { host: 'localhost:3100' });
    requireCapability(env)(x.req, x.res, x.next);
    expect(x.passed).toBe(false);
    expect(x.status).toBe(403);
    expect(x.body?.code).toBe('capability-required');
  });

  it('refuses a near-miss rather than comparing loosely', () => {
    const token = capabilityToken(env);
    const x = exchange('DELETE', {
      host: 'localhost:3100',
      [TOKEN_HEADER]: `${token}x`,
    });
    requireCapability(env)(x.req, x.res, x.next);
    expect(x.passed).toBe(false);
  });

  it('admits a request that echoes it', () => {
    const x = exchange('POST', {
      host: 'localhost:3100',
      [TOKEN_HEADER]: capabilityToken(env),
    });
    requireCapability(env)(x.req, x.res, x.next);
    expect(x.passed).toBe(true);
  });

  it('leaves reads alone, because the dashboard paints before it can send a header', () => {
    const x = exchange('GET', { host: 'localhost:3100' });
    requireCapability(env)(x.req, x.res, x.next);
    expect(x.passed).toBe(true);
  });

  it('is stable across calls and written owner-only', () => {
    const first = capabilityToken(env);
    expect(capabilityToken(env)).toBe(first);
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(readFileSync(tokenPath(env), 'utf8').trim()).toBe(first);
    if (process.platform !== 'win32') {
      // Windows chmod only toggles the read-only bit, so the mode is not meaningful there.
      expect(statSync(tokenPath(env)).mode & 0o777).toBe(0o600);
    }
  });
});

describe('what the page is handed', () => {
  it('puts the token in the HTML, which a cross-origin page cannot read', () => {
    const html = injectToken('<html><head></head><body></body></html>', env);
    expect(html).toContain(capabilityToken(env));
    expect(html).toContain(TOKEN_HEADER);
    // Injected inside head, so the wrapper is installed before any script that calls fetch.
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('</head>'));
  });
});

describe('cross-origin reads', () => {
  const decide = (origin: string | undefined, e = env) =>
    new Promise<boolean>((resolve) => {
      corsOrigin(e)(origin, (_err, ok) => resolve(Boolean(ok)));
    });

  it('refuses a real website, which the old wildcard allowed', async () => {
    await expect(decide('https://evil.example')).resolves.toBe(false);
  });

  it('allows the dashboard talking to itself', async () => {
    await expect(decide('http://localhost:3100')).resolves.toBe(true);
    await expect(decide('http://127.0.0.1:3100')).resolves.toBe(true);
  });

  it('allows a request with no Origin at all, which is not a page', async () => {
    // curl, the CLI, a test. CORS protects a PAGE from reading a response; there is no page here.
    await expect(decide(undefined)).resolves.toBe(true);
  });
});
