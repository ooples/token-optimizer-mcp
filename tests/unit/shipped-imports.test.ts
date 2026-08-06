import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { builtinModules } from 'module';

/**
 * What the shipped code imports must actually be there.
 *
 * Two failures of this kind were found by running every tool against a real
 * repository, and neither is visible from inside this checkout -- which is
 * exactly why they survived:
 *
 *   1. UNDECLARED PACKAGES. `yaml`, `@iarna/toml`, `graphlib`, `d3-force` and
 *      `chalk` were imported but never declared. Here they resolve out of
 *      node_modules; on a user's machine `npm i -g` installs only
 *      `dependencies`, so those modules throw "Cannot find package" on import.
 *
 *   2. EXTENSIONLESS DYNAMIC IMPORTS. `import('../../core/cache-engine')` is
 *      not resolvable in ESM -- Node does not guess the extension. Static
 *      imports in this codebase all carry `.js`; ten dynamic ones did not. A
 *      dynamic import only runs when its code path runs, so the module imported
 *      cleanly, the tool registered, it appeared in the tool list, and it threw
 *      the first time anybody CALLED it. smart_rest, smart_orm, smart_api_fetch
 *      and smart_cache_api were all broken this way.
 */
const ROOT = join(process.cwd(), 'src');
const PKG = JSON.parse(
  readFileSync(join(process.cwd(), 'package.json'), 'utf8')
);
const DECLARED = new Set(Object.keys(PKG.dependencies || {}));
const BUILTIN = new Set(builtinModules);

/**
 * Packages loaded through `optionalDependency()` or a guarded dynamic import.
 * These are allowed to be absent because the code handles it and says so.
 */
const OPTIONAL = new Set([
  'typescript',
  '@typescript-eslint/typescript-estree',
  '@babel/parser',
  'prettier',
  'highlight',
  'lz4',
  'zstd-codec',
  'snappy',
]);

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    // `.test.ts` never reaches dist, so what it imports cannot break a user.
    else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.test.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

const files = sources(ROOT);
const rel = (f: string) => relative(ROOT, f).split('\\').join('/');

/**
 * The file's leading import block.
 *
 * A real top-level import lives here. Anything further down that LOOKS like an
 * import is inside a string or a comment -- custom-widget.ts emits
 * `import React from 'react'` as generated code at line 871, which is its
 * output, not a dependency of this package.
 */
function importBlock(source: string): string[] {
  const out: string[] = [];
  for (const line of source.split('\n')) {
    const t = line.trim();
    if (
      t === '' ||
      t.startsWith('//') ||
      t.startsWith('*') ||
      t.startsWith('/*')
    ) {
      out.push(line);
      continue;
    }
    if (
      /^import[\s{*]/.test(t) ||
      /^\}\s*from\s/.test(t) ||
      /^['"][^'"]+['"];?$/.test(t)
    ) {
      out.push(line);
      continue;
    }
    break;
  }
  return out;
}

/** A comment mentioning code is not code. */
const isComment = (line: string): boolean => {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
};

describe('the shipped build only imports what it ships', () => {
  it('has sources to scan', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('declares every package it statically imports', () => {
    const undeclared: string[] = [];

    for (const file of files) {
      importBlock(readFileSync(file, 'utf8')).forEach((line, i) => {
        // Top-level static imports only; a `type` import is erased at compile
        // time and needs nothing at runtime.
        const m = line.match(
          /^import\s+(?!type\s)[^'"]*from\s+['"]([^'"]+)['"]/
        );
        if (!m) return;
        const spec = m[1];
        if (spec.startsWith('.') || spec.startsWith('node:')) return;
        const name = spec.startsWith('@')
          ? spec.split('/').slice(0, 2).join('/')
          : spec.split('/')[0];
        if (BUILTIN.has(name) || DECLARED.has(name) || OPTIONAL.has(name))
          return;
        undeclared.push(`${rel(file)}:${i + 1}  imports "${name}"`);
      });
    }

    expect(undeclared).toEqual([]);
  });

  it('gives every relative dynamic import its .js extension', () => {
    const bad: string[] = [];

    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (isComment(line)) return;
          for (const m of line.matchAll(
            /import\(\s*['"](\.[^'"]*)['"]\s*\)/g
          )) {
            if (!/\.(js|json|mjs|cjs)$/.test(m[1])) {
              bad.push(`${rel(file)}:${i + 1}  import('${m[1]}')`);
            }
          }
        });
    }

    expect(bad).toEqual([]);
  });

  it('never spawns a .cmd or .bat shim', () => {
    // Node 20.12+ refuses to spawn one without `shell: true` (CVE-2024-27980)
    // and throws EINVAL. Every build tool did this and was broken on Windows.
    // `shell: true` is not the fix -- it reintroduces the injection the code
    // was guarding against -- so nothing may name a shim at all.
    const shims: string[] = [];

    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (isComment(line)) return;
          if (
            /['"`][^'"`]*\.(cmd|bat)['"`]/.test(line) &&
            /spawn|exec/.test(line)
          ) {
            shims.push(`${rel(file)}:${i + 1}  ${line.trim().slice(0, 80)}`);
          }
          if (/\$\{[^}]*\}\.cmd/.test(line)) {
            shims.push(`${rel(file)}:${i + 1}  ${line.trim().slice(0, 80)}`);
          }
        });
    }

    expect(shims).toEqual([]);
  });
});
