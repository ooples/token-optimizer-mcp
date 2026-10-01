import { describe, it, expect } from '@jest/globals';

import {
  BAR_CHART_WIDTH,
  EXPORT_FORMATS,
  SPARK_LEVELS,
  SPARK_LEVEL_COUNT,
  asRows,
  barChart,
  columnsOf,
  csvField,
  isExportFormat,
  markdownCell,
  renderPayload,
  sparkline,
} from '../../../src/tools/intelligence/render-core.js';

/**
 * Known-answer tests: every expectation here is the exact string or array the
 * input produces, written out in full.
 *
 * WHY THAT MATTERS HERE: this file exists because five tools publish an
 * `export` and three a `visualize`, and the thing being replaced returned
 * `success: true` with a hard-coded confidence and no output at all. A test
 * asserting "renders something" would pass against that. So each case pins the
 * characters, including the escaping, and each refusal pins the text that names
 * what the caller has to change.
 */

describe('render-core formats', () => {
  it('offers exactly the three table formats', () => {
    expect([...EXPORT_FORMATS]).toEqual(['markdown', 'json', 'csv']);
    for (const format of EXPORT_FORMATS)
      expect(isExportFormat(format)).toBe(true);
    expect(isExportFormat('yaml')).toBe(false);
    expect(isExportFormat(1)).toBe(false);
  });
});

describe('render-core cell escaping', () => {
  it('escapes a pipe so a value cannot forge a markdown column', () => {
    expect(markdownCell('a|b')).toBe('a\\|b');
    expect(markdownCell('one\ntwo')).toBe('one two');
    expect(markdownCell('one\r\ntwo')).toBe('one two');
    expect(markdownCell(undefined)).toBe('');
    expect(markdownCell(0)).toBe('0');
  });

  it('quotes a csv field per rfc 4180 and doubles an inner quote', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('with,comma')).toBe('"with,comma"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField(null)).toBe('');
  });
});

