/**
 * The ring that lets `token-optimizer-inspect` answer without configuration.
 *
 * WHAT THESE PIN. The eviction arithmetic, and -- more importantly -- that
 * `recent(n)` returns the LAST n rather than the first n. A ring read from the
 * wrong end still returns the right COUNT of records, so a test that only
 * counts them passes while the diagnostic shows the oldest requests in the
 * window, which is the opposite of what it was asked for.
 */

import { describe, it, expect } from '@jest/globals';
import {
  createTransformationLog,
  TRANSFORMATION_CAPACITY,
} from '../../../src/proxy/transformations.js';
import type { AccountingRecord } from '../../../src/proxy/accounting.js';

function record(index: number): AccountingRecord {
  return {
    ts: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    path: `/v1/messages?n=${index}`,
    status: 200,
    compressed: true,
    beforeBytes: 1000 + index,
    afterBytes: 500,
    usage: { input_tokens: index },
  };
}

const indexOf = (entry: AccountingRecord): number =>
  Number(entry.path.split('=')[1]);

describe('the transformation ring', () => {
  it('starts empty, and says so rather than inventing a window', () => {
    const log = createTransformationLog(4);
    expect(log.size()).toBe(0);
    expect(log.dropped()).toBe(0);
    expect(log.recent()).toEqual([]);
  });

  it('holds what fits, oldest first', () => {
    const log = createTransformationLog(4);
    for (let i = 0; i < 3; i++) log.record(record(i));
    expect(log.size()).toBe(3);
    expect(log.dropped()).toBe(0);
    expect(log.recent().map(indexOf)).toEqual([0, 1, 2]);
  });

  it('evicts the oldest once full, and counts the evictions', () => {
    const log = createTransformationLog(4);
    for (let i = 0; i < 7; i++) log.record(record(i));
    expect(log.size()).toBe(4);
    expect(log.dropped()).toBe(3);
    expect(log.recent().map(indexOf)).toEqual([3, 4, 5, 6]);
  });

  it('returns the LAST n for a limit smaller than the window', () => {
    const log = createTransformationLog(8);
    for (let i = 0; i < 8; i++) log.record(record(i));
    // The positive control for the direction: reading from the wrong end would
    // give [0, 1] here and still be two records long.
    expect(log.recent(2).map(indexOf)).toEqual([6, 7]);
    expect(log.recent(1).map(indexOf)).toEqual([7]);
  });

  it('reads correctly across the wrap point', () => {
    // Nine writes into a window of four is two wraps plus one, so `head` has
    // passed zero twice and the newest record sits at index 0.
    const log = createTransformationLog(4);
    for (let i = 0; i < 9; i++) log.record(record(i));
    expect(log.recent(3).map(indexOf)).toEqual([6, 7, 8]);
    expect(log.recent().map(indexOf)).toEqual([5, 6, 7, 8]);
  });

  it('clamps a limit larger than the window to what it holds', () => {
    const log = createTransformationLog(4);
    log.record(record(0));
    expect(log.recent(100).map(indexOf)).toEqual([0]);
  });

  it('treats a zero or negative limit as asking for nothing', () => {
    const log = createTransformationLog(4);
    log.record(record(0));
    expect(log.recent(0)).toEqual([]);
    expect(log.recent(-5)).toEqual([]);
    // The control: the record really is there to be returned.
    expect(log.recent(1)).toHaveLength(1);
  });

  it('refuses a capacity of zero rather than dropping every record', () => {
    const log = createTransformationLog(0);
    log.record(record(0));
    expect(log.size()).toBe(1);
    expect(log.recent().map(indexOf)).toEqual([0]);
  });

  it('defaults to a capacity large enough to outlive a few turns', () => {
    expect(TRANSFORMATION_CAPACITY).toBeGreaterThanOrEqual(32);
    const log = createTransformationLog();
    for (let i = 0; i < TRANSFORMATION_CAPACITY; i++) log.record(record(i));
    expect(log.dropped()).toBe(0);
    expect(log.size()).toBe(TRANSFORMATION_CAPACITY);
  });

  it('writes a late token count onto the record it belongs to', () => {
    const log = createTransformationLog(4);
    const attach = log.record(record(0));
    log.record(record(1));

    // The control: before the count lands the record is in the window and
    // carries no token figures at all, which is what makes the amendment
    // visible rather than assumed.
    expect(log.recent()[0].tokens).toBeUndefined();

    attach({
      measured: true,
      beforeTokens: 900,
      afterTokens: 300,
      method: 'test-encoder',
    });

    expect(log.recent()[0].tokens).toEqual({
      measured: true,
      beforeTokens: 900,
      afterTokens: 300,
      method: 'test-encoder',
    });
    // The neighbour is untouched: the handle addresses one record, not the ring.
    expect(log.recent()[1].tokens).toBeUndefined();
  });

  it('records a named refusal in place of a count, never a zero', () => {
    const log = createTransformationLog(2);
    const attach = log.record(record(0));

    attach({ measured: false, reason: 'queue-full' });

    const only = log.recent()[0];
    expect(only.tokens).toEqual({ measured: false, reason: 'queue-full' });
    // A zero here would read as a request the proxy did not improve, so the
    // field must not be numeric when nothing was measured.
    expect(only.tokens).not.toHaveProperty('beforeTokens');
  });

  it('drops a count for a record the window has already evicted', () => {
    const log = createTransformationLog(2);
    const stale = log.record(record(0));
    const live = log.record(record(1));
    log.record(record(2));
    log.record(record(3));

    // Record 0 was evicted, and its slot now holds record 2. A late count must
    // not be written onto whatever request has since taken that position.
    stale({ measured: true, beforeTokens: 1, afterTokens: 1, method: 'x' });
    expect(log.recent().map(indexOf)).toEqual([2, 3]);
    expect(log.recent().every((r) => r.tokens === undefined)).toBe(true);

    // The control: a handle for a record still in the window does amend it, so
    // the test above is about eviction and not about the handle being inert.
    const current = log.record(record(4));
    current({ measured: true, beforeTokens: 7, afterTokens: 3, method: 'x' });
    expect(log.recent().find((r) => indexOf(r) === 4)?.tokens).toEqual({
      measured: true,
      beforeTokens: 7,
      afterTokens: 3,
      method: 'x',
    });
    expect(live).toBeInstanceOf(Function);
  });

  it('hands out a frozen view, so a reader cannot edit the window', () => {
    const log = createTransformationLog(4);
    log.record(record(0));
    const view = log.recent();
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(log)).toBe(true);
  });
});
