/**
 * A store rejection recorded while resolving one finding's anchors is not
 * blamed on the next finding (review on #543).
 *
 * Finding 1 resolves anchor A, while the store refuses anchor B (a transient
 * EBUSY, say), so finding 1 is still written. Finding 2 names only files that
 * do not exist. Finding 2 failed on its anchors, not on the store, and must not
 * be reported as a store rejection.
 *
 * indexFile is wrapped so that indexing B produces a real store rejection,
 * through the same `rejected()` every store writer uses.
 */

import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const real = await import('../../hooks-core/staleness.mjs');
const { rejected } = await import('../../hooks-core/store-write.mjs');

jest.unstable_mockModule('../../hooks-core/staleness.mjs', () => ({
  ...real,
  indexFile: (dir, path, ...rest) => {
    if (String(path).includes('busy')) {
      rejected({ store: dir, op: 'graph-append', reason: 'EBUSY: resource busy', quiet: true });
      return null;
    }
    return real.indexFile(dir, path, ...rest);
  },
}));

const { writeHarvested } = await import('../../hooks-core/harvest-write.mjs');

let project;
let dir;
beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), 'harvest-reject-'));
  dir = join(project, '.token-optimizer', 'wiki');
  writeFileSync(join(project, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(project, 'busy.ts'), 'export const b = 1;\n');
});
afterAll(() => rmSync(project, { recursive: true, force: true }));

const finding = (claim, anchors) => ({
  type: 'decision',
  claim,
  confidence: 0.8,
  confidenceLabel: 'verified',
  anchors,
  evidence: 'observed in the test',
  applicability: 'always',
});

describe('store rejections are attributed per finding', () => {
  test("finding 2's unresolvable anchors are not reported as finding 1's store rejection", () => {
    const keys = writeHarvested(
      dir,
      [
        finding('the first claim, anchored to a and busy', [join(project, 'a.ts'), join(project, 'busy.ts')]),
        finding('the second claim, anchored to nothing real', [join(project, 'missing.ts')]),
      ],
      { projectRoot: project }
    );
    expect(keys).toHaveLength(1);
    expect(keys.storeRejected).toEqual([]);
  });

  test('a finding whose only valid anchor the store refused is a store rejection', () => {
    const keys = writeHarvested(dir, [finding('anchored only to busy', [join(project, 'busy.ts')])], {
      projectRoot: project,
    });
    expect(keys).toHaveLength(0);
    expect(keys.storeRejected).toEqual([expect.objectContaining({ reason: 'EBUSY: resource busy' })]);
  });
});
