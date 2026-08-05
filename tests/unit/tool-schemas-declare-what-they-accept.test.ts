import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * A tool's published inputSchema must declare every option it accepts.
 *
 * THIS IS NOT TIDINESS. The server hands the caller's whole argument object to the
 * implementation -- `const { pattern, ...options } = args as any` -- so every field
 * of an Options interface is reachable over MCP. An option missing from inputSchema
 * is therefore not "undocumented", it is a schema that lies: the caller cannot know
 * the option exists, and a caller that guesses a NEIGHBOURING name gets silence,
 * because `tool-arguments.ts` only refuses near-misses of DECLARED fields.
 *
 * That silence has cost real bugs, all found by using the tools rather than reading
 * them:
 *
 *   - smart_grep and smart_glob did not declare `path`. Callers passed it, it was
 *     dropped, `cwd` fell back to process.cwd(), and every "scoped" search silently
 *     walked 676,875 files from the home directory. smart_grep then died on
 *     `RangeError: Maximum call stack size exceeded` for every caller in every
 *     project; smart_glob returned confident results about the wrong repository.
 *   - `expand` prints "expand <id>" but its parameter is `ref`, so a caller
 *     following the printed hint got "No stored output for reference undefined".
 *   - smart_edit takes `operations`, not `edits`; the wrong name is a validation
 *     error rather than a silent drop only because `operations` is required.
 *
 * When this test was written the surface had 29 tools with 166 undeclared options.
 * Every one of them is a way for a caller to be quietly ignored.
 *
 * Function-valued options are excluded automatically -- a callback cannot cross a
 * JSON boundary, so it is genuinely programmatic-only. That exclusion is computed
 * from the declared TYPE rather than kept as a hand-maintained list, so it cannot
 * become a place to hide a real omission.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, 'src', 'tools');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
      out.push(full);
  }
  return out;
}

/**
 * Top-level keys of the object literal whose `{` is at `open`.
 *
 * COMMENT-AWARE, and that is not a nicety. Without it an apostrophe inside a `//`
 * comment -- "the caller's argument object" -- opens a string that never closes, and
 * every key after it is swallowed. That happened while writing this file: the audit
 * reported 11 newly declared properties as still missing, and the numbers looked
 * plausible enough to believe. A scanner that silently under-reports is worse than
 * no scanner, because it makes a real gap look fixed.
 */
function topLevelKeys(text: string, open: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let inString: string | null = null;

  for (let i = open; i < text.length; i++) {
    const c = text[i];

    if (inString) {
      if (c === '\\') i++;
      else if (c === inString) inString = null;
      continue;
    }

    // Comments first: their contents are prose, not syntax.
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      if (end === -1) break;
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      continue;
    }
    if (c === '{' || c === '[') {
      depth++;
      continue;
    }
    if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1 && /[A-Za-z_$]/.test(c)) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(text.slice(i));
      if (m) {
        keys.push(m[1]);
        i += m[1].length;
      }
    }
  }
  return keys;
}

/**
 * Property names a schema declares, counting an `options` sub-object as declared.
 *
 * MOST tools are flattened by the server -- `const { pattern, ...options } = args` --
 * so their options belong at the top level. A few instead take options as a SEPARATE
 * argument (`run(target, options)`) and nest them under an `options` property, which is
 * correct for that call shape. Counting only top-level keys reported those as
 * undeclared, which was the checker being wrong rather than the tool: smart_workflow
 * declares all six of its options inside `options`, exactly as its signature expects.
 */
function declaredProperties(text: string): string[] | null {
  const schema = text.indexOf('inputSchema');
  if (schema === -1) return null;
  const props = text.indexOf('properties:', schema);
  if (props === -1) return null;
  const open = text.indexOf('{', props);
  if (open === -1) return null;

  const top = topLevelKeys(text, open);
  if (!top.includes('options')) return top;

  // Descend into the `options` object and treat its keys as declared too.
  const optionsKey = text.indexOf('options:', open);
  const nestedProps =
    optionsKey === -1 ? -1 : text.indexOf('properties:', optionsKey);
  if (nestedProps === -1) return top;
  const nestedOpen = text.indexOf('{', nestedProps);
  return nestedOpen === -1 ? top : [...top, ...topLevelKeys(text, nestedOpen)];
}

/**
 * Option names an interface accepts, with function-typed fields dropped.
 *
 * A `(x) => y` field cannot be expressed in JSON Schema and cannot arrive over MCP,
 * so it is programmatic-only rather than undeclared.
 */
function acceptedOptions(text: string): string[] {
  const fields: string[] = [];

  for (const match of text.matchAll(/export interface\s+\w*Options\s*\{/g)) {
    const open = text.indexOf('{', match.index);
    let depth = 0;

    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (c === '{') {
        depth++;
        continue;
      }
      if (c === '}') {
        depth--;
        if (depth === 0) break;
        continue;
      }
      if (depth !== 1 || text[i - 1] !== '\n') continue;

      const line = /^\s*([A-Za-z_$][\w$]*)\??\s*:\s*([^;\n]*)/.exec(
        text.slice(i)
      );
      if (!line) continue;

      const [, name, type] = line;

      // NOT EXPRESSIBLE AS JSON, so not declarable and not reachable over MCP.
      //
      // Functions are obvious. `Buffer` is here for the same reason and was checked
      // rather than assumed: cache_compression's `dictionary` is handed straight to
      // zlib as a Buffer, so declaring it as a base64 string would promise a shape the
      // implementation cannot consume -- a different lie from the one this test exists
      // to catch, not a fix for it.
      const isFunction = type.includes('=>') || /\bFunction\b/.test(type);
      const isBinary = /\bBuffer\b/.test(type);
      if (!isFunction && !isBinary) fields.push(name);
    }
  }

  return [...new Set(fields)];
}

