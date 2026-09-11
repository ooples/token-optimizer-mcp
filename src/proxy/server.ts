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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { v1Frontier, type StrategyResult } from '../compress/strategy.js';
import {
  accountingPath,
  appendRecord,
  tapUsage,
  type CompressionFacts,
} from './accounting.js';
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

/**
 * Paths the DEFAULT upstream is allowed to serve.
 *
 * THE DEFAULT IS A GUESS, AND A WRONG GUESS FORWARDS SOMEONE'S CREDENTIALS TO THE WRONG
 * COMPANY. Sixteen clients can be redirected here through their own base-URL variable,
 * and their requests carry their own provider's key. With no explicit upstream every one
 * of them would be sent to api.anthropic.com -- a Copilot token, a Gemini key, delivered
 * over TLS to a third party that never asked for it.
 *
 * So an unconfigured upstream serves only the routes Anthropic actually has. Anything
 * else is refused with an error naming the variable to set. This can only reject traffic
 * that was about to go somewhere it should not; correctly-configured proxies never see
 * it.
 */
const ANTHROPIC_PATHS = ['/v1/messages', '/v1/complete', '/v1/models'];

/**
 * May the default upstream serve this path?
 *
 * Exported so the rule can be tested for what it ADMITS as well as what it refuses --
 * the refusal is easy to exercise end to end, while proving `/v1/messages` still gets
 * through would otherwise mean letting a test reach api.anthropic.com.
 */
export function defaultUpstreamServes(path: string): boolean {
  return ANTHROPIC_PATHS.some((prefix) => path.startsWith(prefix));
}

/** True when the upstream was chosen for us rather than by the operator. */
export function upstreamIsDefault(options: ProxyOptions): boolean {
  return !options.upstream && !process.env.TOKEN_OPTIMIZER_PROXY_UPSTREAM;
}

/** Requests above this are worth compressing; below it the work is noise. */
const MIN_BYTES = 4096;

/**
 * The share of a request compression must remove before it is worth sending.
 *
 * AN ELISION IS NOT FREE, and the byte count alone never said so. Every elision
 * replaces content with a path the agent can read back, and reading it back
 * costs a TURN -- which on these workloads costs far more than the tokens the
 * elision saved. Measured on four THOL tasks: the proxy removed 2.47% of bytes
 * and spent three extra turns against control, 37 to 34, for a net cost of
 * $0.53 against $0.42.
 *
 * So a rewrite now has to clear a floor that is proportional to the request,
 * not merely be smaller than it. Below the floor the original is forwarded
 * untouched: no elision to read back, no rewritten prefix, and nothing for the
 * provider to re-cache.
 *
 * WHY 0.5%, AND WHY NOT 5%. I set this to 5% first, reasoning that a 2.5%
 * rewrite could not justify the turn an elision might cost. The measurement
 * said otherwise and the floor had to come back down. With the floor at 5% the
 * proxy passed 22 of 22 requests through untouched and the screen came out at
 * 37 turns and $0.58; with compression actually applied it was 37 turns and
 * $0.53. Identical turns, LOWER cost -- so the elisions were never buying those
 * extra turns, and suppressing them only removed the saving.
 *
 * What the floor is still for is the case it was always for: a rewrite that
 * shaves a handful of bytes is not worth an elision the agent might read back.
 * 0.5% keeps that guard while leaving the achievable 2.5% intact.
 *
 * It is NOT a cache-economics guard. The ledger settled that separately: cache
 * writes were 5.5% of cached tokens against 94.5% reads, with per-request writes
 * falling to 150 tokens as reads climbed past 30,000, so re-anchoring reproduces
 * a byte-stable prefix and the cache is hitting. The cost is turns, not writes.
 */
const MIN_SAVING_SHARE = 0.005;

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
  /**
   * Largest request body to buffer, in bytes.
   *
   * Only ever lowers the built-in ceiling; a larger value is ignored, because raising it
   * would opt back into the unbounded buffering the ceiling exists to prevent.
   */
  readonly maxBodyBytes?: number;
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
  /**
   * Which branch the anchor decision took, and how many elisions the
   * strategy produced.
   *
   * DIAGNOSTIC, AND IT EXISTS BECAUSE INFERENCE FAILED TWICE. Two campaigns
   * reported 'compression did not pay' on every request, and reading the code
   * produced two confident explanations that a local reproduction then
   * disproved. These two fields separate the remaining possibilities without
   * guessing: no elisions means nothing was touchable or no engine claimed the
   * content, while elisions with no saving means the rewrite grew the payload.
   * Neither records any payload.
   */
  readonly anchorReason?: string;
  readonly elisions?: number;
  /** Section sizes, for locating where a request's bytes live. No content. */
  readonly systemChars?: number;
  readonly toolsChars?: number;
  readonly toolCount?: number;
  readonly messagesChars?: number;
  readonly messageCount?: number;
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

