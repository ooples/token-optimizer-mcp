/**
 * Scoring for the cross-project proof.
 *
 * STRICT BY DEFAULT, AND THE REASON IS A NEAR MISS. A first scorer asked only
 * whether the value APPEARED in the answer, and reported 6 of 6 avoided -- 100%,
 * a clean pass. Two of those answers named the value inside an explicit REFUSAL
 * to apply it:
 *
 *   "That date belongs to that repo's history, not this one -- carrying it over
 *    would be fabrication."
 *
 * Counting that as a success would have turned the model correctly declining a
 * bad transfer into evidence the feature works. This repository's own corpus
 * notes already record the same mistake in another suite, where merely mentioning
 * a failure's symptom scored as having solved it.
 *
 * So a refusal is its own outcome. It is admitted to the denominator -- the
 * lesson was delivered and did not change the answer -- but never counted as an
 * avoidance.
 */

/**
 * Phrases that mark an answer as DECLINING TO TRANSFER what it was given.
 *
 * NARROWED AFTER READING THE ANSWERS, and the narrowing is a correctness fix
 * rather than a moved goalpost. The first version also matched bare hedges like
 * "I don't know", which misclassified this answer as a refusal:
 *
 *   "wiki.train.full holds 117,920,208 tokens, against a 1,500,000-token window
 *    -- roughly 76x. I don't know it independently for an unnamed file; that
 *    number comes from the recalled note, so verify the filename matches."
 *
 * That answer supplies the value, uses it, and reasons from it. The hedge is a
 * caveat about provenance, which is exactly the calibration a cross-project fact
 * SHOULD carry. Scoring it as a refusal punished the tier for the model being
 * careful. Contrast a real refusal, which asserts non-transfer and withholds:
 *
 *   "I don't know the number. The 536 figure is HarmonicEngine's baseline for a
 *    different build target, and it doesn't transfer."
 *
 * So the test is an explicit non-transfer assertion, not uncertainty. An answer
 * that never supplies the value at all is already caught by `walksIn` and scores
 * as walked, so nothing is lost by dropping the bare hedges.
 */
const REFUSAL =
  /(does\s?n[o']?t transfer|doesn't apply here|would be fabrication|belongs to (that|another|a different) (repo|project)|not this one|scoped to a different project|carrying it over)/i;

/**
 * @returns 'walked' | 'avoided' | 'refused' | 'ambig' | 'abstain'
 */
export function verdict(testCase, answer, { strict = true } = {}) {
  const text = String(answer || '');
  const walks = testCase.walksIn(text);
  const avoids = testCase.avoids(text);
  if (strict && avoids && REFUSAL.test(text)) return 'refused';
  if (walks && !avoids) return 'walked';
  if (avoids && !walks) return 'avoided';
  if (walks && avoids) return 'ambig';
  return 'abstain';
}

/**
 * Grades a full run against the pre-registered gate.
 *
 * A case is ADMITTED only when the control failed it -- a case the control gets
 * right measures nothing, and averaging it in makes the graph look better or
 * worse depending only on which easy cases the corpus happens to contain.
 */
export function grade(cases, results, { strict = true } = {}) {
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  const rows = [];
  let admitted = 0;
  let avoided = 0;
  let refused = 0;
  let regressions = 0;

  for (const c of cases) {
    const r = byId[c.id];
    if (!r) continue;
    const control = verdict(c, r.control, { strict });
    const treated = verdict(c, r.treated, { strict });
    rows.push({ id: c.id, origin: c.origin, control, treated });

    // The control failing is what admits a case, whether it failed by walking in
    // or by declining to answer at all.
    if (control === 'walked' || control === 'refused') {
      admitted += 1;
      if (treated === 'avoided') avoided += 1;
      if (treated === 'refused') refused += 1;
    }
    // A finding that pushes a previously-correct answer wrong is the hard zero.
    if (control === 'avoided' && treated === 'walked') regressions += 1;
  }

  const rate = admitted ? Math.round((100 * avoided) / admitted) : null;
  const gates = {
    admitted: admitted >= 5,
    avoidance: rate !== null && rate >= 80,
    regressions: regressions === 0,
  };

  return {
    rows,
    admitted,
    avoided,
    refused,
    regressions,
    rate,
    gates,
    pass: gates.admitted && gates.avoidance && gates.regressions,
  };
}

export function report(g) {
  const lines = ['case                              origin     control    treated'];
  for (const r of g.rows) {
    lines.push(
      r.id.padEnd(34) + r.origin.padEnd(11) + r.control.padEnd(11) + r.treated
    );
  }
  lines.push('');
  lines.push(`ADMITTED    : ${g.admitted}`);
  lines.push(`AVOIDED     : ${g.avoided}`);
  lines.push(`REFUSED     : ${g.refused}  (delivered, declined -- not an avoidance)`);
  lines.push(`REGRESSIONS : ${g.regressions}`);
  lines.push(`RATE        : ${g.rate === null ? 'undefined' : g.rate + '%'}`);
  lines.push('');
  lines.push(
    `GATES: admitted>=5 ${g.gates.admitted ? 'MET' : 'NOT MET'} | ` +
      `avoidance>=80% ${g.gates.avoidance ? 'MET' : 'NOT MET'} | ` +
      `regressions==0 ${g.gates.regressions ? 'MET' : 'NOT MET'}`
  );
  lines.push(`OVERALL: ${g.pass ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}
