/**
 * The invariants a linter cannot see.
 *
 * `n/no-sync` catches the mechanical half of #335 -- a blocking `*Sync` call --
 * and `eslint-suppressions.json` keeps the 306 existing ones from growing. What
 * no linter can check is whether a tool that CAN return a partial answer
 * actually SAYS so, and whether it refuses to cache one. Those are semantic,
 * they are where every real defect in this area was found, and they are the
 * reason this file exists rather than another lint rule.
 *
 * Each of the three rules below failed on real code before it was written:
 *
 *   - `deadlineMs` accepted but undeclared. The server spreads the caller's
 *     whole argument object into options, so an undeclared option WORKS while
 *     being undiscoverable -- and a caller who guesses a neighbouring name gets
 *     silence. smart_build shipped exactly this during #335 and the schema
 *     ratchet could not see it, because its options interface is not exported.
 *
 *   - A bounded walk whose result says nothing. `success: true` with a short
 *     file list is indistinguishable from a complete search; the caller acts on
 *     "no findings" and "nothing imports this" as though the tool had looked
 *     everywhere.
 *
 *   - A partial result written to the cache. This is the one that outlives the
 *     call: the keys are derived from cwd, or project path plus language, or
 *     file content -- never from WHICH FILES WERE REACHED -- so a truncated
 *     walk stored under one is served to every later call for the whole TTL,
 *     reporting `cacheHit: true` with no truncation flag at all. Three tools
 *     had this and all three tests failed before the guards were added.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { acceptedOptions, declaredProperties } from './helpers/schema-source.js';

const ROOT = process.cwd();
const TOOLS = join(ROOT, 'src', 'tools');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

interface BoundedTool {
  file: string;
  text: string;
}

/** Every tool that walks the filesystem through the bounded primitives. */
function boundedTools(): BoundedTool[] {
  const found: BoundedTool[] = [];
  for (const file of walk(TOOLS)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('bounded-traversal.js')) continue;
    if (!text.includes('_TOOL_DEFINITION')) continue;
    found.push({ file: relative(ROOT, file).replace(/\\/g, '/'), text });
  }
  return found;
}

const tools = boundedTools();

/**
 * Tools whose cache key already encodes which files were reached, so a partial
 * result cannot be served in answer to a complete one.
 *
 * AN EXEMPTION HERE NEEDS A REASON THAT IS TRUE OF THE KEY, not a note that the
 * author checked. smart_security hashes the discovered file set itself
 * (`generateCacheKey(files)`), so a truncated scan hashes differently and lands
 * under a different key -- the poisoning this rule prevents is impossible by
 * construction rather than by a guard.
 */
const KEY_ENCODES_COMPLETENESS: Record<string, string> = {
  'src/tools/code-analysis/smart-security.ts':
    'generateCacheKey hashes the discovered file set, so a partial scan gets its own key',
};

/**
 * Individual cache writes that cannot store a partial result, with the argument
 * for why -- matched on the call text so a rewrite invalidates the exemption
 * rather than silently carrying it forward.
 *
 * A whole-file exemption would be wrong for these: the same file has other
 * writes that DO need the guard, and blinding the rule to the file would take
 * those with it.
 */
const CACHE_WRITES_THAT_CANNOT_TRUNCATE: Record<string, string> = {
  'this.cacheGraph(cacheKey, updatedGraph, opts.ttl);':
    'the incremental path. `incrementalGraphUpdate` re-analyses only files ' +
    'already IN the graph and never walks the tree, so its result is exactly ' +
    'as complete as its input -- and its input came from the cache, which the ' +
    'guard on the full-build path keeps free of partial graphs. Safe by ' +
    'induction on that guard, so it breaks if the other one is ever removed; ' +
    'the full-build write is still checked.',
};

