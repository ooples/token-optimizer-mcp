// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/advise.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Answering a search from the graph, before the search runs.
 *
 * THE GAP THIS CLOSES. The graph captured 526 records on a single benchmark
 * task -- 122 symbols, 120 files, 230 edges -- and advised nothing. Every
 * mechanism shipped so far subtracts: the bound truncates, the compactor elides,
 * substitution swaps a file for an outline. All of them fight over the size of
 * what the model reads, and the measurements say size is not what we lose on:
 * turns are (corr(turns, USD) = 0.878), and on the debug family we run 2.305x
 * the control's turns while the leader runs 0.904.
 *
 * A turn is the unit worth attacking, and a search is a whole turn spent
 * finding out something the graph already knows.
 *
 * THE ARITHMETIC IS WHY THIS IS GENEROUS. An advisory of ~30 tokens costs
 * 30 x $3.75/M at cache creation plus 30 x $0.30/M for each later turn that
 * re-reads it -- about $0.0002 over a session. A turn costs ~$0.012. So a
 * wrong advisory costs 1/50th of what a saved search returns, and the policy
 * that maximises expected value is to speak whenever the graph has an answer,
 * not to speak only when certain. The failure mode to guard against here is
 * silence, not noise -- the opposite of the injections measured so far, which
 * were status text nobody asked for and which bought nothing at any price.
 *
 * WHAT IT CAN HONESTLY ANSWER. `indexFile` writes symbol nodes carrying name,
 * file, line and endLine, `contains` edges from file to symbol, and `calls`
 * edges between symbols. The `calls` extraction is INTRA-FILE by construction
 * (`linkCalls` keeps only callees the same file declares), so "what calls this"
 * is true within a file and silent across files. Saying so in the notice
 * matters: an advisory that overstated its reach would send the model away from
 * a grep that was actually necessary, and that costs the turn it was meant to
 * save.
 */

/**
 * Identifiers worth looking up, pulled out of a search pattern.
 *
 * THE PATTERN IS NEVER EXECUTED. It arrives from the model as an arbitrary
 * regex, and compiling it here would hand a stranger's expression to our own
 * engine on the hook's critical path -- the catastrophic-backtracking class this
 * repo already has a linearity gate for. Scanning it for identifier-shaped runs
 * with one linear expression answers the only question we have of it.
 */
import { statSync } from 'node:fs';

export function identifiersIn(pattern) {
  if (typeof pattern !== 'string' || !pattern) return [];
  const found = [];
  const seen = new Set();
  // ESCAPES FIRST, or the letter in one becomes the head of an identifier.
  // `\bdef parse_line\b` yielded `bdef`: the lookbehind below sees a backslash,
  // which is not a word character, so it happily starts there. Measured, not
  // theorised -- and a junk name is not merely wasted, it can collide with a
  // real symbol and produce an advisory about something nobody asked for.
  const plain = pattern.replace(/\\./g, ' ');
  // Linear: a lookbehind refusing to start mid-identifier, the same shape
  // linkCalls uses and for the same reason.
  for (const match of plain.matchAll(/(?<![\w$])([A-Za-z_$][\w$]{2,})/g)) {
    const name = match[1];
    if (seen.has(name) || STOPWORDS.has(name.toLowerCase())) continue;
    seen.add(name);
    found.push(name);
    if (found.length >= 8) break;
  }
  return found;
}

/**
 * Words that look like identifiers and never name one worth reporting.
 *
 * Regex syntax contributes the first group -- a model writing `\bfoo\b` or
 * `(?:a|b)` puts these in the pattern without meaning them. The rest are
 * language keywords common enough that matching them would return most of the
 * index and say nothing.
 */
const STOPWORDS = new Set([
  'def', 'let', 'var', 'const', 'function', 'class', 'return', 'import',
  'from', 'export', 'async', 'await', 'self', 'this', 'null', 'none',
  'true', 'false', 'and', 'not', 'for', 'while', 'with', 'try', 'catch',
  'except', 'raise', 'throw', 'new', 'int', 'str', 'bool', 'float',
]);

