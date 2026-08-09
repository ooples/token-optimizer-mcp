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
