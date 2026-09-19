/**
 * Who is allowed to talk to the dashboard, and how they prove it.
 *
 * THE SHAPE OF THE PROBLEM. This server holds an OrcaRouter API key and can install or delete one
 * over HTTP. Until now it bound every interface (`app.listen(PORT)` with no host), answered with a
 * wildcard `Access-Control-Allow-Origin`, and required no authentication of any kind. Anything on
 * the same network could drive it, and so could any web page the user happened to visit.
 *
 * Three defences, because each one alone has a documented way past it:
 *
 *   1. BIND TO LOOPBACK. Removes the network reach. Not sufficient on its own: a page in the user's
 *      own browser is already on loopback as far as the socket is concerned.
 *
 *   2. A LITERAL HOST ALLOWLIST. This is the DNS-rebinding defence. An attacker points
 *      evil.example at 127.0.0.1, so the connection genuinely arrives on loopback and the browser
 *      genuinely considers it same-origin -- `Origin` and `Host` agree, and any check that compares
 *      them to each other passes. What the attacker cannot do is make `Host` read `localhost`, so
 *      the comparison is against a fixed list rather than against the request itself. webpack-dev-
 *      server and Jupyter both added exactly this, each after a CVE.
 *
 *   3. A CAPABILITY TOKEN. The strongest of the three, and the one that makes the others belt and
 *      braces. A secret is generated per run, written 0600, and embedded in the HTML this server
 *      returns. Mutating requests must echo it in a header. A cross-origin page cannot read that
 *      HTML -- it is not a CORS-readable response -- so it cannot learn the token, and a request it
 *      forges is refused even when the origin and host look perfect. This is Jupyter's model.
 *
 * WHAT IS DELIBERATELY NOT HERE. No password, no login, no session. The trust boundary is the
 * filesystem: whoever can read a 0600 file in the user's own home is already the user.
 */

/* eslint-disable n/no-sync -- SYNCHRONOUS ON PURPOSE, for the reason supervisor.ts and
 * default-routing.ts record. `capabilityToken` is called from inside Express middleware, which is
 * synchronous: there is no point at which an await could be introduced without restructuring every
 * caller. The read happens once per process and is then cached, so the blocking cost is a single
 * small file at first request, and the alternative -- serving a request before the token exists --
 * is the failure this module exists to prevent. */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { optimizerHome } from '../proxy/default-routing.js';

/** The header a browser must echo. Non-simple, so a cross-origin form post cannot set it either. */
export const TOKEN_HEADER = 'x-token-optimizer-dashboard';

/**
 * Hosts this server answers to, as literal strings.
 *
 * Compared against `Host` verbatim rather than resolved, because resolution is precisely what the
 * attacker controls. A port is stripped before the comparison; the port is not a secret.
 */
const ALLOWED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
  '0.0.0.0',
]);

/** Methods that can change something. GET and HEAD are readable and carry no token requirement. */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The interface to bind.
 *
 * LOOPBACK BY DEFAULT, which is the change in behaviour: a dashboard that was reachable from the
 * LAN no longer is. The override exists because someone genuinely does run this on a box they reach
 * from elsewhere, and silently breaking them would be its own failure -- but they have to ask.
 */
export function dashboardHost(env: NodeJS.ProcessEnv = process.env): string {
  const requested = String(env.TOKEN_OPTIMIZER_DASHBOARD_HOST ?? '').trim();
  return requested.length > 0 ? requested : '127.0.0.1';
}

/** True when the bind address is not loopback, i.e. the user opted into network exposure. */
export function isExposed(env: NodeJS.ProcessEnv = process.env): boolean {
  const host = dashboardHost(env);
  return !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
}

function hostname(value: string | undefined): string {
  if (!value) return '';
  // IPv6 literals arrive bracketed, and only the trailing :port may be stripped.
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    return close === -1 ? value : value.slice(0, close + 1);
  }
  const colon = value.lastIndexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

/**
 * Reject a request whose `Host` is not one of ours.
 *
 * Skipped when the operator opted into network exposure, because then a real hostname or LAN
 * address is the point and this check would refuse every legitimate request.
 */
