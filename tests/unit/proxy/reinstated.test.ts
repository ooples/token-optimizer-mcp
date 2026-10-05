/**
 * THE REFERENCE RATE'S NUMERATOR HAS TO BE ABLE TO READ MORE THAN ZERO.
 *
 * The whole withholding case rests on how often a withheld unit is wanted
 * back, and zero is the reading that makes the arm look best. So these drive a
 * known answer through the counter rather than checking the proxy still runs.
 */
import { describe, expect, it } from '@jest/globals';
import { digestOf, reinstatedIn } from '../../../src/proxy/reinstated.js';

const WITHHELD =
  'a build log, four hundred lines of it, withheld from the body';
const OTHER = 'something else entirely that never left';

const bodyWith = (...texts: string[]) =>
  JSON.stringify({
    model: 'claude-sonnet-4-5',
    messages: texts.map((text) => ({
      role: 'user',
      content: [{ type: 'text', text }],
    })),
  });

describe('counting reinstated units', () => {
  it('counts a unit that came back', () => {
    const withheld = new Set([digestOf(WITHHELD)]);
    expect(reinstatedIn(bodyWith(OTHER, WITHHELD), withheld)).toBe(1);
  });

  it('counts nothing when it did not', () => {
    // THE CONTROL for the test above: the same set, a body without the unit.
    const withheld = new Set([digestOf(WITHHELD)]);
    expect(
      reinstatedIn(bodyWith(OTHER, 'and more of the same'), withheld)
    ).toBe(0);
  });

  it('counts a unit once however often it is pasted', () => {
    // The question is whether it was wanted, not how many times it appears.
    const withheld = new Set([digestOf(WITHHELD)]);
    expect(reinstatedIn(bodyWith(WITHHELD, OTHER, WITHHELD), withheld)).toBe(1);
  });

  it('counts two different units separately', () => {
    const withheld = new Set([digestOf(WITHHELD), digestOf(OTHER)]);
    expect(reinstatedIn(bodyWith(WITHHELD, OTHER), withheld)).toBe(2);
  });

  it('reads string content as well as blocks', () => {
    // A client may send content as a bare string rather than a block list.
    const withheld = new Set([digestOf(WITHHELD)]);
    const body = JSON.stringify({
      messages: [{ role: 'user', content: WITHHELD }],
    });
    expect(reinstatedIn(body, withheld)).toBe(1);
  });

  it('answers zero for a body that does not parse', () => {
    // A malformed request is not evidence about the rate, so it must not throw
    // and must not be counted as a reinstatement either.
    expect(reinstatedIn('not json at all', new Set([digestOf(WITHHELD)]))).toBe(
      0
    );
  });

  it('answers zero when nothing has been withheld', () => {
    // The arm is not running, so there is no rate to contribute to.
    expect(reinstatedIn(bodyWith(WITHHELD), new Set())).toBe(0);
  });

  it('does not match a unit that was only partly sent back', () => {
    // A digest is of the whole unit. Half of it is a different string, which is
    // what stops a stub naming the unit from counting as the unit returning.
    const withheld = new Set([digestOf(WITHHELD)]);
    expect(reinstatedIn(bodyWith(WITHHELD.slice(0, 20)), withheld)).toBe(0);
  });
});
