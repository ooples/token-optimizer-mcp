/**
 * OrcaRouter's two public origins, and the rule that neither is derived from the other.
 *
 * WHY THIS IS ITS OWN MODULE. The single most common OrcaRouter integration mistake is reaching
 * `https://api.orcarouter.ai/v1/auth/keys` and getting a 404 that reads like a routing bug on the
 * provider's side. The relay is at `/v1` on `api.orcarouter.ai`; authentication is a different host
 * entirely, `www.orcarouter.ai`, whose API endpoints live under `/api/v1/auth`. Appending `/v1` to
 * an auth URL, or swapping one hostname for the other, produces a URL that looks right and is not.
 * So the paths are constants here and nothing else in this package composes them.
 *
 * SELF-HOSTED DEPLOYMENTS may run both roles on one origin or on two, which is why a shared
 * fallback (`ORCA_BASE_URL`) exists beside the explicit overrides (`ORCA_AUTH_BASE_URL`,
 * `ORCA_API_BASE_URL`). Explicit always wins, and the fallback is never applied to only one of them.
 */

/** Consent screen origin. Not an API. */
export const DEFAULT_AUTH_BASE = 'https://www.orcarouter.ai';

/** Inference and model discovery. The OpenAI-compatible relay. */
export const DEFAULT_API_BASE = 'https://api.orcarouter.ai/v1';

/** Fixed, per the protocol: the consent screen path. */
export const AUTHORIZE_PATH = '/auth';

/** Fixed, per the protocol: the code-for-key exchange. NOT under the relay's `/v1`. */
export const EXCHANGE_PATH = '/api/v1/auth/keys';

export const DEVICE_CODE_PATH = '/api/v1/auth/device/code';
export const DEVICE_TOKEN_PATH = '/api/v1/auth/device/token';
export const OPENID_CONFIGURATION_PATH = '/.well-known/openid-configuration';

/** The literal `callback_url` value that asks for a displayed code instead of a redirect. */
export const OUT_OF_BAND_CALLBACK = 'oob';

export interface OrcaRouterOrigins {
  readonly authBase: string;
  readonly apiBase: string;
}

export class OrcaRouterConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OrcaRouterConfigError';
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    LOOPBACK_HOSTS.has(host) || /^127[.]\d{1,3}[.]\d{1,3}[.]\d{1,3}$/.test(host)
  );
}

/**
 * Refuse a remote origin that is not HTTPS.
 *
 * A credential is minted over this connection and an inference key travels on the other one, so
 * cleartext to anything but this machine is refused rather than warned about. Loopback over HTTP is
 * allowed because that is how a local deployment is developed against.
 */
export function assertSecureOrigin(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OrcaRouterConfigError(`${label} is not a valid URL: ${raw}`);
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url;
  throw new OrcaRouterConfigError(
    `${label} must be https (http is allowed only for loopback): ${raw}`
  );
}

function trimmed(value: string | undefined): string | null {
  const text = String(value ?? '').trim();
  return text.length ? text : null;
}

/**
 * Resolve both origins from the environment.
 *
 * Precedence per origin: its explicit override, then the shared self-hosted base, then the public
 * default. The shared value is applied to BOTH origins rather than one, because a self-hosted
 * install that set only `ORCA_BASE_URL` means "everything is here".
 */
export function resolveOrigins(
  env: NodeJS.ProcessEnv = process.env
): OrcaRouterOrigins {
  const shared = trimmed(env.ORCA_BASE_URL);
  const authBase =
    trimmed(env.ORCA_AUTH_BASE_URL) ?? shared ?? DEFAULT_AUTH_BASE;
  const apiBase = trimmed(env.ORCA_API_BASE_URL) ?? shared ?? DEFAULT_API_BASE;
  assertSecureOrigin(authBase, 'ORCA_AUTH_BASE_URL');
  assertSecureOrigin(apiBase, 'ORCA_API_BASE_URL');
  return {
    authBase: stripTrailingSlash(authBase),
    apiBase: stripTrailingSlash(apiBase),
  };
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export interface AuthorizeParams {
  /** A loopback callback URL, or the literal `oob`. */
  readonly callbackUrl: string;
  /** `base64url(sha256(verifier))`, no padding. Always S256. */
  readonly codeChallenge: string;
  readonly state: string;
  readonly appName: string;
  readonly scope: 'api' | 'connector';
  readonly loginHint?: string;
  readonly workspaceHint?: string;
  readonly prompt?: 'consent';
}

/**
 * Build the consent URL.
 *
 * Takes the challenge, never the verifier: the verifier must not be able to reach a URL, and a
 * function that accepts one cannot enforce that. Everything a caller passes here is public by
 * construction.
 */
export function buildAuthorizeUrl(
  origins: OrcaRouterOrigins,
  params: AuthorizeParams
): string {
  const url = new URL(`${origins.authBase}${AUTHORIZE_PATH}`);
  url.searchParams.set('callback_url', params.callbackUrl);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', params.state);
  url.searchParams.set('app_name', params.appName);
  url.searchParams.set('scope', params.scope);
  if (params.loginHint) url.searchParams.set('login_hint', params.loginHint);
  if (params.workspaceHint)
    url.searchParams.set('workspace_hint', params.workspaceHint);
  if (params.prompt) url.searchParams.set('prompt', params.prompt);
  return url.toString();
}

export function buildExchangeUrl(origins: OrcaRouterOrigins): string {
  return `${origins.authBase}${EXCHANGE_PATH}`;
}

export function buildModelsUrl(
  origins: OrcaRouterOrigins,
  capability?: string
): string {
  const url = new URL(`${origins.apiBase}/models`);
  if (capability) url.searchParams.set('capability', capability);
  return url.toString();
}

/** The redirect the consent screen delivers a code to. */
export function loopbackCallbackUrl(port: number): string {
  return `http://127.0.0.1:${port}/cb`;
}
