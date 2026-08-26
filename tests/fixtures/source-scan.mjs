/**
 * One definition of "what counts as shipped code", shared by every guard that
 * reads this repository as text.
 *
 * WHY SHARED. `reachability.test.mjs` asks whether an exported name is called;
 * `census.test.mjs` asks whether a declared event kind, edge kind or tool name
 * has a producer and a consumer. Different questions, identical notion of where
 * the code is and which parts of a file are code -- and two copies of that
 * notion drift. When one of them learns that a comment is not a call site and
 * the other does not, the second reports confident nonsense and nobody
 * re-examines it, which is the exact failure mode these guards exist to catch.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Where DECLARATIONS live: the live hook path only.
 *
 * `src/tools` is excluded because its tools are dispatched by NAME through a
 * registry, so a name-based scan reports false positives there, and a blocking
 * check built on false positives gets disabled within a week.
 */
export const DECLARE_DIRS = ['hooks-core', 'plugin/hooks'];

/**
 * Where USAGES are searched: everything that ships.
 *
 * THIS MUST BE WIDER THAN THE DECLARATION SET. `src/server/*` reaches into
 * hooks-core through a dynamic `mods.<module>.<fn>` handle rather than a static
 * import, and eleven files under `scripts/` consume hooks-core directly -- the
 * installer and the uninstaller among them. A check that scans only where its
 * author expected the callers to be measures the author, not the code.
 */
export const USAGE_DIRS = ['hooks-core', 'plugin', 'src', 'scripts'];

/** Every source file under `dir`, minus the generated and vendored copies. */
export function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // `lib` holds the GENERATED copies of hooks-core; scanning them would
      // make every function look used by its own duplicate.
      if (['node_modules', 'dist', 'lib', '.git'].includes(entry)) continue;
      walk(full, out);
    } else if (/\.(mjs|js|ts)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** `{ file, text }` for every source file under each of `dirs`, relative to `repo`. */
export function readSources(repo, dirs) {
  return dirs
    .flatMap((d) => walk(join(repo, d)))
    .map((file) => ({ file, text: readFileSync(file, 'utf8') }));
}

/**
 * Strips comments, so prose cannot be mistaken for code.
 *
 * THIS IS WHAT LET A DEAD PUBLIC ENTRY POINT THROUGH. `calibrate` counted as
 * reachable because curate.mjs contains the English phrase "the reader's
 * ability to calibrate trust", and `reliability` counted because the word
 * appears in its own file's prose. calibration.mjs had ZERO importers -- no
 * forecast was ever logged, no outcome observed, and the shipped panel printed
 * precisely the uncalibrated number that module's docstring calls "a vibe with
 * a typeface" -- while the check that exists to catch exactly this reported it
 * as wired, on a coincidence of comment wording.
 *
 * COMMENTS ONLY, NOT STRING LITERALS, and that boundary has now been moved
 * twice and measured back twice. Both attempts are recorded here so the third
 * reader does not spend the afternoon rediscovering them.
 *
 * FIRST ATTEMPT -- three global regex passes that also stripped quotes. It made
 * `routingReport` and `modelSwitchCost` look orphaned while routing-tool.ts
 * called both: independent global passes cannot nest, so an apostrophe inside a
 * DOUBLE-quoted sentence opened a "single-quoted string" that ran to the next
 * apostrophe further down the file and swallowed the real call sites between.
 *
 * SECOND ATTEMPT -- a hand-written character scanner, on the reasoning that a
 * scanner cannot suffer the non-nesting problem. It cannot, and it fails worse:
 * a JS lexer that knows about quotes but not about REGEX LITERALS desynchronises
 * on the first regex containing a quote, and this repository has them --
 *
 *   hooks-core/adapter.mjs:255
 *   /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*((?:"(?:\\.|[^"\\])*")|...)/gs
 *
 * MEASURED: adapter.mjs 1032 newlines in, 385 out -- 63% of the file consumed;
 * disclose.mjs 69%. Eleven genuinely-called exports fell to a single reference,
 * their own declaration, and reported as orphans.
 *
 * Telling a regex literal from a division needs parse context, which means a
 * real parser -- a dependency and a maintenance surface for a guard whose
 * entire value is that nobody switches it off. Over-counting a name that
 * appears in a string is the PERMISSIVE direction, and permissive is merely
 * useless where strict fails CI on working code and gets deleted. Comments
 * only. The line stays where the measurement put it.
 */
export function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')     // block comments, including docblocks
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); // line comments, sparing the // in a URL
}

