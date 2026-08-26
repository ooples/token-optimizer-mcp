import { afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  WIKI_WRITE_TOOL_DEFINITION,
  wikiWrite,
} from '../../src/tools/intelligence/wiki-write.js';
import { putNode, putNodeWithEdges, putEdge, load, nodeId } from '../../hooks-core/wiki.mjs';

let workspace: string;
let anchor: string;
let priorWikiDir: string | undefined;

/**
 * `wikiWrite` loads five hooks-core modules with one `Promise.all` of
 * dynamic `import()`s (see wiki-write.ts). Under Jest's `--experimental-vm-modules`
 * loader, linking several BRAND NEW ESM modules concurrently for the first
 * time races and throws `request for 'node:<builtin>' is not in cache` --
 * reproducible in isolation, nothing to do with this task's change, and
 * specific to Jest's VM-module linker (plain Node has no such race). Once
 * each module has been linked once, a later concurrent `Promise.all` of the
 * same modules hits Jest's cache and is fine -- so importing them here,
 * sequentially, before any test calls `wikiWrite`, is what lets its happy
 * path be exercised under this test runner at all.
 */
beforeAll(async () => {
  const here = join(process.cwd(), 'hooks-core');
  for (const name of ['wiki.mjs', 'harvest-write.mjs', 'curate.mjs', 'metrics.mjs', 'projects.mjs']) {
    await import(pathToFileURL(join(here, name)).href);
  }
});

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'wiki-write-contract-'));
  anchor = join(workspace, 'source.ts');
  writeFileSync(anchor, 'export const value = 1;\n');
  priorWikiDir = process.env.TOKEN_OPTIMIZER_WIKI_DIR;
  process.env.TOKEN_OPTIMIZER_WIKI_DIR = join(workspace, 'graph');
});

afterEach(() => {
  if (priorWikiDir === undefined) delete process.env.TOKEN_OPTIMIZER_WIKI_DIR;
  else process.env.TOKEN_OPTIMIZER_WIKI_DIR = priorWikiDir;
  rmSync(workspace, { recursive: true, force: true });
});

describe('active-model semantic finding contract', () => {
  it('advertises every evidence and calibration field as required', () => {
    expect(WIKI_WRITE_TOOL_DEFINITION.inputSchema.required).toEqual(
      expect.arrayContaining([
        'claim', 'anchors', 'evidence', 'applicability', 'confidenceLabel',
      ])
    );
  });

  it('rejects a plausible claim when the model supplies no evidence', async () => {
    const result = await wikiWrite({
      claim: 'The verifier requires the project runner.',
      anchors: [anchor],
      applicability: 'When running project verification.',
      confidenceLabel: 'probable',
      projectRoot: workspace,
    } as never);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/evidence is required/i);
  });

});

/**
 * `wiki_write` never writes an `answers` edge, and that is a deliberate,
 * documented consequence rather than a gap.
 *
 * ROUND 3 removed `wikiWrite`'s `taskId: options.sessionId` synthesis and
 * routed it through `writeHarvested`'s traversal fallback instead, keyed by
 * `sessionId`. ROUND 4's adversarial review found that was still not enough:
 * `sessionId` is a plain MCP tool argument the calling model supplies,
 * unverified, so a model naming a REAL foreign session -- one whose task
 * genuinely covered these anchors -- would still get a confidently wrong
 * `answers` edge, because coverage cannot distinguish "this session" from
 * "some other session that really did touch these files". `writeHarvested`
 * now takes a separate `authoritativeSessionId` parameter that gates the
 * traversal fallback, and `wikiWrite` supplies NEITHER `taskId` NOR
 * `authoritativeSessionId` -- only `sessionId`, stored for provenance and
 * never used for attribution. So every `wiki_write` call takes the "no
 * candidate" path regardless of what the graph holds, on purpose: a wrong
 * provenance edge is worse than none, and `sessionId` here is not evidence.
 *
 * These tests assert the CONSEQUENCE directly: even a task that fully covers
 * the anchor, keyed by exactly the `sessionId` supplied, produces no edge.
 * `plugin/hooks/harvest-worker.mjs` is where `authoritativeSessionId` is
 * actually supplied (Claude Code's own hook payload) and where `answers` can
 * fire -- covered in `tests/hooks/contradicts.test.mjs`, not here.
 */
describe('wiki_write never attributes an answers edge to an unverified sessionId', () => {
  it('writes no answers edge even when the named session’s task fully covers the anchor', async () => {
    const dir = process.env.TOKEN_OPTIMIZER_WIKI_DIR as string;
    // A REAL task, fully covering the anchor -- traversal alone (round 3)
    // would have matched this. The point is that it must not, because
    // `wiki_write` supplies no `authoritativeSessionId`.
    putNode(dir, { kind: 'task', key: 'session-1' });
    putEdge(dir, nodeId('task', 'session-1'), 'derived_from', nodeId('file', anchor));

    const result = await wikiWrite({
      claim: 'The verifier requires the project runner.',
      anchors: [anchor],
      evidence: 'Ran the suite directly and it failed with a clear error.',
      applicability: 'When running project verification.',
      confidenceLabel: 'probable',
      projectRoot: workspace,
      sessionId: 'session-1',
    } as never);
    expect(result.success).toBe(true);

    const graph = load(dir);
    expect(graph.edges.some((e) => e.edge === 'answers')).toBe(false);
  });

  it('writes no answers edge when the session’s task exists but never touched the anchor', async () => {
    const dir = process.env.TOKEN_OPTIMIZER_WIKI_DIR as string;
    putNodeWithEdges(dir, { kind: 'task', key: 'session-2' });

    const result = await wikiWrite({
      claim: 'The verifier requires the project runner.',
      anchors: [anchor],
      evidence: 'Ran the suite directly and it failed with a clear error.',
      applicability: 'When running project verification.',
      confidenceLabel: 'probable',
      projectRoot: workspace,
      sessionId: 'session-2',
    } as never);
    expect(result.success).toBe(true);

    const graph = load(dir);
    expect(graph.edges.some((e) => e.edge === 'answers')).toBe(false);
  });

  it('writes no answers edge when sessionId names no existing task node', async () => {
    const dir = process.env.TOKEN_OPTIMIZER_WIKI_DIR as string;
    // Deliberately no task node created for 'ghost-session'.

    const result = await wikiWrite({
      claim: 'The verifier requires the project runner.',
      anchors: [anchor],
      evidence: 'Ran the suite directly and it failed with a clear error.',
      applicability: 'When running project verification.',
      confidenceLabel: 'probable',
      projectRoot: workspace,
      sessionId: 'ghost-session',
    } as never);
    expect(result.success).toBe(true);

    const graph = load(dir);
    expect(graph.edges.some((e) => e.edge === 'answers')).toBe(false);
  });

  it('writes no answers edge when no sessionId is supplied at all', async () => {
    const dir = process.env.TOKEN_OPTIMIZER_WIKI_DIR as string;
    putNodeWithEdges(dir, { kind: 'task', key: 'sentinel-task' });

    const result = await wikiWrite({
      claim: 'The verifier requires the project runner.',
      anchors: [anchor],
      evidence: 'Ran the suite directly and it failed with a clear error.',
      applicability: 'When running project verification.',
      confidenceLabel: 'probable',
      projectRoot: workspace,
    } as never);
    expect(result.success).toBe(true);

    const graph = load(dir);
    expect(graph.edges.some((e) => e.edge === 'answers')).toBe(false);
  });
});
