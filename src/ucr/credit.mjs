import { sha256 } from './protocol.mjs';

export const OUTCOME_PRIORITY = Object.freeze([
  'correct',
  'severeHarm',
  'harm',
  'mistakeExecuted',
  'firstPass',
  'toolCalls',
  'latencyMs',
  'tokens',
  'costUsd',
]);

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function interval(values) {
  if (!values.length) return { mean: null, low: null, high: null, samples: 0 };
  const average = mean(values);
  if (values.length === 1)
    return { mean: average, low: null, high: null, samples: 1 };
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    (values.length - 1);
  const margin = 1.96 * Math.sqrt(variance / values.length);
  return {
    mean: average,
    low: average - margin,
    high: average + margin,
    samples: values.length,
  };
}

export function outcomeVerdict(outcome, baseline = null) {
  if (outcome?.correct !== true)
    return outcome?.severeHarm ? 'harmful' : 'failed';
  if (outcome.severeHarm || outcome.harm) return 'harmful';
  if (baseline?.correct === true) {
    if (
      (outcome.mistakeExecuted ?? false) &&
      !(baseline.mistakeExecuted ?? false)
    )
      return 'failed';
    if (
      numeric(outcome.tokens) !== null &&
      numeric(baseline.tokens) !== null &&
      outcome.tokens < baseline.tokens
    )
      return 'improved';
  }
  return 'correct';
}

export function exactEpisodeJoin(events, episodeId) {
  const episode = events.filter((event) => event.episodeId === episodeId);
  const candidates = episode.filter((event) => event.kind === 'candidate');
  const deliveries = episode.filter((event) => event.kind === 'delivery');
  const guards = episode.filter((event) => event.kind === 'guard');
  const actions = episode.filter((event) => event.kind === 'action');
  const outcomes = episode.filter((event) => event.kind === 'outcome');
  const diagnostics = [];
  const byDelivery = new Map(
    deliveries.map((event) => [event.deliveryId, event])
  );
  const byCandidate = new Map(
    candidates.filter((event) => event.candidateId).map((event) => [event.candidateId, event])
  );
  const byAction = new Map(actions.map((event) => [event.actionId, event]));
  for (const action of actions) {
    if (action.deliveryId && !byDelivery.has(action.deliveryId))
      diagnostics.push(`action ${action.actionId} has no delivery`);
  }
  for (const delivery of deliveries) {
    if (
      delivery.candidateIds?.some((candidateId) => !byCandidate.has(candidateId))
    )
      diagnostics.push(`delivery ${delivery.deliveryId} has no candidate`);
  }
  for (const outcome of outcomes) {
    if (!outcome.actionId || !byAction.has(outcome.actionId))
      diagnostics.push(`outcome ${outcome.outcomeId} has no action`);
    if (!outcome.graderId)
      diagnostics.push(
        `outcome ${outcome.outcomeId} has no deterministic grader`
      );
  }
  const objectDeliveries = new Map();
  for (const delivery of deliveries) {
    for (const objectId of delivery.objectIds || []) {
      if (!objectDeliveries.has(objectId)) objectDeliveries.set(objectId, []);
      objectDeliveries.get(objectId).push(delivery.deliveryId);
    }
  }
  const confounded = [...objectDeliveries.entries()].filter(
    ([, ids]) => ids.length > 1
  );
  if (confounded.length)
    diagnostics.push('objects were delivered more than once in one episode');
  const untrackedConfounders = episode.filter(
    (event) => event.kind === 'confounder' && event.controlled !== true
  );
  if (untrackedConfounders.length)
    diagnostics.push('episode contains uncontrolled confounders');
  return {
    valid: diagnostics.length === 0 && outcomes.length > 0,
    diagnostics,
    candidates,
    deliveries,
    guards,
    actions,
    outcomes,
    confounders: episode.filter((event) => event.kind === 'confounder'),
    joinHash: sha256({
      episodeId,
      candidates,
      deliveries,
      guards,
      actions,
      outcomes,
    }),
  };
}

export function ablationEffect(rows, objectId, field = 'correct') {
  const pairs = new Map();
  for (const row of rows.filter((item) => item.objectId === objectId)) {
    if (!row.pairId || !['included', 'ablated'].includes(row.variant)) continue;
    if (!pairs.has(row.pairId)) pairs.set(row.pairId, {});
    pairs.get(row.pairId)[row.variant] = row;
  }
  const deltas = [...pairs.values()]
    .filter((pair) => pair.included && pair.ablated)
    .map((pair) => Number(pair.included[field]) - Number(pair.ablated[field]))
    .filter(Number.isFinite);
  return {
    objectId,
    field,
    pairs: deltas.length,
    ...interval(deltas),
    attributable: deltas.length >= 5 && interval(deltas).low > 0,
  };
}

