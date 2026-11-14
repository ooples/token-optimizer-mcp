/**
 * CLOSING A PR MUST NOT CANCEL MASTER'S OWN CI.
 *
 * cancel-on-pr-close.yml evicts a closed PR's in-flight runs by joining the
 * heavy workflows' concurrency groups with cancel-in-progress. It built those
 * group keys from `${{ github.ref }}`. On an open PR that is
 * `refs/pull/<n>/merge`, but on a CLOSED pull_request event it is the base
 * branch, `refs/heads/master`. So every merge put the eviction jobs in master's
 * own groups, and the push CI and Quality Gates for the merge commit were
 * cancelled within seconds. On 2026-11-14 that happened for the #586 and #588
 * merges, with the annotation "Canceling since a higher priority waiting
 * request for CI-refs/heads/master exists".
 *
 * This asserts on the workflow file itself: every eviction group targets the
 * PR's merge ref by number, matches a heavy workflow's group shape, and can
 * never evaluate to a branch ref.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

const DIR = join(process.cwd(), '.github', 'workflows');

interface Workflow {
  name?: string;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: Record<
    string,
    { concurrency?: { group?: string; 'cancel-in-progress'?: boolean } }
  >;
}

const read = (file: string): Workflow =>
  load(readFileSync(join(DIR, file), 'utf8')) as Workflow;

const evictor = read('cancel-on-pr-close.yml');
const evictions = Object.entries(evictor.jobs).filter(
  ([, job]) => job.concurrency?.['cancel-in-progress'] === true
);

describe('the PR-close eviction jobs', () => {
  it('exist', () => {
    expect(evictions.map(([id]) => id).sort()).toEqual([
      'evict-ci-group',
      'evict-quality-gates-group',
    ]);
  });

  it.each(evictions)('%s never keys on github.ref', (_id, job) => {
    const group = job.concurrency?.group ?? '';
    // github.ref is the base branch on a closed PR: master's own group.
    expect(group).not.toContain('github.ref');
    expect(group).toMatch(
      /-refs\/pull\/\$\{\{ github\.event\.pull_request\.number \}\}\/merge$/
    );
  });

  it.each([
    ['ci.yml', 'evict-ci-group'],
    ['quality-gates.yml', 'evict-quality-gates-group'],
  ])('%s is evicted by %s under the group its PR runs use', (file, jobId) => {
    const heavy = read(file);
    // The heavy workflow's group, as evaluated for an open PR's run.
    expect(heavy.concurrency?.group).toBe(
      '${{ github.workflow }}-${{ github.ref }}'
    );
    expect(heavy.concurrency?.['cancel-in-progress']).toBe(true);
    expect(evictor.jobs[jobId].concurrency?.group).toBe(
      `${heavy.name}-refs/pull/\${{ github.event.pull_request.number }}/merge`
    );
  });
});
