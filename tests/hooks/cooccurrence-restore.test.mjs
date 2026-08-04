/**
 * Co-occurrence to restoration, end to end.
 *
 * This feature was built complete and connected at neither end. `related` is a
 * declared edge kind; `linkCoOccurrence` is its only producer and was called by
 * nothing, so no graph has ever contained one; `predictNext` is its only
 * consumer, reached solely through `restorationPlan`, which was equally
 * unreachable. Two halves of a working feature, each waiting for the other.
 *
 * So the tests that matter here are not unit tests of either half -- those
 * already passed for the whole time the feature did nothing. They drive the real
 * hooks: PreCompact writes the edges, SessionStart with source=compact spends
 * them, and the assertion is that a file the session never opened comes back
 * recommended because it was worked on alongside one that was.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  wikiDir,
  load,
  putNode,
  putNodeWithEdges,
  nodeId,
} from '../../hooks-core/wiki.mjs';

const PRECOMPACT = join(
  process.cwd(),
  'plugin',
  'hooks',
  'precompact-optimize.mjs'
);
const SESSION_START = join(
  process.cwd(),
  'plugin',
  'hooks',
  'session-start.mjs'
);

let project;
let dir;
let stateRoot;
let session;

/** Seeds the session state the hooks read, as the router would have written it. */
function seenState(paths) {
  const seen = {};
  for (const p of paths) seen[p] = Date.now();
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(
    join(stateRoot, `${session}.json`),
    JSON.stringify({ seen, denied: {}, injected: [] })
  );
}

function run(hook, payload, env = {}) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, TOKEN_OPTIMIZER_STATE_DIR: stateRoot, ...env },
  });
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'cooccur-'));
  mkdirSync(join(project, '.git'), { recursive: true });
  dir = wikiDir(project);
  // The hooks read session state from a fixed location on this branch, so the
  // test writes where they will actually look. The session id is unique per
  // run, which keeps the files from colliding with a real session or with each
  // other.
  stateRoot = join(tmpdir(), 'token-optimizer-hooks');
  session = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
});

