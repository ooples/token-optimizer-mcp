/**
 * What keeps the savings record from growing without a bound, and without lying.
 *
 * THE PROBLEM IT SOLVES. The proxy appends one JSONL line per request for as
 * long as a ledger is configured, and nothing ever removed one. A daemon left
 * running writes until the disk says no, and the component that noticed first
 * was whatever else needed that disk.
 *
 * WHY NOT SIMPLY DELETE THE OLD LINES. Every figure the savings report prints
 * is a fold over these rows, so dropping a row silently reduces a number an
 * operator reads as their saving -- the report would get quieter the longer it
 * ran and say nothing about why. So a line is never dropped before what it
 * contributes has been added to a durable per-day total, and the report folds
 * those totals in alongside the live rows.
 *
 * WHY A DAY IS THE GRAIN, and why that is exact rather than approximate: every
 * window the report prints opens at the start of a local day (`windows.ts`), so
 * a whole local day is either entirely inside a window or entirely outside it.
 * There is no day to split and no boundary to round, which is the property that
 * makes a pre-folded day indistinguishable from the rows it came from.
 *
 * THE WINDOW IS DERIVED, NOT CHOSEN. It is the longest window the report shows
 * plus a margin, read off `windowBoundaries` rather than written down here --
 * so a fifth window added to the report cannot quietly start reading from a
 * retention policy that already threw its rows away.
 */

