import { sha256 } from './protocol.mjs';

export const MEMORY_STATES = Object.freeze([
  'active',
  'speculative',
  'stale',
  'superseded',
  'quarantined',
  'archived',
  'tombstoned',
]);

function similarityKey(object) {
  return sha256({
    type: object.type,
    trigger: String(object.trigger || '').toLowerCase(),
    correction: String(object.correction || object.claim || '').toLowerCase(),
    scope: object.scope,
  });
}

export function consolidationProposals(
  objects,
  { author, minimumGroup = 2 } = {}
) {
  const groups = new Map();
  for (const object of objects.filter((item) => item.state === 'active')) {
    const key = similarityKey(object);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(object);
  }
  return [...groups.values()]
    .filter((group) => group.length >= minimumGroup)
    .map((group) => ({
      id: `consolidation:${sha256(group.map((item) => item.id).sort()).slice(0, 24)}`,
      type: 'procedure',
      state: 'speculative',
      author,
      sourceIds: group.map((item) => item.id).sort(),
      generalizedFrom: group.map((item) => item.id).sort(),
      // A derived proposal may never claim greater certainty without a new
      // verification receipt.
      confidence: Math.min(...group.map((item) => item.confidence ?? 0)),
      trigger: group[0].trigger,
      steps: group.map((item) => item.correction || item.claim).filter(Boolean),
      verificationReceiptIds: [],
    }));
}

export function decayState(
  object,
  {
    now = Date.now(),
    halfLifeMs = 90 * 24 * 60 * 60 * 1000,
    utility = 0,
    dependedOn = false,
  } = {}
) {
  if (['quarantined', 'superseded', 'tombstoned'].includes(object.state))
    return object.state;
  const age = Math.max(0, now - (object.learnedAt || now));
  const recency = 2 ** (-age / halfLifeMs);
  const score =
    recency * 0.35 +
    (object.confidence ?? 0.5) * 0.3 +
    Math.max(-1, Math.min(1, utility)) * 0.35;
  if (dependedOn) return score < 0.1 ? 'stale' : object.state;
  if (score < 0.05) return 'tombstoned';
  if (score < 0.15) return 'archived';
  if (score < 0.3) return 'stale';
  return object.state;
}

export function resolveContradiction(left, right, receipts = []) {
  const verified = new Map(
    receipts
      .filter((receipt) => receipt.passed && receipt.objectId)
      .map((receipt) => [receipt.objectId, receipt])
  );
  const score = (object) =>
    (verified.has(object.id) ? 1 : 0) +
    (object.confidence ?? 0) +
    (object.learnedAt || 0) / 1e15;
  const leftScore = score(left);
  const rightScore = score(right);
  if (leftScore === rightScore)
    return {
      state: 'unresolved',
      activeId: null,
      retained: [left.id, right.id],
    };
  const active = leftScore > rightScore ? left : right;
  const superseded = active === left ? right : left;
  return {
    state: 'resolved',
    activeId: active.id,
    supersededId: superseded.id,
    retained: [left.id, right.id],
    receiptId: verified.get(active.id)?.receiptId || null,
  };
}

export function compactLogicalHistory(objects, relations) {
  const canonical = {
    objects: objects
      .map((object) => ({ ...object }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    relations: relations
      .map((relation) => ({ ...relation }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  return {
    schemaVersion: 'ucr.compaction/1',
    logicalHistoryHash: sha256(canonical),
    canonical,
  };
}

export function consolidationStudy(
  sessions,
  { author = 'consolidation-model', now = Date.now() } = {}
) {
  const source = sessions.flatMap((session) => session.objects || []);
  const sourceHashesBefore = new Map(source.map((object) => [object.id, sha256(object)]));
  const proposals = consolidationProposals(source, { author });
  const groups = new Map();
  for (const object of source) {
    const key = String(object.trigger || object.claim || object.id).toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(object);
  }
  const contradictionResults = [];
  for (const group of groups.values()) {
    const corrections = new Set(
      group.map((object) => object.correction || object.claim).filter(Boolean)
    );
    if (corrections.size < 2) continue;
    const sorted = [...group].sort(
      (a, b) =>
        (b.verificationReceiptIds?.length || 0) -
          (a.verificationReceiptIds?.length || 0) ||
        (b.learnedAt || 0) - (a.learnedAt || 0)
    );
    contradictionResults.push(
      resolveContradiction(
        sorted[0],
        sorted[1],
        sorted[0].verificationReceiptIds?.length
          ? [
              {
                objectId: sorted[0].id,
                passed: true,
                receiptId: sorted[0].verificationReceiptIds[0],
              },
            ]
          : []
      )
    );
  }
  const states = source.map((object) => ({
    objectId: object.id,
    state: decayState(object, {
      now,
      utility: object.expectedUtility || 0,
      dependedOn: Boolean(object.dependedOn),
    }),
  }));
  const activeSources = states.filter((item) => item.state === 'active').length;
  const uniqueLogicalMemories = new Set(source.map(similarityKey)).size;
  const sourceMutations = source.filter(
    (object) => sourceHashesBefore.get(object.id) !== sha256(object)
  ).length;
  const delayedReuse = sessions.filter((session) => session.delayedReuseOf).map((session) => ({
    sessionId: session.id,
    memoryId: session.delayedReuseOf,
    retained: source.some(
      (object) =>
        object.id === session.delayedReuseOf &&
        !states.some(
          (state) =>
            state.objectId === object.id &&
            ['tombstoned', 'superseded', 'quarantined'].includes(state.state)
        )
    ),
  }));
  return {
    schemaVersion: 'ucr.consolidation-study/1',
    sessions: sessions.length,
    sourceObjects: source.length,
    sourceMutations,
    proposals: proposals.length,
    proposalAuthors: [...new Set(proposals.map((proposal) => proposal.author))],
    activeSources,
    uniqueLogicalMemories,
    activeGrowthRatio: source.length
      ? (uniqueLogicalMemories + proposals.length) / source.length
      : null,
    contradictions: contradictionResults,
    contradictionsResolved: contradictionResults.filter(
      (result) => result.state === 'resolved'
    ).length,
    delayedReuseCases: delayedReuse.length,
    delayedReuseRetained: delayedReuse.filter((item) => item.retained).length,
    states,
    logicalHistoryHash: compactLogicalHistory(source, []).logicalHistoryHash,
  };
}
