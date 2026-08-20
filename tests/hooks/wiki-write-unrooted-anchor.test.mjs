/**
 * Regression for wiki_write refusing anchors with no VCS ancestor.
 *
 * projectRootFor() falls back to unrootedRoot() -- a storage bucket, not a
 * real directory anything lives inside -- when no .git/.hg/.svn marker
 * exists above the anchor. resolveAnchor() used to pass that same bucket
 * straight into the containment check, so no anchor outside a repo could
 * ever resolve, not because the file was missing but because nothing on
 * disk sits inside the bucket path it was compared against. Home directory
 * is the boundary that actually matches what an unrooted anchor looks like.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

import { wikiDir, projectRootFor, unrootedRoot } from '../../hooks-core/wiki.mjs';
import { writeHarvested } from '../../hooks-core/harvest-write.mjs';
import { ORIGIN_AGENT } from '../../hooks-core/curate.mjs';

let priorUnrootedDir, unrootedDir, homeWorkspace, outsideWorkspace;

beforeEach(() => {
  priorUnrootedDir = process.env.TOKEN_OPTIMIZER_UNROOTED_DIR;
  unrootedDir = mkdtempSync(join(tmpdir(), 'wiki-write-unrooted-'));
  process.env.TOKEN_OPTIMIZER_UNROOTED_DIR = unrootedDir;
});

afterEach(() => {
  if (priorUnrootedDir === undefined) delete process.env.TOKEN_OPTIMIZER_UNROOTED_DIR;
  else process.env.TOKEN_OPTIMIZER_UNROOTED_DIR = priorUnrootedDir;
  for (const d of [unrootedDir, homeWorkspace, outsideWorkspace]) {
    if (d) try { rmSync(d, { recursive: true, force: true }); } catch { /* windows lock */ }
  }
  homeWorkspace = undefined;
  outsideWorkspace = undefined;
});

describe('anchors with no VCS ancestor', () => {
  test('one under the home directory resolves', () => {
    homeWorkspace = mkdtempSync(join(homedir(), '.token-optimizer-harvest-test-'));
    const anchor = join(homeWorkspace, 'config.json');
    writeFileSync(anchor, '{}\n');

    const project = projectRootFor(anchor, process.cwd());
    expect(project).toBe(unrootedRoot());

    const keys = writeHarvested(
      wikiDir(project),
      [{ type: 'finding', claim: 'A home config file with no VCS ancestor is anchorable.',
         confidence: 0.9, anchors: [anchor] }],
      { sessionId: null, origin: ORIGIN_AGENT, projectRoot: project }
    );
    expect(keys.length).toBe(1);
  });

  test('one outside the home directory still stays refused', () => {
    outsideWorkspace = mkdtempSync(join(tmpdir(), 'wiki-write-outside-home-'));
    const anchor = join(outsideWorkspace, 'secret.txt');
    writeFileSync(anchor, 'not under home\n');

    const project = projectRootFor(anchor, process.cwd());
    expect(project).toBe(unrootedRoot());

    const keys = writeHarvested(
      wikiDir(project),
      [{ type: 'finding', claim: 'A file with no VCS ancestor and outside home stays refused.',
         confidence: 0.9, anchors: [anchor] }],
      { sessionId: null, origin: ORIGIN_AGENT, projectRoot: project }
    );
    expect(keys.length).toBe(0);
  });
});
