/**
 * PROSE ELISION MUST NOT TOUCH CONTENT WHOSE LINES ARE THE UNIT OF MEANING.
 *
 * Issue #469, third sub-problem. A session read source through the compression
 * path, got comment lines elided out of the middle of a region, and built
 * exact-text edits from what came back. Every anchor missed, because the lines
 * it was anchored to had been removed from the view and not from the file.
 *
 * A comment block clears the wordiness bar that `looksLikeProse` tests -- a
 * dense run of `//` lines is wordier than most paragraphs -- so the engine
 * claimed it and dropped half its sentences, each of which was a whole line.
 */

import { describe, expect, it } from '@jest/globals';
import { compressProse, looksLikeProse } from '../../../src/compress/prose.js';

const PARAGRAPHS = [
  'The release waiter polls the registry until the published version resolves or the budget runs out.',
  'npm accepts a publish and then processes it asynchronously, which can take well over an hour.',
  'Raising the budget therefore cannot fix the failure, because no runner-held budget outlasts the queue.',
  'The waiter instead reports a pending publish separately from a broken one, and a scheduled job verifies the window.',
  // Wrapped across lines, as a paragraph in a document or a design note is.
].join('\n');

const COMMENT_BLOCK = `// THE BUNDLED INVENTORY IS ASSERTED ONLY FOR AN ACTUAL PLUGIN INSTALL.
//
// This used to run unconditionally, on the grounds that these entry points ship
// beside an MCP declaration for the same package. That holds for a plugin --
// .mcp.json travels with the hooks -- and not otherwise: the script path wires
// hooks through settings.json without the server, and a user can drop the
// server and keep the hooks, and the benchmark arm removes the mcp block.
process.env.TOKEN_OPTIMIZER_MCP_CAPABILITIES_BUNDLED ??= 'smart_read';`;

describe('prose elision declines line-oriented content', () => {
  it('still claims ordinary prose', () => {
    // THE POSITIVE CONTROL. Without it this file would pass just as happily if
    // the engine had been switched off altogether, which is the regression the
    // guard below could easily have caused.
    expect(looksLikeProse(PARAGRAPHS)).toBe(true);
  });

  it('declines a comment block that reads like prose by word count', () => {
    const lines = COMMENT_BLOCK.split('\n').filter((l) => l.trim());
    const wordy = lines.filter((l) => l.split(/\s+/).length > 8).length;
    // Stated rather than assumed: this fixture really does clear the wordiness
    // bar, so it is the guard and not the bar that declines it.
    expect(wordy / lines.length).toBeGreaterThan(0.5);
    expect(looksLikeProse(COMMENT_BLOCK)).toBe(false);
  });

  it('declines a numbered listing, where a dropped line breaks every number after it', () => {
    const listing = Array.from(
      { length: 12 },
      (_, index) =>
        `${index + 1}|  the adapter records the outcome of this call against the episode it belongs to`
    ).join('\n');
    expect(looksLikeProse(listing)).toBe(false);
  });

  it('declines a bulleted list, where a dropped bullet is a dropped step', () => {
    const steps = [
      '- list the review threads with the paginated GraphQL query and count the unresolved ones',
      '- cancel any in-progress run on the pull request while a thread is still unresolved',
      '- fix each thread in code, then reply and resolve it with the evidence that it is fixed',
      '- push, and only then let the full run proceed to completion',
    ].join('\n');
    expect(looksLikeProse(steps)).toBe(false);
  });

  it('claims prose that merely contains a line or two of structure', () => {
    // THE BOUNDARY. The rule is a majority of lines, not the presence of any,
    // so a passage that quotes one command stays compressible.
    const mixed = [
      'The waiter reports a pending publish separately from a broken one, which is the whole distinction.',
      '- npm run verify:published-launch -- --version 7.4.2 --pending-ok',
      'A pending-tolerant waiter is only safe while something else still verifies the release afterwards.',
      'The scheduled job covers a twenty-four hour window and files an issue when the latest version lags.',
    ].join('\n');
    expect(looksLikeProse(mixed)).toBe(true);
  });
});

describe('numbered lists are line-oriented however they are numbered', () => {
  // Review thread on #470: `1.` and `2.` prefixes did not match LINE_ORIENTED,
  // so a wordy numbered list still reached prose elision and could lose items.
  const numbered = (separator: string) =>
    Array.from(
      { length: 10 },
      (_, index) =>
        `${index + 1}${separator} the waiter reports a pending publish separately from a broken one`
    ).join('\n');

  it.each([['.'], [')'], ['|'], [':']])(
    'declines a list numbered with "%s"',
    (separator) => {
      expect(looksLikeProse(numbered(separator))).toBe(false);
    }
  );

  it('still claims prose whose lines open with a decimal measurement', () => {
    // THE BOUNDARY the trailing space buys. `3.5 ms` is a number, not an item
    // marker, so these lines stay compressible. They end as sentences do:
    // an unterminated line one per row is a record (#494), declined for that
    // reason, and this test is about the decimal, not about records.
    const readings = [
      '3.5 ms was the median transform time across three passes of the comparator.',
      '28.7 ms was their tenth percentile, which is the bar the latency rows compare against.',
      '0.4 ms is what the move-whole arm costs when the store is already warm.',
    ].join('\n');
    expect(looksLikeProse(readings)).toBe(true);
  });
});

