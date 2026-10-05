/**
 * Joining a conversation already in flight, and what it costs to be wrong.
 *
 * `anchorDecision` answers `joined-mid-conversation` when the proxy has never
 * seen a prefix before and the conversation is already past `coldMessageLimit`.
 * The provider demonstrably holds that prefix in its ORIGINAL form, so this is
 * the one case where rewriting can spend a 1.25x cache write and buy nothing.
 *
 * It refused outright, and the refusal was measured: on the benchmark captures
 * Claude Code puts its `cache_control` marker on the second-to-last user turn,
 * which leaves the ENTIRE history behind the frontier -- agent-loop gave up
 * 0.0% of its bytes and agent-loop-logs 0.0%, while the same bytes handed to
 * the block compressor gave up 83% and 89%.
 *
 * The frontier rule's own arithmetic is single-turn, and it reverses over a
 * session: a rewrite that leaves share `r` costs `r * (W + R*N)` against
 * `R * (N+1)` for leaving the prefix where it is. So the rewrite is now
 * ATTEMPTED, MEASURED, and kept only when what it actually removed clears that
 * break-even on a deliberately short horizon. These tests pin both halves --
 * that an overwhelming win is taken, and that anything short of it is reverted
 * to the client's own bytes with nothing recorded.
 */

import { describe, it, expect } from '@jest/globals';
import { anchorStore } from '../../../src/compress/anchor.js';
import {
  breakEvenRewriteShare,
  JOINED_TURNS_ASSUMED,
  minRewriteShare,
  v1Frontier,
} from '../../../src/compress/strategy.js';
import { DEFAULT_TUNING } from '../../../src/compress/options.js';
import type { ProviderRequest } from '../../../src/compress/frontier.js';

describe('the exact break-even share', () => {
  it('is 21.9% at the horizon the joined path bets on', () => {
    // 1 - 0.1*41 / (1.25 + 4.0). Pinned rather than recomputed: this single
    // number is what separates a rewrite that is taken from one that is not.
    // It moves only when `JOINED_TURNS_ASSUMED` is re-measured, so it is
    // written against the constant rather than against a literal 40.
    expect(JOINED_TURNS_ASSUMED).toBe(40);
    expect(breakEvenRewriteShare(JOINED_TURNS_ASSUMED)).toBeCloseTo(0.219, 3);
  });

  it('is why this is not minRewriteShare', () => {
    // THE APPROXIMATION IS WRONG IN BOTH REGIMES, which is the whole reason for
    // a second function. `W/R/turns` is honest at a hundred turns; at the
    // measured forty it is half again too strict, and at five it asks for 250%
    // of the payload -- a threshold nothing can ever clear, so reusing it there
    // would have left the joined path refusing every time while looking as
    // though it had been given a chance. The horizon is measured and can move,
    // so the exact form is what the decision is written against.
    expect(
      minRewriteShare({
        ...DEFAULT_TUNING,
        assumedSessionTurns: JOINED_TURNS_ASSUMED,
      })
    ).toBeGreaterThan(breakEvenRewriteShare(JOINED_TURNS_ASSUMED));
    expect(
      minRewriteShare({ ...DEFAULT_TUNING, assumedSessionTurns: 5 })
    ).toBeGreaterThan(1);
    expect(breakEvenRewriteShare(5)).toBeLessThan(1);
  });

  it('agrees with the approximation where the approximation is valid', () => {
    // Both describe the same trade, so at the hundred-turn prior they land
    // close together -- and the exact form is the more permissive of the two,
    // which is why the approximation stays where it is rather than being
    // replaced: every existing caller keeps the dial it was measured against.
    expect(breakEvenRewriteShare(100)).toBeCloseTo(0.102, 3);
    expect(breakEvenRewriteShare(100)).toBeLessThan(
      minRewriteShare(DEFAULT_TUNING)
    );
  });

  it('demands more of a rewrite the shorter the session', () => {
    const shares = [200, 50, 10, 3].map(breakEvenRewriteShare);
    for (let i = 1; i < shares.length; i += 1)
      expect(shares[i]).toBeGreaterThan(shares[i - 1]);
  });

  it('never promises a rewrite pays when no turns follow it', () => {
    // At zero turns the rewrite must remove 92% to break even, and a negative
    // or nonsense horizon is treated as zero rather than trusted.
    expect(breakEvenRewriteShare(0)).toBeCloseTo(0.92, 10);
    expect(breakEvenRewriteShare(-4)).toBeCloseTo(0.92, 10);
    expect(breakEvenRewriteShare(Number.NaN)).toBeCloseTo(0.92, 10);
  });
});

