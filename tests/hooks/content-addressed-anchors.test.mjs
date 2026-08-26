/**
 * A finding about a file reaches every identical copy of it.
 *
 * A vendored file is the same file wherever it sits, whatever path each copy is
 * given. Until now a finding recorded against one copy was invisible from the
 * others, and this repository is its own best example: the shared hook core is
 * vendored into eleven directories, byte-identical, so a claim about
 * `plugin/hooks/lib/adapter.mjs` said nothing at all when a reader touched
 * `integrations/qwen/hooks/lib/adapter.mjs`.
 *
 * WHY THIS IS AN INDEX AND NOT A SECOND IDENTITY, which is the question #319
 * asks and the reason `contentAnchor` was deleted rather than wired. That
 * implementation minted a second anchor id, `content:<hash>:<size>`, and a
 * second identity for one file is the defect this codebase has already been
 * burned by -- `canonicalKey` lives inside `nodeId` precisely because a caller
 * that forgot produced a second node for an existing file and split its
 * findings invisibly.
 *
 * So nothing new is stored. A file node has carried the sha256 of its contents
 * since staleness needed it, and this reads what is already there. One node per
 * path, one set of `derived_from` edges per finding, no history to split.
 *
 * The other three questions fall out rather than being decided, and each has a
 * test below: identical content at two paths in one repository, whether
 * staleness follows content or path, and what this does to cross-project
 * transfer.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  load,
  nodeId,
  putNode,
  putNodeWithEdges,
  findingsFor,
  contentPeers,
} from '../../hooks-core/wiki.mjs';
import { indexFile } from '../../hooks-core/staleness.mjs';

const NL = String.fromCharCode(10);
const VENDORED = 'export function run() {' + NL + '  return 1;' + NL + '}' + NL;

let project;
let dir;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'content-anchor-'));
  mkdirSync(join(project, '.git'), { recursive: true });
  dir = join(project, '.token-optimizer', 'wiki');
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

/** Writes a file, indexes it, and returns its path. */
function vendor(relative, contents = VENDORED) {
  const path = join(project, ...relative.split('/'));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  indexFile(dir, path, contents);
  return path;
}

/** A finding anchored to one path. */
function findingAt(key, path, claim = 'run() returns 1, not the parsed value') {
  return putNodeWithEdges(
    dir,
    { kind: 'finding', key, claim, type: 'finding', confidence: 0.9, origin: 'human' },
    [{ edge: 'derived_from', to: nodeId('file', path) }]
  );
}

const keysFor = (path) =>
  findingsFor(load(dir), nodeId('file', path), { limit: 20 }).map((f) => f.key);

describe('a finding reaches every identical copy', () => {
  test('surfaces from a sibling copy the finding was never anchored to', () => {
    const source = vendor('plugin/hooks/lib/adapter.mjs');
    const copy = vendor('integrations/qwen/hooks/lib/adapter.mjs');
    findingAt('adapter-returns-one', source);

    // The claim was recorded against one copy and is asked for from the other.
    expect(keysFor(copy)).toContain('adapter-returns-one');
    // And still from the copy it was anchored to, obviously.
    expect(keysFor(source)).toContain('adapter-returns-one');
  });

  test('reaches all of them, the way this repository actually vendors', () => {
    // Eleven directories, byte-identical, which is the case that motivated the
    // issue rather than a hypothetical one.
    const paths = Array.from({ length: 11 }, (_, i) =>
      vendor(`integrations/client-${i}/hooks/lib/adapter.mjs`)
    );
    findingAt('vendored-claim', paths[0]);

    for (const path of paths) {
      expect([path, keysFor(path)]).toEqual([path, expect.arrayContaining(['vendored-claim'])]);
    }
  });

  test('returns the finding ONCE, however many anchors reach it', () => {
    // A finding reachable through several anchors would otherwise be returned
    // several times -- spending the injection budget repeatedly on one claim
    // and letting it outrank a rival by being duplicated.
    //
    // ANCHORED TO TWO COPIES DELIBERATELY. The first version of this test
    // anchored the finding to ONE path and passed with the dedupe removed,
    // because the loop iterates EDGES: one edge can only be found once however
    // many anchors are in the set. Duplication needs two edges that both land
    // inside it, which is exactly what a finding recorded against two identical
    // copies produces.
    const a = vendor('a/adapter.mjs');
    const b = vendor('b/adapter.mjs');
    vendor('c/adapter.mjs');
    putNodeWithEdges(
      dir,
      { kind: 'finding', key: 'once-only', claim: 'reached from both copies', type: 'finding', confidence: 0.9 },
      [
        { edge: 'derived_from', to: nodeId('file', a) },
        { edge: 'derived_from', to: nodeId('file', b) },
      ]
    );

    for (const path of [a, b]) {
      const keys = keysFor(path);
      expect([path, keys.filter((k) => k === 'once-only').length]).toEqual([path, 1]);
    }
  });

  test('does not reach a file whose contents differ', () => {
    const source = vendor('lib/adapter.mjs');
    const different = vendor('lib/other.mjs', 'export const x = 2;' + NL);
    findingAt('only-here', source);

    expect(keysFor(different)).not.toContain('only-here');
  });
});

