/**
 * The interception layer: compression on the wire.
 *
 * WHY A PROXY AT ALL, when this package is built out of hooks. Because a hook
 * provably cannot do this. `docs/superpowers/spikes/2026-08-30-posttooluse-
 * rewrite.md` established that the `PostToolUse` output schema is
 * `{hookEventName, additionalContext?, classifierContext?}` and that
 * `updatedOutput`, `modifiedOutput`, `toolResponse`, `updatedResult` and
 * `replaceOutput` occur ZERO times in the Claude Code binary. A hook can add
 * context; it cannot replace a tool result.
 *
 * THIS NEVER TRIES TO. It rewrites the outbound REQUEST, and tool results are
 * already inside that request as conversation history -- so the bytes a hook
 * cannot touch at PostToolUse are fully rewritable one moment later, here.
 * That is the entire idea, and it is why this reaches results from other
 * vendors' MCP servers, WebFetch bodies, and the history that grows every turn,
 * none of which a hook can see.
 *
 * WHAT IT WILL NOT DO:
 *   - bind anywhere but loopback;
 *   - store, log or persist a payload;
 *   - read or retain a credential -- headers are forwarded verbatim;
 *   - rewrite a message carrying signed thinking blocks (a permanent 400);
 *   - touch anything at or before the last cache breakpoint;
 *   - run at all unless explicitly enabled.
 */

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { v1Frontier, type StrategyResult } from '../compress/strategy.js';
import { anchorStore, type AnchorStore } from '../compress/anchor.js';
import type { Finding } from '../compress/knowledge.js';
import { loadFindings } from './findings.js';
import {
  presetFromEnv,
  resolveTuning,
  type CompressionOptions,
  type PresetName,
  type Tuning,
} from '../compress/options.js';
import type { ProviderRequest } from '../compress/frontier.js';

/** Upstream, overridable for a gateway. */
const UPSTREAM = (): string =>
  process.env.TOKEN_OPTIMIZER_PROXY_UPSTREAM || 'https://api.anthropic.com';

/** Loopback only. Not configurable, deliberately: see the header. */
const HOST = '127.0.0.1';

/** Requests above this are worth compressing; below it the work is noise. */
const MIN_BYTES = 4096;

export interface ProxyOptions {
  readonly port?: number;
  readonly upstream?: string;
  /** Called with a one-line summary per request. Never receives payloads. */
  readonly onSummary?: (summary: ProxySummary) => void;
  /**
   * Where to look for this project's knowledge graph.
   *
   * Defaults to the directory the proxy was started in, which is where the
   * rest of this package resolves a project from.
   */
  readonly projectRoot?: string;
  /** Named starting point for the dials. Defaults to the environment's. */
  readonly preset?: PresetName | string;
  /** Expert overrides, layered over the preset. */
  readonly compression?: CompressionOptions;
}

export interface ProxySummary {
  readonly path: string;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly compressed: boolean;
  readonly reason?: string;
  /**
   * Characters of knowledge deliberately ADDED to the request.
   *
   * Reported separately from the byte counts because it is the opposite of
   * what the rest of this does, and a summary that hid it would make the
   * compression figure beside it a lie.
   */
  readonly injectedChars?: number;
}

/** Enabled only on an explicit opt-in, and never when the kill switch is set. */
export function proxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TOKEN_OPTIMIZER_MODE === 'off') return false;
  return /^(1|true|yes|on)$/i.test(env.TOKEN_OPTIMIZER_PROXY || '');
}

/**
 * Where spilled content goes.
 *
 * Under the OS temp directory with an unguessable name and mode 0600, for the
 * same reason the host-CLI harvest does it: this is a fragment of the user's
 * session sitting in a shared directory. Written, never read back by us -- the
 * agent reads it with the tool it already has.
 *
 * CONTENT-ADDRESSED, AND THAT IS LOAD-BEARING, not tidiness. A random name
 * per call means the same bytes spilled twice get two paths, so the two
 * compressed blocks differ by that path alone -- and cross-block dedup, which
 * matches on exact equality, sees two different blocks and collapses neither.
 * Measured on the repeated-reads workload: with random names the v3 arm lost
 * to the CCR control on gross reduction purely because of it. Keying on
 * content also means identical bytes are written once rather than N times.
 *
 * The key is an HMAC under a per-process random salt rather than a bare
 * digest, so the name stays stable within a run -- which is all dedup needs
 * -- without being predictable from the content by anyone else.
 */
