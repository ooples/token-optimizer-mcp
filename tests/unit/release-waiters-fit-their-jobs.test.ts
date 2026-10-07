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
const waiters: { job: string; step: string; minutes: number }[] = [];
for (const [name, job] of Object.entries(workflow.jobs))
  for (const step of job.steps ?? []) {
    const minutes = waitMinutesOf(step.run ?? '');
    if (minutes !== null)
      waiters.push({ job: name, step: step.name ?? '(unnamed)', minutes });
  }

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
    // MEASURED, NOT GUESSED: 7.4.0 was not served after 10 minutes and 7.4.1
    // was not installable after 20, so anything at or below 20 is known to be
    // too short rather than merely untested.
    for (const waiter of waiters) expect(waiter.minutes).toBeGreaterThan(20);
  });
});
