/**
 * Evidence-aware retrieval economics.
 *
 * Relevance alone is not enough: a true finding can still cost more context
 * than it saves.  Every candidate receives a conservative expected-benefit
 * estimate, its delivery cost and risk are subtracted, and harmful findings
 * are quarantined from automatic delivery while remaining visible for audit.
 */

import { readEvidence } from './metrics.mjs';

const DAY = 86_400_000;
const ORIGIN_WEIGHT = { human: 1.2, agent: 1.08, harvested: 1 };

const envNumber = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const retrievalPolicy = () => ({
  baseBenefitTokens: envNumber('TOKEN_OPTIMIZER_EXPECTED_BENEFIT_TOKENS', 400),
  minimumNetUtility: envNumber('TOKEN_OPTIMIZER_MIN_EXPECTED_UTILITY', 20),
  cooldownMs: envNumber('TOKEN_OPTIMIZER_INJECTION_COOLDOWN_MS', 60_000),
  quarantineHarmCount: Math.max(1, envNumber('TOKEN_OPTIMIZER_QUARANTINE_HARM_COUNT', 2)),
});

function feedbackFor(events, key) {
  return events.filter((event) =>
    event.kind === 'finding-feedback'
    && (event.findingId === key || (event.findingIds || []).includes(key))
  );
}

function outcomesFor(events, key) {
  return events.filter((event) =>
    event.kind === 'tool-outcome' && (event.findingIds || []).includes(key)
  );
}

function deliveredRecently(events, key, episodeId, now, cooldownMs) {
  if (!episodeId || cooldownMs <= 0) return false;
  return events.some((event) =>
    event.kind === 'inject'
    && event.episodeId === episodeId
    && (event.findingIds || []).includes(key)
    && !event.holdout
    && now - (event.at || 0) < cooldownMs
  );
}

/**
 * Returns eligible candidates in utility order plus every rejection reason.
 * `costFor` is supplied by inject.mjs so the gate prices the exact rendered
 * text rather than a second approximation that could drift.
 */
export function assessFindings(
  dir,
  findings,
  {
    relevanceFor = () => 1,
    costFor = () => 0,
    episodeId = null,
    now = Date.now(),
    policy = retrievalPolicy(),
  } = {}
) {
  const events = readEvidence(dir);
  const eligible = [];
  const rejected = [];

  for (const finding of findings) {
    const key = finding.key;
    const feedback = feedbackFor(events, key);
    const outcomes = outcomesFor(events, key);
    const helpful = feedback.filter((event) => event.rating === 'helpful').length;
    const neutral = feedback.filter((event) => event.rating === 'neutral').length;
    const harmful = feedback.filter((event) => event.rating === 'harmful').length;
    const successfulUses = outcomes.filter((event) => event.success === true).length;
    const failedUses = outcomes.filter((event) => event.success === false).length;

    if (harmful >= policy.quarantineHarmCount && harmful >= helpful + neutral) {
      rejected.push({ key, reason: 'quarantined-harm', helpful, neutral, harmful });
      continue;
    }
    if (deliveredRecently(events, key, episodeId, now, policy.cooldownMs)) {
      rejected.push({ key, reason: 'cooldown' });
      continue;
    }

    const confidence = Number.isFinite(finding.confidence) ? finding.confidence : 0.5;
    const relevance = Math.max(0, Math.min(1, Number(relevanceFor(finding)) || 0));
    const ageDays = Math.max(0, (now - (finding.at || now)) / DAY);
    const recency = finding.pinned ? 1 : Math.pow(0.5, ageDays / 90);
    const provenance = ORIGIN_WEIGHT[finding.origin] || 1;
    // Outcome evidence moves the estimate gradually. Explicit harmful feedback
    // is handled above; a failed command alone is not labelled harmful because
    // the model may have ignored correct advice.
    const observed = successfulUses + failedUses;
    const successFactor = observed
      ? 0.75 + 0.5 * (successfulUses / observed)
      : 1;
    const feedbackFactor = Math.max(0.25, 1 + helpful * 0.12 - harmful * 0.35);
    const expectedBenefit =
      policy.baseBenefitTokens * confidence * relevance * recency * provenance * successFactor * feedbackFactor;
    const deliveryCost = Math.max(0, Number(costFor(finding)) || 0);
    const riskPenalty =
      (finding.stale ? 160 : 0)
      + (finding.confidenceLabel === 'speculative' ? 100 : 0)
      + harmful * 100;
    const netUtility = expectedBenefit - deliveryCost - riskPenalty;

    const assessed = {
      finding,
      expectedBenefit,
      deliveryCost,
      riskPenalty,
      netUtility,
      helpful,
      neutral,
      harmful,
      successfulUses,
      failedUses,
    };
    if (netUtility < policy.minimumNetUtility) {
      rejected.push({ key, reason: 'negative-expected-value', ...assessed, finding: undefined });
      continue;
    }
    eligible.push(assessed);
  }

  eligible.sort((a, b) => b.netUtility - a.netUtility);
  return { eligible, rejected };
}