/**
 * Blanks the specifier list of an `import {...}` / `export {...}` statement.
 *
 * IMPORTED IS NOT CALLED, and the reachability guard could not tell the
 * difference. Found by mutation: dropping the `cacheOrdered` CALL from
 * inject.mjs while leaving `import { cacheOrdered } from './cache.mjs'` in
 * place left the suite GREEN. Only deleting the import as well turned it red --
 * so any refactor that removed the last call but left a tidy-looking import
 * would have restored the exact defect that guard exists to catch, silently.
 *
 * Only the braces are blanked, not the whole statement: the module path is left
 * alone, and a default or namespace import (`import x from`, `import * as x`)
 * is deliberately untouched. Those bind a name that ordinary code then has to
 * call, so they are not the specifier case, and widening this would move the
 * guard in the strict direction for no measured defect.
 */
export function stripSpecifiers(code) {
  return String(code)
    .replace(/\bimport\s*\{[^}]*\}\s*from\b/g, ' importfrom ')
    .replace(/\bexport\s*\{[^}]*\}(\s*from\b)?/g, ' exportfrom ');
}

/**
 * The text following each call to `name(`, bounded to `window` characters.
 *
 * DELIBERATELY A WINDOW RATHER THAN AN ARGUMENT PARSE. Splitting a call's
 * arguments correctly means tracking nesting through strings, template
 * interpolations and regex literals -- the same problem stripComments refuses
 * for the same reason. A window over-reports: it can attribute a literal that
 * belongs to a nested call to the outer one.
 *
 * OVER-REPORTING IS THE SAFE DIRECTION HERE, and the direction matters per
 * assertion, so callers must think about it. "Every declared kind has a
 * writer" is permissive under over-reporting -- a spurious writer only ever
 * silences a complaint. "Written but never read" is NOT, which is why the read
 * side of that census is deliberately generous too.
 *
 * The plan this came from proposed a single-line regex taking the SECOND
 * argument of `putEdge(dir, from, edge, to)`. Two defects in one line: the edge
 * kind is the third argument, and the call that writes `calls` edges spans six
 * lines in staleness.mjs, so a line-anchored pattern reported the graph's
 * call-edge kind as having no writer at all. Measured against grep before it
 * was believed.
 */
export function callWindows(code, name, window = 500) {
  const out = [];
  const call = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let m;
  while ((m = call.exec(code)) !== null) out.push(code.slice(m.index, m.index + window));
  return out;
}

/**
 * The keys of the first object literal passed to each call of `name(`, at the
 * literal's top level only.
 *
 * BRACE-BALANCED RATHER THAN WINDOWED, because here over-reporting is the
 * STRICT direction. This feeds the unread-field census, where a spuriously
 * detected write becomes a spurious orphan and fails CI on working code. A
 * fixed character window did exactly that on the first measurement: it ran past
 * the end of a `record()` call in mcp-evidence.ts and into the next function,
 * collecting `toolProfile` -- which belongs to `recordMcpDiagnostic` and is
 * written twice -- as a field of the graph record. One false positive in seven
 * is far too many for a blocking check.
 *
 * TOP LEVEL ONLY, which is what "record field" means: `rejected: [{ key,
 * reason }]` contributes `rejected`, not `key` and `reason`. Those belong to a
 * nested shape with its own reader.
 *
 * PERMISSIVE ON FAILURE. A literal that does not balance inside `limit`
 * characters is SKIPPED rather than half-parsed, so an unparsed call site can
 * only ever make this census quieter -- never make it accuse working code. The
 * brace counter is not string-aware, for the reason stripComments records
 * above, so a brace inside a string or a regex is what a skip protects against.
 */
export function objectLiteralKeys(code, name, limit = 4000) {
  const out = [];
  const call = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let m;
  while ((m = call.exec(code)) !== null) {
    const open = code.indexOf('{', m.index);
    if (open === -1 || open - m.index > 200) continue;

    let depth = 0;
    let end = -1;
    for (let i = open; i < Math.min(code.length, open + limit); i += 1) {
      if (code[i] === '{') depth += 1;
      else if (code[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) continue; // unbalanced within the limit: skip, never guess

    const keys = [];
    let level = 0;
    for (let i = open; i <= end; i += 1) {
      const c = code[i];
      if (c === '{' || c === '[' || c === '(') level += 1;
      else if (c === '}' || c === ']' || c === ')') level -= 1;
      else if (level === 1) {
        const rest = code.slice(i, i + 80);
        const key = /^([A-Za-z_$][\w$]*)\s*:/.exec(rest);
        if (key) { keys.push(key[1]); i += key[1].length; }
      }
    }
    out.push(keys);
  }
  return out;
}
