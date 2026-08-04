/**
 * Findings about ACTIONS have to arrive when the action is taken.
 *
 * Injection was keyed entirely on touching a file. The findings worth the most
 * are about running things, and they are anchored to files nobody opens at the
 * moment they run the command. The case that proved it, from a real session:
 * the graph held "run the suite with npm test, not npx jest", anchored to
 * plugin/hooks/lib/harvest.mjs. The agent ran `npx jest`, lost a test cycle,
 * and the finding never fired -- because it was never going to.
 *
 * These tests pin the trigger path that closes that gap.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { forCommand } from '../../hooks-core/inject.mjs';
import { load, putNodeWithEdges, putNode, nodeId } from '../../hooks-core/wiki.mjs';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let dir;
let anchorFile;

/** Stores a finding anchored to a real file, optionally with a trigger. */
function seed({ key, claim, type = 'command', trigger, confidence = 0.9 }) {
  const fileId = putNode(dir, { kind: 'file', key: anchorFile, hash: 'abc' });
  return putNodeWithEdges(
    dir,
    { kind: 'finding', key, claim, type, trigger, confidence, origin: 'agent' },
    [{ edge: 'derived_from', to: fileId }]
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cmd-inject-'));
  anchorFile = join(dir, 'harvest.mjs');
  writeFileSync(anchorFile, 'export function harvest() {}\n');
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
});

