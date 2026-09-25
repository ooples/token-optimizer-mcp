/**
 * WHICH IDENTIFIERS SURVIVED, AND WHICH COLUMNS WERE ACTUALLY MEASURED.
 *
 * The retention table asks one question per identifier: after an arm has run,
 * can the agent still get at it, and at what cost? There are four answers, in
 * increasing price:
 *
 *   inOut    it is literally in the output -- free
 *   derived  the published decoder rebuilds it from the output alone -- free
 *   inSpill  it is in a block the arm evicted, so one Read gets it back
 *   gone     nothing in the output leads to it
 *
 * WHY THIS IS ITS OWN FILE. It used to be a loop inside `head-to-head.mjs`,
 * which exports nothing and takes minutes to run against real fixtures, so the
 * classification had no test and one of its columns was wrong for as long as it
 * existed. The arithmetic is pure, so it can be checked on inputs whose answer
 * is known, and that is the only reason the extraction is worth the indirection.
 *
 * THE BUG THIS FILE EXISTS TO PREVENT, STATED PLAINLY. The headline `ours` arm
 * runs WITHOUT A SPILL SINK: `spilled` is a literal empty array, so the third
 * branch below can never fire, so `inSpill` came out 0 on all twelve workloads.
 * Zero is what a measurement looks like when it found nothing. This one had
 * found nothing because it could not look. Published beside three columns that
 * WERE measured, it read as "our arm spills nothing and loses nothing", which
 * happens to be true, but not for the reason the column appeared to be giving.
 *
 * So a sinkless arm reports `inSpill: null`. Null is a statement about the
 * measurement; zero is a statement about the arm; rounding the first to the
 * second is exactly the move that made the column worthless. The arms that DO
 * have a sink -- `preset` and `sub` -- report a number, and the check file
 * arms a positive control proving the branch fires when a sink exists, so a
 * future null can only mean "no sink" and never "the probe broke".
 */

/** Eight characters with a digit: a coincidental substring match is not a real risk. */
const MIN_ID_LEN = 8;

/**
 * Sort every wanted identifier into exactly one of the four buckets.
 *
 * `hasSink` is the caller's declaration that this arm was given somewhere to
 * evict to. It is deliberately NOT inferred from `spill` being empty: an arm
 * with a sink that happened to evict nothing is a measured zero, and an arm
 * with no sink is an unasked question, and those two must not collapse.
 *
 * Order matters and is cheapest-first. An identifier that is both literally
 * present and also in a spilled block is free, not one Read away, so `inOut`
 * has to be tested before `inSpill`.
 */
export function classifyIds({
  ids,
  output = '',
  reconstructed = '',
  spill = '',
  hasSink = false,
  sampleMissing = 5,
}) {
  // AN IDENTIFIER TOO SHORT TO SCORE BY SUBSTRING IS NOT SCORED AT ALL.
  // Every branch here is `includes`, so a 3-character id matches by accident
  // somewhere in a 700KB document and lands in `inOut` as a free pass. That is
  // a credit we would be awarding ourselves for a coincidence, so short ids
  // leave the denominator entirely and are counted where a reader can see them.
  const want = [];
  const unsafeIds = [];
  for (const id of ids) (String(id).length >= MIN_ID_LEN ? want : unsafeIds).push(id);
  let inOut = 0;
  let derived = 0;
  let inSpill = 0;
  let gone = 0;
  const missing = [];

  for (const id of want) {
    if (output.includes(id)) inOut++;
    else if (reconstructed.includes(id)) derived++;
    else if (hasSink && spill.includes(id)) inSpill++;
    else {
      gone++;
      if (missing.length < sampleMissing) missing.push(id);
    }
  }

  return {
    ids: want.length,
    inOut,
    derived,
    // NOT ZERO. See the header: a sinkless arm was never asked the question.
    inSpill: hasSink ? inSpill : null,
    gone,
    missing,
    // Free means the agent pays no round trip, which is the column the
    // head-to-head actually compares across engines.
    zeroTurn: inOut + derived,
    hasSink,
    // Excluded from every count above, and named so the exclusion is visible
    // rather than a silently smaller denominator.
    unsafeIds,
  };
}
