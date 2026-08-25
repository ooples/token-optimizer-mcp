import { afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  WIKI_WRITE_TOOL_DEFINITION,
  wikiWrite,
} from '../../src/tools/intelligence/wiki-write.js';
import { putNodeWithEdges, load, nodeId } from '../../hooks-core/wiki.mjs';

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
 * harvest. So this is the path where the edge is most likely to be observed
 * in practice -- provided the caller actually supplies the real session id,
 * which nothing here does automatically. These tests exercise the wiring
 * itself: a real sessionId resolves, an unresolvable one does not dangle, and
 * omitting it does not fall back to some other identity.
 */
describe('wiki_write links a finding to the task that produced it', () => {
  it('writes the answers edge when sessionId names an existing task node', async () => {
    const dir = process.env.TOKEN_OPTIMIZER_WIKI_DIR as string;
    putNodeWithEdges(dir, { kind: 'task', key: 'session-1' });

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
    // A sentinel task node that a wrong fallback (e.g. defaulting to some
    // other identity instead of leaving taskId unset) could accidentally
    // resolve against.
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
