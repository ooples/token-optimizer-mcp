/**
 * A SHARED GRAPH CANNOT VOUCH FOR A PROJECT CLAIM.
 *
 * `forCommand` is the one injection path with no anchor into the current tree:
 * it matches on the command's TEXT. On a per-project graph that is harmless,
 * because every finding in it is about this project. On the machine-level
 * shared graph -- which is where findings land for any file with no repository
 * marker above it, and which a benchmark rig may mount across repositories --
 * it means a `project`-scoped conclusion from an unrelated checkout is a
 * candidate for every command run here.
 *
 * The proxy's own delivery path already guards this (TRANSFERABLE_SCOPES in
 * src/compress/knowledge.ts), and `forRepeatedAct` / `forSharedCommand` refuse
 * a shared graph outright. `forCommand` and `forTouch` did neither.
 *
 * THE THIRD CASE IS THE POINT. A test that only asserts "the project claim did
 * not arrive on a shared graph" passes just as well when the finding never
 * matched the command at all -- the commonest way a guard test goes vacuous
 * here. So the same seed is also injected from a NON-shared directory and must
 * arrive, which proves the scope gate is what excluded it and nothing else.
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
function seed(dir, { key, claim, scope }) {
  const anchorFile = join(dir, 'runner.mjs');
  writeFileSync(anchorFile, 'export function run() {}\n');
  const fileId = putNode(dir, { kind: 'file', key: anchorFile, hash: 'abc' });
  return putNodeWithEdges(
    dir,
    {
      kind: 'finding',
      key,
      claim,
      type: 'command',
      trigger: TRIGGER,
      confidence: 0.9,
      scope,
      origin: 'agent',
    },
    [{ edge: 'derived_from', to: fileId }]
  );
}

/** The claims forCommand actually delivered, as one string. */
function deliveredText(dir) {
  const out = forCommand(dir, load(dir), COMMAND, { sessionId: 's1' });
  if (!out) return '';
  return typeof out === 'string' ? out : JSON.stringify(out);
}

describe('forCommand respects finding scope on a shared graph', () => {
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

  it('withholds a project-scoped finding', () => {
    seed(shared, {
      key: 'other-project-only',
      claim: 'PROJECTONLYCLAIM run the suite through the wrapper',
      scope: 'project',
    });

    expect(deliveredText(shared)).not.toContain('PROJECTONLYCLAIM');
  });

  it('still delivers a global-scoped finding, so the gate is not a blanket refusal', () => {
    seed(shared, {
      key: 'travels-everywhere',
      claim: 'GLOBALCLAIM check the exit code, not the word failed',
      scope: 'global',
    });

    expect(deliveredText(shared)).toContain('GLOBALCLAIM');
  });

  it('delivers that same project-scoped finding from a per-project graph', () => {
    // NON-VACUITY: identical seed, identical command, only the directory
    // differs. If this fails, the first case proved nothing about scope.
    seed(local, {
      key: 'other-project-only',
      claim: 'PROJECTONLYCLAIM run the suite through the wrapper',
      scope: 'project',
    });

    expect(deliveredText(local)).toContain('PROJECTONLYCLAIM');
  });
});
