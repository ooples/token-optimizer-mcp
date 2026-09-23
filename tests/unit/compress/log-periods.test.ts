import { describe, expect, it } from '@jest/globals';
import { compressLogPeriods } from '../../../src/compress/log-periods.js';
// Independent reconstruction uses only the emitted text, never original input.
// The shared decoder rather than a local copy: it knows this marker already, and
// unlike a private expander it REFUSES an unrecognised one instead of passing it
// through as a line of text.
import { rehydrate } from '../../support/rehydrate.js';

const protectedLine = (line: string) => /ERROR|AssertionError/.test(line);

describe('exact periodic logs', () => {
  it.each([1, 2, 4, 5, 7, 8])(
    'restores period %i around rare events exactly',
    (period) => {
      const block = Array.from(
        { length: period },
        (_, i) => `2026-01-01T00:00:00Z INFO worker=${i} healthy  \r`
      );
      const rare =
        '2026-01-01T00:00:00Z ERROR correlation=unique failure=checksum\r';
      const input = [
        ...Array.from({ length: 13 }, () => block).flat(),
        rare,
        ...Array.from({ length: 11 }, () => block).flat(),
        '',
      ].join('\n');
      const result = compressLogPeriods(input, protectedLine)!;
      expect(result.lossless).toBe(true);
      expect(result.text.length).toBeLessThan(input.length / 2);
      expect(result.text).toContain(rare);
      expect(rehydrate(result.text)).toBe(input);
    }
  );

  it('leaves nonperiodic input and marker collisions alone', () => {
    expect(
      compressLogPeriods('INFO a\nINFO b\nINFO c\nINFO d', protectedLine)
    ).toBeNull();
    const input =
      'INFO long healthy heartbeat\n'.repeat(20) +
      '[... previous 1 log lines repeat 9 more times, verbatim and in order]';
    expect(compressLogPeriods(input, protectedLine)).toBeNull();
  });

  it('never folds repeated load-bearing lines or invents changing timestamps', () => {
    expect(
      compressLogPeriods('ERROR failed\n'.repeat(30), protectedLine)
    ).toBeNull();
    const input = Array.from(
      { length: 30 },
      (_, i) =>
        `2026-01-01T00:00:${String(i).padStart(2, '0')}Z INFO same event`
    ).join('\n');
    expect(compressLogPeriods(input, protectedLine)).toBeNull();
  });
});
