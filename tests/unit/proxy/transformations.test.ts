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

  it('hands out a frozen view, so a reader cannot edit the window', () => {
    const log = createTransformationLog(4);
    log.record(record(0));
    const view = log.recent();
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(log)).toBe(true);
  });
});
