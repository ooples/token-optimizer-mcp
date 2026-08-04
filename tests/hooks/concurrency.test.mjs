/**
 * Concurrent WRITERS, in real processes.
 *
 * Several tool calls can run at once and each spawns its own hook process, so
 * concurrency here is the ordinary case rather than an edge one. Every test in
 * this repository until now ran in a single process, which is a category of
 * behaviour they structurally cannot reach: a lock that is never contended
 * always looks correct, and an in-memory set always survives.
 *
 * That blind spot has already cost twice. A session-state field was dropped on
 * write and absent on read, so a gate that passed every unit test did nothing in
 * production because each tool call is a separate process. And the lock guarding
 * that state retried twenty times with no delay, so it exhausted in microseconds
 * and the caller fell through to an unlocked read-modify-write.
 *
 * So these spawn actual `node` processes and let them race.
 *
 * WHAT THIS SUITE DOES AND DOES NOT ESTABLISH -- stated because the difference
 * was measured rather than assumed.
 *
 * It DOES verify the invariants under genuine multi-process load: no write is
 * lost, no line is left unparseable, and no finding survives without its
 * anchors while several processes append at once.
 *
 * It does NOT prove the append lock in wiki.mjs is load-bearing on Windows.
 * That was checked directly: with the lock removed entirely, eight processes
 * writing forty records of 256 KB each -- far past the PIPE_BUF threshold the
 * lock's own comment cites -- produced 320 of 320 lines, none torn. Append-mode
 * writes are atomic on this platform, so the failure the lock guards against
 * does not reproduce here and no test run here can demonstrate its value.
 *
 * The suite is kept because CI runs Linux, where the PIPE_BUF limit is real and
 * these same assertions may have teeth, and because the invariants matter
 * regardless of which mechanism upholds them. What is avoided is the worse
 * outcome: a green concurrency test that would stay green with the lock deleted
 * and would therefore be evidence of nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync, spawn } from 'child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, utimesSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { load } from '../../hooks-core/wiki.mjs';

const WIKI = join(process.cwd(), 'hooks-core', 'wiki.mjs').replace(/\\/g, '/');

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'concurrency-'));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
});

/**
 * A child that appends `count` findings, each with its own anchors.
 *
 * THE RECORDS MUST BE BIG. The first version of this suite wrote small findings
 * and passed even with the lock REMOVED -- a single small append is atomic
 * enough on its own, so the test proved nothing. wiki.mjs says why in its own
 * docstring: POSIX guarantees atomicity only up to PIPE_BUF (often 4 KB) and
 * Windows guarantees none, while a real record can carry a 256 KB file
 * snapshot. The padding below puts every record over that line, which is where
 * interleaving actually happens.
 */
function writerScript(tag, count) {
  return `
    import { putNodeWithEdges, putNode } from 'file:///${WIKI}';
    const dir = ${JSON.stringify(dir)};
    const PAD = 'x'.repeat(96 * 1024);
    for (let i = 0; i < ${count}; i++) {
      const fileId = putNode(dir, { kind: 'file', key: dir + '/f-${tag}-' + i + '.ts', hash: 'h' });
      putNodeWithEdges(
        dir,
        { kind: 'finding', key: '${tag}-' + i, claim: 'claim ${tag} ' + i, confidence: 0.9, snapshot: PAD },
        [{ edge: 'derived_from', to: fileId }]
      );
    }
  `;
}

/** Runs N writers truly in parallel and waits for all of them. */
async function raceWriters(tags, perWriter) {
  const children = tags.map((tag) => {
    const file = join(dir, `writer-${tag}.mjs`);
    writeFileSync(file, writerScript(tag, perWriter));
    return spawn(process.execPath, [file], { stdio: 'ignore' });
  });

  await Promise.all(
    children.map(
      (c) =>
        new Promise((resolve, reject) => {
          c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))));
          c.on('error', reject);
        })
    )
  );
}

