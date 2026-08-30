/**
 * The adapter measures the same things the Claude Code router measures.
 *
 * adapter.mjs serves codex, gemini, qwen and opencode; plugin/hooks/pretooluse-router.mjs serves
 * Claude Code. Its comment claims "Same measurement as the Claude Code router: every client's
 * allowed read feeds the same holdout comparison, or the metric is client-specific and therefore
 * not comparable". Three details made that claim false, and each produced a wrong number rather
 * than a missing one -- which is worse, because a wrong number gets quoted.
 *
 * These tests assert the shared CONTRACT rather than driving the hook binary, so they state
 * exactly what parity means and fail if either side drifts from it.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { wikiDir, projectRootFor } from '../../hooks-core/wiki.mjs';
import { recordRead, fingerprint, readMetrics } from '../../hooks-core/metrics.mjs';
import { loadState, saveState } from '../../hooks-core/policy.mjs';

let repoA, repoB, fileA, fileB;

beforeEach(() => {
  repoA = mkdtempSync(join(tmpdir(), 'adapter-a-'));
  repoB = mkdtempSync(join(tmpdir(), 'adapter-b-'));
  for (const r of [repoA, repoB]) mkdirSync(join(r, '.git'), { recursive: true });
  fileA = join(repoA, 'a.js'); writeFileSync(fileA, 'export const a = 1;\n');
  fileB = join(repoB, 'b.js'); writeFileSync(fileB, 'export const b = 2;\n');
});

afterEach(() => {
  for (const r of [repoA, repoB]) {
    try { rmSync(r, { recursive: true, force: true }); } catch { /* windows lock */ }
  }
});

describe('a read is filed against the project the FILE belongs to', () => {
  test("a session in repo A reading repo B's file records into B, not A", () => {
    // The defect: recordRead(wikiDir(payload.cwd), ...) appended the cost to whichever repo the
    // client was launched in, with an anchor that does not exist there -- while the repo that
    // owns the file never saw the cost of its own file.
    const dir = wikiDir(projectRootFor(fileB, repoA));
    mkdirSync(dir, { recursive: true });
    recordRead(dir, { anchor: fileB, sessionId: 's1', bytes: 1234, fp: fingerprint(fileB) });

    // Landed in B.
    expect(readMetrics(dir).some((e) => e.kind === 'read' && e.anchor === fileB)).toBe(true);
    // And not in A.
    const dirA = wikiDir(repoA);
    const inA = existsSync(dirA) ? readMetrics(dirA) : [];
    expect(inA.some((e) => e.anchor === fileB)).toBe(false);
  });

  test('projectRootFor sends the file to its own repository, not the caller cwd', () => {
    expect(projectRootFor(fileB, repoA)).toBe(repoB.split('\\').join('/'));
  });
});

describe('a recorded read carries a fingerprint', () => {
  test('fingerprint distinguishes an unchanged file from a changed one', () => {
    // Without fp, rereadWaste classifies every pair as undecidable, so waste reports as ZERO
    // for these clients rather than as unmeasured -- and the reads still inflate `repeats`, so
    // the zero looks measured.
    const before = fingerprint(fileA);
    expect(before).toBeTruthy();
    expect(fingerprint(fileA)).toBe(before);

    writeFileSync(fileA, 'export const a = 99;\n');
    expect(fingerprint(fileA)).not.toBe(before);
  });

  test('a read written with a fingerprint round-trips it', () => {
    const dir = wikiDir(repoA);
    mkdirSync(dir, { recursive: true });
    const fp = fingerprint(fileA);
    recordRead(dir, { anchor: fileA, sessionId: 's1', bytes: 10, fp });
    const read = readMetrics(dir).find((e) => e.kind === 'read' && e.anchor === fileA);
    // The SAME fingerprint, not merely a truthy one. 'round-trips' is a claim
    // about identity: a store that wrote a constant, or the fingerprint of the
    // wrong file, would satisfy `toBeTruthy` and make every later
    // unchanged/changed comparison wrong while reporting itself measured.
    expect(read.fp).toBe(fp);
  });
});

describe('the briefing is read from the repository root', () => {
  test('a subdirectory launch resolves to the same graph as a root launch', () => {
    // wikiDir does no upward walk, so trusting the bare cwd read an empty directory and
    // reported "nothing learned" for a project whose graph was fully populated one level up.
    const sub = join(repoA, 'packages', 'web');
    mkdirSync(sub, { recursive: true });

    const fromRoot = wikiDir(projectRootFor(join(repoA, '__session__'), repoA));
    const fromSub = wikiDir(projectRootFor(join(sub, '__session__'), sub));
    expect(fromSub).toBe(fromRoot);
  });

  test('the bare cwd would NOT have resolved to the same place', () => {
    // Pins why the walk is required rather than merely tidy.
    const sub = join(repoA, 'packages', 'web');
    mkdirSync(sub, { recursive: true });
    expect(wikiDir(sub)).not.toBe(wikiDir(repoA));
  });
});

describe('state is scoped to the agent, not just the session', () => {
  test('two agents in one session do not share denial state', () => {
    // Subagents inherit the parent's session id. The router already keys state on
    // transcript_path for this reason -- its comment records the failure observed live: "an
    // agent refused a file it had never opened because a sibling had read it." The adapter,
    // which serves codex/gemini/qwen/opencode, was never given the same scope.
    const session = 'shared-session-id';
    const a = loadState(session, '/transcripts/agent-a.jsonl');
    const b = loadState(session, '/transcripts/agent-b.jsonl');

    a.denied = { 'read:big.ts': 1 };
    saveState(session, a, '/transcripts/agent-a.jsonl');

    const bAfter = loadState(session, '/transcripts/agent-b.jsonl');
    expect(bAfter.denied?.['read:big.ts']).toBeUndefined();
    expect(b).toBeTruthy();
  });

  test('the same agent still sees its own state', () => {
    // The scope must not be so narrow that a single agent forgets its own denials, or the
    // repeat-denial escape hatch stops working.
    const session = 'shared-session-id-2';
    const scope = '/transcripts/agent-a.jsonl';
    const first = loadState(session, scope);
    first.denied = { 'read:big.ts': 1 };
    saveState(session, first, scope);
    expect(loadState(session, scope).denied?.['read:big.ts']).toBe(1);
  });
});
