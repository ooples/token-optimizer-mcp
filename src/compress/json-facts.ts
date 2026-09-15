/** Exact, bounded facts computed from a complete array, never sampled rows.
 * They let an agent answer boolean-count questions without reading an elided tail.
 */
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
