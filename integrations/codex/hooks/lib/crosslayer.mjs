// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/crosslayer.mjs. Regenerate with `npm run sync:hooks`.
/**
 * The calibration loop: does Layer 1's LABEL predict Layer 2's EFFECT?
 *
 * Layer 1 (`usage.mjs`) classifies an injected finding by whether the model
 * later NAMED it. Layer 2 (`loo.mjs`) measures, by leave-one-out, how many
 * tokens of reading a finding actually SUPPRESSED. Those are two different
 * quantities, and the whole point of putting them side by side is that the
 * cheap one (a label, available on every injection) might stand in for the
 * expensive one (a causal effect, costing three withheld sessions per finding).
 *
 * WHY THIS IS A REAL QUESTION AND NOT A TAUTOLOGY. Task 7 established the
 * independence three ways -- statically (`loo.mjs` contains no `query` or
 * `reference`; `usage.mjs` contains no `tokens`, `cost` or `bytes`),
 * behaviourally in both directions, and by naming the one overlap that does
 * exist (`recordToolOutcome`'s join, which supplies ATTRIBUTABILITY to both and
 * the measured quantity to neither). This module is built to preserve that:
 *
 *   - from Layer 1 it takes ONLY the categorical label per finding key. No
 *     rate, no count, no magnitude -- Layer 1 has no magnitude to give.
 *   - from Layer 2 it takes ONLY the effect magnitude per finding key.
 *   - the join is the finding key, which is a graph identity and not a
 *     measurement.
 *
 * If a magnitude common to both ever entered, this would correlate a quantity
 * with itself and report a strong result that means nothing. Two tests pin the
 * separation from opposite sides: flipping the labels while holding the effects
 * fixed must move the gap, and changing Layer 1's rate WITHOUT changing any
 * label must leave the gap byte-identical.
 *
 * MEASURED UTILITY RANKS A FINDING. IT MUST NEVER RAISE ITS CONFIDENCE.
 * A confidently WRONG finding suppresses reads better than a hedged true one,
 * so utility alone optimises directly against "wrong findings are worse than
 * none". The plan called for a `mayPromote` gate over
 * `hasOutstandingContradiction` here. There is nothing to gate: every write of
 * `confidence` in `hooks-core` happens at CREATION (a per-producer constant in
 * `derive.mjs` / `lessons.mjs` / `harvest.mjs`, or a human's own number in
 * `curate.mjs`), and no code path updates a stored finding's confidence
 * afterwards. `assessFindings` in `utility.mjs` READS confidence into an
 * ephemeral `netUtility` used for ordering and writes nothing back. So a gate
 * here would be unreachable, and an unreachable gate is the exact defect class
 * this work exists to close. `hasOutstandingContradiction` already has its
 * real consumer -- `staleness.mjs` calls it as the dispute gate on serve.
 * What is enforceable is the invariant itself, and it is: this module never
 * writes to the graph, and `tests/hooks/calibration-loop.test.mjs` asserts that
 * neither it nor either layer under it can move a stored confidence.
 *
 * NOTHING HERE IS PRICED. A calibration verdict, a holdout estimate and a
 * consolidation ratio are all estimates; currency belongs only on a measured
 * counterfactual, and `balanceSheet`'s `measuredCounterfactual` is the one
 * section in the sheet below that qualifies.
 */

import { readMetrics, readTruncation, balanceSheet } from './metrics.mjs';
import { classify, referenceRate } from './usage.mjs';
import {
  effects,
  observations,
  servingPolicyVersion,
  permutationP,
  FDR_Q,
} from './loo.mjs';
import { consolidationRatio, aggregateConsolidation } from './consolidate.mjs';
import { recallProbe } from './recall.mjs';
import { load } from './wiki.mjs';

/**
 * Distinct findings needed in EACH arm before a gap is reported at all.
 *
 * Two findings per arm is a difference of two numbers; the comparison would be
 * dominated by whichever finding happened to sit on a big file. Three is still
 * small, and the refusal says so rather than implying the gap is solid.
 */
export const MIN_FINDINGS_PER_ARM = 3;

/**
 * The smallest gap that may be PUBLISHED, in tokens per touch.
 *
 * Not an effect-size convention: it is tied to the unit the verdict prints. The
 * published sentence rounds the gap to whole tokens, so a gap of 1e-13 -- which
 * is what two arms of equal means produce once floating point has had its say --
 * would publish as "referenced findings suppress 0 more tokens/touch". That is a
 * calibration claim resting on arithmetic noise, and it leans the only direction
 * a measurement of this project by this project must never lean.
 */
