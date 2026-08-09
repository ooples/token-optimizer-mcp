import { canonicalJson, sha256 } from './protocol.mjs';

export const QUERY_FAMILIES = Object.freeze([
  'factual-local',
  'factual-global',
  'activity-local',
  'activity-global',
  'workflow',
  'failure',
  'temporal',
  'coordination',
]);

export function classifyQuery(query) {
  const text = String(query?.text || query || '').toLowerCase();
  if (/fail|mistake|error|dead end|wrong/.test(text)) return 'failure';
  if (/how|workflow|procedure|steps|runbook/.test(text)) return 'workflow';
  if (/when|before|after|changed|latest|history/.test(text)) return 'temporal';
  if (/agent|owner|lease|delegat|coordinate/.test(text)) return 'coordination';
  if (/project|repository|global|across/.test(text)) return 'factual-global';
  return 'factual-local';
}

function tokenEstimate(value) {
  return Math.ceil(canonicalJson(value).length / 4);
}

function relevance(object, text) {
  const terms = String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2);
  if (!terms.length) return 0;
  const content = canonicalJson({
    trigger: object.trigger,
    claim: object.claim,
    correction: object.correction,
    applicability: object.applicability,
    nonApplicability: object.nonApplicability,
    steps: object.steps,
    title: object.title,
    tags: object.tags,
  }).toLowerCase();
  return terms.filter((term) => content.includes(term)).length / terms.length;
}

export class RetrievalPlanner {
  constructor({
    graph,
    artifactStore = null,
    compatibility = () => ({ compatible: true, reasons: [] }),
  } = {}) {
    this.graph = graph;
    this.artifactStore = artifactStore;
    this.compatibility = compatibility;
    this.kernels = new Map();
    this.telemetry = [];
    this.registerDefaults();
  }

  register(name, kernel) {
    this.kernels.set(name, kernel);
  }

  registerDefaults() {
    this.register('lexical', ({ text }) =>
      this.graph.lexical(text).map((item) => ({
        object: item.object,
        score: item.score,
        path: ['lexical', item.object.id],
      }))
    );
    this.register('temporal', () =>
      [...this.graph.objects.values()]
        .sort((a, b) => b.learnedAt - a.learnedAt)
        .slice(0, 50)
        .map((object, index) => ({
          object,
          score: 1 / (index + 1),
          path: ['temporal', object.id],
        }))
    );
    this.register('procedure', ({ text }) =>
      [...this.graph.objects.values()]
        .filter((object) => object.type === 'procedure')
        .map((object) => ({
          object,
          score: (object.confidence ?? 0.5) * relevance(object, text),
          path: ['procedure', object.id],
        }))
        .filter((row) => row.score > 0)
    );
    this.register('failure', ({ text }) =>
      [...this.graph.objects.values()]
        .filter((object) => ['failure', 'guard'].includes(object.type))
        .map((object) => ({
          object,
          score: (object.confidence ?? 0.5) * relevance(object, text),
          path: ['failure', object.id],
        }))
        .filter((row) => row.score > 0)
    );
    this.register('checkpoint', () =>
      [...this.graph.objects.values()]
        .filter((object) => object.type === 'checkpoint')
        .map((object) => ({
          object,
          score: 1,
          path: ['checkpoint', object.id],
        }))
    );
    this.register('causal', ({ seeds = [] }) => {
      if (!seeds.length) return [];
      const relations = [...this.graph.relations.values()].filter(
        (relation) =>
          ['causes', 'claimed_causes', 'verified_by', 'derived_from'].includes(
            relation.type
          ) &&
          (!seeds.length ||
            seeds.includes(relation.from) ||
            seeds.includes(relation.to))
      );
      return relations
        .flatMap((relation) => [relation.from, relation.to])
        .map((id) => this.graph.objects.get(id))
        .filter(Boolean)
        .map((object) => ({ object, score: 0.8, path: ['causal', object.id] }));
    });
    this.register('structural', ({ anchors = [] }) =>
      anchors.length
        ? [...this.graph.relations.values()]
            .filter(
              (relation) =>
                anchors.includes(relation.from) || anchors.includes(relation.to)
            )
            .flatMap((relation) => [relation.from, relation.to])
            .map((id) => this.graph.objects.get(id))
            .filter(Boolean)
            .map((object) => ({
              object,
              score: 0.7,
              path: ['structural', object.id],
            }))
        : []
    );
  }

  plan(query, context = {}, { minimumScore = 0.35, limit = 10 } = {}) {
    const family = classifyQuery(query);
    const selected =
      family === 'failure'
        ? ['failure', 'lexical', 'causal']
        : family === 'workflow'
          ? ['procedure', 'lexical', 'structural']
          : family === 'temporal'
            ? ['temporal', 'lexical']
            : family === 'coordination'
              ? ['checkpoint', 'lexical', 'structural']
              : ['lexical', 'structural'];
    const started = Date.now();
    const union = new Map();
    const excluded = [];
    for (const name of selected) {
      const rows =
        this.kernels.get(name)?.({
          text: query?.text || String(query),
          anchors: context.anchors,
          seeds: context.seeds,
        }) || [];
      for (const row of rows) {
        const compatibility = this.compatibility(row.object, context);
        if (!compatibility.compatible) {
          excluded.push({
            objectId: row.object.id,
            kernel: name,
            reasons: compatibility.reasons,
          });
          continue;
        }
        const risk =
          row.object.state === 'stale' || row.object.state === 'quarantined'
            ? 1
            : 0;
        const confidence = row.object.confidence ?? 0.5;
        const utility = row.object.expectedUtility ?? 0;
        const recency =
          1 /
          (1 +
            Math.max(0, Date.now() - (row.object.learnedAt || Date.now())) /
              2.6e9);
        const score =
          row.score * 0.45 +
          confidence * 0.25 +
          recency * 0.1 +
          utility * 0.2 -
          risk;
        const prior = union.get(row.object.id);
        const candidate = {
          object: row.object,
          objectId: row.object.id,
          score,
          kernels: [...new Set([...(prior?.kernels || []), name])].sort(),
          paths: [...(prior?.paths || []), row.path],
          compatibility,
          risk,
          confidence,
          recency,
          expectedUtility: utility,
          tokenCost: tokenEstimate(row.object),
        };
        if (!prior || candidate.score > prior.score)
          union.set(row.object.id, candidate);
        else
          union.set(row.object.id, {
            ...prior,
            kernels: candidate.kernels,
            paths: candidate.paths,
          });
      }
    }
    const candidates = [...union.values()]
      .filter(
        (candidate) => candidate.score >= minimumScore && candidate.risk < 1
      )
      .sort((a, b) => b.score - a.score || a.objectId.localeCompare(b.objectId))
      .slice(0, limit);
    const explanation = {
      queryHash: sha256(query),
      family,
      kernels: selected,
      excluded,
      candidates: candidates.map((candidate) => ({
        objectId: candidate.objectId,
        score: candidate.score,
        kernels: candidate.kernels,
        paths: candidate.paths,
        filters: candidate.compatibility.reasons,
      })),
    };
    this.telemetry.push({
      family,
      kernels: selected,
      candidates: candidates.length,
      latencyMs: Date.now() - started,
    });
    return {
      action: candidates.length ? 'deliver' : 'abstain',
      candidates,
      explanation,
    };
  }
}
