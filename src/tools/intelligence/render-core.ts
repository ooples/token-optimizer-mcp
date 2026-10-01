/**
 * Rendering the caller's own data: table formats and plain-text charts.
 *
 * WHY THIS IS SHARED: five of the six tools being rewritten here publish an
 * `export` operation and three publish a `visualize`. Written once per tool
 * those would be six renderers that disagree about quoting and about what to do
 * with a payload that is not a table -- and disagreement between copies is
 * exactly what the deleted hand-written validation layer was.
 *
 * Nothing here invents a value. A payload that cannot be rendered in the
 * requested format is refused, never reshaped into one that can: a silent
 * flatten is how a caller ends up quoting a figure the tool made up.
 */

/** The table formats every `export` operation offers. */
export const EXPORT_FORMATS = ['markdown', 'json', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const isExportFormat = (value: unknown): value is ExportFormat =>
  typeof value === 'string' &&
  (EXPORT_FORMATS as readonly string[]).includes(value);

/** Escapes a cell so a value containing a pipe cannot forge a column. */
export const markdownCell = (value: unknown): string =>
  String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');

/** Escapes a field per RFC 4180. */
export const csvField = (value: unknown): string => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** The union of keys across an array of records, in first-seen order. */
export const columnsOf = (
  rows: ReadonlyArray<Record<string, unknown>>
): string[] => {
  const seen: string[] = [];
  for (const row of rows)
    for (const key of Object.keys(row)) if (!seen.includes(key)) seen.push(key);
  return seen;
};

/** A payload read as table rows, or undefined when it is not a table. */
export const asRows = (
  payload: unknown
): Array<Record<string, unknown>> | undefined => {
  if (Array.isArray(payload)) {
    if (
      payload.length > 0 &&
      payload.every((entry) => entry !== null && typeof entry === 'object')
    )
      return payload as Array<Record<string, unknown>>;
    return undefined;
  }
  if (payload !== null && typeof payload === 'object')
    return [payload as Record<string, unknown>];
  return undefined;
};

export interface RenderedPayload {
  format: ExportFormat;
  content: string;
  rows: number;
}

/**
 * Renders a payload in the requested format. `json` takes anything; `csv` and
 * `markdown` need a table and refuse anything else, naming the format that
 * could not be produced.
 */
export const renderPayload = (
  tool: string,
  payload: unknown,
  format: ExportFormat
): RenderedPayload => {
  if (format === 'json')
    return {
      format,
      content: JSON.stringify(payload, null, 2),
      rows: asRows(payload)?.length ?? 0,
    };

  const rows = asRows(payload);
  if (rows === undefined)
    throw new Error(
      `${tool} export: \`${format}\` needs \`payload\` to be an object or a non-empty array of objects`
    );
  const columns = columnsOf(rows);
  if (columns.length === 0)
    throw new Error(`${tool} export: \`payload\` has no fields to write`);

  if (format === 'csv') {
    const lines = [columns.map(csvField).join(',')];
    for (const row of rows)
      lines.push(columns.map((key) => csvField(row[key])).join(','));
    return { format, content: lines.join('\n'), rows: rows.length };
  }

  const lines = [
    `| ${columns.map(markdownCell).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
  ];
  for (const row of rows)
    lines.push(
      `| ${columns.map((key) => markdownCell(row[key])).join(' | ')} |`
    );
  return { format, content: lines.join('\n'), rows: rows.length };
};

/*
 * The block characters a sparkline is drawn from, lowest to highest.
 */
/** Lowest of the eight block glyphs, U+2581 LOWER ONE EIGHTH BLOCK. */
const SPARK_BASE_CODE_POINT = 0x2581;

/** Eight levels: the resolution the glyphs give, so the scale maps onto eight. */
export const SPARK_LEVEL_COUNT = 8;

/*
 * Built from code points rather than written as literal glyphs. A literal
 * block character in a source file is one mojibake round-trip away from being
 * a question mark, and this repository has already had two files land in
 * Latin-1 that way.
 */
export const SPARK_LEVELS = Array.from(
  { length: SPARK_LEVEL_COUNT },
  (_unused, level) => String.fromCodePoint(SPARK_BASE_CODE_POINT + level)
).join('');

/**
 * A sparkline over the series, scaled between its own minimum and maximum.
 *
 * A flat series renders at the LOWEST level rather than the middle: there is no
 * way to place a constant on a scale derived from itself, and the middle would
 * read as "about average" for data that has no average to be about.
 */
export const sparkline = (values: readonly number[]): string => {
  if (values.length === 0)
    throw new Error('sparkline needs at least one value');
  for (const value of values)
    if (!Number.isFinite(value))
      throw new Error(
        `sparkline needs finite values; received ${String(value)}`
      );
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;
  return values
    .map((value) => {
      const level =
        span === 0
          ? 0
          : Math.min(
              SPARK_LEVELS.length - 1,
              Math.floor(((value - low) / span) * SPARK_LEVELS.length)
            );
      return SPARK_LEVELS[level];
    })
    .join('');
};

export interface BarRow {
  label: string;
  value: number;
}

/** Default bar width, in characters, for the longest bar in a chart. */
export const BAR_CHART_WIDTH = 40;

/**
 * A horizontal bar chart in plain text. Bars are scaled against the largest
 * ABSOLUTE value so a series containing negatives still shares one scale, and
 * every row is labelled with its own value so the chart never has to be read
 * off the glyphs.
 */
export const barChart = (
  rows: readonly BarRow[],
  width: number = BAR_CHART_WIDTH
): string => {
  if (rows.length === 0) throw new Error('barChart needs at least one row');
  if (!Number.isInteger(width) || width < 1)
    throw new Error(
      `barChart needs a width of at least 1; received ${String(width)}`
    );
  for (const row of rows)
    if (!Number.isFinite(row.value))
      throw new Error(
        `barChart needs finite values; ${row.label} is ${String(row.value)}`
      );
  const peak = Math.max(...rows.map((row) => Math.abs(row.value)));
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  return rows
    .map((row) => {
      const filled =
        peak === 0 ? 0 : Math.round((Math.abs(row.value) / peak) * width);
      const bar = (row.value < 0 ? '-' : '#').repeat(filled);
      return `${row.label.padEnd(labelWidth)} | ${bar} ${row.value}`;
    })
    .join('\n');
};
