/**
 * Per-request token accounting, so the cost of compressing can be attributed
 * rather than argued about.
 *
 * WHY THIS EXISTS. The first end-to-end measurement of the proxy showed four
 * THOL tasks taking 36 turns against control's 35 -- effectively no turn cost --
 * while costing $0.58 against $0.43. Turns barely moved and money moved a lot,
 * which means the difference is per-turn token spend rather than extra work.
 * Nothing in the rig could say which kind of token: a cache read bills at 0.1x,
 * a cache write at 1.25x, and a plain input token at 1.0x, so a strategy can cut
 * the token COUNT and raise the BILL by moving tokens between those classes.
 *
 * The benchmark models that split from recorded payloads. It cannot observe it,
 * because only the provider says what it actually charged. This reads the
 * `usage` the provider reports and writes it beside what compression did to the
 * same request, so the two can be joined per turn.
 *
 * OFF UNLESS ASKED FOR. It writes a file, and a proxy that writes files nobody
 * requested is a proxy nobody should run. `TOKEN_OPTIMIZER_PROXY_ACCOUNTING`
 * names the path; absent, nothing here does anything.
 *
 * FAILS OPEN, ALWAYS. This is instrumentation. An optimizer that wedges the
 * agent is worse than one that saves nothing, and that goes double for a
 * measurement it was not asked to take.
 */

import { appendFileSync } from 'node:fs';
import type { OutputArm } from './output-savings.js';
import type { Readable, Writable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import * as zlib from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import { UsageParser } from './usage-parser.js';
import { pruneProxyLedger } from '../savings/retention.js';

/** The token classes a provider bills separately. */
export interface RequestUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** Responses input_tokens includes this subset; do not add it a second time. */
  cached_input_tokens?: number;
}

const USAGE_KEYS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'cached_input_tokens',
] as const;

/**
 * Pulls usage numbers out of a response fragment, keeping the LAST value seen
 * for each key.
 *
 * Last-wins is the correct rule rather than a convenience. A streaming response
 * reports input and cache tokens once in `message_start` and then reports
 * `output_tokens` again in every `message_delta`, cumulatively -- so the final
 * occurrence is the total and an earlier one is a partial count.
 */
export function scanUsage(text: string, into: RequestUsage): void {
  new UsageParser((usage) => mergeUsage(usage, into)).write(text);
}

function mergeUsage(usage: Record<string, unknown>, into: RequestUsage): void {
  const assign = (key: keyof RequestUsage, value: unknown): void => {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      into[key] = value;
  };
  for (const [wire, canonical] of [
    ['prompt_tokens', 'input_tokens'],
    ['completion_tokens', 'output_tokens'],
  ] as const) {
    assign(canonical, usage[wire]);
  }
  for (const key of USAGE_KEYS) {
    assign(key, usage[key]);
  }
  // Responses reports cache reads inside input_tokens_details. Keep its native
  // semantics separate from Anthropic's exclusive token classes.
  for (const key of ['input_tokens_details', 'prompt_tokens_details']) {
    const details = usage[key];
    if (details && typeof details === 'object' && !Array.isArray(details))
      assign(
        'cached_input_tokens',
        (details as Record<string, unknown>).cached_tokens
      );
  }
}

/** What compression did to one request, as the summary already reports it. */
export interface CompressionFacts {
  readonly compressed: boolean;
  /**
   * Which arm of the output-shaper holdout the request was in, when one ran.
   *
   * THE ONLY FIELD HERE THAT IS NOT A FACT ABOUT THE INPUT, and it is here
   * because the question it answers cannot be answered anywhere else. The
   * shaper withholds itself from a fraction of conversations so its effect on
   * what the model WRITES can be measured rather than estimated, and that
   * measurement is a difference between the two arms' output token counts --
   * which only this row holds. A label recorded without the count, or a count
   * recorded without the label, each make the experiment unreadable.
   *
   * ABSENT WHEN NO EXPERIMENT RAN, never defaulted to an arm. Every request
   * being labelled "treatment" would read as a trial whose control arm came
   * back empty, rather than as a trial that was never started.
   *
   * NOT REQUEST CONTENT. It is one of two fixed words, derived from a hash of
   * a conversation key that is itself never recorded.
   */
  readonly outputArm?: OutputArm;
  readonly reason?: string;
  readonly anchorReason?: string;
  readonly elisions?: number;
  /** References actually forwarded by the Responses deduplicator. */
  readonly dedupReferences?: number;