/**
 * A conversation ALREADY six messages deep, with the marker where a real client
 * puts it: on the second-to-last user turn, so everything of size is behind it.
 */
const joined = (history: string): ProviderRequest => ({
  system: 'You are a coding agent.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'start the task' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'reading files' }] },
    { role: 'user', content: [{ type: 'text', text: history }] },
    { role: 'assistant', content: [{ type: 'text', text: 'noted' }] },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'carry on',
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'carrying on' }] },
  ],
});

/** One tool result repeated: the shape every agent loop actually has. */
const repeated = (n: number): string =>
  Array.from(
    { length: n },
    () => `export function handler(input: string): string {
  const trimmed = input.trim();
  const parts = trimmed.toUpperCase().split(',');
  return parts.join('|');
}`
  ).join('\n\n');

/** Incompressible by construction: no line repeats, so nothing can be elided. */
const distinct = (n: number): string =>
  Array.from(
    { length: n },
    (_, i) =>
      `line ${i} ${(i * 2654435761) % 4294967296} ${(i * 40503) % 65521} ${
        (i * 97 + 13) % 1000003
      }`
  ).join('\n');

const run = (history: string) => {
  const request = joined(history);
  const result = v1Frontier(request, { anchors: anchorStore() });
  const before = JSON.stringify(request);
  const after = JSON.stringify(result.request);
  return {
    result,
    removed: (before.length - after.length) / before.length,
    untouched: after === before,
    sent: after,
  };
};

describe('a joined conversation is tried rather than refused', () => {
  const winner = repeated(200);

  it('still reports the decision as joined, because that is what it was', () => {
    // The strategy overrides the decision, it does not rewrite history. A
    // reason that changed to 'first-turn' here would hide the one case the
    // safety argument rests on.
    expect(run(winner).result.anchor?.reason).toBe('joined-mid-conversation');
  });

  it('rewrites the cached prefix when the saving clears the break-even', () => {
    const { result, removed } = run(winner);
    expect(removed).toBeGreaterThan(
      breakEvenRewriteShare(JOINED_TURNS_ASSUMED)
    );
    // AND IT IS COMMITTED. Without this the next turn re-derives the prefix
    // from scratch and changes bytes the provider is now holding as ours.
    expect(result.anchor?.reanchor).toBe(true);
    expect(result.anchor?.record.anchored).toBe(true);
  });

  it('reaches behind the client cache_control marker to do it', () => {
    // THE PROPERTY THAT WAS MISSING. `history` sits at message index 2 and the
    // marker at index 4, so a frontier-respecting pass cannot touch it. If the
    // repeated body survived intact the rewrite never happened, and the size
    // assertion above would be satisfied by something else.
    const { sent } = run(winner);
    expect(sent).toContain('carry on');
    expect(sent.length).toBeLessThan(winner.length);
  });
});

describe('a joined conversation that does not pay is left exactly alone', () => {
  it('returns the client bytes untouched when nothing compresses', () => {
    const { untouched, result } = run(distinct(900));
    expect(untouched).toBe(true);
    // RECORDING A REWRITE WE DID NOT SEND is the exact failure this path has to
    // avoid: the next turn would believe the provider holds our version,
    // reproduce it, and miss on the entire prefix.
    expect(result.anchor?.reanchor).toBe(false);
    expect(result.anchor?.record.anchored).toBe(false);
  });

  it('brackets the threshold at the break-even, not at 12.5%', () => {
    // TWO NEIGHBOURS, A HUNDRED LINES APART out of three thousand. The first
    // clears 21.9% by a whisker and is kept; the second falls under it and is
    // reverted whole -- which is only possible if the bar really is the
    // break-even at the measured horizon. `minRewriteShare`'s 12.5% would have
    // kept both, and its 31.2% at forty turns would have refused both.
    //
    // Deliberately tight, and it is the tightness that makes it a measurement
    // rather than a restatement: a bar anywhere else in [0, 1] fails one arm.
    const bar = breakEvenRewriteShare(JOINED_TURNS_ASSUMED);
    const kept = run(repeated(200) + '\n' + distinct(2800));
    expect(kept.removed).toBeGreaterThan(bar);
    expect(kept.removed).toBeLessThan(bar + 0.01);
    expect(kept.result.anchor?.reanchor).toBe(true);

    const reverted = run(repeated(200) + '\n' + distinct(2900));
    expect(reverted.untouched).toBe(true);
    expect(reverted.result.anchor?.reanchor).toBe(false);
    expect(minRewriteShare(DEFAULT_TUNING)).toBeLessThan(bar);
  });
});
