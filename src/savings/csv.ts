/**
 * The savings report as one flat table, for a spreadsheet or a stored series.
 *
 * NOT A SECOND AGGREGATION. Every figure here is one already computed for the
 * text and JSON renderings and copied across unchanged; this module adds no
 * arithmetic of its own, so a number read out of the CSV is the same number the
 * report printed and there is no third result to reconcile.
 *
 * ONE TABLE, WITH THE GRAIN NAMED IN TWO COLUMNS. The report is really five
 * tables -- nested windows and two breakdowns over the MCP tools, windows and a
 * model breakdown over the proxy -- and a spreadsheet wants one. So `source`
 * says which half of the product a row describes and `section` says at what
 * grain, which keeps the rows addressable without a reader having to guess from
 * the label. The windows NEST rather than partition (today is inside the last
 * seven days), so summing a column across window rows double-counts; that is a
 * property of the report, not of this encoding, and the header note says so.
 *
 * A HALF WITH NOTHING MEASURABLE CONTRIBUTES NO ROWS, NOT A ROW OF ZEROS.
 * Once it is in a spreadsheet, `tokens_saved=0` is indistinguishable from a
 * measured zero, and `savings_percent=0` over `tokens_before=0` is a ratio
 * nobody computed. The text rendering already refuses to print a table in that
 * state and says what to do instead; this one answers with the header alone,
 * which is also what lets a stored series be appended to from day one.
 *
 * AN EMPTY CELL MEANS NOT MEASURED AT THIS GRAIN, NEVER ZERO. A breakdown row
 * carries no before-state, because a group is a slice of operations rather than
 * a window over them, and an unpriced window carries no dollar figure. Writing
 * 0 in either place would be a measurement this command never made.
 */

import { asSavingsWindow } from './render.js';
import { PROXY_INPUT, type ProxyInput } from './proxy.js';
import type { SavingsGroup, SavingsReport, SavingsWindow } from './windows.js';

/** Which half of the product a row describes. */
export const CSV_SOURCE = Object.freeze({
  /** Undisclosed MCP payloads the tools never materialized. */
  Mcp: 'mcp',
  /** Request bodies the proxy rewrote on the wire. */
  Proxy: 'proxy',
} as const);

export type CsvSource = (typeof CSV_SOURCE)[keyof typeof CSV_SOURCE];

/** The grain a row is taken at. */
export const CSV_SECTION = Object.freeze({
  /** A calendar window, nested inside the wider ones. */
  Window: 'window',
  /** One model's slice of every window. */
  ByModel: 'by_model',
  /** One client's slice of every window. */
  ByClient: 'by_client',
} as const);

export type CsvSection = (typeof CSV_SECTION)[keyof typeof CSV_SECTION];

/**
 * The column order, which is the file format. Appending is safe for a reader
 * that addresses cells by header name; reordering or renaming is not, so this
 * list changes only alongside a note in the release.
 */
export const CSV_FIELDS = Object.freeze([
  'source',
  'section',
  'name',
  'since',
  'operations',
  'tokens_before',
  'tokens_saved',
  'savings_percent',
  'cost_usd',
  'priced_operations',
  'eligible_operations',
] as const);

/** A cell before encoding: a number, a string, or nothing measured. */
type Cell = string | number | null;

/**
 * One row, keyed by column so a caller cannot transpose two figures silently.
 */
type Row = Readonly<Record<(typeof CSV_FIELDS)[number], Cell>>;

/**
 * Characters a spreadsheet reads as the start of a formula rather than as text.
 *
 * A model or client name reaches this file from recorded traffic, so it is not
 * ours to trust. Excel and Sheets both execute a cell that opens with one of
 * these, which turns a report into a script, so such a cell is prefixed with an
 * apostrophe -- the documented spreadsheet escape for "this is text". The JSON
 * output is the lossless channel and does not need the prefix.
 */
const FORMULA_LEAD = Object.freeze(['=', '+', '-', '@', '\t', '\r']);