/**
 * Search programs whose first operand is a pattern.
 *
 * WHY THIS LIST EXISTS AT ALL. The advisory above answers a search from the
 * index before it runs, and it was wired only to the `Grep` and `Glob` TOOLS.
 * Measured on the warm benchmark, that is the wrong half of the surface: in the
 * needle-in-repo runs the agent searched entirely through Bash --
 *
 *   Bash  grep -rn "compute_settlement_fee" /work --include=* 2>/dev/null | head -50
 *   Bash  cat /work/pkg/mod_047.py
 *   Edit  /work/pkg/mod_047.py
 *
 * -- zero Grep calls, zero Glob calls, and so zero advisories delivered, while
 * the graph for that very session held
 * `compute_settlement_fee -> pkg/mod_047.py:9-12` and returned it correctly to a
 * direct call. Two turns were spent rediscovering a fact already indexed.
 */
const SEARCH_PROGRAMS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);

/**
 * Flags that consume the NEXT token, so its value is never the pattern.
 *
 * `grep -n "needle" -A 30 -B 10 file` is real observed input: without this, the
 * walk would stop at `30`. The `--flag=value` spelling needs no entry here --
 * it is one token, and the `=` test below skips it.
 *
 * THE COLOUR FLAGS ARE NOT HERE, because their arity is the one thing in this
 * list that differs by program. See COLOR_TAKES_SEPARATE_VALUE.
 */
const VALUED_FLAGS = new Set([
  '-e', '--regexp', '-f', '--file', '-m', '--max-count',
  '-A', '--after-context', '-B', '--before-context', '-C', '--context',
  '-d', '--directories', '-t', '--type', '-g', '--glob',
  '--include', '--exclude', '--exclude-dir',
]);

/** The spellings of the colour option, across the programs handled here. */
const COLOR_FLAGS = new Set(['--color', '--colour']);

/**
 * Programs whose colour flag takes a SEPARATE value token.
 *
 * The one option in this parser whose arity cannot be decided globally, and
 * getting it wrong silently returns a path or a keyword as the search pattern:
 *
 *   grep --color needle file   GNU: the value is optional and inline-only, so
 *                              `needle` is the pattern. Treating --color as
 *                              valued consumed `needle` and returned `file`.
 *   rg --color never needle .  ripgrep REQUIRES a separate WHEN, so `never` is
 *                              the flag's value and `needle` is the pattern.
 *                              Treating --color as valueless returns `never`.
 *   ag --color needle .        a valueless toggle, like ack. Same failure as
 *   ack --color needle .       grep: returned `.` instead of `needle`.
 *
 * So neither "always valued" nor "never valued" is correct, and the contract has
 * to come from the program. Only ripgrep is in this set.
 */
const COLOR_TAKES_SEPARATE_VALUE = new Set(['rg']);

/**
 * Splits a command into segments of tokens, honouring quotes and escapes.
 *
 * SEGMENTING AND TOKENIZING ARE ONE PASS, and they have to be. Splitting the raw
 * string on `|`, `&&` and `;` before tokenizing cut straight through quoted
 * text, so a perfectly ordinary alternation lost everything after the first
 * branch:
 *
 *   grep -E "foo|bar" .   returned `foo`   -- `bar` never reached adviseSearch
 *   rg "a;b" .            returned `a`
 *   grep "x&&y" .         returned `x`
 *
 * A quote-aware scan cannot make that mistake, because an operator inside a
 * quoted run is just a character. Pipelines still split, which is what lets
 * `cat x | grep foo` be recognised at all -- the search is never the first
 * segment there.
 *
 * A CHARACTER LOOP RATHER THAN A REGEX, deliberately. This runs on the hook's
 * critical path against a string the model composed, which is the exact input
 * class this repo keeps a linearity gate for; a single forward pass cannot
 * backtrack at all.
 */
export function commandSegments(command) {
  const segments = [];
  let tokens = [];
  let current = '';
  let quote = null;
  let started = false;

  const endToken = () => {
    if (current || started) tokens.push(current);
    current = '';
    started = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      current += command[i + 1];
      i += 1;
      started = true;
      continue;
    }
    // UNQUOTED ONLY -- reaching here means the quote branches above did not.
    if (ch === '|' || ch === ';' || ch === '&' || ch === '\n') {
      endSegment();
      // `||` and `&&` are one operator, not two empty segments.
      while (i + 1 < command.length && command[i + 1] === ch) i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      endToken();
      continue;
    }
    current += ch;
    started = true;
  }
  endSegment();
  return segments;
}