afterEach(() => {
  try {
    rmSync(project, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
  // Only this run's own state file -- the directory is shared with real
  // sessions and must not be removed wholesale.
  try {
    rmSync(join(stateRoot, `${session}.json`), { force: true });
  } catch {
    /* already gone */
  }
});

describe('PreCompact writes the related edges', () => {
  it('links files the session worked on together', () => {
    const a = join(project, 'a.ts');
    const b = join(project, 'b.ts');
    writeFileSync(a, 'export const a = 1;\n');
    writeFileSync(b, 'export const b = 2;\n');
    seenState([a, b]);

    // Before: the edge kind is declared and the graph has never held one.
    expect(load(dir).edges.filter((e) => e.edge === 'related')).toHaveLength(0);

    run(PRECOMPACT, { session_id: session, cwd: project });

    const related = load(dir).edges.filter((e) => e.edge === 'related');
    expect(related.length).toBeGreaterThan(0);

    const ids = new Set([nodeId('file', a), nodeId('file', b)]);
    for (const e of related) {
      expect(ids.has(e.from) || ids.has(e.to)).toBe(true);
    }
  }, 60_000);

  it('writes nothing when only one file was touched', () => {
    const a = join(project, 'a.ts');
    writeFileSync(a, 'export const a = 1;\n');
    seenState([a]);

    run(PRECOMPACT, { session_id: session, cwd: project });

    // Two files are the minimum that can co-occur. One would only cost a graph
    // load and record a relationship that does not exist.
    expect(load(dir).edges.filter((e) => e.edge === 'related')).toHaveLength(0);
  }, 60_000);

  it('reaches the wrapper when a plugin root is configured', () => {
    // REGRESSION, AND A LESSON ABOUT FAIL-OPEN CODE. `findWrapper` calls
    // `join`, and its import sat on the line an edit overwrote while adding the
    // co-occurrence imports. That branch runs only when CLAUDE_PLUGIN_ROOT is
    // set -- the configuration every real plugin install uses and no test did.
    //
    // Asserting on exit status or stderr does NOT catch it: `main()` ends in
    // `.catch(() => {})` so a compaction is never delayed, which means the
    // ReferenceError is swallowed and the hook still exits 0 in silence. The
    // only observable difference is that the wrapper is never reached, so that
    // is what this asserts: a stub wrapper is planted where findWrapper looks,
    // and the systemMessage only appears if the hook actually got there.
    const home = mkdtempSync(join(tmpdir(), 'cooccur-home-'));
    mkdirSync(join(home, 'plugin'), { recursive: true });
    writeFileSync(join(home, 'cli-wrapper.mjs'), 'process.exit(0);' + '\n');

    const a = join(project, 'a.ts');
    const b = join(project, 'b.ts');
    writeFileSync(a, 'export const a = 1;\n');
    writeFileSync(b, 'export const b = 2;\n');
    seenState([a, b]);

    const out = run(
      PRECOMPACT,
      { session_id: session, cwd: project },
      { CLAUDE_PLUGIN_ROOT: join(home, 'plugin') }
    );

    expect(out.stdout || '').toContain('token-optimizer: compressed');

    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* windows */
    }
  }, 60_000);

  it('does not invent relationships across two checkouts', () => {
    // The graph is per project. A session spanning two repositories must not
    // relate a file in one to a file in the other -- they have never met.
    const other = mkdtempSync(join(tmpdir(), 'cooccur-other-'));
    mkdirSync(join(other, '.git'), { recursive: true });
    const a = join(project, 'a.ts');
    const z = join(other, 'z.ts');
    writeFileSync(a, 'export const a = 1;\n');
    writeFileSync(z, 'export const z = 3;\n');
    seenState([a, z]);

    run(PRECOMPACT, { session_id: session, cwd: project });

    // One file each side: neither project has a pair, so neither gets an edge.
    expect(load(dir).edges.filter((e) => e.edge === 'related')).toHaveLength(0);
    expect(
      load(wikiDir(other)).edges.filter((e) => e.edge === 'related')
    ).toHaveLength(0);

    try {
      rmSync(other, { recursive: true, force: true });
    } catch {
      /* windows */
    }
  }, 60_000);
});

describe('SessionStart spends them', () => {
  it('recommends a file the session never opened, because a peer was worked on', () => {
    // THE ASSERTION THE WHOLE FEATURE EXISTS FOR. `b.ts` carries a finding and
    // is never in `seen`; it comes back only because the graph learned it is
    // worked on alongside `a.ts`.
    const a = join(project, 'a.ts');
    const b = join(project, 'b.ts');
    writeFileSync(a, 'export const a = 1;\n');
    writeFileSync(b, 'export const b = 2;\n');

    const bNode = putNode(dir, { kind: 'file', key: b, hash: 'h' });
    putNodeWithEdges(
      dir,
      {
        kind: 'finding',
        key: 'about-b',
        claim: 'b.ts owns the retry budget.',
        confidence: 0.95,
      },
      [{ edge: 'derived_from', to: bNode }]
    );

    // The session worked on both, so PreCompact relates them.
    seenState([a, b]);
    run(PRECOMPACT, { session_id: session, cwd: project });

    // Now resume with only `a` in view -- `b` is what must be predicted.
    seenState([a]);
    const out = run(SESSION_START, {
      session_id: session,
      cwd: project,
      source: 'compact',
    });

    const ctx =
      JSON.parse(out.stdout || '{}')?.hookSpecificOutput?.additionalContext ||
      '';
    expect(ctx).toContain('Restored after compaction');
    expect(ctx).toContain('b.ts owns the retry budget');
  }, 90_000);

  it('says nothing on a cold start, so the text is not paid for every session', () => {
    const a = join(project, 'a.ts');
    writeFileSync(a, 'export const a = 1;\n');
    seenState([a]);

    const out = run(SESSION_START, {
      session_id: session,
      cwd: project,
      source: 'startup',
    });
    const ctx =
      JSON.parse(out.stdout || '{}')?.hookSpecificOutput?.additionalContext ||
      '';

    expect(ctx).not.toContain('Restored after compaction');
    // The policy notice still arrives, which is the hook's original job.
    expect(ctx.length).toBeGreaterThan(50);
  }, 60_000);

  it('still emits the policy notice when the graph is unreadable', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'graph.jsonl'), '{not json\n');
    seenState([join(project, 'a.ts')]);

    const out = run(SESSION_START, {
      session_id: session,
      cwd: project,
      source: 'compact',
    });
    expect(out.status).toBe(0);
    const ctx =
      JSON.parse(out.stdout || '{}')?.hookSpecificOutput?.additionalContext ||
      '';
    expect(ctx.length).toBeGreaterThan(50);
  }, 60_000);
});
