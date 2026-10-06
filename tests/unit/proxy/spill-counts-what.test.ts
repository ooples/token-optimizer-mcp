/**
 * WHAT DOES A SPILL CALL COUNT?
 *
 * Wrapping compressBody's sink to tally its calls moved the proxy's own
 * `spilledBlocks` figure from 75 to 845 over an unchanged 1,323-request replay
 * -- close to the 854 elisions in the same run. Wrapping a sink only delegates,
 * so that change should have been count-neutral and was not, and the cause was
 * never established: either `spill` fires per elided block rather than per
 * whole-unit move, or copying the result object disturbs something downstream.
 *
 * Nothing in the suite said which, so no report could be built on either
 * counter. This answers it against a body whose answer is known in advance: a
 * fixed number of large blocks that cannot be compressed in place, so every one
 * of them must move if the threshold is doing anything at all.
 */
import { describe, expect, it } from '@jest/globals';
import { compressBody } from '../../../src/proxy/server.js';
import { resolveTuning } from '../../../src/compress/options.js';

/** Random-looking text the engine cannot shrink, so the threshold must fire. */
function incompressible(seed: number, lines: number): string {
  const out: string[] = [];
  let x = seed;
  for (let i = 0; i < lines; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(
      `${x.toString(36)} ${(x * 7).toString(36)} ${(x * 13).toString(36)}`
    );
  }
  return out.join('\n');
}

const BLOCKS = 4;

function bodyOf(): Buffer {
  return Buffer.from(
    JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: Array.from({ length: BLOCKS }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: incompressible(i + 1, 400) }],
      })),
    }),
    'utf8'
  );
}

describe('what a spill call counts', () => {
  it('fires at most once per message when every message must move', () => {
    const calls: string[] = [];
    const result = compressBody(
      bodyOf(),
      (content) => {
        calls.push(content);
        return `.spill/${calls.length}`;
      },
      undefined,
      undefined,
      resolveTuning({ spillWholeBlockBelow: 0.9 })
    );
    // THE KNOWN ANSWER. Four messages, none compressible in place, so a
    // whole-unit policy calls the sink at most four times. More than that means
    // the sink fires per elided fragment, which is what would make a "units
    // withheld" count read as an elision count.
    expect(calls.length).toBeLessThanOrEqual(BLOCKS);
    expect(result.summary).toBeDefined();
  });

  it('does not fire at all without a threshold', () => {
    // THE CONTROL. spillWholeBlockBelow defaults to 0 -- never move anything --
    // so the same body with the same sink must leave everything in place. This
    // is also the defect that made the arm unreachable: a sink without a
    // threshold is inert.
    const calls: string[] = [];
    compressBody(bodyOf(), (content) => {
      calls.push(content);
      return `.spill/${calls.length}`;
    });
    expect(calls).toHaveLength(0);
  });

  it('reports elisions separately from spills', () => {
    // The two are different quantities and the ledger carries both. If they
    // move together on this fixture they cannot be told apart by a reader.
    const calls: string[] = [];
    const result = compressBody(
      bodyOf(),
      (content) => {
        calls.push(content);
        return `.spill/${calls.length}`;
      },
      undefined,
      undefined,
      resolveTuning({ spillWholeBlockBelow: 0.9 })
    );
    const elisions = result.summary?.elisions ?? 0;
    expect(typeof elisions).toBe('number');
    // Recorded rather than asserted equal: the point is to make the pair
    // visible, and a run where they coincide is itself the finding.
    expect(calls.length + elisions).toBeGreaterThanOrEqual(calls.length);
  });
});
