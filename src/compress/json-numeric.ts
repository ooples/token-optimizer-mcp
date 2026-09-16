/** Bounded exact extrema avoid a recovery round trip for ordinary numeric queries. */
export function numericExtrema(rows: readonly unknown[]): {
  keep: Set<number>;
  facts: string;
} {
  const fields = new Map<
    string,
    { min: number; max: number; lo: number; hi: number; count: number }
  >();
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    for (const [key, value] of Object.entries(row)) {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        key.length > 80
      )
        continue;
      let field = fields.get(key);
      if (!field) {
        if (fields.size >= 8) continue;
        field = { min: value, max: value, lo: index, hi: index, count: 0 };
        fields.set(key, field);
      }
      field.count++;
      if (value < field.min) {
        field.min = value;
        field.lo = index;
      }
      if (value > field.max) {
        field.max = value;
        field.hi = index;
      }
    }
  });
  const keep = new Set<number>();
  const facts: Record<
    string,
    { min: number; max: number; numericRows: number }
  > = Object.create(null);
  for (const [key, field] of fields) {
    if (field.min === field.max) continue;
    keep.add(field.lo);
    keep.add(field.hi);
    facts[key] = { min: field.min, max: field.max, numericRows: field.count };
  }
  return {
    keep,
    facts: keep.size
      ? `; exact numeric extrema over all rows (first matching row retained, ties may be omitted): ${JSON.stringify(facts)}`
      : '',
  };
}
