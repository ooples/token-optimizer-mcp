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

interface ToolDefinition {
  /** The exported identifier, e.g. SMART_READ_TOOL_DEFINITION. */
  id: string;
  /** The name a client calls, e.g. smart_read. */
  name: string;
  /** Path relative to the repository root, for a failure message. */
  file: string;
}

/**
 * Every tool definition that exists under src/tools, by BOTH of the two naming
 * conventions the repository uses: the modern `X_TOOL_DEFINITION` with an
 * underscore tool name, and the legacy `XTOOL` with a hyphenated one. A
 * detector that knows only one of them is blind to half the surface, which is
 * how a whole class of unreachable tool survived the checks below.
 *
 * A match must carry a `name:` and an `inputSchema:` at the object's own
 * indentation, with the name first -- that is what makes it a tool definition
 * rather than some other exported constant. Matching loosely inside a fixed
 * window instead lets an unrelated `export const X_INPUT_SCHEMA` swallow the
 * real definition that follows it.
 */
function definedTools(): ToolDefinition[] {
  const defs: ToolDefinition[] = [];

  (function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts'))
        continue;

      const src = readFileSync(full, 'utf8');
      for (const m of src.matchAll(
        /(?:^|\n)export const ([A-Z][A-Z0-9_]*)(?::[^=\n]*)?\s*=\s*\{\r?\n([\s\S]*?)\r?\n\}(?: as const)?;/g
      )) {
        const body = m[2];
        const name = /(?:^|\n) {2}name: '([a-zA-Z0-9_-]+)',/.exec(body);
        const schema = /(?:^|\n) {2}inputSchema: \{/.exec(body);
        if (name === null || schema === null) continue;
        if (schema.index < name.index) continue;
        defs.push({
          id: m[1],
          name: name[1],
          file: full.slice(ROOT.length + 1).replace(/\\/g, '/'),
        });
      }
    }
  })(join(ROOT, 'src/tools'));

  return defs;
}

/** The identifiers the server actually puts in its advertised list. */
function listedIdentifiers(): Set<string> {
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

  return new Set(
    [...listBlock.matchAll(/(?:^|\n)\s{2}([A-Z][A-Z0-9_]*),/g)].map((m) => m[1])
  );
}

describe('every advertised tool can actually be called', () => {
  const listed = listedIdentifiers();
  const defined = definedTools();
  const names = defined.filter((d) => listed.has(d.id)).map((d) => d.name);

  it('found the advertised tools', () => {
    expect(names.length).toBeGreaterThan(40);
  });

  it('reads both of the naming conventions in use', () => {
    // A POSITIVE CONTROL FOR THE SCANNER. Every other assertion here is a
    // filter over `defined`, so an expression that quietly matched nothing
    // would report a clean surface. These two are real definitions written in
    // the two different styles; if either stops being found, the scanner has
    // gone blind and the emptiness below means nothing.
    const ids = new Set(defined.map((d) => d.id));
    expect(ids.has('SMART_READ_TOOL_DEFINITION')).toBe(true);
    expect(ids.has('PATTERNRECOGNITIONTOOL')).toBe(true);
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

describe('no tool definition is left out of the advertised list', () => {
  it('every definition under src/tools is registered', () => {
    // FOUR TOOLS WERE IN EXACTLY THIS STATE: knowledge_graph,
    // sentiment_analysis, smart_workflow and anomaly_explainer were each
    // implemented, exported with a published inputSchema -- and named in no
    // profile, so the CallTool handler refused them by name. Nothing failed,
    // because the checks above start from the advertised list and an
    // unadvertised definition is simply not in it. This one starts from the
    // definitions instead, which is the only direction that can see them.
    const listed = listedIdentifiers();
    const orphans = definedTools()
      .filter((d) => !listed.has(d.id))
      .map((d) => `${d.id} (${d.name}) in ${d.file}`);

    expect(orphans).toEqual([]);
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
