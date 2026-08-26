/**
 * P2: staleness, snapshots, and the invalidating diff.
 *
 * THE LOAD-BEARING RULE, from docs/WIKI_GRAPH.md: a stale finding is SERVED,
 * MARKED, and ACCOMPANIED BY THE DIFF that invalidated it. Not deleted, not
 * withheld.
 *
 * Deleting throws away the reason the graph survives a refactor at all --
 * re-verifying a conclusion against a known diff is far cheaper than
 * re-deriving it from nothing. Withholding declines to spend 200 tokens to save
 * 20,000. But serving a stale finding BARE would be worse than having no graph,
 * so the diff is mandatory rather than decorative, and `serve()` below cannot
 * return a stale finding without one.
 *
 * TWO INVALIDATION PATHS, and each covers what the other cannot see:
 *
 *   EAGER  -- our PostToolUse hook saw a write, so the finding is marked at the
 *             moment it went stale, with the exact before/after in hand. The
 *             hook does not call `invalidateOnWrite` directly: it queues the
 *             evidence through pending.mjs, and the next graph read -- which
 *             loads the graph anyway -- applies it before serving anything.
 *             That path is also the only one that catches a write the SESSION
 *             made, because the lazy check below compares the stored hash
 *             against disk and `indexFile` has already refreshed it.
 *   LAZY   -- at retrieval, the anchor's stored hash is compared against disk.
 *             This is what catches `git pull`, another editor, a teammate, or a
 *             build step: every change our hooks never observed.
 *
 * Eager alone would silently serve stale findings as fresh whenever a change
 * came from outside the agent, which is the single failure mode the design
 * calls worse than no graph.
 *
 * AND LAZY ALONE IS BLIND TO THE AGENT'S OWN WRITES -- not degraded, BLIND.
 * `indexFile` re-points an anchor's stored hash at the bytes it was just handed,
 * and it is called on every file either hook observes: pretooluse-router.mjs
 * (two call sites) and adapter.mjs (one). The lazy check then compares that
 * refreshed hash against the same disk it came from and finds them equal. So
 * for a file the session edited ITSELF, the lazy path cannot detect the change
 * at all, and the finding derived from the pre-edit content is served CLEAN.
 *
 * Which means that until the eager path was connected, staleness for a file the
 * agent edited did not work AT ALL: eager was dead code and lazy was defeated
 * by re-indexing. Every account of this defect, including the one in this
 * module's own git history, called it "lazy-only, therefore degraded". It was
 * not degraded. `stale-before-reindex.test.mjs` states in its header that this
 * case is covered by `invalidateOnWrite`, and `invalidateOnWrite` had never run
 * once in production. The two paths are not redundant and never were: each is
 * the ONLY cover for a whole class of change.
 */

import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { putNode, putEdge, contentHash, nodeId, load } from './wiki.mjs';
import { hasOutstandingContradiction } from './curate.mjs';
import { extractSymbols, spanText, symbolKey, extractImports } from './symbols.mjs';
import { canonicalPath, resolvableCandidates, isFsSafePath } from './paths.mjs';
import { safeRecord } from './safe-text.mjs';

/** Reads a path in whichever spelling resolves, or throws if none do. */
function readAnySpelling(path) {
  // Unreadable is already this function's failure mode; an unsafe path takes
  // the same route instead of killing the process.
  if (!isFsSafePath(path)) throw new Error('unreadable');
  let last;
  for (const candidate of resolvableCandidates(path)) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch (error) {
      last = error;
    }
  }
  throw last ?? new Error('unreadable');
}

const hash = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 16);

/**
 * Largest file whose full text is stored as an anchor snapshot.
 *
 * Symbol spans are stored unconditionally because a function is small. Whole
 * files are not: 256 KB keeps the common case (source files) covered while
 * refusing to mirror bundles, lockfiles and minified assets into the graph.
 */
function snapshotLimit() {
  const raw = Number(process.env.TOKEN_OPTIMIZER_SNAPSHOT_LIMIT);
  // `|| default` alone accepted Infinity and NaN-adjacent values: Infinity
  // would snapshot a 2 GB bundle into the graph, and a negative value would
  // disable snapshots entirely while looking configured.
  return Number.isFinite(raw) && raw > 0 ? raw : 262_144;
}

/**
 * Largest symbol span stored in full.
 *
 * Spans used to be stored unconditionally, on the reasoning that "a function is
 * small". That holds for hand-written code and fails badly on generated and
 * machine-assembled sources, where a single class body is megabytes. Measured
 * on a real project: 132 symbol nodes holding 34.3 MB between them -- 95.8% of
 * the entire graph -- with one span of 1.8 MB. The graph had become a second,
 * worse copy of the repository.
 *
 * Same trade as the file cap above: past the limit the hash still drives
 * staleness detection, so invalidation keeps working; only the reconstructed
 * diff degrades, and `serve` already says so plainly when it cannot show
 * evidence. A span this large is not worth its own weight in the graph -- the
 * diff of a 1.8 MB function is not something anyone reads either.
 */
function symbolSnapshotLimit() {
  const raw = Number(process.env.TOKEN_OPTIMIZER_SYMBOL_SNAPSHOT_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? raw : 32_768;
}

/**
 * Records a file and the symbols inside it as nodes, each carrying a snapshot
 * of its own text.
 *
 * Snapshotting the SPAN rather than the whole file is what keeps storage
 * bounded: only regions that findings actually anchor to are stored, and a
 * function is orders of magnitude smaller than the file containing it.
 */
export function indexFile(dir, rawPath, text) {
  // This reads rawPath through its own loop rather than readAnySpelling, so it
  // needs the same guard: an unsafe path aborts libuv instead of throwing, and
  // the per-candidate try/catch below cannot catch that.
  if (!isFsSafePath(rawPath)) return null;
  // The graph KEY is canonical, so one file is one node however it was spelled.
  // Reading still tries the spellings that actually resolve on this host.
  const path = canonicalPath(rawPath);
  const source = text ?? (() => {
    for (const candidate of resolvableCandidates(rawPath)) {
      try {
        return readFileSync(candidate, 'utf8');
      } catch { /* try the next spelling */ }
    }
    return null;
  })();
  if (source === null) return null;

  // THE SNAPSHOT IS NOT OPTIONAL ON A FILE NODE. Without it `checkAnchor`
  // cannot produce a `before` side, so a stale file-level finding is served
  // with an empty diff, and `refusalPayload` returns null for every real file
  // -- meaning the zero-turn refusal, the headline of P4, never fired outside
  // tests that hand-wrote the snapshot themselves.
  //
  // Bounded, because a snapshot of every large file read would turn the graph
  // into a second copy of the repository. Past the cap the hash still drives
  // staleness detection; only the diff degrades, and `serve` already states
  // plainly when evidence cannot be reconstructed.
  const snapshot = source.length <= snapshotLimit() ? source : undefined;
  // BYTES BESIDE THE HASH, because the hash is truncated to 64 bits and content
  // identity is now read from it. `contentPeers` groups files by identical
  // content, and two unrelated files sharing a 16-hex-character digest would
  // silently share each other's findings. The deleted `contentAnchor` carried a
  // size for exactly this reason and said so; the size is free here, since the
  // source is already in hand.
  //
  // NOT THE SNAPSHOT, which would have been the obvious discriminator and is
  // unavailable: `putNode` writes snapshots to a separate file that `load()`
  // deliberately skips, so a loaded node never carries one.
  const fileNode = putNode(dir, {
    kind: 'file',
    key: path,
    hash: hash(source),
    bytes: Buffer.byteLength(source),
    snapshot,
  });

  const symbols = extractSymbols(path, source);
  for (const symbol of symbols) {
    const body = spanText(source, symbol);
    const symbolNode = putNode(dir, {
      kind: 'symbol',
      key: symbolKey(path, symbol.name),
      name: symbol.name,
      file: path,
      line: symbol.line,
      endLine: symbol.endLine,
      hash: hash(body),
      // Bounded for the same reason the file snapshot above is, and measured:
      // unbounded spans were 95.8% of a real project's graph.
      snapshot: body.length <= symbolSnapshotLimit() ? body : undefined,
    });
    putEdge(dir, fileNode, 'contains', symbolNode);
  }

  linkImports(dir, path, source, fileNode);
  linkCalls(dir, path, source, symbols);
  return fileNode;
}

/**
 * `imports` edges, file to file.
 *
 * Without these the graph is a set of disconnected stars -- a file and the
 * symbols it contains -- and traversal cannot cross a file boundary, so a
 * finding one hop from the current work is unreachable. That is the difference
 * between the design's "traversal, causally correct" and no retrieval at all.
 *
 * The target node is created if the file exists on disk. An import that cannot
 * be resolved to a real path yields no edge: a dangling edge would make
 * `audit()` count a file as connected while nothing can ever be traversed to.
 */
function linkImports(dir, path, source, fileNode) {
  const base = dirname(path);

  for (const specifier of extractImports(path, source)) {
    const target = resolveImport(base, specifier);
    if (!target) continue;
    // Only the node, not a full index: indexing the target here would recurse
    // through the whole import graph on every tool call.
    putEdge(dir, fileNode, 'imports', putNode(dir, { kind: 'file', key: target }));
  }
}

/** Extensions and index forms tried when a specifier omits them. */
const IMPORT_SUFFIXES = [
  '', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs',
  '/index.ts', '/index.js', '/index.mjs', '/__init__.py',
];

/**
 * First existing file a relative specifier names, or null.
 *
 * Deliberately a filesystem probe rather than a resolver: the point is to draw
 * an edge only where a real file node can exist, and existsSync answers exactly
 * that question without taking on a module-resolution dependency.
 */
function resolveImport(base, specifier) {
  // Import specifiers come from file contents, so they are external input
  // reaching statSync below.
  if (!isFsSafePath(base) || !isFsSafePath(specifier)) return null;
  // TypeScript sources routinely import `./x.js` and mean `./x.ts`; trying the
  // stripped stem covers it without special-casing the whole ESM/TS story.
  const stems = [specifier, specifier.replace(/\.(js|mjs|cjs)$/, '')];

  for (const stem of stems) {
    for (const suffix of IMPORT_SUFFIXES) {
      const candidate = canonicalPath(join(base, stem + suffix));
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Does not exist, or is not reachable. Try the next shape.
      }
    }
  }
  return null;
}

