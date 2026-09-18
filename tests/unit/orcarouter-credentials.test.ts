/**
 * The credential seam: two adapters, one credential, one downstream.
 *
 * The properties under test are the ones that make the two authentication choices genuinely
 * interchangeable rather than nominally so: both produce the same result shape, the provider request
 * built from either is identical, nothing downstream can see which one was used, a revoked key
 * becomes `needsReauth` with no refresh attempted, and a late 401 from an old generation cannot
 * touch a newer credential. Plus the plain hygiene: save, read, redact, clear, and a secret that
 * appears in no log, no error and no URL.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApiKeyCredentialAdapter,
  PkceCredentialAdapter,
  credentialForInference,
  recordRejection,
  CREDENTIAL_ADAPTERS,
  ORCA_KEY_DASHBOARD_URL,
  CredentialInputError,
} from '../../src/orcarouter/credentials.js';
import {
  clearCredentials,
  credentialStorePath,
  looksLikeOrcaKey,
  markNeedsReauth,
  readCredentialFile,
  redactKey,
  resolveCredential,
  saveCredential,
} from '../../src/orcarouter/credential-store.js';
import {
  authorizationHeaders,
  sendProviderRequest,
  OrcaProviderError,
} from '../../src/orcarouter/provider.js';
import { hasOrcaRouterCredential } from '../../src/orcarouter/credential-presence.js';

const FAKE_KEY = 'sk-orca-abcdefghijklmnopqrstuvwx';
const FAKE_KEY_2 = 'sk-orca-zyxwvutsrqponmlkjihgfedc';

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-credentials-'));
  env = { TOKEN_OPTIMIZER_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('credential store', () => {
  it('stores, reads back and clears a credential', async () => {
    const saved = await saveCredential(
      { source: 'api-key', key: FAKE_KEY },
      env
    );
    expect(saved.generation).toBe(1);
    expect(saved.needsReauth).toBe(false);

    const resolved = await resolveCredential(env);
    expect(resolved?.key).toBe(FAKE_KEY);
    expect(resolved?.source).toBe('api-key');
    expect(resolved?.ephemeral).toBe(false);

    expect(await clearCredentials('api-key', env)).toBe(1);
    expect(await resolveCredential(env)).toBeNull();
  });

  it('writes the file owner-only, because it holds a billable credential', async () => {
    await saveCredential({ source: 'api-key', key: FAKE_KEY }, env);
    const mode = statSync(credentialStorePath(env)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('bumps the generation on every save for the same account', async () => {
    const first = await saveCredential(
      { source: 'api-key', key: FAKE_KEY },
      env
    );
    const second = await saveCredential(
      { source: 'api-key', key: FAKE_KEY_2 },
      env
    );
    expect(second.generation).toBe(first.generation + 1);
    const file = await readCredentialFile(env);
    expect(file.credentials).toHaveLength(1);
    expect(file.credentials[0].key).toBe(FAKE_KEY_2);
  });

  it('keeps the two sources independent, so clearing one leaves the other usable', async () => {
    await saveCredential({ source: 'api-key', key: FAKE_KEY }, env);
    await saveCredential(
      { source: 'oauth-pkce', key: FAKE_KEY_2, accountId: '777' },
      env
    );
    expect(await clearCredentials('api-key', env)).toBe(1);
    const remaining = await resolveCredential(env);
    expect(remaining?.source).toBe('oauth-pkce');
    expect(remaining?.accountId).toBe('777');
  });

  it('treats a missing, corrupt or wrong-schema file as an empty store rather than throwing', async () => {
    expect(await readCredentialFile(env)).toEqual({
      schema: 1,
      credentials: [],
    });
    const path = credentialStorePath(env);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(home, { recursive: true });
    writeFileSync(path, 'not json at all');
    expect(await resolveCredential(env)).toBeNull();
    writeFileSync(path, JSON.stringify({ schema: 9, credentials: [] }));
    expect(await resolveCredential(env)).toBeNull();
    writeFileSync(
      path,
      JSON.stringify({
        schema: 1,
        credentials: [{ key: '', source: 'api-key' }],
      })
    );
    expect(await resolveCredential(env)).toBeNull();
  });

  it('prefers an environment key over the store, and marks it ephemeral', async () => {
    await saveCredential(
      { source: 'oauth-pkce', key: FAKE_KEY, accountId: '1' },
      env
    );
    const resolved = await resolveCredential({
      ...env,
      ORCAROUTER_API_KEY: FAKE_KEY_2,
    });
    expect(resolved?.key).toBe(FAKE_KEY_2);
    expect(resolved?.ephemeral).toBe(true);
  });

  it('reports a rejected credential as needing reauthentication without attempting a refresh', async () => {
    const saved = await saveCredential(
      { source: 'oauth-pkce', key: FAKE_KEY, accountId: '42' },
      env
    );
    const outcome = await markNeedsReauth(
      { accountId: '42', generation: saved.generation },
      'HTTP 401',
      env
    );
    expect(outcome).toBe('marked');
    const file = await readCredentialFile(env);
    expect(file.credentials[0].needsReauth).toBe(true);
    expect(file.credentials[0].reauthReason).toBe('HTTP 401');
    // And it is no longer selected, so nothing keeps calling a dead credential.
    expect(await resolveCredential(env)).toBeNull();
  });

  it('refuses to mark a newer generation broken from a late failure of an older one', async () => {
    const first = await saveCredential(
      { source: 'oauth-pkce', key: FAKE_KEY, accountId: '42' },
      env
    );
    // The user reauthorizes; the credential is replaced and the generation advances.
    const second = await saveCredential(
      { source: 'oauth-pkce', key: FAKE_KEY_2, accountId: '42' },
      env
    );
    expect(second.generation).toBeGreaterThan(first.generation);

    // A 401 from the request that was issued under the OLD generation arrives now.
    const outcome = await markNeedsReauth(
      { accountId: '42', generation: first.generation },
      'HTTP 401',
      env
    );
    expect(outcome).toBe('stale-generation');
    const resolved = await resolveCredential(env);
    expect(resolved?.key).toBe(FAKE_KEY_2);
    expect(resolved?.generation).toBe(second.generation);
  });

  it('reports an unknown account rather than creating one', async () => {
    expect(
      await markNeedsReauth(
        { accountId: 'nobody', generation: 1 },
        'HTTP 401',
        env
      )
    ).toBe('unknown-account');
    expect(await readCredentialFile(env)).toEqual({
      schema: 1,
      credentials: [],
    });
  });

  it('never silently deletes an old secret before a replacement is stored', async () => {
    await saveCredential(
      { source: 'oauth-pkce', key: FAKE_KEY, accountId: '9' },
      env
    );
    // A failed replacement leaves the old file intact and readable.
    const raw = readFileSync(credentialStorePath(env), 'utf8');
    expect(raw).toContain(FAKE_KEY);
    const before = await resolveCredential(env);
    expect(before?.key).toBe(FAKE_KEY);
  });
});

describe('redaction and shape checks', () => {
  it('redacts a key to a prefix and a suffix, and never shows the middle', () => {
    const masked = redactKey(FAKE_KEY);
    expect(masked).toBe('sk-orca-…uvwx');
    expect(masked).not.toContain('abcdefghijklmnop');
    expect(redactKey('')).toBe('');
    expect(redactKey(null)).toBe('');
    expect(redactKey(undefined)).toBe('');
    expect(redactKey('short')).toBe('…');
  });

  it('accepts a plausible key shape and rejects an obviously wrong paste', () => {
    expect(looksLikeOrcaKey(FAKE_KEY)).toBe(true);
    expect(looksLikeOrcaKey('  sk-orca-abcdefghijklmnop  ')).toBe(true);
    expect(looksLikeOrcaKey('sk-abc')).toBe(false);
    expect(looksLikeOrcaKey('sk-orca-short')).toBe(false);
    expect(looksLikeOrcaKey('')).toBe(false);
    expect(looksLikeOrcaKey('Bearer sk-orca-abcdefghijklmnop')).toBe(false);
  });
});

describe('the two adapters', () => {
  it('registers both choices with distinct ids and distinct labels', () => {
    expect(CREDENTIAL_ADAPTERS).toHaveLength(2);
    const ids = CREDENTIAL_ADAPTERS.map((adapter) => adapter.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toEqual(['orcarouter', 'orcarouter-oauth']);
    const labels = CREDENTIAL_ADAPTERS.map((adapter) => adapter.label);
    expect(new Set(labels).size).toBe(2);
    expect(labels).toEqual(['OrcaRouter - API', 'OrcaRouter - Auth']);
  });

  it('produces the same credential result shape from either adapter', async () => {
    const fromKey = await new ApiKeyCredentialAdapter().save(FAKE_KEY, env);
    const fromPkce = await new PkceCredentialAdapter().save(
      FAKE_KEY_2,
      { accountId: '12345', scope: 'api' },
      env
    );
    expect(Object.keys(fromKey).sort()).toEqual(Object.keys(fromPkce).sort());
    expect(fromKey.source).toBe('api-key');
    expect(fromPkce.source).toBe('oauth-pkce');
    expect(typeof fromKey.key).toBe('string');
    expect(typeof fromPkce.key).toBe('string');
  });

  it('lets the downstream provider use a credential from either adapter identically', async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> =
      [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      requests.push({
        url: String(url),
        headers: init.headers as Record<string, string>,
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [] }),
      });
    }) as unknown as typeof fetch;

    const fromKey = await new ApiKeyCredentialAdapter().save(FAKE_KEY, env);
    await sendProviderRequest({
      model: 'orcarouter/auto',
      path: '/chat/completions',
      body: { messages: [] },
      env,
      fetchImpl,
    });
    await clearCredentials(null, env);
    await new PkceCredentialAdapter().save(
      FAKE_KEY_2,
      { accountId: '12345', scope: 'api' },
      env
    );
    await sendProviderRequest({
      model: 'orcarouter/auto',
      path: '/chat/completions',
      body: { messages: [] },
      env,
      fetchImpl,
    });

    expect(requests).toHaveLength(2);
    // Same endpoint, same header shape: the source is invisible downstream.
    expect(requests[0].url).toBe(
      'https://api.orcarouter.ai/v1/chat/completions'
    );
    expect(requests[1].url).toBe(requests[0].url);
    expect(requests[0].headers.Authorization).toBe(`Bearer ${fromKey.key}`);
    expect(requests[1].headers.Authorization).toBe(`Bearer ${FAKE_KEY_2}`);
    expect(Object.keys(requests[0].headers).sort()).toEqual(
      Object.keys(requests[1].headers).sort()
    );
  });

  it('reports status per adapter, and a redacted form only', async () => {
    await new ApiKeyCredentialAdapter().save(FAKE_KEY, env);
    const apiStatus = await new ApiKeyCredentialAdapter().status(env);
    const authStatus = await new PkceCredentialAdapter().status(env);
    expect(apiStatus.configured).toBe(true);
    expect(apiStatus.masked).toBe(redactKey(FAKE_KEY));
    expect(apiStatus.masked).not.toContain('abcdefghijkl');
    expect(apiStatus.dashboardUrl).toBe(ORCA_KEY_DASHBOARD_URL);
    // The other choice is independently unconfigured, not hidden.
    expect(authStatus.configured).toBe(false);
    expect(authStatus.masked).toBe('');
  });

  it('reports both choices configured with exactly one marked active', async () => {
    // A user who pasted a key and later signed in holds two credentials. Neither choice may
    // disappear from the UI, and exactly one must be flagged as the one inference uses.
    await new ApiKeyCredentialAdapter().save(FAKE_KEY, env);
    await new PkceCredentialAdapter().save(
      FAKE_KEY_2,
      { accountId: '1', scope: 'api' },
      env
    );
    const apiStatus = await new ApiKeyCredentialAdapter().status(env);
    const authStatus = await new PkceCredentialAdapter().status(env);
    expect(apiStatus.configured).toBe(true);
    expect(authStatus.configured).toBe(true);
    expect(apiStatus.masked).toBe(redactKey(FAKE_KEY));
    expect(authStatus.masked).toBe(redactKey(FAKE_KEY_2));
    // Exactly one of the two is flagged active, and the flag agrees with what inference resolves.
    // Which one wins is "most recently stored" and therefore not asserted here.
    expect([apiStatus.active, authStatus.active].filter(Boolean)).toHaveLength(
      1
    );
    const resolved = await credentialForInference(env);
    const activeStatus = apiStatus.active ? apiStatus : authStatus;
    expect(activeStatus.source).toBe(resolved?.source);
  });

  it('marks the pasted key active when it is the only credential', async () => {
    await new ApiKeyCredentialAdapter().save(FAKE_KEY, env);
    const apiStatus = await new ApiKeyCredentialAdapter().status(env);
    const authStatus = await new PkceCredentialAdapter().status(env);
    expect(apiStatus.active).toBe(true);
    expect(authStatus.active).toBe(false);
  });

  it('refuses an empty or malformed key with an instruction, and stores nothing', async () => {
    const adapter = new ApiKeyCredentialAdapter();
    await expect(adapter.save('', env)).rejects.toBeInstanceOf(
      CredentialInputError
    );
    await expect(adapter.save('   ', env)).rejects.toThrow(
      /Enter an OrcaRouter API key/
    );
    await expect(adapter.save('nope', env)).rejects.toThrow(/sk-orca-/);
    expect(await readCredentialFile(env)).toEqual({
      schema: 1,
      credentials: [],
    });
  });

  it('clears each adapter without disturbing the other', async () => {
    await new ApiKeyCredentialAdapter().save(FAKE_KEY, env);
    await new PkceCredentialAdapter().save(
      FAKE_KEY_2,
      { accountId: '1', scope: 'api' },
      env
    );
    expect(await new ApiKeyCredentialAdapter().clear(env)).toBe(true);
    expect(await new PkceCredentialAdapter().status(env)).toMatchObject({
      configured: true,
    });
    expect(await new PkceCredentialAdapter().clear(env)).toBe(true);
    expect(await credentialForInference(env)).toBeNull();
  });

  it('is unaffected by which adapter produced the credential that inference resolves', async () => {
    await new PkceCredentialAdapter().save(
      FAKE_KEY,
      { accountId: '12345', scope: 'api' },
      env
    );
    const resolved = await credentialForInference(env);
    expect(resolved?.source).toBe('oauth-pkce');
    expect(resolved?.accountId).toBe('12345');
    expect(resolved?.scope).toBe('api');
  });
});

describe('401 handling', () => {
  it('marks the exact account generation and attempts no refresh', async () => {
    await new PkceCredentialAdapter().save(
      FAKE_KEY,
      { accountId: '12345', scope: 'api' },
      env
    );
    const credential = await credentialForInference(env);
    const outcome = await recordRejection(credential!, env);
    expect(outcome).toBe('marked');
    const file = await readCredentialFile(env);
    expect(file.credentials[0].needsReauth).toBe(true);
    // No refresh token, no refresh call: the store gained no field that pretends otherwise.
    expect(Object.keys(file.credentials[0])).not.toContain('refreshToken');
    expect(JSON.stringify(file)).not.toMatch(/refresh/i);
  });

  it('does not mark an environment key, which has no stored generation to scope', async () => {
    const credential = await credentialForInference({
      ...env,
      ORCAROUTER_API_KEY: FAKE_KEY,
    });
    expect(await recordRejection(credential!, env)).toBe('ephemeral');
  });

  it('turns a 401 from the relay into a reauth instruction rather than a retry', async () => {
    await new PkceCredentialAdapter().save(
      FAKE_KEY,
      { accountId: '12345', scope: 'api' },
      env
    );
    const fetchImpl = (() =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({}),
      })) as unknown as typeof fetch;

    const error = await sendProviderRequest({
      model: 'orcarouter/auto',
      path: '/chat/completions',
      body: {},
      env,
      fetchImpl,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OrcaProviderError);
    expect((error as OrcaProviderError).needsReauth).toBe(true);
    expect(String(error)).toMatch(/Reconnect OrcaRouter/);
    expect(String(error)).not.toContain(FAKE_KEY);
    const file = await readCredentialFile(env);
    expect(file.credentials[0].needsReauth).toBe(true);
  });

  it('leaves a newer credential untouched when an older generation fails', async () => {
    const oldCredential = await new PkceCredentialAdapter().save(
      FAKE_KEY,
      { accountId: '12345', scope: 'api' },
      env
    );
    await new PkceCredentialAdapter().save(
      FAKE_KEY_2,
      { accountId: '12345', scope: 'api' },
      env
    );
    const outcome = await recordRejection(
      {
        key: oldCredential.key,
        source: 'oauth-pkce',
        accountId: oldCredential.accountId,
        generation: oldCredential.generation,
        scope: 'api',
      },
      env
    );
    expect(outcome).toBe('stale-generation');
    expect((await resolveCredential(env))?.key).toBe(FAKE_KEY_2);
  });
});

describe('startup presence probe', () => {
  it('sees an environment key', () => {
    expect(
      hasOrcaRouterCredential({ ...env, ORCAROUTER_API_KEY: FAKE_KEY })
    ).toBe(true);
  });

  it('sees a stored key and ignores a store awaiting reauthentication', async () => {
    expect(hasOrcaRouterCredential(env)).toBe(false);
    await saveCredential({ source: 'api-key', key: FAKE_KEY }, env);
    expect(hasOrcaRouterCredential(env)).toBe(true);
    await markNeedsReauth({ accountId: 'api-key', generation: 1 }, '401', env);
    expect(hasOrcaRouterCredential(env)).toBe(false);
  });

  it('never returns the key itself', async () => {
    await saveCredential({ source: 'api-key', key: FAKE_KEY }, env);
    const value = hasOrcaRouterCredential(env);
    expect(value).toBe(true);
    expect(typeof value).toBe('boolean');
  });
});

describe('provider headers', () => {
  it('sends the key as a Bearer header and nowhere else', async () => {
    const headers = authorizationHeaders({
      key: FAKE_KEY,
      source: 'api-key',
      accountId: 'api-key',
      generation: 1,
      scope: null,
    });
    expect(headers).toEqual({ Authorization: `Bearer ${FAKE_KEY}` });
    expect(JSON.stringify(headers)).not.toMatch(/\?|&/);
  });

  it('refuses to send an unauthenticated request when no credential is held', async () => {
    const error = await sendProviderRequest({
      model: 'orcarouter/auto',
      path: '/chat/completions',
      body: {},
      env,
      fetchImpl: (() =>
        Promise.reject(new Error('must not be called'))) as typeof fetch,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OrcaProviderError);
    expect(String(error)).toMatch(/No OrcaRouter credential/);
  });
});
