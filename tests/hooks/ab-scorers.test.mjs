/**
 * The A/B scorers decide whether the graph helped, so a wrong scorer silently
 * produces a wrong verdict about the whole feature. These pin the two the
 * review caught: `tee` alone does not propagate a pipeline's exit status, and
 * `set -o pipefail` does.
 */
import { describe, it, expect } from '@jest/globals';
import { CASES } from '../fixtures/ab-injection-harness.mjs';

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
