import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import YAML from 'yaml';

/**
 * The pinned-spec sync must be triggered by an event that actually fires.
 *
 * release-please opens its release PR with GITHUB_TOKEN, and GitHub suppresses
 * workflow runs triggered by that token to prevent recursion. sync-release-pins.yml
 * was wired to `pull_request` and therefore could never run: every attempt sat in
 * `action_required` having executed nothing.
 *
 * The cost was two silent non-releases. v5.4.0 and v5.4.1 were both tagged with
 * GitHub Releases and neither reached npm, because the publish guard correctly
 * refused a version whose client pins still named the previous one. npm stayed on
 * 5.3.6 while master's package.json said 5.4.1 -- a repository that looked released
 * and a registry that had never heard of it.
 *
 * The irony worth keeping: sync-release-pins.yml cited the GITHUB_TOKEN rule in its
 * own header as the reason it could not loop, without noticing the same rule meant it
 * could not start.
 */

const workflow = (name: string) =>
  YAML.parse(readFileSync(join(process.cwd(), '.github', 'workflows', name), 'utf8'));

describe('the release pin sync is reachable', () => {
  it('syncs the pins from inside the release-please job', () => {
    const release = workflow('release.yml');
    const steps = release.jobs['release-please'].steps as Array<Record<string, unknown>>;

    const sync = steps.find((s) => typeof s.run === 'string' && s.run.includes('sync:hooks'));

    expect(sync).toBeDefined();
  });

  it('runs that sync only when release-please actually opened a PR', () => {
    const release = workflow('release.yml');
    const steps = release.jobs['release-please'].steps as Array<Record<string, unknown>>;
    const sync = steps.find((s) => typeof s.run === 'string' && s.run.includes('sync:hooks'));

    // Gated on the PR output: on a merge run there is no PR to amend, and an
    // ungated step would try to push to a branch that no longer exists.
    expect(String(sync?.if ?? '')).toContain('steps.release.outputs.pr');
  });

  it('is triggered by push, which GITHUB_TOKEN does not suppress', () => {
    const release = workflow('release.yml');

    expect(Object.keys(release.on)).toContain('push');
  });

  it('no longer depends on pull_request, which could never fire for a release PR', () => {
    // The specific defect. If a future change reintroduces a pull_request trigger as
    // the sync mechanism, it will silently stop working again -- and the symptom is a
    // tagged release that never publishes, which is easy to miss.
    const sync = workflow('sync-release-pins.yml');

    expect(Object.keys(sync.on)).not.toContain('pull_request');
    expect(Object.keys(sync.on)).toContain('workflow_dispatch');
  });

  it('scopes the manual path to the same strict branch pattern', () => {
    // The two guards must agree. release.yml uses `release-please--*`; the manual
    // workflow used `release-please*`, which also admits `release-please-maintenance`.
    // With the pull_request trigger gone, that case is the ONLY guard on a path that
    // force-commits to whatever branch it is handed.
    const sync = workflow('sync-release-pins.yml');
    const steps = sync.jobs['sync-release-pins'].steps as Array<Record<string, unknown>>;
    const guarded = steps.filter(
      (s) => typeof s.run === 'string' && s.run.includes('release-please')
    );

    expect(guarded.length).toBeGreaterThan(0);
    for (const step of guarded) {
      expect(String(step.run)).not.toMatch(/release-please\*\)/);
    }
  });

  it('still refuses to amend a branch release-please does not own', () => {
    // The sync force-commits to a branch. Both the old workflow and the new step
    // scope that to release-please branches; losing the guard would let a dispatch
    // rewrite an arbitrary contributor's PR.
    const release = workflow('release.yml');
    const steps = release.jobs['release-please'].steps as Array<Record<string, unknown>>;
    const sync = steps.find((s) => typeof s.run === 'string' && s.run.includes('sync:hooks'));

    expect(String(sync?.run ?? '')).toContain('release-please--*');
  });
});
