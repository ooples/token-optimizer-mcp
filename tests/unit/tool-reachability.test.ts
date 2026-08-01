import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { toolSchemaMap } from '../../src/validation/tool-schemas.js';

/**
 * A tool that is advertised must be callable, and calling one must not break
 * the next.
 *
 * Both halves of this were violated at once, and neither showed up in any unit
 * test, because both live in the seams BETWEEN parts that each work fine:
 *
 *   1. NO VALIDATION SCHEMA. Every tools/call goes through validateToolArgs,
 *      which throws "Unknown tool: X. No validation schema available." when the
 *      name is absent from toolSchemaMap. Seventeen advertised tools had no
 *      entry -- the fifteen newly registered ones, plus cache_benchmark and
 *      smart_cache_api, which advertised a HYPHENATED name while their schema
 *      key and dispatch case both used underscores. A client calling the
 *      advertised name could never reach either.
 *
 *      That error arrives inside a successful JSON-RPC RESULT, not in the error
 *      field, so a harness that only inspects `error` reports a healthy call.
 *      That is exactly how I first reported "0 broken" while 13 were broken.
 *
 *   2. CLOSING SOMEONE ELSE'S CACHE. runSmartSymbols accepted an optional
 *      CacheEngine and closed it in a `finally` regardless of who created it.
 *      The server hands its ONE shared cache to every tool, so a single
 *      smart_symbols call closed that handle and every later tools/call in the
 *      process failed with "The database connection is not open" -- twenty
 *      tools down from one call, until the server was restarted.
 */
const ROOT = process.cwd();

/** Every tool name the server advertises, read from the definitions it lists. */
function advertisedNames(): string[] {
  const server = readFileSync(join(ROOT, 'src/server/index.ts'), 'utf8');

  // The advertised list lives in `const TOOL_DEFINITIONS = [ ... ]`, which the
  // ListTools handler returns and the required-field guard reads. It used to be
  // an inline `tools: [ ... ]`; both spellings are accepted here so this test
  // pins the CONTENT of the list rather than where it happens to be written.
  const listStart = (() => {
    const named = server.indexOf('const TOOL_DEFINITIONS = [');
    return named !== -1 ? named : server.indexOf('tools: [');
  })();
  const listEnd = (() => {
    const closing = server.indexOf(`${'\n'}];`, listStart);
    const legacy = server.indexOf('};', listStart);
    if (closing === -1) return legacy;
    if (legacy === -1) return closing;
    return Math.min(closing, legacy);
  })();
  const listBlock = server.slice(listStart, listEnd);
  const defs = new Set(
    [...listBlock.matchAll(/([A-Z0-9_]+_TOOL_DEFINITION)/g)].map((m) => m[1])
  );

  const names: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const src = readFileSync(full, 'utf8');
        for (const m of src.matchAll(
          /export const ([A-Z0-9_]+_TOOL_DEFINITION)[\s\S]{0,400}?name:\s*['"]([a-zA-Z0-9_-]+)['"]/g
        )) {
          if (defs.has(m[1])) names.push(m[2]);
        }
      }
    }
  })(join(ROOT, 'src/tools'));

  return names;
}

describe('every advertised tool can actually be called', () => {
  const names = advertisedNames();

  it('found the advertised tools', () => {
    expect(names.length).toBeGreaterThan(40);
  });

  it('has a validation schema for each one', () => {
    const missing = names.filter((n) => !(n in toolSchemaMap));
    expect(missing).toEqual([]);
  });

  it('advertises names in the same form the dispatch uses', () => {
    // cache-benchmark / smart-cache-api advertised hyphens while their case
    // labels used underscores, so no client could route to them.
    const server = readFileSync(join(ROOT, 'src/server/index.ts'), 'utf8');
    const cases = new Set(
      [...server.matchAll(/case\s+'([a-zA-Z0-9_-]+)':/g)].map((m) => m[1])
    );
    const unroutable = names.filter((n) => !cases.has(n));
    expect(unroutable).toEqual([]);
  });
});

describe('a tool must not close a cache it was handed', () => {
  it('no runner closes an injected CacheEngine unconditionally', () => {
    const offenders: string[] = [];

    (function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts')
        ) {
          const src = readFileSync(full, 'utf8');
          for (const m of src.matchAll(
            /export async function (run[A-Za-z0-9]+)\(([\s\S]{0,400}?)\)\s*:/g
          )) {
            const [, name, params] = m;
            if (!/cache\??\s*:\s*CacheEngine/.test(params)) continue;

            const start = m.index!;
            const next = src.indexOf('\nexport ', start + 10);
            const body = src.slice(start, next === -1 ? src.length : next);

            const injected =
              /=\s*cache\s*\|\|\s*new CacheEngine|cache\s*\?\?\s*new CacheEngine/.test(
                body
              );
            const closes = /finally\s*\{[\s\S]{0,200}?\.close\(\)/.test(body);
            const guarded = /ownsCache|createdCache/.test(body);

            if (injected && closes && !guarded) {
              offenders.push(`${entry.name} ${name}`);
            }
          }
        }
      }
    })(join(ROOT, 'src/tools'));

    expect(offenders).toEqual([]);
  });
});
