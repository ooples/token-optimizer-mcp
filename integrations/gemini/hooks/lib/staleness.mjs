// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/staleness.mjs. Regenerate with `npm run sync:hooks`.
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
 *             moment it went stale, with the exact before/after in hand.
 *   LAZY   -- at retrieval, the anchor's stored hash is compared against disk.
 *             This is what catches `git pull`, another editor, a teammate, or a
 *             build step: every change our hooks never observed.
 *
 * Eager alone would silently serve stale findings as fresh whenever a change
 * came from outside the agent, which is the single failure mode the design
 * calls worse than no graph.
 */

import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { putNode, putEdge, contentHash, nodeId } from './wiki.mjs';
import { extractSymbols, spanText, symbolKey, extractImports } from './symbols.mjs';
import { canonicalPath, resolvableCandidates } from './paths.mjs';

/** Reads a path in whichever spelling resolves, or throws if none do. */
function readAnySpelling(path) {
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
  const fileNode = putNode(dir, { kind: 'file', key: path, hash: hash(source), snapshot });

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
    return { fresh: false, before: anchor.snapshot || '', hasBefore: Boolean(anchor.snapshot), after: '', reason: 'file no longer readable' };
  }

  if (anchor.kind === 'file') {
    return hash(source) === anchor.hash
      ? { fresh: true }
      : { fresh: false, before: anchor.snapshot || '', hasBefore: Boolean(anchor.snapshot), after: source, reason: 'file changed' };
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
 * A compact line diff.
 *
 * Deliberately not a full unified diff with hunks and context: the consumer is
 * a model deciding whether an existing conclusion still holds, and for that the
 * changed lines are the signal. Output is capped because an unbounded diff
 * injected alongside a finding would spend more tokens than re-deriving it.
 */
export function diffLines(before, after, { maxLines = 40 } = {}) {
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
  for (const line of removed.slice(0, maxLines / 2)) out.push('- ' + line);
  if (removed.length > maxLines / 2) out.push(`  ... ${removed.length - maxLines / 2} more removed`);
  for (const line of added.slice(0, maxLines / 2)) out.push('+ ' + line);
  if (added.length > maxLines / 2) out.push(`  ... ${added.length - maxLines / 2} more added`);

  return out.join('\n');
}

/**
 * Prepares findings for delivery, verifying each one lazily against disk.
 *
 * This is the only function that should ever hand a finding to a model, because
 * it is the one that enforces the rule: a stale finding leaves here carrying
 * `stale: true` AND a diff, or it does not leave at all.
 */
export function serve(graph, findings) {
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
    const anchors = graph.edges
      .filter((e) => e.edge === 'derived_from' && e.from === finding.id)
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
    if (!stale && finding.stale) {
      stale = true;
      diff = finding.diff || '';
      reason = finding.staleReason || 'marked stale when the change was observed';
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
      diff = `(marked stale: ${reason}. The supporting diff can no longer be `
        + 'reconstructed; the claim itself may well still hold, so weigh it rather '
        + 'than discard it)';
    }

    served.push({ ...finding, stale, ...(stale ? { diff, staleReason: reason } : {}) });
  }
  return served;
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

export { contentHash };
