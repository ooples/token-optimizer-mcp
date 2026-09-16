import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { putNode } from '../../hooks-core/wiki.mjs';

describe('packaged graph module resolution', () => {
  it('loads project findings when the installed package path contains spaces and Unicode', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'optimizer résumé '));
    // A junction is used only for shared, read-only test dependencies. Unlink
    // it before cleanup so recursive deletion never walks the linked source.
    const linked = join(dir, 'hooks-core');
    try {
      fs.mkdirSync(join(dir, 'dist/proxy'), { recursive: true });
      fs.writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      for (const name of ['findings.js', 'graph-scope.js'])
        fs.copyFileSync(
          resolve('dist/proxy', name),
          join(dir, 'dist/proxy', name)
        );
      fs.symlinkSync(
        resolve('hooks-core'),
        linked,
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      const project = join(dir, 'project');
      putNode(join(project, '.token-optimizer/wiki'), {
        kind: 'finding',
        key: 'path-test',
        claim: 'Installed path supports Unicode and spaces.',
        confidence: 1,
        confidenceLabel: 'verified',
        scope: 'project',
      });
      const { loadFindingsFrom } = await import(
        pathToFileURL(join(dir, 'dist/proxy/findings.js')).href
      );
      const result = await loadFindingsFrom(project);
      expect(result.findings.map((f) => f.key)).toContain('path-test');
      const before = process.env.TOKEN_OPTIMIZER_WIKI_DIR;
      try {
        const custom = join(dir, 'custom-wiki');
        putNode(custom, {
          kind: 'finding',
          key: 'custom-path',
          claim: 'Explicit wiki directory.',
          confidence: 1,
          confidenceLabel: 'verified',
          scope: 'project',
        });
        process.env.TOKEN_OPTIMIZER_WIKI_DIR = custom;
        const explicit = await loadFindingsFrom(project);
        expect(explicit.findings.map((f) => f.key)).toEqual(['custom-path']);
      } finally {
        if (before === undefined) delete process.env.TOKEN_OPTIMIZER_WIKI_DIR;
        else process.env.TOKEN_OPTIMIZER_WIKI_DIR = before;
      }
    } finally {
      if (fs.existsSync(linked)) fs.unlinkSync(linked);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
