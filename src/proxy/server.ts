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
import {
  v1Frontier,
  v4Substitute,
  taskIn,
  type StrategyResult,
} from '../compress/strategy.js';
import {
  deferTools,
  withAdvancedToolUse,
  DEFAULT_KEEP_RELEVANT,
} from '../compress/tools.js';
import {
  accountingPath,
  appendRecord,
  tapUsage,
  type CompressionFacts,
} from './accounting.js';
import { anchorStore, type AnchorStore } from '../compress/anchor.js';
import { captureDir, captureRequest } from './capture.js';
import type { Finding } from '../compress/knowledge.js';
import { loadFindingsFrom } from './findings.js';
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
  readonly deferredTools?: number;
  /** Probe: thinking blocks removed from older assistant turns. */
  readonly droppedThinking?: number;
  readonly deferredToolChars?: number;
  readonly systemChars?: number;
  readonly toolsChars?: number;
  readonly toolCount?: number;
  readonly mcpToolChars?: number;
  readonly topTools?: string;
  readonly coreToolChars?: number;
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
  tuning?: Tuning,
  /** True when `findings` came from a graph shared across projects. */
  sharedGraph?: boolean
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
    let shape: Record<string, number | string> | undefined;
    try {
      const seen = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      const sizeOf = (v: unknown): number =>
        v === undefined ? 0 : JSON.stringify(v).length;
      shape = {
        systemChars: sizeOf(seen.system),
        toolsChars: sizeOf(seen.tools),
        toolCount: Array.isArray(seen.tools) ? seen.tools.length : 0,
        // Split by origin, because which half is actually big decides what is
        // worth deferring -- a client's built-in descriptions can dwarf an MCP
        // server's terse schemas, or the reverse, and guessing gets it wrong.
        coreToolChars: Array.isArray(seen.tools)
          ? seen.tools
              .filter(
                (t) =>
                  typeof (t as { name?: string })?.name === 'string' &&
                  !(t as { name: string }).name.startsWith('mcp__')
              )
              .reduce((a, t) => a + JSON.stringify(t).length, 0)
          : 0,
        // The biggest definitions by name, because an average hides which ones
        // are worth attacking.
        topTools: Array.isArray(seen.tools)
          ? seen.tools
              .map((t) => ({
                n: String((t as { name?: string })?.name ?? '?'),
                c: JSON.stringify(t).length,
              }))
              .sort((a, b) => b.c - a.c)
              .slice(0, 10)
              .map((t) => `${t.n}:${t.c}`)
              .join(' ')
          : '',
        mcpToolChars: Array.isArray(seen.tools)
          ? seen.tools
              .filter((t) =>
                (t as { name?: string })?.name?.startsWith('mcp__')
              )
              .reduce((a, t) => a + JSON.stringify(t).length, 0)
          : 0,
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

  // CAPTURED BEFORE ANY DECISION, and before the size floor, because the corpus
  // must be what ARRIVED rather than what we chose to act on. Recording only
  // the requests we compressed would build a corpus selected by the very thing
  // under test.
  const capture = captureDir();
  if (capture) captureRequest(capture, '/v1/messages', body);

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

  // TOOL DEFERRAL IS ITS OWN CAPABILITY, and deliberately not folded into the
  // compression path. They address different halves of the request and keeping
  // them separate is what lets either be measured without the other's effect
  // being attributed to it.
  //
  // MEASURED ACROSS 116 LIVE REQUESTS, tool definitions are 28.7% of a request
  // (p10 25.3%, median 29.2%, p90 31.6%). An earlier note here said 47.6%; that
  // came from a single 179,564-byte request and was not representative.
  //
  // Compression reaches the other half and reaches it well -- it removes 91.7%
  // of the FRESH region, which is the same figure it scores on fixtures. But
  // the fresh region is only 3.7-8.0% of a live request, the rest being cached
  // prefix billed at 0.1x, so 91.7% of it is 3.4% of the request. Deferral is
  // what reaches the 28.7%, and it reaches it in the prefix, where every
  // subsequent turn re-reads what was removed.
  //
  // ON BY DEFAULT, decided on the campaign: with deferral the proxy is cheaper
  // than control on 11 of 16 THOL tasks against 4 of 16 without it, at
  // identical scores (1.000 on every task) and a median 33% turn reduction.
  // Set TOKEN_OPTIMIZER_PROXY_DEFER_TOOLS=0 to turn it off.
  let deferred = 0;
  let deferredChars = 0;
  if (
    !/^(0|false|no|off)$/i.test(
      process.env.TOKEN_OPTIMIZER_PROXY_DEFER_TOOLS || ''
    )
  ) {
    try {
      // The task text steers which non-core tools stay loaded, so the model
      // never has to search for one -- and a search costs a round trip plus a
      // second cold prefix write.
      const out = deferTools(parsed, {
        // taskIn, NOT questionIn: the tools array is part of the cached
        // prefix, so steering it with text that changes every turn changes
        // the prefix every turn. See taskIn for the measurement.
        query: taskIn(parsed),
        keepRelevant: keepToolsFromEnv(),
      });
      parsed = out.request;
      deferred = out.deferredCount;
      deferredChars = out.deferredChars;
    } catch {
      // Fails open like everything else here: a tools array we cannot rewrite
      // is forwarded as it arrived.
    }
  }

  // A PROBE, NOT THE FEATURE. The substitution design in the plan turns on one
  // untested question -- will the API accept history whose older assistant turns
  // have had their `thinking` blocks removed? `frontier.ts` refuses to touch a
  // signed block and cites HeadRoom's issue #3456, but that is their bug report,
  // and removal is not rewriting: a signature covers block CONTENT, so deleting
  // the block leaves nothing to mismatch.
  //
  // A direct probe against /v1/messages returned 429 on every variant including
  // its control, so this asks the question down the path that demonstrably
  // works instead: the real client, through this proxy, against the rig.
  //
  // Safe to do minimally because it was measured: across a 29-message
  // conversation, `thinking` never shared a message with any other block type,
  // so dropping those messages orphans no tool_use/tool_result pairing. The
  // newest assistant turn keeps its thinking, since that is the one the
  // provider may still require for continuity.
  //
  // Off unless asked for, and it stays a probe until the answer is in.
  //
  // TWO MODES, because exempting the newest turn cost more than it saved. `1`
  // keeps that turn's thinking; `all` drops every one.
  //
  // MEASURED. With the newest turn exempt, the exemption BOUNDARY MOVES each
  // turn -- the block kept at turn N is dropped at turn N+1 -- so the prefix
  // changes at that point on every request and is re-written there. On the four
  // longest THOL tasks turns fell hard (0.49, 0.67, 0.29, 0.82 against control)
  // while cost rose on three of four (0.62, 1.48, 1.10, 1.34):
  // code-debug-pipeline-py took 71% fewer turns and still cost 10% more, so
  // per-turn cost had roughly quadrupled. Dropping every block instead makes
  // the transform a pure function of the history, so the prefix one turn
  // produces is the prefix the next reproduces.
  //
  // THE VERDICT, AND IT IS NEGATIVE. Stabilising the transform worked -- against
  // control on the four longest tasks, `all` beat `keep newest` on three of four
  // (1.01 vs 1.48, 0.71 vs 1.10, 1.32 vs 1.34; cascade went the other way, 0.72
  // vs 0.62). But DEFERRAL ALONE beats both on three of four (0.93, 0.93, 0.54,
  // 0.98), so removing thinking costs more than it saves even once the prefix is
  // stable. Turns fall hard and consistently -- 0.31, 0.67, 0.75, 0.94 against
  // control, at score 1.0 everywhere -- and that does not convert into money.
  //
  // So this stays OFF and stays a probe. It is kept rather than deleted because
  // it answered the question the plan was gated on (the API does accept the
  // removal) and because the turn reduction is real and unexplained, which is
  // worth understanding before anything else is built on top.
  //
  // n=1 per task on four tasks. Enough to stop, not enough to have proven a
  // mechanism.
  const dropMode = (
    process.env.TOKEN_OPTIMIZER_PROXY_DROP_THINKING || ''
  ).toLowerCase();
  const keepNewestThinking = dropMode !== 'all';
  let droppedThinking = 0;
  if (/^(1|true|yes|on|all)$/.test(dropMode)) {
    try {
      const msgs = parsed.messages ?? [];
      let lastAssistant = -1;
      for (let i = msgs.length - 1; keepNewestThinking && i >= 0; i--) {
        if (msgs[i]?.role === 'assistant') {
          lastAssistant = i;
          break;
        }
      }
      const kept = msgs
        .map((m, i) => {
          if (m?.role !== 'assistant' || i === lastAssistant) return m;
          const content = m.content;
          if (!Array.isArray(content)) return m;
          const next = content.filter((b) => {
            const type = (b as { type?: string })?.type;
            const drop = type === 'thinking' || type === 'redacted_thinking';
            if (drop) droppedThinking += 1;
            return !drop;
          });
          return next.length === content.length ? m : { ...m, content: next };
        })
        .filter((m) => !Array.isArray(m?.content) || m.content.length > 0);
      parsed = { ...parsed, messages: kept };
    } catch {
      // Fails open, like every other rewrite here.
      droppedThinking = 0;
    }
  }

  // THE ONE PLACE A STRATEGY IS CHOSEN, and until now it was not a choice at
  // all: `v1Frontier` was named directly, so `v4Substitute` could be registered,
  // tested and benchmarked while remaining unreachable from the running proxy.
  // That is the shape tool deferral shipped in for months -- present, correct,
  // and never once executed on real traffic.
  //
  // Off unless asked. Substitution removes model reasoning from history, and
  // whether that costs the model something it needed is the one question no
  // offline instrument can answer.
  const substitute = /^(1|true|yes|on)$/i.test(
    (process.env.TOKEN_OPTIMIZER_PROXY_SUBSTITUTE || '').trim()
  );
  let result: StrategyResult;
  try {
    result = (substitute ? v4Substitute : v1Frontier)(parsed, {
      spill,
      anchors,
      findings,
      sharedGraph,
      tuning,
    });
  } catch {
    return unchanged('compression threw');
  }

  const next = Buffer.from(JSON.stringify(result.request), 'utf8');
  // Never send more than we were given -- UNLESS a knowledge block was
  // deliberately added, which is the one case where growing the request is
  // the point. It is charged in the summary either way, and it only
  // happens on a turn the prefix was being rewritten anyway.
  const added = result.injectedChars > 0 || deferred > 0;
  // WORTH THE RISK, not merely smaller. See MIN_SAVING_SHARE: a rewrite that
  // shaves a couple of percent still plants elisions the agent may read back,
  // and one such turn costs more than the whole saving.
  const saved = before - next.length;
  if (!added && saved < before * MIN_SAVING_SHARE) {
    // REMEMBERED EVEN THOUGH WE SENT THE CLIENT'S BYTES, and forgetting here was
    // a deadlock rather than a missed optimisation.
    //
    // `remember` used to sit only past this return, so a turn that compressed
    // nothing was never recorded -- and a FIRST turn legitimately compresses
    // nothing, because the only content it could touch is already behind the
    // client's cache marker. The store therefore stayed empty, turn two saw
    // `first-turn` again and got no floor, compressed nothing, and was not
    // recorded either. It could not compress because it never remembered, and
    // never remembered because it had not compressed.
    //
    // Measured: six live proxy runs, every request reporting `first-turn` and
    // 0 elisions, while the identical requests replayed through one store
    // offline removed 4.3%. That gap was this line.
    //
    // `anchored: false` is the honest value and the load-bearing one: we sent
    // the client's prefix, so the next turn must be told the provider holds
    // THEIRS, not ours. What the record carries that matters is the breakpoint,
    // which is what tells the next turn where the cache ends.
    if (anchors && result.anchor)
      anchors.remember(result.anchor.key, {
        ...result.anchor.record,
        anchored: false,
      });
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
  }

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
      deferredTools: deferred,
      droppedThinking,
      deferredToolChars: deferredChars,
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
/**
 * How stale the in-memory findings may get before a background re-read.
 *
 * The read is a full synchronous parse of the graph -- 40-58ms on a project
 * graph, and it was measured at 1,118ms on a 75MB unrooted one -- so it is
 * throttled rather than done per request. Sixty seconds is well inside the gap
 * between sessions, which is when a fresher block can actually be used, and far
 * longer than a burst of turns within one conversation, where it cannot.
 */
const FINDINGS_REFRESH_MS = 60_000;

export function knowledgeEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.TOKEN_OPTIMIZER_MODE === 'off') return false;
  return /^(1|true|yes|on)$/i.test(env.TOKEN_OPTIMIZER_PROXY_KNOWLEDGE || '');
}