/**
 * The pattern a shell search command is about to look for, or null.
 *
 * Splits on pipeline and sequencing operators first, because `cat x | grep foo`
 * and `a && grep foo` both carry a search the graph may be able to answer, and
 * the search is never the first segment there. `git grep foo` is handled by
 * skipping a leading `git`, and `find . -name "*.py"` by reading the -name
 * value: a glob yields no identifiers and so costs nothing, but
 * `find . -name "compute_settlement*"` does.
 *
 * Returns the raw pattern rather than identifiers, so the caller hands it to the
 * same `adviseSearch` the Grep tool path uses and the two surfaces cannot drift.
 */
export function searchPatternFromCommand(command) {
  if (typeof command !== 'string' || !command) return null;
  // Bounded before any work: a pathological command is not worth parsing, and
  // the advisory is an optimisation that must never become the slow path.
  if (command.length > 4_000) return null;

  for (const tokens of commandSegments(command)) {
    if (!tokens.length) continue;
    // `env FOO=bar grep ...` and `sudo grep ...` are not worth chasing, but a
    // leading `git` is: `git grep` is ordinary.
    let at = 0;
    if (tokens[at] === 'git') at += 1;
    const program = String(tokens[at] || '').split(/[/\\]/).pop();

    if (program === 'find') {
      for (let i = at + 1; i < tokens.length - 1; i += 1) {
        if (tokens[i] === '-name' || tokens[i] === '-iname') return tokens[i + 1];
      }
      continue;
    }
    if (!SEARCH_PROGRAMS.has(program)) continue;

    // Whether a flag eats the next token, decided per program: only the colour
    // option varies, and only ripgrep requires a separate value for it.
    const consumesNext = (token) =>
      VALUED_FLAGS.has(token) ||
      (COLOR_FLAGS.has(token) && COLOR_TAKES_SEPARATE_VALUE.has(program));

    for (let i = at + 1; i < tokens.length; i += 1) {
      const token = tokens[i];
      // An explicit -e/--regexp names the pattern outright and wins over
      // position, which is the whole reason the flag exists.
      if (consumesNext(token)) {
        if (token === '-e' || token === '--regexp') return tokens[i + 1] || null;
        i += 1;
        continue;
      }
      if (token.startsWith('--') && token.includes('=')) {
        const [name, ...rest] = token.split('=');
        if (name === '--regexp') return rest.join('=') || null;
        continue;
      }
      if (token.startsWith('-') && token.length > 1) continue;
      // The first bare operand is the pattern; everything after it is a path.
      return token || null;
    }
  }
  return null;
}

/** Symbol nodes grouped by name, for one lookup per identifier. */
export function symbolIndex(graph) {
  const byName = new Map();
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'symbol' || typeof node.name !== 'string') continue;
    const bucket = byName.get(node.name);
    if (bucket) bucket.push(node);
    else byName.set(node.name, [node]);
  }
  return byName;
}

/**
 * Callers of a symbol, within its own file.
 *
 * Reverse traversal of `calls`. Bounded hard: naming two callers is a hint,
 * naming eleven is the search result the model was going to get anyway, at
 * which point the advisory has become the cost it was avoiding.
 */
function callersOf(graph, symbolId, limit = 2) {
  const names = [];
  for (const edge of graph.edges) {
    if (edge.edge !== 'calls' || edge.to !== symbolId) continue;
    const caller = graph.nodes.get(edge.from);
    if (!caller || typeof caller.name !== 'string') continue;
    if (!names.includes(caller.name)) names.push(caller.name);
    if (names.length >= limit) break;
  }
  return names;
}

