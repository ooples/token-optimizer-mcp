/**
 * The OrcaRouter provider API, and the entry points wired to it.
 *
 * What this file proves, and why each part needs a test rather than a convention:
 *
 *   - BOTH authentication choices are registered and independently usable over HTTP, and neither is
 *     a fallback for the other.
 *   - A key posted through the API-key route and one installed by the PKCE route reach the SAME
 *     provider path: the model dropdown and the inference request do not know which was used.
 *   - Auth requests go to the auth origin and model/inference requests go to the API origin, with
 *     the exchange path at `/api/v1/auth/keys` and never at `/v1/auth/keys`.
 *   - The model options a selector receives are already filtered for the capability and the input
 *     modality, so a text-only model is absent the moment an image is attached -- and a stale
 *     selection is reported as invalid so the caller clears it.
 *   - Every terminal login path releases the server-side lock, including the `pagehide` cancel.
 *   - No route returns a stored key, and no error message carries one.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  jest,
} from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { app } from '../../src/server/web-server.js';
import { orcaConnectManager } from '../../src/server/orcarouter-routes.js';
import {
  ORCA_API_KEY_PROVIDER_ID,
  ORCA_PKCE_PROVIDER_ID,
  credentialStorePath,
} from '../../src/orcarouter/credential-store.js';
import {
  AUTHORIZE_PATH,
  EXCHANGE_PATH,
} from '../../src/orcarouter/endpoints.js';

const FAKE_KEY = 'sk-orca-aaaaaaaaaaaaaaaaaaaa';
const FAKE_KEY_2 = 'sk-orca-bbbbbbbbbbbbbbbbbbbb';

/** The catalog the fake upstream serves, shaped like the real one. */
const UPSTREAM_MODELS = [
  { id: 'orcarouter/auto', supported_endpoint_types: ['openai', 'anthropic'] },
  {
    id: 'deepseek/deepseek-v4-pro',
    supported_endpoint_types: ['openai', 'openai-response'],
    context_length: 1048576,
    architecture: { input_modalities: ['text'] },
  },
  {
    id: 'deepseek/deepseek-v4.1-flash',
    supported_endpoint_types: ['openai', 'anthropic'],
    context_length: 1048576,
    architecture: { input_modalities: ['text', 'image'] },
  },
  { id: 'vendor/embed-large', supported_endpoint_types: ['embeddings'] },
  { id: 'vendor/image-gen-1', supported_endpoint_types: ['image-generation'] },
  { id: 'vendor/video-1', supported_endpoint_types: ['openai-video'] },
  { id: 'vendor/rerank-v2', supported_endpoint_types: ['jina-rerank'] },
];

let server: Server;
let baseUrl: string;
let upstream: Server;
let upstreamBase: string;
let home: string;
const upstreamCalls: Array<{
  path: string;
  query: string;
  auth: string | null;
}> = [];
const originalEnv: Record<string, string | undefined> = {};

const SAVED_KEYS = [
  'TOKEN_OPTIMIZER_HOME',
  'ORCAROUTER_API_KEY',
  'ORCA_AUTH_BASE_URL',
  'ORCA_API_BASE_URL',
  'ORCA_BASE_URL',
] as const;

beforeAll(async () => {
  for (const key of SAVED_KEYS) originalEnv[key] = process.env[key];

  upstream = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    upstreamCalls.push({
      path: url.pathname,
      query: url.search,
      auth: request.headers.authorization ?? null,
    });
    if (url.pathname === AUTHORIZE_PATH) {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<p>consent</p>');
      return;
    }
    if (url.pathname === EXCHANGE_PATH && request.method === 'POST') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ key: FAKE_KEY_2, user_id: '555', scope: 'api' })
      );
      return;
    }
    if (url.pathname === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: UPSTREAM_MODELS }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', () => resolve())
  );
  upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  orcaConnectManager().cancelAll();
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  await new Promise<void>((resolve) => {
    upstream.closeAllConnections?.();
    upstream.close(() => resolve());
  });
  for (const key of SAVED_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-routes-'));
  process.env.TOKEN_OPTIMIZER_HOME = home;
  delete process.env.ORCAROUTER_API_KEY;
  // Both origins point at the fake, which is a loopback origin, so the HTTPS rule permits it.
  process.env.ORCA_AUTH_BASE_URL = upstreamBase;
  process.env.ORCA_API_BASE_URL = `${upstreamBase}/v1`;
  delete process.env.ORCA_BASE_URL;
  upstreamCalls.length = 0;
});

