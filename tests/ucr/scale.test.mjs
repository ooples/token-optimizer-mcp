import { describe, expect, test } from '@jest/globals';
import {
  StreamingGraphProjection,
  benchmarkGraphProjection,
  syntheticScaleEvent,
} from '../../ucr/index.mjs';

describe('streaming graph projection', () => {
  test('accepts every unique write, rejects duplicates, and reports no orphans', () => {
    const projection = new StreamingGraphProjection();
    const first = syntheticScaleEvent(0, { objectCount: 2 });
    const second = syntheticScaleEvent(1, { objectCount: 2 });
    expect(projection.apply(first)).toBe(true);
    expect(projection.apply(first)).toBe(false);
    expect(projection.apply(second)).toBe(true);
    expect(projection.finish()).toMatchObject({
      acceptedEvents: 2,
      duplicates: 1,
      objects: 2,
      orphaned: 0,
      diagnostics: [],
    });
  });

  test('runs a bounded scale gate without substituting it for live evidence', () => {
    expect(
      benchmarkGraphProjection({
        eventCount: 1000,
        objectCount: 16,
        maximumMs: 10_000,
      })
    ).toMatchObject({
      passed: true,
      eventCount: 1000,
      projection: { acceptedEvents: 1000, objects: 16, orphaned: 0 },
    });
  });
});
