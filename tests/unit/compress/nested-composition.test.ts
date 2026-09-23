import { describe, it, expect } from '@jest/globals';
import { compressBlock } from '../../../src/compress/router.js';
import { DEFAULT_TUNING } from '../../../src/compress/options.js';
import { expandLog } from '../../helpers/expand-log.js';
import { expandJsonRecords } from '../../support/rehydrate.js';

/**
 * THE LAST TWO ENGINES CLAIMING `lossless` WITH NOTHING RECONSTRUCTING IT.
 *
 * `nested` is a COMPOSITION, which is what makes it worth its own gate. A tool
 * result is a JSON envelope whose `stdout` is a log, so the log engine runs
 * inside a JSON string value: the template lands escaped, between quotes, in a
 * document the JSON minifier has also touched. Two transforms over the same
 * bytes, and the losslessness of the whole is the AND of both -- precisely the
 * composition `registry.ts` warns about, where a document with a lossless half
 * and a lossy half must report lossy.
 *
 * Measured on a bash-shaped envelope: 7685 -> 4141, 46.1%, three elisions, all
 * lossless with no path -- `79 lines folded into a template`, `39 lines folded
 * into a template`, `3544 bytes of whitespace`. A large saving on the most
 * common shape a coding agent sees, and nothing checked that the log inside the
 * string could still be read back.
 *
 * `json-sections` is the simpler case: headed blocks of JSON in one document,
 * 3712 -> 2271 at 38.8%, with a single whitespace elision. Its gate is that the
 * headings survive and the row content is still there -- a boundary the engine
 * mangled would take content with it.
 */

const logLines = (n: number, seed: string) =>
  Array.from(
    { length: n },
    (_, i) =>
      `2026-09-21T10:00:${String(i % 60).padStart(2, '0')}Z INFO ${seed} ` +
      `worker ${i} handled request ${i + 5000}`
  ).join('\n');

describe('a log compressed inside a json string survives the round trip', () => {
  it('reconstructs stdout and stderr from the envelope alone', () => {
    const envelope = {
      tool: 'bash',
      exitCode: 0,
      stdout: logLines(80, 'alpha'),
      stderr: logLines(40, 'beta'),
    };
    const input = JSON.stringify(envelope, null, 2);

    const result = compressBlock(input, { tuning: DEFAULT_TUNING });

    // An inert engine passes every assertion below by doing nothing.
    expect(result.text.length).toBeLessThan(input.length * 0.7);
    expect(result.lossless).toBe(true);

    // The envelope must still BE an envelope. A transform that broke the
    // escaping would leave a document the caller cannot parse, and the saving
    // would be worthless however large.
    const parsed = JSON.parse(result.text) as Record<string, unknown>;
    expect(parsed.tool).toBe('bash');
    expect(parsed.exitCode).toBe(0);

    // And the log inside each string reads back exactly, from the string alone.
    expect(expandLog(String(parsed.stdout))).toBe(envelope.stdout);
    expect(expandLog(String(parsed.stderr))).toBe(envelope.stderr);
  });

  it('a damaged inner template is rejected', () => {
    const envelope = { tool: 'bash', stdout: logLines(80, 'alpha') };
    const input = JSON.stringify(envelope, null, 2);
    const parsed = JSON.parse(
      compressBlock(input, { tuning: DEFAULT_TUNING }).text
    ) as Record<string, unknown>;
    const compressed = String(parsed.stdout);

    const damaged = [
      compressed.replace(/; # = (\S+)/, '; # ='),
      compressed.replace(/positions=\[(\d+),/, 'positions=['),
    ].filter((candidate) => candidate !== compressed);
    expect(damaged).toHaveLength(2);

    for (const candidate of damaged) {
      let rebuilt: string | null = null;
      try {
        rebuilt = expandLog(candidate);
      } catch {
        rebuilt = null;
      }
      expect(rebuilt).not.toBe(envelope.stdout);
    }
  });
});

describe('a lossy inner string makes the whole document lossy', () => {
  it('does not report lossless when a nested string spilled', () => {
    // THE AND IS THE WHOLE GUARANTEE. registry.ts states it plainly: a
    // guarantee aggregated over parts combines with AND, and a part that does
    // not state its status must be treated as not guaranteeing it. Deleting
    // that one line in nested.ts left every other suite in this directory
    // green, so the composition was asserted nowhere.
    const paragraph = (i) =>
      `Section ${i}. The scheduler acquires a lease before dispatching work, ` +
      'and renews it on a fixed interval so a partitioned worker cannot keep ' +
      `processing after the coordinator moved on. Unique token alpha${i}beta.`;
    const envelope = {
      tool: 'read',
      contents: Array.from({ length: 40 }, (_, i) => paragraph(i)).join('\n\n'),
    };
    const input = JSON.stringify(envelope, null, 2);

    const spilled = [];
    const result = compressBlock(input, {
      tuning: DEFAULT_TUNING,
      spill: (content) => {
        spilled.push(content);
        return `/spill/${spilled.length}.txt`;
      },
    });

    // The inner prose must actually have spilled, or this proves nothing.
    expect(spilled.length).toBeGreaterThan(0);
    expect(result.text.length).toBeLessThan(input.length);

    // And the outer document must inherit that loss rather than paper over it.
    expect(result.lossless).toBe(false);
  });
});
describe('headed json sections keep their content', () => {
  it('every heading and every row survives the minification', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      id: `r-${i}`,
      v: i % 7,
      note: `obs ${i}`,
    }));
    const input = [
      '## config',
      JSON.stringify(
        { service: 'checkout', replicas: 3, flags: ['a', 'b'] },
        null,
        2
      ),
      '',
      '## rows',
      JSON.stringify(rows, null, 2),
      '',
      '## trailer',
      JSON.stringify({ done: true }, null, 2),
    ].join('\n');

    const result = compressBlock(input, { tuning: DEFAULT_TUNING });

    expect(result.text.length).toBeLessThan(input.length * 0.8);
    expect(result.lossless).toBe(true);

    // Headings are the section boundaries. Losing one merges two sections,
    // which reads as corruption rather than compression.
    for (const heading of ['## config', '## rows', '## trailer'])
      expect(result.text).toContain(heading);

    // THE CLAIM IS THAT ONLY WHITESPACE WENT, so every row must still be here.
    // Asserted on content rather than on layout: this transform is allowed to
    // reflow, and a shape assertion would fail for the wrong reason.
    //
    // READ THROUGH THE DECODER, NOT THE RAW TEXT. These rows are uniform, so
    // the records encoder states the shape once and supplies each row as
    // fragments -- `r-0` is "r-" in the template joined to a slot the run rule
    // generates, and it is not a substring of the output. A substring oracle
    // here reports a lossless encoding as data loss (#415).
    const rebuilt = expandJsonRecords(result.text);
    for (let i = 0; i < rows.length; i += 1) {
      expect(rebuilt).toContain(`r-${i}`);
      expect(rebuilt).toContain(`obs ${i}`);
    }
    expect(rebuilt).toContain('checkout');

    // And the engine really did something -- otherwise the loop above is
    // satisfied by an untouched document.
    expect(result.text).not.toBe(input);
    for (const elision of result.elisions) {
      expect(elision.lossless).toBe(true);
      expect(elision.recoverAt).toBeNull();
    }
  });
});