/**
 * `calls` edges between symbols in the SAME file.
 *
 * Cross-file call resolution needs a real type resolver; a regex guess would
 * attach `handle` in one file to `handle` in an unrelated one and produce a
 * confidently wrong edge. This module's whole doctrine is that degradation is
 * acceptable and incorrectness is not, so the scope is limited to calls whose
 * target is declared in the file being indexed, where the match is unambiguous.
 */
function linkCalls(dir, path, source, symbols) {
  if (symbols.length < 2) return;

  const byName = new Map(symbols.map((s) => [s.name, s]));

  for (const caller of symbols) {
    // spanText, not a hand-rolled slice: it is the same span the snapshot and
    // the hash use, and it handles a one-line declaration, where a naive
    // slice(line, endLine) is empty and silently finds no calls at all.
    const body = spanText(source, caller);
    const seen = new Set();

    for (const match of body.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = match[1];
      // Not itself, not a keyword, and only names this file declares.
      if (name === caller.name || seen.has(name) || !byName.has(name)) continue;
      seen.add(name);
      putEdge(
        dir,
        nodeId('symbol', symbolKey(path, caller.name)),
        'calls',
        nodeId('symbol', symbolKey(path, name))
      );
    }
  }
}

/**
 * Is this anchor still what it was? Compares the stored hash against disk.
 *
 * Returns { fresh } when unchanged, or { fresh: false, before, after } with the
 * text needed to build the diff. A node whose file has been DELETED is reported
 * stale with an empty `after` rather than treated as unchanged -- a finding
 * about a file that no longer exists is exactly the kind that must not be
 * served as fresh.
 */
export function checkAnchor(anchor) {
  const path = anchor.kind === 'symbol' ? anchor.file : anchor.key;

  let source;
  try {
    source = readAnySpelling(path);
  } catch {
    // REASON-NEUTRAL, for the reason spelled out beside the fallback text below:
    // report what was determined, not a cause that was not. "no longer readable"
    // asserts a change of state, and the commonest way to reach this branch
    // involves none -- a branch, worktree, uninitialised submodule or fresh clone
    // where the file simply is not present. Observed here: a finding anchored to
    // a file added on another branch reported it gone.
    return { fresh: false, before: anchor.snapshot || '', hasBefore: Boolean(anchor.snapshot), after: '', reason: 'anchor not readable from this checkout' };
  }

  if (anchor.kind === 'file') {
    return hash(source) === anchor.hash
      ? { fresh: true }
      : {
          fresh: false,
          before: anchor.snapshot || '',
          hasBefore: Boolean(anchor.snapshot),
          after: source,
          // AND WHAT CHANGED IT, when the graph knows. The structural harvest
          // stamps `lastAction` -- the tool name that last touched this file --
          // on every file node, and nothing read it: the field was written on
          // every observed tool call since #203 and consumed nowhere.
          //
          // It belongs precisely here. "file changed" tells a reader that their
          // finding may be wrong; "file changed (last touched by Edit)" tells
          // them a targeted edit did it, which is cheap to re-verify, and "last
          // touched by Write" says the file was replaced wholesale, which is
          // usually not. Same disclosure, one word of provenance, no extra I/O.
          reason: anchor.lastAction
            ? `file changed (last touched by ${String(anchor.lastAction).slice(0, 40)})`
            : 'file changed',
        };
  }

  // For a symbol, re-locate it by NAME rather than by line number. Line numbers
  // shift whenever anything above is edited, which would report every function
  // in a file as stale after an unrelated insert at the top.
  const current = extractSymbols(path, source).find((s) => s.name === anchor.name);
  if (!current) {
    return { fresh: false, before: anchor.snapshot || '', hasBefore: Boolean(anchor.snapshot), after: '', reason: 'symbol no longer found' };
  }

  const body = spanText(source, current);
  return hash(body) === anchor.hash
    ? { fresh: true }
    : { fresh: false, before: anchor.snapshot || '', hasBefore: Boolean(anchor.snapshot), after: body, reason: 'symbol body changed' };
}

/**
 * Characters kept from any single diff line.
 *
 * A LINE CAP IS NOT A SIZE CAP, and the gap was measured: with only `maxLines`
 * in force, `diffLines('X'.repeat(200000), 'Y'.repeat(200000))` returned 2 lines
 * and 400,005 bytes. Minified bundles, generated sources and single-line JSON
 * all have that shape, and this output goes STRAIGHT INTO MODEL CONTEXT from
 * inject.mjs's zero-turn refusal -- so a line bound alone let one pathological
 * file spend hundreds of thousands of tokens.
 *
 * 200 characters is chosen because it is past the width at which a line is read
 * as a line by anybody, human or model: a hand-written source line is under
 * ~120 columns, so the cap cannot truncate a diff a reader was going to use,
 * while the cases it does truncate are ones where the interesting change is not
 * legible from the raw text anyway.
 */
