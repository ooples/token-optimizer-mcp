import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

/**
 * A LESSON LEARNED IN ONE PROJECT MUST BE AVAILABLE IN THE NEXT ONE.
 *
 * Every graph in this system is keyed on the project a file belongs to. That is
 * correct for a claim about that file and wrong for a claim about the tools, and
 * the cost was measured across five repositories in one session: structural
 * capture worked in all of them (31, 30 and 12 capture events in three fresh
 * checkouts) while all 35 live lessons sat in ONE project's graph. "Run npm test,
 * not npx jest" was therefore available to be re-learned from scratch in every
 * other checkout on the machine.
 *
 * The tier added here carries only what does not depend on a repository's
 * contents -- the exact complement of staleness.mjs's CONTENT_DEPENDENT set -- so
 * a `command` or `failure` crosses and a `finding` about a file does not.
 *
 * THE SUITE DRIVES THE REAL HOOK. This project has twice shipped a feature that
 * was fully implemented, fully unit-tested, and called by nothing: `forTouch` and
 * the semantic harvest were both dead on arrival, and green unit tests said
 * otherwise both times. So the load-bearing cases here spawn
 * pretooluse-router.mjs and read its stdout, which is the only thing that can
 * fail when the wiring is missing.
 */

const ROUTER = join(process.cwd(), 'plugin', 'hooks', 'pretooluse-router.mjs');
const CORE = (n) => pathToFileURL(join(process.cwd(), 'hooks-core', n)).href;

let writeHarvested, sharedDirOf, loadGraph;

beforeEach(async () => {
  ({ writeHarvested } = await import(CORE('harvest-write.mjs')));
  const wiki = await import(CORE('wiki.mjs'));
  sharedDirOf = wiki.sharedDir;
  loadGraph = wiki.load;
});

let projectA, projectB, wikiA, wikiB, shared, stateDir;

beforeEach(() => {
  projectA = mkdtempSync(join(tmpdir(), 'shared-projA-'));
  projectB = mkdtempSync(join(tmpdir(), 'shared-projB-'));
  // These fixtures stand in for the repositories the docstring above describes, so
  // they carry a VCS marker. Without one, projectRootFor resolves them to the
  // machine-wide unrooted graph instead of to themselves, and the "learned here"
  // identity these tests turn on collapses -- projectA would no longer recognise
  // its own lesson and would be told about it as foreign news.
  mkdirSync(join(projectA, '.git'), { recursive: true });
  mkdirSync(join(projectB, '.git'), { recursive: true });
  wikiA = join(projectA, '.token-optimizer', 'wiki');
  wikiB = join(projectB, '.token-optimizer', 'wiki');
  mkdirSync(wikiA, { recursive: true });
  mkdirSync(wikiB, { recursive: true });
  shared = mkdtempSync(join(tmpdir(), 'shared-tier-'));
  stateDir = mkdtempSync(join(tmpdir(), 'shared-state-'));
  process.env.TOKEN_OPTIMIZER_SHARED_DIR = shared;
});

afterEach(() => {
  delete process.env.TOKEN_OPTIMIZER_SHARED_DIR;
  for (const d of [projectA, projectB, shared, stateDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* windows can hold a handle briefly */
    }
  }
});

/** Teaches project A a lesson, exactly as the harvest worker would. */
function learnIn(root, wikiDirOf, finding) {
  const file = join(root, 'build.js');
  writeFileSync(file, 'module.exports = 1;\n');
  return writeHarvested(
    wikiDirOf,
    [{ ...finding, anchors: [file] }],
    { sessionId: 'learn', projectRoot: root }
  );
}

/** Runs a Bash command through the REAL hook, inside project B. */
function runCommandIn(root, command, { sessionId = 'use' } = {}) {
  const result = spawnSync(process.execPath, [ROUTER], {
    input: JSON.stringify({
      cwd: root,
      session_id: sessionId,
      tool_name: 'Bash',
      tool_input: { command },
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_SHARED_DIR: shared,
      TOKEN_OPTIMIZER_STATE_DIR: stateDir,
      TOKEN_OPTIMIZER_HOLDOUT: '0',
    },
    timeout: 30_000,
  });
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout || '{}');
  return parsed.hookSpecificOutput?.additionalContext ?? '';
}

const NPM_LESSON = {
  type: 'command',
  claim: 'Run the suite with npm test, not npx jest: bare npx jest skips every ESM suite and reports green.',
  confidence: 0.9,
  trigger: 'jest',
};

