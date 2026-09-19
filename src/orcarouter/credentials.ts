/**
 * The one seam both authentication choices go through.
 *
 * WHY AN INTERFACE. "Paste a key" and "sign in with PKCE" differ only in how a credential is
 * ACQUIRED. Everything after that -- the Bearer header, the base URL, model discovery, the 401
 * recovery path -- is identical, and it has to stay identical or the two paths drift. So acquisition
 * is two adapters behind this interface and nothing downstream can tell which one produced the key:
 *
 *     ApiKeyCredentialAdapter    user pastes an sk-orca-… key
 *     PkceCredentialAdapter      browser consent issues one
 *
 * `CredentialResult` carries no `source`-dependent behaviour, which is asserted by test rather than
 * left as a convention -- a provider request built from an API-key result and one built from a PKCE
 * result are byte-identical.
 *
 * THE DASHBOARD IS A SEPARATE PROCESS FROM THE PROVIDER CALLS, and it is a browser. So the adapter
 * that runs in the dashboard never holds a key: it posts the secret to the loopback server, which
 * owns the store, and reads back a redacted status. `BrowserCredentialClient` below is that half.
 */

import {
  clearCredentials,
  looksLikeOrcaKey,
  markNeedsReauth,
  readCredentialFile,
  redactKey,
  resolveCredential,
  saveCredential,
  type OrcaCredentialSource,
  type ResolvedOrcaCredential,
} from './credential-store.js';

/** What both adapters produce. Nothing downstream may branch on `source`. */
export interface CredentialResult {
  readonly key: string;
  readonly source: OrcaCredentialSource;
  readonly accountId: string;
  readonly generation: number;
  readonly scope: string | null;
}

export function toCredentialResult(
  credential: ResolvedOrcaCredential
): CredentialResult {
  return {
    key: credential.key,
    source: credential.source,
    accountId: credential.accountId,
    generation: credential.generation,
    scope: credential.scope,
  };
}

export interface CredentialAdapter {
  readonly id: 'orcarouter' | 'orcarouter-oauth';
  readonly source: OrcaCredentialSource;
  /** The label a user sees. Distinct per adapter, everywhere both can appear. */
  readonly label: string;
  /** Is a usable credential currently held for this adapter? */
  status(env?: NodeJS.ProcessEnv): Promise<CredentialStatus>;
  /** Discard this adapter's stored credential. */
  clear(env?: NodeJS.ProcessEnv): Promise<boolean>;
}

export interface CredentialStatus {
  readonly configured: boolean;
  readonly masked: string;
  readonly accountId: string | null;
  readonly scope: string | null;
  readonly needsReauth: boolean;
  readonly reauthReason: string | null;
  readonly source: OrcaCredentialSource | null;
  /** True when this adapter's credential is the one inference would actually use. */
  readonly active: boolean;
  /** Where a user goes to manage or revoke the key this app holds. */
  readonly dashboardUrl: string;
}

export const ORCA_KEY_DASHBOARD_URL =
  'https://www.orcarouter.ai/console/authorized-apps';

export class CredentialInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CredentialInputError';
  }
}

/**
 * Adapter one: a key the user already has.
 *
 * This path is never removed in favour of PKCE. A user who already holds a key, or who is working on
 * a machine where a browser flow is not appropriate, must keep a working route to inference.
 */
export class ApiKeyCredentialAdapter implements CredentialAdapter {
  public readonly id = 'orcarouter' as const;
  public readonly source = 'api-key' as const;
  public readonly label = 'OrcaRouter - API';

  /**
   * Store a pasted key.
   *
   * The shape check is a typo catcher, not validation: an `sk-orca-` prefix proves nothing about
   * whether the credential is live, and this package has no non-billing endpoint to check it
   * against. Validity is established by the first real request.
   */
  public async save(
    rawKey: string,
    env: NodeJS.ProcessEnv = process.env
  ): Promise<CredentialResult> {
    const key = String(rawKey ?? '').trim();
    if (!key) {
      throw new CredentialInputError('Enter an OrcaRouter API key.');
    }
    if (!looksLikeOrcaKey(key)) {
      throw new CredentialInputError(
        'That does not look like an OrcaRouter API key. Keys start with "sk-orca-".'
      );
    }
    const stored = await saveCredential(
      { source: this.source, key, accountId: 'api-key' },
      env
    );
    return {
      key: stored.key,
      source: stored.source,
      accountId: stored.accountId,
      generation: stored.generation,
      scope: stored.scope,
    };
  }

