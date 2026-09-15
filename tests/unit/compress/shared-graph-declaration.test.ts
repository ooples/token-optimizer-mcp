/**
 * A graph that spans projects must be KNOWN to span them.
 *
 * `knowledgeBlock` drops `project`-scoped claims when `sharedGraph` is set,
 * because on a shared graph such a claim is a fact about some tree and nothing
 * downstream can say which. That filter is only as good as the flag feeding
 * it, and the flag was inferred from one path comparison: `isSharedDir`
 * recognises the machine-level unrooted graph and nothing else.
 *
 * The gap is not hypothetical. This project's own benchmark bind-mounts a
 * seeded graph at /proxy-graph and points the proxy there while the tasks work
 * on unrelated upstream repositories -- a per-project layout that is
 * cross-project in fact. The inference says "not shared", the filter stays
 * shut, and claims about token-optimizer-mcp become eligible for injection
 * into a Django task under the heading "Already established in this project".
 * Measured on the seed graph: a 99,842-character per-project ceiling against a
 * transferable 30,870, so 69% of the injectable pool was wrong-project advice.
 *
 * So these pin the DIRECTION of the override as much as its existence. It may
 * only ever turn sharing ON. A false negative serves foreign claims as
 * established fact on every turn of a cached prefix; a false positive merely
 * withholds some true ones.
 */

import { sharedGraphFor } from '../../../src/proxy/graph-scope.js';

const shared = { isSharedDir: () => true };
const perProject = { isSharedDir: () => false };

describe('the declaration can only add sharing, never remove it', () => {
  test('a declared shared graph is shared however the path looks', () => {
    // The benchmark's case exactly: a per-project layout, mounted across trees.
    expect(
      sharedGraphFor('/proxy-graph/.token-optimizer/wiki', perProject, {
        TOKEN_OPTIMIZER_GRAPH_SHARED: '1',
      })
    ).toBe(true);
  });

  test('the declaration cannot UNSHARE the unrooted machine-level graph', () => {
    // The dangerous direction. A graph that genuinely holds several projects'
    // claims must not be talked out of saying so by an environment variable --
    // that would put foreign `project` claims back into the prefix, which is
    // the whole failure this flag exists to prevent.
    for (const value of ['0', 'false', 'no', 'off', '']) {
      expect(
        sharedGraphFor('/anywhere', shared, {
          TOKEN_OPTIMIZER_GRAPH_SHARED: value,
        })
      ).toBe(true);
    }
  });

  test('an ordinary per-project graph is still per-project', () => {
    // Where the flag is absent, behaviour is exactly what it was. A normal
    // checkout's own graph is the most useful kind there is and must not be
    // filtered.
    expect(sharedGraphFor('/repo/.token-optimizer/wiki', perProject, {})).toBe(
      false
    );
  });
});

describe('what counts as a declaration', () => {
  test('the affirmative spellings an operator actually types', () => {
    for (const value of ['1', 'true', 'yes', 'on', 'TRUE', 'Yes', ' 1 ']) {
      expect(
        sharedGraphFor('/repo', perProject, {
          TOKEN_OPTIMIZER_GRAPH_SHARED: value,
        })
      ).toBe(true);
    }
  });

  test('anything else is not a declaration and falls through to the inference', () => {
    // Asserted against the per-project stub so a pass means "fell through and
    // the inference said no", not "the variable happened to be ignored".
    for (const value of ['0', 'no', 'maybe', 'shared', '2', '']) {
      expect(
        sharedGraphFor('/repo', perProject, {
          TOKEN_OPTIMIZER_GRAPH_SHARED: value,
        })
      ).toBe(false);
    }
  });
});

describe('a graph module that cannot answer is not treated as shared', () => {
  test('a missing isSharedDir leaves an undeclared graph per-project', () => {
    // FAIL SILENT IS THE RULE HERE, and this is the safe direction of it: a
    // pruned runtime means no inference, and defaulting to shared would strip
    // every project claim from a legitimate per-project graph -- turning a
    // module-resolution failure into a silent loss of the most useful findings.
    expect(sharedGraphFor('/repo', {}, {})).toBe(false);
  });

  test('but a declaration still stands without it', () => {
    expect(
      sharedGraphFor('/repo', {}, { TOKEN_OPTIMIZER_GRAPH_SHARED: '1' })
    ).toBe(true);
  });
});