export function quarantineLatency(events, objectId) {
  const harmful = events.find(
    (event) => event.objectId === objectId && event.severeHarm === true
  );
  const quarantine = events.find(
    (event) =>
      event.objectId === objectId &&
      event.kind === 'quarantine' &&
      (!harmful || event.at >= harmful.at)
  );
  return {
    objectId,
    detectedAt: harmful?.at ?? null,
    quarantinedAt: quarantine?.at ?? null,
    latencyMs:
      harmful && quarantine ? Math.max(0, quarantine.at - harmful.at) : null,
    beforeNextDelivery:
      Boolean(harmful && quarantine) &&
      !events.some(
        (event) =>
          event.objectId === objectId &&
          event.kind === 'delivery' &&
          event.at > harmful.at &&
          event.at < quarantine.at
      ),
  };
}

export class CreditLedger {
  constructor({ lesserHarmThreshold = 3 } = {}) {
    this.observations = [];
    this.quarantine = new Map();
    this.lesserHarmThreshold = lesserHarmThreshold;
    this.appeals = [];
  }

  record({ objectId, context, outcome, baseline = null, join }) {
    if (!join?.valid)
      return {
        recorded: false,
        diagnostics: join?.diagnostics || ['invalid causal join'],
      };
    const verdict = outcomeVerdict(outcome, baseline);
    const observation = {
      objectId,
      context,
      outcome,
      baseline,
      verdict,
      effect: {
        correct:
          Number(Boolean(outcome.correct)) - Number(Boolean(baseline?.correct)),
        mistakeExecuted:
          Number(Boolean(baseline?.mistakeExecuted)) -
          Number(Boolean(outcome.mistakeExecuted)),
        tokens:
          numeric(baseline?.tokens) !== null && numeric(outcome.tokens) !== null
            ? baseline.tokens - outcome.tokens
            : null,
      },
      joinHash: join.joinHash,
      at: Date.now(),
    };
    this.observations.push(observation);
    const mine = this.observations.filter((item) => item.objectId === objectId);
    const lesser = mine.filter((item) => item.verdict === 'harmful').length;
    if (outcome.severeHarm === true || lesser >= this.lesserHarmThreshold) {
      this.quarantine.set(objectId, {
        objectId,
        at: observation.at,
        reason: outcome.severeHarm
          ? 'verified severe regression'
          : `${lesser} verified harm observations`,
        joinHashes: mine
          .filter((item) => item.verdict === 'harmful')
          .map((item) => item.joinHash),
      });
    }
    return {
      recorded: true,
      observation,
      quarantined: this.quarantine.has(objectId),
    };
  }

  utility(objectId, filters = {}) {
    const rows = this.observations.filter(
      (item) =>
        item.objectId === objectId &&
        Object.entries(filters).every(
          ([key, value]) => item.context?.[key] === value
        )
    );
    return {
      objectId,
      filters,
      samples: rows.length,
      correctness: interval(
        rows
          .map((item) => item.effect.correct)
          .filter((value) => value !== null)
      ),
      recurrence: interval(
        rows
          .map((item) => item.effect.mistakeExecuted)
          .filter((value) => value !== null)
      ),
      tokens: interval(
        rows.map((item) => item.effect.tokens).filter((value) => value !== null)
      ),
      harmful: rows.filter((item) => item.verdict === 'harmful').length,
      quarantined: this.quarantine.get(objectId) || null,
    };
  }

  selection(
    objectIds,
    context,
    { minimumSamples = 5, minimumCorrectnessGain = 0 } = {}
  ) {
    const eligible = objectIds
      .map((objectId) => this.utility(objectId, context))
      .filter(
        (utility) =>
          !utility.quarantined &&
          utility.samples >= minimumSamples &&
          utility.correctness.low !== null &&
          utility.correctness.low >= minimumCorrectnessGain
      );
    if (!eligible.length)
      return {
        action: 'abstain',
        objectIds: [],
        reason: 'insufficient safe causal evidence',
      };
    eligible.sort(
      (a, b) =>
        b.correctness.mean - a.correctness.mean ||
        a.objectId.localeCompare(b.objectId)
    );
    return {
      action: 'deliver',
      objectIds: eligible.map((item) => item.objectId),
      utilities: eligible,
    };
  }

  appeal(objectId, evidence) {
    const appeal = { objectId, evidence, at: Date.now(), state: 'pending' };
    this.appeals.push(appeal);
    return appeal;
  }

  revalidate(objectId, receipt) {
    if (receipt?.passed !== true || !receipt?.graderId)
      return { revalidated: false };
    const prior = this.quarantine.get(objectId);
    if (!prior) return { revalidated: false };
    this.quarantine.delete(objectId);
    return { revalidated: true, prior, receipt };
  }
}