describe('parallel processes appending to one graph', () => {
  it('loses no writes and corrupts no records', async () => {
    const tags = ['a', 'b', 'c', 'd'];
    const each = 15;
    await raceWriters(tags, each);

    const graph = load(dir);
    const findings = [...graph.nodes.values()].filter((n) => n.kind === 'finding');

    // EVERY write must survive. Interleaved appends that corrupt a line would
    // show up as a missing finding, because load() skips unparseable records --
    // which is exactly how this failure would hide without a test like this.
    expect(findings).toHaveLength(tags.length * each);
    for (const tag of tags) {
      expect(findings.filter((f) => String(f.key).startsWith(`${tag}-`))).toHaveLength(each);
    }
  }, 120_000);

  it('leaves every line individually parseable', async () => {
    await raceWriters(['x', 'y', 'z'], 12);

    const raw = readFileSync(join(dir, 'graph.jsonl'), 'utf8').split('\n').filter(Boolean);
    const bad = [];
    for (const line of raw) {
      try {
        JSON.parse(line);
      } catch {
        bad.push(line.slice(0, 80));
      }
    }

    // A torn line is the visible symptom of two processes writing at once. The
    // fold tolerates it by design, so only a raw check can prove it is absent.
    expect(bad).toEqual([]);
  }, 120_000);

  it('never leaves a finding without its anchors, whoever was writing', async () => {
    await raceWriters(['p', 'q', 'r'], 12);

    const graph = load(dir);
    const anchored = new Set(
      graph.edges.filter((e) => e.edge === 'derived_from').map((e) => e.from)
    );
    const orphans = [...graph.nodes.values()]
      .filter((n) => n.kind === 'finding' && !anchored.has(n.id))
      .map((n) => n.key);

    // The invariant putNodeWithEdges exists to hold, now under contention: an
    // unanchored finding can never be invalidated, so it would be served as
    // current forever.
    expect(orphans).toEqual([]);
  }, 120_000);

  it('releases its lock, so a later writer is never blocked by a finished one', async () => {
    await raceWriters(['s'], 5);
    expect(existsSync(join(dir, '.graph.lock'))).toBe(false);
  }, 60_000);
});

describe('a lock left behind by a killed process', () => {
  it('is broken and reclaimed, not merely stepped around', () => {
    // WHAT THIS CAN AND CANNOT PROVE, stated plainly.
    //
    // `withLock` calls `write()` whether or not the lock was taken -- that is
    // deliberate, because a stale lock from a killed process must never stop
    // the graph being written. The consequence is that "the write still lands"
    // is true with the stale-lock branch REMOVED, so asserting only that proves
    // nothing. Verified by deleting the branch: the first version of this test
    // stayed green.
    //
    // The observable difference is reclamation. When the stale lock is broken
    // the writer holds it and releases it on the way out, so the file is gone
    // afterwards; when it is not broken the writer never held it and the stale
    // file survives, leaving every subsequent write unsynchronised for the life
    // of the session. That is the property worth guarding, and it is what is
    // asserted below.
    // BACKDATED WITHOUT A try/catch, and asserted.
    //
    // This used to call `require('fs')` inside a catch-all. Jest runs .mjs as
    // native ESM, where `require` is not defined, so it threw a ReferenceError
    // straight into the catch on every run -- the lock was never backdated and
    // the test proved only that a writer succeeds against a FRESH lock, which
    // is a different code path from the one it names. Reported by CodeRabbit on
    // this PR.
    //
    // `utimesSync` is imported at the top and called directly, and the mtime is
    // asserted afterwards, so a backdate that silently fails can no longer be
    // mistaken for recovery.
    const lockPath = join(dir, '.graph.lock');
    writeFileSync(lockPath, '');
    // Comfortably past the 5s threshold in wiki.mjs.
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    expect(Date.now() - statSync(lockPath).mtimeMs).toBeGreaterThan(30_000);

    const script = join(dir, 'after-stale.mjs');
    writeFileSync(
      script,
      `
      import { putNode } from 'file:///${WIKI}';
      putNode(${JSON.stringify(dir)}, { kind: 'file', key: 'after-stale.ts', hash: 'h' });
      `
    );

    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(0);

    const graph = load(dir);
    const keys = [...graph.nodes.values()].map((n) => n.key);
    expect(keys.some((k) => String(k).includes('after-stale.ts'))).toBe(true);

    // THE ASSERTION THAT DISTINGUISHES THE TWO. The stale lock was reclaimed
    // and released, so it is gone. Leave it in place and every later write in
    // the session runs unsynchronised.
    expect(existsSync(lockPath)).toBe(false);
  }, 90_000);
});
