/**
 * A drainer killed mid-claim does not take its records with it.
 *
 * `drainInvalidations` claims the pending-invalidation queue by renaming it to a
 * per-pid file, then reads and deletes that file. The rename closed the original
 * defect -- a concurrent append deleted unread -- and it left a residual, which
 * is what this file is about: a drainer killed BETWEEN the rename and the read
 * strands its claim, and the records inside are lost.
 *
 * WHY LOST MEANS LOST. The lazy staleness path cannot pick them up afterwards.
 * `indexFile` re-points an anchor's stored hash at the bytes the session just
 * wrote, so for a file the session itself edited there is nothing left to
 * compare against -- lazy is structurally blind to the session's own writes
 * rather than merely late. A stranded claim is a permanently missed
 * invalidation, and the stray files accumulate with nothing reading them.
 *
 * The recovery is safe because re-application is idempotent: marking a finding
 * stale twice is marking it stale. So the cost of adopting a claim whose owner
 * turns out to be alive is a repeated write, and the cost of not adopting is a
 * finding served as current when it is not.
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load, nodeId, putNodeWithEdges } from '../../hooks-core/wiki.mjs';
import { indexFile } from '../../hooks-core/staleness.mjs';
import { drainInvalidations } from '../../hooks-core/pending.mjs';

const NL = String.fromCharCode(10);
const BEFORE = 'export function parse(x) {' + NL + '  return x.trim();' + NL + '}' + NL;
const AFTER = 'export function parse(x) {' + NL + '  return JSON.parse(x);' + NL + '}' + NL;
const CLAIM_TEXT = 'parse() trims rather than parsing';

let project;
let wiki;
let file;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'stranded-proj-'));
  mkdirSync(join(project, '.git'), { recursive: true });
  wiki = mkdtempSync(join(tmpdir(), 'stranded-wiki-'));

  file = join(project, 'parser.ts');
  writeFileSync(file, BEFORE);
  indexFile(wiki, file, BEFORE);
  putNodeWithEdges(
    wiki,
    {
      kind: 'finding',
      key: 'parse-trims',
      claim: CLAIM_TEXT,
      type: 'finding',
      confidence: 0.95,
      origin: 'human',
    },
    [{ edge: 'derived_from', to: nodeId('file', file) }]
  );
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(wiki, { recursive: true, force: true });
});

const finding = () => load(wiki).nodes.get(nodeId('finding', 'parse-trims'));
const claimFiles = () =>
  readdirSync(wiki).filter((f) => f.startsWith('pending-invalidation.claim.'));

/**
 * Writes a claim file exactly as a drainer killed after its rename would leave
 * one: the queue's bytes, under a pid-suffixed name, never read.
 */