/**
 * #494: a listing, one record per line, none of them ending in a period. The
 * engine claimed it as prose, ran sentences across line breaks, and dropped
 * them -- deleting a header line and joining one record's text onto another's.
 * Measured on a real 77-line issue listing: 14 output lines existed nowhere in
 * the input.
 */
const record = (n: number, title: string): string =>
  `#${n} [enhancement] upd=10-13 len=${n * 7} | ${title} || ` +
  `This issue tracks ${title.toLowerCase()} across every backend and records what remains open`;

const LISTING = [
  '=== AiDotNet.Tensors',
  record(368, 'BlasManaged perf sprint and supply-chain removal'),
  record(377, 'GPU BLAS supply-chain removal for cuBLAS and rocBLAS'),
  record(436, 'Close per-model gaps surfaced by the fair comparison'),
  '=== AiDotNet',
  record(293, 'Roadmap of the high-impact backlog and its tracking'),
  record(310, 'Comprehensive model hub ecosystem with pretrained weights'),
  record(425, 'Model metadata and license verification for the SDK'),
].join('\n');

const spill = (): string => '/spill/prose.txt';

describe('prose elision never joins or truncates records (#494)', () => {
  it('declines a one-record-per-line listing', () => {
    expect(looksLikeProse(LISTING)).toBe(false);
  });

  it('still claims hard-wrapped prose, whose breaks continue lowercase', () => {
    const wrapped = [
      'The release waiter polls the registry until the published version',
      'resolves or the budget runs out, and npm then processes the publish',
      'asynchronously, which can take well over an hour on a busy day.',
      'Raising the budget therefore cannot fix the failure, because no',
      'runner-held budget outlasts the queue that npm keeps on its side.',
    ].join('\n');
    expect(looksLikeProse(wrapped)).toBe(true);
  });

  it('never emits a line made of two input lines, even when forced', () => {
    // Called directly, past the gate, so the sentence splitter itself is what
    // is under test: every output line must be a run of sentences from ONE
    // input line, never the tail of one and the head of the next.
    const mixed = `${PARAGRAPHS}\n${LISTING}\n${PARAGRAPHS}`;
    const out = compressProse(mixed, { spill }).text;
    expect(out).not.toBe(mixed);
    const inputLines = mixed.split('\n');
    for (const line of out.split('\n')) {
      const body = line.replace(/\s*\[\.\.\..*$/, '');
      if (!body.trim()) continue;
      const pieces = body.split(/(?<=[.!?])\s+(?=[A-Z#=(`"'[])/);
      const home = inputLines.find((input) =>
        pieces.every((piece) => input.includes(piece.trim()))
      );
      expect({ line, home: home !== undefined }).toEqual({ line, home: true });
    }
  });
});

/** Output lines with any trailing elision marker removed. */
const survivors = (out: string): string[] =>
  out
    .split(/\r?\n/)
    .map((line) => line.replace(/\s*\[\.\.\..*$/, ''))
    .filter((line) => line.trim());

/** A record with sentence breaks INSIDE it, the shape that could lose half itself. */
const RICH_RECORDS = [
  '#101 [bug] upd=10-13 | Cache misses on resume || The key omits the version. Resume then reads stale state. Fix by hashing it',
  '#102 [perf] upd=10-12 | Join is quadratic || Each row rescans the table. Index it first. Then join once',
  '#103 [docs] upd=10-11 | Install guide drift || Step four names a removed flag. Users copy it. Nothing warns them',
];

describe('records stay whole inside prose (#494 review)', () => {
  it('keeps every surviving record line byte-identical, even inside prose-majority text', () => {
    const mixed = [PARAGRAPHS, ...RICH_RECORDS, PARAGRAPHS].join('\n');
    const out = compressProse(mixed, { spill }).text;
    const inputLines = new Set(mixed.split('\n'));
    for (const line of survivors(out).filter((l) => l.startsWith('#'))) {
      expect({ line, exact: inputLines.has(line) }).toEqual({
        line,
        exact: true,
      });
    }
  });

  it('does not let a sentence cross between lowercase-starting rows', () => {
    const rows = [
      'alpha service restarts nightly. it drops the cache on every restart',
      'beta worker retries forever. it never backs off under load at all',
      'gamma queue loses ordering. it reorders on every rebalance of shards',
      'delta store compacts hourly. it blocks writers for the whole window',
      'epsilon proxy logs bodies. it leaks tokens into the shared log files',
      'zeta index rebuilds weekly. it doubles disk use while it is running',
    ];
    const text = rows.join('\n');
    expect(looksLikeProse(text)).toBe(false);
    const out = compressProse(`${PARAGRAPHS}\n${text}\n${PARAGRAPHS}`, {
      spill,
    }).text;
    const inputLines = new Set(
      `${PARAGRAPHS}\n${text}\n${PARAGRAPHS}`.split('\n')
    );
    for (const line of survivors(out).filter((l) => /^[a-z]/.test(l)))
      expect({ line, exact: inputLines.has(line) }).toEqual({
        line,
        exact: true,
      });
  });

  it('keeps the indentation of a record that survives after removed lines', () => {
    const indented = [PARAGRAPHS, ...RICH_RECORDS.map((r) => `    ${r}`)].join(
      '\n'
    );
    const out = compressProse(indented, { spill }).text;
    for (const line of survivors(out).filter((l) => l.includes('#10')))
      expect(line.startsWith('    #10')).toBe(true);
  });
});