/**
 * How many characters of established knowledge go into the cached prefix.
 *
 * A KNOB FOR THE SAME REASON THE TOOL APERTURE IS ONE. The default of 2,000
 * fits six to eight lines out of 72,736 characters of eligible claim text --
 * 2.7% of what this project has worked out -- and that number was never chosen
 * against a measurement, only against a worry that a longer block would bury
 * the relevant lines. The block is charged once as a cache write and then read
 * at 0.1x, so widening it is cheap per turn and expensive only once; whether it
 * buys turns is a question for the rig, not for an argument.
 *
 * Returns undefined when unset so the preset's own value survives; falling
 * back to the constant here would silently override a preset that chose a
 * different budget on purpose.
 */
export function knowledgeCharsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): number | undefined {
  const raw = env.TOKEN_OPTIMIZER_PROXY_KNOWLEDGE_CHARS;
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/**
 * How many large tool definitions stay loaded when deferral is on.
 *
 * A KNOB BECAUSE THE RIGHT VALUE IS MEASURED, NOT REASONED. The default of
 * five was a guess; the first campaign to run deferral end to end deferred 14
 * of 26 definitions, cut the model's context from 29,824 prefix tokens to
 * 19,138 -- below the 20,431 of an arm with no proxy at all -- and the
 * transcripts show the tool search tool was never once invoked. Nothing was
 * searched for, so the guess was too cautious, and finding out how much too
 * cautious costs a campaign rather than an argument.
 *
 * Out-of-range and unparseable values fall back to the default rather than
 * throwing: a typo in an environment variable must not take a session down.
 */
export function keepToolsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TOKEN_OPTIMIZER_PROXY_KEEP_TOOLS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_KEEP_RELEVANT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_KEEP_RELEVANT;
  return n;
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
  // THE BETA THAT MAKES defer_loading MEAN ANYTHING. Appended to whatever the
  // client already asked for, never replacing it -- overwriting would switch
  // off betas it needs and the failure would surface far from here.
  if (facts?.deferredTools)
    headers['anthropic-beta'] = withAdvancedToolUse(
      req.headers['anthropic-beta']
    );

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
  // The knowledge budget is the one dial with its own variable, because it is
  // the one being swept: an explicit `compression` option still wins over it,
  // so this layers in rather than overriding the caller.
  const knowledgeChars = knowledgeCharsFromEnv(process.env);
  const tuning = resolveTuning(
    {
      ...(knowledgeChars === undefined
        ? {}
        : { knowledgeBudgetChars: knowledgeChars }),
      ...(options.compression ?? {}),
    },
    options.preset ?? presetFromEnv(process.env)
  );
  // Read at startup, then refreshed in the background -- see the block below,
  // which owns the reasoning about why the refresh cannot be synchronous.
  const knowledgeOn = knowledgeEnabled(process.env);
  const graphRoot = options.projectRoot || process.cwd();
  const loaded = knowledgeOn
    ? await loadFindingsFrom(graphRoot)
    : { findings: [], sharedGraph: false };
  // MUTABLE, AND REFRESHED IN THE BACKGROUND. Read once per process was a real
  // defect: a finding written today did not reach tomorrow's session until the
  // proxy restarted, and this project writes findings continuously.
  //
  // NOT refreshed synchronously per request, for two separate reasons. The
  // request path is synchronous and this read is not, and more importantly the
  // block may only CHANGE on a turn where the cached prefix is already lost --
  // `first-turn` and `client-invalidated`. On `already-anchored` the provider
  // holds our prefix and reproducing it byte for byte is the cache hit, so a
  // fresher block there would buy nothing and cost everything.
  //
  // So the refresh is decoupled: it runs after a response, throttled, and the
  // newer findings are picked up by the next conversation that starts. Within
  // one conversation the block still cannot change, which is not a limitation
  // of this code but of what a cached prefix is.
  let findings = loaded.findings;
  let sharedGraphFlag = loaded.sharedGraph;
  let lastFindingsRead = Date.now();
  let refreshing = false;
  const refreshFindings = (): void => {
    if (!knowledgeOn || refreshing) return;
    if (Date.now() - lastFindingsRead < FINDINGS_REFRESH_MS) return;
    refreshing = true;
    void loadFindingsFrom(graphRoot)
      .then((next) => {
        findings = next.findings;
        sharedGraphFlag = next.sharedGraph;
        lastFindingsRead = Date.now();
      })
      .catch(() => {
        // A graph that cannot be re-read leaves the previous findings in place,
        // which is strictly better than serving none.
        lastFindingsRead = Date.now();
      })
      .finally(() => {
        refreshing = false;
      });
  };
  // CARRIED WITH THE FINDINGS, not recomputed here. A shared graph -- the
  // unrooted fallback, or one mounted across several repositories -- holds
  // `project` claims about trees other than this one, and only the loader knows
  // which graph it opened.

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
        tuning,
        sharedGraphFlag
      );
      refreshFindings();
      options.onSummary?.({ path: req.url || '/', ...summary });
      // SPREAD, NOT RE-LISTED. This was seventeen fields copied across by hand,
      // and the ledger is only as good as that list is complete: injectedChars
      // was missing from it, so the proxy printed `+1927 injected` to its log
      // while the ledger line beside it said nothing, and an A/B of the
      // knowledge block read its own effect as zero. The summary IS the
      // compression facts -- every field of it belongs in the ledger, and a
      // field added to one should never need remembering in the other.
      forward(upstream, req, res, next, summary);
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
