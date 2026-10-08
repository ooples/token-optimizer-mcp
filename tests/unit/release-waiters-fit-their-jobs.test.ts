/**
 * EVERY NPM-PROPAGATION WAIT MUST FIT INSIDE THE JOB THAT RUNS IT.
 *
 * Two releases shipped red for the same reason, and the second broke because
 * of how the first was fixed.
 *
 * 7.4.0: `Publish to the MCP registry` polled npm for 10 minutes, npm took
 * longer, the job failed. The package was fine -- npm served it shortly after.
 *
 * 7.4.1: the poll was raised to 30 minutes, but `verify-published` has its OWN
 * waiter on `--wait-minutes`, which nobody touched, so the next release timed
 * out there instead. A fix applied to one instance of a two-instance problem.
 *
 * And twice the raise was nearly inert, because a job's `timeout-minutes` kills
 * it regardless of what its script is willing to wait for: the mcp-registry
 * poll went to 30 under a 15-minute job, and the verification wait went to 45
 * under a 30-minute job.
 *
 * So this asserts the two properties that were violated, on the workflow file
 * itself:
 *
 *   1. every waiter is KNOWN. A new one has to be added here, which is the
 *      check that stops the next "fixed one, missed the other".
 *   2. every waiter's budget is strictly less than its job's timeout, with
 *      room for the work either side of the wait.
 *
 * It is a unit test rather than a bench instrument because it has to run on
 * every push, without a network or a release.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

const WORKFLOW = join(process.cwd(), '.github', 'workflows', 'release.yml');

interface Job {
  'timeout-minutes'?: number;
  steps?: { run?: string; name?: string }[];
}

const workflow = load(readFileSync(WORKFLOW, 'utf8')) as {
  jobs: Record<string, Job>;
};

/** How long a step is prepared to wait, in minutes, or null if it does not. */
function waitMinutesOf(run: string): number | null {
  const flag = /--wait-minutes\s+(\d+)/.exec(run);
  if (flag) return Number(flag[1]);
  // The inline poll writes its budget as a deadline in seconds.
  const deadline = /deadline=\$\(\(\s*\$\(date \+%s\)\s*\+\s*(\d+)\s*\)\)/.exec(
    run
  );
  if (deadline) return Number(deadline[1]) / 60;
  return null;
}

/** Every job step that waits on npm, found rather than listed. */
const waiters: {
  job: string;
  step: string;
  minutes: number;
  pendingOk: boolean;
}[] = [];
for (const [name, job] of Object.entries(workflow.jobs))
  for (const step of job.steps ?? []) {
    const run = step.run ?? '';
    const minutes = waitMinutesOf(run);
    if (minutes !== null)
      waiters.push({
        job: name,
        step: step.name ?? '(unnamed)',
        minutes,
        pendingOk: run.includes('--pending-ok'),
      });
  }

const FOLLOW_UP = join(
  process.cwd(),
  '.github',
  'workflows',
  'verify-latest-release.yml'
);

describe('release waiters fit inside their jobs', () => {
  it('finds every waiter, so a new one cannot be missed', () => {
    // THE CHECK THAT WOULD HAVE CAUGHT 7.4.1. Raising one waiter and leaving
    // the other is only invisible while nobody enumerates them.
    expect(waiters.map((w) => w.job).sort()).toEqual([
      'publish-mcp-registry',
      'verify-published',
    ]);
  });

  it('gives each waiter a job timeout it can actually reach', () => {
    for (const waiter of waiters) {
      const timeout = workflow.jobs[waiter.job]['timeout-minutes'];
      // A job without a timeout inherits the 360-minute default, which is
      // fine; an explicit one shorter than the wait is the trap.
      expect(timeout ?? 360).toBeGreaterThan(waiter.minutes);
      // Plus room for the work either side of the wait -- install, publish,
      // launch -- so the job does not die the minute the wait returns.
      expect((timeout ?? 360) - waiter.minutes).toBeGreaterThanOrEqual(5);
    }
  });

  it('waits long enough to cover what npm has actually taken', () => {
    // MEASURED, NOT GUESSED: 7.4.0 was not served after 10 minutes, 7.4.1 was
    // not installable after 20 and 7.4.2 not after 45, so anything at or below
    // 20 is known to be too short rather than merely untested.
    //
    // A pending-tolerant waiter is exempt because running out of time is not a
    // failure for it -- 7.4.2 proved the queue can outlast any budget worth
    // holding a runner for, so the budget stopped being the thing that decides.
    for (const waiter of waiters) {
      if (waiter.pendingOk) continue;
      expect(waiter.minutes).toBeGreaterThan(20);
    }
  });

  it('never lets a slow npm queue fail the release', () => {
    // 7.4.2 published fine and was reported broken: the waiter could not tell
    // "npm has not processed it yet" from "the artifact does not work", so it
    // filed #466 and #467 against a package that passes this very check.
    const published = waiters.find((w) => w.job === 'verify-published');
    expect(published).toBeDefined();
    expect(published?.pendingOk).toBe(true);
  });

  it('follows up every pending verification somewhere else', () => {
    // THE OTHER HALF, AND THE REASON --pending-ok IS SAFE. Tolerating a pending
    // outcome is only acceptable while something still performs the check; on
    // its own it would silently mean "never verify a published release again".
    const followUp = load(readFileSync(FOLLOW_UP, 'utf8')) as {
      on?: Record<string, unknown>;
      jobs: Record<string, Job>;
    };
    const runs = Object.values(followUp.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.run ?? '');
    const verifies = runs.filter((run) =>
      run.includes('verify:published-launch')
    );
    expect(verifies.length).toBeGreaterThan(0);
    // It checks what npm already serves, so a timeout there is a real defect
    // and must still fail. Tolerating pending in both places would close the
    // loop on nothing.
    for (const run of verifies) expect(run).not.toContain('--pending-ok');
    // And it has to run on its own, without a release to trigger it.
    expect(Object.keys(followUp.on ?? {})).toContain('schedule');
  });
});
