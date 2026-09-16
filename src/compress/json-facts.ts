/** Exact, bounded facts computed from a complete array, never sampled rows.
 * They let an agent answer boolean-count questions without reading an elided tail.
 */
export function nullFacts(rows: readonly unknown[]): string {
  const keys = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    for (const [key, value] of Object.entries(row))
      if (value === null && key.length <= 80 && keys.size < 8) keys.add(key);
  }
  const facts: Record<
    string,
    { null: number; missing: number; other: number }
  > = Object.create(null);
  for (const key of keys) {
    const counts = { null: 0, missing: 0, other: 0 };
    for (const row of rows) {
      if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        !Object.hasOwn(row, key)
      )
        counts.missing++;
      else if ((row as Record<string, unknown>)[key] === null) counts.null++;
      else counts.other++;
    }
    facts[key] = counts;
  }
  return keys.size
    ? `; exact null counts over all ${rows.length} rows: ${JSON.stringify(facts)}`
    : '';
}

export function booleanFacts(rows: readonly unknown[]): string {
  const keys = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'boolean' && key.length <= 80 && keys.size < 8)
        keys.add(key);
    }
    if (keys.size === 8) break;
  }
  if (!keys.size) return '';
  const facts: Record<
    string,
    { true: number; false: number; missing: number; other: number }
  > = Object.create(null);
  for (const key of keys) {
    const counts = { true: 0, false: 0, missing: 0, other: 0 };
    for (const row of rows) {
      if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        !Object.hasOwn(row, key)
      )
        counts.missing++;
      else {
        const value = (row as Record<string, unknown>)[key];
        if (value === true) counts.true++;
        else if (value === false) counts.false++;
        else counts.other++;
      }
    }
    facts[key] = counts;
  }
  return `; exact boolean counts over all ${rows.length} rows: ${JSON.stringify(facts)}`;
}

/** Keep complete rare boolean populations, including their identifiers and
 * neighboring fields. Counts alone cannot answer which records need attention.
 * Bound both fields and population size; never sample a population and call it
 * complete. Missing/null/string values are not boolean false.
 */
export function rareBooleanRows(rows: readonly unknown[]): Set<number> {
  const fields = new Map<string, { yes: number[]; no: number[] }>();
  const limit = Math.min(8, Math.floor(rows.length * 0.1));
  if (!limit) return new Set();
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== 'boolean' || key.length > 80) continue;
      let field = fields.get(key);
      if (!field) {
        if (fields.size === 8) continue;
        field = { yes: [], no: [] };
        fields.set(key, field);
      }
      const positions = value ? field.yes : field.no;
      // One extra position distinguishes an oversized population without
      // retaining an index for every ordinary row in a huge response.
      if (positions.length <= limit) positions.push(index);
    }
  });
  const keep = new Set<number>();
  for (const { yes, no } of fields.values()) {
    for (const positions of [yes, no]) {
      if (positions.length <= limit)
        for (const index of positions) keep.add(index);
    }
  }
  return keep;
}

/** Retain complete rare categories without knowing the user's target vocabulary.
 * High-cardinality IDs are rejected. Each admitted population is complete and
 * counted before elision; a shared row budget and group cap bound the output.
 */
export function rareStringGroups(rows: readonly unknown[]): {
  keep: Set<number>;
  facts: string;
} {
  const keep = new Set<number>();
  const populationLimit = Math.min(8, Math.floor(rows.length * 0.1));
  const totalLimit = Math.min(32, Math.floor(rows.length * 0.1));
  if (!populationLimit) return { keep, facts: '' };
  const fields = new Map<string, Map<string, number[]> | null>();
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== 'string' || key.length > 80) continue;
      if (!fields.has(key)) {
        if (fields.size === 8) continue;
        fields.set(key, new Map());
      }
      const groups = fields.get(key);
      if (!groups) continue;
      if (value.length > 80 || (!groups.has(value) && groups.size === 8)) {
        fields.set(key, null);
        continue;
      }
      let positions = groups.get(value);
      if (!positions) {
        positions = [];
        groups.set(value, positions);
      }
      // One excess index distinguishes oversized groups without retaining
      // an index per ordinary row in a large response.
      if (positions.length <= populationLimit) positions.push(index);
    }
  });
  const complete: { field: string; value: string; count: number }[] = [];
  for (const [field, groups] of fields) {
    if (!groups || groups.size < 2) continue;
    for (const [value, positions] of groups) {
      if (positions.length > populationLimit || complete.length === 8) continue;
      const additional = positions.filter((index) => !keep.has(index));
      if (keep.size + additional.length > totalLimit) continue;
      for (const index of additional) keep.add(index);
      complete.push({ field, value, count: positions.length });
    }
  }
  return {
    keep,
    facts: complete.length
      ? `; complete string-value groups kept above (exact counts over all ${rows.length} rows): ${JSON.stringify(complete)}`
      : '',
  };
}
