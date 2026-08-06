import { describe, it, expect, beforeAll } from '@jest/globals';
import { pathToFileURL } from 'url';
import { join } from 'path';

/**
 * The standing policy must ask the agent to RECORD what it concluded.
 *
 * The graph had 851 structural nodes and zero findings on a real project after
 * days of work. Not because extraction was broken -- `wiki_write` works, and
 * writes a finding anchored to real file nodes -- but because nothing ever asked
 * for it. The only other route was `harvest.mjs`, which calls a SEPARATE model
 * and is therefore opt-in for cost and disclosure reasons, so on a default
 * install the semantic layer could never fill.
 *
 * The session already running is the right extractor: it knows what it
 * concluded, at no marginal cost, with nothing leaving the machine. The lever
 * that reaches it is the SessionStart briefing -- the same standing context that
 * already redirects reads and searches to the smart tools, and demonstrably
 * changes behaviour for a whole session.
 *
 * ANCHORS ARE ASSERTED HERE because an unanchored finding can never go stale, so
 * it is served as current forever; `wiki_write` refuses one, and a briefing that
 * omitted the requirement would produce refusals the agent cannot diagnose.
 */

const ADAPTER = pathToFileURL(
  join(process.cwd(), 'hooks-core', 'adapter.mjs')
).href;

let policyText;

beforeAll(async () => {
  ({ policyText } = await import(ADAPTER));
});

describe('the standing policy asks for findings', () => {
  it('names the tool that records them', () => {
    expect(policyText(true)).toMatch(/wiki_write/);
  });

  it('states the anchor requirement, which the tool enforces', () => {
    // Without this the agent learns the rule by having writes refused.
    expect(policyText(true)).toMatch(/anchor/i);
  });

  it('says what is worth recording, not merely that recording exists', () => {
    // "Record findings" is an exhortation. The graph's own extraction prompt is
    // specific -- what was TRIED AND REJECTED, and why, because that exists
    // nowhere in the source tree -- and the briefing has to carry that same
    // specificity or it produces restatements of what the code already says.
    expect(policyText(true)).toMatch(/rejected|failure|decision/i);
  });

  it('keeps the briefing in both enforcement modes', () => {
    // policyText(false) is the advise-only wording used by clients that cannot
    // deny a tool call. Recording findings is not an enforcement feature, so it
    // must not disappear along with the denial language.
    expect(policyText(false)).toMatch(/wiki_write/);
  });
});
