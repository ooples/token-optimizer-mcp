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
import { v1Frontier } from '../compress/strategy.js';
import { anchorStore, type AnchorStore } from '../compress/anchor.js';
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
}

export interface ProxySummary {
  readonly path: string;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly compressed: boolean;
  readonly reason?: string;
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
  anchors?: AnchorStore
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

  let rewritten: ProviderRequest;
  try {
    rewritten = v1Frontier(parsed, { spill, anchors }).request;
  } catch {
    return unchanged('compression threw');
  }

  const next = Buffer.from(JSON.stringify(rewritten), 'utf8');
  // Never send more than we were given.
  if (next.length >= before) return unchanged('compression did not pay');

  return {
    body: next,
    summary: { beforeBytes: before, afterBytes: next.length, compressed: true },
  };
}

/** Forwards one request upstream and pipes the response back verbatim. */
function forward(
  upstream: string,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer
): void {
  const target = new URL(req.url || '/', upstream);
  const send = target.protocol === 'http:' ? httpRequest : httpsRequest;

  // BYTE-FAITHFUL PASSTHROUGH of everything we did not deliberately change.
  // HeadRoom's #3463 is a proxy losing `Location` on the way back; the fix is
  // to copy headers rather than reconstruct them.
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (key === 'host' || key === 'content-length') continue;
    headers[key] = value;
  }
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
export function startProxy(
  options: ProxyOptions = {}
): Promise<{ server: Server; port: number }> {
  const upstream = options.upstream || UPSTREAM();
  const spillRoot = join(tmpdir(), 'token-optimizer-spill');
  const spill = spillTo(spillRoot);
  // One store per proxy, holding a hash and a boolean per conversation.
  // Per-conversation, never per-request, and passed in explicitly rather
  // than reached for -- HeadRoom's #3486 is a shared router keeping request
  // state on itself, and two agents through one proxy is the exact shape
  // that turns into.
  const anchors = anchorStore();

  const server = createServer((req, res) => {
    void (async () => {
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(400).end();
        return;
      }

      const { body: next, summary } = compressBody(body, spill, anchors);
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