import {
  closeSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import {
  classifyProxySavings,
  priceProxyDelta,
  proxyCalibration,
  proxyTokensBefore,
  proxyTransportDelta,
  PROXY_SAVINGS,
} from '../analytics/proxy-savings.js';
import { looksLikeRecord } from '../inspect/ledger.js';
import type { AccountingRecord } from '../proxy/accounting.js';
import { UNATTRIBUTED, startOfLocalDay, windowBoundaries } from './windows.js';

/**
 * Days kept past the longest window the report shows.
 *
 * The grain makes the boundary exact, so this is not correcting for rounding.
 * It buys the things that only raw rows can answer: a per-request breakdown at
 * the edge of the longest window, a clock that moved, and an operator looking
 * at yesterday's ledger by hand after reading today's report.
 */
export const RETENTION_MARGIN_DAYS = 5;

/**
 * How many days of raw rows the report itself needs.
 *
 * READ OFF THE WINDOWS, by measuring the oldest dated boundary they open at.
 * `All time` has no boundary and asks for nothing: it is the window the folded
 * totals serve.
 */
export function longestReportWindowDays(now: Date = new Date()): number {
  const today = startOfLocalDay(now).getTime();
  let days = 0;
  for (const bound of windowBoundaries(now)) {
    if (bound.since === null) continue;
    const span = Math.round((today - bound.since.getTime()) / 86_400_000);
    if (span > days) days = span;
  }
  return days;
}

/** The oldest local day whose raw rows are kept. Everything older is folded. */
export function retentionDays(now: Date = new Date()): number {
  return longestReportWindowDays(now) + RETENTION_MARGIN_DAYS;
}

/**
 * The byte ceiling the age window is backed by.
 *
 * AN AGE WINDOW ALONE IS NOT A BOUND. It bounds how long a row survives, not
 * how many arrive: a single heavy day of proxied traffic can outgrow a month of
 * a quiet one, and the file only shrinks when that day ages out. 16 MiB is
 * around forty thousand rows at the length these records run to, which is more
 * traffic than a day of agent work produces and small enough that nobody
 * notices it on a disk. Past it, the oldest days are folded early -- the same
 * operation the window performs, applied for a different reason, so there is
 * only one path that ever removes a row.
 */
export const MAX_LEDGER_BYTES = 16 * 1024 * 1024;

/**
 * The local calendar day a stamp falls in, as `YYYY-MM-DD`.
 *
 * LOCAL, NOT UTC, because the report's windows are local days. A UTC key would
 * put the evening's requests in tomorrow for anyone east of Greenwich, and a
 * folded day would then straddle a boundary that the raw rows did not.
 */
export function localDayKey(at: Date): string {
  const year = at.getFullYear();
  const month = `${at.getMonth() + 1}`.padStart(2, '0');
  const day = `${at.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Midnight that opens a `YYYY-MM-DD` key, in local time, or null if unparseable. */
export function startOfDayKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const at = new Date(year, month - 1, day, 0, 0, 0, 0);
  // A ROUND TRIP, NOT A RANGE CHECK: `new Date(2026, 1, 31)` is March 3rd, and
  // only comparing the parts back catches a key that named a day that is not
  // one. The report would otherwise fold a day into a window it never fell in.
  if (
    at.getFullYear() !== year ||
    at.getMonth() !== month - 1 ||
    at.getDate() !== day
  ) {
    return null;
  }
  return at;
}

/**
 * One set of running totals: the only shape a folded day is ever stored in.
 *
 * DEFINED HERE, AND USED BY THE READER, so the two cannot drift. A field the
 * report starts accumulating but the rollup does not store would make the
 * folded half of the record quietly shorter than the live half, and the seam
 * would sit exactly where nobody looks -- at the far edge of the longest
 * window, in the figure labelled "all time".
 *
 * MUTABLE BY DESIGN: this is a fold.
 */
export interface RollupTotals {
  requests: number;
  billedRequests: number;
  countedRequests: number;
  pricedRequests: number;
  calibratedRequests: number;
  tokensSaved: number;
  tokensBefore: number;
  cost: number;
  oursTokens: number;
  billedTokens: number;
}

export function emptyTotals(): RollupTotals {
  return {
    requests: 0,
    billedRequests: 0,
    countedRequests: 0,
    pricedRequests: 0,
    calibratedRequests: 0,
    tokensSaved: 0,
    tokensBefore: 0,
    cost: 0,
    oursTokens: 0,
    billedTokens: 0,
  };
}

/** Adds one set of totals into another. The folded half's only arithmetic. */
export function addTotals(into: RollupTotals, from: RollupTotals): void {
  into.requests += from.requests;
  into.billedRequests += from.billedRequests;
  into.countedRequests += from.countedRequests;
  into.pricedRequests += from.pricedRequests;
  into.calibratedRequests += from.calibratedRequests;
  into.tokensSaved += from.tokensSaved;
  into.tokensBefore += from.tokensBefore;
  into.cost += from.cost;
  into.oursTokens += from.oursTokens;
  into.billedTokens += from.billedTokens;
}

/**
 * A day of rows, pre-folded, as it is stored and as the report reads it back.
 *
 * `records` IS NOT DERIVABLE FROM `totals`. The report distinguishes a row that
 * was never charged for from one that was charged but carried no count, and a
 * row that contributed a signed delta from one that contributed zero -- and the
 * last of those cannot be recovered from any sum. They are stored.
 *
 * `byModel` HOLDS ONLY THE ROWS THE BREAKDOWN HOLDS, which is the rows with a
 * non-zero delta, exactly as the live reader buckets them. Storing every row
 * here would give the folded days a longer model table than the live ones.
 */
export interface RollupRow {
  readonly kind: 'proxy-day-rollup';
  readonly version: 1;
  /** The local calendar day, `YYYY-MM-DD`. */
  readonly day: string;
  readonly records: {
    readonly total: number;
    readonly measured: number;
    readonly unbilled: number;
    readonly uncounted: number;
    readonly skippedLines: number;
  };
  readonly totals: RollupTotals;
  readonly byModel: Readonly<Record<string, RollupTotals>>;
}

const ROLLUP_KIND = 'proxy-day-rollup';

function isTotals(value: unknown): value is RollupTotals {
  if (typeof value !== 'object' || value === null) return false;
  const seen = value as Record<string, unknown>;
  for (const field of Object.keys(emptyTotals())) {
    if (typeof seen[field] !== 'number' || !Number.isFinite(seen[field]))
      return false;
  }
  return true;
}

/**
 * Whether a parsed line is a rollup this build can read back.
 *
 * EVERY FIELD IS CHECKED, not just the tag. A rollup is a number the report
 * prints without any row behind it to sanity-check against, so a half-written
 * or future-shaped one has to be refused and counted rather than folded in as
 * a partial day -- which would read as a quiet week.
 */
export function looksLikeRollup(value: unknown): value is RollupRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  if (row.kind !== ROLLUP_KIND || row.version !== 1) return false;
  if (typeof row.day !== 'string' || startOfDayKey(row.day) === null)
    return false;
  const records = row.records;
  if (typeof records !== 'object' || records === null) return false;
  const counts = records as Record<string, unknown>;
  for (const field of [
    'total',
    'measured',
    'unbilled',
    'uncounted',
    'skippedLines',
  ]) {
    const seen = counts[field];
    if (typeof seen !== 'number' || !Number.isInteger(seen) || seen < 0)
      return false;
  }
  if (!isTotals(row.totals)) return false;
  if (typeof row.byModel !== 'object' || row.byModel === null) return false;
  for (const totals of Object.values(row.byModel as Record<string, unknown>)) {
    if (!isTotals(totals)) return false;
  }
  return true;
}

/**
 * Folds one record into one set of totals.
 *
 * SHARED WITH THE READER rather than copied into it. This is the arithmetic
 * that decides what a saving is, and the folded days and the live rows have to
 * agree on it exactly or the seam between them becomes a step in the figure.
 *
 * `tokensBefore` COMES FROM THE SAME ROWS AS `tokensSaved`, which is the rule
 * `windows.ts` already follows: a percentage whose numerator is the measured
 * rows and whose denominator is every row would fall as more unmeasurable
 * traffic arrived, reading as the proxy getting worse at the moment it was
 * being told less.
 */
export function foldRecord(
  totals: RollupTotals,
  record: AccountingRecord
): void {
  totals.requests += 1;
  const classification = classifyProxySavings(record);
  if (classification === PROXY_SAVINGS.Unbilled) return;
  totals.billedRequests += 1;
  if (classification === PROXY_SAVINGS.Uncounted) return;
  totals.countedRequests += 1;
  const calibration = proxyCalibration(record);
  if (calibration !== null) {
    totals.calibratedRequests += 1;
    totals.oursTokens += calibration.ours;
    totals.billedTokens += calibration.billed;
  }
  const delta = proxyTransportDelta(record);
  if (delta === 0) return;
  totals.tokensSaved += delta;
  totals.tokensBefore += proxyTokensBefore(record);
  const priced = priceProxyDelta(record);
  if (priced === null) return;
  totals.cost += priced;
  totals.pricedRequests += 1;
}

/** A day being folded, before it is frozen into a `RollupRow`. */
interface DayFold {
  total: number;
  measured: number;
  unbilled: number;
  uncounted: number;
  skippedLines: number;
  totals: RollupTotals;
  byModel: Map<string, RollupTotals>;
}

function emptyDay(): DayFold {
  return {
    total: 0,
    measured: 0,
    unbilled: 0,
    uncounted: 0,
    skippedLines: 0,
    totals: emptyTotals(),
    byModel: new Map(),
  };
}

/** Where a ledger's folded days live: beside it, never inside it. */
export function rollupPath(ledger: string): string {
  // A SEPARATE FILE so the live ledger stays append-only for its writer and a
  // reader that only wants the last few records never parses a day's totals.
  return `${ledger}.rollup.jsonl`;
}

/**
 * Reads a JSONL file a line at a time without holding it in memory.
 *
 * SYNCHRONOUS, like the append it shares a writer with. The prune runs inside
 * the one path that writes the ledger, which is what lets it rewrite the file
 * without racing an append; an async read would hand control back and let one
 * land in the middle of the rewrite. Memory stays at one chunk plus one line.
 */
function forEachLine(path: string, visit: (line: string) => void): void {
  // eslint-disable-next-line n/no-sync -- single-writer rewrite; see above
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let carry = '';
    for (;;) {
      // eslint-disable-next-line n/no-sync -- single-writer rewrite; see above
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      const text = carry + chunk.subarray(0, read).toString('utf8');
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) if (line.trim() !== '') visit(line);
    }
    if (carry.trim() !== '') visit(carry);
  } finally {
    // eslint-disable-next-line n/no-sync -- single-writer rewrite; see above
    closeSync(fd);
  }
}

/** The local day a ledger line falls in, or null when it cannot be placed. */
function dayOfLine(
  line: string
): { day: string; record: AccountingRecord } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!looksLikeRecord(parsed)) return null;
  const record = parsed as AccountingRecord;
  const at = Date.parse(record.ts);
  if (!Number.isFinite(at)) return null;
  return { day: localDayKey(new Date(at)), record };
}

export interface PruneLimits {
  /** Days of raw rows to keep. Defaults to `retentionDays(now)`. */
  readonly retentionDays?: number;
  /** Ceiling the kept rows are brought under. Defaults to `MAX_LEDGER_BYTES`. */
  readonly maxBytes?: number;
}

export interface PruneOutcome {
  /** Whether anything was folded. A no-op prune rewrites nothing. */
  readonly changed: boolean;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly linesKept: number;
  readonly linesFolded: number;
  readonly daysFolded: number;
  /** Lines that were not a record, folded as skipped so the count survives. */
  readonly linesSkipped: number;
  /** Why the fold happened, for the caller that reports it. */
  readonly reason: 'age' | 'bytes' | 'none';
}

const NOTHING_TO_DO: PruneOutcome = Object.freeze({
  changed: false,
  bytesBefore: 0,
  bytesAfter: 0,
  linesKept: 0,
  linesFolded: 0,
  daysFolded: 0,
  linesSkipped: 0,
  reason: 'none',
});

function fileSize(path: string): number | null {
  try {
    // eslint-disable-next-line n/no-sync -- single-writer rewrite; see forEachLine
    return statSync(path).size;
  } catch {
    return null;
  }
}

/**
 * The days to fold, oldest first, and why.
 *
 * AGE DECIDES FIRST, and the ceiling only ever folds MORE. Running the two in
 * the other order would let a quiet month of rows sit inside the ceiling and
 * never age out, which is the behaviour the window exists to prevent.
 */
function daysToFold(
  bytesByDay: ReadonlyMap<string, number>,
  cutoff: Date,
  maxBytes: number,
  totalBytes: number
): { days: string[]; reason: 'age' | 'bytes' | 'none' } {
  const ordered = [...bytesByDay.keys()].sort();
  const days: string[] = [];
  let kept = totalBytes;
  for (const day of ordered) {
    const start = startOfDayKey(day);
    if (start === null || start.getTime() >= cutoff.getTime()) break;
    days.push(day);
    kept -= bytesByDay.get(day) ?? 0;
  }
  const byAge = days.length;
  for (const day of ordered.slice(byAge)) {
    if (kept <= maxBytes) break;
    // THE NEWEST DAY IS NEVER FOLDED BY SIZE ALONE. Folding the day that is
    // still being written to would replace rows a reader can still see in the
    // live file with a total that the next append immediately makes partial.
    if (day === ordered[ordered.length - 1]) break;
    days.push(day);
    kept -= bytesByDay.get(day) ?? 0;
  }
  if (days.length === 0) return { days, reason: 'none' };
  return { days, reason: days.length > byAge ? 'bytes' : 'age' };
}

function freezeDay(day: string, fold: DayFold): RollupRow {
  const byModel: Record<string, RollupTotals> = {};
  for (const [name, totals] of fold.byModel) byModel[name] = totals;
  return Object.freeze({
    kind: ROLLUP_KIND,
    version: 1,
    day,
    records: Object.freeze({
      total: fold.total,
      measured: fold.measured,
      unbilled: fold.unbilled,
      uncounted: fold.uncounted,
      skippedLines: fold.skippedLines,
    }),
    totals: fold.totals,
    byModel: Object.freeze(byModel),
  });
}

/** Folds one record into a day, exactly as the live reader buckets it. */
function foldIntoDay(fold: DayFold, record: AccountingRecord): void {
  fold.total += 1;
  const classification = classifyProxySavings(record);
  if (classification === PROXY_SAVINGS.Unbilled) fold.unbilled += 1;
  else if (classification === PROXY_SAVINGS.Uncounted) fold.uncounted += 1;
  const delta = proxyTransportDelta(record);
  if (delta !== 0) fold.measured += 1;
  foldRecord(fold.totals, record);
  if (delta === 0) return;
  const name = (record.model ?? '').trim() || UNATTRIBUTED;
  let bucket = fold.byModel.get(name);
  if (bucket === undefined) {
    bucket = emptyTotals();
    fold.byModel.set(name, bucket);
  }
  foldRecord(bucket, record);
}

/** Merges a day already on disk into the fold being built for it. */
function mergeRollup(into: DayFold, row: RollupRow): void {
  into.total += row.records.total;
  into.measured += row.records.measured;
  into.unbilled += row.records.unbilled;
  into.uncounted += row.records.uncounted;
  into.skippedLines += row.records.skippedLines;
  addTotals(into.totals, row.totals);
  for (const [name, totals] of Object.entries(row.byModel)) {
    let bucket = into.byModel.get(name);
    if (bucket === undefined) {
      bucket = emptyTotals();
      into.byModel.set(name, bucket);
    }
    addTotals(bucket, totals);
  }
}

/**
 * Folds the ledger's old days into its rollup file and rewrites what is left.
 *
 * THE ROLLUP IS WRITTEN BEFORE THE LEDGER IS REWRITTEN, and the order is what
 * makes a crash survivable. Stopping between the two leaves a day present in
 * both files, and the reader resolves that by preferring the live rows and
 * ignoring the rollup for any day it has rows for -- so the worst a crash
 * costs is a rollup row nobody reads. Writing the ledger first would instead
 * lose the day outright, which is the failure that shows up as a quiet week.
 *
 * BOTH WRITES GO THROUGH A TEMPORARY FILE AND A RENAME, so a reader never sees
 * half of either file, and a prune that dies mid-write leaves both as they
 * were.
 *
 * CALLED FROM THE WRITER, never beside it. See `forEachLine`.
 */
export function pruneProxyLedger(
  ledger: string,
  now: Date = new Date(),
  limits: PruneLimits = {}
): PruneOutcome {
  const bytesBefore = fileSize(ledger);
  if (bytesBefore === null || bytesBefore === 0) return NOTHING_TO_DO;
  const keepDays = limits.retentionDays ?? retentionDays(now);
  const maxBytes = limits.maxBytes ?? MAX_LEDGER_BYTES;
  const cutoff = startOfLocalDay(now);
  cutoff.setDate(cutoff.getDate() - keepDays);

  const bytesByDay = new Map<string, number>();
  let unplaceable = 0;
  forEachLine(ledger, (line) => {
    const placed = dayOfLine(line);
    // A LINE'S OWN LENGTH, newline included, because that is what rewriting it
    // will cost; summing the file size instead would misattribute the tail.
    const bytes = Buffer.byteLength(line, 'utf8') + 1;
    if (placed === null) {
      unplaceable += bytes;
      return;
    }
    bytesByDay.set(placed.day, (bytesByDay.get(placed.day) ?? 0) + bytes);
  });

  const { days, reason } = daysToFold(
    bytesByDay,
    cutoff,
    maxBytes,
    bytesBefore - unplaceable
  );
  // THE TWO CHECKS ARE THE SAME FACT stated twice, which is deliberate: the
  // reason a caller reports and the set a rewrite walks must agree, and a cast
  // here would let a future `daysToFold` return one without the other.
  if (days.length === 0 || reason === 'none') return NOTHING_TO_DO;
  const folding = new Set(days);
  const oldest = days[0];
  if (oldest === undefined) return NOTHING_TO_DO;
  return rewrite(ledger, folding, oldest, bytesBefore, reason);
}

/**
 * The two writes, in the order the header explains.
 *
 * AN UNPLACEABLE LINE IS DROPPED AND ITS COUNT KEPT, on the oldest day being
 * folded. A line whose stamp cannot be read is outside every dated window
 * already -- the only thing it contributes to the report is the skipped-line
 * count -- so carrying the count forward loses nothing the report prints, and
 * keeping the lines themselves would put a floor under the file that no window
 * could ever bring down.
 */
function rewrite(
  ledger: string,
  folding: ReadonlySet<string>,
  oldest: string,
  bytesBefore: number,
  reason: 'age' | 'bytes'
): PruneOutcome {
  const folds = new Map<string, DayFold>();
  const dayFold = (day: string): DayFold => {
    let fold = folds.get(day);
    if (fold === undefined) {
      fold = emptyDay();
      folds.set(day, fold);
    }
    return fold;
  };
  const keptPath = `${ledger}.pruned`;
  // eslint-disable-next-line n/no-sync -- single-writer rewrite; see forEachLine
  const kept = openSync(keptPath, 'w');
  let linesKept = 0;
  let linesFolded = 0;
  let linesSkipped = 0;
  try {
    forEachLine(ledger, (line) => {
      const placed = dayOfLine(line);
      if (placed === null) {
        linesSkipped += 1;
        dayFold(oldest).skippedLines += 1;
        return;
      }
      if (!folding.has(placed.day)) {
        // eslint-disable-next-line n/no-sync -- single-writer rewrite; see above
        writeSync(kept, `${line}\n`);
        linesKept += 1;
        return;
      }
      linesFolded += 1;
      foldIntoDay(dayFold(placed.day), placed.record);
    });
  } finally {
    // eslint-disable-next-line n/no-sync -- single-writer rewrite; see above
    closeSync(kept);
  }

  writeRollups(rollupPath(ledger), folds);
  // eslint-disable-next-line n/no-sync -- single-writer rewrite; see above
  renameSync(keptPath, ledger);
  return Object.freeze({
    changed: true,
    bytesBefore,
    bytesAfter: fileSize(ledger) ?? 0,
    linesKept,
    linesFolded,
    daysFolded: folds.size,
    linesSkipped,
    reason,
  });
}

/**
 * Merges new day folds into the rollup file and replaces it atomically.
 *
 * A ROLLUP LINE THAT NO LONGER PARSES IS KEPT, BYTE FOR BYTE, rather than
 * dropped while rewriting around it. It is somebody's saving: a build that
 * cannot read it is not evidence that it is wrong, and the reader already
 * counts what it cannot fold. Dropping it here would make an unreadable row
 * permanent on the first prune after an upgrade.
 */
function writeRollups(path: string, folds: ReadonlyMap<string, DayFold>): void {
  const merged = new Map<string, DayFold>();
  for (const [day, fold] of folds) merged.set(day, fold);
  const foreign: string[] = [];
  if (fileSize(path) !== null) {
    forEachLine(path, (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        foreign.push(line);
        return;
      }
      if (!looksLikeRollup(parsed)) {
        foreign.push(line);
        return;
      }
      let fold = merged.get(parsed.day);
      if (fold === undefined) {
        fold = emptyDay();
        merged.set(parsed.day, fold);
      }
      mergeRollup(fold, parsed);
    });
  }
  const lines: string[] = [...foreign];
  for (const day of [...merged.keys()].sort()) {
    const fold = merged.get(day);
    if (fold === undefined) continue;
    lines.push(JSON.stringify(freezeDay(day, fold)));
  }
  const temporary = `${path}.writing`;
  // eslint-disable-next-line n/no-sync -- single-writer rewrite; see forEachLine
  writeFileSync(temporary, `${lines.join('\n')}\n`, 'utf8');
  // eslint-disable-next-line n/no-sync -- single-writer rewrite; see forEachLine
  renameSync(temporary, path);
}
