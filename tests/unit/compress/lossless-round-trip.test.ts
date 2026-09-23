import { describe, it, expect } from '@jest/globals';
import { compressBlock } from '../../../src/compress/router.js';
import { expandLog } from '../../helpers/expand-log.js';

/**
 * THE GATE ON `lossless: true`, held to its word by reconstruction.
 *
 * WHY THIS REPLACES A NEEDLE-RETENTION GATE RATHER THAN JOINING IT. The
 * obvious accuracy check -- plant a fact that occurs exactly once and assert
 * the compressed text still `includes()` it -- is wrong twice over here.
 *
 * The ORACLE is wrong. On varied log lines the engine emits a template plus a
 * value list, so `probe 77` becomes
 *
 *   ...probe # completed  [90 occurrences, positions=[1..90]; # = ... 77 ...]
 *
 * The literal substring is absent while the information is completely
 * present. Measured on nine shapes, a substring oracle reports healthy
 * compression -- 54.6% here -- as catastrophic data loss.
 *
 * The THRESHOLD is also wrong. `compressBlock`'s lossless path does not drop
 * unrecoverable information by construction, so "the needle survived" is a
 * restatement of the contract rather than a measurement of it, and it reads
 * as coverage while proving nothing about the encoding.
 *
 * WHAT IS ACTUALLY GATEABLE IS THE FLAG. `lossless: true` claims every dropped
 * byte is recoverable FROM THE OUTPUT ALONE -- no file, no spill, no lookup.
 * That is falsifiable: rebuild the input from the compressed text and compare.
 *
 * THE DECODER IS `expandLog`, NOT A LOCAL ONE. It already reads only the
 * emitted markers and already covers a format this file does not generate --
 * the periodic repeat -- so a second inverter here would be one more copy to
 * drift. What this file adds is the ROUTER-LEVEL claim: `log-order` exercises
 * `compressLog` directly, while a regression in engine selection or in the
 * registry boundary only shows through `compressBlock`.
 *
 * AND THE ORACLE IS ITSELF GATED. A decoder that is too forgiving passes
 * everything and is indistinguishable from no gate at all -- the failure mode
 * the needle check had. So every fixture also damages its own compressed
 * output in a way that destroys information, and the run fails if `expandLog`
 * still reproduces the input. The discrimination is re-proved on every run
 * rather than asserted once in a comment.
 */

const stamp = (i: number) =>
  `2026-09-21T10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`;

const FIXTURES: Array<{ name: string; text: string }> = [
  {
    // One message repeated under a moving clock: the run fold has to list the
    // stamps to stay lossless, and that listing is what gets reconstructed.
    name: 'adjacent duplicates under a moving clock',
    text: Array.from(
      { length: 80 },
      (_, i) => `${stamp(i)} INFO scheduler heartbeat acknowledged by peer`
    ).join('\n'),
  },
  {
    // Lines differing only in their numbers: the templating path, and the one
    // a substring oracle misreads as data loss.
    name: 'lines differing only in their numbers',
    text: Array.from(
      { length: 90 },
      (_, i) =>
        `${stamp(i)} INFO scheduler probe ${i} completed in ${i * 3} ms with status 200`
    ).join('\n'),
  },
  {
    // The same warning scattered between other lines: consecutive-only folding
    // sees none of it, so this exercises foldScattered's line-number list.
    name: 'duplicates scattered between other lines',
    text: Array.from({ length: 90 }, (_, i) =>
      i % 3 === 0
        ? `${stamp(i)} WARN peer dependency resolution skipped`
        : `${stamp(i)} INFO worker ${i} handled request ${i + 5000}`
    ).join('\n'),
  },
];

describe('lossless results reconstruct their input from the output alone', () => {
  it.each(FIXTURES)('$name', ({ text }) => {
    const result = compressBlock(text);

    // A gate over an inert engine measures nothing -- this is the trap that
    // made squad-eval report 1.000 accuracy at 0.0% reduction.
    expect(result.text.length).toBeLessThan(text.length);
    expect(result.lossless).toBe(true);
    expect(expandLog(result.text)).toBe(text);
  });

  it.each(FIXTURES)('$name -- a damaged output is rejected', ({ text }) => {
    const compressed = compressBlock(text).text;
    const damaged = [
      // Drop a value from a template row: the count no longer matches.
      compressed.replace(/; # = (\S+)/, '; # ='),
      // Drop one occurrence's worth of positions.
      compressed.replace(/positions=\[(\d+),/, 'positions=['),
      // Shorten a stamp list.
      compressed.replace(/"copies":\["([^"]*)",/, '"copies":['),
      // Shorten a scattered-copy list.
      compressed.replace(
        /"copiesAtLines":\[\[(\d+),"([^"]*)"\],/,
        '"copiesAtLines":[['
      ),
      // Truncate the output.
      compressed.slice(0, Math.floor(compressed.length * 0.8)),
    ].filter((candidate) => candidate !== compressed);

    // If no mutation applied, the oracle was never exercised and the test is
    // vacuous -- which is the defect this whole file exists to avoid.
    expect(damaged.length).toBeGreaterThan(0);

    for (const candidate of damaged) {
      let rebuilt: string | null = null;
      try {
        rebuilt = expandLog(candidate);
      } catch {
        rebuilt = null;
      }
      expect(rebuilt).not.toBe(text);
    }
  });
});
