/**
 * A SHARED GRAPH MAY NOT PASS OFF ANOTHER REPOSITORY'S CLAIM AS THIS ONE'S.
 *
 * `forCommand` is the one injection path with no anchor into the current tree:
 * it matches on the command's TEXT. On a per-project graph that is harmless,
 * because every finding in it is about this project. The machine-level graph is
 * different -- `wikiDir()` falls back to it for any directory with no
 * repository marker, and `promoteToShared` also carries findings up into it
 * from named repositories.
 *
 * WHAT THE DISCRIMINATOR IS, AND WHY IT IS NOT SCOPE. The first version of this
 * guard withheld every `project`-scoped finding on a shared graph. That silenced
 * the graph completely for anyone working outside a repository -- where the
 * shared graph is the ONLY graph and project scope is the default state of every
 * ordinary finding -- and took six suites and 21 tests with it, including "a
 * lesson learned in one session reaches the next".
 *
 * The finding that actually travels wrongly is one PROMOTED from a named
 * repository, which `promoteToShared` stamps with `sourceProject`. That stamp
 * says the claim is about another tree. A finding with no stamp was written
 * where we are working, and is ours to serve.
 *
 * Four cases, because each of the first three is a way the rule can be wrong in
 * a different direction, and the fourth keeps the first from passing vacuously.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from '@jest/globals';
import { forCommand } from '../../hooks-core/inject.mjs';
import { load, putNode, putNodeWithEdges, sharedDir } from '../../hooks-core/wiki.mjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const COMMAND = 'npm test';
const TRIGGER = '\\bnpm test\\b';

const PRIOR_HOLDOUT = process.env.TOKEN_OPTIMIZER_HOLDOUT;
process.env.TOKEN_OPTIMIZER_HOLDOUT = '0';
afterAll(() => {
  if (PRIOR_HOLDOUT === undefined) delete process.env.TOKEN_OPTIMIZER_HOLDOUT;
  else process.env.TOKEN_OPTIMIZER_HOLDOUT = PRIOR_HOLDOUT;
});

/** Seeds one finding, anchored to a real file inside `dir`. */
function seed(dir, { key, claim, scope, sourceProject }) {
  const anchorFile = join(dir, 'runner.mjs');
  writeFileSync(anchorFile, 'export function run() {}\n');
  const fileId = putNode(dir, { kind: 'file', key: anchorFile, hash: 'abc' });
  const node = {
    kind: 'finding',
    key,
    claim,
    type: 'command',
    trigger: TRIGGER,
    confidence: 0.9,
    scope,
    origin: 'agent',
  };
  // Only stamped when the case is about a promoted finding, because an absent
  // stamp is itself one of the conditions under test.
  if (sourceProject) node.sourceProject = sourceProject;
  return putNodeWithEdges(dir, node, [{ edge: 'derived_from', to: fileId }]);
}

/** The claims forCommand actually delivered, as one string. */
function deliveredText(dir) {
  const out = forCommand(dir, load(dir), COMMAND, { sessionId: 's1' });
  if (!out) return '';
  return typeof out === 'string' ? out : JSON.stringify(out);
}

describe('forCommand respects where a shared finding came from', () => {
  let shared;
  let local;

  beforeEach(() => {
    shared = sharedDir();
    mkdirSync(shared, { recursive: true });
    local = mkdtempSync(join(tmpdir(), 'scope-local-'));
  });

  afterEach(() => {
    try {
      rmSync(shared, { recursive: true, force: true });
    } catch {
      /* the isolated HOME is torn down by the suite anyway */
    }
    try {
      rmSync(local, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('withholds a project claim promoted from another repository', () => {
    seed(shared, {
      key: 'other-project-only',
      claim: 'FOREIGNCLAIM run the suite through the wrapper',
      scope: 'project',
      sourceProject: join(tmpdir(), 'some-other-checkout'),
    });

    expect(deliveredText(shared)).not.toContain('FOREIGNCLAIM');
  });

  it('delivers a global claim, so the gate is not a blanket refusal', () => {
    seed(shared, {
      key: 'travels-everywhere',
      claim: 'GLOBALCLAIM check the exit code, not the word failed',
      scope: 'global',
      sourceProject: join(tmpdir(), 'some-other-checkout'),
    });

    expect(deliveredText(shared)).toContain('GLOBALCLAIM');
  });

  it('delivers an unstamped claim, because that is work done right here', () => {
    // THE CASE THE FIRST VERSION GOT WRONG. Outside a repository the shared
    // graph is the only graph, so this is the ordinary finding -- and
    // withholding it is what broke six suites.
    seed(shared, {
      key: 'written-in-place',
      claim: 'LOCALCLAIM the suite needs the experimental modules flag',
      scope: 'project',
    });

    expect(deliveredText(shared)).toContain('LOCALCLAIM');
  });

  it('delivers a stamped project claim from a per-project graph', () => {
    // NON-VACUITY for case one: identical seed, identical stamp, identical
    // command -- only the graph differs. A per-project graph vouches for its
    // own contents, so the stamp is irrelevant there. If this fails, case one
    // proved nothing about provenance.
    seed(local, {
      key: 'other-project-only',
      claim: 'FOREIGNCLAIM run the suite through the wrapper',
      scope: 'project',
      sourceProject: join(tmpdir(), 'some-other-checkout'),
    });

    expect(deliveredText(local)).toContain('FOREIGNCLAIM');
  });
});
