/**
 * The OrcaRouter connect flow: OAuth 2.0 with PKCE, no client secret, no pre-registered redirect.
 *
 * FLOW A (loopback redirect) IS THE DEFAULT. This package always runs on the machine the user is
 * sitting at -- the dashboard binds a loopback port and the CLI runs in their terminal -- so a
 * `http://127.0.0.1:<port>/cb` listener is always available and the user clicks once. FLOW B
 * (out-of-band code) is offered beside it for the case where the dashboard is being read through a
 * remote browser, or the loopback listener cannot bind, and the code has to travel by hand.
 *
 * FLOW C (device grant) IS NOT IMPLEMENTED. The protocol guide says to implement one flow, and a
 * device grant exists for clients with no browser at all. This one has a browser on both of its
 * surfaces. The constants for it live in `endpoints.ts` so a later addition does not re-derive them.
 *
 * WHAT THE EXCHANGE RETURNS IS A DURABLE API KEY, NOT A REFRESH TOKEN. There is no refresh endpoint
 * to call and no grant to fabricate, so this module never schedules one. A key is reused until
 * OrcaRouter revokes it; a 401 from the relay is terminal and means re-authenticate, which
 * `credential-store.ts` records against the exact account generation that was rejected.
 *
 * ATTEMPTS ARE GENERATION-GUARDED. Every start bumps a counter, and every asynchronous step --
 * the listener callback, the exchange response, a manual code submission -- confirms it still
 * belongs to the current generation before it is allowed to produce a credential or change state.
 * A late success from a cancelled attempt therefore cannot install a key the user did not ask for,
 * and a late failure cannot clear one they did.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildAuthorizeUrl,
  buildExchangeUrl,
  loopbackCallbackUrl,
  OUT_OF_BAND_CALLBACK,
  type OrcaRouterOrigins,
} from './endpoints.js';
import { createPkcePair, stateMatches, type PkcePair } from './pkce.js';

/** The scope this integration asks for. `connector` is refused before a code is minted. */
const REQUESTED_SCOPE = 'api' as const;

const APP_NAME = 'Token Optimizer MCP';

/** Auth codes live 10 minutes; the listener waits slightly less so the error is ours, not theirs. */
export const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 300_000;

const EXCHANGE_TIMEOUT_MS = 30_000;

export type ConnectMode = 'loopback' | 'oob';

export type ConnectFailureKind =
  | 'denied'
  | 'state-mismatch'
  | 'timeout'
  | 'cancelled'
  | 'exchange-rejected'
  | 'exchange-failed'
  | 'rate-limited'
  | 'network'
  | 'scope';

/**
 * A failure a user can act on.
 *
 * The message never carries the code, the verifier or the key: an error string reaches logs, the
 * dashboard and a terminal, and a credential that appears in any of those is a credential that has
 * to be revoked. `detail` is therefore assembled from status codes and protocol error names only.
 */
export class OrcaConnectError extends Error {
  public readonly kind: ConnectFailureKind;
  public readonly detail: string | null;
  public readonly status: number | null;

  public constructor(
    kind: ConnectFailureKind,
    message: string,
    options: { detail?: string | null; status?: number | null } = {}
  ) {
    super(message);
    this.name = 'OrcaConnectError';
    this.kind = kind;
    this.detail = options.detail ?? null;
    this.status = options.status ?? null;
  }
}

export interface StartOptions {
  readonly mode: ConnectMode;
  readonly origins: OrcaRouterOrigins;
  readonly loginHint?: string;
  readonly workspaceHint?: string;
  readonly timeoutMs?: number;
  /** Injected in tests so a fake auth server can be exercised through this exact adapter. */
  readonly fetchImpl?: typeof fetch;
  /** Injected in tests to prove the verifier and state come from a cryptographic RNG. */
  readonly random?: (size: number) => Buffer;
}

