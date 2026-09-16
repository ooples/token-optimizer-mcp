/** Shared fail-closed checks for benchmark evidence, independent of reporting. */
export function reduction(ours, baseline) {
  if (![ours, baseline].every(Number.isFinite) || ours < 0 || baseline < 0)
    throw Error('Invalid reduction operands');
  if (baseline === 0) return null;
  const value = 1 - ours / baseline;
  if (!Number.isFinite(value)) throw Error('Non-finite reduction');
  return value;
}

export const identity = (row) => JSON.stringify([row.task, row.arm, row.rep]);

export function matchAudits(rows, audits) {
  if (!Array.isArray(rows) || !Array.isArray(audits))
    throw Error('Missing audit rows');
  const ids = rows.map(identity),
    auditIds = audits.map(identity);
  if (
    new Set(ids).size !== ids.length ||
    new Set(auditIds).size !== auditIds.length ||
    ids.length !== auditIds.length ||
    ids.some((id) => !auditIds.includes(id))
  )
    throw Error('Audit identities do not match results');
  const byId = new Map(audits.map((r) => [identity(r), r]));
  return rows.map((r) => ({ ...r, verdict: byId.get(identity(r)).verdict }));
}

export function groupMatrix(records, dimensions, sampleCount) {
  if (
    !Array.isArray(records) ||
    !Number.isSafeInteger(sampleCount) ||
    sampleCount < 1
  )
    return false;
  const fields = Object.keys(dimensions);
  let combinations = [[]];
  for (const values of Object.values(dimensions))
    combinations = combinations.flatMap((prefix) =>
      values.map((v) => [...prefix, v])
    );
  const expected = new Set(combinations.map((v) => JSON.stringify(v)));
  if (records.length !== expected.size) return false;
  for (const record of records) {
    if (
      !expected.delete(JSON.stringify(fields.map((k) => record[k]))) ||
      !Array.isArray(record.samples) ||
      record.samples.length !== sampleCount
    )
      return false;
  }
  return expected.size === 0;
}

export function auditedPilot(rows, audits, summary) {
  if (summary?.valid !== true) return [];
  try {
    return matchAudits(rows, audits).filter((r) => r.verdict === 'PASS');
  } catch {
    return [];
  }
}
