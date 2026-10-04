/**
 * The columnar encoding has to be exactly reversible, because the saving is
 * only real if nothing was dropped to get it.
 *
 * smart_complexity now answers with a Table instead of an array of objects --
 * the field names sent once in a header rather than re-labelled on all 13
 * functions of a file. That is only a densification, and not a loss, if
 * decodeTable() rebuilds what encodeTable() was handed. These tests pin the
 * round trip, the two edges where an inverse is easy to get wrong (a field
 * missing from one record, and a nested field), and the input the encoder
 * refuses rather than silently mangles.
 */

import { encodeTable, decodeTable, type Table } from '../../../src/tools/shared/table.js';

describe('encodeTable / decodeTable', () => {
  it('round-trips uniform records', () => {
    const records = [
      { name: 'parse', lines: 12, nested: false },
      { name: 'render', lines: 41, nested: true },
    ];

    const table = encodeTable(records);

    expect(table.columns).toEqual(['name', 'lines', 'nested']);
    expect(table.rows).toEqual([
      ['parse', 12, false],
      ['render', 41, true],
    ]);
    expect(decodeTable(table)).toEqual(records);
  });

  it('sends each field name once however many records there are', () => {
    const records = Array.from({ length: 13 }, (_, index) => ({
      maintainabilityIndex: index,
      distinctOperators: index * 2,
    }));

    const table = encodeTable(records);

    // The point of the encoding: the header is independent of the row count.
    expect(table.columns).toEqual(['maintainabilityIndex', 'distinctOperators']);
    expect(table.rows).toHaveLength(13);
    expect(JSON.stringify(table).match(/maintainabilityIndex/g)).toHaveLength(1);
    expect(decodeTable(table)).toEqual(records);
  });

  it('round-trips nested fields through dotted columns', () => {
    const records = [
      { name: 'parse', complexity: { cyclomatic: 4, halstead: { volume: 88.71 } } },
    ];

    const table = encodeTable(records);

    expect(table.columns).toEqual([
      'name',
      'complexity.cyclomatic',
      'complexity.halstead.volume',
    ]);
    expect(decodeTable(table)).toEqual(records);
  });

  it('treats a field missing from one record as absent on the way back', () => {
    const records = [{ name: 'parse', note: 'recursive' }, { name: 'render' }];

    const table = encodeTable(records);

    expect(table.columns).toEqual(['name', 'note']);
    expect(table.rows[1]).toEqual(['render', null]);

    const decoded = decodeTable<Record<string, unknown>>(table);
    expect(decoded).toEqual(records);
    // Absent, not present-and-null: the inverse of what the encoder wrote.
    expect('note' in decoded[1]).toBe(false);
  });

  it('keeps arrays whole rather than flattening them into columns', () => {
    const records = [{ name: 'parse', params: ['source', 'options'] }];

    const table = encodeTable(records);

    expect(table.columns).toEqual(['name', 'params']);
    expect(decodeTable(table)).toEqual(records);
  });

  it('produces one row per record even for a record with no fields', () => {
    const table = encodeTable([{ name: 'parse' }, {}]);

    expect(table.rows).toHaveLength(2);
    expect(decodeTable(table)).toEqual([{ name: 'parse' }, {}]);
  });

  it('refuses a field name holding the path separator instead of mangling it', () => {
    // Encoding it would decode as two levels of nesting, so the round trip
    // would quietly return something other than the input.
    expect(() => encodeTable([{ 'complexity.cyclomatic': 4 }])).toThrow(
      /path separator/
    );
  });

  it('decodes an empty table to no records', () => {
    const empty: Table = { columns: [], rows: [] };

    expect(decodeTable(empty)).toEqual([]);
  });
});