export interface StartedConnect {
  readonly attemptId: string;
  readonly mode: ConnectMode;
  readonly authorizeUrl: string;
  /** Present for Flow A: the loopback URL the consent screen will deliver the code to. */
  readonly redirectUri: string | null;
}

export interface ExchangeOutcome {
  readonly key: string;
  readonly accountId: string;
  readonly scope: string;
  /** True when the granted scope is not the one requested. Reported, never silently accepted. */
  readonly scopeDowngraded: boolean;
}

interface Attempt {
  readonly id: string;
  readonly generation: number;
  readonly mode: ConnectMode;
  readonly pkce: PkcePair;
  readonly origins: OrcaRouterOrigins;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  server: Server | null;
  redirectUri: string | null;
  settle: ((code: string) => void) | null;
  fail: ((error: OrcaConnectError) => void) | null;
  timer: NodeJS.Timeout | null;
  /** A code that arrived before `complete` was waiting for it. Never overwritten. */
  pendingCode: string | null;
  /** A failure that happened before `complete` was waiting for it. */
  pendingFailure: OrcaConnectError | null;
  /** Set once the code is in hand, so a second delivery cannot overwrite the first. */
  delivered: boolean;
  /**
   * True once a newer attempt has started. The attempt keeps running to completion -- so an HTTP
   * request already waiting on it is answered rather than hanging -- but it may not install a
   * credential, because a newer login owns that decision now.
   */
  superseded: boolean;
  cancelled: boolean;
}

/**
 * Owns at most one live attempt per id.
 *
 * The dashboard keeps one of these for the life of the server, which is what makes
 * "the browser went away mid-login" a recoverable state rather than a stuck one: the page tells the
 * server to cancel, and the server releases the listener and the pending promise.
 */
export class OrcaConnectManager {
  private readonly attempts = new Map<string, Attempt>();
  private generation = 0;
  private counter = 0;

  /** Start an attempt. Returns the URL to open; nothing is stored until the exchange succeeds. */
  public async start(options: StartOptions): Promise<StartedConnect> {
    this.generation += 1;
    this.counter += 1;
    // Every attempt that was live before this one is now superseded: its success or failure can no
    // longer be attributed to the login the user is currently performing.
    for (const existing of this.attempts.values()) existing.superseded = true;
    const attempt: Attempt = {
      id: `orca-${this.counter}-${Date.now().toString(36)}`,
      generation: this.generation,
      mode: options.mode,
      pkce: createPkcePair(options.random),
      origins: options.origins,
      fetchImpl: options.fetchImpl ?? fetch,
      timeoutMs: options.timeoutMs ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS,
      server: null,
      redirectUri: null,
      settle: null,
      fail: null,
      timer: null,
      pendingCode: null,
      pendingFailure: null,
      delivered: false,
      superseded: false,
      cancelled: false,
    };

    let callbackUrl: string;
    if (options.mode === 'loopback') {
      const bound = await this.bindListener(attempt);
      callbackUrl = bound.redirectUri;
      attempt.redirectUri = bound.redirectUri;
      attempt.server = bound.server;
    } else {
      callbackUrl = OUT_OF_BAND_CALLBACK;
    }

    this.attempts.set(attempt.id, attempt);
    // The listener is bound BEFORE the URL is built, so the port in the URL is the port actually
    // listening. Building the URL first and binding after is the race that leaves the user staring
    // at a consent screen whose callback goes nowhere.
    const authorizeUrl = buildAuthorizeUrl(attempt.origins, {
      callbackUrl,
      codeChallenge: attempt.pkce.challenge,
      state: attempt.pkce.state,
      appName: APP_NAME,
      scope: REQUESTED_SCOPE,
      loginHint: options.loginHint,
      workspaceHint: options.workspaceHint,
    });

    return {
      attemptId: attempt.id,
      mode: attempt.mode,
      authorizeUrl,
      redirectUri: attempt.redirectUri,
    };
  }

