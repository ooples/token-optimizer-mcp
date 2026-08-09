import { canonicalJson, sha256 } from './protocol.mjs';

export const CONTEXT_TIERS = Object.freeze({
  L0: 'dormant-graph',
  L1: 'active-goal-checkpoint',
  L2: 'decision-guard',
  L3: 'evidence-capsule',
  L4: 'raw-artifact',
});

const estimate = (value) =>
  Math.max(1, Math.ceil(canonicalJson(value).length / 4));

export function contextCapsule(candidate, { tier = 'L3' } = {}) {
  const object = candidate.object;
  const capsule = {
    schemaVersion: 'ucr.capsule/1',
    capsuleId: `capsule:${sha256({ objectId: object.id, tier, eventId: object.eventId }).slice(0, 24)}`,
    tier,
    objectIds: [object.id],
    payload:
      object.claim ||
      object.correction ||
      object.title ||
      object.desiredState ||
      object.steps,
    provenance: object.provenance || [],
    applicability: object.applicability || [],
    nonApplicability: object.nonApplicability || [],
    uncertainty: { confidence: object.confidence ?? null, state: object.state },
    expansion: object.artifactRef || object.payloadRef || null,
    retrieval: {
      // Full path explanations remain available on the page result. Repeating
      // them inside every capsule wastes the exact context this VM protects.
      score: candidate.score,
      kernels: candidate.kernels,
    },
  };
  return { ...capsule, tokens: estimate(capsule) };
}

export class ContextVM {
  constructor({
    planner,
    hardMaximumTokens = 512,
    artifactResolver = null,
  } = {}) {
    if (!planner) throw new Error('ContextVM requires a retrieval planner');
    this.planner = planner;
    this.hardMaximumTokens = hardMaximumTokens;
    this.artifactResolver = artifactResolver;
    this.workingSets = new Map();
    this.expansionCache = new Map();
    this.events = [];
  }

  page(
    query,
    context = {},
    { budget = this.hardMaximumTokens, tier = 'L3' } = {}
  ) {
    const maximum = Math.min(Math.max(0, budget), this.hardMaximumTokens);
    const retrieval = this.planner.plan(query, context);
    if (retrieval.action === 'abstain' || maximum === 0) {
      const result = {
        action: 'abstain',
        capsules: [],
        tokens: 0,
        explanation: retrieval.explanation,
      };
      this.events.push({
        kind: 'page-fault',
        trigger: context.trigger || 'task',
        ...result,
      });
      return result;
    }
    const ranked = retrieval.candidates
      .map((candidate) => {
        const capsule = contextCapsule(candidate, { tier });
        return {
          capsule,
          valuePerToken:
            (candidate.score * (1 + candidate.expectedUtility)) /
            capsule.tokens,
        };
      })
      .sort(
        (a, b) =>
          b.valuePerToken - a.valuePerToken ||
          a.capsule.capsuleId.localeCompare(b.capsule.capsuleId)
      );
    const capsules = [];
    let tokens = 0;
    for (const item of ranked) {
      if (tokens + item.capsule.tokens > maximum) continue;
      capsules.push(item.capsule);
      tokens += item.capsule.tokens;
    }
    const result = {
      action: capsules.length ? 'deliver' : 'abstain',
      capsules,
      tokens,
      explanation: retrieval.explanation,
    };
    if (context.taskId)
      this.workingSets.set(context.taskId, {
        stateHash: context.stateHash || null,
        capsules,
      });
    this.events.push({
      kind: 'page-fault',
      trigger: context.trigger || 'task',
      ...result,
    });
    return result;
  }

  retain(taskId, stateHash) {
    const existing = this.workingSets.get(taskId);
    if (!existing) return null;
    if (existing.stateHash && stateHash && existing.stateHash !== stateHash) {
      this.workingSets.delete(taskId);
      return null;
    }
    return existing.capsules;
  }

  evict(taskId, { preserve = ['L1', 'L2'] } = {}) {
    const existing = this.workingSets.get(taskId);
    if (!existing) return [];
    existing.capsules = existing.capsules.filter((capsule) =>
      preserve.includes(capsule.tier)
    );
    return existing.capsules;
  }

  expand(reference) {
    const key = String(reference?.uri || reference || '');
    if (this.expansionCache.has(key))
      return { cached: true, content: this.expansionCache.get(key) };
    if (!this.artifactResolver) return { cached: false, content: null };
    const content = this.artifactResolver(reference);
    if (content !== null && content !== undefined)
      this.expansionCache.set(key, content);
    this.events.push({
      kind: 'context-expanded',
      referenceHash: sha256(key),
      tokens: estimate(content),
    });
    return { cached: false, content };
  }

  metrics() {
    return {
      pageFaults: this.events.filter((event) => event.kind === 'page-fault')
        .length,
      capsuleTokens: this.events
        .filter((event) => event.kind === 'page-fault')
        .reduce((sum, event) => sum + event.tokens, 0),
      expansionTokens: this.events
        .filter((event) => event.kind === 'context-expanded')
        .reduce((sum, event) => sum + event.tokens, 0),
      workingSets: this.workingSets.size,
    };
  }
}
