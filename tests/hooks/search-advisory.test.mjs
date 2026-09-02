/**
 * The graph answering a search before it runs.
 *
 * WHAT THIS SUITE IS REALLY GUARDING. The product captured 526 records on a
 * benchmark task and advised nothing: everything it shipped subtracted from
 * what the model reads, and none of it converted the graph into a fact stated
 * at the moment the model would otherwise go looking. These tests are what stop
 * that regressing, and two of them exist because the first implementation was
 * wrong in exactly that way.
 *
 * THE LOAD-BEARING TEST IS `both paths`. A Grep is only refused when smart_grep
 * is proven present, which is the ordinary state of a real plugin install --
 * so an advisory wired solely into the allowed path fires for the benchmark arm
 * (no MCP server) and NEVER for a properly installed user. A suite that checked
 * only the allowed path would have passed on a feature that did not exist for
 * anybody who bought it.
 *
 * THE OTHER IS `a real project`. The first seed managed 26 files of this
 * repository in 1,221 ms and hit its deadline, so every query about a file it
 * had not reached came back silent. It passed a toy fixture perfectly. Fixture
 * scale is not evidence of a working index, so the throughput assertion is
 * measured against a genuine tree.
 */

import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { identifiersIn, adviseSearch, SESSION_CAP } from '../../hooks-core/advise.mjs';
import { seedProject, alreadySeeded, seedDisabled } from '../../hooks-core/seed.mjs';
import { load, withBatchedWrites, putNode, putEdge } from '../../hooks-core/wiki.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const ROUTER = join(REPO, 'plugin', 'hooks', 'pretooluse-router.mjs');

let workspace;
let graphDir;
let graph;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'advisory-ws-'));
  mkdirSync(join(workspace, 'pipeline'), { recursive: true });
  mkdirSync(join(workspace, 'node_modules', 'dep'), { recursive: true });

  writeFileSync(
    join(workspace, 'pipeline', 'parse.py'),
    [
      'def parse_line(raw):',
      '    parts = raw.split(",")',
      '    return {"id": parts[0]}',
      '',
      '',
      'def parse_all(lines):',
      '    return [parse_line(line) for line in lines]',
      '',
    ].join('\n')
  );
  writeFileSync(
    join(workspace, 'pipeline', 'clean.py'),
    ['def normalise_record(record):', '    return record', ''].join('\n')
  );
  // Must never be indexed: it would put a dependency's symbols into answers
  // about the user's own code.
  writeFileSync(
    join(workspace, 'node_modules', 'dep', 'index.js'),
    'function parse_line() {}\n'
  );

  graphDir = mkdtempSync(join(tmpdir(), 'advisory-graph-'));
  seedProject(graphDir, workspace);
  graph = load(graphDir);
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(graphDir, { recursive: true, force: true });
});