const DIFF_MAX_LINE_CHARS = () => {
  const raw = Number(process.env.TOKEN_OPTIMIZER_DIFF_MAX_LINE_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : 200;
};

/**
 * Total UTF-8 bytes of diff body.
 *
 * 4,000 bytes is roughly 1,000 tokens. It is deliberately larger than the
 * per-file injection budget (`TOKEN_OPTIMIZER_TOUCH_BUDGET`, 500 tokens) and
 * far smaller than a file, because the two consumers want different things: the
 * injection surface fits the diff inside its own budget and drops it if it does
 * not fit, while the zero-turn refusal is replacing a whole file read and can
 * afford more. One cap that neither consumer has to think about is worth more
 * than two tuned ones.
 *
 * WHAT IT COSTS, PLAINLY: a legitimately large diff now arrives truncated, so a
 * model looking at a 300-line refactor sees the head of it and a count of what
 * was elided rather than the whole change. That is the correct direction to
 * fail -- the alternative was a bounded-looking function that could emit 400 KB.
 */
const DIFF_MAX_BYTES = () => {
  const raw = Number(process.env.TOKEN_OPTIMIZER_DIFF_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 4_000;
};

/**
 * A compact line diff.
 *
 * Deliberately not a full unified diff with hunks and context: the consumer is
 * a model deciding whether an existing conclusion still holds, and for that the
 * changed lines are the signal. Output is capped because an unbounded diff
 * injected alongside a finding would spend more tokens than re-deriving it.
 *
 * BOUNDED IN THREE WAYS, and each one is load-bearing: lines, characters per
 * line, and total bytes. Every truncation is announced in the output, because a
 * silently shortened diff is worse than a visibly shortened one -- a reader who
 * cannot tell content was elided believes they saw the whole change.
 *
 * `maxLines` BOUNDS THE BODY, MARKERS INCLUDED: at most `maxLines` lines of
 * removed lines, added lines and "... N more" elision markers between them, plus
 * at most one final notice when the byte cap dropped lines -- so `maxLines + 1`
 * lines in total, and no more. That last line is outside the budget on purpose,
 * for the reason stated where it is pushed.
 */
export function diffLines(
  before,
  after,
  {
    maxLines = 40,
    maxLineChars = DIFF_MAX_LINE_CHARS(),
    maxBytes = DIFF_MAX_BYTES(),
  } = {}
) {
  const a = String(before).split('\n');
  const b = String(after).split('\n');

  // Trim the common head and tail so the diff shows only the region that moved.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;

  let tail = 0;
  while (tail < a.length - head && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);

  const out = [];
  let bytes = 0;
  let dropped = 0;

  // Per line first, so ONE enormous line cannot consume the whole budget and
  // leave every other changed line unrepresented.
  const clamp = (line) => {
    const text = String(line);
    if (text.length <= maxLineChars) return text;
    return `${text.slice(0, maxLineChars)} [+${text.length - maxLineChars} chars cut]`;
  };

  // Bytes, not characters: the cap exists to bound what is sent, and a
  // multi-byte source file would otherwise pass a character check while
  // emitting several times the budget.
  const push = (line) => {
    const text = clamp(line);
    const size = Buffer.byteLength(text, 'utf8') + 1;
    if (bytes + size > maxBytes) {
      dropped++;
      return;
    }
    out.push(text);
    bytes += size;
  };

  // THE ELISION MARKER IS PAID FOR OUT OF THE SIDE'S OWN QUOTA, so `maxLines`
  // bounds the whole body rather than only the content in it. It did not: at the
  // default 40 the body could reach 42 lines -- 20 removed, 20 added and two
  // "... N more" markers -- and the out-of-budget notice below made 43, against
  // a documented bound of 40 and a test asserting 41. Three numbers, no two the
  // same. A side that has to elide now shows one fewer content line and spends
  // that line on saying so, which is the trade a reader wants anyway: knowing
  // that 300 lines were cut matters more than the 20th of the 20 shown.
  const half = Math.floor(maxLines / 2);
  const emit = (lines, prefix, label) => {
    const elides = lines.length > half;
    const shown = elides ? Math.max(0, half - 1) : half;
    for (const line of lines.slice(0, shown)) push(prefix + line);
    if (elides) push(`  ... ${lines.length - shown} more ${label}`);
  };

  emit(removed, '- ', 'removed');
  emit(added, '+ ', 'added');

  // Announced OUTSIDE the budget, deliberately: the one line a reader most
  // needs is the one saying the rest is missing, and dropping it to stay under
  // a self-imposed cap would hand back a diff that lies about being complete.
  if (dropped) out.push(`  ... ${dropped} more changed line(s) cut at the size limit`);

  return out.join('\n');
}

/**
 * Types whose truth is a claim ABOUT the anchor's contents.
 *
 * Only these can be invalidated by that file changing. An anchor on any other
 * type is a RETRIEVAL HOOK -- the file that happened to be open when the lesson
 * was learned -- and its contents changing says nothing about the claim.
 *
 * MEASURED, across every real graph on one machine: 32 findings were served
 * stale, and 24 of them -- 75% -- were types in neither of these sets. The
 * clearest example is a `failure` reading "Edit hooks-core/, never the generated
 * copies", marked stale because hooks-core/wiki.mjs changed. That rule is about
 * process; wiki.mjs's contents cannot make it wrong. It was being discounted for
 * a reason that did not exist.
 *
 * THE TRADE, STATED. A `command` finding CAN be invalidated by its anchor -- a
 * claim about `npm test` anchored to package.json genuinely dies if the test
 * script changes. That case is now missed. It is the better error: today every
 * version bump marks it stale, so the signal fires overwhelmingly when nothing
 * relevant happened, and a signal that is usually wrong is one a reader learns
 * to ignore -- taking the rare true positive with it.
 */
const CONTENT_DEPENDENT = new Set(['finding', 'map']);

/**
 * What, if anything, currently disagrees with this finding.
 *
 * DISCLOSED AT SERVE TIME, because that is the only moment the disagreement can
 * do any good. `WIKI_GRAPH.md`'s whole argument for making `contradicts` an edge
 * rather than an overwrite is that a reader "sees both claims and the
 * disagreement between them" -- so handing a finding to a model while something
 * in the graph disputes it, without saying so, throws away the reason the edge
 * was recorded instead of an overwrite.
 *
 * `hasOutstandingContradiction` is the gate: it is the one definition of "an
 * open dispute", shared with the confidence-promotion gate, so the two can never
 * disagree about what counts. The loop only NAMES the other side, and it names a
 * key rather than quoting a claim because the reader can call `wiki_query` with
 * a key -- and because the injection path pays for every character it renders.
 *
 * SEPARATE FROM STALENESS on purpose. A finding can be disputed without being
 * stale (nothing touched its anchor; another finding simply says otherwise) and
 * stale without being disputed, so this adds its own fields rather than
 * borrowing the stale ones, and the renderer discloses each on its own terms.
 */
function disputeOf(graph, finding) {
  if (!hasOutstandingContradiction(graph, finding.key)) return {};

  const keys = [];
  const disputantIds = [];
  // AND THE REASON A PERSON TYPED, which had no reader anywhere. `contradict`
  // stores `contradictionReason` -- up to 400 characters of human explanation --
  // on the CONTRADICTED end only, and nothing outside its own test ever read it:
  // this disclosure named the other key and stopped, `audit` counts ends, and the
  // dashboard detail view renders neither. So the one field on the edge that says
  // WHY was written on every contradiction and seen by nobody. It is collected
  // from whichever end holds it, so both sides of a dispute disclose the same
  // reason rather than only the claim that lost.
  let reason = typeof finding.contradictionReason === 'string' ? finding.contradictionReason : '';
  for (const edge of graph.edges) {
    if (edge.edge !== 'contradicts') continue;
    const otherId =
      edge.from === finding.id ? edge.to : edge.to === finding.id ? edge.from : null;
    if (!otherId) continue;
    const other = graph.nodes.get(otherId);
    // An edge end that resolves to nothing names nothing. The dispute is still
    // disclosed -- the gate above already established it -- but without a key
    // the reader cannot be pointed anywhere, and inventing one would be worse.
    //
    // A RETIRED END IS NOT NAMED EITHER, for a sharper reason: the disclosure
    // tells the reader to `wiki_query` that key, and `serve` refuses to return
    // a retired finding at all. Naming it points them at a claim they cannot
    // fetch. `hasOutstandingContradiction` above already declines to open the
    // gate when EVERY disputant is retired; this is the same rule applied to
    // each name, so a live disputant is still reported alongside a withdrawn one.
    if (!disputantIds.includes(otherId)) disputantIds.push(otherId);
    if (other && !other.retired && typeof other.key === 'string' && !keys.includes(other.key)) {
      keys.push(other.key);
      // A RETIRED END'S REASON IS NOT BORROWED EITHER, which is why this sits
      // inside the same guard as the key: `hasOutstandingContradiction` can be
      // open on one live disputant while another is withdrawn, and quoting the
      // withdrawn one's explanation would attribute the live dispute to a claim
      // the reader cannot fetch.
      if (!reason && typeof other.contradictionReason === 'string') {
        reason = other.contradictionReason;
      }
    }
  }

  // WHEN, alongside WHY. `contradict` writes `contradictedAt` and
  // `contradictionReason` on the same line of the same putNode call. Round 1
  // gave the reason a reader -- this function -- and left the timestamp
  // unread, so the disclosure could say a claim was disputed and why, and not
  // whether that happened this morning or a year ago. For a reader deciding
  // whether to trust a disputed finding, the age of the dispute is most of the
  // signal: a year-old objection to a claim nobody has revisited reads very
  // differently from one raised since the last release.
  //
  // Collected from whichever end holds it, exactly like the reason, and the
  // EARLIEST is kept -- the dispute began when the first end recorded it.
  let contradictedAt =
    typeof finding.contradictedAt === 'number' ? finding.contradictedAt : null;
  for (const id of disputantIds) {
    const other = graph.nodes.get(id);
    if (!other || other.retired) continue;
    if (typeof other.contradictedAt !== 'number') continue;
    contradictedAt =
      contradictedAt === null ? other.contradictedAt : Math.min(contradictedAt, other.contradictedAt);
  }

  return {
    contradicted: true,
    ...(keys.length ? { contradictedBy: keys.join(', ') } : {}),
    ...(contradictedAt !== null ? { contradictedAt } : {}),
    // Trimmed here rather than at the renderer: an empty string is not a reason,
    // and a consumer checking `if (reason)` should not have to trim first.
    //
    // SET UNCONDITIONALLY, INCLUDING TO `undefined`. `serve` spreads the stored
    // record before this object, so omitting the key would let a whitespace-only
    // stored reason through untouched and make the served value differ from the
    // one this function decided on. The disclosure is authoritative or it is not
    // a disclosure.
    contradictionReason: reason.trim() || undefined,
  };
}

/**
 * Whether THIS finding's own claim-time evidence still matches its anchors --
 * the reader `harvest-write.mjs`'s `derivation` record was written for.
 * Nothing consumed that record until now: a grep for it found only the writer
 * and its own tests, which made "checkable rather than merely attributed" a
 * claim with no code behind it.
 *
 * DISTINCT FROM `stale`/`checkAnchor`, DELIBERATELY, not a duplicate of it.
 * `checkAnchor` compares disk against the anchor NODE's CURRENT stored hash,
 * which is refreshed by `indexFile` every time ANYTHING touches that file --
 * so it answers "has this file changed since the last time anyone indexed
 * it", not "has it changed since THIS finding was derived from it". Those
 * differ in a real case: file F changes, and a LATER, unrelated write
 * (another finding, another session) re-indexes F, updating the node's
 * stored hash to match the new content again. `checkAnchor` now reports
 * "fresh" -- disk matches the node's current hash -- while this finding's own
 * frozen `derivation.anchors[id]` snapshot, taken when IT was written, no
 * longer matches. The bytes this claim was actually derived from are gone,
 * and `stale` alone would never say so.
 *
 * Returns `{}` when there is nothing to check (no `derivation.anchors`
 * recorded -- true of every finding written before this existed), so a
 * caller can tell "not checked" from "checked and holds" by whether
 * `derivationHolds` is present at all.
 *
 * `derivationHolds: true` MEANS "MATCHES THE ANCHOR NODE'S LAST-INDEXED
 * HASH", NOT "MATCHES DISK RIGHT NOW" -- and that distinction is stored in
 * `derivationCheckedAgainst: 'index'` rather than left for a `wiki_query`
 * consumer to infer from a field name alone. Two ways to close this gap were
 * considered: recompute a live hash from disk here, or document precisely
 * what is actually compared. `stale` (via `checkAnchor`, above) ALREADY owns
 * the disk comparison -- re-reading the same file a second time on the same
 * serve path, for the same anchor, from a second mechanism, is worse than
 * one honest name. So: documented, not duplicated. A file changed on disk
 * but never re-indexed by anything is still caught, correctly, by `stale`;
 * `derivationHolds` answers a narrower, complementary question -- whether
 * the LAST INDEXED state agrees with what this specific finding recorded --
 * which is exactly the re-indexed-by-something-else case above that `stale`
 * cannot see.
 */
function derivationCheck(graph, finding) {
  const recorded = finding.derivation && finding.derivation.anchors;
  if (!recorded || typeof recorded !== 'object') return {};
  const ids = Object.keys(recorded);
  if (!ids.length) return {};

  const changed = [];
  for (const id of ids) {
    const node = graph.nodes.get(id);
    const currentHash = node && typeof node.hash === 'string' ? node.hash : null;
    // An anchor that no longer resolves at all cannot be confirmed either --
    // treated the same as a changed hash, never as "still holds" by default.
    if (currentHash === null || currentHash !== recorded[id]) {
      changed.push(node && typeof node.key === 'string' ? node.key : id);
    }
  }

  // Declared on BOTH branches, not only the ambiguous one: a consumer should
  // not have to already know the answer to know what was checked.
  if (!changed.length) return { derivationHolds: true, derivationCheckedAgainst: 'index' };
  // Bounded: a finding with many anchors should not spend unbounded budget
  // naming every one that moved.
  return { derivationHolds: false, derivationChanged: changed.slice(0, 5), derivationCheckedAgainst: 'index' };
}

/**
 * Prepares findings for delivery, verifying each one lazily against disk.
 *
 * This is the only function that should ever hand a finding to a model, because
 * it is the one that enforces the rule: a stale finding leaves here carrying
 * `stale: true` AND a diff, or it does not leave at all.
 *
 * AND IT CLEARS A STORED FLAG WHOSE EVIDENCE IS GONE, when given a `dir` to
 * write to. Clearing used to be reachable only by a person pressing Re-verify in
 * the dashboard, which left the rot path fully open on every install where
 * nobody opens the dashboard -- and that is most of them. The evidence test is
 * what makes clearing safe, and it does not care who triggered it: the same
 * `claimTimeEvidence` runs here as in `reverify`, so this cannot clear anything
 * the button would not.
 *
 * A CLEAR ALSO RE-INDEXES THE ANCHORS IT VERIFIED. The three disclosures this
 * function emits -- `stale`, `derivationHolds`, and the dispute -- are computed
 * from three different comparisons, and clearing the flag without moving the
 * anchor's stored hash made the first two contradict the clear on the revert
 * path. `reindexVerifiedAnchors` explains the reproduction and why re-pointing
 * the index is the fix rather than suppressing the disclosures.
 *
 * `dir` IS OPTIONAL, AND OMITTING IT MAKES THIS READ-ONLY. Several callers hold
 * a graph without the directory it came from, and a serve that silently did
 * nothing would be worse than one that plainly cannot write.
 */
export function serve(graph, findings, { dir = null } = {}) {
  const served = [];

  // RETIRED FINDINGS STOP HERE, unconditionally.
  //
  // findingsFor and sessionIndex already filter them, so this is redundant on
  // every current path -- deliberately. This function's own contract is that it
  // is the only thing that hands a finding to a model, which makes it the right
  // place for the guarantee to live: a future caller that reaches into the
  // graph directly cannot accidentally serve a claim a human explicitly
  // withdrew. A withheld claim reappearing is not a bug anyone would notice
  // quickly.

  for (const finding of findings.filter((f) => !f.retired)) {
    // A DISPUTE TRAVELS WITH EVERY TYPE, which is why it is computed before the
    // content-dependence branch below. A `command` or `rule` finding cannot be
    // invalidated by an anchor's contents, but another finding can still
    // disagree with it, and this early return is the path that would have
    // quietly dropped that.
    const dispute = disputeOf(graph, finding);

    // A claim that does not depend on the anchor's contents cannot be
    // invalidated by them. It is served as-is rather than discounted.
    if (!CONTENT_DEPENDENT.has(finding.type || 'finding')) {
      served.push({ ...finding, ...dispute });
      continue;
    }

    // AUTOMATIC CLEARING, on the same evidence the manual path demands.
    //
    // THE FLAG AND THE INDEX MOVE TOGETHER. Clearing the flag alone made this
    // function contradict itself on the revert path: the lazy loop below
    // compares disk against the anchor NODE's hash, which the eager path
    // re-pointed at the post-edit bytes, so a reverted file read as `stale:
    // true, staleReason: 'file changed'` and `derivationHolds: false` inside the
    // very object whose flag had just been cleared for matching its claim-time
    // content. `reindexVerifiedAnchors` writes the verified bytes' hash back to
    // the anchor, so all three disclosures are finally reading the same content
    // and cannot disagree. Eager and lazy stay two mechanisms, as the module
    // header insists -- what changed is that the index no longer holds a hash
    // that matches no version of the file that exists.
    //
    // AND THE FIELDS GO WITH THE FLAG. `putNode` does not merge and neither does
    // this spread: serving `{ ...finding, stale: false }` would hand back a
    // finding that reads fresh while still carrying `staleReason` and `diff`
    // from the record -- stale and fresh at once, which is worse than either.
    // So the cleared record, not the stored one, is what the rest of this
    // iteration reads and spreads.
    //
    // BOUNDED PER CALL, and the bound is the point: this runs only for a finding
    // whose flag is already STORED, only when a `derivation` record exists to
    // check against, and it reads each of that finding's anchors at most once.
    // A finding that is not flagged pays nothing. The lazy loop below already
    // reads every anchor of every content-dependent finding served, so the worst
    // case is twice the anchor reads on the already-stale subset alone.
    //
    // AND THE PER-SESSION SHAPE, stated because the per-call bound alone reads
    // as cheaper than it is. Measured on a synthetic 40-stale-finding graph, the
    // serve path went 158 ms -> 217 ms (+37%), and for a GENUINELY stale finding
    // that cost recurs on every call for the whole session: the verdict is
    // `'differs'` forever, nothing is cleared, and the reads are repaid with
    // nothing. What keeps it survivable in practice is not this bound but two
    // others -- `findingsFor`'s result limit and inject.mjs's `alreadyInjected`
    // gate, which together put it near 40 ms on the first touch of a hot file
    // and zero on the touches after.
    //
    // THE REVERT CASE PAYS ONCE, AND THAT IS MEASURED, not argued. Same 40
    // findings, all revertible, medians of 9 across three process launches: the
    // read-only serve is 23-29 ms, the first clearing serve is 141-173 ms (the
    // anchor reads plus one node append per cleared finding AND per re-pointed
    // anchor), and the SECOND clearing serve is 21-28 ms -- back to the
    // read-only baseline, because the flag is off and the index agrees, so this
    // gate no longer fires. What the re-index changed is not that cost -- the
    // gate stopped firing once the flag came off before, too -- but that every
    // serve after the clear used to re-derive `stale: true` and
    // `derivationHolds: false` from an index nobody had moved. The extra ~120 ms
    // buys silence that is actually correct.
    // On the genuinely-stale set the recurring cost is
    // real and unchanged in kind: 26-45 ms read-only against 53-105 ms with
    // clearing on, every call, clearing nothing.
    //
    // NOT ON THE NON-CONTENT-DEPENDENT EARLY RETURN ABOVE, deliberately. Both
    // eager paths refuse to flag those types at all, so a flag there can only
    // come from an older graph -- and reading anchors for a type whose truth
    // does not depend on them is exactly the cost `CONTENT_DEPENDENT` exists to
    // avoid.
    let record = finding;
    if (dir && finding.stale) {
      const evidence = claimTimeEvidence(graph, finding);
      if (evidence.verdict === 'match') {
        reindexVerifiedAnchors(dir, graph, evidence.contents);
        clearStale(dir, finding.key, { graph });
        const { stale: _s, staleReason: _r, diff: _d, staleEvidence: _e, ...cleared } = finding;
        record = cleared;
      }
    }

    const anchors = graph.edges
      .filter((e) => e.edge === 'derived_from' && e.from === record.id)
      .map((e) => graph.nodes.get(e.to))
      .filter(Boolean);

    let stale = false;
    let diff = '';
    let reason = '';

    for (const anchor of anchors) {
      const check = checkAnchor(anchor);
      if (check.fresh) continue;
      stale = true;
      reason = check.reason;
      // An absent snapshot is NOT an empty "before". Diffing against '' renders
      // the whole file as added, which reads like a total rewrite and is worse
      // than saying nothing -- so the missing-evidence case is detected from
      // whether a snapshot exists, not from whether the diff string came back
      // empty.
      diff = check.hasBefore ? diffLines(check.before, check.after) : '';
      break;
    }

    // A finding already marked stale eagerly, whose diff was captured at write
    // time, keeps that diff -- the eager path saw the change we can no longer
    // reconstruct from disk alone.
    if (!stale && record.stale) {
      stale = true;
      diff = record.diff || '';
      reason = record.staleReason || 'marked stale when the change was observed';
    }

    if (stale && !diff) {
      // The invariant holds: never serve a bare stale finding as though it were
      // current. But the WORDING was doing more than that, and it was measured.
      //
      // "treat this finding as unverified" is an instruction to discount, and
      // models follow it. In an A/B on a fresh subagent, identical findings
      // scored 1/3 dead-ends avoided when rendered with that sentence and 2/3
      // when rendered clean -- no code change, only the wording. The claim being
      // discounted was correct every time; all that had changed was the anchor
      // file, which says nothing about whether the claim still holds.
      //
      // So: report what is actually known and let the claim stand or fall on its
      // own. That is honest about staleness without arguing against the content.
      //
      // REASON-NEUTRAL. The earlier text asserted "the anchor changed", which is
      // only one of the ways a finding reaches this branch -- it is also reached
      // when the eager path marked the finding at write time, or when the anchor
      // was never snapshotted at all because it exceeded the snapshot limit. In
      // those cases the sentence stated a cause that had not been established.
      // `reason` already carries whatever was actually determined, so the
      // fallback now describes only the evidence gap.
      // NO DISMISSAL VOCABULARY AT ALL, not even in a sentence arguing against
      // dismissal. "weigh it rather than discard it" still puts the word in
      // front of the model, and this text exists precisely because the previous
      // phrasing was measured suppressing correct findings. State the evidence
      // gap and stop.
      // THE PROSE MOVES OUT OF `diff`, and the fact moves into a flag.
      //
      // Softening this sentence was not enough, because the RENDERER wraps it:
      // the model saw `STALE (reason). What changed:` followed by a paragraph
      // explaining that nothing follows. The strong framing was designed for
      // the case where evidence exists and was being applied to the case where
      // it does not.
      //
      // Measured across every real graph on one machine: 32 of 241 served
      // findings were stale, and 25 of those 32 -- 78% -- had no diff at all.
      // So the strongest wording available was carried by the findings with the
      // least evidence behind them, on 10.4% of everything served.
      //
      // A caller cannot phrase this well from a prose blob, so it gets the two
      // things it needs: that the finding is stale, and whether any evidence
      // survives. The wording is then the renderer's business.
      diff = '';
    }

    served.push({
      ...record,
      stale,
      ...(stale ? { diff, staleReason: reason, staleEvidence: Boolean(diff) } : {}),
      // BOTH OTHER DISCLOSURES SURVIVE A MID-SERVE CLEAR. `dispute` was computed
      // above the content-dependence branch and is applied here untouched, and
      // the derivation verdict is recomputed from the record -- which still
      // carries its `derivation`, since clearing removes only the staleness
      // fields. A finding whose flag was just cleared is still disclosed as
      // disputed, and still reports whether its derivation holds.
      //
      // AND THEY NO LONGER CONTRADICT THE CLEAR. Surviving is not the same as
      // agreeing: for a whole serve this returned `stale: true, staleReason:
      // 'file changed'` and `derivationHolds: false` on a finding it had just
      // cleared, because the clear was decided against disk while these two read
      // the anchor node's hash, and the eager path had moved it. All three now
      // read the same content because the clear re-points the anchor; see
      // `reindexVerifiedAnchors`.
      ...dispute,
      // Independent of `stale` above: see `derivationCheck`'s own comment for
      // the case it catches that node-level staleness can miss.
      ...derivationCheck(graph, record),
    });
  }
  // FLATTENED ON THE WAY OUT, once, for both push sites and any added later.
  //
  // This function's contract, stated at the top, is that it is the only thing
  // that hands a finding to a model -- so it is the only place that has to hold
  // the line about what those findings may contain. A stored claim or dispute
  // reason carrying a newline writes its own lines inside the injected block,
  // and the model cannot tell a forged line from one the renderer wrote. See
  // safe-text.mjs for what is flattened, and for why `diff` is not.
  return served.map(safeRecord);
}

/**
 * The eager path: our hook saw a write, so mark dependent findings now and
 * record the diff while both sides are still in hand.
 */
export function invalidateOnWrite(dir, graph, rawPath, beforeText, afterText) {
  // Canonical at the boundary, because node keys are canonical. Comparing a raw
  // path against them matched nothing and silently invalidated no findings.
  const path = canonicalPath(rawPath);
  const marked = [];

  // Which symbols in this file ACTUALLY changed. Without this the loop below
  // marked every symbol node belonging to the file, so editing one function
  // permanently staled every finding about every other function in it -- and
  // permanently, because the eager mark is a stored flag that the lazy check
  // never clears. That is worse than the file-level staleness symbols were
  // introduced to avoid.
  const before = new Map(extractSymbols(path, beforeText ?? '')
    .map((s) => [s.name, hash(spanText(beforeText ?? '', s))]));
  const after = new Map(extractSymbols(path, afterText ?? '')
    .map((s) => [s.name, hash(spanText(afterText ?? '', s))]));

  const changedSymbols = new Set();
  for (const [name, digest] of after) {
    if (before.get(name) !== digest) changedSymbols.add(name);
  }
  for (const name of before.keys()) {
    if (!after.has(name)) changedSymbols.add(name);
  }

  // Edges indexed ONCE by target. The nested loop below was O(nodes x edges) on
  // every observed write, which on a mature graph is the hot path running
  // inside a hook -- the one place latency is paid per tool call.
  const byTarget = new Map();
  for (const edge of graph.edges) {
    if (edge.edge !== 'derived_from') continue;
    if (!byTarget.has(edge.to)) byTarget.set(edge.to, []);
    byTarget.get(edge.to).push(edge);
  }

  for (const node of graph.nodes.values()) {
    if (node.kind === 'file' && node.key !== path) continue;
    if (node.kind === 'symbol' && (node.file !== path || !changedSymbols.has(node.name))) continue;
    if (node.kind !== 'file' && node.kind !== 'symbol') continue;

    for (const edge of byTarget.get(node.id) || []) {
      const finding = graph.nodes.get(edge.from);
      if (!finding || finding.kind !== 'finding') continue;
      // THE SAME TYPE GATE `serve` APPLIES, and it has to be here too now that
      // this path actually runs. `serve` ignores a stale flag on a type whose
      // truth is not a claim about the anchor's contents -- but the flag is
      // STORED, and disclose.mjs skips a stale finding outright while
      // utility.mjs penalises one by 160. So writing it onto a `failure` or a
      // `command` would suppress that claim everywhere except the one reader
      // that knows to ignore it, which is exactly the harm measured in the
      // comment on CONTENT_DEPENDENT above.
      if (!CONTENT_DEPENDENT.has(finding.type || 'finding')) continue;

      putNode(dir, {
        ...finding,
        kind: 'finding',
        key: finding.key,
        stale: true,
        staleReason: 'edited during this session',
        diff: diffLines(beforeText ?? '', afterText ?? ''),
      });
      marked.push(finding.key);
    }
  }

  // Re-index so the anchors carry the new hashes; otherwise the lazy path would
  // report the same change again on every future retrieval.
  indexFile(dir, path, afterText);
  return marked;
}

/**
 * The eager path for a write with NO before/after pair: compare stored hashes
 * against disk, and mark what actually moved.
 *
 * WHY THIS EXISTS AS A SECOND SHAPE. A whole-file `Write` replaces the file, so
 * the payload carries the after side and nothing at all of the before -- and a
 * whole-file write is the commonest write shape there is. `invalidateOnWrite`
 * cannot serve it: passing '' as the before side makes every symbol in the file
 * look changed, marks every finding anchored anywhere in it, and the eager mark
 * is a stored flag no later check ever clears. False-stale is expensive and
 * permanent, so it is not an acceptable price for coverage.
 *
 * But the hash comparison is available, and it is exactly the comparison the
 * lazy path makes. The difference is WHEN: this runs at the top of injection,
 * before `indexFile` refreshes the anchor, so the stored hash is still the
 * pre-write one and the comparison is meaningful. That is the whole trick --
 * lazy is not wrong, it is merely too late.
 *
 * SYMBOL-LEVEL, and from ONE read. Re-locating each symbol by name and
 * comparing its own span hash is what keeps this from degenerating into
 * file-level marking: editing one function must not stale a finding about
 * another, which is the property symbol nodes exist to provide.
 *
 * WEAKER EVIDENCE, STATED AS SUCH. There is no before text, so no diff can be
 * built -- the finding is marked with the two hashes and `serve` reports the
 * evidence gap through `staleEvidence: false`, which the renderer turns into
 * "no diff could be rebuilt" rather than promising a diff and showing nothing.
 * A stale finding with weak evidence is far better than one served as fresh,
 * but the reader has to be able to tell which one they are holding.
 */
export function invalidateChangedAnchors(dir, graph, rawPath) {
  const path = canonicalPath(rawPath);
  const marked = [];

  // ONE read for the file and every symbol in it. checkAnchor would have been
  // the obvious reuse and it reads per anchor, which on a file with fifty
  // symbols is fifty-one reads of the same bytes on a hook path.
  let source = null;
  try {
    source = readAnySpelling(path);
  } catch {
    // Deleted, or unreadable from this checkout. Handled below as a change,
    // because a finding about a file that is no longer there is exactly the
    // kind that must not be served as fresh.
  }

  const changed = [];
  const fileNode = graph.nodes.get(nodeId('file', path));
  const fileDigest = source === null ? null : hash(source);
  if (fileNode && fileDigest !== fileNode.hash) {
    changed.push({ node: fileNode, from: fileNode.hash, to: fileDigest });
  }

  const current = new Map(
    source === null
      ? []
      : extractSymbols(path, source).map((s) => [s.name, hash(spanText(source, s))])
  );
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'symbol' || node.file !== path) continue;
    const digest = current.has(node.name) ? current.get(node.name) : null;
    if (digest !== node.hash) changed.push({ node, from: node.hash, to: digest });
  }

  if (changed.length) {
    // Indexed once by target, for the reason invalidateOnWrite indexes: the
    // nested alternative is O(nodes x edges) inside a hook.
    const byTarget = new Map();
    for (const edge of graph.edges) {
      if (edge.edge !== 'derived_from') continue;
      if (!byTarget.has(edge.to)) byTarget.set(edge.to, []);
      byTarget.get(edge.to).push(edge);
    }

    for (const { node, from, to } of changed) {
      for (const edge of byTarget.get(node.id) || []) {
        const finding = graph.nodes.get(edge.from);
        if (!finding || finding.kind !== 'finding') continue;
        // The same type gate serve() applies, for the same reason it is applied
        // in invalidateOnWrite: the flag is STORED, and disclose.mjs skips a
        // stale finding while utility.mjs penalises one by 160.
        if (!CONTENT_DEPENDENT.has(finding.type || 'finding')) continue;
        // ALREADY MARKED IS LEFT ALONE. Whatever marked it first had a diff or
        // a more specific reason; overwriting that with a hash pair trades real
        // evidence for less.
        if (finding.stale) continue;

        putNode(dir, {
          ...finding,
          kind: 'finding',
          key: finding.key,
          stale: true,
          staleReason:
            to === null
              ? `the ${node.kind} it depends on is no longer present (was ${from})`
              : `content hash changed during this session (${from} -> ${to}), observed without a before/after pair`,
          // EXPLICITLY EMPTY, not absent. serve() reports `staleEvidence` from
          // whether a diff survived, and the renderer says "no diff could be
          // rebuilt" -- so the reader can tell "changed, diff unknown" from
          // "changed, here is what changed".
          diff: '',
        });
        marked.push(finding.key);
      }
    }
  }

  // Re-index for the same reason the diff path does: otherwise every future
  // retrieval re-reports a change that has already been accounted for.
  if (source !== null) indexFile(dir, path, source);
  return marked;
}