export const MIN_GAP_TOKENS = 1;

/**
 * The per-finding Layer 1 label, folded from per-injection rows.
 *
 * ANY reference wins. `classify` emits one row per (injection, finding) because
 * one reference must not excuse every later injection -- that is the right unit
 * for a RATE. For a label the question is different: did the model ever name
 * this finding? A finding referenced once and ignored nine times is a finding
 * the model reads, and averaging it into `not-referenced` would put it in the
 * arm whose mean effect it is meant to predict.
 *
 * `unknown` rows are dropped rather than defaulted, exactly as Layer 1 drops
 * them from its own denominator.
 */
export function labelsByFinding(rows) {
  const labels = new Map();
  for (const row of rows || []) {
    const key = row?.findingKey;
    if (typeof key !== 'string' || !key) continue;
    if (row.label === 'referenced') labels.set(key, 'referenced');
    else if (row.label === 'not-referenced' && !labels.has(key))
      labels.set(key, 'not-referenced');
  }
  return labels;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * A deterministic, label-symmetric permutation test for the headline gap.
 *
 * Layer 2 only publishes a per-finding row after a two-sided permutation test.
 * The calibration headline summarises those rows, so a positive difference of
 * arm means must clear the same evidential bar rather than being promoted just
 * because it points in this project's favour.
 *
 * Sorting within each arm and then sorting the two arms makes the sampled path
 * invariant to event order and to swapping the labels. The seed is derived
 * from that canonical data instead of shared globally, so two different
 * datasets do not reuse one arbitrary sequence of sampled relabellings.
 */
export function calibrationP(referenced, notReferenced) {
  const arms = [referenced, notReferenced]
    .map((values) => [...values].sort((a, b) => a - b))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const encoded = JSON.stringify(arms);
  let seed = 2166136261;
  for (const char of encoded) {
    seed ^= char.charCodeAt(0);
    seed = Math.imul(seed, 16777619);
  }
  return permutationP(arms[0], arms[1], { seed: seed >>> 0 });
}

/**
 * Does Layer 1's label predict Layer 2's effect?
 *
 * Returns `publishable`, a `verdict` in English, and `gap` ONLY when a gap was
 * actually computed. There is no `gap: 0` for the unmeasured case, and that is
 * deliberate: a permanent zero reads as "measured, and the two agree", which is
 * the opposite of "nothing was measured". Task 7 deleted a field rather than
 * zero it for the same reason.
 *
 * FAILS OPEN. This runs on report paths that must not break a tool call.
 */
export function calibration(dir, options = {}) {
  const refuse = (verdict, extra = {}) => ({
    publishable: false,
    verdict,
    ...extra,
  });

  try {
    // ONE READ for both layers, so the two arms of the comparison cannot cover
    // different spans of the log. `referenceRate` reports `windowed: false`
    // when the caller supplies events -- correctly, since the bounds are then
    // the caller's -- so the truncation flag is taken here, from the read that
    // actually set it, and republished.
    const supplied = options.events || null;
    const events = supplied || readMetrics(dir);
    const truncation = supplied ? null : readTruncation();
    const truncated = Boolean(
      truncation && (truncation.byBytes || truncation.byEvents)
    );

    const layer1 = referenceRate(dir, { events });
    const labels = labelsByFinding(classify(dir, { events }));

    const obs = observations(dir, { ...options, events });
    const rows = effects(dir, { ...options, events, obs });

    // ONE POLICY VERSION. Layer 2 refuses to pool arms across serving
    // policies; a calibration that pooled them would undo that guard one level
    // up. Rows from any other policy are excluded and counted.
    const policy = servingPolicyVersion();
    const inPolicy = rows.filter((row) => row.policy === policy);

    const layer2 = {
      rows: rows.length,
      inPolicy: inPolicy.length,
      published: rows.filter((row) => row.published).length,
      observations: obs.rows.length,
      policy,
    };
    const l1 = {
      referenced: layer1.referenced,
      notReferenced: layer1.notReferenced,
      unknown: layer1.unknown,
      denominator: layer1.denominator,
      rate: layer1.rate,
      referenceEvents: layer1.referenceEvents,
    };

    const excluded = { layer1Unknown: layer1.unknown, unlabelled: 0, noEffect: 0 };
    const arms = { referenced: [], notReferenced: [] };
    for (const row of inPolicy) {
      // THE SHRUNK ESTIMATE, not the raw one. Shrinkage pulls every finding
      // toward the population mean, so it pulls the GAP toward zero -- the
      // bias runs against publishing, which is the only direction a
      // measurement of this project by this project may lean.
      if (row.shrunk === null || !Number.isFinite(row.shrunk)) {
        excluded.noEffect += 1;
        continue;
      }
      const label = labels.get(row.findingKey);
      if (label === 'referenced') arms.referenced.push(row.shrunk);
      else if (label === 'not-referenced') arms.notReferenced.push(row.shrunk);
      else excluded.unlabelled += 1;
    }

    const context = { layer1: l1, layer2, arms: { referenced: arms.referenced.length, notReferenced: arms.notReferenced.length }, excluded, windowed: truncated };
    const caveat = truncated
      ? ' The event log was truncated, so both sides can understate.'
      : '';

    // WHICH INPUT WAS INSUFFICIENT, named. "Not enough data" tells a reader
    // nothing about which half of the loop to go and fix.
    const l1Silent = layer1.rate === null;
    const l2Silent = layer2.observations === 0;
    if (l1Silent || l2Silent) {
      const why = [];
      if (l1Silent)
        why.push(
          `Layer 1 has ${layer1.denominator} classifiable observation(s) and ` +
            `${layer1.referenceEvents} reference event(s), so it publishes no rate`
        );
      if (l2Silent)
        why.push(
          `Layer 2 has ${layer2.observations} observation(s), so it publishes no effect`
        );
      return refuse(
        `not calibrated: ${why.join('; and ')}. No gap is reported, which is not the same as a gap of zero.${caveat}`,
        context
      );
    }

    // A POLICY CHANGE RESETS THE CALIBRATION, and says so rather than reporting
    // an empty arm. Layer 2 refuses to pool arms across serving policies, so
    // rows generated under an older one cannot answer a question about how the
    // graph serves findings today -- but "0 findings per arm" would send a
    // reader hunting for missing observations that are right there in the log.
    if (rows.length > 0 && inPolicy.length === 0)
      return refuse(
        `not calibrated: all ${rows.length} Layer 2 effect row(s) were measured under a different serving ` +
          `policy than the current ${policy}, and arms are never pooled across policies. ` +
          `No gap is reported, which is not the same as a gap of zero.${caveat}`,
        context
      );

    if (layer2.published === 0)
      return refuse(
        `not calibrated: Layer 2 has ${layer2.observations} observation(s) but no published effect at q=0.1, ` +
          'so its per-finding numbers are noise and a difference between two means of them would be too. ' +
          `No gap is reported, which is not the same as a gap of zero.${caveat}`,
        context
      );

    if (
      arms.referenced.length < MIN_FINDINGS_PER_ARM ||
      arms.notReferenced.length < MIN_FINDINGS_PER_ARM
    )
      return refuse(
        `not calibrated: ${arms.referenced.length} referenced and ${arms.notReferenced.length} not-referenced ` +
          `finding(s) carry a Layer 2 effect, below the floor of ${MIN_FINDINGS_PER_ARM} per arm. ` +
          `No gap is reported, which is not the same as a gap of zero.${caveat}`,
        context
      );

    const referencedMean = mean(arms.referenced);
    const notReferencedMean = mean(arms.notReferenced);
    const gap = referencedMean - notReferencedMean;
    const p = calibrationP(arms.referenced, arms.notReferenced);
    const measured = {
      ...context,
      gap,
      referencedMean,
      notReferencedMean,
      p,
      alpha: FDR_Q,
      test: 'two-sided permutation',
    };

    if (!(gap >= MIN_GAP_TOKENS))
      return refuse(
        `uncalibrated: Layer 1's "referenced" label does not predict a larger Layer 2 effect ` +
          `(referenced ${Math.round(referencedMean).toLocaleString()} vs not-referenced ` +
          `${Math.round(notReferencedMean).toLocaleString()} tokens/touch, gap ${Math.round(gap).toLocaleString()}). ` +
          `Do not quote the reference rate as a saving.${caveat}`,
        measured
      );

    if (p === null || p > FDR_Q)
      return refuse(
        `not calibrated: the positive Layer 1/Layer 2 gap is not statistically resolved by the ` +
          `two-sided permutation test (p=${p === null ? 'unavailable' : p.toFixed(3)}, ` +
          `alpha=${FDR_Q.toFixed(3)}). Do not quote the reference rate as a saving.${caveat}`,
        measured
      );

    return {
      publishable: true,
      verdict:
        `calibrated: referenced findings suppress ${Math.round(gap).toLocaleString()} more tokens/touch ` +
        `than unreferenced ones (${arms.referenced.length} vs ${arms.notReferenced.length} findings, ` +
        `shrunk estimates, two-sided permutation p=${p.toFixed(3)}). ` +
        `The reference rate is a usable proxy for causal value at this sample size.${caveat}`,
      ...measured,
    };
  } catch {
    return refuse(
      'not calibrated: the calibration inputs could not be read. No gap is reported, which is not the same as a gap of zero.'
    );
  }
}

/**
 * What the graph cost to build against what it carries -- AN ESTIMATE, and
 * never priced.
 *
 * `consolidationRatio` is the per-finding form and the aggregate is the fold.
 * Both need `derivedCost`, which `expand.promote` persists onto the finding
 * node it creates (`src/server/disclosure.ts` is its caller) and which
 * `harvest-write.mjs` does not yet carry through -- so a graph built only by
 * the harvest reports nothing here rather than a ratio of one.
 */
export function consolidation(dir, { graph = null } = {}) {
  try {
    const g = graph || load(dir);
    const findings = [...g.nodes.values()].filter(
      (node) => node.kind === 'finding' && !node.retired
    );
    const rated = [];
    for (const finding of findings) {
      const ratio = consolidationRatio(finding);
      if (ratio === null) continue;
      rated.push({ key: finding.key, ratio, derivedCost: finding.derivedCost });
    }
    const aggregate = aggregateConsolidation(findings);
    return {
      what: 'cost to derive against cost to carry',
      // SAID IN THE DATA, not only in the prose above it, because this is the
      // field a dashboard will read and a dashboard will not read a comment.
      basis: 'estimate',
      priced: false,
      findings: findings.length,
      withDerivedCost: rated.length,
      aggregate,
      best: rated.sort((a, b) => b.ratio - a.ratio).slice(0, 5),
    };
  } catch {
    return null;
  }
}

/**
 * The balance sheet with the graph's own measurements attached.
 *
 * `balanceSheet` lives in `metrics.mjs`, which every one of these modules
 * imports, so it cannot import them back. This is where the two meet, and it
 * is the shape `get_optimization_report` serves.
 *
 * `recall` joins them as an OFFLINE PROBE, and that label travels in the data
 * (`recall.basis`) as well as in the rendered line. It is not an observation of
 * anything a session did: it deletes an anchor edge in memory and re-runs the
 * real retrieval primitives over the graph as it stands right now. `recall.mjs`
 * imports only `wiki.mjs` and `lexical.mjs`, neither of which imports anything
 * in this direction, so no cycle -- the same reason `calibration` had to live
 * here rather than in `metrics.mjs`.
 */
export function graphBalanceSheet(dir, options = {}) {
  const sheet = balanceSheet(dir);
  const cal = calibration(dir, options);
  const { layer1 = null, layer2 = null } = cal;
  return {
    ...sheet,
    layer1,
    layer2,
    calibration: cal,
    consolidation: consolidation(dir, options),
    recall: recallProbe(dir, options),
  };
}

/**
 * One audit line, or null when there is nothing honest to say.
 *
 * Silent when NEITHER layer has produced anything: a reader of a graph that has
 * never injected a finding is owed no paragraph about a loop that has not
 * started. The moment either side speaks, the refusal is worth printing --
 * because at that point a reader could otherwise take Layer 1's rate for a
 * saving, which is precisely what this loop exists to stop.
 */
export function calibrationNote(dir, options = {}) {
  try {
    const result = calibration(dir, options);
    const l1 = result.layer1;
    const l2 = result.layer2;
    if (!l1 || !l2) return null;
    if (l1.denominator === 0 && l2.observations === 0) return null;
    return `Layer 1 against Layer 2: ${result.verdict}`;
  } catch {
    return null;
  }
}
