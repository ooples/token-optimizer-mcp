/**
 * WHICH OF THEIR ARMS A CRITERION IS SCORED AGAINST.
 *
 * WHY THIS FILE EXISTS. Their sweep runs nine or ten arms over every payload and
 * publishes the one with the best compression ratio. Ratio is the right rule for
 * a compression claim and the wrong rule for everything else, because the arm it
 * selects is systematically their most destructive one. Measured on the twelve
 * carried and six of their own fixtures:
 *
 *   workload               their winner  their ratio  ids they keep  ids we keep
 *   grep-output            crusher             99.6%       4 of 1045         1005
 *   raw-build-log          router              99.8%       3 of  430          430
 *   codebase-exploration   router              99.7%       5 of  590          537
 *   search-results         crusher-lossy-ccr   95.7%      84 of  807          505
 *   api-responses          crusher-lossy-ccr   91.4%     100 of  714          699
 *   database-rows          crusher-lossy-ccr   90.6%     110 of  689          590
 *   sre-debugging          crusher-lossy-ccr   88.4%     514 of 3124         3116
 *   log-entries            crusher-lossy-ccr   83.3%     242 of 1185         1180
 *
 * On grep-output their credited winner turns 75,399 characters into 284 in
 * 2.2ms. Our engine took 8.3ms on the same payload and the gate read that as a
 * speed regression. It is not a speed regression; it is the time to delete text
 * measured against the time to encode it. The same arm's 99.6% sat in the chars
 * column as a compression figure we had lost to.
 *
 * WHAT THIS FILE DOES ABOUT IT. Nothing, on its own -- it picks arms, it does
 * not decide anything. It names TWO of their arms per workload:
 *
 *   best        their lowest-ratio arm, whatever it retained. Their strongest
 *               compression number, and the only honest opponent for a RETENTION
 *               claim: an arm that threw the payload away is exactly the arm a
 *               retention criterion should be compared against.
 *   comparable  their lowest-ratio arm that retained AT LEAST what we retained.
 *               The opponent for a compression, cost or speed claim, because it
 *               is the only one of their arms whose number answers "could they
 *               have done this while keeping what we kept?".
 *
 * A criterion is then scored against both and must win both -- see
 * `bothColumns` below and `columnsFor`, which says which criteria have two
 * columns at all.
 *
 * THIS DOES NOT LOWER ANY BAR. `comparable` is never easier to beat than
 * `best` on the metric that selected `best`: it is drawn from the same set with
 * a filter applied, so its ratio is at best equal. Requiring both is strictly
 * harder than requiring either. The one thing it changes is that a row can no
 * longer be lost to an arm that kept 4 identifiers out of 1045, or won on
 * retention against an arm nobody would run.
 */

/**
 * Their two arms for one workload.
 *
 * @param {Array<{arm: string, after: number, before: number, retained: number}>} candidates
 *   every arm of theirs that produced an output, with its own before-text length
 *   (their pipeline arms are fed a wrapped envelope and are scored against it,
 *   which is their sweep's own rule and the one that is fair to them).
 * @param {{ourRetained: number}} ours
 * @returns {{best: object|null, comparable: object|null, detail: string}}
 */
/**
 * HOW TWO ARMS ARE ORDERED, AND WHY A TIE IS NOT A COIN FLIP.
 *
 * Lower ratio first -- that is what "their best arm" means for a compression
 * claim. What matters is the tie, because ties are not rare: on browser-session
 * three of their arms (router, crusher, crusher-lossy-ccr) emit the SAME 611859
 * bytes from the same 782294, so all three sit at 0.7821 and the ratio cannot
 * separate them. Their measured times there are 284.4ms, 16.7ms and 15.8ms.
 *
 * Breaking that tie by name picks `crusher`; breaking it the way the capture
 * happened to enumerate picks `router`. The second is 18x slower for identical
 * output, so a speed claim scored against it is scored against the slowest arm
 * that produced their best bytes -- our own result inflated by their arm
 * selection rather than by our code. THE FASTER ARM IS THE HONEST OPPONENT, so
 * a ratio tie is broken by measured time, and only an unmeasured or equal time
 * falls through to the name (which keeps the choice deterministic, so a ratchet
 * entry means the same thing tomorrow).
 *
 * An arm with no recorded time cannot win the tie-break against one that has a
 * time: `null` sorts after any number here. It is not refused, because a tie in
 * ratio with a missing time is still decidable on the arms that do have one.
 */