describe('reading a search pattern', () => {
  test('a bare identifier is found', () => {
    expect(identifiersIn('parse_line')).toEqual(['parse_line']);
  });

  test('regex escapes do not become identifiers', () => {
    // `\bdef parse_line\b` yielded `bdef`: the lookbehind sees a backslash,
    // which is not a word character, so it starts happily inside the escape. A
    // junk name is not merely wasted -- it can collide with a real symbol.
    expect(identifiersIn('\\bdef parse_line\\b')).toEqual(['parse_line']);
    expect(identifiersIn('\\d{3}\\s+\\w')).toEqual([]);
  });

  test('language keywords are not looked up', () => {
    expect(identifiersIn('def class return')).toEqual([]);
  });

  test('short runs are ignored', () => {
    expect(identifiersIn('a bc')).toEqual([]);
  });

  test('the pattern is never executed as a regex', () => {
    // A catastrophic-backtracking pattern reaching our own engine is the class
    // this repository keeps a linearity gate for. Scanning must be linear and
    // must not compile the input.
    const started = Date.now();
    expect(() => identifiersIn(`${'a'.repeat(20_000)}!`)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(250);
  });

  test('malformed and empty patterns are handled, not thrown on', () => {
    for (const evil of ['', '[[[', '(((', '\\', '*', null, undefined, 42]) {
      expect(() => identifiersIn(evil)).not.toThrow();
    }
  });
});

describe('what the index answers', () => {
  test('a known symbol yields its file and line span', () => {
    const advice = adviseSearch(graph, 'parse_line', { root: workspace });
    expect(advice).not.toBeNull();
    expect(advice.text).toContain('parse_line -> pipeline/parse.py:1');
  });

  test('in-file callers are named', () => {
    const advice = adviseSearch(graph, 'parse_line', { root: workspace });
    expect(advice.text).toContain('parse_all');
  });

  test('an unknown symbol is silence, not a guess', () => {
    // Substring sweeping is what turns an answer into a second set of search
    // results -- longer than the budget, wrong more often than right, and
    // indistinguishable from something we verified.
    expect(adviseSearch(graph, 'parse', { root: workspace })).toBeNull();
    expect(adviseSearch(graph, 'TODO|FIXME', { root: workspace })).toBeNull();
  });

  test('a fact is never stated twice', () => {
    const told = new Set();
    const first = adviseSearch(graph, 'parse_line', { told, root: workspace });
    expect(first).not.toBeNull();
    for (const fact of first.facts) told.add(fact);
    expect(adviseSearch(graph, 'parse_line', { told, root: workspace })).toBeNull();
  });

  test('the explanation is paid for once, not per advisory', () => {
    const withTrailer = adviseSearch(graph, 'parse_line', {
      root: workspace,
      firstOfSession: true,
    });
    const without = adviseSearch(graph, 'parse_line', { root: workspace });
    expect(withTrailer.text).toContain('local symbol index');
    expect(without.text).not.toContain('local symbol index');
    // The whole economic case is that an advisory is a small fraction of the
    // turn it saves. A repeated paragraph would multiply the only real cost.
    expect(Buffer.byteLength(without.text)).toBeLessThan(200);
  });

  test('a symbol from another tree is never reported', () => {
    // THE SAFETY ARGUMENT FOR SEEDING UNROOTED PROJECTS. A directory with no
    // VCS marker shares one machine-level graph with every other unrooted
    // session on the host, and even a rooted graph acquires foreign file nodes
    // through resolved imports. Blocking the seed was the first attempt and was
    // wrong twice: it disabled the feature for anyone working outside a
    // repository, and it did not fix the hazard, since ordinary capture writes
    // to that same store. The hazard is fixed here, where it happens.
    //
    // A foreign symbol is the worst kind of wrong answer, because it is
    // indistinguishable from a correct one.
    const elsewhere = mkdtempSync(join(tmpdir(), 'advisory-elsewhere-'));
    try {
      expect(
        adviseSearch(graph, 'parse_line', { root: workspace, scope: elsewhere })
      ).toBeNull();
      // Same graph, same query, correct scope: the answer is there.
      expect(
        adviseSearch(graph, 'parse_line', { root: workspace, scope: workspace })
      ).not.toBeNull();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('scoping survives separator and case differences', () => {
    // A graph written on Windows holds backslashes while a payload's cwd may
    // arrive either way, and `C:/Repo` and `c:/repo` are one directory. Getting
    // this wrong silences every answer rather than failing loudly.
    const slashed = workspace.replace(/\\/g, '/');
    for (const variant of [slashed, slashed.toUpperCase(), `${slashed}/`]) {
      expect(
        adviseSearch(graph, 'parse_line', { root: workspace, scope: variant })
      ).not.toBeNull();
    }
  });

  test('an empty graph says nothing', () => {
    expect(adviseSearch({ nodes: new Map(), edges: [] }, 'parse_line', {})).toBeNull();
  });
});

describe('seeding a project', () => {
  test('the project index exists before the model has read anything', () => {
    const names = [...graph.nodes.values()]
      .filter((node) => node.kind === 'symbol')
      .map((node) => node.name)
      .sort();
    expect(names).toEqual(['normalise_record', 'parse_all', 'parse_line']);
  });

  test('dependencies are not indexed as the user\'s code', () => {
    const keys = [...graph.nodes.values()].map((node) => String(node.key || ''));
    expect(keys.some((key) => key.includes('node_modules'))).toBe(false);
  });

  test('no snapshots are written, so the index is not a copy of the repo', () => {
    // 974 KB of snapshots against a 161 KB graph for 26 files, nearly all about
    // files the model never opens -- and the refusal path parses that sidecar
    // in full. A file that comes into play is re-indexed with its snapshot by
    // the ordinary capture path.
    const sidecar = join(graphDir, 'snapshots.jsonl');
    expect(existsSync(sidecar) && readFileSync(sidecar, 'utf8').trim().length > 0).toBe(false);
  });

  test('a warm graph is not re-seeded', () => {
    expect(alreadySeeded(graph, 3)).toBe(true);
    expect(alreadySeeded({ nodes: new Map(), edges: [] })).toBe(false);
  });

  test('the deadline is honoured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'advisory-deadline-'));
    try {
      // Zero budget: the walk must stop rather than run to completion.
      const result = seedProject(dir, REPO, { budgetMs: 0 });
      expect(result.stopped).toBe('deadline');
      expect(result.files).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unusable root is refused before any filesystem call', () => {
    // U+10FFFF ABORTS the process inside libuv rather than throwing, so no
    // try/catch in the walk could contain it -- the guard has to come before
    // the syscall. `isFsSafePath` is deliberately narrow and refuses only this,
    // because every other malformed path throws catchably.
    expect(seedProject(graphDir, '').stopped).toBe('unusable-root');
    expect(seedProject(graphDir, `C:/x/\u{10FFFF}`).stopped).toBe('unusable-root');
  });

  test('a root that is merely absent or malformed costs nothing', () => {
    // Distinct from unusable: these are well-formed enough to hand to the
    // filesystem, so the walk starts, finds nothing readable, and stops. It
    // must not throw and must not seed.
    for (const root of [join(tmpdir(), 'advisory-absent-xyz'), 'bad\u0000path']) {
      const result = seedProject(graphDir, root);
      expect(result.files).toBe(0);
      expect(result.stopped).toBe('complete');
    }
  });

  test('the shared lesson tier is never used as a project index', () => {
    // `sharedDir` holds only lessons that hold in ANY repository -- per machine,
    // per user, following the person rather than the code. File and symbol
    // nodes are the opposite kind of fact, and seeding them there would put one
    // checkout's paths into every other checkout's briefing.
    const shared = mkdtempSync(join(tmpdir(), 'advisory-shared-'));
    const previous = process.env.TOKEN_OPTIMIZER_SHARED_DIR;
    process.env.TOKEN_OPTIMIZER_SHARED_DIR = shared;
    try {
      expect(seedProject(shared, workspace).stopped).toBe('shared-tier');
      expect(load(shared).nodes.size).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.TOKEN_OPTIMIZER_SHARED_DIR;
      else process.env.TOKEN_OPTIMIZER_SHARED_DIR = previous;
      rmSync(shared, { recursive: true, force: true });
    }
  });

  test('the kill switch is honoured', () => {
    expect(seedDisabled({ TOKEN_OPTIMIZER_SEED: '0' })).toBe(true);
    expect(seedDisabled({ TOKEN_OPTIMIZER_SEED: 'off' })).toBe(true);
    expect(seedDisabled({})).toBe(false);
  });

  test('a real project is indexed within the budget, not a tenth of one', () => {
    // THE REGRESSION THIS EXISTS FOR. Unbatched, each record cost a lock, an
    // append, a compaction check and an unlink -- 1.3 ms apiece -- so seeding
    // reached 26 files of this repository in 1,221 ms and every query about
    // anything further in came back silent. The toy fixture above passed
    // throughout. Scale is the only thing that catches it.
    const dir = mkdtempSync(join(tmpdir(), 'advisory-real-'));
    try {
      // CALIBRATED ON THIS MACHINE, NOT AGAINST A WALL-CLOCK CONSTANT. The
      // property under test is that the batch is applied -- ~350 files/sec
      // with it against ~21/sec without, a 16x gap. Encoding that as "under
      // 4,000 ms" measures the machine instead: the full suite runs in
      // parallel, and this failed at 4,372 ms while still achieving 45.7
      // files/sec, comfortably twice the unbatched rate. Raising the budget
      // would have hidden the real regression by exactly as much as it hid the
      // load.
      //
      // So time the unbatched primitive here, under whatever load this run is
      // under, and require the batched path to beat it by a wide margin. Both
      // measurements pay the same tax, so the ratio is what survives.
      const calDir = mkdtempSync(join(tmpdir(), 'advisory-cal-'));
      let perRecordUnbatched;
      try {
        const CAL = 40;
        const calStart = Date.now();
        for (let i = 0; i < CAL; i++) {
          putNode(calDir, { kind: 'file', key: `cal/${i}.ts`, path: `cal/${i}.ts` });
        }
        perRecordUnbatched = (Date.now() - calStart) / CAL;
      } finally {
        rmSync(calDir, { recursive: true, force: true });
      }

      const started = Date.now();
      const result = seedProject(dir, REPO, { maxFiles: 200, budgetMs: 10_000 });
      const elapsed = Date.now() - started;
      expect(result.files).toBe(200);

      // A seeded file costs more than one record, so this is conservative:
      // even at one record per file the batched path must be several times
      // cheaper per record than the unbatched primitive.
      const perFileBatched = elapsed / result.files;
      expect(perRecordUnbatched).toBeGreaterThan(0);
      expect(perFileBatched).toBeLessThan(perRecordUnbatched * 4);

      const seeded = load(dir);
      const advice = adviseSearch(seeded, 'seedProject', { root: REPO });
      expect(advice).not.toBeNull();
      expect(advice.text).toContain('seed.mjs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('batched writes', () => {
  test('order is preserved, so a node still precedes its edges', () => {
    const dir = mkdtempSync(join(tmpdir(), 'advisory-batch-'));
    try {
      withBatchedWrites(dir, () => {
        const a = putNode(dir, { kind: 'file', key: join(dir, 'a.ts') });
        const b = putNode(dir, { kind: 'file', key: join(dir, 'b.ts') });
        putEdge(dir, a, 'imports', b);
      });
      const lines = readFileSync(join(dir, 'graph.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(lines.map((record) => record.t)).toEqual(['n', 'n', 'e']);
      const loaded = load(dir);
      expect(loaded.nodes.size).toBe(2);
      expect(loaded.edges).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a throw inside the scope still flushes and closes the batch', () => {
    // An open batch that outlives its scope would silently buffer every
    // subsequent write in the process into something nobody flushes.
    const dir = mkdtempSync(join(tmpdir(), 'advisory-throw-'));
    try {
      expect(() =>
        withBatchedWrites(dir, () => {
          putNode(dir, { kind: 'file', key: join(dir, 'a.ts') });
          throw new Error('boom');
        })
      ).toThrow('boom');
      expect(load(dir).nodes.size).toBe(1);

      // The next unbatched write must land immediately, not be buffered.
      putNode(dir, { kind: 'file', key: join(dir, 'b.ts') });
      expect(load(dir).nodes.size).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('another project\'s graph is not captured by an open batch', () => {
    const mine = mkdtempSync(join(tmpdir(), 'advisory-mine-'));
    const theirs = mkdtempSync(join(tmpdir(), 'advisory-theirs-'));
    try {
      withBatchedWrites(mine, () => {
        putNode(theirs, { kind: 'file', key: join(theirs, 'x.ts') });
        // Written directly, because it belongs to a different graph.
        expect(load(theirs).nodes.size).toBe(1);
      });
      expect(load(mine).nodes.size).toBe(0);
    } finally {
      rmSync(mine, { recursive: true, force: true });
      rmSync(theirs, { recursive: true, force: true });
    }
  });
});

describe('the advisory reaches the model on both paths', () => {
  const run = (payload, env) =>
    spawnSync(process.execPath, [ROUTER], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        TOKEN_OPTIMIZER_WIKI_DIR: graphDir,
        TOKEN_OPTIMIZER_SHARED_DIR: graphDir,
        ...env,
      },
    });

  const grep = (session) => ({
    session_id: session,
    cwd: workspace,
    tool_name: 'Grep',
    tool_input: { pattern: 'parse_line' },
  });

  let seq = 0;
  const fresh = (name) => `${name}-${Date.now()}-${++seq}`;

  test('allowed: no MCP server, so the search runs and carries the answer', () => {
    const result = run(grep(fresh('allowed')), {
      TOKEN_OPTIMIZER_MODE: 'assist',
      TOKEN_OPTIMIZER_MCP_CAPABILITIES: '',
    });
    const out = JSON.parse(result.stdout || '{}').hookSpecificOutput || {};
    expect(out.permissionDecision).not.toBe('deny');
    expect(out.additionalContext || '').toContain('parse.py');
  });

  test('refused: smart_grep present, and the redirect still carries the answer', () => {
    // THE CASE THAT WAS NEARLY SHIPPED BROKEN. This is what a real plugin
    // install looks like, and it takes the refusal path -- where the first
    // implementation said nothing at all.
    const result = run(grep(fresh('refused')), {
      TOKEN_OPTIMIZER_MODE: 'enforce',
      TOKEN_OPTIMIZER_MCP_CAPABILITIES:
        'smart_read,smart_write,smart_edit,smart_glob,smart_grep',
    });
    const out = JSON.parse(result.stdout || '{}').hookSpecificOutput || {};
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason || '').toContain('parse.py');
  });

  test('the search itself is never rewritten', () => {
    // If the index is wrong the model must still get exactly the results it
    // asked for. That is the only failure mode this feature is allowed to have.
    const result = run(grep(fresh('intact')), {
      TOKEN_OPTIMIZER_MODE: 'assist',
      TOKEN_OPTIMIZER_MCP_CAPABILITIES: '',
    });
    const out = JSON.parse(result.stdout || '{}').hookSpecificOutput || {};
    expect(out.updatedInput).toBeUndefined();
  });

  test('a session is capped', () => {
    expect(SESSION_CAP).toBeGreaterThan(0);
    const told = new Set(Array.from({ length: SESSION_CAP }, (_, i) => `filler-${i}`));
    expect(adviseSearch(graph, 'parse_line', { told, root: workspace })).not.toBeNull();
    // The router refuses once the cap is reached; the module reports the facts
    // and the router is what stops asking.
    expect(told.size).toBe(SESSION_CAP);
  });
});
