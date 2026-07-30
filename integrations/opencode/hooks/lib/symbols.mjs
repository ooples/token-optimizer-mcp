// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/symbols.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Zero-dependency symbol extraction.
 *
 * WHY NOT tree-sitter: these run on every tool call, in a hook, where startup
 * cost is paid per invocation. A native dependency plus per-language grammar
 * downloads would be the heaviest thing in a package that is otherwise
 * dependency-light, to buy accuracy on constructs that mostly do not change the
 * answer.
 *
 * WHY REGEX IS ACCEPTABLE HERE, specifically: a missed symbol is not a wrong
 * answer, it is a COARSER one. Findings simply anchor to the file instead of the
 * function, and staleness falls back to file granularity -- which is exactly
 * what P1 already did. The failure mode is graceful degradation to the previous
 * behaviour, never incorrect invalidation.
 *
 * What this buys: an edit to `parseHeader` no longer marks every finding about
 * a 2,000-line file stale. That false-staleness problem is the reason symbols
 * are first-class nodes in the design at all.
 */

/**
 * Declaration patterns per language family.
 *
 * Each must capture the symbol name in group 1. They are deliberately anchored
 * at line start (allowing indentation and modifiers) so that a mention of a
 * function inside a string or comment is not mistaken for its declaration.
 */
const PATTERNS = {
  js: [
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    // Class methods: an identifier followed by a parameter list and a brace,
    // excluding the control keywords that share that shape.
    /^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|async\s+|\*)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/,
  ],
  py: [
    /^\s*def\s+([A-Za-z_]\w*)/,
    /^\s*class\s+([A-Za-z_]\w*)/,
  ],
  go: [
    /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
    /^type\s+([A-Za-z_]\w*)/,
  ],
  rust: [
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z_]\w*)/,
  ],
  clike: [
    /^\s*(?:public|private|protected|internal|static|final|abstract|virtual|override|async|\s)*(?:[\w<>\[\],.?]+\s+)([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/,
    /^\s*(?:public|private|protected|internal|static|abstract|sealed|partial|\s)*(?:class|struct|interface|enum|record)\s+([A-Za-z_]\w*)/,
  ],
  ruby: [
    /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/,
    /^\s*(?:class|module)\s+([A-Za-z_]\w*)/,
  ],
  php: [
    /^\s*(?:public\s+|private\s+|protected\s+|static\s+|abstract\s+|final\s+)*function\s+([A-Za-z_]\w*)/,
    /^\s*(?:abstract\s+|final\s+)*(?:class|interface|trait)\s+([A-Za-z_]\w*)/,
  ],
  shell: [
    /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\s*\)\s*\{/,
  ],
};

const BY_EXTENSION = {
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.ts': 'js', '.tsx': 'js', '.mts': 'js', '.cts': 'js',
  '.py': 'py', '.pyi': 'py',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'clike', '.cs': 'clike', '.c': 'clike', '.h': 'clike',
  '.cpp': 'clike', '.cc': 'clike', '.hpp': 'clike', '.kt': 'clike', '.swift': 'clike',
  '.rb': 'ruby',
  '.php': 'php',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
};

/**
 * Keywords whose call-like shape would otherwise be read as a declaration.
 * Without this, `if (x) {` becomes a symbol named "if" in every C-like file.
 */
const NOT_SYMBOLS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try',
  'function', 'class', 'new', 'delete', 'typeof', 'case', 'default', 'with',
  'constructor', 'super', 'this', 'using', 'lock', 'fixed', 'foreach',
]);

/** Language family for a path, or null when unrecognised. */
export function languageOf(path) {
  const dot = String(path).lastIndexOf('.');
  return dot === -1 ? null : BY_EXTENSION[path.slice(dot).toLowerCase()] || null;
}

/**
 * Extracts symbols with line spans.
 *
 * A symbol's span runs from its declaration to the line before the next
 * declaration at the same or shallower indentation. That is an approximation --
 * it over-extends past a trailing comment or blank line -- but it is stable
 * under reformatting of unrelated code, which is what staleness needs. A span
 * that is slightly too generous causes a slightly-too-eager invalidation; a
 * span that is too tight would MISS a real change, which is the dangerous
 * direction.
 *
 * @returns {Array<{name: string, line: number, endLine: number, indent: number}>}
 */
export function extractSymbols(path, text) {
  const family = languageOf(path);
  if (!family) return [];

  const patterns = PATTERNS[family];
  const lines = String(text).split('\n');
  const found = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('//') || line.trim().startsWith('#')) continue;

    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (!match) continue;
      const name = match[1];
      if (!name || NOT_SYMBOLS.has(name)) continue;

      found.push({ name, line: i + 1, endLine: lines.length, indent: line.length - line.trimStart().length });
      break;
    }
  }

  // Close each span at the next declaration that is not nested inside it.
  for (let i = 0; i < found.length; i++) {
    for (let j = i + 1; j < found.length; j++) {
      if (found[j].indent <= found[i].indent) {
        found[i].endLine = found[j].line - 1;
        break;
      }
    }
  }

  // DISAMBIGUATE REPEATED NAMES.
  //
  // A file can legitimately declare the same name twice -- `read()` on two
  // classes, `handle` in two modules, an overload pair. `path#name` is not
  // unique in that case, so two different spans collapsed onto one node: the
  // second write overwrote the first's hash and snapshot, and staleness was
  // then evaluated against the WRONG span, reporting a function stale because
  // an unrelated namesake changed.
  //
  // Only repeats are suffixed, so the common case keeps a stable, readable key
  // and existing graphs do not churn.
  const counts = new Map();
  for (const symbol of found) counts.set(symbol.name, (counts.get(symbol.name) || 0) + 1);

  const seen = new Map();
  for (const symbol of found) {
    if (counts.get(symbol.name) === 1) continue;
    const index = seen.get(symbol.name) || 0;
    seen.set(symbol.name, index + 1);
    symbol.occurrence = index;
    // Ordinal rather than enclosing scope: it needs no parser, and it is stable
    // as long as declaration ORDER is stable, which survives edits inside a
    // function body -- the overwhelmingly common change.
    symbol.name = `${symbol.name}~${index}`;
  }

  return found;
}

/** The source text of a symbol's span -- what gets snapshotted as its anchor. */
export function spanText(text, symbol) {
  return String(text).split('\n').slice(symbol.line - 1, symbol.endLine).join('\n');
}

/** Stable key for a symbol node, so the same function is one node across runs. */
export function symbolKey(path, name) {
  return `${path}#${name}`;
}
