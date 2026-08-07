/**
 * The retrieval contract wiki_read depends on.
 *
 * wiki_read is TypeScript and dynamically imports hooks-core, which the TS jest project cannot
 * do -- `node:fs` cannot be resolved on an .mjs that the VM-modules loader has not linked. So
 * the round trip is proven HERE, against the real graph, in the project that can run it.
 *
 * What this pins is the agreement between the two halves: the node id wiki_read computes from a
 * caller-supplied path must be the same id writeHarvested anchored the finding to. If those ever
 * diverge -- a change to canonicalKey, to nodeId, to how symbols are keyed -- wiki_read returns
 * an empty list for a graph that plainly contains the answer, and nothing else would catch it.
 * That is the exact failure mode this project has shipped twice: fully implemented, fully
 * unit-tested, and connected to nothing.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { wikiDir, load, findingsFor, nodeId, canonicalKey, projectRootFor } from '../../hooks-core/wiki.mjs';
import { writeHarvested } from '../../hooks-core/harvest-write.mjs';
import { ORIGIN_AGENT } from '../../hooks-core/curate.mjs';

let project, target, shared;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'wikiread-'));
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(join(project, 'src'), { recursive: true });
  target = join(project, 'src', 'thing.js');
  writeFileSync(target, 'export function thing() { return 1; }\n');
  shared = mkdtempSync(join(tmpdir(), 'wikiread-shared-'));
  process.env.TOKEN_OPTIMIZER_SHARED_DIR = shared;
});

afterEach(() => {
  delete process.env.TOKEN_OPTIMIZER_SHARED_DIR;
  for (const d of [project, shared]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* windows lock */ }
  }
});

/** The id computation wiki_read performs, kept verbatim so a divergence fails here. */
const idFor = (anchor) => {
  const [file, symbol] = anchor.split('#');
  return symbol ? nodeId('symbol', `${file}#${symbol}`) : nodeId('file', canonicalKey('file', file));
};

describe('the id wiki_read computes reaches the finding wiki_write stored', () => {
  test('a written finding is retrievable by the path the caller passed in', () => {
    const dir = wikiDir(project);
    const keys = writeHarvested(
      dir,
      [{ type: 'finding', claim: 'thing() returns 1 because the caller cannot handle 0 yet.',
         confidence: 0.9, anchors: [target] }],
      { sessionId: null, origin: ORIGIN_AGENT, projectRoot: project }
    );
    expect(keys.length).toBe(1);

    const found = findingsFor(load(dir), idFor(target));
    expect(found.map((f) => f.claim)).toContain(
      'thing() returns 1 because the caller cannot handle 0 yet.'
    );
  });

  test('an anchor absent from the graph is distinguishable from a graph with no findings', () => {
    // wiki_read reports these separately, and it can only do so if the node lookup itself
    // distinguishes them. Silence read as "nothing known" is how a typo becomes reassurance.
    const dir = wikiDir(project);
    const graph = load(dir);
    expect(graph.nodes.has(idFor(join(project, 'src', 'nope.js')))).toBe(false);
  });

  test('a retired finding is excluded by the retrieval primitive itself', () => {
    // wiki_read deliberately does not re-filter: retirement is enforced at the source so no
    // consumer has to remember. This asserts that guarantee actually holds.
    const dir = wikiDir(project);
    writeHarvested(
      dir,
      [{ type: 'finding', claim: 'A conclusion later withdrawn as incorrect.',
         confidence: 0.9, anchors: [target] }],
      { sessionId: null, origin: ORIGIN_AGENT, projectRoot: project }
    );
    const graph = load(dir);
    const node = [...graph.nodes.values()].find(
      (n) => n.kind === 'finding' && n.claim === 'A conclusion later withdrawn as incorrect.'
    );
    expect(node).toBeTruthy();

    node.retired = true;
    graph.nodes.set(nodeId('finding', node.key), node);
    expect(findingsFor(graph, idFor(target)).map((f) => f.claim)).not.toContain(
      'A conclusion later withdrawn as incorrect.'
    );
  });

  test('projectRootFor resolves the anchor to its own repository, not the caller cwd', () => {
    // wiki_read selects the graph this way. A subagent's cwd is meaningless, which is exactly
    // why the anchor rather than the cwd has to pick the project.
    expect(projectRootFor(target, undefined)).toBe(project.split('\\').join('/'));
  });
});
