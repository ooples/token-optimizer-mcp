/**
 * Do the proxy's two recorders agree about the traffic they both saw?
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. The savings this package publishes come
 * from the accounting ledger, which the proxy writes from its own arithmetic on
 * the request path. Nothing checked that arithmetic against a second record of
 * the same traffic, so a byte counted at the wrong point or a price attributed
 * to the wrong model would have been published as a measurement. The capture
 * directory is that second record: it holds each request body AS IT ARRIVED,
 * written by a different code path at a different moment.
 *
 * This is therefore a CROSS-RECORDER audit, not an external one. Both recorders
 * live inside the same proxy, so a fault they share -- a body already altered
 * before either saw it -- is invisible here and needs a capture taken off the
 * wire. What it does catch is the family of defects that has actually happened
 * in this repository: a figure attributed to the wrong record, a count taken
 * after a re-serialization rather than before it, and a corpus that is not the
 * corpus the numbers were computed over.
 *
 * MULTISETS, NOT PAIRS, AND THAT IS DELIBERATE. The two files have no shared
 * request id, and the ledger is appended when a response completes while the
 * capture is written when a request arrives, so concurrent requests appear in
 * different orders. Pairing them by position would invent a correspondence and
 * then report agreement about it. Comparing the multiset of byte lengths and
 * the multiset of models per path needs no correspondence at all: either the
 * same values occur the same number of times or they do not, whatever order
 * they arrived in, and a difference is a fact rather than an inference.
 *
 * ONLY THE OVERLAP IS COMPARED, AND THE REST IS COUNTED. Capture and accounting
 * are enabled independently, so one file routinely covers a period the other
 * does not -- and even when both are on for a whole session, the first request
 * reaches the capture before it reaches the ledger. Records outside the
 * intersection of the two extents are EXCLUDED and reported as excluded,
 * because a boundary request is legitimately in one recorder and not the other.
 * An exclusion that is never counted is the difference between "they agree" and
 * "the parts I chose to look at agree".
 *
 * ONE KNOWN FALSE POSITIVE, RECORDED RATHER THAN HIDDEN. The ledger counts the
 * request as raw bytes; the capture stores it as a JSON string, decoded as
 * UTF-8. A body that is not valid UTF-8 therefore reaches the two recorders as
 * two different lengths, and this audit reports that as a disagreement. It is
 * the right answer for the wrong reason -- the bodies at issue are JSON from an
 * HTTP client, so a malformed one is itself worth looking at -- but an operator
 * chasing a finding needs to know the decoder is in the path.
 *
 * READS BODIES, EMITS NONE. A capture directory is conversation content in
 * plaintext -- see `proxy/capture.ts` for why it is opt-in and announced. This
 * module parses those bodies and keeps NOTHING from them but the byte length
 * and the `model` field, which the ledger already records. No message, no
 * system prompt, no tool body, and no hash of any of them reaches a finding.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { looksLikeRecord } from './ledger.js';
import type { AccountingRecord } from '../proxy/accounting.js';

/** The file `proxy/capture.ts` appends to inside a capture directory. */
export const CAPTURE_FILE = 'requests.jsonl';

/** Everything this audit keeps from one captured request. */
export interface CapturedRequest {
  /** Epoch milliseconds, as the capture writer recorded them. */
  readonly at: number;
  readonly path: string;
  /** UTF-8 length of the body as it arrived -- never the body itself. */
  readonly bytes: number;
  /** The model the body named, or null when it named none we could read. */
  readonly model: string | null;
}

/** What a capture directory yielded, with what it could not. */
export interface CaptureRead {
  readonly requests: readonly CapturedRequest[];
  /** Lines that were not parseable JSON objects of the expected shape. */
  readonly skipped: number;
  /** True when the directory held no capture file at all. */
  readonly missing: boolean;
}

/**
 * Reads a capture directory, keeping only the projection above.
 *
 * STREAMED, AND THE BODY IS DROPPED AS SOON AS IT IS MEASURED. A capture file
 * is the largest thing this package writes -- it is whole request bodies -- so
 * slurping it to count bytes would need more memory than the proxy that wrote
 * it. Each line is parsed, measured and discarded.
 *
 * A LINE THAT DOES NOT PARSE IS SKIPPED AND COUNTED, the same rule the ledger
 * reader follows: a capture can be truncated by a full disk mid-write, and
 * refusing to audit nine thousand good records because of one torn line would
 * be the wrong trade. The count is returned so a reader is told.
 */
