import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { putNode } from '../../hooks-core/wiki.mjs';

/**
 * Copy a built module and everything it reaches into the fixture, keeping each
 * file at the same path under dist so the relative specifiers still resolve.
 *
 * The specifiers are read out of the emitted JavaScript rather than listed
 * here, because a list is only correct until the next import is added -- which
 * is exactly how this fixture broke. Only relative specifiers are followed: a
 * bare one resolves through node_modules, which an installed package has.
 */
function copyModuleGraph(entry, into) {
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const source = resolve(rel);
    const target = join(into, rel);
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    const code = fs.readFileSync(source, 'utf8');
    const specifiers = code.matchAll(
      /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g
    );
    for (const [, specifier] of specifiers)
      visit(join(dirname(rel), specifier).split('\\').join('/'));
  };
  visit(entry);
  return [...seen];
}
describe('packaged graph module resolution', () => {
  it('loads project findings when the installed package path contains spaces and Unicode', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'optimizer résumé '));
    // A junction is used only for shared, read-only test dependencies. Unlink
    // it before cleanup so recursive deletion never walks the linked source.
    const linked = join(dir, 'hooks-core');
    try {
      fs.mkdirSync(join(dir, 'dist/proxy'), { recursive: true });
      fs.writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      const copied = copyModuleGraph('dist/proxy/findings.js', dir);
      // A POSITIVE CONTROL ON THE COPIER. This used to name the two files it
      // needed, and broke the day graph-scope.js started importing
      // ../rollout/resolve.js: the fixture is an installed package, so a module
      // it did not copy is simply missing and the entry point fails to load.
      // Following the built imports cannot go stale, but a walker that quietly
      // followed none would look identical to one with nothing to follow.
      expect(copied.length).toBeGreaterThan(1);
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
      if (fs.existsSync(linked)) fs.rmSync(linked, { force: true, recursive: false });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
