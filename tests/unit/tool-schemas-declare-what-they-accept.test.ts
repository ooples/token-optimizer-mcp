import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  acceptedOptions,
  declaredProperties,
} from './helpers/schema-source.js';

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

  it('audits a tool whose options interface is not exported', () => {
    // THE HOLE THIS CLOSES, AND WHY THE COUNT ABOVE DID NOT CATCH IT. The
    // extractor once required `export interface`, so the 15 tools that declare
    // their options without it -- smart_build, smart_test, smart_lint,
    // smart_install, smart_docker, smart_typecheck among them -- were exempt
    // while appearing to pass. `audited` still cleared 40, because the count is
    // of FILES reached, and those files were reached; it was their options that
    // were invisible. A `deadlineMs` added to smart_build slipped through
    // exactly that way.
    //
    // Asserting on a specific non-exported interface is what makes the fix
    // self-protecting: narrowing the extractor back turns this red instead of
    // quietly re-exempting a sixth of the surface.
    const build = readFileSync(
      join(SRC, 'build-systems', 'smart-build.ts'),
      'utf8'
    );
    expect(/\n\s*interface SmartBuildOptions/.test(build)).toBe(true);
    expect(build).not.toContain('export interface SmartBuildOptions');
    expect(acceptedOptions(build)).toContain('deadlineMs');
  });

  it('does not mistake a nested data shape for a tool option', () => {
    // Widening the search brings in every `*Options` interface in the file, and
    // not all of them are arguments. `TsConfigCompilerOptions` describes the
    // contents of a tsconfig FILE -- `target`, `module`, `strict` -- which no
    // caller ever sends as MCP arguments; the tool accepts `compilerOptions` as
    // one field, and `nestedShape` is what looks inside it. Counting its 16
    // keys as undeclared options would be 16 false alarms, and false alarms are
    // how a ratchet gets switched off.
    const tsconfig = readFileSync(
      join(SRC, 'configuration', 'smart-tsconfig.ts'),
      'utf8'
    );
    const accepted = acceptedOptions(tsconfig);

    expect(accepted).toContain('configPath');
    expect(accepted).not.toContain('esModuleInterop');
    expect(accepted).not.toContain('skipLibCheck');
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