/**
 * The current content of an anchor, read from disk: the whole file for a file
 * anchor, the located span for a symbol one. Null when nothing can be read.
 *
 * SPLIT OUT FROM `anchorHashNow` SO THE BYTES SURVIVE THE COMPARISON. The
 * clearing path hashes this to reach a verdict and, on `'match'`, re-indexes the
 * anchor from the same bytes -- see `reindexVerifiedAnchors`. Returning only a
 * hash forced a second read of a file that had just been read, for content
 * already known to be identical.
 */
function anchorContentNow(anchor) {
  const path = anchor.kind === 'symbol' ? anchor.file : anchor.key;
  let source;
  try {
    source = readAnySpelling(path);
  } catch {
    return null;
  }
  if (anchor.kind !== 'symbol') return source;

  // By NAME, like checkAnchor: line numbers shift whenever anything above is
  // edited, and re-locating by line would report a symbol as moved when only an
  // unrelated insert happened above it.
  const current = extractSymbols(path, source).find((s) => s.name === anchor.name);
  if (!current) return null;
  return spanText(source, current);
}

/**
 * The current content hash of an anchor, read from disk.
 *
 * DELIBERATELY NOT `checkAnchor`, and the difference is the whole of this
 * clearing rule. `checkAnchor` compares disk against the anchor NODE's stored
 * hash, and both eager paths call `indexFile` immediately after marking --
 * which re-points that hash at the very bytes that caused the mark. So
 * `checkAnchor` answers "fresh" for exactly the finding it just marked stale,
 * and a clearing rule built on it would clear every flag it was handed,
 * unconditionally. This returns a bare hash instead, so the caller can compare
 * it against the FROZEN claim-time hash rather than against a value the marking
 * path itself moved.
 *
 * Returns null when no content can be read at all -- a deleted file, or a
 * symbol that no longer exists. A caller must treat that as "changed", never as
 * "unknown": a claim about content that is gone certainly does not match the
 * content it was made against.
 */