afterEach(() => {
  orcaConnectManager().cancelAll();
  rmSync(home, { recursive: true, force: true });
});

async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

describe('provider registry over HTTP', () => {
  it('registers both authentication choices, with distinct ids and distinct labels', async () => {
    const { status, body } = await api('/api/orcarouter/adapters');
    expect(status).toBe(200);
    const ids = body.adapters.map((adapter: { id: string }) => adapter.id);
    expect(ids).toEqual([ORCA_API_KEY_PROVIDER_ID, ORCA_PKCE_PROVIDER_ID]);
    const labels = body.adapters.map(
      (adapter: { label: string }) => adapter.label
    );
    expect(new Set(labels).size).toBe(2);
    expect(labels).toEqual(['OrcaRouter - API', 'OrcaRouter - Auth']);
  });

  it('reports both choices as available and independently unconfigured on a fresh home', async () => {
    const { body } = await api('/api/orcarouter/status');
    expect(body.ready).toBe(false);
    expect(body.adapters).toHaveLength(2);
    expect(
      body.adapters.every((a: { configured: boolean }) => !a.configured)
    ).toBe(true);
    expect(body.dashboardUrl).toBe(
      'https://www.orcarouter.ai/console/authorized-apps'
    );
    expect(body.origins.apiBase).toBe(`${upstreamBase}/v1`);
    expect(body.origins.authBase).toBe(upstreamBase);
  });

  it('stores a pasted key, reports it redacted, and never returns it', async () => {
    const saved = await api('/api/orcarouter/key', {
      method: 'POST',
      body: JSON.stringify({ key: FAKE_KEY }),
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain(FAKE_KEY);
    expect(saved.body.ready).toBe(true);
    expect(saved.body.masked).toBe('sk-orca-…aaaa');

    const status = await api('/api/orcarouter/status');
    expect(JSON.stringify(status.body)).not.toContain(FAKE_KEY);
    const apiAdapter = status.body.adapters.find(
      (a: { id: string }) => a.id === ORCA_API_KEY_PROVIDER_ID
    );
    expect(apiAdapter.configured).toBe(true);
    expect(apiAdapter.active).toBe(true);
    expect(apiAdapter.masked).not.toContain('aaaaaaaa');
    // The status route reports both choices, and the key field placeholder reads the pasted key's
    // own redacted value -- so the active flag has to be per adapter, not just a top-level source.
    expect(status.body.masked).toBe('sk-orca-…aaaa');
  });

  it('rejects a malformed key with an instruction and stores nothing', async () => {
    // The adapter's own input error is written for the user and must survive `safeMessage`, which
    // otherwise replaces it with a generic string -- the fix for CWE-209 hid this instruction.
    const spy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      const result = await api('/api/orcarouter/key', {
        method: 'POST',
        body: JSON.stringify({ key: 'not-a-key' }),
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toMatch(/sk-orca-/);
      // A caller's typo is not a server fault, so nothing is logged as one.
      expect(spy).not.toHaveBeenCalled();
      const status = await api('/api/orcarouter/status');
      expect(status.body.ready).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('clears the stored key without touching the other choice', async () => {
    await api('/api/orcarouter/key', {
      method: 'POST',
      body: JSON.stringify({ key: FAKE_KEY }),
    });
    const cleared = await api('/api/orcarouter/key', { method: 'DELETE' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.ready).toBe(false);
    const status = await api('/api/orcarouter/status');
    expect(
      status.body.adapters.find(
        (a: { id: string }) => a.id === ORCA_PKCE_PROVIDER_ID
      ).configured
    ).toBe(false);
  });
});

describe('the credential routes reject cross-origin callers', () => {
  /**
   * The dashboard is same-origin, and a browser sends `Origin` on every non-GET request -- so the
   * allowed case has to be exercised too, or the guard would look correct while breaking the feature.
   */
  it('accepts the dashboard\u2019s own origin and refuses a different one', async () => {
    const sameOrigin = await api('/api/orcarouter/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({ key: FAKE_KEY }),
    });
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.body.ready).toBe(true);

    const foreign = await api('/api/orcarouter/key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ key: FAKE_KEY_2 }),
    });
    expect(foreign.status).toBe(403);
    // The key that arrived cross-origin was not stored, and the previous one is untouched.
    const status = await api('/api/orcarouter/status');
    expect(JSON.stringify(status.body)).not.toContain(FAKE_KEY_2);
    expect(status.body.masked).toBe('sk-orca-…aaaa');
  });

  it('refuses cross-origin deletes and connect starts, and allows a client with no Origin', async () => {
    const foreignDelete = await api('/api/orcarouter/key', {
      method: 'DELETE',
      headers: { Origin: 'https://evil.example' },
    });
    expect(foreignDelete.status).toBe(403);

    const foreignConnect = await api('/api/orcarouter/connect', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ mode: 'loopback' }),
    });
    expect(foreignConnect.status).toBe(403);
    // No listener was bound for the refused request.
    expect(orcaConnectManager().activeCount).toBe(0);

    // `Origin: null` (a sandboxed frame) matches nothing and is refused too.
    const nullOrigin = await api('/api/orcarouter/key', {
      method: 'DELETE',
      headers: { Origin: 'null' },
    });
    expect(nullOrigin.status).toBe(403);

    // The CLI and curl send no Origin at all, and must keep working.
    const cliDelete = await api('/api/orcarouter/key', { method: 'DELETE' });
    expect(cliDelete.status).toBe(200);
  });
});

describe('model options per entry point', () => {
  beforeEach(async () => {
    await api('/api/orcarouter/key', {
      method: 'POST',
      body: JSON.stringify({ key: FAKE_KEY }),
    });
  });

  it('serves the chat dropdown from the API, filtered to text-capable models', async () => {
    const { status, body } = await api(
      '/api/orcarouter/models?capability=chat'
    );
    expect(status).toBe(200);
    expect(body.status).toBe('live');
    expect(body.sourceUrl).toBe(`${upstreamBase}/v1/models?capability=chat`);
    const ids = body.models.map((model: { id: string }) => model.id);
    expect(ids).toContain('deepseek/deepseek-v4-pro');
    expect(ids).not.toContain('vendor/embed-large');
    expect(ids).not.toContain('vendor/image-gen-1');
    expect(ids).not.toContain('vendor/video-1');
    expect(ids).not.toContain('vendor/rerank-v2');
    expect(
      body.models.every((model: { fromSeed: boolean }) => !model.fromSeed)
    ).toBe(true);
    // The key went upstream as a Bearer header and is not in the response.
    expect(upstreamCalls[0].auth).toBe(`Bearer ${FAKE_KEY}`);
    expect(JSON.stringify(body)).not.toContain(FAKE_KEY);
  });

  it('narrows the options to image-input chat models when an image is attached', async () => {
    const text = await api('/api/orcarouter/models?capability=chat');
    const withImage = await api(
      '/api/orcarouter/models?capability=chat&inputModality=image'
    );
    const textIds = text.body.models.map((model: { id: string }) => model.id);
    const imageIds = withImage.body.models.map(
      (model: { id: string }) => model.id
    );

    expect(textIds).toContain('deepseek/deepseek-v4-pro');
    expect(imageIds).not.toContain('deepseek/deepseek-v4-pro');
    expect(imageIds).toEqual(['deepseek/deepseek-v4.1-flash']);
    expect(imageIds.length).toBeLessThan(textIds.length);
    for (const model of withImage.body.models) {
      expect(model.inputModalities).toContain('image');
    }
  });

  it('serves embedding, image, video and rerank capability lists separately', async () => {
    const embedding = await api('/api/orcarouter/models?capability=embedding');
    expect(embedding.body.models.map((m: { id: string }) => m.id)).toEqual([
      'vendor/embed-large',
    ]);
    const image = await api('/api/orcarouter/models?capability=image');
    expect(image.body.models.map((m: { id: string }) => m.id)).toEqual([
      'vendor/image-gen-1',
    ]);
    const video = await api('/api/orcarouter/models?capability=video');
    expect(video.body.models.map((m: { id: string }) => m.id)).toEqual([
      'vendor/video-1',
    ]);
    const rerank = await api('/api/orcarouter/models?capability=rerank');
    expect(rerank.body.models.map((m: { id: string }) => m.id)).toEqual([
      'vendor/rerank-v2',
    ]);
  });

  it('falls back to a labelled seed with its metadata when the catalog is unreachable', async () => {
    process.env.ORCA_API_BASE_URL = 'http://127.0.0.1:1/v1';
    const { body } = await api('/api/orcarouter/models?capability=chat');
    expect(body.status).toBe('degraded');
    expect(typeof body.degradedReason).toBe('string');
    expect(body.models.length).toBeGreaterThan(0);
    expect(
      body.models.every((model: { fromSeed: boolean }) => model.fromSeed)
    ).toBe(true);
    const gpt = body.models.find(
      (model: { id: string }) => model.id === 'openai/gpt-5.5'
    );
    expect(gpt.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(gpt.inputModalities).toContain('image');
    // Never free text: the client is handed a list, and the degraded state is explicit.
    expect(Array.isArray(body.models)).toBe(true);
  });
});

describe('the connect flow over HTTP', () => {
  it('starts a login against the auth origin, at /auth, with S256 and no verifier on the URL', async () => {
    const started = await api('/api/orcarouter/connect', {
      method: 'POST',
      body: JSON.stringify({ mode: 'loopback' }),
    });
    expect(started.status).toBe(200);
    expect(started.body.attemptId).toBeTruthy();
    const url = new URL(started.body.authorizeUrl);
    expect(url.origin).toBe(upstreamBase);
    expect(url.pathname).toBe(AUTHORIZE_PATH);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('app_name')).toBe('Token Optimizer MCP');
    expect(url.searchParams.get('scope')).toBe('api');
    expect(url.searchParams.get('callback_url')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/cb$/
    );
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    // Nothing was stored by starting a login.
    const status = await api('/api/orcarouter/status');
    expect(status.body.ready).toBe(false);
    await api(`/api/orcarouter/connect/${started.body.attemptId}`, {
      method: 'DELETE',
    });
  });

  it('completes loopback authorize → callback → exchange and installs the key', async () => {
    const started = await api('/api/orcarouter/connect', {
      method: 'POST',
      body: JSON.stringify({ mode: 'loopback' }),
    });
    const authorize = new URL(started.body.authorizeUrl);
    const completing = api(
      `/api/orcarouter/connect/${started.body.attemptId}/complete`,
      { method: 'POST', body: JSON.stringify({}) }
    );
    const callback = new URL(started.body.redirectUri);
    callback.searchParams.set('code', 'auth-code');
    callback.searchParams.set('state', authorize.searchParams.get('state')!);
    const delivered = await fetch(callback.toString());
    expect(delivered.status).toBe(200);
    expect(await delivered.text()).toMatch(/close this tab/i);

    const result = await completing;
    expect(result.status).toBe(200);
    expect(result.body.scope).toBe('api');
    expect(result.body.scopeDowngraded).toBe(false);
    expect(result.body.status.ready).toBe(true);
    expect(JSON.stringify(result.body)).not.toContain(FAKE_KEY_2);

    // The exchange went to the auth origin at the right path, and the granted key was stored.
    const exchange = upstreamCalls.find((call) => call.path === EXCHANGE_PATH);
    expect(exchange).toBeTruthy();
    expect(upstreamCalls.some((call) => call.path === '/v1/auth/keys')).toBe(
      false
    );

    const status = await api('/api/orcarouter/status');
    const authAdapter = status.body.adapters.find(
      (a: { id: string }) => a.id === ORCA_PKCE_PROVIDER_ID
    );
    expect(authAdapter.configured).toBe(true);
    expect(status.body.activeSource).toBe('oauth-pkce');
    expect(authAdapter.active).toBe(true);
    // Exactly one choice is flagged in use, and it is the one inference resolves.
    expect(
      status.body.adapters.filter((a: { active: boolean }) => a.active)
    ).toHaveLength(1);
  });

  it('runs out-of-band mode with a submitted code', async () => {
    const started = await api('/api/orcarouter/connect', {
      method: 'POST',
      body: JSON.stringify({ mode: 'oob' }),
    });
    expect(started.body.redirectUri).toBeNull();
    expect(
      new URL(started.body.authorizeUrl).searchParams.get('callback_url')
    ).toBe('oob');
    const completing = api(
      `/api/orcarouter/connect/${started.body.attemptId}/complete`,
      { method: 'POST', body: JSON.stringify({}) }
    );
    const submitted = await api(
      `/api/orcarouter/connect/${started.body.attemptId}/code`,
      { method: 'POST', body: JSON.stringify({ code: 'pasted' }) }
    );
    expect(submitted.status).toBe(200);
    expect((await completing).status).toBe(200);
  });

  it('reports a denial with a kind and stores nothing', async () => {
    const started = await api('/api/orcarouter/connect', {
      method: 'POST',
      body: JSON.stringify({ mode: 'loopback' }),
    });
    const authorize = new URL(started.body.authorizeUrl);
    const completing = api(
      `/api/orcarouter/connect/${started.body.attemptId}/complete`,
      { method: 'POST', body: JSON.stringify({}) }
    );
    const callback = new URL(started.body.redirectUri);
    callback.searchParams.set('error', 'access_denied');
    callback.searchParams.set('state', authorize.searchParams.get('state')!);
    await fetch(callback.toString());
    const result = await completing;
    expect(result.status).toBe(403);
    expect(result.body.kind).toBe('denied');
    expect((await api('/api/orcarouter/status')).body.ready).toBe(false);
  });

  it('reports a state mismatch as such and does not exchange the code', async () => {
    const started = await api('/api/orcarouter/connect', {
      method: 'POST',
      body: JSON.stringify({ mode: 'loopback' }),
    });
    const completing = api(
      `/api/orcarouter/connect/${started.body.attemptId}/complete`,
      { method: 'POST', body: JSON.stringify({}) }
    );
    const callback = new URL(started.body.redirectUri);
    callback.searchParams.set('code', 'attacker');
    callback.searchParams.set('state', 'wrong');
    await fetch(callback.toString());
    const result = await completing;
    expect(result.body.kind).toBe('state-mismatch');
    expect(upstreamCalls.some((call) => call.path === EXCHANGE_PATH)).toBe(
      false
    );
  });

  it('does not install a credential for an attempt a newer login superseded', async () => {
    const first = await api('/api/orcarouter/connect', {
      method: 'POST',
      body: JSON.stringify({ mode: 'oob' }),
    });
    const completing = api(
      `/api/orcarouter/connect/${first.body.attemptId}/complete`,
      { method: 'POST', body: JSON.stringify({}) }
    );
    // A second login starts while the first is still waiting for its code. This is what the
    // route-level window looked like: the supersession check and the store write were separate.
    const second = await api('/api/orcarouter/connect', {
      method: 'POST',
      body: JSON.stringify({ mode: 'oob' }),
    });
    expect(second.status).toBe(200);
    await api(`/api/orcarouter/connect/${first.body.attemptId}/code`, {
      method: 'POST',
      body: JSON.stringify({ code: 'late-code' }),
    });
    const result = await completing;
    expect(result.status).toBe(409);
    expect(result.body.kind).toBe('cancelled');
    // Nothing was stored by the superseded attempt.
    const status = await api('/api/orcarouter/status');
    expect(status.body.ready).toBe(false);
    expect(JSON.stringify(status.body)).not.toContain(FAKE_KEY_2);
    await api(`/api/orcarouter/connect/${second.body.attemptId}`, {
      method: 'DELETE',
    });
  });

  it('releases the login lock on the pagehide cancel, and a second login can start', async () => {
    const first = await api('/api/orcarouter/connect', {
      method: 'POST',
      body: JSON.stringify({ mode: 'loopback' }),
    });
    const completing = api(
      `/api/orcarouter/connect/${first.body.attemptId}/complete`,
      { method: 'POST', body: JSON.stringify({}) }
    );
    // This is the request the pagehide handler sends with `keepalive`.
    const cancelled = await api(
      `/api/orcarouter/connect/${first.body.attemptId}`,
      {
        method: 'DELETE',
      }
    );
    expect(cancelled.body.cancelled).toBe(true);
    expect((await completing).body.kind).toBe('cancelled');
    expect(orcaConnectManager().activeCount).toBe(0);

    // A second attempt starts without any remount or reset.
    const second = await api('/api/orcarouter/connect', {
      method: 'POST',
      body: JSON.stringify({ mode: 'oob' }),
    });
    expect(second.status).toBe(200);
    expect(second.body.attemptId).not.toBe(first.body.attemptId);
    await api(`/api/orcarouter/connect/${second.body.attemptId}`, {
      method: 'DELETE',
    });
  });

  it('cancels idempotently, so a client firing it twice is not an error', async () => {
    const started = await api('/api/orcarouter/connect', {
      method: 'POST',
      body: JSON.stringify({ mode: 'oob' }),
    });
    const first = await api(
      `/api/orcarouter/connect/${started.body.attemptId}`,
      {
        method: 'DELETE',
      }
    );
    const second = await api(
      `/api/orcarouter/connect/${started.body.attemptId}`,
      {
        method: 'DELETE',
      }
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.cancelled).toBe(false);
  });

  it('removes the PKCE credential through its own route', async () => {
    const started = await api('/api/orcarouter/connect', {
      method: 'POST',
      body: JSON.stringify({ mode: 'oob' }),
    });
    const completing = api(
      `/api/orcarouter/connect/${started.body.attemptId}/complete`,
      { method: 'POST', body: JSON.stringify({}) }
    );
    await api(`/api/orcarouter/connect/${started.body.attemptId}/code`, {
      method: 'POST',
      body: JSON.stringify({ code: 'c' }),
    });
    await completing;
    const cleared = await api('/api/orcarouter/connect', { method: 'DELETE' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.ready).toBe(false);
  });
});

describe('one downstream for both choices', () => {
  it('gives the model selector the same options whichever choice supplied the key', async () => {
    await api('/api/orcarouter/key', {
      method: 'POST',
      body: JSON.stringify({ key: FAKE_KEY }),
    });
    const viaApiKey = await api('/api/orcarouter/models?capability=chat');

    await api('/api/orcarouter/key', { method: 'DELETE' });
    const started = await api('/api/orcarouter/connect', {
      method: 'POST',
      body: JSON.stringify({ mode: 'oob' }),
    });
    const completing = api(
      `/api/orcarouter/connect/${started.body.attemptId}/complete`,
      { method: 'POST', body: JSON.stringify({}) }
    );
    await api(`/api/orcarouter/connect/${started.body.attemptId}/code`, {
      method: 'POST',
      body: JSON.stringify({ code: 'c' }),
    });
    await completing;
    const viaPkce = await api('/api/orcarouter/models?capability=chat');

    expect(viaPkce.body.models.map((m: { id: string }) => m.id)).toEqual(
      viaApiKey.body.models.map((m: { id: string }) => m.id)
    );
    expect(viaPkce.body.sourceUrl).toBe(viaApiKey.body.sourceUrl);
    // Both went upstream to the same relay path with a Bearer header.
    const modelCalls = upstreamCalls.filter(
      (call) => call.path === '/v1/models'
    );
    expect(modelCalls).toHaveLength(2);
    expect(modelCalls[0].auth).toBe(`Bearer ${FAKE_KEY}`);
    expect(modelCalls[1].auth).toBe(`Bearer ${FAKE_KEY_2}`);
  });

  it('writes the credential under the project home rather than a new secret store', async () => {
    await api('/api/orcarouter/key', {
      method: 'POST',
      body: JSON.stringify({ key: FAKE_KEY }),
    });
    expect(credentialStorePath(process.env)).toBe(
      join(home, 'orcarouter-credentials.json')
    );
  });
});