const slashed = (path) =>
  String(path == null ? '' : path).replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Is this file inside the tree the session is working in?
 *
 * THE SCOPE IS THE WHOLE SAFETY ARGUMENT. A graph is not guaranteed to contain
 * only this project: an unrooted directory shares one machine-level store with
 * every other unrooted session on the host, and even a rooted graph acquires
 * foreign file nodes through resolved imports. Without this test the advisory
 * would confidently report a symbol from an unrelated checkout, with a path
 * that means nothing where it is read -- and it would look exactly like a
 * correct answer, which is the worst property a hint can have.
 *
 * Comparison is on the slashed form because a graph written on Windows holds
 * backslashes while the session's cwd may arrive either way.
 */
/**
 * Case folding that follows the filesystem rather than the whole world.
 *
 * WHY NOT ALWAYS toLowerCase. Windows resolves `C:/Repo` and `c:/repo` to one
 * directory, so folding there is required or a case difference between the
 * payload's cwd and a stored path silences every answer. On Linux and macOS
 * with a case-sensitive volume they are DIFFERENT directories, and folding
 * makes `/work/Repo/secret.ts` test as inside `/work/repo` -- which is the
 * scope check that exists to stop one project's symbols being reported into
 * another's session. A wrong answer that names a real file from somebody
 * else's tree is the worst output this feature can produce, because it is
 * indistinguishable from a correct one.
 */
// ASKED OF THE FILESYSTEM, NOT GUESSED FROM THE PLATFORM. Keying this on
// `platform === 'win32'` was wrong in both directions: macOS defaults to a
// case-INSENSITIVE volume, so a case difference between the payload cwd and a
// stored path suppressed every answer there, while a case-SENSITIVE volume on
// any platform would have had its scope silently widened had we folded by
// default. Both are one-line guesses about somebody else’s disk.
//
// So ask, once per directory, and remember: stat it, stat its case-flipped
// name, compare identity. Same inode and device means the filesystem folded
// the name for us. Falls back to NOT folding, which errs toward suppressing
// an answer rather than widening scope -- the safe direction, since a symbol
// from another tree is the worst output this feature can produce.
/**
 * The pair of paths whose identity answers "does this filesystem fold case".
 *
 * ONLY THE LAST COMPONENT DIFFERS, and that is the whole point. Flipping the
 * entire path probes every ancestor at once, so a case-INSENSITIVE project
 * under an ancestor with no case-flipped twin fails the stat there, the caller
 * falls back to "case-sensitive", and valid in-scope advisories are
 * suppressed. The question is only ever about the directory holding the entry.
 *
 * Exported so the property is testable without a filesystem that actually
 * folds: on NTFS the whole-path probe succeeds anyway, so an end-to-end test
 * cannot tell the two implementations apart.
 */
export function caseProbePath(dir) {
  const normalised = slashed(dir).replace(/\/+$/, '');
  const cut = normalised.lastIndexOf('/');
  const parent = cut > 0 ? normalised.slice(0, cut) : normalised.slice(0, cut + 1);
  const base = normalised.slice(cut + 1);
  const flippedBase = base === base.toLowerCase() ? base.toUpperCase() : base.toLowerCase();
  if (!base || flippedBase === base) return null;
  return { actual: normalised, flipped: (parent ? parent + '/' : '') + flippedBase };
}
const foldCache = new Map();
function foldsCase(dir) {
  if (foldCache.has(dir)) return foldCache.get(dir);
  let result = false;
  try {
    // ONLY THE LAST COMPONENT IS FLIPPED. Flipping the whole path tests every
    // ancestor at once, so a case-INSENSITIVE project mounted under a
    // case-SENSITIVE ancestor -- /home/User/proj on Linux, any nested mount --
    // fails the stat at the ancestor, the probe falls back to "sensitive", and
    // valid in-scope advisories are suppressed. The question is only ever about
    // the directory holding this entry, so ask it about that one.
    const probe = caseProbePath(dir);
    if (probe) {
      const a = statSync(probe.actual);
      const b = statSync(probe.flipped);
      result = a.ino === b.ino && a.dev === b.dev;
    }
  } catch {
    result = false;
  }
  foldCache.set(dir, result);
  return result;
}
const foldWith = (insensitive) => (v) => (insensitive ? v.toLowerCase() : v);

function withinScope(file, scope) {
  if (!scope) return true;
  const f = foldWith(foldsCase(scope));
  const path = f(slashed(file));
  const base = f(slashed(scope));
  return path === base || path.startsWith(`${base}/`);
}