function toolName(text: string): string {
  return /name:\s*'([a-z0-9_-]+)'/i.exec(text)?.[1] ?? 'unknown';
}

interface Gap {
  tool: string;
  file: string;
  undeclared: string[];
}

function audit(): Gap[] {
  const gaps: Gap[] = [];

  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('_TOOL_DEFINITION')) continue;

    const declared = declaredProperties(text);
    if (!declared) continue;

    const accepted = acceptedOptions(text);
    if (!accepted.length) continue;

    const undeclared = accepted.filter((option) => !declared.includes(option));
    if (undeclared.length) {
      gaps.push({
        tool: toolName(text),
        // Repo-relative and forward-slashed, with no leading separator, so the keys in
        // KNOWN_GAPS read the way a path appears in a diff.
        file: file.replace(ROOT, '').replace(/\\/g, '/').replace(/^\//, ''),
        undeclared,
      });
    }
  }

  return gaps;
}

/**
 * The gaps that still exist, pinned exactly.
 *
 * A RATCHET, not an allowlist. The surface had 29 tools with 166 undeclared options;
 * 12 tools and 80 options were closed, and the rest are recorded here so that:
 *
 *   - adding a NEW undeclared option to any tool fails immediately, which is the
 *     regression this file exists to prevent;
 *   - closing one of these fails too, until it is struck off -- so the list can only
 *     shrink, and progress is visible in the diff rather than in a summary.
 *
 * This is debt, written down. It is not permission. Every entry is a way for a caller
 * to pass an option and be silently ignored, and the ones marked (registered) are
 * reachable over MCP today.
 */
const KNOWN_GAPS: Record<string, string[]> = {
  // registered — reachable over MCP
};

describe('every tool declares the options it accepts', () => {
  const gaps = audit();

  it('introduces no undeclared option beyond the recorded debt', () => {
    const unexpected = gaps.flatMap((g) => {
      const known = KNOWN_GAPS[g.file] ?? [];
      return g.undeclared
        .filter((o) => !known.includes(o))
        .map((o) => `${g.file}: ${o}`);
    });

    expect(unexpected).toEqual([]);
  });

  it('records no debt that has already been paid off', () => {
    // Forces the list to shrink as tools are fixed, instead of rotting into an
    // allowlist that outlives the problem.
    const stale: string[] = [];
    for (const [file, options] of Object.entries(KNOWN_GAPS)) {
      const found = gaps.find((g) => g.file === file)?.undeclared ?? [];
      for (const option of options) {
        if (!found.includes(option)) stale.push(`${file}: ${option}`);
      }
    }

    expect(stale).toEqual([]);
  });

  it('has no undeclared option anywhere', () => {
    // THE RATCHET IS NOW AT ZERO. It started at 29 tools and 166 options, was carried
    // for a while as recorded debt, and is empty: every tool declares everything it
    // accepts. Stated as its own assertion so the goal cannot quietly become "no
    // WORSE than the list", which is all the two tests above check once KNOWN_GAPS is
    // empty.
    const report = gaps
      .map((g) => `${g.file}: ${g.undeclared.join(', ')}`)
      .join('\n');

    expect(report).toBe('');
    expect(Object.keys(KNOWN_GAPS)).toEqual([]);
  });

  it('audits a meaningful number of tools, so it cannot pass by finding nothing', () => {
    // If the extraction breaks, `gaps` empties and this file would go green while
    // asserting nothing at all.
    let audited = 0;
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      if (
        text.includes('_TOOL_DEFINITION') &&
        declaredProperties(text) &&
        acceptedOptions(text).length
      ) {
        audited++;
      }
    }

    expect(audited).toBeGreaterThan(40);
  });

  it('drops function-valued options, which cannot arrive over MCP', () => {
    const sample = `
      export interface XOptions {
        onProgress?: (n: number) => void;
        keyGenerator?: Function;
        depth?: number;
      }
    `;

    expect(acceptedOptions(sample)).toEqual(['depth']);
  });

  it('does not lose keys to an apostrophe in a comment', () => {
    // The scanner bug that made this audit under-report while it was being written:
    // "caller's" opened a string that never closed, hiding every later key.
    const sample = `
      export const X_TOOL_DEFINITION = {
        inputSchema: {
          properties: {
            first: { type: 'string' },
            // spreads the caller's whole argument object
            second: { type: 'number' },
            third: { type: 'boolean', description: 'pass [] to search everything' },
          },
        },
      };
    `;

    expect(declaredProperties(sample)).toEqual(['first', 'second', 'third']);
  });
});
