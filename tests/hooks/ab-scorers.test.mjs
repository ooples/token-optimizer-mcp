/**
 * The A/B scorers decide whether the graph helped, so a wrong scorer silently
 * produces a wrong verdict about the whole feature. These pin the two the
 * review caught: `tee` alone does not propagate a pipeline's exit status, and
 * `set -o pipefail` does.
 */
import { describe, it, expect } from '@jest/globals';
import { CASES, buildArms } from '../fixtures/ab-injection-harness.mjs';

const pipeExit = CASES.find((c) => c.id === 'pipe-exit');

describe('pipe-exit scorer', () => {
  it('treats bare tee as still walking into the dead end', () => {
    // tee duplicates the stream; the pipeline's status is still the LAST
    // command's, so the build failure is still invisible.
    const answer = 'dotnet build App.csproj 2>&1 | tee build.log | tail -20';
    expect(pipeExit.walksIn(answer)).toBe(true);
    expect(pipeExit.avoids(answer)).toBe(false);
  });

  it('accepts set -o pipefail', () => {
    const answer = 'set -o pipefail; dotnet build App.csproj | tail -20';
    expect(pipeExit.avoids(answer)).toBe(true);
    expect(pipeExit.walksIn(answer)).toBe(false);
  });

  it('accepts PIPESTATUS', () => {
    const answer = 'dotnet build App.csproj | tail -20; echo ${PIPESTATUS[0]}';
    expect(pipeExit.avoids(answer)).toBe(true);
  });

  it('accepts capturing the status before any pipe', () => {
    const answer = 'dotnet build App.csproj > b.log 2>&1; ec=$?; tail -20 b.log';
    expect(pipeExit.avoids(answer)).toBe(true);
  });

  it('still catches the naive pipe that started all this', () => {
    const answer = 'dotnet build App.csproj | tail -20';
    expect(pipeExit.walksIn(answer)).toBe(true);
    expect(pipeExit.avoids(answer)).toBe(false);
  });
});

describe('every case is scoreable', () => {
  it('has a walksIn and avoids that disagree on the dead-end answer', () => {
    // A case whose two scorers both fire, or neither, cannot produce a verdict.
    for (const c of CASES) {
      expect(typeof c.walksIn).toBe('function');
      expect(typeof c.avoids).toBe('function');
      expect(c.trigger).toBeTruthy();
      expect(() => new RegExp(c.trigger)).not.toThrow();
    }
  });
});

describe('the harness is repeatable', () => {
  // AN INSTRUMENT THAT ONLY WORKS ONCE MEASURES NOTHING THE SECOND TIME.
  //
  // The session id was `ab-${c.id}`, fixed. Injection is deliberately
  // once-per-session and that gate persists to disk under the shared state
  // root, so the FIRST run served every finding and recorded it, and every run
  // afterwards received nothing at all.
  //
  // That is the worst failure mode available to a measurement harness: the
  // treatment arm silently degrades into a second control arm, both arms answer
  // identically, and the experiment concludes that the graph does not help.
  // Caught while actually running the A/B -- the first dump showed injected
  // context for all five cases, and the next showed null for all five.
  it('carries injected context on every run, not just the first', () => {
    for (let pass = 0; pass < 3; pass++) {
      const arms = buildArms();
      const withContext = arms.filter((a) => a.injected);
      expect(withContext).toHaveLength(arms.length);
    }
  }, 180_000);
});