/**
 * Trim an absolute path to something readable and short, and safe to hand to a
 * model.
 *
 * CONTROL CHARACTERS ARE NEUTRALISED HERE. This string is interpolated into
 * `additionalContext`, which is agent context: a path containing a newline --
 * legal on Linux and macOS -- would end the advisory line and let the rest of
 * the filename appear as its own instruction to the model. The graph's paths
 * come from the filesystem, so they are attacker-influenced wherever the agent
 * works on a checkout it did not write.
 *
 * Replaced rather than rejected, so a legitimately odd filename still gets an
 * answer instead of silence.
 */
function display(path, root) {
  const normalised = slashed(path);
  const base = slashed(root);
  const trimmed =
    base && (() => { const g = foldWith(foldsCase(root)); return g(normalised).startsWith(`${g(base)}/`); })()
      ? normalised.slice(base.length + 1)
      : normalised;
  // C0 AND DEL WERE NOT THE WHOLE SET. U+2028 LINE SEPARATOR and U+2029
  // PARAGRAPH SEPARATOR end a line as far as the model reading this text is
  // concerned, so they carry exactly the injection a bare newline does while
  // passing a C0-only filter. C1 (U+0080-U+009F) is invisible, legal in a
  // filename, and no path legitimately needs one.
  // eslint-disable-next-line no-control-regex
  return trimmed.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '\uFFFD');
}

/** How many facts one session may be told. */
export const SESSION_CAP = 15;

/** How many locations a single advisory may carry. */
const MAX_HITS = 6;

/**
 * What the graph can tell a model that is about to search.
 *
 * Returns null whenever there is nothing to add -- no identifiers in the
 * pattern, no symbol by that name, or every hit already stated this session.
 * Repeating a fact is the one cheap-injection failure that is not cheap: it is
 * the mechanism by which an always-on block becomes wallpaper, and a model that
 * has learned to skip our text will skip the advisory that mattered.
 *
 * @param graph  a loaded wiki graph
 * @param pattern the search pattern, never executed
 * @param told   fact keys already delivered this session
 */
export function adviseSearch(
  graph,
  pattern,
  { told = new Set(), root = '', scope = root, firstOfSession = false } = {}
) {
  const identifiers = identifiersIn(pattern);
  if (!identifiers.length) return null;

  const byName = symbolIndex(graph);
  if (!byName.size) return null;

  const lines = [];
  const facts = [];

  for (const identifier of identifiers) {
    // EXACT NAMES ONLY. A substring sweep over the index is where a surface
    // like this stops being an answer and becomes a second set of search
    // results -- longer than the advisory budget, wrong more often than it is
    // right, and indistinguishable to the model from something we verified.
    // An identifier the graph does not hold is a case for staying quiet.
    for (const node of byName.get(identifier) || []) {
      if (typeof node.file !== 'string' || !node.line) continue;
      // A symbol from another tree is not an answer to this session's search.
      if (!withinScope(node.file, scope)) continue;
      const where = `${display(node.file, root)}:${node.line}${
        node.endLine && node.endLine !== node.line ? `-${node.endLine}` : ''
      }`;
      const key = `${identifier}@${where}`;
      if (told.has(key)) continue;

      const callers = callersOf(graph, node.id);
      lines.push(
        `  ${identifier} -> ${where}${
          callers.length ? ` (called in-file by ${callers.join(', ')})` : ''
        }`
      );
      facts.push(key);
      if (lines.length >= MAX_HITS) break;
    }
    if (lines.length >= MAX_HITS) break;
  }

  if (!lines.length) return null;

  // THE EXPLANATION IS PAID FOR ONCE. It is the longest part of the message and
  // it says the same thing every time, so repeating it on every advisory would
  // multiply the only real cost here by the number of searches in a session.
  // The locations alone are self-describing after the first.
  const trailer = firstOfSession
    ? '\nFrom this project\'s local symbol index, not a search. Read with offset/limit ' +
      'to go straight there. Call sites are tracked within a file only, so grep ' +
      'anyway if you need callers in other files.'
    : '';

  return { text: `token-optimizer index:\n${lines.join('\n')}${trailer}`, facts };
}
