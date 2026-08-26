// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/recall.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Does retrieval FIND a finding, or does it only find what it was told where
 * to look?
 *
 * `docs/WIKI_GRAPH.md` says embeddings get added "if measurement shows real
 * recall loss". Nothing measured recall, so the no-embeddings stance was
 * unfalsifiable -- a claim with no observation that could contradict it. This
 * module is the observation.
 *
 * ---------------------------------------------------------------------------
 * THE TAUTOLOGY THIS DELIBERATELY DOES NOT SHIP, AND WHY IT IS RECORDED HERE
 * ---------------------------------------------------------------------------
 * The obvious probe -- for each finding, take its anchors and ask whether
 * `findingsFor` returns it from each -- CANNOT FAIL. `findingsFor(graph, A)`
 * walks `derived_from` edges backwards into A, and the edge F -> A is the very
 * thing that makes A an anchor of F. So F is in the result by CONSTRUCTION, not
 * by retrieval quality, for every graph, forever. Its rate is 1.0 always, and a
 * permanent 1.0 published as a recall rate reads to a human as "retrieval is
 * perfect, embeddings unnecessary" -- one unfalsifiable claim swapped for
 * another, leaning the one direction a measurement of this project by this
 * project must never lean.
 *
 * That check is still worth running -- if it ever fails, traversal is broken
 * rather than merely lossy -- so it is kept, and reported as `integrity` with
 * its own `what` string saying it is not a recall rate. It is NEVER `rate`.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MEASURED INSTEAD: LEAVE-ONE-EDGE-OUT
 * ---------------------------------------------------------------------------
 * For each active finding F and each anchor A of F, delete the edge F -> A and
 * ask whether touching A would STILL surface F. Two independent arms, both of
 * which can genuinely miss, which is what makes this a measurement:
 *
 *   Arm A -- TRAVERSAL FROM THE NEIGHBOURHOOD. Run the real `findingsFor` over
 *   the edge-deleted graph from A itself and from A's `contains` parents. This
 *   hits only when F has some OTHER structural route in: a second anchor on the
 *   same file, or an anchor on a sibling symbol under the same parent. A's
 *   `contains` children need no separate call because `findingsFor` expands
 *   them itself -- calling the parent therefore covers every sibling, which is
 *   why the neighbour list is `[A, ...parents(A)]` and not a hop-counted
 *   frontier. The REAL primitive is used rather than an equivalent inlined
 *   here, because a probe that reimplements the thing it measures drifts from
 *   it and then measures itself.
 *
 *   Arm B -- BM25 FROM THE ANCHOR'S OWN KEY. Rank the whole active corpus with
 *   `lexical.rank`, querying with A's key -- the file path or symbol name the
 *   user actually touched -- and hit if F comes back inside `limit`.
 *
 * WHY ARM B IS NOT QUERIED WITH THE FINDING'S OWN CLAIM. The plan's literal
 * form was "the finding's claim terms against the rest of the corpus", and both
 * readings of it are degenerate. Querying F's claim against a corpus that
 * INCLUDES F is the tautology again: BM25 scores a document against its own
 * text, so F wins its own query every time. Querying F's claim against a corpus
 * that EXCLUDES F cannot return F at all, so a "hit" would mean some DIFFERENT
 * finding matched -- that is redundancy of storage, not recall of F, and it
 * would score a graph better for holding duplicates. The anchor's key is the
 * one query text that is available offline, is not derived from F, and matches
 * the production question: a session touches a file, and the only lexical
 * handle on it is its own path. It misses exactly when a finding's claim never
 * names the code it is about, which is the recall gap embeddings are supposed
 * to close.
 *
 * ---------------------------------------------------------------------------
 * REFUSALS -- four, and each costs this project its own good news
 * ---------------------------------------------------------------------------
 *  1. TOO FEW OBSERVATIONS -> `rate: null` with a reason. See `MIN_PROBED`.
 *  2. A CORPUS NO LARGER THAN THE RETRIEVAL LIMIT -> `rate: null`. Arm B is
 *     recall@`limit`, and below the limit NO FINDING IS EVER CUT FOR BUDGET:
 *     every document scoring above zero is returned, so the arm measures
 *     whether a token matched, which is a strictly weaker bar than the one
 *     production applies when `forTouch` fills a token budget from a ranked
 *     list. A probe more permissive than the system it measures can only
 *     overstate recall, so the rate is withheld in that band and the counts are
 *     published instead. It bites between `MIN_PROBED` and `limit` findings --
 *     on this machine's project graph, whose one finding had both anchor edges
 *     "recovered" that way, the observation-count refusal fires first.
 *  3. NO ANCHOR NODE -> the pair is UNPROBEABLE, not a miss. Reported and
 *     excluded from the denominator; see `probeEdge`.
 *  4. STRICT AGGREGATION -> a finding counts as retrieved only if EVERY one of
 *     its probeable anchor edges is recoverable. A finding reachable from one
 *     anchor and lost from another is a miss, with the losing anchor named.
 *     This biases the rate DOWN, which is the safe direction here.
 *
 * FAILS OPEN. It runs on a report path; a graph it cannot read must cost a
 * section, not the report.
 */

