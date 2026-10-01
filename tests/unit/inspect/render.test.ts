/**
 * What `token-optimizer-inspect` prints.
 *
 * THE UNIT LABELS ARE THE POINT OF HALF OF THESE. `beforeBytes` is bytes and
 * `injectedChars` is UTF-16 code units, and the first draft of the renderer
 * printed both as `KB`. For the ASCII-dominant JSON a model request mostly is,
 * that reads correctly and is still a wrong label -- so there is a test here
 * whose whole job is that a character count never carries a byte unit.
 */

import { describe, it, expect } from '@jest/globals';
import {
  COLUMNS,
  detailFor,
  formatBytes,
  formatChars,
  formatCount,
  formatDelta,
  formatTime,
  notesFor,
  renderTransformations,
  totalsFor,
} from '../../../src/inspect/render.js';
import type { AccountingRecord } from '../../../src/proxy/accounting.js';

function record(over: Partial<AccountingRecord> = {}): AccountingRecord {
  return {
    ts: '2026-10-01T12:34:56.000Z',
    path: '/v1/messages',
    status: 200,
    compressed: true,
    beforeBytes: 400_000,
    afterBytes: 100_000,
    elisions: 12,
    usage: { input_tokens: 2413, cache_read_input_tokens: 115_002, output_tokens: 806 },
    ...over,
  };
}

