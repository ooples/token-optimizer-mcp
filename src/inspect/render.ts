/**
 * Turning transformation records into something a person reads.
 *
 * WHAT THIS IS FOR. The proxy has always known, to the byte, what it removed
 * from every request and what the provider then billed for it. Until now that
 * knowledge went either nowhere or into a JSONL ledger two benchmark scripts
 * read. The question an operator actually has -- "is this thing doing anything,
 * and if not, why not" -- had no answer short of reading the source.
 *
 * THE `reason` COLUMN IS THE POINT, not the percentage. A request that was not
 * compressed is the interesting case: the percentages answer "how much", and
 * `reason` answers "why not", which is the question someone asks when the
 * number disappoints them. So an uncompressed row spends its widest column on
 * the refusal rather than printing a zero and leaving the reader to guess.
 */

import type { AccountingRecord } from '../proxy/accounting.js';

/** Byte counts rendered the way a reader compares them: same unit, aligned. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Character counts, which are NOT byte counts and must not be printed as if
 * they were.
 *
 * `injectedChars`, `deferredToolChars`, `systemChars`, `toolsChars` and
 * `messagesChars` are `String.length` -- UTF-16 code units -- taken before the
 * body is serialised. For the ASCII-dominant JSON a model request mostly is,
 * one unit happens to be one byte, which is exactly why rendering them as `KB`
 * passes a casual read and is still wrong: a request carrying CJK text or
 * emoji would have the label overstate the bytes by up to three times. The
 * unit is named instead of converted, because the conversion is not available
 * here and guessing it would be the inaccuracy, not the fix.
 */
export function formatChars(chars: number): string {
  if (!Number.isFinite(chars) || chars < 0) return '-';
  return chars < 10_000
    ? `${chars.toLocaleString('en-US')} chars`
    : `${(chars / 1000).toFixed(1)}k chars`;
}

/** Thousands separators, because these numbers are read, not summed by hand. */
export function formatCount(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('en-US')
    : '-';
}

/**
 * The change in size, signed from the request's point of view.
 *
 * NEGATIVE MEANS SMALLER, which is the convention the rest of this repository's
 * measurements use: a saving reads as -68.9%, and a request the knowledge block
 * made bigger reads as +4.2% rather than as a saving of minus four percent.
 */
export function formatDelta(before: number, after: number): string {
  if (!Number.isFinite(before) || before <= 0) return '-';
  const ratio = (after - before) / before;
  const sign = ratio > 0 ? '+' : '';
  return `${sign}${(ratio * 100).toFixed(1)}%`;
}

