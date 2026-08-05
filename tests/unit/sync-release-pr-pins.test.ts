import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * The release-PR pin sync, exercised against real git repositories.
 *
 * This logic lived inline in release.yml, where it could not be run without cutting
 * a release -- so it shipped broken and failed in production on its first outing:
 *
 *   fatal: couldn't find remote ref release-please--branches--master--components--...
 *   ##[error]Process completed with exit code 128
 *
 * The release PR had been merged between release-please reporting it and the step
 * fetching its branch, so the branch was gone. Under `set -e` that made the whole
 * release job red. THREE release attempts were burned on this pipeline before anyone
 * ran any of it outside CI; that is the reason this file exists.
 *
 * Every case below runs the real script against a real bare "remote" and a real
 * clone. No mocks: the thing that broke was git behaviour, and a mocked git would
 * have agreed with the broken version.
 */

const SCRIPT = join(process.cwd(), 'scripts', 'sync-release-pr-pins.mjs');

const RELEASE_BRANCH = 'release-please--branches--master--components--token-optimizer-mcp';

describe('sync-release-pr-pins', () => {
  let root: string;
  let remote: string;
  let work: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  /** Runs the script the way the workflow does, returning status and output. */
  const run = (branch: string, syncCommand: string) =>
    spawnSync(
      process.execPath,
      [SCRIPT, '--branch', branch, '--remote', 'origin', '--sync-command', syncCommand],
      { cwd: work, encoding: 'utf8' }
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pin-sync-'));
    remote = join(root, 'remote.git');
    work = join(root, 'work');

    // A bare repository standing in for origin.
    mkdirSync(remote);
    git(remote, 'init', '--bare', '--initial-branch=master');

    // A clone with one commit on master, mirroring the workflow's checkout.
    mkdirSync(work);
    git(work, 'init', '--initial-branch=master');
    git(work, 'remote', 'add', 'origin', remote);
    git(work, 'config', 'user.email', 'test@example.com');
    git(work, 'config', 'user.name', 'Test');
    writeFileSync(join(work, 'pin.txt'), 'pinned: 5.4.1\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'base');
    git(work, 'push', '-u', 'origin', 'master');
  });

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows can hold a handle on a just-deleted git dir.
    }
  });

  /** Creates the release branch on the remote, as release-please would. */
  const pushReleaseBranch = () => {
    git(work, 'checkout', '-b', RELEASE_BRANCH);
    writeFileSync(join(work, 'version.txt'), '5.4.2\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'chore(master): release 5.4.2');
    git(work, 'push', 'origin', RELEASE_BRANCH);
    git(work, 'checkout', 'master');
  };

  it('exits successfully when the release branch no longer exists', () => {
    // THE PRODUCTION FAILURE. The PR was merged and its branch deleted between
    // release-please reporting it and this step running. A merged release is a
    // success, so a vanished branch is nothing to do -- not a red build.
    const result = run(RELEASE_BRANCH, 'echo noop');

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/no longer exists|already merged/i);
  });

  it('does not leave a partial checkout behind when the branch is missing', () => {
    run(RELEASE_BRANCH, 'echo noop');

    // Still on master, nothing half-applied.
    expect(git(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('master');
  });

  it('refuses a branch release-please does not own', () => {
    git(work, 'checkout', '-b', 'release-please-maintenance');
    git(work, 'push', 'origin', 'release-please-maintenance');
    git(work, 'checkout', 'master');

    // Single-dash form must not be accepted: this path force-commits to whatever
    // branch it is handed.
    const result = run('release-please-maintenance', 'echo noop');

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/refus/i);
  });

  it('refuses an arbitrary branch outright', () => {
    const result = run('main', 'echo noop');

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/refus/i);
  });

  it('commits and pushes the sync when the branch has stale pins', () => {
    pushReleaseBranch();
    const before = git(work, 'rev-parse', `origin/${RELEASE_BRANCH}`);

    // Stands in for `npm run sync:hooks`: rewrites the pinned file.
    const result = run(RELEASE_BRANCH, 'node -e "require(\'fs\').writeFileSync(\'pin.txt\',\'pinned: 5.4.2\\n\')"');

    expect(result.status).toBe(0);

    git(work, 'fetch', 'origin', RELEASE_BRANCH);
    const after = git(work, 'rev-parse', `origin/${RELEASE_BRANCH}`);
    expect(after).not.toBe(before);

    // And the pushed content is the synced content.
    const pushed = git(work, 'show', `${after}:pin.txt`);
    expect(pushed).toContain('5.4.2');
  });

  it('pushes nothing when the pins are already in step', () => {
    pushReleaseBranch();
    const before = git(work, 'rev-parse', `origin/${RELEASE_BRANCH}`);

    const result = run(RELEASE_BRANCH, 'echo noop');

    expect(result.status).toBe(0);
    git(work, 'fetch', 'origin', RELEASE_BRANCH);
    expect(git(work, 'rev-parse', `origin/${RELEASE_BRANCH}`)).toBe(before);
  });

  it('commits a pinned config the sync newly creates', () => {
    // `git diff --quiet` does not see untracked files and `git commit -am` does not
    // stage them, so a sync that ADDS a config -- a new client integration -- read as
    // "already match" and pushed nothing. Silent, and the release would ship without
    // the new file.
    pushReleaseBranch();
    const before = git(work, 'rev-parse', `origin/${RELEASE_BRANCH}`);

    const result = run(
      RELEASE_BRANCH,
      'node -e "const fs=require(\'fs\');fs.mkdirSync(\'integrations/new\',{recursive:true});fs.writeFileSync(\'integrations/new/mcp.json\',\'{}\\n\')"'
    );

    expect(result.status).toBe(0);

    git(work, 'fetch', 'origin', RELEASE_BRANCH);
    const after = git(work, 'rev-parse', `origin/${RELEASE_BRANCH}`);
    expect(after).not.toBe(before);
    expect(git(work, 'show', '--stat', '--name-only', after)).toContain('integrations/new/mcp.json');
  });

  it('exits successfully when the branch is deleted while the sync is running', () => {
    // The same merge race the existence check handles, moved to the push. Without a
    // lease the push would RECREATE the deleted branch and could resurrect a closed
    // release PR; with a plain push and a deleted ref it would fail the job.
    pushReleaseBranch();

    // The sync command itself deletes the remote branch, standing in for a merge
    // landing mid-run.
    const result = run(
      RELEASE_BRANCH,
      `git push origin --delete ${RELEASE_BRANCH} && node -e "require('fs').writeFileSync('pin.txt','pinned: 5.4.2\\n')"`
    );

    expect(result.status).toBe(0);

    // And it must not have recreated the branch.
    const lsRemote = execFileSync('git', ['ls-remote', '--heads', 'origin', RELEASE_BRANCH], {
      cwd: work,
      encoding: 'utf8',
    });
    expect(lsRemote.trim()).toBe('');
  });

  it('exits successfully when the branch advances while the sync is running', () => {
    pushReleaseBranch();

    // Someone else pushes to the release branch mid-run. A plain push would be
    // rejected non-fast-forward and fail the release job; the next release-please run
    // re-syncs, so standing down is correct.
    const result = run(
      RELEASE_BRANCH,
      // Advance the remote branch, then make a local change to sync. Deliberately no
      // failing command in this chain: `&&` would short-circuit and the script would
      // (correctly) report the SYNC as failed, which is a different case.
      `git -c user.email=o@e.com -c user.name=O commit -q --allow-empty -m other && ` +
        `git push -q origin HEAD:refs/heads/${RELEASE_BRANCH} && ` +
        `node -e "require('fs').writeFileSync('pin.txt','pinned: 5.4.2\\n')"`
    );

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/moved or was merged/i);
  });

  it('fails loudly when the sync command itself fails', () => {
    pushReleaseBranch();

    // A broken generator must not be mistaken for "nothing to sync" and silently
    // pass, which would ship a release with stale pins.
    const result = run(RELEASE_BRANCH, 'node -e "process.exit(3)"');

    expect(result.status).not.toBe(0);
  });

  it('is idempotent: a second run finds nothing to do', () => {
    pushReleaseBranch();
    const sync = 'node -e "require(\'fs\').writeFileSync(\'pin.txt\',\'pinned: 5.4.2\\n\')"';

    expect(run(RELEASE_BRANCH, sync).status).toBe(0);
    git(work, 'fetch', 'origin', RELEASE_BRANCH);
    const afterFirst = git(work, 'rev-parse', `origin/${RELEASE_BRANCH}`);

    expect(run(RELEASE_BRANCH, sync).status).toBe(0);
    git(work, 'fetch', 'origin', RELEASE_BRANCH);
    expect(git(work, 'rev-parse', `origin/${RELEASE_BRANCH}`)).toBe(afterFirst);
  });

  it('syncs against the release branch, not whatever was checked out', () => {
    // The workflow checks out master; the sync must apply to the release branch.
    pushReleaseBranch();
    expect(git(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('master');

    run(RELEASE_BRANCH, 'node -e "require(\'fs\').writeFileSync(\'pin.txt\',\'pinned: 5.4.2\\n\')"');

    git(work, 'fetch', 'origin', RELEASE_BRANCH);
    const head = git(work, 'rev-parse', `origin/${RELEASE_BRANCH}`);
    // version.txt only exists on the release branch, so this proves the commit
    // landed there rather than on a copy of master.
    expect(git(work, 'show', `${head}:version.txt`)).toContain('5.4.2');
    expect(readFileSync(join(work, 'pin.txt'), 'utf8')).toBeDefined();
  });
});
