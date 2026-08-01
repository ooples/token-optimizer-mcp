import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * A tool's published schema must describe everything the tool can do.
 *
 * `optimization_storage` and `context_delta` were each published as a top-level
 * JSON Schema `oneOf`, one branch per operation, with `operation` pinned to a
 * const in each. That is legal, and the Zod validation behind it was correct.
 *
 * But MCP clients FLATTEN a top-level oneOf to its first branch. Measured
 * against a real client, `optimization_storage` advertised
 * `operation: {const: "store"}` and nothing else -- `retrieve` was absent from
 * the contract, and `context_delta` lost `seed` and `clear` the same way. Both
 * operations still worked when called. They simply could not be found, which
 * for a tool nobody has memorised amounts to the same thing.
 *
 * The remedy is a flat object with `operation` as an ENUM and per-field notes
 * about which operations need which fields. Strictness lives in the Zod schema,
 * where it belongs; the published schema's job is to be readable.
 */

// process.cwd(), not __dirname: these suites run under ESM in the full run,
// where __dirname does not exist. It passed alone and failed in the suite.
const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('published tool schemas', () => {
  it('never puts oneOf/anyOf at the top level of an inputSchema', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('inputSchema')) continue;

      // Look only at the top level of each inputSchema: the two lines that
      // follow `inputSchema: {` and its `type: 'object',`. A oneOf NESTED
      // inside a property is fine -- clients render those.
      const pattern =
        /inputSchema:\s*\{\s*(?:\/\/[^\n]*\n\s*)*type:\s*'object',\s*(oneOf|anyOf)\s*:/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const line = text.slice(0, match.index).split('\n').length;
        offenders.push(
          `${file.replace(SRC, 'src')}:${line} uses top-level ${match[1]}`
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it('lists every operation in the operation enum', () => {
    // Guards the specific regression: an `operation` property whose only
    // permitted value is a single const, on a tool whose description
    // advertises several operations.
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('TOOL_DEFINITION')) continue;

      // "Operations: a, b, c." in the description is the tool's own claim.
      const claim = text.match(/Operations:\s*([a-z0-9,\-\s]+)\./i);
      if (!claim) continue;
      const claimed = claim[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (claimed.length < 2) continue;

      const enumMatch = text.match(/operation:\s*\{[^}]*enum:\s*\[([^\]]+)\]/);
      const advertised = enumMatch
        ? enumMatch[1]
            .split(',')
            .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        : [];

      const missing = claimed.filter((op) => !advertised.includes(op));
      if (missing.length) {
        offenders.push(
          `${file.replace(SRC, 'src')} claims [${claimed.join(', ')}] ` +
            `but advertises [${advertised.join(', ') || 'none'}]`
        );
      }
    }

    expect(offenders).toEqual([]);
  });
});
