/**
 * THE REFERENCE RATE'S NUMERATOR HAS TO BE ABLE TO READ MORE THAN ZERO.
 *
 * The whole withholding case rests on how often a withheld unit is wanted
 * back, and zero is the reading that makes the arm look best. So these drive a
 * known answer through the counter rather than checking the proxy still runs.
 */
import { describe, expect, it } from '@jest/globals';
import {
  digestOf,
  referenceRate,
  reinstatedIn,
} from '../../../src/proxy/reinstated.js';

const WITHHELD =
  'a build log, four hundred lines of it, withheld from the body';
const OTHER = 'something else entirely that never left';

/** A plain text block: the client resending history, which is NOT a retrieval. */
const bodyWith = (...texts: string[]) =>
  JSON.stringify({
    model: 'claude-sonnet-4-5',
    messages: texts.map((text) => ({
      role: 'user',
      content: [{ type: 'text', text }],
    })),
  });

/** A tool result: content arriving back because somebody asked for it. */
const bodyWithToolResults = (...texts: string[]) =>
  JSON.stringify({
    model: 'claude-sonnet-4-5',
    messages: texts.map((text) => ({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: [{ type: 'text', text }],
        },
      ],
    })),
  });

describe('counting reinstated units', () => {
  it('counts a unit that came back as a tool result', () => {
    const withheld = new Set([digestOf(WITHHELD)]);
    expect(reinstatedIn(bodyWithToolResults(OTHER, WITHHELD), withheld)).toBe(
      1
    );
  });

  it('does NOT count the client resending history', () => {
    // THE CORRECTION THIS FILE EXISTS FOR. A conversation resends its whole
    // history every turn, so a unit withheld at turn 5 arrives again at 6, 7
    // and 8. Counting those made `reinstated` five times `spilled` over a real
    // run of 1,323 requests -- not a rate at all. The client never reinstates
    // anything: it sends originals, the proxy removes them on the way out, and
    // the proxy re-decides every turn.
    const withheld = new Set([digestOf(WITHHELD)]);
    expect(reinstatedIn(bodyWith(OTHER, WITHHELD), withheld)).toBe(0);
  });

  it('counts nothing when the unit did not come back', () => {
    const withheld = new Set([digestOf(WITHHELD)]);
    expect(
      reinstatedIn(bodyWithToolResults(OTHER, 'and more of the same'), withheld)
    ).toBe(0);
  });

  it('counts a unit once however often it is returned', () => {
    const withheld = new Set([digestOf(WITHHELD)]);
    expect(
      reinstatedIn(bodyWithToolResults(WITHHELD, OTHER, WITHHELD), withheld)
    ).toBe(1);
  });

  it('counts two different units separately', () => {
    const withheld = new Set([digestOf(WITHHELD), digestOf(OTHER)]);
    expect(reinstatedIn(bodyWithToolResults(WITHHELD, OTHER), withheld)).toBe(
      2
    );
  });

  it('reads a tool result whose content is a bare string', () => {
    const withheld = new Set([digestOf(WITHHELD)]);
    const body = JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', content: WITHHELD }],
        },
      ],
    });
    expect(reinstatedIn(body, withheld)).toBe(1);
  });

  it('answers zero for a body that does not parse', () => {
    expect(reinstatedIn('not json at all', new Set([digestOf(WITHHELD)]))).toBe(
      0
    );
  });

  it('answers zero when nothing has been withheld', () => {
    expect(reinstatedIn(bodyWithToolResults(WITHHELD), new Set())).toBe(0);
  });

  it('does not match a unit that was only partly sent back', () => {
    // A digest is of the whole unit, which is what stops a stub NAMING the unit
    // from counting as the unit returning.
    const withheld = new Set([digestOf(WITHHELD)]);
    expect(
      reinstatedIn(bodyWithToolResults(WITHHELD.slice(0, 20)), withheld)
    ).toBe(0);
  });
});

describe('the reference rate', () => {
  it('is the share of withheld units that came back', () => {
    expect(referenceRate({ spilled: 100, reinstated: 23 })).toBeCloseTo(0.23);
  });

  it('is null when nothing was withheld, not zero', () => {
    // Zero says every unit was dropped for free, which is the most flattering
    // reading available -- and it is what 0/0 produces when the arm never ran.
    expect(referenceRate({ spilled: 0, reinstated: 0 })).toBeNull();
    expect(referenceRate({})).toBeNull();
  });

  it('reads zero when units were withheld and none came back', () => {
    // THE CONTROL for the test above: a real zero is a real reading, and has to
    // be distinguishable from no data.
    expect(referenceRate({ spilled: 40, reinstated: 0 })).toBe(0);
  });

  it('refuses a rate above one rather than reporting it', () => {
    // More returned than left means the counters are measuring different
    // populations, which is a defect and not a catastrophic arm.
    expect(referenceRate({ spilled: 5, reinstated: 6 })).toBeNull();
  });

  it('refuses figures that are not numbers', () => {
    expect(referenceRate({ spilled: Number.NaN, reinstated: 1 })).toBeNull();
    expect(referenceRate({ spilled: 5, reinstated: -1 })).toBeNull();
  });
});