function strandClaim(pid, records) {
  const path = join(wiki, `pending-invalidation.claim.${pid}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join(NL) + NL);
  return path;
}

/**
 * A pid that is certainly not running.
 *
 * Spawning and reaping a real process would be exact but slow and racy on a
 * shared runner. A very high pid is not allocated on any platform this ships
 * to, and the guard under test only ever asks "is this alive".
 */
const DEAD_PID = 999_999;

describe('a claim stranded by a dead drainer', () => {
  test('is adopted and applied, so the invalidation is not missed', () => {
    // The edit has landed and the anchor has been re-indexed, which is the
    // state that makes lazy staleness blind: the stored hash already agrees
    // with disk.
    writeFileSync(file, AFTER);
    const stranded = strandClaim(DEAD_PID, [
      { path: file, before: BEFORE, after: AFTER },
    ]);
    indexFile(wiki, file, AFTER);

    expect(finding().stale).toBeFalsy();

    const marked = drainInvalidations(wiki, load(wiki));

    expect(marked).toBeGreaterThan(0);
    expect(finding().stale).toBe(true);
    // And with evidence, which is the invariant staleness.mjs opens with.
    expect(finding().diff).toContain('JSON.parse');
    // Read, then removed -- not left to accumulate.
    expect(existsSync(stranded)).toBe(false);
  });

  test('is adopted even when there is no queue at all', () => {
    // THE CASE THAT MADE THE RESIDUAL PERMANENT. The drain used to return
    // early when no queue existed, so a stranded claim stayed stranded for as
    // long as the project was quiet -- which is exactly the state a killed
    // drain leaves behind.
    writeFileSync(file, AFTER);
    strandClaim(DEAD_PID, [{ path: file, before: BEFORE, after: AFTER }]);
    indexFile(wiki, file, AFTER);

    expect(existsSync(join(wiki, 'pending-invalidation.jsonl'))).toBe(false);

    expect(drainInvalidations(wiki, load(wiki))).toBeGreaterThan(0);
    expect(finding().stale).toBe(true);
    expect(claimFiles()).toEqual([]);
  });

  test('a claim under this process own pid is adopted, not overwritten', () => {
    // The old behaviour renamed the queue straight onto this path, replacing a
    // leftover from a previous drain in the same process and losing whatever
    // was inside it.
    writeFileSync(file, AFTER);
    strandClaim(process.pid, [{ path: file, before: BEFORE, after: AFTER }]);
    indexFile(wiki, file, AFTER);

    expect(drainInvalidations(wiki, load(wiki))).toBeGreaterThan(0);
    expect(finding().stale).toBe(true);
  });

  test('a hash-only record is adopted too, not just a diffable one', () => {
    // The queue carries two grades. A record with only a path gets the hash
    // comparison, which is the grade that is meaningful only before indexFile
    // refreshes the anchor -- so it is the one with the most to lose.
    writeFileSync(file, AFTER);
    strandClaim(DEAD_PID, [{ path: file }]);

    expect(drainInvalidations(wiki, load(wiki))).toBeGreaterThan(0);
    expect(finding().stale).toBe(true);
  });
});

describe('a claim held by a live drainer', () => {
  test('is left alone, because its owner is still going to read it', () => {
    // process.pid is this test, which is alive by construction -- but the
    // same-pid rule adopts our own, so a live FOREIGN pid is what this needs.
    // process.ppid is the runner that spawned us: alive, and not us.
    writeFileSync(file, AFTER);
    const held = strandClaim(process.ppid, [
      { path: file, before: BEFORE, after: AFTER },
    ]);

    drainInvalidations(wiki, load(wiki));

    expect(existsSync(held)).toBe(true);
    expect(finding().stale).toBeFalsy();
  });

  test('is adopted anyway once it is old enough, because pids get reused', () => {
    // THE HOLE A LIVENESS CHECK ALONE LEAVES. A killed drainer's pid is free to
    // be handed to something unrelated, and from that moment the check answers
    // "alive" forever and the records are never recovered. An age fallback
    // closes it, and is safe to be wrong about because re-application is
    // idempotent.
    writeFileSync(file, AFTER);
    const held = strandClaim(process.ppid, [
      { path: file, before: BEFORE, after: AFTER },
    ]);
    const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(held, longAgo, longAgo);
    indexFile(wiki, file, AFTER);

    expect(drainInvalidations(wiki, load(wiki))).toBeGreaterThan(0);
    expect(finding().stale).toBe(true);
    expect(existsSync(held)).toBe(false);
  });
});

describe('adoption does not break the ordinary paths', () => {
  test('an unrelated file in the graph directory is never touched', () => {
    // The scan matches on a name shape. A graph directory holds graph.jsonl,
    // metrics.jsonl and the rest, and deleting one of those would be a far
    // worse bug than the one being fixed.
    const bystanders = ['graph.jsonl', 'metrics.jsonl', 'pending-invalidation.claim.jsonl'];
    for (const name of bystanders) writeFileSync(join(wiki, name), 'keep me' + NL);

    drainInvalidations(wiki, load(wiki));

    for (const name of bystanders) expect(existsSync(join(wiki, name))).toBe(true);
  });

  test('an empty graph directory drains to zero without throwing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'stranded-empty-'));
    try {
      expect(drainInvalidations(empty, load(empty))).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('a torn line in a stranded claim costs one record, not the file', () => {
    writeFileSync(file, AFTER);
    const path = join(wiki, `pending-invalidation.claim.${DEAD_PID}.jsonl`);
    writeFileSync(
      path,
      '{"path":"' + 'not-json' + NL +
        JSON.stringify({ path: file, before: BEFORE, after: AFTER }) + NL
    );
    indexFile(wiki, file, AFTER);

    expect(drainInvalidations(wiki, load(wiki))).toBeGreaterThan(0);
    expect(finding().stale).toBe(true);
  });
});