  public async status(
    env: NodeJS.ProcessEnv = process.env
  ): Promise<CredentialStatus> {
    return statusFor(this.source, env);
  }

  public async clear(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    return (await clearCredentials(this.source, env)) > 0;
  }
}

/**
 * Adapter two: consent in a browser, exchanged for a key.
 *
 * The exchange itself lives in `connect.ts` because it needs a listener and a lifecycle; this class
 * is the store-facing half, so both adapters present the same three operations.
 */
export class PkceCredentialAdapter implements CredentialAdapter {
  public readonly id = 'orcarouter-oauth' as const;
  public readonly source = 'oauth-pkce' as const;
  public readonly label = 'OrcaRouter - Auth';

  /**
   * Persist the key the exchange returned.
   *
   * A PKCE-issued key is durable, not refreshable: it is stored exactly like a pasted one and reused
   * until OrcaRouter revokes it. Re-authorizing on every launch would hit the account's
   * 10-keys-per-24-hours cap and lock the user out, which is why nothing here is called at startup.
   */
  public async save(
    key: string,
    options: { accountId: string; scope: string | null },
    env: NodeJS.ProcessEnv = process.env
  ): Promise<CredentialResult> {
    const stored = await saveCredential(
      {
        source: this.source,
        key,
        accountId: options.accountId,
        scope: options.scope,
      },
      env
    );
    return {
      key: stored.key,
      source: stored.source,
      accountId: stored.accountId,
      generation: stored.generation,
      scope: stored.scope,
    };
  }

  public async status(
    env: NodeJS.ProcessEnv = process.env
  ): Promise<CredentialStatus> {
    return statusFor(this.source, env);
  }

  public async clear(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    return (await clearCredentials(this.source, env)) > 0;
  }
}

async function statusFor(
  source: OrcaCredentialSource,
  env: NodeJS.ProcessEnv
): Promise<CredentialStatus> {
  // Read the STORE for this adapter, not the resolved winner: a user who has both a pasted key and
  // an account login must see both as configured, with one of them marked active. Reporting the
  // resolved credential against both adapters would show one as configured and one as absent, which
  // is exactly the confusion the two separate choices exist to avoid.
  const file = await readCredentialFile(env);
  const stored = file.credentials.find(
    (entry) => entry.source === source && !entry.needsReauth
  );
  const resolved = await resolveCredential(env);
  const active = resolved?.source === source;
  return {
    configured: !!stored,
    masked: stored ? redactKey(stored.key) : '',
    accountId: stored?.accountId ?? null,
    scope: stored?.scope ?? null,
    needsReauth:
      !stored && file.credentials.some((entry) => entry.source === source),
    reauthReason:
      file.credentials.find((entry) => entry.source === source)?.reauthReason ??
      null,
    source: stored ? source : null,
    active,
    dashboardUrl: ORCA_KEY_DASHBOARD_URL,
  };
}

export const apiKeyAdapter = new ApiKeyCredentialAdapter();
export const pkceAdapter = new PkceCredentialAdapter();

export const CREDENTIAL_ADAPTERS: readonly CredentialAdapter[] = [
  apiKeyAdapter,
  pkceAdapter,
];

/**
 * Resolve the credential inference will use, from whichever adapter holds one.
 *
 * This is the function a provider request calls. It takes no adapter argument on purpose: a caller
 * that could name an adapter could branch on the answer, and the whole point of the seam is that the
 * request path cannot tell the difference.
 */
export async function credentialForInference(
  env: NodeJS.ProcessEnv = process.env
): Promise<CredentialResult | null> {
  const resolved = await resolveCredential(env);
  return resolved ? toCredentialResult(resolved) : null;
}

/**
 * Record that the relay rejected a request with 401.
 *
 * Delegates to the generation-scoped transition, so a late failure from a request issued before the
 * user reauthorized cannot mark the new credential as broken.
 */
export async function recordRejection(
  credential: CredentialResult,
  env: NodeJS.ProcessEnv = process.env
): Promise<'marked' | 'stale-generation' | 'unknown-account' | 'ephemeral'> {
  if (credential.source === 'api-key' && credential.accountId === 'api-key:env')
    return 'ephemeral';
  return markNeedsReauth(
    { accountId: credential.accountId, generation: credential.generation },
    'OrcaRouter rejected this key with HTTP 401.',
    env
  );
}
