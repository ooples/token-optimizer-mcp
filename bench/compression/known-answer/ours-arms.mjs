/**
 * The one thing the three stub profiles share: telling our four arms apart.
 *
 * head-to-head calls `compressBlock` three times per workload with different
 * options, and a stub has to answer each call differently or the arms all carry
 * the same number and the table cannot be checked. It has no workload name to
 * go on -- only the options -- so the discrimination is stated once, here, and
 * a change in how head-to-head configures its arms breaks this rather than
 * silently collapsing three columns into one.
 *
 *   default   no spill sink at all              (the headline `ours` column)
 *   sub       a sink, threshold 1               (the like-for-like against a store)
 *   preset    a sink, threshold 0.9             (the arm a caller would run)
 */

/** 'default' | 'sub' | 'preset' */
export function armOf(options) {
  if (typeof options?.spill !== 'function') return 'default';
  const below = options?.tuning?.spillWholeBlockBelow;
  if (below === 1) return 'sub';
  if (below === 0.9) return 'preset';
  throw new Error(
    `known-answer ours: unrecognised arm, spillWholeBlockBelow=${String(below)}. ` +
      'head-to-head changed how it configures its arms; update armOf() rather ' +
      'than letting three columns answer as one.'
  );
}

/** The identifiers the fixtures plant, in the order they appear in the text. */
export const ID = /KA-ID-\d{4}/g;

/**
 * A `compressBody` result in the shape head-to-head consumes.
 *
 * The body arm is the second product surface and it is scored the same way, so
 * a stub that returned nothing here would leave those columns untested.
 */
export function bodyResult(text) {
  return {
    body: Buffer.from(text, 'utf8'),
    summary: { compressed: true, reason: '' },
  };
}
