/**
 * A list of same-shaped records, with the field names sent once.
 *
 * Every tool here that answers with a list of findings -- functions with their
 * complexity, exports with their signatures, symbols with their locations --
 * sent the field names again on every element. Measured on a 13-function
 * source file, smart_complexity's per-function blocks cost 1639 tokens, and
 * about half of that was 24 key names repeated 13 times: "distinctOperators",
 * "logicalLinesOfCode" and "maintainabilityIndex" once per function, to label
 * numbers whose meaning had already been established by the first element.
 *
 * The names are structural, not content, so they belong in the header. This is
 * the same information in the shape a table has always had, and it is
 * reversible: decodeTable() rebuilds the records exactly, which is how the one
 * in-process consumer (smart_refactor, which reads smart_complexity's output)
 * keeps working on objects.
 */

/** A leaf value: what survives JSON without further structure. */
export type Cell = string | number | boolean | null | unknown[];

export interface Table {
  /**
   * Field paths, in first-seen order. A nested field is dotted --
   * `complexity.halstead.volume` -- so the header stays flat and one row is
   * one record.
   */
  columns: string[];
  /** One array per record, positionally matching {@link columns}. */
  rows: Cell[][];
}

const PATH_SEPARATOR = '.';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function flatten(
  record: Record<string, unknown>,
  prefix: string,
  into: Map<string, Cell>
): void {
  for (const [key, value] of Object.entries(record)) {
    if (key.includes(PATH_SEPARATOR)) {
      // Refused rather than guessed at. A dotted key would decode as two
      // levels of nesting, so encoding one would make decodeTable() return
      // something other than what it was given -- and a lossless claim that
      // holds only for most inputs is not one worth making.
      throw new Error(
        `encodeTable: field name contains the path separator and could not be decoded back: ${prefix}${key}`
      );
    }
    const path = prefix + key;
    if (value === undefined) {
      continue;
    }
    if (isPlainObject(value)) {
      flatten(value, path + PATH_SEPARATOR, into);
      continue;
    }
    into.set(path, value as Cell);
  }
}

/**
 * Turns a list of records into a header plus rows.
 *
 * A field absent from one record is `null` in that row, and decodes back to
 * absent. A record contributing no fields at all still produces a row, so the
 * count of rows is the count of records.
 */
export function encodeTable(records: Record<string, unknown>[]): Table {
  const flattened = records.map((record) => {
    const cells = new Map<string, Cell>();
    flatten(record, '', cells);
    return cells;
  });

  const columns: string[] = [];
  const seen = new Set<string>();
  for (const cells of flattened) {
    for (const path of cells.keys()) {
      if (!seen.has(path)) {
        seen.add(path);
        columns.push(path);
      }
    }
  }

  return {
    columns,
    rows: flattened.map((cells) =>
      columns.map((path) => (cells.has(path) ? (cells.get(path) as Cell) : null))
    ),
  };
}

/**
 * Rebuilds the records a {@link Table} was encoded from.
 *
 * A `null` cell is treated as the field having been absent, which is the
 * inverse of what encodeTable() writes for a missing field. A record that
 * genuinely held `null` is therefore returned without that field; none of the
 * metric shapes here use null as a value, and the alternative -- a sentinel --
 * would cost a token on every cell to preserve a case that does not arise.
 */
export function decodeTable<T>(table: Table): T[] {
  return table.rows.map((row) => {
    const record: Record<string, unknown> = {};
    table.columns.forEach((path, index) => {
      const value = row[index];
      if (value === null || value === undefined) {
        return;
      }
      const segments = path.split(PATH_SEPARATOR);
      let target = record;
      for (const segment of segments.slice(0, -1)) {
        const next = target[segment];
        if (isPlainObject(next)) {
          target = next;
        } else {
          const created: Record<string, unknown> = {};
          target[segment] = created;
          target = created;
        }
      }
      const leaf = segments[segments.length - 1];
      if (leaf !== undefined) {
        target[leaf] = value;
      }
    });
    return record as T;
  });
}