import { load, findingsFor } from './wiki.mjs';
import { rank } from './lexical.mjs';

/**
 * Distinct findings that must be probeable before a RATE is published at all.
 *
 * NOT AN EFFECT-SIZE CONVENTION -- it is a resolution argument. A proportion
 * over n observations has a resolution of 1/n, so below ten findings the
 * published figure moves in steps coarser than ten percentage points, and the
 * two extremes a small graph actually produces (`1.0` and `0.0`) are the two a
 * reader is most likely to mistake for a finding about retrieval. At n = 10 and
 * zero misses the exact binomial 95% upper bound on the true miss rate is still
 * 1 - 0.05^(1/10) = 0.26, so even a clean sweep here bounds recall loss only
 * below about a quarter -- which is why the refusal reason says what the number
 * would and would not have supported rather than just naming the floor.
 *
 * THE FLOOR IS ON DISTINCT FINDINGS, NOT ANCHOR EDGES. Two anchors of one
 * finding are two edges of the same claim, not two independent observations;
 * counting them would let a single multi-anchored finding unlock a rate.
 */
export const MIN_PROBED = 10;

/**
 * The most findings probed in one call.
 *
 * Each probed anchor edge costs a graph-sized edge filter plus one or two real
 * `findingsFor` walks plus one BM25 pass over the corpus, and this runs on the
 * on-demand report path. The cap is deterministic (findings sorted by key) and
 * `truncated` says when it bit, so a large graph gets a smaller, honestly
 * labelled sample rather than a slow report.
 */
export const MAX_FINDINGS = 200;

/** Active findings only. A retired claim is withdrawn; recalling it is not a win. */
function activeFindings(graph) {
  return [...graph.nodes.values()]
    .filter((node) => node && node.kind === 'finding' && !node.retired)
    .sort((a, b) => String(a.key || '').localeCompare(String(b.key || '')));
}

/** The `contains` parents of every node, indexed once for the whole probe. */
function parentIndex(graph) {
  const parents = new Map();
  for (const edge of graph.edges) {
    if (edge.edge !== 'contains') continue;
    const list = parents.get(edge.to);
    if (list) list.push(edge.from);
    else parents.set(edge.to, [edge.from]);
  }
  return parents;
}

/** The anchors of one finding: the targets of its own `derived_from` edges. */
function anchorsOf(graph, findingId) {
  const out = new Set();
  for (const edge of graph.edges) {
    if (edge.edge === 'derived_from' && edge.from === findingId) out.add(edge.to);
  }
  return [...out];
}

/**
 * The graph minus exactly one anchor edge.
 *
 * `nodes` is shared rather than copied: nothing here mutates it, and a
 * 2,600-node Map copied once per anchor edge is the difference between a probe
 * and a stall.
 */
