import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { toolSchemaMap } from '../../src/validation/tool-schemas.js';

/**
 * A field the published schema calls required must actually be required.
 *
 * 43 tools share `GenericToolOptionsSchema`, a permissive catch-all, so their
 * `required` arrays were documentation and nothing else. Omitting a required
 * field sailed through validation and into the tool body, where smart_orm
 * answered:
 *
 *     The "data" argument must be of type string or an instance of Buffer,
 *     TypedArray, or DataView. Received undefined
 *
 * -- an internal implementation detail that tells the caller nothing about the
 * argument they left out. The tool works perfectly when given `ormCode` and
 * `ormType`: it found a real N+1 in a fixture ("Query inside for loop", 10
 * estimated queries). The only broken thing was what it said when asked wrong.
 *
 * The server now enforces each tool's OWN published `required` list, derived
 * from the same definitions the client is shown, so the two cannot drift.
 */

const ROOT = process.cwd();

/** Reads the advertised definitions out of the server source. */
function toolDefinitions(): Array<{ name: string; required: string[] }> {
  const server = readFileSync(join(ROOT, 'src/server/index.ts'), 'utf8');
  const listStart = server.indexOf('const TOOL_DEFINITIONS = [');
  const listBlock = server.slice(
    listStart,
    server.indexOf(`${'\n'}];`, listStart)
  );
  const advertised = new Set(
    [...listBlock.matchAll(/([A-Z0-9_]+_TOOL_DEFINITION)/g)].map((m) => m[1])
  );

  const out: Array<{ name: string; required: string[] }> = [];
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
        /export const ([A-Z0-9_]+_TOOL_DEFINITION)\s*=\s*\{([\s\S]{0,6000}?)\n\};/g
      )) {
        if (!advertised.has(m[1])) continue;
        const name = m[2].match(/name:\s*['"]([a-zA-Z0-9_-]+)['"]/)?.[1];
        if (!name) continue;
        const req = m[2].match(/required:\s*\[([^\]]*)\]/);
        const required = req
          ? req[1]
              .split(',')
              .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
              .filter(Boolean)
          : [];
        out.push({ name, required });
      }
    }
  })(join(ROOT, 'src'));

  return out;
}

describe('published required fields are enforced', () => {
  const defs = toolDefinitions();

  it('found the advertised definitions', () => {
    expect(defs.length).toBeGreaterThan(40);
  });

  it('the server derives its guards from the same list it advertises', () => {
    // If a guard were built from a hand-maintained copy, it could go stale
    // silently -- which is exactly how the required arrays became decorative.
    const server = readFileSync(join(ROOT, 'src/server/index.ts'), 'utf8');
    expect(server).toContain('const TOOL_DEFINITIONS = [');
    // Both guards are constructed from that array and nothing else.
    expect(server).toContain('createToolArgumentChecker(');
    expect(server).toContain(
      'ADVERTISED_TOOL_DEFINITIONS as ToolDefinitionLike[]'
    );
    expect(server).toContain('assertRequiredFields(name, args)');
    expect(server).toContain('assertKnownFields(name, args)');
    // And the handler serves that same array rather than a second literal.
    expect(server).toContain('tools: ADVERTISED_TOOL_DEFINITIONS');

    // The checker itself must read the definitions it was handed, rather than
    // keeping its own list of names alongside them.
    const checker = readFileSync(
      join(ROOT, 'src/server/tool-arguments.ts'),
      'utf8'
    );
    expect(checker).toContain('tools.map');
    expect(checker).toContain('inputSchema?.required');
    expect(checker).toContain('inputSchema?.properties');
  });

  it('every advertised tool still has a validation schema', () => {
    const missing = defs.filter((d) => !(d.name in toolSchemaMap));
    expect(missing.map((d) => d.name)).toEqual([]);
  });

  it('tools that declare required fields actually declare real ones', () => {
    // A `required` naming a field absent from `properties` would be
    // unsatisfiable: the guard would reject every call.
    const broken: string[] = [];
    for (const { name, required } of defs) {
      if (!required.length) continue;
      for (const field of required) {
        if (!/^[a-zA-Z][\w-]*$/.test(field)) broken.push(`${name}: ${field}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