describe('formatting', () => {
  it('keeps small byte counts exact and scales the large ones', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('refuses a byte count that is not one', () => {
    expect(formatBytes(-1)).toBe('-');
    expect(formatBytes(Number.NaN)).toBe('-');
    // The control: a real count still renders.
    expect(formatBytes(2048)).toBe('2.0 KB');
  });

  it('names characters as characters, never as bytes', () => {
    expect(formatChars(1927)).toBe('1,927 chars');
    expect(formatChars(41_000)).toBe('41.0k chars');
    expect(formatChars(41_000)).not.toContain('KB');
    expect(formatChars(41_000)).not.toContain('B');
  });

  it('separates thousands, and says so when there is no number', () => {
    expect(formatCount(115_002)).toBe('115,002');
    expect(formatCount(undefined)).toBe('-');
    expect(formatCount(Number.NaN)).toBe('-');
  });

  it('signs the change from the request point of view', () => {
    expect(formatDelta(1000, 250)).toBe('-75.0%');
    // A request the knowledge block made bigger reads as bigger.
    expect(formatDelta(1000, 1200)).toBe('+20.0%');
    expect(formatDelta(1000, 1000)).toBe('0.0%');
    expect(formatDelta(0, 10)).toBe('-');
  });

  it('prints a clock time, and refuses a timestamp it cannot read', () => {
    expect(formatTime('2026-10-01T12:34:56.000Z')).toMatch(/^\d\d:\d\d:56$/);
    expect(formatTime('not a date')).toBe('-');
  });
});

describe('the notes column', () => {
  it('names the refusal when nothing was compressed', () => {
    const notes = notesFor(record({ compressed: false, reason: 'below-threshold', elisions: 0 }));
    expect(notes).toBe('not compressed: below-threshold');
  });

  it('still says so when a refusal carried no reason', () => {
    expect(notesFor(record({ compressed: false, reason: undefined }))).toBe('not compressed');
  });

  it('prefers the transport error, because there was no transformation to report', () => {
    const notes = notesFor(record({ transportError: 'ECONNRESET', elisions: 99 }));
    expect(notes).toBe('no response: ECONNRESET');
    expect(notes).not.toContain('99');
  });

  it('lists only what fired', () => {
    const notes = notesFor(
      record({ elisions: 121, deferredTools: 31, deferredToolChars: 41_000, injectedChars: 1927 })
    );
    expect(notes).toContain('121 elisions');
    expect(notes).toContain('31 tools deferred (41.0k chars)');
    // Signed, because this is the one item that makes a request bigger.
    expect(notes).toContain('+1,927 chars knowledge');
  });

  it('omits the zeroes rather than stacking them', () => {
    const notes = notesFor(
      record({ elisions: 5, deferredTools: 0, injectedChars: 0, dedupReferences: 0 })
    );
    expect(notes).toBe('5 elisions');
  });

  it('says it compressed even when every line item is zero', () => {
    expect(notesFor(record({ elisions: 0 }))).toBe('compressed');
  });
});

describe('totals', () => {
  it('counts the skipped requests in the denominator', () => {
    // A ratio taken only over the compressed requests would read -75.0% here
    // and flatter the compressor: half of these bytes were never touched.
    const totals = totalsFor([
      record({ beforeBytes: 1000, afterBytes: 250 }),
      record({ compressed: false, beforeBytes: 1000, afterBytes: 1000 }),
    ]);
    expect(totals.requests).toBe(2);
    expect(totals.compressed).toBe(1);
    expect(formatDelta(totals.beforeBytes, totals.afterBytes)).toBe('-37.5%');
  });

  it('reads either provider spelling of a cache read, never both', () => {
    const anthropic = totalsFor([record({ usage: { cache_read_input_tokens: 10 } })]);
    const responses = totalsFor([record({ usage: { cached_input_tokens: 7 } })]);
    expect(anthropic.cachedTokens).toBe(10);
    expect(responses.cachedTokens).toBe(7);
    // Both present is Anthropic's shape with a Responses field alongside it;
    // adding them would double-count the same tokens.
    const both = totalsFor([
      record({ usage: { cache_read_input_tokens: 10, cached_input_tokens: 10 } }),
    ]);
    expect(both.cachedTokens).toBe(10);
  });

  it('treats missing usage as unknown, not as zero cost' , () => {
    const totals = totalsFor([record({ usage: {} })]);
    expect(totals.inputTokens).toBe(0);
    // The control: the bytes are still counted, so the row is not discarded.
    expect(totals.beforeBytes).toBe(400_000);
  });

  it('sums an empty window to an empty window', () => {
    expect(totalsFor([])).toEqual({
      requests: 0,
      compressed: 0,
      beforeBytes: 0,
      afterBytes: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
    });
  });
});

describe('the table', () => {
  it('says there is nothing rather than printing a bare header', () => {
    expect(renderTransformations([])).toEqual(['no transformations recorded']);
  });

  it('heads every column it lays out', () => {
    const [header] = renderTransformations([record()]);
    for (const column of COLUMNS) expect(header).toContain(column);
  });

  it('aligns the numeric columns so two rows can be compared', () => {
    const lines = renderTransformations([
      record({ beforeBytes: 400_000 }),
      record({ beforeBytes: 900 }),
    ]);
    const header = lines[0];
    const at = header.indexOf('before') + 'before'.length;
    // Right-aligned means both values end at the same column.
    expect(lines[1][at - 1]).not.toBe(' ');
    expect(lines[2][at - 1]).not.toBe(' ');
  });

  it('shows the newest rows the caller was given, in the order given', () => {
    const lines = renderTransformations([
      record({ ts: '2026-10-01T12:00:01.000Z', path: '/first' }),
      record({ ts: '2026-10-01T12:00:02.000Z', path: '/second' }),
    ]);
    expect(lines[1]).toContain('/first');
    expect(lines[2]).toContain('/second');
  });

  it('keeps the summary out of the rows, where a parser would read it as one', () => {
    const lines = renderTransformations([record()]);
    expect(lines[lines.length - 3]).toBe('');
    expect(lines[lines.length - 2]).toContain('1 request, 1 compressed');
    expect(lines[lines.length - 1]).toContain('billed 2,413 input');
  });

  it('adds the detail block only when asked', () => {
    const plain = renderTransformations([record({ systemChars: 3200 })]);
    const full = renderTransformations([record({ systemChars: 3200 })], { full: true });
    expect(plain.some((line) => line.includes('3,200 chars'))).toBe(false);
    expect(full.some((line) => line.includes('3,200 chars'))).toBe(true);
  });

  it('never pads the last column, which would trail whitespace on every line', () => {
    for (const line of renderTransformations([record(), record({ path: '/v1/messages/longer' })]))
      expect(line).toBe(line.trimEnd());
  });
});

describe('the detail block', () => {
  it('omits a field the record does not carry', () => {
    const detail = detailFor(record());
    expect(detail.some((line) => line.includes('system'))).toBe(false);
    // The control: the one field every record carries is always there.
    expect(detail.some((line) => line.includes('request bytes'))).toBe(true);
  });

  it('names the tool split, which is the field no column has room for', () => {
    const detail = detailFor(
      record({ toolsChars: 52_000, toolCount: 48, coreToolChars: 21_000, mcpToolChars: 31_000 })
    ).join(' ');
    expect(detail).toContain('52.0k chars in 48 tools');
    expect(detail).toContain('core 21.0k chars');
    expect(detail).toContain('mcp 31.0k chars');
  });

  it('reports both durations, because a slow turn is the other question asked here', () => {
    const detail = detailFor(
      record({ timing: { transformMs: 12.4, upstreamMs: 1832 } })
    ).join(' ');
    expect(detail).toContain('transform 12.4 ms');
    expect(detail).toContain('upstream 1832 ms');
  });
});