  readonly deferredTools?: number;
  readonly deferredToolChars?: number;
  /**
   * Characters of cached knowledge added to the request.
   *
   * RECORDED BECAUSE IT IS THE ONE THING HERE THAT MAKES A REQUEST BIGGER,
   * and it was the one fact the ledger did not carry. The proxy printed
   * `+1927 injected` to its log while the ledger line beside it said nothing,
   * so an A/B of the knowledge block read its own effect as zero and would
   * have reported the feature inert. A cost that only appears in a log a
   * measurement does not parse is a cost nobody attributes.
   */
  readonly injectedChars?: number;
  readonly systemChars?: number;
  readonly toolsChars?: number;
  readonly toolCount?: number;
  readonly coreToolChars?: number;
  readonly mcpToolChars?: number;
  readonly topTools?: string;
  readonly messagesChars?: number;
  readonly messageCount?: number;
  /**
   * The model the request names, when it names one.
   *
   * THE ONE FIELD THAT MAKES A ROW PRICEABLE. Every other number here is a
   * size, and a size cannot be turned into money: the provider's catalog is
   * keyed by model, so a ledger row without one can report tokens avoided and
   * never a dollar figure. The MCP path already carries a model for exactly
   * this reason and the proxy path -- the component responsible for the larger
   * saving -- carried none, so its rows could only ever have been reported
   * unpriced.
   *
   * AN IDENTIFIER, NOT CONTENT. It is a value chosen from the provider's own
   * published catalog, in the same class as the tool names already recorded
   * here, and it is read from the PARSED request rather than matched out of
   * the raw bytes. No part of the conversation, system prompt or tool schema
   * is retained with it -- which is what keeps the always-on ring and the
   * loopback `/__token-optimizer/transformations` endpoint as safe as they
   * were before this field existed.
   */
  readonly model?: string;
  readonly beforeBytes: number;
  readonly afterBytes: number;
}

/**
 * What the request cost in tokens on each side, or why that is not known.
 *
 * BYTES ARE NOT THE UNIT A BILL IS DENOMINATED IN. `beforeBytes` and
 * `afterBytes` are exact and free, and they are the wrong unit: a provider
 * charges per token, and the ratio between the two is not constant across
 * JSON structure, prose and code. A savings figure computed from bytes is a
 * proxy for the thing the user actually pays, and this field is the thing
 * itself.
 *
 * COUNTS ONLY. No body, no fragment of one, and no text of any kind appears
 * here -- that constraint is what lets the transformations ring and the ledger
 * stay always-on rather than opt-in like capture.
 *
 * THE PROVIDER'S OWN COUNT STAYS WHERE IT IS, in `usage`. Keeping our estimate
 * of the after-body separate from the provider's billed count for that same
 * body is what makes every single request a free calibration of this
 * instrument; merging them would throw that away.
 */
export type TokenAccountingFacts =
  | {
      readonly measured: true;
      /** Our estimate for the body we would have sent. Nobody billed for it. */
      readonly beforeTokens: number;
      /** Our estimate for the body we did send; compare with `usage`. */
      readonly afterTokens: number;
      /** The encoder, so this figure can be compared with any other. */
      readonly method: string;
    }
  | {
      readonly measured: false;
      /**
       * Why there is no figure. A NAMED REASON, NEVER A ZERO: a zero in a
       * savings column reads as a request the proxy did not improve, which
       * would be a false measurement rather than a missing one.
       */
      readonly reason: string;
    };