export async function readCapture(dir: string): Promise<CaptureRead> {
  const requests: CapturedRequest[] = [];
  let skipped = 0;
  const stream = createReadStream(join(dir, CAPTURE_FILE), {
    encoding: 'utf8',
  });
  try {
    await new Promise<void>((settle, fail) => {
      stream.on('error', fail);
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      lines.on('line', (line) => {
        if (line.trim().length === 0) return;
        const request = projectCaptureLine(line);
        if (request === null) skipped++;
        else requests.push(request);
      });
      lines.on('close', settle);
      lines.on('error', fail);
    });
  } catch (error) {
    // A MISSING FILE IS A STATE, NOT A FAULT. Capture was never on, or was
    // pointed somewhere else, and the command has to say which rather than
    // failing in a way that looks like the audit itself broke.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return { requests: [], skipped: 0, missing: true };
    throw error;
  }
  return { requests, skipped, missing: false };
}

/**
 * One capture line as the projection, or null when it is not one.
 *
 * THE MODEL IS READ, THE REST IS NOT. `model` is the field the ledger prices
 * the request by, so it is the one value in the body this audit has a question
 * about. A body that is not JSON, or names no model, yields a null model and is
 * still counted -- a request whose model could not be read is a fact about the
 * corpus, and dropping it would shrink the corpus silently.
 */
export function projectCaptureLine(line: string): CapturedRequest | null {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof record !== 'object' || record === null) return null;
  const { at, path, body } = record as {
    at?: unknown;
    path?: unknown;
    body?: unknown;
  };
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  if (typeof path !== 'string' || typeof body !== 'string') return null;
  return {
    at,
    path,
    bytes: Buffer.byteLength(body, 'utf8'),
    model: modelOf(body),
  };
}

/** The `model` a request body names, or null. Nothing else is retained. */
function modelOf(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const model = (parsed as { model?: unknown }).model;
    return typeof model === 'string' && model.length > 0 ? model : null;
  } catch {
    return null;
  }
}

/** Everything this audit keeps from one ledger record. */
export interface LedgerRequest {
  /**
   * Epoch milliseconds of the instant the request ARRIVED, which is the instant
   * the capture also stamps -- not the `ts` on the record. See
   * `readLedgerProjection` for why the two differ and how the gap is undone.
   */
  readonly at: number;
  readonly path: string;
  /** The record's own count of the body before transformation. */
  readonly bytes: number;
  readonly model: string | null;
}

export interface LedgerProjection {
  readonly requests: readonly LedgerRequest[];
  readonly skipped: number;
  readonly missing: boolean;
  /**
   * Records with no `timing`, whose arrival could not be recovered and which
   * therefore sit on the completion clock instead.
   *
   * COUNTED, BECAUSE IT CHANGES WHAT THE WINDOW MEANS. `timing` is optional so
   * that an old ledger stays readable, and an old ledger is exactly the one
   * whose records are placed a round trip late. That only matters at the edges
   * of the compared window, but an operator cannot judge whether it mattered
   * here unless the number is in front of them.
   */
  readonly unaligned: number;
}

/**
 * How long after arrival the record was stamped, or null when it cannot be told.
 *
 * `transformMs` is measured from the moment the body had arrived -- the same
 * moment the capture is written -- and `upstreamMs` from the end of the
 * transform, so the two together span arrival to completion. The response body
 * streams on after that, which is why this recovers arrival to within the
 * stream's own duration rather than exactly.
 */
function laggedBy(timing: AccountingRecord['timing']): number | null {
  if (timing === undefined) return null;
  const lag = timing.transformMs + timing.upstreamMs;
  return Number.isFinite(lag) && lag >= 0 ? lag : null;
}

/**
 * The whole ledger, projected to the four fields this audit compares.
 *
 * ONE VALIDITY RULE, NOT TWO. `looksLikeRecord` is the ledger reader's own test
 * for "is this line a record", imported rather than restated, so a line this
 * audit silently ignores is exactly a line `token-optimizer-inspect` would also
 * refuse to render. A second copy of that rule would eventually disagree, and
 * the audit would then be measuring a different corpus than the command it is
 * auditing.
 *
 * PROJECTED WHILE STREAMING, because `readLedger` keeps whole records and this
 * needs every record rather than the last few: a session's ledger is tens of
 * megabytes, and the audit has a question about four fields of it.
 */