export const rankArms = (a, b) => {
  if (a.ratio !== b.ratio) return a.ratio - b.ratio;
  const am = Number.isFinite(a.ms) ? a.ms : Number.POSITIVE_INFINITY;
  const bm = Number.isFinite(b.ms) ? b.ms : Number.POSITIVE_INFINITY;
  if (am !== bm) return am - bm;
  return a.arm < b.arm ? -1 : 1;
};

/**
 * THEIR BEST ARM ALONE, WITHOUT A RETENTION QUESTION.
 *
 * `selectArms` needs our retained count, because comparability is defined
 * against it. The best-of-any arm is not: it is the lowest ratio, full stop. The
 * capture is normalised through this before any workload is scored, so that
 * `bestText`, `ms` and the recorded chars/tokens all name the SAME arm that
 * `selectArms` will later call `best`. Two definitions of "their best arm" in
 * one record is how a 284ms arm came to stand in for a 16.7ms one.
 *
 * Returns null when no arm can be ranked -- the caller then keeps whatever the
 * capture already said and says so, rather than silently picking.
 */
export function bestByRatio(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const scored = [];
  for (const c of candidates) {
    const arm = c === null || c === undefined ? undefined : c.arm;
    if (typeof arm !== 'string' || arm === '') return null;
    if (!Number.isFinite(c.before) || c.before <= 0) return null;
    if (!Number.isFinite(c.after) || c.after < 0) return null;
    scored.push({
      arm,
      ratio: c.after / c.before,
      ms: Number.isFinite(c.ms) ? c.ms : null,
    });
  }
  return [...scored].sort(rankArms)[0];
}

export function selectArms(candidates, ours) {
  if (!Array.isArray(candidates) || candidates.length === 0)
    return {
      best: null,
      comparable: null,
      detail:
        'no arms recorded for this workload, so there is nothing to select ' +
        'from - re-run the capture',
    };
  const ourRetained = ours === null || ours === undefined ? undefined : ours.ourRetained;
  // NOT DEFAULTED TO ZERO. An unknown `ourRetained` treated as 0 makes every
  // arm comparable, including the one that kept 4 of 1045 -- the exact bar this
  // file exists to stop being used. So it is refused instead.
  if (!Number.isFinite(ourRetained) || ourRetained < 0)
    return {
      best: null,
      comparable: null,
      detail:
        'our retained count is not recorded, so no arm of theirs can be called ' +
        'comparable to it',
    };
  const scored = [];
  for (const c of candidates) {
    const arm = c === null || c === undefined ? undefined : c.arm;
    if (typeof arm !== 'string' || arm === '')
      return {
        best: null,
        comparable: null,
        detail: 'an arm in this capture has no name, so it cannot be selected or reported',
      };
    // A RATIO OVER A ZERO DENOMINATOR IS NOT A RATIO, and an arm whose
    // before-length was not recorded cannot be given one. Refused, not skipped:
    // a skipped arm could have been the comparable one, and quietly dropping it
    // substitutes a worse bar without saying so.
    if (!Number.isFinite(c.before) || c.before <= 0 || !Number.isFinite(c.after) || c.after < 0)
      return {
        best: null,
        comparable: null,
        detail:
          'arm ' + arm + ' has no usable before/after size (' + c.before + '/' + c.after + '), ' +
          'so its ratio cannot be computed and no arm can be ranked against it',
      };
    // SAME REASONING FOR RETENTION. Comparability is a claim about what an arm
    // kept; an arm we could not scan might have been the comparable one.
    if (!Number.isFinite(c.retained) || c.retained < 0)
      return {
        best: null,
        comparable: null,
        detail:
          'arm ' + arm + ' has no retained count, so it cannot be ruled in or out ' +
          'of comparability',
      };
    scored.push({
      arm,
      ratio: c.after / c.before,
      retained: c.retained,
      ms: Number.isFinite(c.ms) ? c.ms : null,
    });
  }
  const rank = rankArms;
  const ordered = [...scored].sort(rank);
  const best = ordered[0];
  const eligible = ordered.filter((c) => c.retained >= ourRetained);
  const comparable = eligible.length > 0 ? eligible[0] : null;
  const detail =
    'best ' + best.arm + ' at ' + (best.ratio * 100).toFixed(1) + '% of input keeping ' +
    best.retained + '; ' +
    (comparable === null
      ? 'no arm of theirs retained our ' + ourRetained
      : 'comparable ' + comparable.arm + ' at ' + (comparable.ratio * 100).toFixed(1) +
        '% of input keeping ' + comparable.retained);
  return { best, comparable, detail };
}