/** One line of the ledger: what we sent, and what it was billed as. */
export interface AccountingRecord extends CompressionFacts {
  /** Monotonic durations. Upstream includes transport and provider processing. */
  readonly timing?: {
    readonly transformMs: number;
    readonly upstreamHeadersMs?: number;
    readonly upstreamMs: number;
  };
  readonly ts: string;
  readonly path: string;
  readonly status: number;
  /** No HTTP response was received; usage remains unknown, not zero. */
  readonly transportError?: string;
  readonly usage: RequestUsage;
  /**
   * Tokens before and after, under our own encoder -- absent entirely on a
   * proxy built without token accounting, so an old ledger line stays valid.
   */
  readonly tokens?: TokenAccountingFacts;
}

/** The ledger path, or null when accounting was not asked for. */
export function accountingPath(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const raw = env.TOKEN_OPTIMIZER_PROXY_ACCOUNTING;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Appends one record. Swallows every failure by design -- see the file header.
 */
export function appendRecord(path: string, record: AccountingRecord): void {
  try {
    // SYNCHRONOUS ON PURPOSE, against `n/no-sync`, for the same reason the spill
    // is: a JSONL ledger is only usable if every line is whole and in order.
    // The async form is open/write/close per call, so two responses finishing
    // together can interleave -- and a torn line is not a slightly worse
    // measurement, it is a parse error in the middle of the data we are trying
    // to read. Append ordering under O_APPEND is also emulated on Windows,
    // which is the platform this rig runs on.
    //
    // The cost it is weighed against is small and off the critical path: this
    // runs once per request, after the response stream has already ended, and
    // only when someone explicitly asked for a ledger.
    // eslint-disable-next-line n/no-sync -- ledger lines must not interleave; see above
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // An unwritable ledger must not cost the agent its response.
  }
  maybePrune(path);
}

/**
 * How many appends pass between two prunes of the same ledger.
 *
 * AMORTISED, BECAUSE A PRUNE READS THE WHOLE FILE. Checking on every append
 * would turn a per-request constant into a per-request pass over the ledger,
 * which is exactly the cost the append above was written to avoid. At this
 * interval the read is spread thin enough to disappear, and the file can still
 * only overshoot its ceiling by the few hundred lines written in between --
 * which is why the ceiling is set well under any real limit rather than at it.
 */
const PRUNE_EVERY_APPENDS = 512;

/**
 * Appends since each ledger was last pruned. Keyed by path because one process
 * can be told to write more than one.
 */
const sinceLastPrune = new Map<string, number>();

/**
 * Folds whatever has aged out of the ledger, occasionally.
 *
 * IT RUNS HERE, IN THE WRITER, ON PURPOSE. The prune rewrites the file, so it
 * cannot run beside an append without the risk of losing the line that lands
 * mid-rewrite. The single writer is the one place where "no append is in
 * flight" is known rather than hoped for, and both are synchronous, so the
 * rewrite cannot interleave with the append that triggered it.
 *
 * THE FIRST APPEND ALWAYS CHECKS. A ledger that grew under an older build, or
 * under a proxy that only ever handled a handful of requests before exiting,
 * would otherwise never reach a counter-driven prune at all -- it would just
 * stay as big as it already was, forever.
 */
function maybePrune(path: string): void {
  const seen = sinceLastPrune.get(path);
  const next = (seen ?? 0) + 1;
  if (seen !== undefined && next < PRUNE_EVERY_APPENDS) {
    sinceLastPrune.set(path, next);
    return;
  }
  sinceLastPrune.set(path, 0);
  try {
    pruneProxyLedger(path);
  } catch {
    // A ledger that cannot be pruned is a ledger that grows, which is worth a
    // disk; it is not worth the agent's response, and it is not worth losing
    // the line we just wrote either. Swallowed for the same reason the append
    // above is -- see the file header.
  }
}

/**
 * Watches a response stream for usage numbers without touching what it carries.
 *
 * OBSERVES, NEVER INTERPOSES. Attaching a `data` listener does not consume the
 * stream in flowing mode, so the existing `pipe` still delivers every byte
 * unchanged -- which matters more here than anywhere, because an SSE stream has
 * to arrive as it is produced and this is a byte-faithful proxy.
 *
 * BOUNDED. The parser retains only bounded usage objects and structural state,
 * never the assistant's response content.
 */
export function tapUsage(
  stream: Readable,
  done: (usage: RequestUsage) => void,
  contentEncoding?: string
): void {
  const usage: RequestUsage = {};
  const parser = new UsageParser((value) => mergeUsage(value, usage));
  const utf8 = new StringDecoder('utf8');
  let settled = false;
  let settling = false;

  // DECODED BEFORE IT IS SCANNED, or the scan reads compressed bytes as text
  // and finds nothing. The first live run recorded 23 requests with correct
  // byte counts and `usage: {}` on every one, because this proxy forwards the
  // client's `accept-encoding` untouched -- byte-faithful passthrough is the
  // point -- so the provider answers gzipped.
  //
  // The decoder sits BESIDE the response, never in it. Chunks are copied into
  // it; the original stream still pipes to the client unchanged, which is the
  // property the whole tap exists to preserve.
  const decoder = decoderFor(contentEncoding);

  const finish = (): void => {
    if (settled) return;
    settled = true;
    parser.write(utf8.end());
    try {
      done(usage);
    } catch {
      // Same rule as everything else here.
    }
  };

  const absorb = (text: string): void => {
    parser.write(text);
  };

  if (decoder) {
    decoder.on('data', (chunk: Buffer) => {
      try {
        absorb(utf8.write(chunk));
      } catch {
        // Instrumentation only.
      }
    });
    // A truncated or mislabelled body must cost nothing: the response has
    // already been delivered by the time this fails.
    decoder.on('error', () => undefined);
  }

  stream.on('data', (chunk: Buffer | string) => {
    try {
      if (decoder) {
        decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        return;
      }
      absorb(typeof chunk === 'string' ? chunk : utf8.write(chunk));
    } catch {
      // A chunk that will not decode tells us nothing; the response is
      // unaffected either way.
    }
  });
  // Both, because a stream that errors mid-flight still billed for what it
  // sent, and 'end' does not fire after 'error'.
  //
  // With a decoder in play the trailing bytes only emerge once it is ended, so
  // the ledger waits for the decoder to flush rather than for the socket.
  const settle = (): void => {
    if (settling) return;
    settling = true;
    if (!decoder) {
      finish();
      return;
    }
    decoder.on('end', finish);
    // Belt and braces: a decoder that never ends must not swallow the record.
    decoder.on('error', finish);
    try {
      decoder.end();
    } catch {
      finish();
    }
  };
  // EVERY WAY A RESPONSE CAN FINISH, not just the tidy ones. The ledger
  // recorded 31 requests for a run with about 50 tool calls, because only
  // 'end' and 'error' were wired: a stream that is destroyed, aborted by the
  // client, or closed after the last chunk without emitting 'end' left no
  // record at all. An instrument that silently drops half its observations is
  // worse than none, because the half it keeps still looks like a complete
  // picture. `settle` is idempotent, so listening to all of them is safe.
  stream.on('end', settle);
  stream.on('error', settle);
  stream.on('close', settle);
  stream.on('aborted', settle);
}

/**
 * A decompressor for the encoding the provider actually used, or null when the
 * body is already text.
 *
 * Unknown encodings return null rather than guessing: a wrong decoder yields
 * garbage, and garbage that parses as a number is worse than no number.
 */
function decoderFor(contentEncoding?: string): (Writable & Readable) | null {
  const encoding = (contentEncoding ?? '').trim().toLowerCase();
  if (encoding === 'gzip' || encoding === 'x-gzip') return createGunzip();
  if (encoding === 'deflate') return createInflate();
  if (encoding === 'br') return createBrotliDecompress();
  if (encoding === 'zstd' && typeof zlib.createZstdDecompress === 'function')
    return zlib.createZstdDecompress();
  return null;
}