function withoutAnchorEdge(graph, findingId, anchorId) {
  return {
    nodes: graph.nodes,
    edges: graph.edges.filter(
      (edge) =>
        !(
          edge.edge === 'derived_from' &&
          edge.from === findingId &&
          edge.to === anchorId
        )
    ),
  };
}

/**
 * One anchor edge, hidden, then asked after. Returns `recovered` with the arm
 * that found it, or a reason -- and `probeable: false` when the question could
 * not be put at all.
 */
function probeEdge(graph, parents, finding, anchorId, corpus, limit) {
  const hidden = withoutAnchorEdge(graph, finding.id, anchorId);

  // Arm A. `findingsFor` expands `contains` children itself, so the parent call
  // covers every sibling of the anchor.
  const neighbours = [anchorId, ...(parents.get(anchorId) || [])];
  for (const neighbour of neighbours) {
    const got = findingsFor(hidden, neighbour, { limit });
    if (got.some((node) => node.id === finding.id)) {
      return { recovered: true, arm: 'traversal', anchorId };
    }
  }

  // Arm B needs a query, and the query is the anchor's own key. A dangling
  // anchor edge -- an edge whose target node was never indexed, which
  // `expand.promote` produces -- leaves nothing to query with. That is a
  // question that could not be asked, NOT an observed miss: scoring it a miss
  // would manufacture a recall loss out of a graph-integrity defect.
  const anchor = graph.nodes.get(anchorId);
  const key = anchor && typeof anchor.key === 'string' ? anchor.key : '';
  if (!key) {
    return {
      recovered: false,
      probeable: false,
      anchorId,
      reason: `anchor ${anchorId} has no node in the graph, so there is no anchor key to query BM25 with`,
    };
  }

  const hits = rank(key, corpus, { limit });
  if (hits.some((hit) => hit.finding && hit.finding.id === finding.id)) {
    return { recovered: true, arm: 'lexical', anchorId };
  }

  return {
    recovered: false,
    probeable: true,
    anchorId,
    reason: `no neighbouring anchor reaches it and BM25 over ${key} does not rank it in the top ${limit}`,
  };
}

/**
 * The probe. An OFFLINE measurement over the graph as it stands -- it reads,
 * ranks and traverses, and writes nothing.
 */
