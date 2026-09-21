import { describe, it, expect } from '@jest/globals';
import { compressBlock } from '../../../src/compress/router.js';

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
 *   ...probe # completed  [120 occurrences, positions=[1..120]; # = ... 77 ...]
 *
 * The literal substring is absent while the information is completely
 * present. Measured on nine shapes, a substring oracle reports healthy
 * compression -- 63.3% on varied logs -- as catastrophic data loss.
 *
 * The THRESHOLD is also wrong. `compressBlock`'s lossless path does not drop
 * unrecoverable information by construction, so "the needle survived" is a
 * restatement of the contract rather than a measurement of it, and it reads
 * as coverage while proving nothing about the encoding.
 *
 * WHAT IS ACTUALLY GATEABLE IS THE FLAG. `lossless: true` claims every dropped
 * byte is recoverable FROM THE OUTPUT ALONE -- no file, no spill, no lookup.
 * That is falsifiable: rebuild the input from the compressed text and compare.
 * `rehydrate` below reads only the emitted markers, so it fails the moment the
 * encoding stops describing what it removed, which is exactly the regression a
 * needle count cannot see.
 *
 * AND THE ORACLE IS ITSELF GATED. A reconstructor that is too forgiving passes
 * everything and is indistinguishable from no gate at all -- the failure mode
 * the needle check had. So every fixture also damages its own compressed
 * output in a way that destroys information, and the run fails if `rehydrate`
 * still reproduces the input. The discrimination is re-proved on every run
 * rather than asserted once in a comment.
 */

/** Adjacent run fold, stamps identical: `[... the same line, 37 more times]`. */
const RUN =
  /^\[\.\.\. the same line, (\d+) more times?(?: with prefix replacements (\{.*\}))?\]$/;

/** Scattered fold, which carries the line number of every removed copy. */
const SCATTER =
  /^\[\.\.\. the same line, \d+ more times? elsewhere; before scattered folding (\{.*\})\]$/;

/** Templated group: shape, two spaces, then occurrences, positions and values. */
const TEMPLATE =
  /^(.*?) {2}\[(\d+) occurrences?, positions=(\[[\d,]*\]); # = (.*)\]$/;

/** A marker naming a path is a LOSSY elision -- not this gate's business. */
const SPILLED = /^\[\.\.\. .* -> .+\]$/;

class NotRecoverable extends Error {}

/** Places lines that know their own index, then fills the gaps in order. */
function weave(placed: Map<number, string>, rest: string[]): string[] {
  const total = placed.size + rest.length;
  const out: string[] = [];
  let next = 0;
  for (let i = 0; i < total; i += 1) {
    const at = placed.get(i);
    if (at !== undefined) out.push(at);
    else if (next < rest.length) out.push(rest[next++]);
    else throw new NotRecoverable(`no line for index ${i}`);
  }
  if (next !== rest.length) throw new NotRecoverable('unplaced lines remain');
  return out;
}

/** Undoes `templated`: one rendered line becomes every occurrence it stood for. */
function unTemplate(lines: string[]): string[] {
  const placed = new Map<number, string>();
  const rest: string[] = [];
  for (const line of lines) {
    const m = TEMPLATE.exec(line);
    if (!m) {
      rest.push(line);
      continue;
    }
    const parts = m[1].split('#');
    const positions: number[] = JSON.parse(m[3]);
    const rows = m[4].split(' | ').map((row) => row.split(' '));
    if (rows.length !== positions.length || rows.length !== Number(m[2]))
      throw new NotRecoverable('occurrence count disagrees with the values');
    positions.forEach((position, k) => {
      const values = rows[k];
      if (values.length !== parts.length - 1)
        throw new NotRecoverable('a row does not fill the template');
      let rebuilt = parts[0];
      values.forEach((value, j) => {
        rebuilt += value + parts[j + 1];
      });
      placed.set(position - 1, rebuilt);
    });
  }
  return placed.size ? weave(placed, rest) : lines;
}

/** Undoes `foldScattered`: each removed copy goes back to the line it left. */
function unScatter(lines: string[]): string[] {
  const placed = new Map<number, string>();
  const rest: string[] = [];
  lines.forEach((line, index) => {
    const m = SCATTER.exec(line);
    if (!m) {
      rest.push(line);
      return;
    }
    const base = lines[index - 1];
    if (base === undefined) throw new NotRecoverable('marker with no line');
    const { firstPrefix, copiesAtLines } = JSON.parse(m[1]) as {
      firstPrefix: string;
      copiesAtLines: Array<[number, string]>;
    };
    if (!base.startsWith(firstPrefix))
      throw new NotRecoverable('marker prefix does not match its line');
    const body = base.slice(firstPrefix.length);
    for (const [at, stamp] of copiesAtLines) placed.set(at - 1, stamp + body);
  });
  return placed.size ? weave(placed, rest) : lines;
}

/** Undoes the adjacent run fold: the marker becomes the copies it replaced. */
function unRunFold(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const m = RUN.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const base = out[out.length - 1];
    if (base === undefined) throw new NotRecoverable('marker with no line');
    const dropped = Number(m[1]);
    if (!m[2]) {
      for (let k = 0; k < dropped; k += 1) out.push(base);
      continue;
    }
    const { firstPrefix, copies } = JSON.parse(m[2]) as {
      firstPrefix: string;
      copies: string[];
    };
    if (copies.length !== dropped)
      throw new NotRecoverable('stamp list disagrees with the count');
    if (!base.startsWith(firstPrefix))
      throw new NotRecoverable('marker prefix does not match its line');
    const body = base.slice(firstPrefix.length);
    for (const stamp of copies) out.push(stamp + body);
  }
  return out;
}

/**
 * Rebuilds the original from the compressed text and NOTHING ELSE.
 *
 * Inverted in the reverse of the order the engine applies them -- run fold,
 * then scattered fold, then templating -- because each later stage indexes
 * into the array the earlier one produced.
 */
function rehydrate(text: string): string {
  const lines = text.split('\n');
  for (const line of lines)
    if (SPILLED.test(line))
      throw new NotRecoverable('output refers to a spill');
  return unRunFold(unScatter(unTemplate(lines))).join('\n');
}

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
    expect(rehydrate(result.text)).toBe(text);
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
        rebuilt = rehydrate(candidate);
      } catch {
        rebuilt = null;
      }
      expect(rebuilt).not.toBe(text);
    }
  });
});