function spillTo(root: string) {
  const salt = randomBytes(32);
  return (content: string, hint: string): string => {
    const name = createHmac('sha256', salt)
      .update(content)
      .digest('hex')
      .slice(0, 32);
    const file = join(root, `${name}-${hint}`);
    try {
      // SYNC ON PURPOSE, against `n/no-sync`, and the rule is right in general.
      //
      // The engines take a synchronous `spill` and rely on its return value to
      // decide whether an elision is recoverable at all: an empty string means
      // "no home for this content", and they keep the content instead. Writing
      // asynchronously would mean returning a path before knowing whether the
      // file exists -- so a failed write would leave a marker pointing at
      // nothing, which is precisely the dangling-reference failure this whole
      // design exists to avoid.
      //
      // The cost is bounded: the content is a slice of a body already buffered
      // in memory, and the write only happens when an engine actually elides.
      // Correctness of the recovery path is worth more here than the event-loop
      // tick.
      // eslint-disable-next-line n/no-sync
      mkdirSync(dirname(file), { recursive: true });
      // eslint-disable-next-line n/no-sync
      writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // A spill we cannot write means the elision has nowhere to point, and
      // the engines decline rather than drop content they cannot recover.
      return '';
    }
    return file;
  };
}

/** Reads a whole request body. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Compresses a provider request body, or explains why it did not.
 *
 * FAIL OPEN, ALWAYS. Every branch that cannot proceed returns the original
 * bytes. A token optimizer that wedges the agent is worse than one that saves
 * nothing -- the same rule the hook path has followed since it was written.
 */
export function compressBody(
  body: Buffer,
  spill: (content: string, hint: string) => string,
  anchors?: AnchorStore,
  findings?: readonly Finding[],
  tuning?: Tuning
): { body: Buffer; summary: Omit<ProxySummary, 'path'> } {
  const before = body.length;
  const unchanged = (reason: string) => ({
    body,
    summary: {
      beforeBytes: before,
      afterBytes: before,
      compressed: false,
      reason,
    },
  });

  if (before < MIN_BYTES) return unchanged('below the size floor');

  let parsed: ProviderRequest;
  try {
    parsed = JSON.parse(body.toString('utf8')) as ProviderRequest;
  } catch {
    // Not a JSON provider request -- a streaming upload, a form, something
    // else entirely. Forward it untouched.
    return unchanged('body is not JSON');
  }
  if (!Array.isArray(parsed.messages)) return unchanged('no messages array');

  let result: StrategyResult;
  try {
    result = v1Frontier(parsed, { spill, anchors, findings, tuning });
  } catch {
    return unchanged('compression threw');
  }

  const next = Buffer.from(JSON.stringify(result.request), 'utf8');
  // Never send more than we were given -- UNLESS a knowledge block was
  // deliberately added, which is the one case where growing the request is
  // the point. It is charged in the summary either way, and it only
  // happens on a turn the prefix was being rewritten anyway.
  const added = result.injectedChars > 0;
  if (!added && next.length >= before)
    return unchanged('compression did not pay');

  // COMMITTED ONLY NOW, because everything above can still decide not to send
  // this body. Remembering `anchored: true` for a rewrite that was then
  // discarded would tell the next turn to rewrite a prefix the provider had
  // cached in its original form -- a cache write bought with a lie about what
  // we sent.
  if (anchors && result.anchor)
    anchors.remember(result.anchor.key, result.anchor.record);

  return {
    body: next,
    summary: {
      beforeBytes: before,
      afterBytes: next.length,
      compressed: true,
      ...(added ? { injectedChars: result.injectedChars } : {}),
    },
  };
}

/**
 * Headers that belong to ONE HOP and must not be forwarded.
 *
 * Per RFC 9110. `transfer-encoding` is the one that bites: a chunked client
 * request carries `transfer-encoding: chunked`, and copying it while also
 * setting `content-length` -- which this must do, since the body was
 * rewritten and is now a known length -- sends two conflicting framing
 * headers. A strict upstream rejects that outright, and a lenient one is
 * guessing. The rest are here because forwarding another hop's connection
 * management is wrong for the same structural reason, just less loudly.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Is the cached-knowledge block switched on?
 *
 * SEPARATE FROM THE PROXY SWITCH, and off unless asked for. Compression
 * removes tokens; this ADDS them, and it is justified by turns rather than
 * by size -- a claim this repository cannot yet make, because only THOL
 * measures turns and it has not been run against this. Folding an unproven
 * addition into a proven reduction would make the reduction untrue.
 */
export function knowledgeEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.TOKEN_OPTIMIZER_MODE === 'off') return false;
  return /^(1|true|yes|on)$/i.test(env.TOKEN_OPTIMIZER_PROXY_KNOWLEDGE || '');
}

/**
 * Is it safe to send credentials to this upstream?
 *
 * CREDENTIALS DO NOT GO OVER CLEARTEXT. Every request through here carries
 * the user's provider key in a header, forwarded verbatim -- so an upstream
 * of `http://api.example.com` would put that key on the wire in the clear,
 * and the override that sets it is a single environment variable.
 *
 * Loopback is the exception, and it has to be: the tests in this repository
 * run a stand-in provider on 127.0.0.1, and so does anyone debugging with a
 * local recorder. Traffic that never leaves the machine cannot be
 * intercepted on the way to somewhere else.
 */