describe('forCommand', () => {
  it('delivers a triggered finding for the command that is about to run', () => {
    seed({
      key: 'f-npm-test',
      claim: 'Run the suite with npm test, not npx jest.',
      trigger: '\\bnpx\\s+jest\\b',
    });

    const out = forCommand(dir, load(dir), 'npx jest tests/unit/foo.test.ts', {
      sessionId: 's1',
    });

    expect(out).toBeTruthy();
    expect(out).toContain('npm test');
  });

  it('stays silent for an unrelated command', () => {
    seed({
      key: 'f-npm-test',
      claim: 'Run the suite with npm test, not npx jest.',
      trigger: '\\bnpx\\s+jest\\b',
    });

    expect(forCommand(dir, load(dir), 'git status', { sessionId: 's1' })).toBeNull();
  });

  it('fires at most once per session for the same finding', () => {
    seed({
      key: 'f-npm-test',
      claim: 'Run the suite with npm test, not npx jest.',
      trigger: '\\bnpx\\s+jest\\b',
    });

    const seen = new Set();
    const first = forCommand(dir, load(dir), 'npx jest a', {
      sessionId: 's1',
      alreadyInjected: seen,
    });
    const second = forCommand(dir, load(dir), 'npx jest b', {
      sessionId: 's1',
      alreadyInjected: seen,
    });

    // Repeating advice on every command is how a real signal becomes wallpaper.
    expect(first).toBeTruthy();
    expect(second).toBeNull();
  });

  it('matches an untriggered command finding on a distinctive token', () => {
    // Findings already in existing graphs have no trigger. They must keep
    // working without a migration.
    seed({
      key: 'f-legacy',
      claim: 'Run the suite with npm test, not npx jest: bare jest skips ESM suites.',
      trigger: undefined,
    });

    expect(forCommand(dir, load(dir), 'npx jest tests/', { sessionId: 's1' })).toBeTruthy();
  });

  it('does not match an untriggered finding on a common word alone', () => {
    seed({
      key: 'f-noisy',
      claim: 'This project should always prefer the other approach when there is a choice.',
      trigger: undefined,
    });

    // Every one of those words is a stopword or too short to be distinctive.
    expect(forCommand(dir, load(dir), 'ls -la', { sessionId: 's1' })).toBeNull();
  });

  it('ignores non-action findings that carry no trigger', () => {
    seed({
      key: 'f-map',
      claim: 'The harvest module builds a digest and calls a cheap model.',
      type: 'map',
      trigger: undefined,
    });

    expect(forCommand(dir, load(dir), 'node harvest.mjs', { sessionId: 's1' })).toBeNull();
  });

  it('honours an explicit trigger even on a map-type finding', () => {
    seed({
      key: 'f-map-trig',
      claim: 'Deploys must run from the deploy kit, never by hand.',
      type: 'map',
      trigger: 'deploy\\.sh',
    });

    expect(forCommand(dir, load(dir), './deploy.sh prod', { sessionId: 's1' })).toBeTruthy();
  });

  it('survives a malformed trigger regex instead of throwing on the hook path', () => {
    seed({
      key: 'f-bad',
      claim: 'Something about running deploys.',
      trigger: '([unclosed',
    });

    // Degrades to a literal substring test rather than taking the hook down --
    // and the fallback must actually DELIVER, not merely avoid throwing. A
    // silent null here would look identical to a passing test while the finding
    // was lost.
    let out;
    expect(() => {
      out = forCommand(dir, load(dir), 'echo ([unclosed', { sessionId: 's1' });
    }).not.toThrow();
    expect(out).toBeTruthy();
    expect(out).toContain('running deploys');
  });

  it('records what it served so the value can be measured', () => {
    seed({
      key: 'f-npm-test',
      claim: 'Run the suite with npm test, not npx jest.',
      trigger: '\\bnpx\\s+jest\\b',
    });

    forCommand(dir, load(dir), 'npx jest', { sessionId: 's1' });

    const metrics = readFileSync(join(dir, 'metrics.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.kind === 'inject');

    expect(metrics.length).toBe(1);
    expect(metrics[0].trigger).toBe('command');
    expect(metrics[0].count).toBe(1);
    expect(metrics[0].tokens).toBeGreaterThan(0);
  });

  it('returns nothing when the graph holds no findings at all', () => {
    expect(forCommand(dir, load(dir), 'npx jest', { sessionId: 's1' })).toBeNull();
  });
});

describe('a model-supplied trigger cannot hang the hook', () => {
  it('refuses a catastrophically backtracking pattern instead of running it', async () => {
    const { safeTrigger } = await import('../../hooks-core/inject.mjs');
    // The classic ReDoS shape: a quantifier applied to a group that already
    // contains one. Neither try/catch nor a timeout helps -- it does not throw,
    // it simply does not return -- so it must never be executed at all.
    expect(safeTrigger('(a+)+b')).toBeNull();
    expect(safeTrigger('(a*)*b')).toBeNull();
    expect(safeTrigger('(?:ab+)+c')).toBeNull();
    expect(safeTrigger('(\d+)*$')).toBeNull();
  });

  it('refuses an absurdly long pattern', async () => {
    const { safeTrigger } = await import('../../hooks-core/inject.mjs');
    expect(safeTrigger('a'.repeat(500))).toBeNull();
  });

  it('still compiles the ordinary triggers this feature exists for', async () => {
    const { safeTrigger } = await import('../../hooks-core/inject.mjs');
    for (const t of ['\bnpx\s+jest\b', 'git\s+push', '\.csproj', 'gh\s+(pr|run)\b', 'dotnet\s+(build|test)']) {
      expect(safeTrigger(t)).toBeInstanceOf(RegExp);
    }
  });

  it('a rejected trigger degrades to a literal match rather than vanishing', () => {
    // The finding must still be deliverable; it just cannot use the regex.
    seed({ key: 'f-redos', claim: 'Something about (a+)+b in a command.', trigger: '(a+)+b' });
    const out = forCommand(dir, load(dir), 'echo (a+)+b', { sessionId: 's1' });
    expect(out).toBeTruthy();
  });

  it('does not consider an unbounded number of findings for one command', () => {
    // serve() re-reads and diffs each candidate's anchor, so an uncapped list
    // turns one command into one file read per matching finding, on the hook
    // path, with the user waiting.
    for (let i = 0; i < 60; i++) {
      seed({ key: `bulk-${i}`, claim: `Bulk finding ${i} about jest.`, trigger: 'jest' });
    }
    const seen = new Set();
    const out = forCommand(dir, load(dir), 'npx jest', { sessionId: 's1', alreadyInjected: seen });
    expect(out).toBeTruthy();
    // The budget trims further; the cap is what bounds the WORK done first.
    expect(seen.size).toBeLessThanOrEqual(20);
  });
});