describe('every tool that can answer partially says so', () => {
  it('finds the bounded tools at all, so this file cannot pass by matching nothing', () => {
    // The failure mode of every guard in this repo: the scanner rots, finds
    // nothing, and the suite goes green while asserting about an empty set.
    expect(tools.length).toBeGreaterThanOrEqual(5);
  });

  it('declares deadlineMs in the published schema, not just accepts it', () => {
    const undeclared: string[] = [];
    for (const tool of tools) {
      if (!acceptedOptions(tool.text).includes('deadlineMs')) {
        undeclared.push(`${tool.file}: does not accept deadlineMs at all`);
        continue;
      }
      const declared = declaredProperties(tool.text);
      if (!declared || !declared.includes('deadlineMs')) {
        undeclared.push(`${tool.file}: accepts deadlineMs but does not declare it`);
      }
    }

    expect(undeclared).toEqual([]);
  });

  it('surfaces truncation in its result rather than returning a quiet partial', () => {
    // A bounded walk that reports nothing is worse than a timeout: the caller
    // cannot tell it from a complete answer, so it acts on the short one.
    //
    // LOOKS FOR THE ASSIGNMENT, NOT THE WORD. This first checked
    // `text.includes('searchTruncated')`, which a mutation walked straight
    // through: deleting the block that SETS the flag left the identifier behind
    // in the interface declaration and a comment, so the tool reported nothing
    // while the test stayed green. Mentioning a flag is not setting one.
    const reports = /(searchTruncated|filesCompiledPartial)\s*[:=]\s*true/;
    const silent = tools
      .filter((tool) => !reports.test(tool.text))
      .map((tool) => tool.file);

    expect(silent).toEqual([]);
  });

  it('never writes a bounded result into a cache', () => {
    // THE DEFECT THAT OUTLIVES THE CALL. Every cache write in a tool that can
    // truncate must be guarded by a truncation check, unless the key itself
    // encodes which files were reached.
    const unguarded: string[] = [];

    for (const tool of tools) {
      if (KEY_ENCODES_COMPLETENESS[tool.file]) continue;

      const lines = tool.text.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!/\bthis\.cache[A-Z]\w*\s*\(/.test(line)) return;
        if (CACHE_WRITES_THAT_CANNOT_TRUNCATE[line.trim()]) return;

        // The guard may be the enclosing `if`, so look back a few lines rather
        // than only at the call itself.
        const context = lines.slice(Math.max(0, index - 6), index + 1).join('\n');
        const guarded =
          /!\s*\w*[Tt]runcatedBy|!\s*\w+\.\w*[Tt]runcatedBy/.test(context);
        if (!guarded) {
          unguarded.push(`${tool.file}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    expect(unguarded).toEqual([]);
  });

  it('records an exemption only for a tool that actually exists', () => {
    // Stops the exemption list rotting into an allowlist that outlives the
    // problem, exactly as KNOWN_GAPS is prevented from doing.
    const stale = Object.keys(KEY_ENCODES_COMPLETENESS).filter(
      (file) => !tools.some((tool) => tool.file === file)
    );

    expect(stale).toEqual([]);
  });

  it('records a per-call exemption only for a call that is still there', () => {
    // Same rule for the narrower list. An exemption whose call has been renamed
    // or rewritten is no longer an argument about this code, and leaving it
    // would exempt whatever takes that text next.
    const everyLine = tools
      .flatMap((tool) => tool.text.split(/\r?\n/))
      .map((line) => line.trim());
    const stale = Object.keys(CACHE_WRITES_THAT_CANNOT_TRUNCATE).filter(
      (call) => !everyLine.includes(call)
    );

    expect(stale).toEqual([]);
  });
});

describe('the unbounded traversal APIs stay out of the tools', () => {
  it('uses no globSync anywhere under src/tools', () => {
    // `n/no-sync` does not catch this one: `globSync` is a bare import, not an
    // `fs.*Sync` member call, so the rule that covers the rest of the class
    // steps straight past the API that caused the original 178-second hang.
    const offenders: string[] = [];
    for (const file of walk(TOOLS)) {
      const text = readFileSync(file, 'utf8');
      text.split(/\r?\n/).forEach((line, index) => {
        const code = line.trim();
        if (code.startsWith('*') || code.startsWith('//')) return;
        if (/\bglobSync\s*\(|\bglob\.sync\s*\(/.test(code)) {
          offenders.push(`${relative(ROOT, file).replace(/\\/g, '/')}:${index + 1}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
