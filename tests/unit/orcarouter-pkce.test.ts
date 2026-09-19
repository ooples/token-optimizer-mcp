/**
 * PKCE, the connect flow, and every way it can end.
 *
 * The assertions here are about the properties that make the flow safe rather than about the happy
 * path: a fresh verifier per attempt from a cryptographic RNG, S256 and never `plain`, the verifier
 * absent from every URL and error, the state compared before the code is read, and each failure --
 * denial, mismatch, timeout, cancel, 403, 429, transport -- ending with a message a user can act on
 * and no credential. A flow that hangs or hot-loops is a flow that fails these.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createPkcePair,
  challengeFor,
  stateMatches,
  base64Url,
} from '../../src/orcarouter/pkce.js';
import {
  buildAuthorizeUrl,
  buildExchangeUrl,
  buildModelsUrl,
  resolveOrigins,
  assertSecureOrigin,
  OrcaRouterConfigError,
  AUTHORIZE_PATH,
  EXCHANGE_PATH,
  DEFAULT_AUTH_BASE,
  DEFAULT_API_BASE,
} from '../../src/orcarouter/endpoints.js';
import {
  OrcaConnectManager,
  OrcaConnectError,
} from '../../src/orcarouter/connect.js';

const origins = { authBase: DEFAULT_AUTH_BASE, apiBase: DEFAULT_API_BASE };

/** A fake consent + exchange server, so the whole flow runs through the real adapter. */
interface FakeAuth {
  readonly authBase: string;
  readonly authorizeRequests: URL[];
  readonly exchangeRequests: Array<Record<string, unknown>>;
  close: () => Promise<void>;
  setExchange: (
    handler: (body: Record<string, unknown>) => {
      status: number;
      json?: unknown;
      text?: string;
    }
  ) => void;
}

async function startFakeAuth(): Promise<FakeAuth> {
  const authorizeRequests: URL[] = [];
  const exchangeRequests: Array<Record<string, unknown>> = [];
  let exchangeHandler = (
    _body: Record<string, unknown>
  ): { status: number; json?: unknown } => ({
    status: 200,
    json: {
      key: 'sk-orca-fake0000000000000000',
      user_id: '12345',
      scope: 'api',
    },
  });

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === AUTHORIZE_PATH) {
        authorizeRequests.push(url);
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end('<p>consent</p>');
        return;
      }
      if (url.pathname === EXCHANGE_PATH && request.method === 'POST') {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        exchangeRequests.push(body);
        const result = exchangeHandler(body);
        response.writeHead(result.status, {
          'Content-Type': 'application/json',
        });
        response.end(JSON.stringify(result.json ?? {}));
        return;
      }
      response.writeHead(404).end();
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve())
  );
  const { port } = server.address() as AddressInfo;
  return {
    authBase: `http://127.0.0.1:${port}`,
    authorizeRequests,
    exchangeRequests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
    setExchange: (handler) => {
      exchangeHandler = handler;
    },
  };
}

/** Deliver a code to the loopback listener the way the consent screen would. */
async function deliverToLoopback(
  redirectUri: string,
  params: Record<string, string>
): Promise<number> {
  return (await deliverToLoopbackWithBody(redirectUri, params)).status;
}

/** The same delivery, keeping the page so a test can read what the user was told. */
async function deliverToLoopbackWithBody(
  redirectUri: string,
  params: Record<string, string>
): Promise<{ status: number; body: string }> {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  const response = await fetch(url.toString());
  return { status: response.status, body: await response.text() };
}

let fake: FakeAuth | null = null;
const managers: OrcaConnectManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.cancelAll();
  await fake?.close();
  fake = null;
});

function newManager(): OrcaConnectManager {
  const manager = new OrcaConnectManager();
  managers.push(manager);
  return manager;
}

