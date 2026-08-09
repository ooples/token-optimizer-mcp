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

function terms(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2);
}

function searchable(object) {
  return canonicalJson({
    trigger: object.trigger,
    claim: object.claim,
    correction: object.correction,
    applicability: object.applicability,
    nonApplicability: object.nonApplicability,
    steps: object.steps,
    title: object.title,
    tags: object.tags,
  });
}

function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length)
    return 0;
  const dot = left.reduce((sum, value, index) => sum + value * right[index], 0);
  const a = Math.sqrt(left.reduce((sum, value) => sum + value ** 2, 0));
  const b = Math.sqrt(right.reduce((sum, value) => sum + value ** 2, 0));
  return a && b ? dot / (a * b) : 0;
}

export const RETRIEVAL_KERNELS = Object.freeze([
  'bm25',
  'vector',
  'temporal',
  'causal',
  'structural',
  'procedure',
  'checkpoint',
  'global',
]);

const DEFAULT_ROUTES = Object.freeze({
  'factual-local': ['bm25', 'vector', 'structural'],
  'factual-global': ['global', 'bm25', 'vector', 'structural'],
  'activity-local': ['temporal', 'bm25'],
  'activity-global': ['global', 'temporal', 'bm25'],
  workflow: ['procedure', 'bm25', 'vector', 'structural'],
  failure: ['failure', 'bm25', 'vector', 'causal'],
  temporal: ['temporal', 'bm25', 'causal'],
  coordination: ['checkpoint', 'global', 'bm25', 'structural'],
});

export class RetrievalPlanner {
  constructor({
    graph,
    artifactStore = null,
    compatibility = () => ({ compatible: true, reasons: [] }),
    router = null,
  } = {}) {
    this.graph = graph;
    this.artifactStore = artifactStore;
    this.compatibility = compatibility;
    this.router = router;
    this.kernels = new Map();
    this.telemetry = [];
    this.registerDefaults();
  }

  register(name, kernel) {
    this.kernels.set(name, kernel);
  }

  registerDefaults() {
    this.register('bm25', ({ text }) => {
      const queryTerms = [...new Set(terms(text))];
      const documents = [...this.graph.objects.values()].map((object) => ({
        object,
        terms: terms(searchable(object)),
      }));
      const averageLength =
        documents.reduce((sum, document) => sum + document.terms.length, 0) /
          Math.max(1, documents.length) || 1;
      return documents
        .map((document) => {
          const score = queryTerms.reduce((total, term) => {
            const frequency = document.terms.filter((item) => item === term).length;
            if (!frequency) return total;
            const containing = documents.filter((item) => item.terms.includes(term)).length;
            const inverse = Math.log(
              1 + (documents.length - containing + 0.5) / (containing + 0.5)
            );
            const normalized =
              (frequency * 2.2) /
              (frequency + 1.2 * (0.25 + 0.75 * (document.terms.length / averageLength)));
            return total + inverse * normalized;
          }, 0);
          return {
            object: document.object,
            score: queryTerms.length ? score / queryTerms.length : 0,
            path: ['bm25', document.object.id],
          };
        })
        .filter((row) => row.score > 0);
    });
    // Compatibility alias for telemetry consumers using the previous name.
    this.register('lexical', (query) => this.kernels.get('bm25')(query));
    this.register('vector', ({ embedding }) =>
      Array.isArray(embedding)
        ? [...this.graph.objects.values()]
            .filter((object) => Array.isArray(object.embedding))
            .map((object) => ({
              object,
              score: cosine(embedding, object.embedding),
              path: ['vector', object.id],
            }))
            .filter((row) => row.score > 0)
        : []
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
    this.register('global', () => {
      const degrees = new Map();
      for (const relation of this.graph.relations.values()) {
        degrees.set(relation.from, (degrees.get(relation.from) || 0) + 1);
        degrees.set(relation.to, (degrees.get(relation.to) || 0) + 1);
      }
      const maximum = Math.max(1, ...degrees.values());
      return [...this.graph.objects.values()]
        .filter((object) => object.globalSummary || degrees.has(object.id))
        .map((object) => ({
          object,
          score: object.globalSummary ? 1 : (degrees.get(object.id) || 0) / maximum,
          path: ['global', object.id],
        }));
    });
  }

  plan(query, context = {}, { minimumScore = 0.35, limit = 10 } = {}) {
    const family = classifyQuery(query);
    const selected =
      this.router?.routes?.[family] || DEFAULT_ROUTES[family] || ['bm25'];
    const started = Date.now();
    const union = new Map();
    const excluded = [];
    for (const name of selected) {
      const rows =
        this.kernels.get(name)?.({
          text: query?.text || String(query),
          embedding: query?.embedding,
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

export function calibrateRetrievalRouter(rows, { minimumCases = 5 } = {}) {
  const families = new Map();
  for (const row of rows) {
    if (!row.family || !row.kernel || typeof row.relevant !== 'boolean') continue;
    const key = `${row.family}:${row.kernel}`;
    if (!families.has(key))
      families.set(key, { family: row.family, kernel: row.kernel, rows: [] });
    families.get(key).rows.push(row);
  }
  const scores = [...families.values()].map((group) => {
    const selected = group.rows.filter((row) => row.selected === true);
    const relevant = group.rows.filter((row) => row.relevant === true);
    const truePositive = selected.filter((row) => row.relevant === true).length;
    const precision = selected.length ? truePositive / selected.length : 0;
    const recall = relevant.length ? truePositive / relevant.length : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return {
      family: group.family,
      kernel: group.kernel,
      cases: group.rows.length,
      precision,
      recall,
      f1,
      calibrated: group.rows.length >= minimumCases,
    };
  });
  const routes = Object.fromEntries(
    QUERY_FAMILIES.map((family) => [
      family,
      scores
        .filter((score) => score.family === family && score.calibrated)
        .sort((a, b) => b.f1 - a.f1 || a.kernel.localeCompare(b.kernel))
        .map((score) => score.kernel),
    ])
  );
  return {
    schemaVersion: 'ucr.retrieval-calibration/1',
    routes,
    scores,
    calibrationHash: sha256({ routes, scores }),
  };
}