/**
 * Largest body this will buffer.
 *
 * Generous on purpose: a provider request carrying several images is genuinely tens of
 * megabytes, and a limit that refused real traffic would be worse than none. What it
 * stops is the unbounded case -- any local process can stream at a loopback listener,
 * and `Buffer.concat` over a stream nobody bounded is an out-of-memory kill with no
 * error anyone can act on.
 */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The limit in force, which a caller may lower but never raise past the default. */
export function bodyLimitFor(options: ProxyOptions): number {
  const asked = options.maxBodyBytes;
  if (asked === undefined || !Number.isFinite(asked) || asked <= 0)
    return MAX_BODY_BYTES;
  // Lowering is a legitimate deployment choice and testing needs it; raising it past
  // the default would let a caller opt back into the unbounded case this exists to
  // close.
  return Math.min(asked, MAX_BODY_BYTES);
}

/** Thrown when a body exceeds {@link MAX_BODY_BYTES}, so the handler can answer 413. */
class BodyTooLarge extends Error {}

/** Reads a whole request body, up to the limit. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (c: Buffer) => {
      received += c.length;
      if (received > limit) {
        // PAUSED, NOT DESTROYED. Destroying here does stop the flood, and it also
        // closes the socket before the 413 can be written -- so the caller sees
        // "other side closed" and has no idea a limit exists. Pausing stops reading
        // immediately; the handler answers and then destroys.
        req.pause();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(c);
    });
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

  // A TRUE NULL PROXY, for isolating what the transport itself costs.
  // Identical work through the proxy measured 45% more tokens than without it
  // -- same tool calls, same turns -- which cannot come from compression. This
  // switch forwards bytes and does nothing else, so a run with it on says
  // whether that overhead belongs to our rewriting or to being proxied at all.
  if (/^(1|true|yes|on)$/i.test(process.env.TOKEN_OPTIMIZER_PROXY_NULL || '')) {
    // WHERE THE BYTES ACTUALLY ARE, measured but never recorded. A matched pair
    // showed the proxied run carrying ~9,400 more tokens per request than the
    // same run without a proxy, while the CONVERSATION was the same size (9,035
    // against 9,488 characters). So the difference lives in the static part --
    // system prompt and tool schema, which are ~98% of a 120 KB request -- and
    // nothing was reporting their sizes. Sizes only; no content is recorded.
    let shape: Record<string, number> | undefined;
    try {
      const seen = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      const sizeOf = (v: unknown): number =>
        v === undefined ? 0 : JSON.stringify(v).length;
      shape = {
        systemChars: sizeOf(seen.system),
        toolsChars: sizeOf(seen.tools),
        toolCount: Array.isArray(seen.tools) ? seen.tools.length : 0,
        messagesChars: sizeOf(seen.messages),
        messageCount: Array.isArray(seen.messages) ? seen.messages.length : 0,
      };
    } catch {
      // Not JSON; the null path forwards it regardless.
    }
    return {
      body,
      summary: {
        beforeBytes: before,
        afterBytes: before,
        compressed: false,
        reason: 'null proxy',
        ...(shape ?? {}),
      },
    };
  }

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
  // WORTH THE RISK, not merely smaller. See MIN_SAVING_SHARE: a rewrite that
  // shaves a couple of percent still plants elisions the agent may read back,
  // and one such turn costs more than the whole saving.
  const saved = before - next.length;
  if (!added && saved < before * MIN_SAVING_SHARE)
    // Reported with its diagnostics, because this is the branch that fired on
    // every request of two campaigns and the byte counts alone could not say why.
    return {
      body,
      summary: {
        beforeBytes: before,
        afterBytes: before,
        compressed: false,
        reason:
          saved > 0
            ? `saving ${((saved / before) * 100).toFixed(2)}% is below the ${(MIN_SAVING_SHARE * 100).toFixed(0)}% floor`
            : 'compression did not pay',
        anchorReason: result.anchor?.reason,
        elisions: result.elisions.length,
      },
    };

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
      anchorReason: result.anchor?.reason,
      elisions: result.elisions.length,
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
  body: Buffer,
  facts?: CompressionFacts
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
      // HOP-BY-HOP HEADERS ARE STRIPPED IN BOTH DIRECTIONS, and doing it in
      // only one was a real defect rather than an untidiness.
      //
      // The request path has always dropped them. The response path forwarded
      // `upstreamRes.headers` wholesale, so the upstream's `transfer-encoding`,
      // `connection` and `keep-alive` were copied onto a DIFFERENT connection
      // -- ours to the client. `transfer-encoding: chunked` is the damaging
      // one: Node is already deciding framing for this response, and being
      // handed a conflicting declaration is how a streamed body arrives
      // differently from the way it was sent.
      //
      // That matters here more than it would in most proxies, because the body
      // is an SSE stream the agent consumes incrementally. Measured: a proxy
      // doing NOTHING but forwarding bytes cost ~30% more than no proxy, and
      // control's per-rep token counts are deterministic (97,255 / 97,249 /
      // 97,227) while the proxied ones scatter (111,957 to 175,745). Identical
      // request bytes cannot move the model, so the divergence was on the way
      // back.
      //
      // `Connection` also NAMES further headers that are single-hop, and those
      // go too -- the sender is telling us which ones it considers local to its
      // own connection, and passing those on is the same mistake as passing on
      // `Connection` itself.
      const upstreamHopByHop = new Set(
        String(upstreamRes.headers.connection ?? '')
          .split(',')
          .map((name) => name.trim().toLowerCase())
          .filter(Boolean)
      );
      const responseHeaders: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue;
        if (HOP_BY_HOP.has(key) || upstreamHopByHop.has(key)) continue;
        responseHeaders[key] = value;
      }
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      // WATCHED BEFORE IT IS PIPED, and watching is all it does: a `data`
      // listener does not consume a stream in flowing mode, so every byte still
      // reaches `pipe` unchanged. Registered first so no chunk can be missed by
      // a listener attached after delivery has already begun.
      const ledger = facts ? accountingPath() : null;
      if (ledger && facts) {
        // THE ENCODING HAS TO BE HANDED OVER, and forgetting to was why the
        // ledger still recorded no usage after the decoder was written: the
        // parameter existed, the call site never passed it, and every test fed
        // the tap plaintext so nothing caught it.
        const encoding = upstreamRes.headers['content-encoding'];
        tapUsage(
          upstreamRes,
          (usage) => {
            appendRecord(ledger, {
              ts: new Date().toISOString(),
              path: requestPath(req.url) ?? '/',
              status: upstreamRes.statusCode || 0,
              ...facts,
              usage,
            });
          },
          typeof encoding === 'string' ? encoding : undefined
        );
      }
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
  // ONE DIRECTORY PER PROXY, because shutdown deletes it. A shared root would mean the
  // first proxy to stop wiping the spills of every other one still running -- and a
  // spill path is a live reference the agent may still follow with `Read`. The random
  // segment is what keeps two proxies from sharing a fate; within a proxy the file
  // names stay content-addressed, which is what dedup needs.
  const spillRoot = join(
    tmpdir(),
    'token-optimizer-spill',
    randomBytes(12).toString('hex')
  );
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

  const guessing = upstreamIsDefault(options);
  const limit = bodyLimitFor(options);

  const server = createServer((req, res) => {
    void (async () => {
      // VALIDATED BEFORE ANYTHING IS COMPRESSED, and the order is the fix. Compressing
      // first meant `anchors.remember` recorded this conversation as anchored, and only
      // then did `forward` reject the target with a 400 -- so the provider never saw the
      // body, and the retry took the already-anchored branch against a prefix that was
      // never established.
      const path = requestPath(req.url);
      if (path === null) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(
          'token-optimizer proxy: refusing a request target that names its own ' +
            'destination; send a path, not an absolute URL'
        );
        return;
      }

      if (guessing && !defaultUpstreamServes(path)) {
        res.writeHead(421, { 'content-type': 'text/plain' });
        res.end(
          `token-optimizer proxy: '${path}' is not a route of the default upstream ` +
            `(${upstream}), and forwarding it there would send this client's ` +
            'credentials to the wrong provider. Set TOKEN_OPTIMIZER_PROXY_UPSTREAM, or ' +
            'pass --upstream, to name the provider this client actually uses.'
        );
        return;
      }

      let body: Buffer;
      try {
        body = await readBody(req, limit);
      } catch (error) {
        if (error instanceof BodyTooLarge) {
          // `connection: close` because the rest of that body is still coming and this
          // connection cannot be reused; the socket is destroyed once the answer has
          // actually been written.
          res.writeHead(413, {
            'content-type': 'text/plain',
            connection: 'close',
          });
          res.end(
            `token-optimizer proxy: request body exceeds ${limit} bytes`,
            () => req.destroy()
          );
          return;
        }
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
      forward(upstream, req, res, next, {
        compressed: summary.compressed,
        reason: summary.reason,
        beforeBytes: summary.beforeBytes,
        afterBytes: summary.afterBytes,
        anchorReason: summary.anchorReason,
        elisions: summary.elisions,
        systemChars: summary.systemChars,
        toolsChars: summary.toolsChars,
        toolCount: summary.toolCount,
        messagesChars: summary.messagesChars,
        messageCount: summary.messageCount,
      });
    })();
  });

  // SPILLED CONTENT IS A FRAGMENT OF THE USER'S SESSION, and mode 0600 bounds who can
  // read it, not how long it lives. Left behind, every run adds to a pile under the
  // temp directory that nothing ever removes. Cleared when the proxy stops, which is
  // also when the last agent that could still `Read` one of those paths has gone.
  server.on('close', () => {
    try {
      // eslint-disable-next-line n/no-sync
      rmSync(spillRoot, { recursive: true, force: true });
    } catch {
      // A file already gone, or a directory we cannot remove. Neither is worth
      // failing a shutdown over.
    }
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