export async function readLedgerProjection(
  path: string
): Promise<LedgerProjection> {
  const requests: LedgerRequest[] = [];
  let skipped = 0;
  let unaligned = 0;
  const stream = createReadStream(path, { encoding: 'utf8' });
  try {
    await new Promise<void>((settle, fail) => {
      stream.on('error', fail);
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      lines.on('line', (line) => {
        const text = line.trim();
        if (text === '') return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          skipped++;
          return;
        }
        if (!looksLikeRecord(parsed)) {
          skipped++;
          return;
        }
        const stamped = Date.parse(parsed.ts);
        if (!Number.isFinite(stamped)) {
          skipped++;
          return;
        }
        const lag = laggedBy(parsed.timing);
        if (lag === null) unaligned++;
        requests.push({
          at: stamped - (lag ?? 0),
          path: parsed.path,
          bytes: parsed.beforeBytes,
          model: typeof parsed.model === 'string' ? parsed.model : null,
        });
      });
      lines.on('close', settle);
      lines.on('error', fail);
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT')
      return { requests: [], skipped: 0, missing: true, unaligned: 0 };
    throw error;
  }
  return { requests, skipped, missing: false, unaligned };
}

/** One value the two recorders do not report the same number of times. */
export interface Disagreement {
  readonly path: string;
  /** The byte length, or the model id, the two sides disagree about. */
  readonly value: string;
  readonly inCapture: number;
  readonly inLedger: number;
}

/** How much of one side's records the comparison actually used. */
export interface SideSummary {
  readonly total: number;
  readonly skipped: number;
  readonly missing: boolean;
  /** Records inside the overlap, which are the ones compared. */
  readonly compared: number;
  /** Records outside it, excluded and reported rather than silently dropped. */
  readonly excluded: number;
  /**
   * Records whose arrival could not be recovered -- always zero for the
   * capture, which stamps arrival directly. See `LedgerProjection.unaligned`.
   */
  readonly unaligned: number;
}

export interface AuditReport {
  readonly capture: SideSummary;
  readonly ledger: SideSummary;
  /** The intersection of the two extents, ISO, or null when there is none. */
  readonly from: string | null;
  readonly to: string | null;
  readonly bytes: readonly Disagreement[];
  readonly models: readonly Disagreement[];
  /**
   * True only when something was compared AND nothing disagreed.
   *
   * A COMPARISON OF NOTHING IS NOT AGREEMENT. An empty overlap, a capture that
   * was never on, a ledger from a different machine -- each produces zero
   * disagreements, and reporting that as agreement is how an instrument comes
   * to certify a result it never examined.
   */
  readonly agreed: boolean;
}

/** Code-unit order, so the same input sorts the same way on every machine. */
function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function tally(
  values: readonly { readonly path: string; readonly value: string }[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { path, value } of values) {
    const key = `${path}\u0000${value}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Values one side reports a different number of times than the other.
 *
 * KEYED BY PATH AS WELL AS VALUE, so a 4,000-byte request to one endpoint is
 * never cancelled out by a 4,000-byte request to another. The union of both
 * sides' keys is walked, so a value missing from one side entirely shows up as
 * a count of zero rather than not showing up at all.
 */
function differences(
  capture: Map<string, number>,
  ledger: Map<string, number>
): readonly Disagreement[] {
  const found: Disagreement[] = [];
  for (const key of new Set([...capture.keys(), ...ledger.keys()])) {
    const inCapture = capture.get(key) ?? 0;
    const inLedger = ledger.get(key) ?? 0;
    if (inCapture === inLedger) continue;
    const split = key.indexOf('\u0000');
    found.push({
      path: key.slice(0, split),
      value: key.slice(split + 1),
      inCapture,
      inLedger,
    });
  }
  // ORDERED BY CODE UNIT, NOT BY LOCALE. `localeCompare` puts the findings in a
  // different order on a different machine, and this list is rendered, diffed
  // and asserted on.
  return found.sort((left, right) =>
    left.path === right.path
      ? compareText(left.value, right.value)
      : compareText(left.path, right.path)
  );
}

/**
 * How far past the overlap the compared window reaches, at each end.
 *
 * WIDENED, NOT NARROWED, AND THE DIRECTION IS THE WHOLE POINT. The two
 * recorders stamp the same request from two clocks: the capture writes
 * `Date.now()` as the body lands, while the ledger writes `Date.now()` as the
 * response finishes and this audit subtracts the record's own durations to get
 * back to the landing. The subtraction lands near the capture's instant rather
 * than exactly on it. The ends of the overlap ARE records -- the overlap is
 * built from the extents -- so a window clipped exactly to it drops the first
 * and last request every time, and an audit of two requests would compare none
 * of them. Reaching a second past each end keeps both recorders' copy of a
 * boundary request on the same side of the line.
 *
 * What it costs: when one recorder was switched on while the other was already
 * running, a request within a second of the moment the second one started is
 * compared although only one side saw it, and reads as a disagreement. That is
 * the right way round -- a spurious finding is investigated, a silently
 * excluded one is not -- and the alternative compares nothing at all.
 */
const WINDOW_SLACK_MS = 1_000;

function extent(
  requests: readonly { readonly at: number }[]
): { readonly first: number; readonly last: number } | null {
  if (requests.length === 0) return null;
  let first = requests[0].at;
  let last = first;
  for (const request of requests) {
    if (request.at < first) first = request.at;
    if (request.at > last) last = request.at;
  }
  return { first, last };
}

/**
 * Both recorders' agreement about the traffic they both saw.
 *
 * ONE QUESTION, ASKED TWICE. The byte length is the figure every savings number
 * is built on, and the model id is what each of those figures is attributed to.
 * They are compared separately because they fail separately: a re-serialization
 * moves the bytes and leaves the attribution intact, and a mis-read request
 * moves the attribution and leaves the bytes intact.
 */
export async function auditRecorders(
  captureDir: string,
  ledgerPath: string
): Promise<AuditReport> {
  const [capture, ledger] = await Promise.all([
    readCapture(captureDir),
    readLedgerProjection(ledgerPath),
  ]);
  const captureExtent = extent(capture.requests);
  const ledgerExtent = extent(ledger.requests);
  // NO OVERLAP IS NOT NO DISAGREEMENT. Either side empty -- capture never
  // enabled, a ledger from another machine, a window of traffic each recorder
  // missed -- and there is nothing to compare, which this reports as such
  // rather than as agreement.
  if (captureExtent === null || ledgerExtent === null)
    return empty(capture, ledger, null);
  const from = Math.max(captureExtent.first, ledgerExtent.first);
  const to = Math.min(captureExtent.last, ledgerExtent.last);
  // THE EXTENTS DO NOT MEET. Not a short overlap -- no overlap, which is a
  // different answer from "they agree over a narrow window" and is reported as
  // having no window rather than as an empty one.
  if (from > to) return empty(capture, ledger, null);
  const window = { from: from - WINDOW_SLACK_MS, to: to + WINDOW_SLACK_MS };
  const inside = <T extends { readonly at: number }>(
    requests: readonly T[]
  ): readonly T[] =>
    requests.filter(
      (request) => request.at >= window.from && request.at <= window.to
    );
  const comparedCapture = inside(capture.requests);
  const comparedLedger = inside(ledger.requests);
  const bytes = differences(
    tally(
      comparedCapture.map((request) => ({
        path: request.path,
        value: String(request.bytes),
      }))
    ),
    tally(
      comparedLedger.map((request) => ({
        path: request.path,
        value: String(request.bytes),
      }))
    )
  );
  // AN ABSENT MODEL IS A VALUE, NOT A GAP. One side parsing a model id where
  // the other found none is a disagreement about attribution, and dropping the
  // nulls would hide exactly that.
  const models = differences(
    tally(
      comparedCapture.map((request) => ({
        path: request.path,
        value: request.model ?? NO_MODEL,
      }))
    ),
    tally(
      comparedLedger.map((request) => ({
        path: request.path,
        value: request.model ?? NO_MODEL,
      }))
    )
  );
  return {
    capture: side(capture, comparedCapture.length),
    ledger: side(ledger, comparedLedger.length),
    from: new Date(window.from).toISOString(),
    to: new Date(window.to).toISOString(),
    bytes,
    models,
    agreed:
      comparedCapture.length > 0 &&
      comparedLedger.length > 0 &&
      bytes.length === 0 &&
      models.length === 0,
  };
}

/**
 * The value standing in for a body with no `model` field.
 *
 * A LITERAL NOBODY CAN SEND. A model id is a string from the request body, so
 * any readable placeholder could also arrive as a real value and collide with
 * it; a null byte cannot appear in one.
 */
export const NO_MODEL = '\u0000none';

function side(
  read: CaptureRead | LedgerProjection,
  compared: number
): SideSummary {
  return {
    total: read.requests.length,
    skipped: read.skipped,
    missing: read.missing,
    compared,
    excluded: read.requests.length - compared,
    unaligned: 'unaligned' in read ? read.unaligned : 0,
  };
}

/** A report over an overlap that holds nothing, which is never agreement. */
function empty(
  capture: CaptureRead,
  ledger: LedgerProjection,
  overlap: { readonly from: number; readonly to: number } | null
): AuditReport {
  return {
    capture: side(capture, 0),
    ledger: side(ledger, 0),
    from: overlap === null ? null : new Date(overlap.from).toISOString(),
    to: overlap === null ? null : new Date(overlap.to).toISOString(),
    bytes: [],
    models: [],
    agreed: false,
  };
}

/** A count with its noun agreeing with it, because these lines are read. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function sideLine(name: string, summary: SideSummary): string {
  if (summary.missing) return `  ${name}: not there`;
  const parts = [plural(summary.total, 'record')];
  if (summary.compared !== summary.total)
    parts.push(`${summary.compared} inside the window`);
  if (summary.excluded > 0) parts.push(`${summary.excluded} outside it`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} unreadable`);
  return `  ${name}: ${parts.join(', ')}`;
}

/**
 * The report as lines.
 *
 * LEADS WITH WHAT WAS COMPARED, NOT WITH THE VERDICT. "They agree" over four of
 * nine thousand requests is the shape of answer this instrument exists to stop
 * giving, so the extent comes first and the verdict last.
 */
export function renderAudit(report: AuditReport): readonly string[] {
  const lines = ['capture and ledger, over the traffic they both saw', ''];
  lines.push(sideLine('capture', report.capture));
  lines.push(sideLine('ledger ', report.ledger));
  lines.push(
    report.from === null || report.to === null
      ? '  window: none -- the two recorders cover no common period'
      : `  window: ${report.from} .. ${report.to}`
  );
  if (report.ledger.unaligned > 0)
    lines.push(
      `  ${plural(report.ledger.unaligned, 'ledger record')} carry no timing, ` +
        'so they sit on the completion clock'
    );
  for (const [what, found] of [
    ['body bytes', report.bytes],
    ['model ids', report.models],
  ] as const) {
    if (found.length === 0) continue;
    lines.push('', `${what} the two recorders count differently:`);
    for (const difference of found)
      lines.push(
        `  ${difference.path} ${
          difference.value === NO_MODEL ? '(no model field)' : difference.value
        }: ${difference.inCapture} captured, ${difference.inLedger} in the ledger`
      );
  }
  lines.push('');
  if (report.agreed) {
    lines.push('agreed: every compared value appears the same number of times');
    return lines;
  }
  if (report.capture.compared === 0 || report.ledger.compared === 0) {
    // NOT A PASS, AND NOT A FAILURE EITHER. Nothing was examined, which is a
    // setup problem, and the fix differs per cause -- so name the cause.
    lines.push('nothing was compared, so this is not an agreement');
    lines.push(
      report.capture.missing
        ? '  the capture file is not there: set TOKEN_OPTIMIZER_PROXY_CAPTURE to a'
        : '  with no overlap, one recorder was on while the other was not --'
    );
    lines.push(
      report.capture.missing
        ? '  directory and run the traffic again'
        : '  run traffic with both TOKEN_OPTIMIZER_PROXY_CAPTURE and'
    );
    if (!report.capture.missing)
      lines.push('  TOKEN_OPTIMIZER_PROXY_ACCOUNTING set, then ask again');
    return lines;
  }
  lines.push(
    `disagreed: ${plural(report.bytes.length, 'byte count')} and ` +
      `${plural(report.models.length, 'model id')} differ`
  );
  return lines;
}