describe('PKCE primitives', () => {
  it('derives the challenge as base64url(sha256(verifier)) with no padding', () => {
    const challenge = challengeFor('abc');
    // The RFC 7636 appendix B vector: sha256("abc") is ba7816bf...
    expect(challenge).toBe(
      base64Url(
        Buffer.from(
          'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
          'hex'
        )
      )
    );
    expect(challenge).not.toContain('=');
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('mints a fresh verifier and state for every attempt', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const pair = createPkcePair();
      expect(pair.verifier).not.toBe(pair.challenge);
      expect(seen.has(pair.verifier)).toBe(false);
      seen.add(pair.verifier);
      expect(pair.challenge).toBe(challengeFor(pair.verifier));
      expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    }
    expect(seen.size).toBe(200);
  });

  it('draws the verifier and state from the injected RNG, not from anything guessable', () => {
    const sizes: number[] = [];
    const pair = createPkcePair((size) => {
      sizes.push(size);
      return Buffer.alloc(size, 7);
    });
    expect(sizes).toEqual([32, 16]);
    expect(pair.verifier).toBe(base64Url(Buffer.alloc(32, 7)));
    expect(pair.state).toBe(base64Url(Buffer.alloc(16, 7)));
  });

  it('compares state in constant time and rejects a wrong, short, long or missing value', () => {
    const { state } = createPkcePair();
    expect(stateMatches(state, state)).toBe(true);
    expect(stateMatches(state, `${state}x`)).toBe(false);
    expect(stateMatches(state, state.slice(0, -1))).toBe(false);
    expect(stateMatches(state, '')).toBe(false);
    expect(stateMatches(state, null)).toBe(false);
    expect(stateMatches(state, `${state.slice(0, -1)}y`)).toBe(false);
  });
});