export function recallProbe(
  dir,
  {
    limit = 20,
    graph = null,
    minProbed = MIN_PROBED,
    maxFindings = MAX_FINDINGS,
  } = {}
) {
  const refuse = (reason) => ({
    basis: 'offline probe over the current graph',
    probed: 0,
    retrieved: 0,
    rate: null,
    reason,
    misses: [],
    unprobeable: [],
  });

  let g;
  try {
    g = graph || load(dir);
  } catch {
    return refuse('the graph could not be read, so recall was not measured.');
  }

  try {
    const all = activeFindings(g);
    const truncated = all.length > maxFindings;
    const findings = truncated ? all.slice(0, maxFindings) : all;
    const parents = parentIndex(g);
    // The corpus BM25 ranks over is the ACTIVE graph, uncapped: the sample is
    // which findings are probed, not what they compete against. Every reported
    // figure below reads `corpus.length` rather than `all.length`, so the
    // published size IS the ranking corpus rather than a parallel claim about
    // it. The distinction is not pedantry: a mutation that shrank the ranking
    // corpus to the probed sample -- making retrieval easier, in this project's
    // favour -- SURVIVED the first mutation run precisely because the reported
    // number came from the other variable and could not move.
    const corpus = all;

    const misses = [];
    const unprobeable = [];
    const integrityFailures = [];
    let probed = 0;
    let retrieved = 0;
    let integrityOk = 0;
    let probedEdges = 0;
    let recoveredEdges = 0;
    const byArm = { traversal: 0, lexical: 0 };

    for (const finding of findings) {
      const anchors = anchorsOf(g, finding.id);

      // INTEGRITY, run on the UNTOUCHED graph: the by-construction check. Its
      // only honest use is as a smoke test, and it is reported as one.
      if (!anchors.length) {
        integrityFailures.push({
          key: finding.key,
          reason:
            'active finding with no anchor -- writeHarvested refuses to create one',
        });
      } else if (
        anchors.every((anchorId) =>
          findingsFor(g, anchorId, { limit }).some((node) => node.id === finding.id)
        )
      ) {
        integrityOk += 1;
      } else {
        integrityFailures.push({
          key: finding.key,
          reason: `not returned by findingsFor from one of its own anchors at limit ${limit}`,
        });
      }

      // An unanchored finding is a definite miss, not an unaskable question:
      // nothing traverses to it and there is no anchor key to query from, so
      // the anchor-driven path that serves findings on a file touch can never
      // surface it. Only an explicit wiki_query naming its own terms would.
      if (!anchors.length) {
        probed += 1;
        misses.push({
          key: finding.key,
          reason:
            'no anchor: nothing traverses to it and there is no anchor key to query with, so only an explicit wiki_query of its own terms would surface it',
        });
        continue;
      }

      const results = anchors.map((anchorId) =>
        probeEdge(g, parents, finding, anchorId, corpus, limit)
      );
      const askable = results.filter((result) => result.probeable !== false);
      probedEdges += askable.length;
      recoveredEdges += askable.filter((result) => result.recovered).length;
      for (const result of askable) {
        if (result.recovered) byArm[result.arm] += 1;
      }

      if (!askable.length) {
        unprobeable.push({ key: finding.key, reason: results[0].reason });
        continue;
      }

      probed += 1;
      const lost = askable.filter((result) => !result.recovered);
      if (!lost.length) retrieved += 1;
      else misses.push({ key: finding.key, reason: lost[0].reason });
    }

    const integrity = {
      what:
        'BY CONSTRUCTION: a finding is returned by findingsFor from its own anchor because that edge is what makes it an anchor. Expected 1 for every graph. NOT a recall rate.',
      probed: findings.length,
      retrieved: integrityOk,
      rate: findings.length ? integrityOk / findings.length : null,
      ok: integrityFailures.length === 0,
      failures: integrityFailures,
    };

    // Arm B is recall@`limit`. Over a corpus of at most `limit` findings nothing
    // is ever cut for budget, so the arm asks only whether a token matched --
    // weaker than the bar production applies under a token budget, and a probe
    // more permissive than the system it measures can only overstate recall.
    const discriminating = corpus.length > limit;

    const common = {
      basis: 'offline probe over the current graph',
      probed,
      retrieved,
      misses,
      unprobeable,
      probedEdges,
      recoveredEdges,
      byArm,
      corpus: corpus.length,
      discriminating,
      truncated,
      minProbed,
      integrity,
    };

    if (probed < minProbed) {
      return {
        ...common,
        rate: null,
        reason:
          probed === 0
            ? `no probeable finding: ${unprobeable.length} of ${findings.length} active finding(s) have no anchor node to query from, so recall was not measured. No rate is reported, which is not the same as a rate of zero.`
            : `${probed} probeable finding(s), below the floor of ${minProbed}: a proportion over ${probed} has a resolution of ${Math.round(
                100 / probed
              )} percentage points, so no rate is published. ${retrieved} of ${probed} were recovered without their own anchor edge, which is a count and not a rate.`,
      };
    }

    if (!discriminating) {
      return {
        ...common,
        rate: null,
        reason: `the active corpus holds ${corpus.length} finding(s) and the retrieval limit is ${limit}, so nothing is ever cut for budget and the lexical arm asks only whether a token matched -- a weaker bar than production applies. No rate is published off a probe more permissive than the system it measures; ${retrieved} of ${probed} were recovered, which is a count and not a rate.`,
      };
    }

    return { ...common, rate: retrieved / probed, reason: null };
  } catch {
    return refuse('the probe failed, so recall was not measured.');
  }
}
