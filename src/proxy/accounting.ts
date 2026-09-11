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
import type { Readable, Writable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

/** The token classes a provider bills separately. */
export interface RequestUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

const USAGE_KEYS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const;

/**
 * How much of the previous chunk to re-scan, so a `usage` object split across a
 * chunk boundary is still seen whole. The objects in question are well under
 * this; the cost is re-scanning a few hundred bytes per chunk.
 */
const CARRY_CHARS = 512;

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
  for (const key of USAGE_KEYS) {
    // Anchored on the quoted key, so a field merely CONTAINING this name --
    // `cache_read_input_tokens` contains `input_tokens` -- cannot match it.
    const pattern = new RegExp(`"${key}"[ \\t]*:[ \\t]*(\\d+)`, 'g');
    let match: RegExpExecArray | null;
    let last: string | undefined;
    while ((match = pattern.exec(text)) !== null) last = match[1];
    if (last !== undefined) into[key] = Number(last);
  }
}

/** What compression did to one request, as the summary already reports it. */
export interface CompressionFacts {
  readonly compressed: boolean;
  readonly reason?: string;
  readonly anchorReason?: string;
  readonly elisions?: number;
  readonly systemChars?: number;
  readonly toolsChars?: number;
  readonly toolCount?: number;
  readonly messagesChars?: number;
  readonly messageCount?: number;
  readonly beforeBytes: number;
  readonly afterBytes: number;
}

/** One line of the ledger: what we sent, and what it was billed as. */
export interface AccountingRecord extends CompressionFacts {
  readonly ts: string;
  readonly path: string;
  readonly status: number;
  readonly usage: RequestUsage;
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
}

/**
 * Watches a response stream for usage numbers without touching what it carries.
 *
 * OBSERVES, NEVER INTERPOSES. Attaching a `data` listener does not consume the
 * stream in flowing mode, so the existing `pipe` still delivers every byte
 * unchanged -- which matters more here than anywhere, because an SSE stream has
 * to arrive as it is produced and this is a byte-faithful proxy.
 *
 * BOUNDED. It keeps a few hundred characters of overlap and nothing else, so a
 * long response costs a constant amount of memory rather than being buffered to
 * be measured.
 */
export function tapUsage(
  stream: Readable,
  done: (usage: RequestUsage) => void,
  contentEncoding?: string
): void {
  const usage: RequestUsage = {};
  let carry = '';
  let settled = false;

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
    try {
      done(usage);
    } catch {
      // Same rule as everything else here.
    }
  };

  const absorb = (text: string): void => {
    const combined = carry + text;
    scanUsage(combined, usage);
    carry = combined.slice(Math.max(0, combined.length - CARRY_CHARS));
  };

  if (decoder) {
    decoder.on('data', (chunk: Buffer) => {
      try {
        absorb(chunk.toString('utf8'));
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
      absorb(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
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
  return null;
}
