import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WIKI_WRITE_TOOL_DEFINITION,
  wikiWrite,
} from '../../src/tools/intelligence/wiki-write.js';

let workspace: string;
let anchor: string;
let priorWikiDir: string | undefined;

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