function anchorHashNow(anchor) {
  const content = anchorContentNow(anchor);
  return content === null ? null : hash(content);
}

/**
 * Removes the staleness fields from a finding. Returns whether one was found.
 *
 * THE WHOLE NODE IS REWRITTEN, because `putNode` does not merge: it writes a
 * full record from what it is handed and `load` replaces the node wholesale.
 * Writing `{ kind, key, stale: false }` would blank the claim, the confidence
 * and the provenance -- an overwrite by another name, and the same trap
 * `contradict` documents. So the fields are destructured AWAY and everything
 * else is spread back: no deletion primitive is needed, and the append-only rule
 * is respected.
 *
 * `staleEvidence` is stripped as well, even though no writer stores it. It is
 * added by `serve` to the object it hands out, so anything that ever writes a
 * served finding back would carry it in -- at which point a cleared finding
 * would still be advertising the quality of the evidence for a flag it no longer
 * has.
 *
 * A PRIMITIVE, NOT A ROUTE. Nothing outside this module calls it: the only
 * shipping caller is `reverify` below, which establishes the evidence first.
 * Exposing it to a hook, a tool argument or an HTTP action would be a way to
 * turn a stale finding fresh on request, which is exactly what must not exist.
 */
export function clearStale(dir, key, { graph = null } = {}) {
  // A CALLER THAT ALREADY HOLDS THE GRAPH PASSES IT, and this is not
  // micro-optimisation: `load` re-parses the entire append-only log, so clearing
  // inside `serve`'s loop re-read and re-folded the whole graph once PER cleared
  // finding. Measured on 40 findings all stale and all revertible -- the shape a
  // mass revert produces -- that was 185 ms against 25 ms, a 7x regression on
  // the injection path, all of it graph loading rather than the hashing this
  // feature is actually for. With the graph passed through it is back in line.
  //
  // No new race: this store is last-write-wins with no compare-and-set anywhere,
  // and every other caller that spreads a node back -- `pin`, `retire`,
  // `contradict`, `correct` -- writes from a graph it loaded earlier too. Both
  // callers here already DECIDED on this snapshot, so re-reading it purely for
  // the write narrowed no window that was ever closed.
  const id = nodeId('finding', key);
  const node = (graph || load(dir)).nodes.get(id);
  if (!node || node.kind !== 'finding') return false;
  const { stale, staleReason, diff, staleEvidence, ...rest } = node;
  // Nothing to clear is a success, not a write: an unconditional putNode here
  // would append a duplicate record to the log on every no-op call.
  if (stale === undefined && staleReason === undefined
    && diff === undefined && staleEvidence === undefined) return true;
  const cleared = { ...rest, kind: 'finding', key: node.key };
  putNode(dir, cleared);
  // AND THE CALLER'S GRAPH IS UPDATED, because the guard above reads THAT graph,
  // not disk. Without this, a second `serve` on the same in-memory graph object
  // -- two touched files anchored to one finding, or a lifecycle branch that
  // serves twice from a graph it loaded once, as SessionStart does -- still saw
  // `stale: true`, re-ran the evidence test, and appended a byte-identical clear
  // record. The store is append-only, so that is permanent log growth for no
  // change in state, and the "nothing to clear is a success, not a write"
  // guarantee directly above was only true of the first call.
  if (graph) graph.nodes.set(id, { ...cleared, id });
  return true;
}