  private bindListener(attempt: Attempt): Promise<{
    server: Server;
    redirectUri: string;
  }> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/cb') {
          response.writeHead(404, { 'Content-Type': 'text/plain' });
          response.end('not found');
          return;
        }
        this.closeListener(attempt);

        // VALIDATE FIRST, THEN ANSWER. The page the user is looking at has to describe what actually
        // happened: telling someone "Connected" for a state mismatch, a denial or a missing code is
        // the one lie this flow can tell, and it sends them back to a tool that holds no credential
        // while believing otherwise. So the outcome is decided here and only then rendered.
        const outcome = this.readCallback(attempt, url);
        if (outcome.kind === 'code') this.deliverCode(attempt, outcome.code);
        else this.failAttempt(attempt, outcome.error);

        response.writeHead(outcome.page.status, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(outcome.page.html);
      });

      server.on('error', (error: Error) => {
        reject(
          new OrcaConnectError(
            'network',
            `Could not listen on loopback for the authorization callback: ${error.message}`
          )
        );
      });

      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo;
        resolve({
          server,
          redirectUri: loopbackCallbackUrl(address.port),
        });
      });
    });
  }

  private closeListener(attempt: Attempt): void {
    attempt.server?.close();
    attempt.server = null;
  }

  /**
   * Read one callback and decide both its failure and the page to show for it.
   *
   * The order is the security property, not a style choice: STATE FIRST, before the code and before
   * the `error` parameter. The listener is reachable by anything that can reach loopback, so a code
   * dropped on it by some other page must be discarded without being read, and a denial forged by
   * that page must not be allowed to end a real attempt either.
   *
   * Every branch returns a page, including the ones that carry a failure, because a browser is
   * sitting on this URL and a blank response reads as a broken tool.
   */
  private readCallback(
    attempt: Attempt,
    url: URL
  ):
    | { kind: 'code'; code: string; page: CallbackPage }
    | { kind: 'error'; error: OrcaConnectError; page: CallbackPage } {
    if (attempt.cancelled) {
      const error = new OrcaConnectError(
        'cancelled',
        'The connection attempt was cancelled. Nothing was stored.'
      );
      return {
        kind: 'error',
        error,
        page: callbackPage(
          'cancelled',
          'This sign-in was cancelled',
          'Nothing was stored. You can close this tab and start the connection again from Token Optimizer.'
        ),
      };
    }
    // A second delivery cannot change the outcome, and saying "Connected" again for a code that was
    // already redeemed would be the same untruth in a quieter form.
    if (attempt.delivered) {
      return {
        kind: 'error',
        error: new OrcaConnectError(
          'exchange-rejected',
          'That authorization response had already been received. Start the connection again.'
        ),
        page: callbackPage(
          'already-received',
          'This sign-in was already received',
          'Token Optimizer is already using the response from this attempt. You can close this tab.'
        ),
      };
    }

    if (!stateMatches(attempt.pkce.state, url.searchParams.get('state'))) {
      const error = new OrcaConnectError(
        'state-mismatch',
        'The authorization response did not match this login attempt, so it was discarded. Start the connection again.'
      );
      return {
        kind: 'error',
        error,
        page: callbackPage(
          'state-mismatch',
          'This response did not match your sign-in',
          'Token Optimizer discarded it and nothing was stored. Close this tab and start the connection again from the dashboard.'
        ),
      };
    }

    const error = url.searchParams.get('error');
    if (error) {
      const denied = error === 'access_denied';
      const failure = denied
        ? new OrcaConnectError(
            'denied',
            'Authorization was denied in the browser. Nothing was stored.'
          )
        : new OrcaConnectError(
            'exchange-rejected',
            `Authorization failed with "${error}". Start the connection again.`,
            { detail: error }
          );
      return {
        kind: 'error',
        error: failure,
        page: denied
          ? callbackPage(
              'denied',
              'Authorization was denied',
              'Nothing was stored and no key was issued. You can close this tab and start the connection again if that was not what you meant.'
            )
          : callbackPage(
              'failed',
              'Authorization did not complete',
              'Nothing was stored. Close this tab and start the connection again from the dashboard.'
            ),
      };
    }

    const code = url.searchParams.get('code');
    if (!code) {
      const failure = new OrcaConnectError(
        'exchange-rejected',
        'The authorization response carried no code. Start the connection again.'
      );
      return {
        kind: 'error',
        error: failure,
        page: callbackPage(
          'no-code',
          'No authorization code was returned',
          'Nothing was stored. Close this tab and start the connection again from the dashboard.'
        ),
      };
    }

    return {
      kind: 'code',
      code,
      page: callbackPage(
        'connected',
        'Connected to OrcaRouter',
        'You can close this tab and return to Token Optimizer.'
      ),
    };
  }

  /**
   * A code is in hand.
   *
   * IT MAY ARRIVE BEFORE ANYONE IS WAITING. The consent screen can deliver its redirect the instant
   * the listener is bound, which is earlier than the HTTP request that called `complete` has been
   * read -- so the code is held and handed to the first waiter rather than dropped. Dropping it
   * would leave the exchange waiting for a second delivery that is never coming, which is a hang.
   */
  private deliverCode(attempt: Attempt, code: string): void {
    if (attempt.cancelled || attempt.delivered) return;
    attempt.delivered = true;
    if (attempt.settle) attempt.settle(code);
    else attempt.pendingCode = code;
  }

  private failAttempt(attempt: Attempt, error: OrcaConnectError): void {
    if (attempt.cancelled) return;
    // A failure before anyone is waiting is remembered, for the same reason a code is: the waiter
    // must be rejected rather than left holding a promise that will never settle.
    if (attempt.fail) attempt.fail(error);
    else attempt.pendingFailure = error;
  }

  /**
   * Hand the manager a code typed by a human (Flow B), or a code from a browser that picked
   * "Show me a code" while a loopback attempt was waiting.
   */
  public submitCode(attemptId: string, code: string): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.cancelled) {
      throw new OrcaConnectError(
        'cancelled',
        'That login attempt is no longer active. Start the connection again.'
      );
    }
    const trimmed = String(code ?? '').trim();
    if (!trimmed) {
      throw new OrcaConnectError(
        'exchange-rejected',
        'No code was submitted. Paste the code shown on the authorization page.'
      );
    }
    this.deliverCode(attempt, trimmed);
  }

  /** The attempt's generation, so a caller can prove its response is still current. */
  public generationOf(attemptId: string): number | null {
    return this.attempts.get(attemptId)?.generation ?? null;
  }

  public isCurrent(attemptId: string): boolean {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.cancelled || attempt.superseded) return false;
    return attempt.generation === this.generation;
  }

  /**
   * Install this attempt's credential, unless a newer attempt has taken over in the meantime.
   *
   * WHY THE CHECK AND THE WRITE ARE ONE OPERATION. A caller that asks "may I install?" and then
   * awaits the store before writing has left a window between the two, and that window is reachable
   * in normal use: `start()` is a separate HTTP request, so a second sign-in can arrive and move the
   * generation while the first one's `saveCredential` is in flight. The older attempt then installs a
   * key the user already replaced, and the store's own lock does not help -- it serializes the
   * writes, not the decision that precedes them.
   *
   * So the manager owns the whole decision. The generation is re-read synchronously, immediately
   * before `install` is invoked, and nothing in this process can start a new attempt in between:
   * JavaScript runs this callback to its first await without yielding, and `start()` is synchronous
   * up to the point where it bumps the generation. An attempt that has been superseded or cancelled
   * gets `'superseded'` and its credential is never written.
   */
  public async installIfCurrent<T>(
    attemptId: string,
    install: () => Promise<T>
  ): Promise<
    | { installed: true; value: T }
    | { installed: false; reason: 'unknown' | 'superseded' }
  > {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return { installed: false, reason: 'unknown' };
    if (attempt.cancelled || attempt.superseded) {
      return { installed: false, reason: 'superseded' };
    }
    return { installed: true, value: await install() };
  }

  /**
   * Wait for the code and exchange it.
   *
   * A cancel, a denial, a timeout, an expired code, a reused code, a 403, a 429 and a transport
   * failure all end here with an `OrcaConnectError` and no credential. None of them retries: a
   * hot loop against the exchange endpoint would burn the account's 10-keys-per-24-hours budget
   * while telling the user nothing.
   */
  public async complete(attemptId: string): Promise<ExchangeOutcome> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      throw new OrcaConnectError(
        'cancelled',
        'That login attempt is no longer active. Start the connection again.'
      );
    }

    let code: string;
    try {
      code = await this.awaitCode(attempt);
    } finally {
      // Releasing the listener and the timer happens on every path, including the ones that throw.
      // The attempt itself stays in the map: its outcome still has to be attributable, and
      // `installIfCurrent` is what refuses a credential for an attempt that was cancelled or
      // superseded.
      this.releaseResources(attempt);
    }

    return this.exchange(attempt, code);
  }

  /** Release the listener, the timer and the pending callbacks. Does not change generation. */
  private releaseResources(attempt: Attempt): void {
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.timer = null;
    this.closeListener(attempt);
  }

  private awaitCode(attempt: Attempt): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const finish = (): void => {
        if (attempt.timer) clearTimeout(attempt.timer);
        attempt.timer = null;
      };

      attempt.settle = (code: string) => {
        finish();
        resolve(code);
      };
      attempt.fail = (error: OrcaConnectError) => {
        finish();
        reject(error);
      };

      // The listener's own callbacks already route here through `deliverCode` and `failAttempt`;
      // nothing needs re-wrapping. A code or a failure that arrived first is handed over now.
      if (attempt.pendingFailure) {
        const pending = attempt.pendingFailure;
        attempt.pendingFailure = null;
        attempt.fail(pending);
        return;
      }
      if (attempt.pendingCode !== null) {
        const pending = attempt.pendingCode;
        attempt.pendingCode = null;
        attempt.settle(pending);
        return;
      }

      attempt.timer = setTimeout(() => {
        this.failAttempt(
          attempt,
          new OrcaConnectError(
            'timeout',
            'The authorization window closed before it was approved. Nothing was stored; start the connection again.'
          )
        );
      }, attempt.timeoutMs);
      // Never hold the process open for a login nobody is completing.
      attempt.timer.unref?.();
    });
  }

  /**
   * Cancel an attempt and release everything it holds.
   *
   * Called for an explicit Cancel, for switching authentication method, for a modal closing, for
   * an unmount, and from the `pagehide` handler -- where the caller must ALSO clear its own busy
   * flag synchronously, because the guarded continuation that would normally do it refuses to run
   * once the generation has moved on.
   */
  public cancel(attemptId: string): boolean {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return false;
    const wasActive = !attempt.cancelled;
    attempt.cancelled = true;
    this.closeListener(attempt);
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.timer = null;
    if (attempt.fail) {
      attempt.fail(
        new OrcaConnectError(
          'cancelled',
          'The connection attempt was cancelled. Nothing was stored.'
        )
      );
    } else {
      attempt.pendingFailure = new OrcaConnectError(
        'cancelled',
        'The connection attempt was cancelled. Nothing was stored.'
      );
    }
    attempt.settle = null;
    attempt.fail = null;
    attempt.pendingCode = null;
    attempt.pendingFailure = null;
    this.generation += 1;
    this.attempts.delete(attemptId);
    return wasActive;
  }

  /** Cancel every live attempt. Used on shutdown, where no credential may be installed. */
  public cancelAll(): void {
    for (const id of [...this.attempts.keys()]) this.cancel(id);
  }

  /** Live attempt count, so a test can prove a cancel really released the listener. */
  public get activeCount(): number {
    return this.attempts.size;
  }

  private async exchange(
    attempt: Attempt,
    code: string
  ): Promise<ExchangeOutcome> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await attempt.fetchImpl(buildExchangeUrl(attempt.origins), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          // The verifier travels here and only here. It was never in the authorize URL, never in
          // the callback, and is not in any error this module throws.
          code_verifier: attempt.pkce.verifier,
          code_challenge_method: 'S256',
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new OrcaConnectError(
        'network',
        `Could not reach OrcaRouter to finish signing in (${
          error instanceof Error ? error.name : 'transport error'
        }). Check the network and try again.`
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) throw exchangeError(response.status);
    let body: { key?: unknown; user_id?: unknown; scope?: unknown };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new OrcaConnectError(
        'exchange-failed',
        'OrcaRouter answered the sign-in with a body that could not be read. Nothing was stored.',
        { status: response.status }
      );
    }
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!key) {
      throw new OrcaConnectError(
        'exchange-failed',
        'OrcaRouter answered the sign-in without a key. Nothing was stored.',
        { status: response.status }
      );
    }
    // `scope` is what was GRANTED, not what was asked for. A workspace role can narrow it, and the
    // caller is told so rather than being left to assume it holds the wider grant.
    const scope = typeof body.scope === 'string' ? body.scope : '';
    const accountId =
      typeof body.user_id === 'string' || typeof body.user_id === 'number'
        ? String(body.user_id)
        : 'unknown';
    return {
      key,
      accountId,
      scope,
      scopeDowngraded: scope !== REQUESTED_SCOPE,
    };
  }
}