/** The clock time, which is all a reader needs to line a row up with a turn. */
export function formatTime(ts: string): string {
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return '-';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * The short note that goes in the last column.
 *
 * Only what fired, never a list of zeroes. A row reading `0 elisions, 0 tools
 * deferred, 0 injected` tells a reader nothing they could not see from the
 * percentage, and three of them stacked hide the one row that says something.
 */
export function notesFor(record: AccountingRecord): string {
  if (record.transportError)
    return `no response: ${record.transportError}`;
  if (!record.compressed)
    return `not compressed${record.reason ? `: ${record.reason}` : ''}`;
  const parts: string[] = [];
  if (record.elisions) parts.push(`${record.elisions} elisions`);
  if (record.dedupReferences)
    parts.push(`${record.dedupReferences} refs reused`);
  if (record.deferredTools)
    parts.push(
      `${record.deferredTools} tools deferred (${formatChars(record.deferredToolChars ?? 0)})`
    );
  // Signed, because this is the one line item that makes a request BIGGER, and
  // a reader comparing it against the saving needs to see which way it points.
  if (record.injectedChars)
    parts.push(`+${formatChars(record.injectedChars)} knowledge`);
  if (record.anchorReason) parts.push(`anchor: ${record.anchorReason}`);
  return parts.length > 0 ? parts.join(', ') : 'compressed';
}

/** The columns of the default view, in order. */
export const COLUMNS = Object.freeze([
  'time',
  'path',
  'code',
  'before',
  'after',
  'change',
  'billed',
  'cached',
  'out',
  'notes',
] as const);

function cellsFor(record: AccountingRecord): readonly string[] {
  const usage = record.usage ?? {};
  // Cache reads are the number a subscription user is actually watching, and
  // the two providers report them under different names; sum is wrong because
  // only one of the pair is ever present on a given response.
  const cached =
    usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? undefined;
  return [
    formatTime(record.ts),
    record.path,
    String(record.status),
    formatBytes(record.beforeBytes),
    formatBytes(record.afterBytes),
    formatDelta(record.beforeBytes, record.afterBytes),
    formatCount(usage.input_tokens),
    formatCount(cached),
    formatCount(usage.output_tokens),
    notesFor(record),
  ];
}

// Which columns read as numbers, and so align on their right edge. `notes` is
// deliberately last and never padded: it is the only variable-width cell, and
// padding the final column just adds trailing whitespace to every line.
const RIGHT_ALIGNED = new Set(['code', 'before', 'after', 'change', 'billed', 'cached', 'out']);

/** Every field of one record, for the reader who needs the one not in a column. */
export function detailFor(record: AccountingRecord): readonly string[] {
  const lines: string[] = [];
  const add = (label: string, value: string | number | undefined): void => {
    if (value === undefined || value === '') return;
    lines.push(`    ${label.padEnd(18)} ${value}`);
  };
  add('request bytes', `${formatCount(record.beforeBytes)} -> ${formatCount(record.afterBytes)}`);
  add(
    'system',
    record.systemChars === undefined ? undefined : formatChars(record.systemChars)
  );
  add(
    'tools',
    record.toolsChars === undefined
      ? undefined
      : `${formatChars(record.toolsChars)} in ${formatCount(record.toolCount)} tools` +
          (record.coreToolChars === undefined
            ? ''
            : ` (core ${formatChars(record.coreToolChars)}, mcp ${formatChars(record.mcpToolChars ?? 0)})`)
  );
  add('largest tools', record.topTools);
  add(
    'messages',
    record.messagesChars === undefined
      ? undefined
      : `${formatChars(record.messagesChars)} in ${formatCount(record.messageCount)} messages`
  );
  add('reason', record.reason);
  add('anchor', record.anchorReason);
  if (record.timing)
    add(
      'timing',
      `transform ${record.timing.transformMs.toFixed(1)} ms, upstream ${record.timing.upstreamMs.toFixed(0)} ms`
    );
  const usage = record.usage ?? {};
  add('cache writes', formatCount(usage.cache_creation_input_tokens) === '-' ? undefined : formatCount(usage.cache_creation_input_tokens));
  return lines;
}

/** What a window of records adds up to. */
export interface TransformationTotals {
  readonly requests: number;
  readonly compressed: number;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
}

/**
 * Totals across the window.
 *
 * COUNTED OVER EVERY RECORD, including the ones that were not compressed. A
 * ratio taken only over the compressed requests answers "how well does the
 * compressor do when it runs", which flatters it; the question being asked
 * here is "what is this saving me", and a request that was skipped saved
 * nothing and still cost its bytes.
 */
export function totalsFor(
  records: readonly AccountingRecord[]
): TransformationTotals {
  let compressed = 0;
  let beforeBytes = 0;
  let afterBytes = 0;
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  for (const record of records) {
    if (record.compressed) compressed++;
    beforeBytes += record.beforeBytes;
    afterBytes += record.afterBytes;
    const usage = record.usage ?? {};
    inputTokens += usage.input_tokens ?? 0;
    cachedTokens +=
      usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? 0;
    outputTokens += usage.output_tokens ?? 0;
  }
  return {
    requests: records.length,
    compressed,
    beforeBytes,
    afterBytes,
    inputTokens,
    cachedTokens,
    outputTokens,
  };
}

/** The table, header included, as lines with no trailing newline. */
export function renderTransformations(
  records: readonly AccountingRecord[],
  options: { readonly full?: boolean } = {}
): readonly string[] {
  if (records.length === 0) return ['no transformations recorded'];
  const rows = records.map(cellsFor);
  const widths = COLUMNS.map((name, index) =>
    Math.max(name.length, ...rows.map((row) => row[index].length))
  );
  const lay = (cells: readonly string[]): string =>
    cells
      .map((cell, index) =>
        index === COLUMNS.length - 1
          ? cell
          : RIGHT_ALIGNED.has(COLUMNS[index])
            ? cell.padStart(widths[index])
            : cell.padEnd(widths[index])
      )
      .join('  ')
      .trimEnd();
  const lines: string[] = [lay(COLUMNS)];
  rows.forEach((row, index) => {
    lines.push(lay(row));
    if (options.full === true) lines.push(...detailFor(records[index]));
  });
  const totals = totalsFor(records);
  lines.push('');
  lines.push(
    `${totals.requests} ${totals.requests === 1 ? 'request' : 'requests'}, ` +
      `${totals.compressed} compressed: ` +
      `${formatBytes(totals.beforeBytes)} -> ${formatBytes(totals.afterBytes)} ` +
      `(${formatDelta(totals.beforeBytes, totals.afterBytes)})`
  );
  lines.push(
    `billed ${formatCount(totals.inputTokens)} input, ` +
      `${formatCount(totals.cachedTokens)} from cache, ` +
      `${formatCount(totals.outputTokens)} output`
  );
  return lines;
}