/**
 * THE ONE EVIDENCE TEST, plus the bytes it read. Does this finding's anchored
 * content still hash to what the claim was actually made against?
 *
 * `verdict` is one of:
 *   `'match'`   -- every anchor on disk re-hashes to the value frozen into this
 *                  finding's own `derivation.anchors` at claim time. The content
 *                  IS what the claim was derived from: a revert, or a write that
 *                  never moved the anchored bytes.
 *   `'differs'` -- at least one anchor does not, INCLUDING an anchor whose
 *                  content is gone. Deleted is a difference, not a missing
 *                  measurement.
 *   `'unknown'` -- there is nothing to compare: no `derivation.anchors`, no
 *                  anchors, an anchor with no recorded hash, or one that no
 *                  longer resolves.
 *
 * `contents` carries the disk bytes read to reach a `'match'`, keyed by anchor
 * id, so the caller can re-index those anchors without reading them again. It is
 * empty for the other two verdicts, which read no further than the first
 * disagreement.
 *
 * WHY CLEARING HAS TO EXIST AT ALL. Nothing in this codebase ever cleared a
 * `stale` flag.
 * That was harmless while eager invalidation was dead code; it fires now, so
 * every finding on an edited file becomes permanently stale -- and permanently
 * discounted, since `disclose.mjs` skips a stale finding outright and
 * `utility.mjs` penalises one by 160. The graph degrades toward all-stale, and
 * the eager path is over-eager on top of that: `invalidateOnWrite` marks every
 * finding anchored to a FILE node on any observed write to that file, whether or
 * not the bytes moved.
 *
 * WHAT COUNTS AS EVIDENCE, AND WHY IT IS NOT NEGOTIABLE. The only trustworthy
 * record of what a claim was made against is `derivation.anchors` -- the hash
 * each anchor carried at the moment the finding was written, frozen into the
 * finding itself by `harvest-write.mjs`. Disk is re-hashed here and compared
 * against that. If every anchor matches, the content IS what the claim was
 * derived from: a revert, or a write that never moved the anchored bytes. The
 * flag comes off. Anything else leaves it exactly as it was.
 *
 * IT IS NOT A LAUNDERING ROUTE, and that is a property of the comparison rather
 * than of who is allowed to call it. A caller cannot make a finding fresh by
 * asking; they can only make it fresh by putting the content back. There is no
 * argument, no force flag and no second path -- and `clearStale` above, the one
 * function that clears without checking, has no caller but this one.
 *
 * NO RECORD MEANS UNKNOWN, NEVER CLEAR. A finding with no `derivation.anchors`
 * -- every one written before that record existed, and every hand-curated one --
 * has nothing to compare disk against. That is an absence of evidence, and
 * resolving it to "clear it" would hand back the laundering route through the
 * side door. It reports `unknown` and changes nothing; re-recording the claim
 * against the current code (`curate.correct`) is the way forward for those.
 *
 * SHARED BY BOTH CLEARING PATHS ON PURPOSE, and that sharing is the guarantee
 * rather than a convenience. `reverify` (a person pressing Re-verify) and
 * `serve` (automatic, on every retrieval) call THIS function and nothing else,
 * so the automatic path cannot clear anything the button would not, and neither
 * can drift from the other. Two copies of this comparison would be two policies,
 * and the weaker one would win wherever it ran more often -- which is the
 * automatic one.
 *
 * NOT `checkAnchor`, for the reason `anchorHashNow` above spells out: that
 * compares disk against the anchor NODE's stored hash, which both eager paths
 * re-point at the very bytes that caused the mark, so it answers "fresh" for
 * exactly the finding it just marked stale.
 */
