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

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { putNode, putEdge, contentHash } from './wiki.mjs';
import { extractSymbols, spanText, symbolKey } from './symbols.mjs';

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
 * Records a file and the symbols inside it as nodes, each carrying a snapshot
 * of its own text.
 *
 * Snapshotting the SPAN rather than the whole file is what keeps storage
 * bounded: only regions that findings actually anchor to are stored, and a
 * function is orders of magnitude smaller than the file containing it.
 */
export function indexFile(dir, path, text) {
  const source = text ?? (() => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
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

  for (const symbol of extractSymbols(path, source)) {
    const body = spanText(source, symbol);
    const symbolNode = putNode(dir, {
      kind: 'symbol',
      key: symbolKey(path, symbol.name),
      name: symbol.name,
      file: path,
      line: symbol.line,
      endLine: symbol.endLine,
      hash: hash(body),
      snapshot: body,
    });
    putEdge(dir, fileNode, 'contains', symbolNode);
  }
  return fileNode;
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
    source = readFileSync(path, 'utf8');
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

  for (const finding of findings) {
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
      // The invariant. Rather than serve a bare stale finding -- which the
      // design calls worse than no graph -- say plainly that the evidence is
      // gone, so the model treats the claim as unverified rather than current.
      diff = '(the change could not be reconstructed; treat this finding as unverified)';
    }

    served.push({ ...finding, stale, ...(stale ? { diff, staleReason: reason } : {}) });
  }
  return served;
}

/**
 * The eager path: our hook saw a write, so mark dependent findings now and
 * record the diff while both sides are still in hand.
 */
export function invalidateOnWrite(dir, graph, path, beforeText, afterText) {
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