/**
 * WHICH CRITERIA HAVE TWO COLUMNS, AND WHY RETENTION DOES NOT.
 *
 * `comparable` is DEFINED as an arm that retained at least what we retained. So
 * "did we beat the comparable arm on retention?" has the same answer on every
 * row, for every engine, forever: no, at best a tie. A bar that cannot be
 * failed for any reason to do with the code under test is not a bar, and putting
 * one in the gate would turn eleven recorded retention passes into permanent
 * losses while measuring nothing.
 *
 * The retention criterion therefore keeps ONE column, and it is `best` -- their
 * most compressive arm, which is also their most destructive one. That is the
 * hard direction: it is the arm that makes us look worst on chars and best on
 * retention, and the gate reads both.
 *
 * This is stated here, in code, rather than left as an omission in the scorer,
 * because an omission cannot be tested and this can: the mutation battery flips
 * it and the check catches it.
 */
export function columnsFor(criterion) {
  if (criterion === 'retention')
    return {
      columns: ['best'],
      reason:
        'the comparable arm is defined as retaining at least what we retain, so a ' +
        'retention comparison against it has one answer on every row and tests nothing',
    };
  if (criterion === 'cost' || criterion === 'turns' || criterion === 'speed')
    return { columns: ['best', 'comparable'], reason: 'must win against both of their arms' };
  return {
    columns: [],
    reason: 'unknown criterion ' + String(criterion) + ', so no column can be chosen for it',
  };
}

/**
 * ONE VERDICT FROM TWO COLUMNS. Win both or it is not a win.
 *
 * THREE STATES, AND THE ORDER THEY RESOLVE IN:
 *   a decided LOSS on either column wins, because a measurement that refutes the
 *     claim refutes it whether or not the other column could be read;
 *   then an UNDECIDED column, because a column with no reading is not a pass --
 *     this is the whole reason the verdicts are three-valued;
 *   and only a pass on both is a pass.
 *
 * A MISSING ARGUMENT IS UNDECIDED, NEVER AGREEMENT. `bothColumns(best)` with no
 * second column returns null, not `best`. The defect spelling is
 * `if (comparable && comparable.pass === false)`, which reads an absent second
 * column as a pass on it.
 */
export function bothColumns(best, comparable) {
  const read = (v, which) =>
    v === null || v === undefined || !('pass' in v)
      ? { pass: null, detail: 'no ' + which + ' column recorded for this row' }
      : { pass: v.pass === true ? true : v.pass === false ? false : null, detail: String(v.detail ?? '') };
  const b = read(best, 'best-of-any');
  const c = read(comparable, 'comparable');
  const detail = 'vs best: ' + b.detail + ' | vs comparable: ' + c.detail;
  if (b.pass === false || c.pass === false) return { pass: false, detail };
  if (b.pass === null || c.pass === null) return { pass: null, detail };
  return { pass: true, detail };
}