function claimTimeEvidence(graph, finding) {
  const none = { verdict: 'unknown', contents: new Map() };
  const recorded = finding.derivation && finding.derivation.anchors;
  if (!recorded || typeof recorded !== 'object') return none;

  const anchorIds = new Set(
    graph.edges
      .filter((e) => e.edge === 'derived_from' && e.from === finding.id)
      .map((e) => e.to)
  );
  // An unanchored finding cannot be checked against anything, which is the
  // un-invalidatable shape the anchor discipline exists to refuse. It is equally
  // un-VERIFIABLE, so it is reported as such rather than cleared.
  if (!anchorIds.size) return none;

  const contents = new Map();
  for (const id of anchorIds) {
    const expected = recorded[id];
    const node = graph.nodes.get(id);
    // An anchor this finding never recorded a hash for, or one that no longer
    // resolves to a node: nothing to compare, so nothing is concluded.
    if (typeof expected !== 'string' || !expected || !node) return none;
    if (node.kind !== 'file' && node.kind !== 'symbol') return none;
    // null means the content is gone -- deleted file, vanished symbol. That is a
    // difference, not an absence of evidence.
    const content = anchorContentNow(node);
    if (content === null || hash(content) !== expected) {
      return { verdict: 'differs', contents: new Map() };
    }
    contents.set(id, content);
  }
  return { verdict: 'match', contents };
}