export function upstreamIsSafe(upstream: string): boolean {
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

/**
 * The path and query of a request, and NOTHING a caller can aim with.
 *
 * THE UPSTREAM IS OURS TO CHOOSE, NOT THE REQUEST'S. HTTP lets a client send
 * an absolute-form target -- `POST http://elsewhere.example/v1/messages` --
 * and a proxy is exactly the thing that form exists for, so it arrives here
 * legitimately shaped. `new URL(req.url, upstream)` then IGNORES the base
 * entirely and resolves to the host in the target, which would send the
 * user's provider key to whoever asked. A protocol-relative target
 * (`//elsewhere.example/...`) does the same while keeping our scheme.
 *
 * Validating the configured upstream, as `startProxy` does, does not help:
 * the destination was never read from it. So the request contributes only a
 * path and a query string, and anything carrying a scheme or an authority is
 * refused rather than quietly stripped -- a client sending one is either
 * confused about what this is or is aiming it, and both are worth saying out
 * loud.
 */
export function requestPath(url: string | undefined): string | null {
  const raw = url || '/';
  // Absolute-form (`http://host/path`) and protocol-relative (`//host/path`).
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return null;
  if (raw.startsWith('//')) return null;
  if (!raw.startsWith('/')) return null;
  // A backslash is treated as a slash by several URL parsers, so `/\\host`
  // can read as an authority downstream even though it starts with `/`.
  if (raw.includes('\\')) return null;
  return raw;
}

/** Forwards one request upstream and pipes the response back verbatim. */
function forward(
  upstream: string,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer
): void {
  const path = requestPath(req.url);
  if (path === null) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(
      'token-optimizer proxy: refusing a request target that names its own ' +
        'destination; send a path, not an absolute URL'
    );
    return;
  }

  // Built from the VALIDATED upstream, with only the path and query taken
  // from the request.
  const base = new URL(upstream);
  const target = new URL(path, base);
  target.protocol = base.protocol;
  target.host = base.host;
  const send = target.protocol === 'http:' ? httpRequest : httpsRequest;

  // BYTE-FAITHFUL PASSTHROUGH of everything we did not deliberately change.
  // HeadRoom's #3463 is a proxy losing `Location` on the way back; the fix is
  // to copy headers rather than reconstruct them.
  // Anything named by the request's own `Connection` header is hop-by-hop
  // too, by definition -- the sender is telling us which headers it considers
  // single-hop, and forwarding those is the same mistake as forwarding
  // `Connection` itself.
  const declaredHopByHop = new Set(
    String(req.headers.connection ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );

  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (key === 'host' || key === 'content-length') continue;
    if (HOP_BY_HOP.has(key) || declaredHopByHop.has(key)) continue;
    headers[key] = value;
  }
  // Set last and unconditionally: the body was rewritten, so its length is
  // ours to state and no longer the client's.
  headers['content-length'] = String(body.length);

  const upstreamReq = send(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      // Piped, not buffered: an SSE stream must arrive as it is produced, or
      // the agent sits waiting for a response that has already started.
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`token-optimizer proxy: upstream request failed: ${error.message}`);
  });

  upstreamReq.end(body);
}

/** Starts the proxy. Resolves once it is listening. */
export async function startProxy(
  options: ProxyOptions = {}
): Promise<{ server: Server; port: number }> {
  const upstream = options.upstream || UPSTREAM();
  if (!upstreamIsSafe(upstream)) {
    // FAIL LOUDLY HERE, uniquely in this file. Everything else in the proxy
    // fails open, because a token optimizer that wedges the agent is worse
    // than one that saves nothing. This is the opposite case: carrying on
    // would put the user's provider key on the wire in cleartext, and doing
    // that quietly is not a degradation, it is the harm.
    throw new Error(
      `token-optimizer proxy: refusing to forward credentials to ${upstream} -- ` +
        'an upstream must be https, or http on loopback'
    );
  }
  const spillRoot = join(tmpdir(), 'token-optimizer-spill');
  const spill = spillTo(spillRoot);
  // One store per proxy, holding a hash and a boolean per conversation.
  // Per-conversation, never per-request, and passed in explicitly rather
  // than reached for -- HeadRoom's #3486 is a shared router keeping request
  // state on itself, and two agents through one proxy is the exact shape
  // that turns into.
  const anchors = anchorStore();
  // One preset for the life of the proxy. Changing dials mid-session would
  // change how the cached prefix compresses, which is the one thing that must
  // not move -- see anchor.ts.
  const tuning = resolveTuning(
    options.compression ?? {},
    options.preset ?? presetFromEnv(process.env)
  );
  // Read once at startup, not per request. The graph does change during a
  // session, but a block that changes mid-session cannot live in a cached
  // prefix anyway -- so re-reading would spend I/O to produce a value the
  // cache rules immediately discard. New findings reach the next session,
  // which is when they are free.
  const findings = knowledgeEnabled(process.env)
    ? await loadFindings(options.projectRoot || process.cwd())
    : [];

  const server = createServer((req, res) => {
    void (async () => {
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(400).end();
        return;
      }

      const { body: next, summary } = compressBody(
        body,
        spill,
        anchors,
        findings,
        tuning
      );
      options.onSummary?.({ path: req.url || '/', ...summary });
      forward(upstream, req, res, next);
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}
