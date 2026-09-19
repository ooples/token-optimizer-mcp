/**
 * The OrcaRouter provider: one endpoint, one Bearer header, whichever adapter supplied the key.
 *
 * WHAT THIS IS NOT. It is not a new HTTP client for inference. Every model call in this package
 * already goes through an OpenAI- or Anthropic-shaped path, and OrcaRouter is OpenAI-compatible, so
 * the provider's job is to answer three questions -- where is the endpoint, which key, which model --
 * and to leave the request bytes alone.
 *
 * THE PROXY'S PROVIDER PRESET IS THE SAME OBJECT. `src/proxy/server.ts` forwards verbatim and takes
 * its upstream from `TOKEN_OPTIMIZER_PROXY_UPSTREAM`; this module is what resolves that value when
 * the user names OrcaRouter, so the CLI, the launcher and the dashboard cannot disagree about the
 * endpoint.
 *
 * A 401 IS TERMINAL HERE. There is no refresh grant to attempt: the key is durable and the only
 * recovery is a new authorization, so a 401 marks the exact account generation for reauthentication
 * and returns a plain instruction. Retrying would send the same dead credential forever.
 */

import { resolveOrigins, type OrcaRouterOrigins } from './endpoints.js';
import {
  credentialForInference,
  recordRejection,
  type CredentialResult,
} from './credentials.js';
import {
  fetchCatalog,
  type CatalogRequest,
  type CatalogResult,
} from './catalog.js';

export interface OrcaProviderIdentity {
  readonly id: 'orcarouter';
  readonly label: 'OrcaRouter';
  /** The value a user puts in a provider dropdown. */
  readonly wireApi: 'openai';
}

export const ORCAROUTER_PROVIDER: OrcaProviderIdentity = Object.freeze({
  id: 'orcarouter',
  label: 'OrcaRouter',
  wireApi: 'openai',
});

export interface OrcaProviderConfig {
  readonly origins: OrcaRouterOrigins;
  readonly credential: CredentialResult | null;
  /** False when no key is held, so callers can explain rather than send an unauthenticated request. */
  readonly ready: boolean;
}

export async function resolveProvider(
  env: NodeJS.ProcessEnv = process.env
): Promise<OrcaProviderConfig> {
  const origins = resolveOrigins(env);
  const credential = await credentialForInference(env);
  return { origins, credential, ready: credential !== null };
}

/**
 * Headers for a request to the relay.
 *
 * `Authorization: Bearer` only. The key is never placed in a query string, a body, or a header that
 * a proxy would log by default.
 */
export function authorizationHeaders(
  credential: CredentialResult
): Record<string, string> {
  return { Authorization: `Bearer ${credential.key}` };
}

export interface ProviderRequestOptions {
  readonly model: string;
  readonly path: '/chat/completions' | '/responses' | '/embeddings';
  readonly body: unknown;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

export interface ProviderResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: unknown;
}

export class OrcaProviderError extends Error {
  public readonly status: number | null;
  public readonly needsReauth: boolean;

  public constructor(
    message: string,
    options: { status?: number | null; needsReauth?: boolean } = {}
  ) {
    super(message);
    this.name = 'OrcaProviderError';
    this.status = options.status ?? null;
    this.needsReauth = options.needsReauth ?? false;
  }
}

/**
 * Send one request through the relay.
 *
 * Deliberately the only place a provider request is assembled, so the base URL and the header cannot
 * drift between entry points. It returns the parsed body rather than a typed response: the callers
 * here (summarization, the proxy's own forwarding, diagnostics) each read a different shape.
 */
export async function sendProviderRequest(
  options: ProviderRequestOptions
): Promise<ProviderResponse> {
  const env = options.env ?? process.env;
  const provider = await resolveProvider(env);
  if (!provider.credential) {
    throw new OrcaProviderError(
      'No OrcaRouter credential is configured. Add an API key or connect with OrcaRouter first.'
    );
  }
  const url = `${provider.origins.apiBase}${options.path}`;
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authorizationHeaders(provider.credential),
    },
    body: JSON.stringify({ ...(options.body as object), model: options.model }),
    signal: options.signal,
  });

  if (response.status === 401) {
    // Terminal, and scoped to the generation that was rejected. No refresh is attempted because
    // there is nothing to refresh with.
    const outcome = await recordRejection(provider.credential, env);
    throw new OrcaProviderError(
      outcome === 'stale-generation'
        ? 'OrcaRouter rejected an older credential after this account was reconnected; the current credential is unaffected.'
        : 'OrcaRouter rejected this key. Reconnect OrcaRouter to continue.',
      { status: 401, needsReauth: outcome !== 'stale-generation' }
    );
  }
  if (!response.ok) {
    throw new OrcaProviderError(
      `OrcaRouter answered HTTP ${response.status}.`,
      { status: response.status }
    );
  }
  const json = await response.json().catch(() => null);
  return { ok: true, status: response.status, json };
}

/** Model discovery for whichever entry point is asking. */
export async function discoverModels(
  request: CatalogRequest,
  env: NodeJS.ProcessEnv = process.env
): Promise<CatalogResult> {
  const origins = resolveOrigins(env);
  const credential = await credentialForInference(env);
  return fetchCatalog(origins, credential?.key ?? null, request);
}
