/**
 * THE RETENTION MUST-WIN, AS A FUNCTION, SO THAT IT CAN BE TESTED ON READINGS
 * WHOSE RIGHT ANSWER IS KNOWN -- the same move `speed-verdict.mjs` records, made
 * for the same reason and after the same class of defect.
 *
 * IT DECIDED VERDICTS IN THE WRONG UNITS. The bar lived inline in
 * `must-win.check.mjs` as an absolute count of identifiers retained, ratcheted
 * across runs. An identifier count is denominated in a set THE INSTRUMENT
 * DEFINES, and correcting the instrument is allowed: the scan used to admit 283
 * units that were not literal substrings of their own payload (no arm could ever
 * be credited with keeping one) and to miss the short real keys beside them.
 * When that was fixed the denominator moved -- 14,067 to 13,784 -- and NINE rows
 * reported a retention regression while every one of them held 100% of every
 * unit available to it.
 *
 * A bar that a corrected instrument fails is not a strict bar, it is a bar in
 * the wrong units, and the two ways out of it are both bad: re-deriving the
 * numbers every time the instrument changes is how a ratchet quietly becomes
 * whatever today's run scored, and leaving it is how a green gate becomes
 * something nobody can act on.
 *
 * SO THE RATCHET BOUNDS WHAT WAS LOST, NOT WHAT WAS KEPT. `lost = ids - ours`
 * is a count of units this engine had and dropped, and it does not move when the
 * denominator does:
 *
 *   - a unit removed from the denominator because no arm could ever have kept it
 *     was never in `lost`, so the bound is unchanged;
 *   - a unit removed that we DID keep leaves `lost` unchanged too;
 *   - a unit ADDED that we drop raises `lost`, and the bound refuses it;
 *   - code that drops one more than it used to raises `lost`, and the bound
 *     refuses that as well.
 *
 * The floor is stored WITH the denominator it was measured against, so a floor
 * written before this rule existed -- a bare retained count -- is refused rather
 * than compared. `pass: null` is that refusal, and it is not a pass: the same
 * three-state rule speed uses, for the same reason.
 */

/**
 * @param {object} a
 * @param {number|null} a.ids the scorable denominator this capture found
 * @param {number|null} a.ours units available with no extra turn
 * @param {number|null} a.theirs the same count for their arm
 * @param {'ceiling'|number|null} a.story the bar the story set, null when this
 *   row is not a must-win on retention
 * @param {{lost: number, ids: number}|number|null|undefined} a.floor the ratchet
 * @returns {{pass: boolean|null, detail: string, lost: number|null}}
 */
export function retentionVerdict({ ids, ours, theirs, story, floor }) {
  if (ids === null || ids === undefined || ours === null || ours === undefined)
    return { pass: null, detail: 'ids not recorded', lost: null };
  // AN EMPTY DENOMINATOR IS NOT A PERFECT SCORE. Two payloads once scored zero
  // retention units, and "0 for us, 0 for them" was published as a tie when it
  // was an empty set reported as one. `ours >= ids` is true there for any arm,
  // including an arm that returned nothing at all.
  if (ids === 0)
    return {
      pass: null,
      detail: 'no scorable units in this payload, so nothing was tested',
      lost: null,
    };
  const lost = ids - ours;
  if (story === null || story === undefined)
    return { pass: null, detail: `${ours}/${ids} - not a must-win here`, lost };
  // A FLOOR WITH NO DENOMINATOR CANNOT BE COMPARED TO ONE, and guessing which
  // set it was counted over is how the wrong units got here in the first place.
  if (typeof floor === 'number')
    return {
      pass: null,
      detail:
        `${ours} of ${ids} - floor ${floor} is a retained count with no ` +
        'denominator, so re-derive it with --promote before trusting this row',
      lost,
    };
  // THE LABEL HAS TO STAY TRUE. `'ceiling'` means their arm holds every unit, so
  // the achievable form of beating them is to hold every unit too -- and the bar
  // is `ids` only BECAUSE their column sits there. Nothing checked that, so if
  // their column fell the gate would go on calling the full denominator "their
  // ceiling" and reporting a bar they no longer set.
  if (story === 'ceiling' && theirs !== ids)
    return {
      pass: null,
      detail:
        `${ours} of ${ids} - their column is at ${theirs}, so the full ` +
        'denominator is no longer the ceiling this bar was named for',
      lost,
    };
  // A STORY BAR IS A RETAINED COUNT TOO, and the same correction moved the
  // denominator out from under it: agent-loop-logs' story asks for 2,043 units
  // of a payload that now holds 2,034 scorable ones, so `ours >= 2043` is a bar
  // no arm can clear. Capping it at the denominator asks for every unit there
  // is, which is the strictest bar that exists on that payload -- and the loss
  // ratchet below is what keeps that from being a discount, because a row that
  // has ever been perfect may never drop one.
  const capped = story !== 'ceiling' && story > ids;
  const bar = story === 'ceiling' ? ids : Math.min(story, ids);
  const lostBar = floor === null || floor === undefined ? null : floor.lost;
  const lostOk = lostBar === null || lost <= lostBar;
  const note =
    story === 'ceiling'
      ? ' (their ceiling)'
      : capped
        ? ` (story says ${story}, capped to the ${ids} this payload holds)`
        : ` (story says ${story})`;
  const ratchet =
    lostBar === null
      ? ', no loss recorded yet'
      : `, lost ${lost} against a recorded ${lostBar}${lostOk ? '' : ' NO'}`;
  return {
    pass: ours >= bar && lostOk,
    detail: `${ours} of ${ids}, bar ${bar}${note}${ratchet}`,
    lost,
  };
}

/**
 * The floor to store after this run: the FEWEST units ever lost on this row,
 * with the denominator that count was taken over. A ratchet may only tighten,
 * so an existing floor is never raised -- and a run that could not measure the
 * loss at all leaves the floor exactly as it was.
 */
export function tightenFloor(floor, { ids, lost }) {
  if (lost === null || lost === undefined || ids === null || ids === undefined)
    return typeof floor === 'object' && floor !== null ? floor : undefined;
  const had = typeof floor === 'object' && floor !== null ? floor.lost : null;
  if (had !== null && had <= lost) return floor;
  return { lost, ids };
}
