/**
 * The order vector, and the two documents that used to be indistinguishable.
 *
 * `foldRepeatedSegments` keeps one copy of each distinct section and drops the
 * rest. The note it used to write recorded HOW MANY it dropped and nothing
 * else, so `A B A C A` and `A A B C A` folded to the same sections and the same
 * count -- and neither could be told from the other afterwards. That is the
 * whole reason the fold was lossy and needed a spill file: not that the bytes
 * were gone, but that their arrangement was.
 *
 * Writing where each section stood is what makes the fold exactly invertible,
 * so these tests are built around the pair that collides without it.
 */
import { describe, it, expect } from '@jest/globals';
import {
  foldRepeatedSegments,
  encodeOrder,
  decodeOrder,
} from '../../../src/compress/segments.js';
import { rehydrate } from '../../../src/compress/rehydrate.js';

/** Distinct, heading-led, and long enough for the engine's floors. */
function section(name: string): string {
  return `# ${name}\n${`${name.toLowerCase()} line of prose `.repeat(24)}`;
}

const A = section('Alpha');
const B = section('Beta');
const C = section('Gamma');

/** Same sections, same multiset, different arrangement. */
const FIRST = [A, B, A, C, A, A, B, A, C, A, A, B].join('\n');
const SECOND = [A, A, A, A, A, B, B, C, C, A, B, C].join('\n');

describe('a folded document keeps the order its sections stood in', () => {
  it('rebuilds each arrangement exactly, and does not confuse the two', () => {
    const first = foldRepeatedSegments(FIRST);
    const second = foldRepeatedSegments(SECOND);

    expect(first.lossless).toBe(true);
    expect(second.lossless).toBe(true);
    expect(first.text.length).toBeLessThan(FIRST.length);
    expect(second.text.length).toBeLessThan(SECOND.length);

    // THE COLLISION THE OLD NOTE HAD. Both fold to the same three sections and
    // drop the same nine, so anything that records only the count writes the
    // same output for both -- and can give at most one of them back.
    expect(first.text).not.toBe(second.text);

    expect(rehydrate(first.text)).toBe(FIRST);
    expect(rehydrate(second.text)).toBe(SECOND);
  });

  it('asks for no spill file and no round trip', () => {
    // The published arm is handed no sink at all, so a fold that needs one
    // cannot fire there. This branch needs nothing: every folded section is
    // still in the text above it.
    let spilled = 0;
    const result = foldRepeatedSegments(FIRST, {
      spill: () => {
        spilled += 1;
        return '/recovery/sections.txt';
      },
    });
    expect(spilled).toBe(0);
    expect(result.elisions).toHaveLength(1);
    expect(result.elisions[0].recoverAt).toBeNull();
    expect(result.elisions[0].lossless).toBe(true);
  });
});
describe('the order vector', () => {
  it('collapses an ascending run to its endpoints', () => {
    // An unrepetitive stretch of a document IS an ascending run, so the common
    // case has to cost a few characters rather than one number per section.
    expect(encodeOrder([0, 1, 2, 3, 4])).toBe('0-4');
    expect(encodeOrder([0, 1, 2, 0, 3, 4])).toBe('0-2,0,3-4');
    expect(encodeOrder([0, 0, 0])).toBe('0,0,0');
    expect(encodeOrder([7])).toBe('7');
    expect(encodeOrder([])).toBe('');
  });

  it('round-trips every arrangement it encodes', () => {
    const cases = [[0, 1, 2, 3, 4], [0, 1, 2, 0, 3, 4], [0, 0, 0], [7], [0, 2, 1]];
    for (const order of cases) {
      expect(decodeOrder(encodeOrder(order))).toEqual(order);
    }
  });

  it('declines anything it does not fully understand', () => {
    // REFUSING IS THE POINT. A vector that is repaired into something plausible
    // rebuilds the document in the wrong order and says nothing, which is worse
    // than handing the marker back unexpanded for `rehydrate` to reject.
    expect(decodeOrder('')).toBeNull();
    expect(decodeOrder('4-0')).toBeNull();
    expect(decodeOrder('0,,2')).toBeNull();
    expect(decodeOrder('0-')).toBeNull();
    expect(decodeOrder('0,x')).toBeNull();
    expect(decodeOrder('0-1-2')).toBeNull();
  });

  it('fails closed on a marker that does not describe the text', () => {
    const folded = foldRepeatedSegments(FIRST).text;
    const reorder = (vector: string): string => {
      const out = folded.replace(/order: [\d,-]+\]$/, `order: ${vector}]`);
      expect(out).not.toBe(folded);
      return out;
    };
    // The count the note states, the sections actually present and the vector's
    // length all came out of one encode, so any disagreement between them means
    // this marker belongs to some other text.
    //
    // FIRST stands 12 sections deep over 3 distinct ones, so a well-formed
    // vector has 12 entries, none of them past index 2. A declined marker is
    // left in the text, and `expand-log.ts:122` refuses any `[... ` marker no
    // decoder consumed -- so the refusal is loud, which is the only kind worth
    // making.
    expect(() => rehydrate(reorder('0-2,9,0,0,0,0,0,0,0,0'))).toThrow(
      /unrecognised marker.*repeated sections folded/
    );
    expect(() => rehydrate(reorder('0-2,0,0,0,0,0,0,0,0'))).toThrow(
      /unrecognised marker.*repeated sections folded/
    );
    // Not a vector at all: the marker does not even parse, so nothing is read
    // back out of it.
    expect(() => rehydrate(reorder('0,x,2'))).toThrow(
      /unrecognised marker.*repeated sections folded/
    );

    // AND THE UNTAMPERED ONE STILL GOES BACK, so the refusals above are the
    // guards firing and not the decoder having stopped working.
    expect(rehydrate(folded)).toBe(FIRST);
  });
});