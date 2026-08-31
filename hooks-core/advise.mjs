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

/** Trim an absolute path to something readable and short. */
function display(path, root) {
  const normalised = String(path).replace(/\\/g, '/');
  if (!root) return normalised;
  const base = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
  return normalised.startsWith(`${base}/`)
    ? normalised.slice(base.length + 1)
    : normalised;
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
export function adviseSearch(graph, pattern, { told = new Set(), root = '', firstOfSession = false } = {}) {
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
