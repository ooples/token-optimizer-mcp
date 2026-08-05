#!/usr/bin/env node
/**
 * Sync the pinned client specs into an open release-please PR.
 *
 * WHY THIS IS A SCRIPT AND NOT SIX LINES OF YAML.
 *
 * It was six lines of YAML, and it could not be run without cutting a release. It
 * shipped broken and failed on its first outing:
 *
 *   fatal: couldn't find remote ref release-please--branches--master--components--...
 *   ##[error]Process completed with exit code 128
 *
 * The release PR had been merged between release-please reporting it and the step
 * fetching its branch, so the branch was gone -- and `set -e` turned a merged
 * release into a red build. Three release attempts were spent on this pipeline
 * before any of it was executed outside CI. As a script it has tests that run
 * against real git repositories in milliseconds.
 *
 * Contract:
 *   --branch        the release-please branch to amend (required)
 *   --remote        remote name (default: origin)
 *   --sync-command  command that rewrites the pins (default: npm run sync:hooks)
 *
 * Exit codes:
 *   0  synced and pushed, or nothing to do, or the branch is already merged
 *   1  refused (not a release-please branch) or the sync command failed
 */

import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);

const flag = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const branch = flag('branch');
const remote = flag('remote', 'origin');
const syncCommand = flag('sync-command', 'npm run sync:hooks');

const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};

const git = (...argv) => spawnSync('git', argv, { encoding: 'utf8' });

const gitOrFail = (...argv) => {
  const result = git(...argv);
  if (result.status !== 0) {
    fail(`git ${argv.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return (result.stdout ?? '').trim();
};

if (!branch) {
  fail('--branch is required');
}

// ONLY EVER A BRANCH RELEASE-PLEASE OWNS. This path force-commits to whatever it is
// handed, so the guard is two dashes, matching release.yml: a single-star
// `release-please*` would also admit `release-please-maintenance`.
if (!branch.startsWith('release-please--')) {
  fail(
    `refusing to sync '${branch}': only release-please--* branches are amended automatically`
  );
}

// THE CHECK THAT WAS MISSING. A merged release PR has had its branch deleted, and a
// merged release is a success -- there is nothing to amend and nothing to report as
// broken. Asking the remote costs one round trip and turns the production failure
// into a no-op.
const exists = git('ls-remote', '--heads', remote, `refs/heads/${branch}`);
if (exists.status !== 0) {
  fail(`could not reach ${remote}: ${exists.stderr || exists.stdout}`);
}

if (!exists.stdout.trim()) {
  console.log(
    `${branch} no longer exists on ${remote} -- the release PR was already merged. Nothing to sync.`
  );
  process.exit(0);
}

// Work on a detached copy of the remote branch. Deliberately NOT `git checkout
// <branch>`: the workflow's checkout has a refspec for the base branch only, so a
// local branch of that name may not exist, and creating one risks picking up
// whatever the local ref happens to point at.
gitOrFail('fetch', remote, branch);
const head = gitOrFail('rev-parse', 'FETCH_HEAD');
gitOrFail('checkout', '--detach', head);

const sync = spawnSync(syncCommand, { shell: true, stdio: 'inherit' });
if (sync.status !== 0) {
  // A broken generator must never read as "nothing to sync": that would ship a
  // release whose pins name the previous version.
  fail(`sync command failed (exit ${sync.status}): ${syncCommand}`);
}

// `git status --porcelain`, NOT `git diff --quiet`: diff does not see untracked
// files, and `commit -am` does not stage them. A sync that ADDS a config -- a new
// client integration -- therefore read as "already match" and pushed nothing, which
// would ship a release missing the new file with no error anywhere.
const status = gitOrFail('status', '--porcelain');
if (!status) {
  console.log(`pinned specs on ${branch} already match the release version.`);
  process.exit(0);
}

console.log('Pinned specs updated by the sync:');
console.log(status);

gitOrFail('add', '-A');
gitOrFail('-c', 'user.name=github-actions[bot]', '-c',
  'user.email=41898282+github-actions[bot]@users.noreply.github.com',
  'commit', '-m', 'chore: sync pinned specs to the release version');

// THE SAME MERGE RACE AS ABOVE, at the other end. The existence check happens before
// the sync runs; the sync takes long enough (an npm install and four generators) for
// the release PR to be merged in the meantime.
//
// A plain push would then RECREATE the deleted branch -- measured: it did, and a
// resurrected branch can reopen a closed release PR. And if the branch had instead
// advanced, a plain push is rejected non-fast-forward and exits 1, which is the red
// release job this script exists to prevent.
//
// --force-with-lease bound to the exact head we fetched refuses both: the lease no
// longer holds, so nothing is written. That is a no-op, not a failure -- the next
// release-please run syncs again.
const pushed = git(
  'push',
  remote,
  `HEAD:refs/heads/${branch}`,
  `--force-with-lease=${branch}:${head}`
);

if (pushed.status !== 0) {
  const detail = `${pushed.stderr || ''}${pushed.stdout || ''}`;
  if (/stale info|fetch first|non-fast-forward|rejected/i.test(detail)) {
    console.log(
      `${branch} moved or was merged while the sync ran, so nothing was pushed. ` +
        'The next release-please run will sync it.'
    );
    process.exit(0);
  }

  fail(`git push failed:\n${detail}`);
}

console.log(`pushed the pin sync to ${branch}.`);
