import { describe, it, expect } from '@jest/globals';
import { compressLog } from '../../../src/compress/log.js';
import { expandLog } from '../../../src/compress/expand-log.js';

describe('lossless log order and whitespace', () => {
  it('does not wrap input that already resembles its template encoding', () => {
    const input =
      'INFO ready with a long repeated status\n'.repeat(20) +
      'INFO #  [4 occurrences, positions=[1,2,3,4]; # = 1 | 2 | 3 | 4]';
    expect(compressLog(input).text).toBe(input);
  });

  it('round-trips mixed runs, scattered copies and templates across generated sequences', () => {
    let seed = 74931;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let trial = 0; trial < 50; trial++) {
      const lines = Array.from({ length: 80 }, () => {
        const n = random();
        const prefix = ['', '12:00:00 ', '[12:00:01]  ', '  12:00:02 '][n % 4];
        const body =
          n % 5 === 0
            ? `ERROR operation ${n % 11} failed after retry ${n % 7} with a detailed explanation`
            : `INFO service ${n % 3} ready with a sufficiently detailed status`;
        return prefix + body + ['', '  ', '\r'][n % 3];
      });
      const input = lines.join('\n');
      const out = compressLog(input);
      expect(out.lossless).toBe(true);
      expect(expandLog(out.text)).toBe(input);
    }
  });
  it('restores scattered copies around events with identical timestamps', () => {
    const repeated =
      '12:00:00 INFO ready for requests with a healthy connection pool  ';
    const input = [
      repeated,
      '12:00:00 ERROR first',
      repeated,
      '12:00:00 ERROR second',
      repeated,
      '12:00:00 WARN unique',
      repeated,
      '',
    ].join('\n');
    const out = compressLog(input);
    expect(out.text).toContain('copiesAtLines');
    expect(out.lossless).toBe(true);
    expect(expandLog(out.text)).toBe(input);
  });

  it('restores interleaved templates in order and retains literal hashes', () => {
    const lines = Array.from({ length: 8 }, (_, i) => [
      `12:00:00 ERROR request ${i} failed with a sufficiently detailed message`,
      `12:00:00 ERROR unrelated reason ${i + 100} has another sufficiently detailed message`,
    ]).flat();
    lines.splice(
      5,
      0,
      '12:00:00 ERROR issue #123 must not acquire placeholder semantics'
    );
    const input = lines.join('\n');
    const out = compressLog(input);
    expect(out.text).toContain('gaps=');
    expect(out.text).toContain('issue #123');
    expect(expandLog(out.text)).toBe(input);
  });

  it('retains mixed timestamp presence and exact prefix/body whitespace', () => {
    const body = 'INFO ready with a detailed status about the connection pool';
    const input = [
      `  [12:00:00]  ${body}`,
      body,
      `12:00:01 ${body}`,
      `12:00:02 ${body}  `,
      `12:00:03 ${body}\r`,
    ].join('\n');
    const out = compressLog(input);
    expect(out.lossless).toBe(true);
    expect(expandLog(out.text)).toBe(input);
  });
});
