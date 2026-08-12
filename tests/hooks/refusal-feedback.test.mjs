import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

/**
 * A LESSON THE MODEL KEEPS DECLINING MUST STOP BEING DELIVERED.
 *
 * The signal was already in the transcript and nothing read it. Measured on this
 * machine: a shared lesson carrying a build-error baseline was delivered into a
 * different project and the answer said, in plain words, "the 536 figure is
 * HarmonicEngine's baseline for a different build target, and it doesn't
 * transfer." Nothing recorded that, so the same mis-scoped lesson would be
 * delivered forever -- paying its tokens every time to be refused every time.
 *
 * Two refusals retire it, not one: a single hedge can be caution about a claim
 * that is fine here, and retiring on one lets one cautious moment delete
 * knowledge. Two independent sessions declining the same lesson is a fact about
 * the lesson.
 */

const CORE = (n) => pathToFileURL(join(process.cwd(), 'hooks-core', n)).href;

let detectRefusals, recordRefusal, writeHarvested, load, sharedDirOf, forSharedCommand;

beforeEach(async () => {
  ({ detectRefusals, recordRefusal, writeHarvested } = await import(CORE('harvest-write.mjs')));
  const wiki = await import(CORE('wiki.mjs'));
  load = wiki.load;
  sharedDirOf = wiki.sharedDir;
  ({ forSharedCommand } = await import(CORE('inject.mjs')));
});

let projectA, projectB, wikiA, shared;

beforeEach(() => {
  projectA = mkdtempSync(join(tmpdir(), 'ref-a-'));
  projectB = mkdtempSync(join(tmpdir(), 'ref-b-'));
  wikiA = join(projectA, '.token-optimizer', 'wiki');
  mkdirSync(wikiA, { recursive: true });
  mkdirSync(join(projectB, '.token-optimizer', 'wiki'), { recursive: true });
  shared = mkdtempSync(join(tmpdir(), 'ref-shared-'));
  process.env.TOKEN_OPTIMIZER_SHARED_DIR = shared;
  // The assertion below proves retirement stops an otherwise-deliverable
  // lesson. A randomized control-arm silence would not exercise retirement.
  process.env.TOKEN_OPTIMIZER_HOLDOUT = '0';
});

afterEach(() => {
  delete process.env.TOKEN_OPTIMIZER_SHARED_DIR;
  delete process.env.TOKEN_OPTIMIZER_HOLDOUT;
  for (const d of [projectA, projectB, shared]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* windows can hold a handle briefly */
    }
  }
});

const BASELINE = 'Expect 536 pre-existing build errors on a clean HarmonicEngine checkout.';

function seed(claim = BASELINE) {
  const file = join(projectA, 'x.md');
  writeFileSync(file, '# x\n');
  writeHarvested(
    wikiA,
    [
      {
        type: 'command',
        claim,
        confidence: 0.9,
        trigger: 'build',
        scope: 'global',
        anchors: [file],
      },
    ],
    { sessionId: 'seed', projectRoot: projectA }
  );
  return [...load(sharedDirOf()).nodes.values()].find((n) => n.kind === 'finding');
}

const REFUSAL =
  "I don't know the number. The 536 figure is HarmonicEngine's baseline for a " +
  "different build target, and it doesn't transfer to this repo.";

describe('a lesson the model declines', () => {
  test('is detected as refused from the response text', () => {
    const lesson = seed();
    expect(detectRefusals([lesson], REFUSAL)).toContain(lesson.key);
  });

  test('a hedged answer that USES the value is not a refusal', () => {
    // The distinction the whole loop rests on. "Verify before relying on it" is
    // calibration, and punishing it would train the tier to strip exactly the
    // provenance a cross-project fact should carry.
    const lesson = seed();
    const used =
      'The baseline is 536 errors. I do not know it independently for an unnamed ' +
      'checkout, so verify the repo matches before relying on it.';
    expect(detectRefusals([lesson], used)).toHaveLength(0);
  });

  test('one refusal records but does not retire', () => {
    const lesson = seed();
    const r = recordRefusal(sharedDirOf(), lesson.key);
    expect(r.refusals).toBe(1);
    expect(r.retired).toBe(false);
  });

  test('two refusals retire it, with the reason recorded', () => {
    const lesson = seed();
    recordRefusal(sharedDirOf(), lesson.key);
    const r = recordRefusal(sharedDirOf(), lesson.key);

    expect(r.retired).toBe(true);
    const stored = [...load(sharedDirOf()).nodes.values()].find(
      (n) => n.kind === 'finding' && n.key === lesson.key
    );
    expect(stored.retiredReason).toMatch(/non-transferable/);
  });

  test('stops being delivered once retired, so it stops costing tokens', () => {
    // The point of the loop. Everything above is bookkeeping unless the retired
    // lesson actually goes quiet on the path that was serving it.
    const lesson = seed();
    const dir = join(projectB, '.token-optimizer', 'wiki');

    const before = forSharedCommand(dir, 'dotnet build App.csproj', {
      alreadyInjected: new Set(),
      projectRoot: projectB,
    });
    expect(before).toContain('536');

    recordRefusal(sharedDirOf(), lesson.key);
    recordRefusal(sharedDirOf(), lesson.key);

    const after = forSharedCommand(dir, 'dotnet build App.csproj', {
      alreadyInjected: new Set(),
      projectRoot: projectB,
    });
    expect(after).toBeNull();
  });

  test('a refusal naming a different lesson does not condemn this one', () => {
    // One refusal in a long answer must not retire every lesson delivered
    // alongside it, so the claim's own distinctive text has to appear.
    const lesson = seed();
    const otherRefusal =
      "The npx cache hash belongs to a different project and doesn't transfer here.";
    expect(detectRefusals([lesson], otherRefusal)).toHaveLength(0);
  });
});