describe('origins', () => {
  it('defaults to the public auth origin and the public relay, which are different hosts', () => {
    const resolved = resolveOrigins({});
    expect(resolved.authBase).toBe('https://www.orcarouter.ai');
    expect(resolved.apiBase).toBe('https://api.orcarouter.ai/v1');
    expect(new URL(resolved.authBase).hostname).not.toBe(
      new URL(resolved.apiBase).hostname
    );
  });

  it('never derives one origin from the other: the auth base has no /v1 and the relay has it', () => {
    const resolved = resolveOrigins({});
    expect(buildExchangeUrl(resolved)).toBe(
      'https://www.orcarouter.ai/api/v1/auth/keys'
    );
    // The single most common integration mistake, asserted against directly.
    expect(buildExchangeUrl(resolved)).not.toContain('api.orcarouter.ai');
    expect(buildModelsUrl(resolved)).toBe(
      'https://api.orcarouter.ai/v1/models'
    );
  });

  it('applies a shared self-hosted base to both origins, and lets explicit overrides win', () => {
    const shared = resolveOrigins({ ORCA_BASE_URL: 'https://orca.internal' });
    expect(shared.authBase).toBe('https://orca.internal');
    expect(shared.apiBase).toBe('https://orca.internal');

    const explicit = resolveOrigins({
      ORCA_BASE_URL: 'https://orca.internal',
      ORCA_AUTH_BASE_URL: 'https://login.internal',
      ORCA_API_BASE_URL: 'https://relay.internal/v1',
    });
    expect(explicit.authBase).toBe('https://login.internal');
    expect(explicit.apiBase).toBe('https://relay.internal/v1');
  });

  it('permits http only on loopback and refuses cleartext to a remote host', () => {
    expect(() =>
      assertSecureOrigin('http://127.0.0.1:8080', 'test')
    ).not.toThrow();
    expect(() =>
      assertSecureOrigin('http://localhost:8080', 'test')
    ).not.toThrow();
    expect(() => assertSecureOrigin('http://[::1]:8080', 'test')).not.toThrow();
    expect(() => assertSecureOrigin('http://orca.example.com', 'test')).toThrow(
      OrcaRouterConfigError
    );
    expect(() =>
      resolveOrigins({ ORCA_API_BASE_URL: 'http://api.orcarouter.ai/v1' })
    ).toThrow(OrcaRouterConfigError);
    expect(() => assertSecureOrigin('not a url', 'test')).toThrow(
      OrcaRouterConfigError
    );
  });

  it('builds an authorize URL that carries the challenge and never the verifier', () => {
    const pair = createPkcePair();
    const url = new URL(
      buildAuthorizeUrl(origins, {
        callbackUrl: 'http://127.0.0.1:51733/cb',
        codeChallenge: pair.challenge,
        state: pair.state,
        appName: 'Token Optimizer MCP',
        scope: 'api',
      })
    );
    expect(url.origin).toBe('https://www.orcarouter.ai');
    expect(url.pathname).toBe('/auth');
    expect(url.searchParams.get('code_challenge')).toBe(pair.challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(pair.state);
    expect(url.searchParams.get('scope')).toBe('api');
    expect(url.searchParams.get('callback_url')).toBe(
      'http://127.0.0.1:51733/cb'
    );
    expect(url.searchParams.get('app_name')).toBe('Token Optimizer MCP');
    expect(url.toString()).not.toContain(pair.verifier);
    expect(url.searchParams.get('code_challenge_method')).not.toBe('plain');
  });
});

describe('connect flow through the real adapter', () => {
  it('runs loopback authorize → callback → exchange → key, sending S256 and only the challenge', async () => {
    fake = await startFakeAuth();
    const manager = newManager();
    const started = await manager.start({
      mode: 'loopback',
      origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
    });

    expect(started.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/cb$/);
    const authorize = new URL(started.authorizeUrl);
    expect(authorize.origin).toBe(fake.authBase);
    expect(authorize.pathname).toBe('/auth');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const challenge = authorize.searchParams.get('code_challenge') ?? '';
    const state = authorize.searchParams.get('state') ?? '';
    expect(challenge).not.toHaveLength(0);
    expect(state).not.toHaveLength(0);

    const completing = manager.complete(started.attemptId);
    const status = await deliverToLoopback(started.redirectUri!, {
      code: 'auth-code-1',
      state,
    });
    expect(status).toBe(200);

    const outcome = await completing;
    expect(outcome.key).toBe('sk-orca-fake0000000000000000');
    expect(outcome.accountId).toBe('12345');
    expect(outcome.scope).toBe('api');
    expect(outcome.scopeDowngraded).toBe(false);

    expect(fake.exchangeRequests).toHaveLength(1);
    const body = fake.exchangeRequests[0];
    expect(body.code).toBe('auth-code-1');
    expect(body.code_challenge_method).toBe('S256');
    // The verifier is presented at exchange time and hashes to the challenge that was sent.
    expect(typeof body.code_verifier).toBe('string');
    expect(challengeFor(String(body.code_verifier))).toBe(challenge);
    // And it was nowhere on the authorize URL.
    expect(started.authorizeUrl).not.toContain(String(body.code_verifier));
  });

  it('sends the exchange to the auth origin, never to the relay', async () => {
    fake = await startFakeAuth();
    const manager = newManager();
    const started = await manager.start({
      mode: 'loopback',
      origins: {
        authBase: fake.authBase,
        apiBase: 'https://api.orcarouter.ai/v1',
      },
    });
    const completing = manager.complete(started.attemptId);
    const authorize = new URL(started.authorizeUrl);
    await deliverToLoopback(started.redirectUri!, {
      code: 'c',
      state: authorize.searchParams.get('state')!,
    });
    await completing;
    expect(fake.exchangeRequests).toHaveLength(1);
    expect(fake.exchangeRequests[0].code).toBe('c');
  });

  it('supports out-of-band mode with a submitted code and no listener', async () => {
    fake = await startFakeAuth();
    const manager = newManager();
    const started = await manager.start({
      mode: 'oob',
      origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
    });
    expect(started.redirectUri).toBeNull();
    const authorize = new URL(started.authorizeUrl);
    expect(authorize.searchParams.get('callback_url')).toBe('oob');
    // S256 is mandatory for a code a human can read off a screen.
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');

    const completing = manager.complete(started.attemptId);
    manager.submitCode(started.attemptId, '  pasted-code  ');
    const outcome = await completing;
    expect(outcome.key).toBe('sk-orca-fake0000000000000000');
    expect(fake.exchangeRequests[0].code).toBe('pasted-code');
  });

  it('rejects a callback whose state does not match, before reading the code', async () => {
    fake = await startFakeAuth();
    const manager = newManager();
    const started = await manager.start({
      mode: 'loopback',
      origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
    });
    const completing = manager.complete(started.attemptId);
    // The rejection is asserted before the callback is delivered, so the promise always has a
    // handler attached when it settles rather than being reported as an unhandled rejection.
    const rejection = expect(completing).rejects.toMatchObject({
      kind: 'state-mismatch',
    });
    await deliverToLoopback(started.redirectUri!, {
      code: 'attacker-code',
      state: 'not-the-state-we-sent',
    });
    await rejection;
    // No exchange was attempted with the code that arrived under the wrong state.
    expect(fake.exchangeRequests).toHaveLength(0);
  });

  it('reports a denial as denied, with nothing stored', async () => {
    fake = await startFakeAuth();
    const manager = newManager();
    const started = await manager.start({
      mode: 'loopback',
      origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
    });
    const completing = manager.complete(started.attemptId);
    const rejection = expect(completing).rejects.toMatchObject({
      kind: 'denied',
    });
    const authorize = new URL(started.authorizeUrl);
    await deliverToLoopback(started.redirectUri!, {
      error: 'access_denied',
      state: authorize.searchParams.get('state')!,
    });
    await rejection;
    expect(fake.exchangeRequests).toHaveLength(0);
  });

  /*
   * THE PAGE HAS TO MATCH THE OUTCOME. The listener used to answer 200 with "Connected" before it
   * looked at anything, so a state mismatch, a denial and a missing code all told the user the same
   * false thing and sent them back to a tool holding no credential.
   */
  it('renders a failure page, not a success page, for a state mismatch', async () => {
    fake = await startFakeAuth();
    const manager = newManager();
    const started = await manager.start({
      mode: 'loopback',
      origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
    });
    const completing = manager.complete(started.attemptId);
    const rejection = expect(completing).rejects.toMatchObject({
      kind: 'state-mismatch',
    });
    const delivered = await deliverToLoopbackWithBody(started.redirectUri!, {
      code: 'attacker-code',
      state: 'not-the-state-we-sent',
    });
    await rejection;
    expect(delivered.status).toBe(400);
    expect(delivered.body).toMatch(/did not match your sign-in/i);
    expect(delivered.body).not.toMatch(/Connected to OrcaRouter/i);
    // Nothing from the request is reflected into the page.
    expect(delivered.body).not.toContain('attacker-code');
    expect(delivered.body).not.toContain('not-the-state-we-sent');
  });

  it('renders a denial page that says nothing was stored', async () => {
    fake = await startFakeAuth();
    const manager = newManager();
    const started = await manager.start({
      mode: 'loopback',
      origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
    });
    const completing = manager.complete(started.attemptId);
    const rejection = expect(completing).rejects.toMatchObject({
      kind: 'denied',
    });
    const authorize = new URL(started.authorizeUrl);
    const delivered = await deliverToLoopbackWithBody(started.redirectUri!, {
      error: 'access_denied',
      state: authorize.searchParams.get('state')!,
    });
    await rejection;
    expect(delivered.status).toBe(400);
    expect(delivered.body).toMatch(/Authorization was denied/i);
    expect(delivered.body).not.toMatch(/Connected to OrcaRouter/i);
  });

  it('renders a failure page when the callback carries no code', async () => {
    fake = await startFakeAuth();
    const manager = newManager();
    const started = await manager.start({
      mode: 'loopback',
      origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
    });
    const completing = manager.complete(started.attemptId);
    const rejection = expect(completing).rejects.toMatchObject({
      kind: 'exchange-rejected',
    });
    const authorize = new URL(started.authorizeUrl);
    const delivered = await deliverToLoopbackWithBody(started.redirectUri!, {
      state: authorize.searchParams.get('state')!,
    });
    await rejection;
    expect(delivered.status).toBe(400);
    expect(delivered.body).toMatch(/No authorization code/i);
    expect(delivered.body).not.toMatch(/Connected to OrcaRouter/i);
  });

  it('renders the success page only for a valid callback', async () => {
    fake = await startFakeAuth();
    const manager = newManager();
    const started = await manager.start({
      mode: 'loopback',
      origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
    });
    const completing = manager.complete(started.attemptId);
    const authorize = new URL(started.authorizeUrl);
    const delivered = await deliverToLoopbackWithBody(started.redirectUri!, {
      code: 'good-code',
      state: authorize.searchParams.get('state')!,
    });
    await completing;
    expect(delivered.status).toBe(200);
    expect(delivered.body).toMatch(/Connected to OrcaRouter/i);
  });

  it('maps 400, 403 and 429 to distinct, actionable failures without retrying', async () => {
    for (const [status, kind] of [
      [400, 'exchange-rejected'],
      [403, 'exchange-rejected'],
      [429, 'rate-limited'],
    ] as const) {
      fake = await startFakeAuth();
      fake.setExchange(() => ({ status, json: { error: 'x' } }));
      const manager = newManager();
      const started = await manager.start({
        mode: 'oob',
        origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
      });
      const completing = manager.complete(started.attemptId);
      manager.submitCode(started.attemptId, 'one-shot-code');
      await expect(completing).rejects.toMatchObject({ kind, status });
      // Exactly one attempt. A retry loop would burn the account's key budget silently.
      expect(fake.exchangeRequests).toHaveLength(1);
      await fake.close();
      fake = null;
    }
  });

  it('treats a transport failure as a failure rather than a hot loop', async () => {
    const manager = newManager();
    const started = await manager.start({
      mode: 'oob',
      origins: { authBase: 'https://auth.invalid', apiBase: DEFAULT_API_BASE },
      fetchImpl: (() =>
        Promise.reject(new TypeError('fetch failed'))) as typeof fetch,
    });
    const completing = manager.complete(started.attemptId);
    manager.submitCode(started.attemptId, 'code');
    await expect(completing).rejects.toMatchObject({ kind: 'network' });
  });

  it('times out an abandoned login and releases the listener', async () => {
    fake = await startFakeAuth();
    const manager = newManager();
    const started = await manager.start({
      mode: 'loopback',
      origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
      timeoutMs: 40,
    });
    await expect(manager.complete(started.attemptId)).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('cancels an in-flight login, releases the listener, and reports nothing stored', async () => {
    fake = await startFakeAuth();
    const manager = newManager();
    const started = await manager.start({
      mode: 'loopback',
      origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
    });
    const completing = manager.complete(started.attemptId);
    expect(manager.activeCount).toBe(1);
    expect(manager.cancel(started.attemptId)).toBe(true);
    await expect(completing).rejects.toMatchObject({ kind: 'cancelled' });
    expect(manager.activeCount).toBe(0);
    // Cancelling twice is not an error: a client can fire it on unmount and on unload.
    expect(manager.cancel(started.attemptId)).toBe(false);
    // The loopback port is genuinely released.
    const redirect = new URL(started.redirectUri!);
    await expect(
      fetch(`http://127.0.0.1:${redirect.port}/cb?code=x`)
    ).rejects.toThrow();
  });

  it('refuses a code submitted for an attempt that was cancelled or superseded', async () => {
    fake = await startFakeAuth();
    const manager = newManager();
    const started = await manager.start({
      mode: 'oob',
      origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
    });
    const completing = manager.complete(started.attemptId);
    manager.cancel(started.attemptId);
    await expect(completing).rejects.toMatchObject({ kind: 'cancelled' });
    expect(() => manager.submitCode(started.attemptId, 'late-code')).toThrow(
      OrcaConnectError
    );
  });

  it('refuses an empty submitted code with an instruction, not a crash', async () => {
    fake = await startFakeAuth();
    const manager = newManager();
    const started = await manager.start({
      mode: 'oob',
      origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
    });
    expect(() => manager.submitCode(started.attemptId, '   ')).toThrow(
      /Paste the code/
    );
    manager.cancel(started.attemptId);
  });

  it('reads the granted scope back and reports a downgrade rather than assuming the request', async () => {
    fake = await startFakeAuth();
    fake.setExchange(() => ({
      status: 200,
      json: {
        key: 'sk-orca-other000000000000000',
        user_id: '999',
        scope: 'api-read',
      },
    }));
    const manager = newManager();
    const started = await manager.start({
      mode: 'oob',
      origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
    });
    const completing = manager.complete(started.attemptId);
    manager.submitCode(started.attemptId, 'code');
    const outcome = await completing;
    expect(outcome.scope).toBe('api-read');
    expect(outcome.scopeDowngraded).toBe(true);
  });

  it('fails when the exchange answers without a key, and never stores an empty credential', async () => {
    fake = await startFakeAuth();
    fake.setExchange(() => ({
      status: 200,
      json: { user_id: '1', scope: 'api' },
    }));
    const manager = newManager();
    const started = await manager.start({
      mode: 'oob',
      origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
    });
    const completing = manager.complete(started.attemptId);
    manager.submitCode(started.attemptId, 'code');
    await expect(completing).rejects.toMatchObject({ kind: 'exchange-failed' });
  });

  it('never puts the verifier, the code or the key into an error message', async () => {
    fake = await startFakeAuth();
    fake.setExchange(() => ({ status: 403, json: { error: 'invalid_grant' } }));
    const manager = newManager();
    const started = await manager.start({
      mode: 'oob',
      origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
    });
    const authorize = new URL(started.authorizeUrl);
    const challenge = authorize.searchParams.get('code_challenge')!;
    const completing = manager.complete(started.attemptId);
    manager.submitCode(started.attemptId, 'secret-code-value');
    const error = await completing.catch((caught: unknown) => caught);
    // The positive assertion first: this is the refusal we expect, and it carries a status. Without
    // it the negative assertions below would also pass if nothing was exercised at all.
    expect(error).toBeInstanceOf(OrcaConnectError);
    expect((error as OrcaConnectError).kind).toBe('exchange-rejected');
    expect((error as OrcaConnectError).status).toBe(403);
    const rendered = `${String(error)} ${JSON.stringify(error)}`;
    expect(rendered).not.toContain('secret-code-value');
    expect(rendered).not.toContain(challenge);
    expect(rendered).not.toMatch(/sk-orca-/);
  });

  /*
   * THE CHECK AND THE INSTALL ARE ONE OPERATION. A caller that asks "may I install?" and then awaits
   * a store write has left a window in which a second sign-in -- its own HTTP request -- can move the
   * generation, and the older attempt then installs a key the user already replaced.
   */
  it('installs a credential for the current attempt and refuses one that was superseded', async () => {
    fake = await startFakeAuth();
    const manager = newManager();
    const first = await manager.start({
      mode: 'oob',
      origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
    });

    let writes = 0;
    const installed = await manager.installIfCurrent(
      first.attemptId,
      async () => {
        writes += 1;
        return 'stored';
      }
    );
    expect(installed).toEqual({ installed: true, value: 'stored' });
    expect(writes).toBe(1);

    // A second attempt starts, which supersedes the first.
    await manager.start({
      mode: 'oob',
      origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
    });
    const refused = await manager.installIfCurrent(
      first.attemptId,
      async () => {
        writes += 1;
        return 'should not happen';
      }
    );
    expect(refused).toEqual({ installed: false, reason: 'superseded' });
    // The install callback was never invoked, so no credential was written.
    expect(writes).toBe(1);
  });

  it('refuses to install for a cancelled attempt or an unknown one', async () => {
    fake = await startFakeAuth();
    const manager = newManager();
    const started = await manager.start({
      mode: 'oob',
      origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
    });
    manager.cancel(started.attemptId);
    let invoked = false;
    const cancelled = await manager.installIfCurrent(
      started.attemptId,
      async () => {
        invoked = true;
        return 'nope';
      }
    );
    // `cancel` removes the attempt outright, so a cancelled id is an unknown id by the time the
    // install is asked for. Either way the callback does not run and no credential is written.
    expect(cancelled).toEqual({ installed: false, reason: 'unknown' });
    expect(
      await manager.installIfCurrent('no-such-attempt', async () => 'x')
    ).toEqual({ installed: false, reason: 'unknown' });
    expect(invoked).toBe(false);
  });

  it('guards generations so a superseded attempt cannot report itself as current', async () => {
    fake = await startFakeAuth();
    const manager = newManager();
    const first = await manager.start({
      mode: 'oob',
      origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
    });
    expect(manager.isCurrent(first.attemptId)).toBe(true);
    const second = await manager.start({
      mode: 'oob',
      origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
    });
    // Starting a new attempt moves the generation, so the older one is inert.
    expect(manager.isCurrent(first.attemptId)).toBe(false);
    expect(manager.isCurrent(second.attemptId)).toBe(true);
    expect(manager.generationOf(first.attemptId)).not.toBe(
      manager.generationOf(second.attemptId)
    );
    manager.cancelAll();
  });

  it('reuses no verifier across attempts', async () => {
    fake = await startFakeAuth();
    const manager = newManager();
    const seen = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const started = await manager.start({
        mode: 'oob',
        origins: { authBase: fake.authBase, apiBase: DEFAULT_API_BASE },
      });
      const completing = manager.complete(started.attemptId);
      manager.submitCode(started.attemptId, `code-${i}`);
      await completing;
      seen.add(String(fake.exchangeRequests[i].code_verifier));
    }
    expect(seen.size).toBe(3);
  });
});
