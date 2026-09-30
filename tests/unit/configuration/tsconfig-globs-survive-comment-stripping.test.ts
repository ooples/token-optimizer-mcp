import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getSmartTsConfig } from '../../../src/tools/configuration/smart-tsconfig.js';
import { CacheEngine } from '../../../src/core/cache-engine.js';
import { TokenCounter } from '../../../src/core/token-counter.js';
import { MetricsCollector } from '../../../src/core/metrics.js';

/**
 * A tsconfig's globs must survive being read.
 *
 * Comments are stripped before JSON.parse because tsconfig allows them, and it
 * was done with a pair of regexes that read the file as though no string
 * literal existed. The commonest line in any tsconfig is a glob, and a
 * recursive one contains a slash-star followed by a star-slash -- so the
 * multi-line-comment pattern matched INSIDE the string and the tool reported
 * include: ["src*"].
 *
 * This tool's entire output is "here is the config that actually applies", and
 * a pattern with its separators removed applies to a different set of files.
 * So these read the globs back out of the tool, and each is paired with a
 * control showing the regexes really do mangle that same fixture -- without it
 * a fixture that never exercised the bug would pass just as happily.
 */
describe('smart_tsconfig reads globs, not comments', () => {
  const dirs: string[] = [];
  const caches: CacheEngine[] = [];

  afterEach(() => {
    while (caches.length) {
      try {
        caches.pop()?.close();
      } catch {
        // already closed
      }
    }
    while (dirs.length) {
      const dir = dirs.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // temp dir may linger on Windows
        }
      }
    }
  });

  function naiveStrip(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*/g, '');
  }

  async function resolveConfig(source: string) {
    const dir = mkdtempSync(join(tmpdir(), 'token-optimizer-tsconfig-'));
    dirs.push(dir);
    const cache = new CacheEngine(join(dir, 'cache.db'));
    caches.push(cache);
    const configPath = join(dir, 'tsconfig.json');
    writeFileSync(configPath, source);

    const tool = getSmartTsConfig(
      cache,
      new TokenCounter(),
      new MetricsCollector(),
      dir
    );
    const output = await tool.run({ configPath });
    return output.resolved;
  }

  const WITH_GLOBS = [
    '{',
    '  // Comments are allowed here, and TypeScript\'s own docs use them.',
    '  "compilerOptions": {',
    '    "target": "ES2022",',
    '    /* "strict": false, turned off during the migration */',
    '    "outDir": "dist"',
    '  },',
    '  "include": ["src/**/*"],',
    '  "exclude": ["node_modules", "dist"]',
    '}',
  ].join('\n');

  it('keeps a recursive glob intact', async () => {
    const resolved = await resolveConfig(WITH_GLOBS);
    expect(resolved?.include).toEqual(['src/**/*']);
    expect(resolved?.exclude).toEqual(['node_modules', 'dist']);
  });

  it('control: the regexes this replaced do mangle that same glob', () => {
    const parsed = JSON.parse(naiveStrip(WITH_GLOBS));
    expect(parsed.include).toEqual(['src*']);
  });

  it('still removes the comments it is there to remove', async () => {
    const resolved = await resolveConfig(WITH_GLOBS);
    expect(resolved?.compilerOptions?.outDir).toBe('dist');
    // Commented out, so it must not come back as a setting.
    expect(resolved?.compilerOptions?.strict).toBeUndefined();
  });

  const DOUBLED_SEPARATOR = [
    '{',
    '  "compilerOptions": { "target": "ES2022" },',
    '  "exclude": ["**/vendor//legacy"]',
    '}',
  ].join('\n');

  it('keeps a doubled separator that is inside a string', async () => {
    // What a naive path join leaves behind. It is two slashes in a value, not
    // the start of a comment, and the difference is a parse error.
    const resolved = await resolveConfig(DOUBLED_SEPARATOR);
    expect(resolved?.exclude).toEqual(['**/vendor//legacy']);
  });

  it('control: the regexes this replaced cannot even parse that one', () => {
    expect(() => JSON.parse(naiveStrip(DOUBLED_SEPARATOR))).toThrow();
  });
});
