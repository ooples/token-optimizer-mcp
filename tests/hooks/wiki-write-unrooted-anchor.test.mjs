/**
 * Regression for wiki_write refusing anchors with no VCS ancestor.
 *
 * projectRootFor() falls back to unrootedRoot() -- a storage bucket, not a
 * real directory anything lives inside -- when no .git/.hg/.svn marker
 * exists above the anchor. resolveAnchor() used to pass that same bucket
 * straight into the containment check, so no anchor outside a repo could
 * ever resolve, not because the file was missing but because nothing on
 * disk sits inside the bucket path it was compared against. Home directory
 * is the boundary that actually matches what an unrooted anchor looks like
 * -- except when home itself is "/", where a plain prefix check would
 * accept every absolute path and defeat the containment guard entirely.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, sep } from 'path';
import { tmpdir, homedir } from 'os';

import { wikiDir, projectRootFor, unrootedRoot } from '../../hooks-core/wiki.mjs';
import { writeHarvested } from '../../hooks-core/harvest-write.mjs';
import { ORIGIN_AGENT } from '../../hooks-core/curate.mjs';

let priorUnrootedDir, priorWikiDir, priorHome;
let unrootedDir, wikiDirOverride, homeWorkspace, outsideWorkspace;

beforeEach(() => {
  priorUnrootedDir = process.env.TOKEN_OPTIMIZER_UNROOTED_DIR;
  priorWikiDir = process.env.TOKEN_OPTIMIZER_WIKI_DIR;
  unrootedDir = mkdtempSync(join(tmpdir(), 'wiki-write-unrooted-'));
  wikiDirOverride = mkdtempSync(join(tmpdir(), 'wiki-write-graph-'));
  process.env.TOKEN_OPTIMIZER_UNROOTED_DIR = unrootedDir;
  // wikiDir(project) honors this unconditionally, so an inherited value from
  // outside this file could otherwise redirect storage to a shared location.
  process.env.TOKEN_OPTIMIZER_WIKI_DIR = wikiDirOverride;
});

afterEach(() => {
  if (priorUnrootedDir === undefined) delete process.env.TOKEN_OPTIMIZER_UNROOTED_DIR;
  else process.env.TOKEN_OPTIMIZER_UNROOTED_DIR = priorUnrootedDir;
  if (priorWikiDir === undefined) delete process.env.TOKEN_OPTIMIZER_WIKI_DIR;
  else process.env.TOKEN_OPTIMIZER_WIKI_DIR = priorWikiDir;
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  for (const d of [unrootedDir, wikiDirOverride, homeWorkspace, outsideWorkspace]) {
    if (d) try { rmSync(d, { recursive: true, force: true }); } catch { /* windows lock */ }
  }
  homeWorkspace = undefined;
  outsideWorkspace = undefined;
});

/** True only when `outer` and `inner` don't overlap by path prefix, either way. */
function disjoint(a, b) {
  const withSep = (p) => (p.endsWith(sep) ? p : p + sep);
  return a !== b && !withSep(a).startsWith(withSep(b)) && !withSep(b).startsWith(withSep(a));
}

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

  // tmpdir() and homedir() are unrelated by contract, not by guarantee -- on a
  // machine where TMPDIR happens to live under HOME, this case does not apply.
  (disjoint(tmpdir(), homedir()) ? test : test.skip)(
    'one outside the home directory still stays refused',
    () => {
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
    }
  );

  // "/" is the POSIX shape of a filesystem-root home; "C:\" and a bare UNC
  // share are the Windows shapes of the same problem. os.homedir() trusts
  // HOME verbatim on POSIX, and canonicalPath() normalises any of these the
  // same way regardless of host OS, so all three are exercised for real
  // here, on whichever platform this suite happens to run on.
  test.each([
    ['POSIX root', '/', 'stand-in-for-etc-shadow.txt'],
    ['Windows drive root', 'C:\\', 'stand-in-for-System32-hosts.txt'],
    ['Windows UNC share root', '\\\\server\\share\\', 'stand-in-for-a-network-secret.txt'],
  ])('one stays refused when the home directory is a filesystem root (%s)', (_label, rootHome, filename) => {
    priorHome = process.env.HOME;
    process.env.HOME = rootHome;

    outsideWorkspace = mkdtempSync(join(tmpdir(), 'wiki-write-root-home-'));
    const anchor = join(outsideWorkspace, filename);
    writeFileSync(anchor, 'not the real target, but anchored the same way\n');

    const project = projectRootFor(anchor, process.cwd());
    expect(project).toBe(unrootedRoot());

    const keys = writeHarvested(
      wikiDir(project),
      [{ type: 'finding', claim: 'Home resolving to a filesystem root must not widen the containment boundary.',
         confidence: 0.9, anchors: [anchor] }],
      { sessionId: null, origin: ORIGIN_AGENT, projectRoot: project }
    );
    expect(keys.length).toBe(0);
  });
});