/** The verdict alone, for callers that do not re-index. */
function claimTimeVerdict(graph, finding) {
  return claimTimeEvidence(graph, finding).verdict;
}

/**
 * Re-points every verified anchor at the content the evidence test just read.
 *
 * WHY A CLEAR IS NOT ENOUGH ON ITS OWN, reproduced end to end: index a file at
 * H1, write a finding whose `derivation.anchors` records H1, edit and re-index so
 * the node holds H2, let the eager path mark the finding, then REVERT the edit on
 * disk. `claimTimeVerdict` now says `'match'` -- disk is H1, which is exactly
 * what the claim was derived from -- and the flag comes off. But the node still
 * holds H2, so the same `serve` call went on to emit `stale: true` with
 * `staleReason: 'file changed'` from the lazy loop (disk H1 against node H2) and
 * `derivationHolds: false` from `derivationCheck` (index H2 against claim H1).
 * The model was shown DERIVATION CHANGED and STALE at the exact moment this
 * module's own evidence test had concluded the derivation holds -- on every
 * serve, until something unrelated happened to re-index the anchor.
 *
 * THE FIX IS TO MOVE THE INDEX, NOT TO SILENCE THE DISCLOSURES. Suppressing the
 * lazy check and the derivation verdict for a cleared finding would leave the
 * graph holding a hash that matches no version of the file that exists, so every
 * OTHER finding on that anchor keeps reading stale, and the next reader has to be
 * told which disclosures to disbelieve. The node hash is simply out of date, the
 * bytes are already in hand from the comparison that just succeeded, and writing
 * them makes all three disclosures agree because they are finally reading the
 * same content.
 *
 * COSTS NO READ. `contents` comes from `claimTimeEvidence`, which read each
 * anchor to reach `'match'`. The write is one node record per anchor whose hash
 * actually moved, and it happens once per revert rather than once per serve: with
 * the index re-pointed, the flag stays off and the gate in `serve` does not fire
 * again.
 *
 * THE IN-MEMORY GRAPH IS UPDATED TOO, because the caller is mid-serve and is
 * about to read these same nodes through the lazy loop and `derivationCheck`.
 * Writing only to disk would fix the next process and leave this one contradicting
 * itself, which is the whole defect.
 *
 * Line numbers are deliberately left alone on a symbol anchor: `checkAnchor` and
 * `anchorContentNow` both re-locate by NAME, so a stored line is informational,
 * and the body being byte-identical is what was just established.
 */
function reindexVerifiedAnchors(dir, graph, contents) {
  for (const [id, content] of contents) {
    const node = graph.nodes.get(id);
    if (!node) continue;
    const nextHash = hash(content);
    // Already agrees: no record, no write. The common case once a revert has
    // been accounted for.
    if (node.hash === nextHash) continue;
    const limit = node.kind === 'symbol' ? symbolSnapshotLimit() : snapshotLimit();
    // Same bound as `indexFile`: past the cap the hash still drives staleness and
    // only the reconstructed diff degrades.
    const snapshot = content.length <= limit ? content : undefined;
    const { hash: _h, snapshot: _s, ...rest } = node;
    try {
      putNode(dir, { ...rest, kind: node.kind, key: node.key, hash: nextHash, snapshot });
    } catch {
      // Fail open: a graph that could not be written is a disclosure that stays
      // as it was, never a broken tool call. The in-memory copy is left alone to
      // match, so this serve keeps agreeing with the store.
      continue;
    }
    graph.nodes.set(id, { ...node, hash: nextHash, ...(snapshot ? { snapshot } : {}) });
  }
}

/**
 * Clears a stale flag on behalf of a person who asked for it -- the dashboard's
 * Re-verify action -- and reports what the evidence said.
 *
 * `'cleared'` when the flag is gone (including when it was already gone, so a
 * caller polling this does not retry forever), `'still-stale'` when the anchored
 * content genuinely differs from what the claim was made against, `'unknown'`
 * when there is nothing to compare and therefore nothing to conclude.
 *
 * NO LONGER THE ONLY CLEARING PATH, and the docblock that used to sit here said
 * the opposite: that automatic clearing was refused because it would put N file
 * reads inside injection and "silently un-mark findings nobody asked about".
 * `serve` now does exactly that, on the same evidence, for the reason its own
 * comment gives -- the manual path was reachable only where somebody opens the
 * dashboard, which is almost nowhere, so the rot path stayed open on most
 * installs. What survives of that objection is the cost, which `serve` bounds
 * and states.
 *
 * WHAT THIS STILL ADDS over the automatic path: it loads the graph itself, so a
 * caller holding nothing but a key and a directory can act; it reports the
 * verdict rather than folding it into a served record; and it runs on demand
 * rather than only when the finding happens to be retrieved. It re-indexes the
 * verified anchors for the same reason `serve` does -- otherwise the button
 * clears the flag and the very next retrieval re-derives a contradiction from a
 * node hash nobody moved.
 */
export function reverify(dir, key) {
  const graph = load(dir);
  const finding = graph.nodes.get(nodeId('finding', key));
  if (!finding || finding.kind !== 'finding') return 'unknown';
  // Idempotent: the postcondition -- no stale flag on this finding -- already
  // holds, and reporting anything else would make a caller retry forever.
  if (!finding.stale) return 'cleared';

  const { verdict, contents } = claimTimeEvidence(graph, finding);
  if (verdict === 'unknown') return 'unknown';
  if (verdict === 'differs') return 'still-stale';
  reindexVerifiedAnchors(dir, graph, contents);
  clearStale(dir, key, { graph });
  return 'cleared';
}

export { contentHash };
