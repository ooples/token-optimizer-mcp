import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { get_encoding } from 'tiktoken';
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

export function createTiktokenCounter(encoding = 'cl100k_base') {
  const tokenizer = get_encoding(encoding);
  let closed = false;
  return {
    method: `tiktoken:${encoding}`,
    count(value) {
      if (closed) throw new Error('token counter is closed');
      return tokenizer.encode(canonicalJson(value)).length;
    },
    close() {
      if (!closed) tokenizer.free();
      closed = true;
    },
  };
}

export class WorkingSetStore {
  constructor(path) {
    this.path = path;
  }

  read() {
    if (!existsSync(this.path)) return new Map();
    const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    return new Map(parsed.workingSets || []);
  }

  write(workingSets) {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.next`;
    writeFileSync(
      temporary,
      `${canonicalJson({
        schemaVersion: 'ucr.working-sets/1',
        workingSets: [...workingSets.entries()].sort(([a], [b]) =>
          a.localeCompare(b)
        ),
      })}\n`,
      { mode: 0o600 }
    );
    renameSync(temporary, this.path);
  }
}

export function contextCapsule(
  candidate,
  { tier = 'L3', tokenCounter = null } = {}
) {
  const object = candidate.object;
  const capsule = {
    schemaVersion: 'ucr.capsule/1',
    capsuleId: `capsule:${sha256({ objectId: object.id, tier, eventId: object.eventId }).slice(0, 24)}`,
    tier,
    objectIds: [object.id],
    recordMeaning: ['failure', 'guard'].includes(object.type)
      ? 'verified correction to a prior failed attempt'
      : object.type,
    payload:
      object.claim ||
      object.correction ||
      object.title ||
      object.desiredState ||
      object.steps,
    rejectedAction: object.attemptedAction || null,
    reason: object.rootCause || null,
    verificationEvidence: object.verificationEvidence || null,
    // Scope, exclusions, receipt chains, retrieval paths, and expansion
    // references remain host-side. Repeating them here made a short correction
    // miss its own delivery budget even though none of that metadata crossed
    // the model boundary.
  };
  const transmitted = {
    payload: capsule.payload,
    rejectedAction: capsule.rejectedAction,
    reason: capsule.reason,
    verificationEvidence: capsule.verificationEvidence,
  };
  return {
    ...capsule,
    // Budget only bytes that can cross the model boundary. Internal IDs, tier,
    // and schema metadata remain host-side and previously caused a 126-token
    // correction to be rejected as a 174-token capsule.
    tokens: tokenCounter
      ? tokenCounter.count(transmitted)
      : estimate(transmitted),
    tokenAccounting: tokenCounter?.method || 'heuristic:utf8-length-div-4',
  };
}

export class ContextVM {
  constructor({
    planner,
    hardMaximumTokens = 512,
    artifactResolver = null,
    tokenCounter = null,
    workingSetStore = null,
    maximumCapsules = 1,
  } = {}) {
    if (!planner) throw new Error('ContextVM requires a retrieval planner');
    this.planner = planner;
    this.hardMaximumTokens = hardMaximumTokens;
    this.artifactResolver = artifactResolver;
    this.tokenCounter = tokenCounter;
    this.workingSetStore = workingSetStore;
    this.maximumCapsules = maximumCapsules;
    this.workingSets = workingSetStore?.read() || new Map();
    this.expansionCache = new Map();
    this.events = [];
    this.started = false;
  }

  sessionStart() {
    this.started = true;
    const result = {
      action: 'ready',
      calls: 0,
      tokens: 0,
      tokenAccounting: this.tokenCounter?.method || 'unmeasured',
    };
    this.events.push({ kind: 'session-start', ...result });
    return result;
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
        const capsule = contextCapsule(candidate, {
          tier,
          tokenCounter: this.tokenCounter,
        });
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
      if (capsules.length >= this.maximumCapsules) break;
      if (tokens + item.capsule.tokens > maximum) continue;
      capsules.push(item.capsule);
      tokens += item.capsule.tokens;
    }
    const prior = context.taskId ? this.workingSets.get(context.taskId) : null;
    const priorIds = new Set(
      (prior?.capsules || []).map((capsule) => capsule.capsuleId)
    );
    const currentIds = new Set(capsules.map((capsule) => capsule.capsuleId));
    const delta = {
      baseHash: prior ? sha256(prior.capsules) : null,
      added: capsules.filter((capsule) => !priorIds.has(capsule.capsuleId)),
      removed: [...priorIds].filter((id) => !currentIds.has(id)),
    };
    const result = {
      action: capsules.length ? 'deliver' : 'abstain',
      capsules,
      tokens,
      delta,
      transmittedTokens: context.delta
        ? delta.added.reduce((sum, capsule) => sum + capsule.tokens, 0)
        : tokens,
      tokenAccounting:
        this.tokenCounter?.method || 'heuristic:utf8-length-div-4',
      explanation: retrieval.explanation,
    };
    if (context.taskId)
      this.workingSets.set(context.taskId, {
        stateHash: context.stateHash || null,
        capsules,
      });
    if (context.taskId) this.workingSetStore?.write(this.workingSets);
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
      this.workingSetStore?.write(this.workingSets);
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
    this.workingSetStore?.write(this.workingSets);
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
      tokens: this.tokenCounter
        ? this.tokenCounter.count(content)
        : estimate(content),
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
      startupCalls: this.events
        .filter((event) => event.kind === 'session-start')
        .reduce((sum, event) => sum + event.calls, 0),
      startupTokens: this.events
        .filter((event) => event.kind === 'session-start')
        .reduce((sum, event) => sum + event.tokens, 0),
      transmittedTokens: this.events
        .filter((event) => event.kind === 'page-fault')
        .reduce((sum, event) => sum + (event.transmittedTokens ?? event.tokens), 0),
      tokenAccounting:
        this.tokenCounter?.method || 'heuristic:utf8-length-div-4',
    };
  }
}