describe('a lesson learned in one project', () => {
  test('is served in a DIFFERENT project on the command it applies to', () => {
    // The whole feature in one assertion. Project B has never seen this lesson,
    // has its own empty graph, and shares nothing with A but the machine.
    expect(learnIn(projectA, wikiA, NPM_LESSON)).toHaveLength(1);

    const context = runCommandIn(projectB, 'npx jest tests/unit');

    expect(context).toContain('npm test');
    expect(context).toContain('From other projects on this machine');
  });

  test('names the project it came from, so transfer can be judged', () => {
    // A lesson from another codebase is worth surfacing and is NOT automatically
    // true here. Stating its origin is what lets the reader decide; hedging
    // wording was measured on this project suppressing correct findings 2:1, so
    // the origin is given as a fact instead of a warning.
    learnIn(projectA, wikiA, NPM_LESSON);

    const context = runCommandIn(projectB, 'npx jest');

    expect(context).toMatch(/learned in .*shared-projA/);
  });

  test('does NOT cross when the claim is about a file, not the work', () => {
    // The whole basis of the split. A `finding` is a claim about its anchor's
    // CONTENTS, so carrying it to another repository would assert something about
    // files that repository does not have.
    learnIn(projectA, wikiA, {
      type: 'finding',
      claim: 'parse() trims its input before returning, and callers depend on it',
      confidence: 0.9,
      trigger: 'jest',
    });

    const context = runCommandIn(projectB, 'npx jest');

    expect(context).not.toContain('parse() trims');
  });

  test('is not read back to the project that taught it, as foreign news', () => {
    // Project A's own local path already serves this. Repeating it under a "from
    // other projects" heading would double the tokens AND misstate its origin.
    learnIn(projectA, wikiA, NPM_LESSON);

    const context = runCommandIn(projectA, 'npx jest');

    expect(context).not.toContain('From other projects on this machine');
  });

  test('does not fire on an unrelated command', () => {
    // The trigger is the whole retrieval mechanism here; without this assertion
    // the feature could pass every test above by attaching to everything.
    learnIn(projectA, wikiA, NPM_LESSON);

    const context = runCommandIn(projectB, 'git status --short');

    expect(context).not.toContain('From other projects on this machine');
  });

  test('the same lesson learned twice is stored once', () => {
    // Two repos teaching the same thing is evidence it generalises, not a reason
    // to say it twice on every command.
    learnIn(projectA, wikiA, NPM_LESSON);
    learnIn(projectB, wikiB, NPM_LESSON);

    const findings = [...loadGraph(sharedDirOf()).nodes.values()].filter(
      (n) => n.kind === 'finding'
    );

    expect(findings).toHaveLength(1);
  });

  test('is capped, so cross-project noise cannot crowd out local knowledge', () => {
    // Five applicable lessons, at most two carried. A weaker signal than the
    // project's own findings must never dominate the response.
    for (let i = 0; i < 5; i++) {
      learnIn(projectA, wikiA, {
        ...NPM_LESSON,
        claim: `jest lesson number ${i}: something specific about running it`,
      });
    }

    const context = runCommandIn(projectB, 'npx jest');
    const lines = context.split('\n').filter((l) => l.startsWith('- ['));

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  test('records an inject event, so its tokens appear in the balance sheet', async () => {
    // A TIER THAT SPENDS TOKENS SILENTLY OVERSTATES THE SAVING. The balance sheet
    // is built from `inject` events; text delivered without one is cost the
    // report cannot see, and an overstated saving is the one number this project
    // must never produce. Caught in review, not by me.
    learnIn(projectA, wikiA, NPM_LESSON);

    const context = runCommandIn(projectB, 'npx jest');
    expect(context).toContain('From other projects');

    // Read off disk rather than through a helper: the balance sheet is built
    // from these bytes, so the bytes are what the assertion should be about.
    const { readFileSync, existsSync } = await import('node:fs');
    const path = join(wikiB, 'metrics.jsonl');
    expect(existsSync(path)).toBe(true);
    const shared = readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e) => e && e.kind === 'inject' && e.surface === 'shared');

    expect(shared.length).toBeGreaterThan(0);
    expect(shared[0].tokens).toBeGreaterThan(0);
    expect(shared[0].count).toBeGreaterThan(0);
  });

  test('respects the holdout arm, so the control arm stays a control', () => {
    // The shared tier draws on the SAME key as forCommand. If it delivered while
    // the local path was withheld, the control arm would have received knowledge
    // -- just from another tier -- and every treated-vs-control difference would
    // understate what injection does. This is the measurement defending itself.
    learnIn(projectA, wikiA, NPM_LESSON);

    const result = spawnSync(process.execPath, [ROUTER], {
      input: JSON.stringify({
        cwd: projectB,
        session_id: 'holdout-arm',
        tool_name: 'Bash',
        tool_input: { command: 'npx jest' },
      }),
      encoding: 'utf8',
      env: {
        ...process.env,
        TOKEN_OPTIMIZER_SHARED_DIR: shared,
        TOKEN_OPTIMIZER_STATE_DIR: stateDir,
        // Everything held out. Nothing may be delivered by either tier.
        TOKEN_OPTIMIZER_HOLDOUT: '1',
      },
      timeout: 30_000,
    });

    expect(result.status).toBe(0);
    const context =
      JSON.parse(result.stdout || '{}').hookSpecificOutput?.additionalContext ?? '';

    expect(context).not.toContain('From other projects');
  });

  test('a triggerless feedback lesson still reaches a same-class command', async () => {
    // MEASURED ON THE REAL STORE: 10 of 19 shared lessons could never fire on any
    // command, and ALL FIVE of the `feedback` ones were among them -- because
    // appliesToCommand refuses an untriggered finding that is not `command` or
    // `failure`. Those are the most behaviour-shaping lessons there are, and the
    // shared tier is trigger-only, so they were promoted into a store that could
    // never deliver them.
    //
    // The cross-project matcher therefore also accepts a claim about the same
    // KIND of act as the command. Here: a lesson about trusting a check that
    // printed nothing, against a command that runs a check.
    const file = join(projectA, 'guide.md');
    writeFileSync(file, '# notes\n');
    writeHarvested(
      wikiA,
      [
        {
          type: 'feedback',
          claim:
            'Confirm the sabotage actually applied before trusting a canary result: an edit that silently matched nothing reports PASS, which reads as "the guard works".',
          confidence: 0.9,
          anchors: [file],
        },
      ],
      { sessionId: 'class-seed', projectRoot: projectA }
    );

    const context = runCommandIn(projectB, 'npx jest tests/guard.test.mjs', {
      sessionId: 'class-use',
    });

    expect(context).toContain('sabotage actually applied');
  });

  test('the wider matcher stays silent on commands with no bearing', () => {
    // The cost of matching on act-shape is noise, and noise is how a real signal
    // becomes wallpaper. Reachability is only worth having if this holds.
    writeHarvested(
      wikiA,
      [
        {
          type: 'feedback',
          claim:
            'Confirm the sabotage actually applied before trusting a canary result.',
          confidence: 0.9,
          anchors: [(() => { const f = join(projectA, 'g2.md'); writeFileSync(f, 'x\n'); return f; })()],
        },
      ],
      { sessionId: 'quiet-seed', projectRoot: projectA }
    );

    for (const cmd of ['echo hello', 'ls -la', 'pwd', 'curl https://example.com']) {
      const context = runCommandIn(projectB, cmd, { sessionId: `quiet-${cmd.length}` });
      expect(context).not.toContain('From other projects on this machine');
    }
  });

  test('re-surfaces a lesson when the session keeps doing the same kind of thing', () => {
    // THE ONCE-PER-SESSION GATE IS WHY THIS IS NEEDED. A lesson delivered at the
    // start of a session is suppressed for the rest of it -- correct when the
    // advice landed, wrong when it did not. Measured on this machine: "confirm
    // the sabotage applied before trusting a canary" was served once and the same
    // class of mistake was made six more times that day.
    const file = join(projectA, 'lesson.md');
    writeFileSync(file, '# x\n');
    writeHarvested(
      wikiA,
      [
        {
          type: 'feedback',
          claim:
            'Confirm the sabotage actually applied before trusting a canary result: an edit that silently matched nothing reports PASS.',
          confidence: 0.9,
          anchors: [file],
        },
      ],
      { sessionId: 'rep-seed', projectRoot: projectA }
    );

    const sid = 'repeat-session';
    const seen = [];
    // Three verification-shaped commands in ONE session.
    for (const cmd of ['npx jest a.test.mjs', 'npm test -- b', 'npx tsc --noEmit']) {
      seen.push(runCommandIn(projectB, cmd, { sessionId: sid }));
    }

    // First delivery is the ordinary cross-project one; the reminder arrives on
    // the third act, naming the count -- which is the part the model cannot see.
    expect(seen[2]).toMatch(/You have run 3 verify steps this session/);
  });

  test('the reminder fires once, not on every subsequent call', () => {
    // A reminder that returns forever is the wallpaper the once-per-session gate
    // exists to prevent, rebuilt under another name.
    const file = join(projectA, 'lesson2.md');
    writeFileSync(file, '# x\n');
    writeHarvested(
      wikiA,
      [
        {
          type: 'feedback',
          claim: 'Confirm the sabotage actually applied before trusting a canary result.',
          confidence: 0.9,
          anchors: [file],
        },
      ],
      { sessionId: 'rep2-seed', projectRoot: projectA }
    );

    const sid = 'repeat-once';
    const out = [];
    for (const cmd of ['npx jest a', 'npm test b', 'npx tsc c', 'npm test d', 'npx jest e']) {
      out.push(runCommandIn(projectB, cmd, { sessionId: sid }));
    }

    const reminders = out.filter((o) => /You have run \d+ \w+ steps this session/.test(o));
    expect(reminders).toHaveLength(1);
  });

  test('an absent shared store costs the caller nothing', () => {
    // The tier is an extra. If it cannot be read the tool call must proceed
    // exactly as if the feature were not installed.
    rmSync(shared, { recursive: true, force: true });

    const result = spawnSync(process.execPath, [ROUTER], {
      input: JSON.stringify({
        cwd: projectB,
        session_id: 'no-shared',
        tool_name: 'Bash',
        tool_input: { command: 'npx jest' },
      }),
      encoding: 'utf8',
      env: {
        ...process.env,
        TOKEN_OPTIMIZER_SHARED_DIR: join(shared, 'gone'),
        TOKEN_OPTIMIZER_STATE_DIR: stateDir,
        TOKEN_OPTIMIZER_HOLDOUT: '0',
      },
      timeout: 30_000,
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/Error|ENOENT/);
  });
});