describe('render-core table reading', () => {
  it('takes the union of keys in first-seen order', () => {
    expect(
      columnsOf([
        { b: 1, a: 2 },
        { c: 3, a: 4 },
      ])
    ).toEqual(['b', 'a', 'c']);
  });

  it('reads a lone object as one row and an array of objects as many', () => {
    expect(asRows({ a: 1 })).toEqual([{ a: 1 }]);
    expect(asRows([{ a: 1 }, { a: 2 }])).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('refuses anything that is not a table, including an empty array', () => {
    /*
     * An empty array is undefined rather than zero rows on purpose: a caller
     * who asked for csv and got a bare header back has been handed a file that
     * looks like a measurement of nothing. The refusal says what to send.
     */
    expect(asRows([])).toBeUndefined();
    expect(asRows([1, 2])).toBeUndefined();
    expect(asRows([{ a: 1 }, 2])).toBeUndefined();
    expect(asRows('text')).toBeUndefined();
    expect(asRows(null)).toBeUndefined();
  });
});

describe('render-core renderPayload', () => {
  const TABLE = [
    { term: 'cache', count: 2 },
    { term: 'with,comma', count: 1 },
  ];

  it('writes csv with a header row and escaped fields', () => {
    expect(renderPayload('t', TABLE, 'csv')).toEqual({
      format: 'csv',
      content: 'term,count\ncache,2\n"with,comma",1',
      rows: 2,
    });
  });

  it('writes markdown with a separator row and escaped cells', () => {
    expect(renderPayload('t', [{ term: 'a|b' }], 'markdown')).toEqual({
      format: 'markdown',
      content: '| term |\n| --- |\n| a\\|b |',
      rows: 1,
    });
  });

  it('fills a missing key with an empty cell rather than dropping the column', () => {
    expect(renderPayload('t', [{ a: 1, b: 2 }, { a: 3 }], 'csv').content).toBe(
      'a,b\n1,2\n3,'
    );
  });

  it('writes json for a payload that is not a table at all', () => {
    const rendered = renderPayload('t', [1, 2], 'json');
    expect(rendered.content).toBe('[\n  1,\n  2\n]');
    // Not a table, so there are no rows to report -- not one row of nothing.
    expect(rendered.rows).toBe(0);
  });

  it('counts the rows a json payload does have', () => {
    expect(renderPayload('t', TABLE, 'json').rows).toBe(2);
  });

  it('names the tool and the format it could not produce', () => {
    expect(() => renderPayload('pattern-recognition', 'text', 'csv')).toThrow(
      'pattern-recognition export: `csv` needs `payload` to be an object or a non-empty array of objects'
    );
    expect(() => renderPayload('t', [], 'markdown')).toThrow(
      /`markdown` needs `payload`/
    );
  });

  it('refuses a table whose rows carry no fields', () => {
    expect(() => renderPayload('t', {}, 'csv')).toThrow(
      't export: `payload` has no fields to write'
    );
  });
});

describe('render-core sparkline', () => {
  it('spreads a rising series across all eight levels', () => {
    const values = [0, 1, 2, 3, 4, 5, 6, 7];
    expect(sparkline(values)).toBe(SPARK_LEVELS);
    expect(SPARK_LEVELS).toHaveLength(SPARK_LEVEL_COUNT);
  });

  it('puts the minimum lowest and the maximum highest', () => {
    const line = sparkline([5, 1, 9]);
    expect(line).toHaveLength(3);
    expect(line[0]).toBe(SPARK_LEVELS[Math.floor((4 / 8) * 8)]);
    expect(line[1]).toBe(SPARK_LEVELS[0]);
    expect(line[2]).toBe(SPARK_LEVELS[SPARK_LEVEL_COUNT - 1]);
  });

  it('draws a flat series at the lowest level, not the middle', () => {
    /*
     * There is no way to place a constant on a scale derived from itself. The
     * middle level would read as "about average" for data with no average to be
     * about -- a shape the caller did not supply, which is this file's defect
     * class in miniature.
     */
    expect(sparkline([3, 3, 3])).toBe(SPARK_LEVELS[0].repeat(3));
    expect(sparkline([0])).toBe(SPARK_LEVELS[0]);
  });

  it('handles negatives by scaling between the series own bounds', () => {
    expect(sparkline([-2, 0, 2])).toBe(
      `${SPARK_LEVELS[0]}${SPARK_LEVELS[4]}${SPARK_LEVELS[7]}`
    );
  });

  it('refuses an empty series and a non-finite value', () => {
    expect(() => sparkline([])).toThrow('sparkline needs at least one value');
    expect(() => sparkline([1, Number.NaN])).toThrow(
      'sparkline needs finite values; received NaN'
    );
    expect(() => sparkline([1, Number.POSITIVE_INFINITY])).toThrow(
      /finite values/
    );
  });
});

describe('render-core barChart', () => {
  it('scales the longest bar to the width and labels every row', () => {
    expect(barChart([{ label: 'a', value: 10 }], 4)).toBe('a | #### 10');
  });

  it('pads labels to one column and rounds the shorter bars', () => {
    expect(
      barChart(
        [
          { label: 'long', value: 4 },
          { label: 'x', value: 1 },
        ],
        4
      )
    ).toBe('long | #### 4\nx    | # 1');
  });

  it('shares one scale across positive and negative values', () => {
    /*
     * Scaled on the largest ABSOLUTE value, so -4 and 4 draw the same length
     * and the sign shows in the glyph. Scaling each sign separately would make
     * a small negative look as big as the largest positive.
     */
    expect(
      barChart(
        [
          { label: 'up', value: 4 },
          { label: 'dn', value: -4 },
          { label: 'sm', value: -1 },
        ],
        4
      )
    ).toBe('up | #### 4\ndn | ---- -4\nsm | - -1');
  });

  it('draws no bar at all when every value is zero', () => {
    // A peak of zero has no scale; inventing one would draw a chart of nothing.
    expect(
      barChart(
        [
          { label: 'a', value: 0 },
          { label: 'b', value: 0 },
        ],
        4
      )
    ).toBe('a |  0\nb |  0');
  });

  it('defaults to the published width', () => {
    expect(BAR_CHART_WIDTH).toBe(40);
    expect(barChart([{ label: 'a', value: 1 }])).toBe(
      `a | ${'#'.repeat(BAR_CHART_WIDTH)} 1`
    );
  });

  it('refuses no rows, a bad width and a non-finite value', () => {
    expect(() => barChart([])).toThrow('barChart needs at least one row');
    expect(() => barChart([{ label: 'a', value: 1 }], 0)).toThrow(
      'barChart needs a width of at least 1; received 0'
    );
    expect(() => barChart([{ label: 'a', value: 1 }], 1.5)).toThrow(
      /width of at least 1/
    );
    expect(() => barChart([{ label: 'a', value: Number.NaN }])).toThrow(
      'barChart needs finite values; a is NaN'
    );
  });
});
