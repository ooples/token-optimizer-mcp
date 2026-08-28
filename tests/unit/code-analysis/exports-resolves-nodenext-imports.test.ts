/**
 * An export used through a `./foo.js` import is USED.
 *
 * `smart_exports` proves an export is used by finding a file that imports it,
 * and `resolveImportPath` decides whether an import points at the file being
 * analysed. It appended candidate extensions to the specifier AS WRITTEN, so a
 * NodeNext import -- `./helper.js`, naming the emitted file, which is the style
 * this repository uses in every one of its own modules -- was only ever tried
 * as `helper.js`, then `helper.js.ts`, then `helper.js.tsx`. It never reached
 * `helper.ts`.
 *
 * WHY THAT IS WORSE THAN A MISSING FEATURE. The failure is silent and it points
 * the wrong way: an import that cannot be resolved is not reported as
 * unresolved, it is simply not counted, so the export it uses lands in
 * `unusedExports`. That is the one field of this tool's output that someone
 * acts on by DELETING code. On a NodeNext project it listed every export.
 *
 * Found while writing the traversal tests for #335: a fixture whose files
 * imported `'./file-000.js'` reported zero dependents at every scan depth,
 * which reads exactly like a broken depth bound and is not one.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';
import { SmartExportsTool } from '../../../src/tools/code-analysis/smart-exports.js';

let root: string;
let cache: CacheEngine;

const analyse = () =>
  new SmartExportsTool(
    cache,
    new TokenCounter(),
    new MetricsCollector(),
    root
  ).run({
    filePath: join(root, 'src', 'helper.ts'),
    projectRoot: root,
    checkUsage: true,
    scanDepth: 4,
    force: true,
  });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'exports-nodenext-'));
  mkdirSync(join(root, 'src', 'nested'), { recursive: true });

  writeFileSync(
    join(root, 'src', 'helper.ts'),
    'export const helper = 1;\nexport const neverUsed = 2;\n'
  );
  // The NodeNext spelling: names the emitted `.js`, resolves to the `.ts`.
  writeFileSync(
    join(root, 'src', 'uses-emitted-name.ts'),
    "import { helper } from './helper.js';\nexport const a = helper;\n"
  );
  // The extensionless spelling, which already worked and must keep working.
  writeFileSync(
    join(root, 'src', 'uses-extensionless.ts'),
    "import { helper } from './helper';\nexport const b = helper;\n"
  );
  // A relative import from one directory down, so the importing directory has
  // to be computed correctly rather than coming out empty.
  writeFileSync(
    join(root, 'src', 'nested', 'uses-from-nested.ts'),
    "import { helper } from '../helper.js';\nexport const c = helper;\n"
  );
  // Same-named file in another directory: must NOT be counted, or the fix has
  // simply made the matcher promiscuous.
  writeFileSync(
    join(root, 'src', 'nested', 'helper.ts'),
    'export const helper = 99;\n'
  );
  writeFileSync(
    join(root, 'src', 'nested', 'uses-its-own-helper.ts'),
    "import { helper } from './helper.js';\nexport const d = helper;\n"
  );

  cache = new CacheEngine(join(root, 'c.db'), 100);
});

afterAll(() => {
  try {
    cache.close?.();
  } catch {
    /* a cache that will not close must not fail the suite */
  }
  rmSync(root, { recursive: true, force: true });
});

describe('smart_exports resolves the imports projects actually write', () => {
  it('counts an importer that names the emitted .js file', async () => {
    const result = await analyse();
    const importers = result.dependencies.map((d) =>
      d.importingFile.replace(/^.*[\\/]/, '')
    );

    expect(importers).toContain('uses-emitted-name.ts');
    expect(importers).toContain('uses-from-nested.ts');
  }, 120_000);

  it('still counts the extensionless spelling', async () => {
    const result = await analyse();
    const importers = result.dependencies.map((d) =>
      d.importingFile.replace(/^.*[\\/]/, '')
    );

    expect(importers).toContain('uses-extensionless.ts');
  }, 120_000);

  it('does not claim an import of a DIFFERENT file with the same name', async () => {
    // The guard against fixing this by making the comparison loose. `nested/`
    // has its own `helper.ts`, and `nested/uses-its-own-helper.ts` imports
    // that one -- resolving on basename alone would count it.
    const result = await analyse();
    const importers = result.dependencies.map((d) =>
      d.importingFile.replace(/^.*[\\/]/, '')
    );

    expect(importers).not.toContain('uses-its-own-helper.ts');
    expect(new Set(importers).size).toBe(3);
  }, 120_000);

  it('reports an export nothing imports as unused, and one that is imported as used', async () => {
    // The whole point: `unusedExports` is what a caller deletes on.
    const result = await analyse();
    const unused = result.unusedExports.map((e) => e.name);

    expect(unused).toContain('neverUsed');
    expect(unused).not.toContain('helper');
  }, 120_000);
});
