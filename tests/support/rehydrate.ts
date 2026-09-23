/**
 * REBUILD THE ORIGINAL FROM THE EMITTED TEXT ALONE.
 *
 * The records encoder states a repeated row shape once -- a template plus the
 * per-row fragments, and, for a column that steps by a constant, a rule
 * (`slot=first+stepN`) instead of the values. That is lossless, but only a
 * decoder can see it: `r-0` is not a substring of the output, it is "r-" in
 * the template joined to slot 0 produced by the rule. A substring oracle
 * therefore reports healthy compression as data loss (#415).
 *
 * This lives outside any one test file because three suites now need it.
 */
/** Rebuilds the original from the emitted text alone, rule included. */
export function expandJsonRecords(text: string): string {
  return text.replace(
    /\[JSON array records; ALL \d+ records preserved(?:, \d+ encoded here)?\. Join template parts, replacing numeric slots with verbatim text fragments from each row\. Template: (\[[^\n]+?\])(; slots ([^\]\n]+) count from 0)?\]\n([\s\S]*?)\[\/JSON fragment records\]\n/g,
    (
      _all,
      encoded: string,
      _clause,
      slots: string | undefined,
      rows: string
    ) => {
      const template = JSON.parse(encoded) as (number | string)[];
      const rules = new Map<number, { first: number; step: number }>();
      for (const part of (slots ?? '').split(' ').filter(Boolean)) {
        const m = /^(\d+)=(-?\d+)\+(-?\d+)n$/.exec(part);
        if (!m) throw new Error(`unreadable run clause ${part}`);
        rules.set(Number(m[1]), { first: Number(m[2]), step: Number(m[3]) });
      }
      return rows
        .trim()
        .split('\n')
        .map((row, index) => {
          const present = JSON.parse(row) as string[];
          // Slots carrying a rule were omitted from the row; the rest arrive in
          // order, so the two streams are interleaved by slot number.
          const slotCount =
            present.length + [...rules.keys()].filter((k) => k >= 0).length;
          const values: string[] = [];
          let next = 0;
          for (let slot = 0; slot < slotCount; slot += 1) {
            const rule = rules.get(slot);
            values.push(
              rule ? String(rule.first + rule.step * index) : present[next++]
            );
          }
          return template
            .map((part) => (typeof part === 'number' ? values[part] : part))
            .join('');
        })
        .join('');
    }
  );
}
