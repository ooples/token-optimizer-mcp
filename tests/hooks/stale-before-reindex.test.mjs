import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

/**
 * THE READ THAT MATTERS MOST IS THE ONE THE ROUTER USED TO GET WRONG.
 *
 * A finding is a claim about a file's CONTENT, and the only evidence that it may
 * no longer hold is that the content changed since the claim was recorded. The
 * router destroyed that evidence before it looked at it:
 *
 *     indexFile(dir, path, source)   // line 181 -- overwrites the stored hash
 *     ...
 *     forTouch(dir, load(dir), path) // line 210 -- compares stored hash to disk
 *
 * By the time `forTouch` asked "did this file change?", `indexFile` had already
 * re-pointed the anchor at the NEW content, so the answer was always no. Findings
 * derived from the old content were served CLEAN.
 *
 * The window is narrow and it is exactly the wrong window. A write the hook
 * observes is invalidated eagerly by `invalidateOnWrite`, so the only files that
 * reach this path are the ones changed where the session could not see it -- a
 * git checkout, a rebase, a second agent, an editor outside the tool loop. That
 * is precisely the case where a stale claim is most likely AND least likely to be
 * caught by the reader, because nothing in the session hints that the file moved.
 *
 * A stale finding served as current is worse than no finding at all: it spends
 * tokens to state something false with the graph's authority behind it. So the
 * ordering is asserted end-to-end, against the real hook process, on the real
 * payload shape Claude Code sends.
 *
 * WHY THE FULL PROCESS AND NOT `forTouch` DIRECTLY: the unit is not what broke.
 * `forTouch` and `serve` were correct in isolation and had passing tests
 * throughout -- the defect lived entirely in the order the router called them in,
 * which is invisible to any test that calls them itself. Only a test that lets
 * the ROUTER choose the order can fail on this.
 */

const ROUTER = join(process.cwd(), 'plugin', 'hooks', 'pretooluse-router.mjs');
const CORE = (name) =>
  pathToFileURL(join(process.cwd(), 'hooks-core', name)).href;

let putNode, putEdge, nodeId;

beforeEach(async () => {
  ({ putNode, putEdge, nodeId } = await import(CORE('wiki.mjs')));
});

let project;
let wiki;
let stateDir;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'stale-order-proj-'));
  wiki = mkdtempSync(join(tmpdir(), 'stale-order-wiki-'));
  // PER TEST, AND THE REASON IS NOT TIDINESS.
  //
  // Injection is once-per-session per finding, and the session state lives in a
  // FIXED directory under the system temp dir keyed by session id. A test that
  // names its sessions -- as this one must, since the gate is what it is
  // measuring -- therefore inherits whatever a previous RUN of the same test
  // recorded, and the second run of a passing assertion sees the finding
  // suppressed and reports the feature broken.
  //
  // This cost an hour of chasing a phantom regression: the fix under test looked
  // like it had destroyed injection entirely, and every run agreed, because the
  // first run had consumed the session ids for all the ones that followed.
  stateDir = mkdtempSync(join(tmpdir(), 'stale-order-state-'));
});

afterEach(() => {
  for (const dir of [project, wiki, stateDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows can hold a handle briefly */
    }
  }
});

/**
 * Drives the real hook exactly as Claude Code does.
 *
 * HOLDOUT PINNED OFF. Ten percent of anchors are deliberately served nothing so
 * the value of injection can be measured against a control, which means an
 * unpinned run of this test would fail roughly one time in ten -- and a suite
 * that fails one run in ten teaches people to re-run it rather than read it.
 */
function route(payload, { sessionId = 'stale-order' } = {}) {
  const result = spawnSync(process.execPath, [ROUTER], {
    input: JSON.stringify({ cwd: project, session_id: sessionId, ...payload }),
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_WIKI_DIR: wiki,
      TOKEN_OPTIMIZER_STATE_DIR: stateDir,
      TOKEN_OPTIMIZER_HOLDOUT: '0',
    },
    timeout: 30_000,
  });
  expect(result.status).toBe(0);
  let parsed = {};
  try {
    parsed = JSON.parse(result.stdout || '{}');
  } catch {
    throw new Error(`hook did not emit JSON: ${result.stdout}\n${result.stderr}`);
  }
  return parsed.hookSpecificOutput?.additionalContext ?? '';
}

/** A content claim: the only kind whose truth depends on the bytes on disk. */
function seedFinding(file, claim) {
  const id = putNode(wiki, {
    kind: 'finding',
    key: claim.slice(0, 16),
    claim,
    confidence: 0.9,
    type: 'finding',
  });
  putEdge(wiki, id, 'derived_from', nodeId('file', file));
  return id;
}