/**
 * RFC 4180 encoding of one cell, plus the formula guard above.
 *
 * A null becomes an empty field rather than a zero -- see the module note.
 */
export function csvCell(value: Cell): string {
  if (value === null) return '';
  const raw = typeof value === 'number' ? String(value) : value;
  const guarded =
    raw.length > 0 && FORMULA_LEAD.includes(raw[0]) ? `'${raw}` : raw;
  return /[",\r\n]/.test(guarded) || guarded !== guarded.trim()
    ? `"${guarded.replace(/"/g, '""')}"`
    : guarded;
}

function windowRow(source: CsvSource, window: SavingsWindow): Row {
  return {
    source,
    section: CSV_SECTION.Window,
    name: window.label,
    since: window.since,
    operations: window.operations,
    tokens_before: window.tokensBefore,
    tokens_saved: window.tokensSaved,
    savings_percent: window.savingsPercent,
    cost_usd: window.costUsd,
    priced_operations: window.pricedOperations,
    eligible_operations: window.eligibleOperations,
  };
}

function groupRow(
  source: CsvSource,
  section: CsvSection,
  group: SavingsGroup
): Row {
  return {
    source,
    section,
    name: group.name,
    // A GROUP SPANS EVERY WINDOW, so it opens at no instant and the cell stays
    // empty rather than borrowing a window's.
    since: null,
    operations: group.operations,
    // THE BEFORE-STATE IS THE GROUP'S OWN, taken from the same rows its saving
    // came from, so the percentage here is this group's and not a share of a
    // window's. It is filled because a row that carries a saving with no
    // denominator cannot be held to a target -- which is what the savings gate
    // does with it.
    tokens_before: group.tokensBefore,
    tokens_saved: group.tokensSaved,
    savings_percent: group.savingsPercent,
    cost_usd: group.costUsd,
    priced_operations: group.pricedOperations,
    eligible_operations: group.eligibleOperations,
  };
}

/**
 * Every row of both halves, in the order the text report prints them.
 *
 * EACH HALF IS INCLUDED ONLY IF IT MEASURED SOMETHING. The MCP half needs at
 * least one operation with a provable before-state -- the same test the text
 * rendering uses to decide whether to print a table at all -- and the proxy
 * half needs a ledger that was READ, not merely configured.
 */
export function savingsCsvRows(
  report: SavingsReport,
  proxy: ProxyInput
): readonly Row[] {
  const rows: Row[] = [];
  if (report.eligibleEntries > 0) {
    rows.push(
      ...report.windows.map((window) => windowRow(CSV_SOURCE.Mcp, window)),
      ...report.byModel.map((group) =>
        groupRow(CSV_SOURCE.Mcp, CSV_SECTION.ByModel, group)
      ),
      ...report.byClient.map((group) =>
        groupRow(CSV_SOURCE.Mcp, CSV_SECTION.ByClient, group)
      )
    );
  }
  if (proxy.kind === PROXY_INPUT.Read) {
    for (const window of proxy.report.windows) {
      rows.push(windowRow(CSV_SOURCE.Proxy, asSavingsWindow(window)));
    }
    for (const group of proxy.report.byModel) {
      rows.push(groupRow(CSV_SOURCE.Proxy, CSV_SECTION.ByModel, group));
    }
  }
  return rows;
}

/**
 * The header line and one line per row -- no leading comment line.
 *
 * A `#` note above the header would make the file unreadable by every tool
 * that opens a CSV by its first line, which is the only reason this format
 * exists. What the columns mean belongs in `--help` and in this module.
 */
export function renderSavingsCsv(
  report: SavingsReport,
  proxy: ProxyInput
): readonly string[] {
  return [
    CSV_FIELDS.join(','),
    ...savingsCsvRows(report, proxy).map((row) =>
      CSV_FIELDS.map((field) => csvCell(row[field])).join(',')
    ),
  ];
}
