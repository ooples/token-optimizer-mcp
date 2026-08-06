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