describe('the three questions #319 asks', () => {
  test('identical content at two paths in ONE repository is the same file', () => {
    // The issue asks what happens here. The answer is that it is the ordinary
    // case rather than an edge one: two paths, one content group, findings
    // shared both ways.
    const first = vendor('vendor/left/dep.js');
    const second = vendor('vendor/right/dep.js');
    findingAt('from-left', first);
    findingAt('from-right', second, 'a second claim about the same bytes');

    expect(keysFor(first)).toEqual(expect.arrayContaining(['from-left', 'from-right']));
    expect(keysFor(second)).toEqual(expect.arrayContaining(['from-left', 'from-right']));
  });

  test('staleness follows the PATH, and the group self-corrects', () => {
    // Content identity IS the hash, so there is no such thing as a stale
    // content anchor to invalidate: a file whose bytes change stops matching
    // its old group without anything having to notice.
    const source = vendor('lib/adapter.mjs');
    const copy = vendor('other/adapter.mjs');
    findingAt('shared-claim', source);
    expect(keysFor(copy)).toContain('shared-claim');

    // The copy is edited. It is no longer the same file.
    const edited = 'export function run() {' + NL + '  return 2;' + NL + '}' + NL;
    writeFileSync(copy, edited);
    indexFile(dir, copy, edited);

    expect(keysFor(copy)).not.toContain('shared-claim');
    // And the original is untouched -- the finding is still its own.
    expect(keysFor(source)).toContain('shared-claim');
  });

  test('opens no path between projects: it can only read one graph', () => {
    // This is what keeps `fleet.mjs` and the shared tier the only cross-project
    // transfer, with their own gates intact. A finding in another project's
    // graph is not in this graph, so no amount of matching content can reach
    // it.
    const source = vendor('lib/adapter.mjs');
    findingAt('local-only', source);

    const other = mkdtempSync(join(tmpdir(), 'content-anchor-other-'));
    try {
      const otherDir = join(other, '.token-optimizer', 'wiki');
      const otherPath = join(other, 'lib', 'adapter.mjs');
      mkdirSync(join(other, 'lib'), { recursive: true });
      writeFileSync(otherPath, VENDORED);
      indexFile(otherDir, otherPath, VENDORED);

      // Byte-identical, different graph, nothing carried over.
      const reached = findingsFor(load(otherDir), nodeId('file', otherPath), { limit: 20 });
      expect(reached).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('what must never be grouped', () => {
  test('empty files are not one file', () => {
    // Every empty file in a repository shares a hash, and they are not the same
    // file in any sense a reader cares about.
    const keep = vendor('docs/.gitkeep', '');
    const index = vendor('src/index.js', '');
    findingAt('about-an-empty-file', keep);

    expect(contentPeers(load(dir), nodeId('file', keep))).toEqual([]);
    expect(keysFor(index)).not.toContain('about-an-empty-file');
  });

  test('a file node with no usable hash groups with nothing', () => {
    // `indexFile` mints a file node for every resolved import WITHOUT reading
    // it, so those carry no hash. Grouping on a missing or empty hash would
    // make every unread import in the repository one content group, which is
    // the largest possible wrong answer.
    //
    // ASSERTED ON THE EMPTY STRING, not on `undefined`. The first version of
    // this test used two hashless stubs and passed with the guard removed,
    // because `undefined === ''` is false and they could never have matched
    // anyway. An explicitly empty hash is the value the guard actually stops.
    const key = join(project, 'imported.ts');
    const other = join(project, 'imported-too.ts');
    putNode(dir, { kind: 'file', key, hash: '' });
    putNode(dir, { kind: 'file', key: other, hash: '' });

    expect(contentPeers(load(dir), nodeId('file', key))).toEqual([]);
  });

  test('an import stub with no hash at all groups with nothing either', () => {
    const key = join(project, 'stub-a.ts');
    putNode(dir, { kind: 'file', key });
    putNode(dir, { kind: 'file', key: join(project, 'stub-b.ts') });
    expect(contentPeers(load(dir), nodeId('file', key))).toEqual([]);
  });

  test('a node written before bytes existed still groups, permissively', () => {
    // Refusing to group a node with no size would make the feature quietly stop
    // working on every graph that predates it, healing only as files happen to
    // be touched. Where both sides know their size they must agree; where
    // either does not, the hash stands alone -- the same evidence staleness
    // itself runs on.
    const key = join(project, 'vendor', 'legacy.js');
    const twin = join(project, 'vendor', 'legacy-copy.js');
    const shared = 'a1b2c3d4e5f60718';
    putNode(dir, { kind: 'file', key, hash: shared });
    putNode(dir, { kind: 'file', key: twin, hash: shared, bytes: 4096 });

    expect(contentPeers(load(dir), nodeId('file', key))).toEqual([nodeId('file', twin)]);
  });

  test('a symbol anchor is not a content group', () => {
    const source = vendor('lib/adapter.mjs');
    const symbol = nodeId('symbol', `${source}#run`);
    expect(contentPeers(load(dir), symbol)).toEqual([]);
  });

  test('an unknown anchor returns nothing rather than throwing', () => {
    expect(contentPeers(load(dir), nodeId('file', join(project, 'nope.ts')))).toEqual([]);
  });
});

describe('the peer set is bounded', () => {
  test('a file duplicated far beyond any real vendoring is capped', () => {
    // A vendored core in eleven directories is what this exists for; a
    // generated asset checked in hundreds of times is what would turn one
    // retrieval into a scan.
    const paths = Array.from({ length: 60 }, (_, i) => vendor(`gen/copy-${i}/asset.js`));
    const peers = contentPeers(load(dir), nodeId('file', paths[0]));
    expect(peers.length).toBeGreaterThan(10);
    expect(peers.length).toBeLessThanOrEqual(32);
  });
});
