/**
 * wiki_read: input handling and the advertised contract.
 *
 * The graph ROUND TRIP is not tested here, deliberately. This jest project cannot dynamically
 * import hooks-core from a TypeScript test -- `node:fs` cannot be resolved on an .mjs the
 * VM-modules loader has not linked -- so a graph-touching assertion here is unreliable rather
 * than merely absent. That half lives in tests/hooks/wiki-read-retrieval.test.mjs, in the
 * project that can run it, and pins the thing most likely to break silently: that the node id
 * wiki_read computes from a caller path is the same id writeHarvested anchored the finding to.
 *
 * What is worth testing here is everything that happens BEFORE the graph is reached, because
 * that is where a caller gets an unhelpful answer.
 */
import { describe, test, expect } from '@jest/globals';
import { wikiRead, WIKI_READ_TOOL_DEFINITION } from '../../src/tools/intelligence/wiki-read.js';

describe('wiki_read refuses unanswerable requests with a reason', () => {
  test('neither anchors nor projectRoot is refused, and says which to supply', async () => {
    const read = await wikiRead({});
    expect(read.success).toBe(false);
    expect(read.error).toMatch(/anchors/);
    expect(read.error).toMatch(/projectRoot/);
  });

  test('an anchors array of only blanks counts as no anchors', async () => {
    // Otherwise the tool would proceed to derive a project from '' and read the wrong graph.
    const read = await wikiRead({ anchors: ['', '   '] });
    expect(read.success).toBe(false);
    expect(read.error).toMatch(/anchors|projectRoot/);
  });

  test('a refusal still returns the documented empty shape, not undefined fields', async () => {
    // Callers destructure this. Returning `{success:false}` alone turns a bad request into a
    // TypeError several frames away from the cause.
    const read = await wikiRead({});
    expect(read.findings).toEqual([]);
    expect(read.shared).toEqual([]);
    expect(read.unresolvedAnchors).toEqual([]);
  });
});

describe('the advertised tool matches what the implementation accepts', () => {
  test('it is named wiki_read and states the subagent case that motivates it', () => {
    expect(WIKI_READ_TOOL_DEFINITION.name).toBe('wiki_read');
    expect(WIKI_READ_TOOL_DEFINITION.description).toMatch(/subagent/i);
  });

  test('every documented property is one the implementation actually reads', () => {
    // A schema that advertises a knob the code ignores is worse than no schema: the caller sets
    // it, nothing happens, and there is no error to explain why.
    const props = Object.keys(WIKI_READ_TOOL_DEFINITION.inputSchema.properties).sort();
    expect(props).toEqual(['anchors', 'includeShared', 'limit', 'projectRoot']);
  });

  test('no property is marked required, matching a tool that accepts either anchors or a project', () => {
    expect((WIKI_READ_TOOL_DEFINITION.inputSchema as { required?: string[] }).required).toBeUndefined();
  });
});