describe('a file changed outside the session', () => {
  test('is marked STALE on the first read that follows, not served as current', () => {
    const file = join(project, 'parser.ts');
    writeFileSync(file, 'export function parse(x) {\n  return x.trim();\n}\n');

    // First touch: the router indexes the file at its current content. This is
    // the state a finding is recorded against.
    route({ tool_name: 'Read', tool_input: { file_path: file } });
    seedFinding(file, 'parse() trims its input before returning');

    // THE CHANGE THE SESSION CANNOT SEE. No Write, no Edit, no hook invocation --
    // a checkout or another process, which is the whole point.
    writeFileSync(file, 'export function parse(x) {\n  return JSON.parse(x);\n}\n');

    // A different session, because "once per session per finding" would suppress
    // the second delivery inside the same one and hide the ordering entirely.
    const context = route(
      { tool_name: 'Read', tool_input: { file_path: file } },
      { sessionId: 'stale-order-after' }
    );

    expect(context).toContain('parse() trims its input');
    expect(context).toMatch(/file changed/);
  });

  test('is marked without a diff, because this path does not load snapshots', () => {
    // NOT AN OVERSIGHT, AND WORTH PINNING SO IT STAYS A DECISION.
    //
    // The injection path loads the graph WITHOUT snapshots -- it runs ahead of
    // every tool call, and parsing stored file contents there was measured at
    // 232 ms per call. So staleness here is decided from the stored HASH, which
    // is enough to know THAT the file changed and not enough to say WHAT
    // changed. The renderer's evidence-free wording is what covers that gap.
    //
    // The refusal path, which is already paying for a large file, does load
    // snapshots and does carry the diff. If lazy snapshot loading is added later
    // this test is the one that should change, deliberately.
    const file = join(project, 'config.ts');
    writeFileSync(file, 'export const RETRIES = 3;\n');

    route({ tool_name: 'Read', tool_input: { file_path: file } });
    seedFinding(file, 'RETRIES is 3 and callers depend on that bound');

    writeFileSync(file, 'export const RETRIES = 12;\n');

    const context = route(
      { tool_name: 'Read', tool_input: { file_path: file } },
      { sessionId: 'stale-order-diff' }
    );

    // The claim is delivered, and it is delivered MARKED -- never as current.
    expect(context).toContain('RETRIES is 3');
    expect(context).toMatch(/recorded earlier; file changed/);
    // AND THE CONTRACT IN THE NAME IS ASSERTED, not just implied by the wording.
    // Checking only for the evidence-free phrasing would still pass if the
    // router started shipping a diff alongside it -- which is the 232 ms per
    // call this path exists to avoid. The new content must not appear.
    expect(context).not.toContain('RETRIES = 12');
  });

  test('a file that did NOT change is still served clean', () => {
    // The other half of the guard. Marking everything stale would pass the test
    // above while destroying the feature: every finding would arrive discounted,
    // which is indistinguishable from having no graph.
    const file = join(project, 'stable.ts');
    writeFileSync(file, 'export const NAME = "stable";\n');

    route({ tool_name: 'Read', tool_input: { file_path: file } });
    seedFinding(file, 'NAME is exported as a string literal');

    const context = route(
      { tool_name: 'Read', tool_input: { file_path: file } },
      { sessionId: 'stale-order-clean' }
    );

    expect(context).toContain('NAME is exported');
    expect(context).not.toMatch(/file changed|recorded earlier/);
  });

  test('indexing still happens, so the NEXT read compares against the new content', () => {
    // Moving the read ahead of the write must not drop the write. If injection
    // ran first and indexing never ran at all, this file would report stale
    // forever -- permanently discounted against a snapshot nothing refreshes.
    const file = join(project, 'drift.ts');
    writeFileSync(file, 'export const V = 1;\n');

    route({ tool_name: 'Read', tool_input: { file_path: file } });
    seedFinding(file, 'V is a numeric constant');

    writeFileSync(file, 'export const V = 2;\n');
    const first = route(
      { tool_name: 'Read', tool_input: { file_path: file } },
      { sessionId: 'drift-1' }
    );
    expect(first).toMatch(/file changed/);

    // Nothing changed since that read, so the re-index it performed must have
    // landed and this read must be clean again.
    const second = route(
      { tool_name: 'Read', tool_input: { file_path: file } },
      { sessionId: 'drift-2' }
    );
    expect(second).toContain('V is a numeric constant');
    expect(second).not.toMatch(/file changed|recorded earlier/);
  });
});