/** One rendered browser page: an HTTP status and the HTML that describes the outcome. */
interface CallbackPage {
  readonly status: number;
  readonly html: string;
}

/**
 * The page the browser is left on.
 *
 * Static strings only -- no query parameter, no code and no error text from the request is
 * interpolated into this markup. A callback URL is attacker-reachable by construction (that is what
 * the state comparison is for), so echoing anything from it would turn the consent redirect into a
 * reflected-content surface.
 */
function callbackPage(
  kind: string,
  heading: string,
  detail: string
): CallbackPage {
  const status = kind === 'connected' ? 200 : kind === 'cancelled' ? 409 : 400;
  return {
    status,
    html:
      '<!doctype html><meta charset="utf-8">' +
      `<title>OrcaRouter — ${heading}</title>` +
      '<main style="font:14px/1.5 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem">' +
      `<h1 style="font-size:1.15rem;margin:0 0 .5rem">${heading}</h1>` +
      `<p style="margin:0;color:#555">${detail}</p>` +
      `<p style="margin:1rem 0 0;color:#888;font-size:12px">Outcome: ${kind}</p>` +
      '</main>',
  };
}

function exchangeError(status: number): OrcaConnectError {
  if (status === 400) {
    return new OrcaConnectError(
      'exchange-rejected',
      'OrcaRouter refused the sign-in because the challenge method did not match the one this attempt started with. Start the connection again.',
      { status }
    );
  }
  if (status === 403) {
    return new OrcaConnectError(
      'exchange-rejected',
      'That authorization code was already used, has expired, or does not belong to this attempt. Start the connection again.',
      { status }
    );
  }
  if (status === 429) {
    return new OrcaConnectError(
      'rate-limited',
      'OrcaRouter refused a new key for this account because too many were issued in the last 24 hours. Reuse an existing key, or wait before connecting again.',
      { status }
    );
  }
  return new OrcaConnectError(
    'exchange-failed',
    `OrcaRouter refused the sign-in with HTTP ${status}. Nothing was stored.`,
    { status }
  );
}