export function hostGuard(env: NodeJS.ProcessEnv = process.env) {
  const enforced = !isExposed(env);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!enforced) {
      next();
      return;
    }
    if (ALLOWED_HOSTS.has(hostname(req.headers.host))) {
      next();
      return;
    }
    res.status(403).json({
      error:
        'This dashboard only answers to localhost. A request arriving under another hostname is rejected.',
      code: 'host-not-allowed',
    });
  };
}

/** Where the per-run secret lives. Under the optimizer's own home, never the workspace. */
export function tokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(optimizerHome(env), 'dashboard-token');
}

let cached: string | null = null;

/**
 * The capability token, created on first use.
 *
 * Written before it is returned, and re-chmod'ed afterwards: a file that already existed keeps its
 * old mode through a plain write, so creating it 0600 is not enough on its own.
 */
export function capabilityToken(env: NodeJS.ProcessEnv = process.env): string {
  if (cached) return cached;
  const path = tokenPath(env);
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length >= 32) {
      cached = existing;
      return cached;
    }
  } catch {
    /* not written yet, or unreadable: a fresh one is written below */
  }
  const token = randomBytes(32).toString('base64url');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows narrows this to the read-only bit; the directory is already user-scoped */
  }
  cached = token;
  return token;
}

/** Only for tests: forget the cached token so a different home can be exercised. */
export function resetCapabilityToken(): void {
  cached = null;
}

function sameToken(sent: unknown, expected: string): boolean {
  if (typeof sent !== 'string') return false;
  const a = Buffer.from(sent, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // Length first: timingSafeEqual throws on a mismatch, and a throw is not a security decision.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Require the token on anything that changes state.
 *
 * Reads stay open: they are already reachable by anyone who can reach the port, and gating them
 * would break the dashboard's own first paint, which fetches before it has run any script.
 */
export function requireCapability(env: NodeJS.ProcessEnv = process.env) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!MUTATING.has(req.method.toUpperCase())) {
      next();
      return;
    }
    if (sameToken(req.headers[TOKEN_HEADER], capabilityToken(env))) {
      next();
      return;
    }
    res.status(403).json({
      error:
        'Missing or invalid dashboard token. Open the dashboard from this machine rather than posting to it directly.',
      code: 'capability-required',
    });
  };
}

/**
 * The origins allowed to read a response.
 *
 * Replaces a bare `cors()`, whose wildcard let ANY site read everything this server returns --
 * including the provider status, which names the account a key belongs to. Only the dashboard's own
 * loopback origins are reflected, and only when the bind is loopback.
 */
export function corsOrigin(env: NodeJS.ProcessEnv = process.env) {
  return (
    origin: string | undefined,
    done: (e: Error | null, ok?: boolean) => void
  ): void => {
    // No Origin at all is a non-browser client (curl, the CLI, a test): nothing to protect there,
    // because CORS exists to stop a PAGE reading a response, and there is no page.
    if (!origin) {
      done(null, true);
      return;
    }
    if (isExposed(env)) {
      done(null, true);
      return;
    }
    try {
      const url = new URL(origin);
      const allowed =
        ALLOWED_HOSTS.has(url.hostname) || url.hostname === '[::1]';
      done(null, allowed);
    } catch {
      done(null, false);
    }
  };
}

/**
 * The token, handed to the page that is allowed to have it.
 *
 * Injected into the HTML this server returns, which a cross-origin page cannot read. The wrapper
 * adds the header to same-origin API calls so no individual `fetch` site has to remember, and so a
 * call added later cannot silently miss it.
 */
export function injectToken(
  html: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const token = capabilityToken(env);
  const block = `<script>(function(){var t=${JSON.stringify(token)};window.__TOKEN_OPTIMIZER_DASHBOARD_TOKEN=t;var f=window.fetch;window.fetch=function(input,init){var url=typeof input==='string'?input:(input&&input.url)||'';var local=url.charAt(0)==='/'||url.indexOf(window.location.origin)===0;if(local){init=Object.assign({},init);var h=new Headers((init&&init.headers)||(typeof input!=='string'&&input&&input.headers)||{});h.set(${JSON.stringify(TOKEN_HEADER)},t);init.headers=h;}return f.call(this,input,init);};})();</script>`;
  if (html.includes('</head>'))
    return html.replace('</head>', `${block}</head>`);
  return `${block}${html}`;
}
