/**
 * The gate, as a function, so a run cannot be graded by eye.
 *
 * WHY THIS EXISTS AS CODE. The first A/B run was scored by reading answers and
 * deciding whether they looked right. That is exactly the contamination the
 * proof protocol warns about everywhere else, applied to the scoring step
 * instead of the subject. The predicates already live with the cases; this puts
 * the ARITHMETIC somewhere it can be tested too.
 *
 * TWO RULES, BOTH LEARNED FROM RUNS THAT MEASURED NOTHING.
 *
 * 1. ADMISSION BY CONTROL FAILURE. A case where the control gets the right
 *    answer measured nothing: there was no dead-end to avoid, so the treatment
 *    "avoiding" it is not evidence of anything. The multi-turn run was 0 for 3
 *    on this -- every control verified instead of guessing -- and averaging
 *    those in would have produced a rate with no content. Such cases are
 *    EXCLUDED and reported as excluded, never silently dropped.
 *
 * 2. A MINIMUM NUMBER OF ADMITTED CASES. The single-turn run passed the 80% bar
 *    on two data points. Two is not a measurement, and a bar that can be cleared
 *    by two lucky cases is a bar that will eventually be cleared by noise.
 *
 * The token metric is deliberately NOT a gate. It is reported over the admitted
 * cases only, because tokens spent reaching a wrong answer are not comparable to
 * tokens spent reaching a right one.
 */

const DEFAULTS = { minAdmitted: 5, avoidedBar: 0.8, maxRegressions: 0 };

/**
 * @param {Array} results  [{ id, class, control: {answer, tokens}, treatment: {answer, tokens} }]
 * @param {Array} cases    the corpus, for the walksIn/avoids predicates
 */
export function grade(results, cases, options = {}) {
  const { minAdmitted, avoidedBar, maxRegressions } = { ...DEFAULTS, ...options };
  const byId = new Map(cases.map((c) => [c.id, c]));

  const scored = [];
  for (const r of results) {
    const c = byId.get(r.id);
    if (!c) throw new Error(`result for unknown case: ${r.id}`);
    const score = (answer) => ({
      walksIn: Boolean(c.walksIn(String(answer ?? ''))),
      avoids: Boolean(c.avoids(String(answer ?? ''))),
    });
    scored.push({
      id: r.id,
      // A case with no class still reports; it just cannot hide in an average.
      class: c.class || 'unclassified',
      control: { ...score(r.control?.answer), tokens: r.control?.tokens ?? null },
      treatment: { ...score(r.treatment?.answer), tokens: r.treatment?.tokens ?? null },
    });
  }

  // ADMISSION. The control must actually have failed, or the case is inert.
  const admitted = scored.filter((s) => s.control.walksIn && !s.control.avoids);
  const excluded = scored.filter((s) => !(s.control.walksIn && !s.control.avoids));

  const rescued = admitted.filter((s) => s.treatment.avoids && !s.treatment.walksIn);
  // A regression is the control being RIGHT and the treatment being pushed
  // wrong. It is looked for across every case, admitted or not: a misleading
  // finding does its damage exactly where the subject did not need help.
  const regressions = scored.filter((s) => s.control.avoids && s.treatment.walksIn);

  const avoidedRate = admitted.length ? rescued.length / admitted.length : null;

  // Tokens over ADMITTED cases only, and only where both arms landed correctly:
  // tokens spent reaching a wrong answer are not comparable to tokens spent
  // reaching a right one.
  const comparable = admitted.filter(
    (s) => s.treatment.avoids && s.control.tokens != null && s.treatment.tokens != null
  );
  const controlTokens = comparable.reduce((a, s) => a + s.control.tokens, 0);
  const treatmentTokens = comparable.reduce((a, s) => a + s.treatment.tokens, 0);

  const byClass = {};
  for (const s of admitted) {
    byClass[s.class] = byClass[s.class] || { admitted: 0, rescued: 0 };
    byClass[s.class].admitted += 1;
    if (s.treatment.avoids && !s.treatment.walksIn) byClass[s.class].rescued += 1;
  }

  const reasons = [];
  if (admitted.length < minAdmitted) {
    reasons.push(
      `only ${admitted.length} case(s) admitted; ${minAdmitted} required ` +
        `(a case counts only when the control actually fails it)`
    );
  }
  if (avoidedRate === null) reasons.push('no admitted cases, so the avoided rate is undefined');
  else if (avoidedRate < avoidedBar) {
    reasons.push(`avoided rate ${(avoidedRate * 100).toFixed(0)}% is below the ${avoidedBar * 100}% bar`);
  }
  if (regressions.length > maxRegressions) {
    reasons.push(`${regressions.length} regression(s); the bar is ${maxRegressions}`);
  }

  return {
    verdict: reasons.length ? 'FAIL' : 'PASS',
    reasons,
    admitted: admitted.map((s) => s.id),
    excluded: excluded.map((s) => s.id),
    rescued: rescued.map((s) => s.id),
    regressions: regressions.map((s) => s.id),
    avoidedRate,
    byClass,
    tokens: {
      comparableCases: comparable.map((s) => s.id),
      control: controlTokens,
      treatment: treatmentTokens,
      delta: treatmentTokens - controlTokens,
    },
  };
}

/** A human-readable report. Raw counts first, verdict last. */
export function report(g) {
  const lines = [];
  lines.push(`admitted : ${g.admitted.length}  [${g.admitted.join(', ') || '-'}]`);
  lines.push(`excluded : ${g.excluded.length}  [${g.excluded.join(', ') || '-'}]   (control got these right; they measure nothing)`);
  lines.push(`rescued  : ${g.rescued.length}  [${g.rescued.join(', ') || '-'}]`);
  lines.push(
    `avoided  : ${g.avoidedRate === null ? 'undefined' : (g.avoidedRate * 100).toFixed(0) + '%'}`
  );
  lines.push(`regress. : ${g.regressions.length}  [${g.regressions.join(', ') || 'none'}]`);
  for (const [cls, v] of Object.entries(g.byClass)) {
    lines.push(`  class ${cls.padEnd(14)} ${v.rescued}/${v.admitted} rescued`);
  }
  lines.push(
    `tokens   : control ${g.tokens.control}, treatment ${g.tokens.treatment}, ` +
      `delta ${g.tokens.delta >= 0 ? '+' : ''}${g.tokens.delta} over ${g.tokens.comparableCases.length} comparable case(s)`
  );
  lines.push(`VERDICT  : ${g.verdict}`);
  for (const r of g.reasons) lines.push(`  - ${r}`);
  return lines.join('\n');
}
