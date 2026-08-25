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
 * The `answers` edge, on the default install path.
 *
 * `wiki_write` runs on every install with no opt-in gate, unlike the detached
 * harvest. `wikiWrite` passes NO explicit `taskId` (round 3 removed the
 * earlier `taskId: options.sessionId` synthesis -- a model-supplied
 * `sessionId` is an unverified claim, unlike the harvest worker's, which
 * comes from trusted hook infrastructure, so it should be checked against
 * the graph rather than trusted outright). That routes every call through
 * `writeHarvested`'s traversal fallback, which requires the SAME session's
 * task to have a `derived_from` edge to EVERY one of the finding's anchors
 * before writing an edge -- these tests exercise that: full coverage
 * resolves, no task at all does not dangle, and omitting `sessionId`
 * supplies no identity to check against, so there is no candidate.
 */
describe('wiki_write links a finding to the task that produced it', () => {
  it('writes the answers edge when the session’s task fully covers the finding’s anchor', async () => {
    const dir = process.env.TOKEN_OPTIMIZER_WIKI_DIR as string;
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
    const edge = graph.edges.find((e) => e.edge === 'answers');
    expect(edge).toBeDefined();
    expect(edge?.to).toBe(nodeId('task', 'session-1'));
  });

  it('writes no answers edge when the session’s task exists but never touched the anchor', async () => {
    const dir = process.env.TOKEN_OPTIMIZER_WIKI_DIR as string;
    // The task node exists, matching the sessionId, but has no coverage --
    // existence alone is not attribution.
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
    // A sentinel task node -- present to prove the absence of `sessionId`
    // supplies no identity to check against, not merely that this one
    // particular node fails to match.
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
