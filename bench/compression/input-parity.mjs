/**
 * WERE THE TWO COLUMNS HANDED THE SAME BYTES?
 *
 * This is the precondition for every other number in the record, and until now
 * nothing anywhere asserted it. Their nine-arm sweep wraps a payload that is not
 * already a transcript into a role/content envelope before handing it to its
 * `pipeline@*` arms: on log-entries, search-results, api-responses and
 * database-rows, six of their nine arms therefore run on an input 13-15% LARGER
 * than the one ours was given -- 120,572 characters against 105,155 on
 * log-entries.
 *
 * WHY THAT IS NOT A SMALL THING. A compression ratio is `1 - after / before`, so
 * a bigger `before` is a bigger ratio for the same output; a millisecond spent on
 * more text is not a slower engine; and the identifier denominator is a scan of
 * the input, so a wrapped input has units ours never saw. Chars, speed, cost and
 * retention all inherit the defect from one place.
 *
 * NO PUBLISHED NUMBER IS WRONG TODAY. All eighteen credited winners match ours
 * byte for byte, which is exactly why this is worth writing now: the guard costs
 * nothing while it is true, and the day a wrapped arm wins its row, the record
 * would otherwise publish an inflated percentage as a like-for-like comparison
 * and nothing would say so.
 *
 * A MISSING FIELD IS NOT A PASS. A capture taken before the field existed cannot
 * answer the question, and the honest verdict for a question the run cannot
 * answer is `null` -- the same three-state rule `speed-verdict.mjs` follows. The
 * tempting `if (parity && ...)` spelling, which treats an absent field as
 * agreement, is the defect this module exists to make impossible; it is mutant
 * `the missing parity field is read as agreement`.
 */

/**
 * @param {{oursDigest?: string|null, theirsDigest?: string|null, same?: boolean}
 *   |null|undefined} input as recorded on the row
 * @returns {{ok: boolean|null, detail: string}}
 */
export function inputParity(input) {
  if (input === null || input === undefined)
    return {
      ok: null,
      detail:
        'the record does not say what input their arm was given, so this row ' +
        'cannot be compared - re-record it',
    };
  const ours = typeof input.oursDigest === 'string' ? input.oursDigest : null;
  const theirs = typeof input.theirsDigest === 'string' ? input.theirsDigest : null;
  if (ours === null || theirs === null)
    return {
      ok: null,
      detail:
        'one side of this row has no input digest (' +
        (ours ?? 'ours missing') +
        ' vs ' +
        (theirs ?? 'theirs missing') +
        '), so there is nothing to compare it against',
    };
  // THE DIGESTS DECIDE, NOT THE FLAG. `same` is written by the same pass that
  // writes the digests, so trusting it would let one bug make a row agree with
  // itself; the two are cross-checked and a disagreement is undecided rather
  // than resolved in either direction.
  const agree = ours === theirs;
  if (typeof input.same === 'boolean' && input.same !== agree)
    return {
      ok: null,
      detail:
        'the record says same=' +
        input.same +
        ' while its own digests say ' +
        (agree ? 'they agree' : 'they differ') +
        ' - the record contradicts itself',
    };
  if (agree) return { ok: true, detail: 'both arms were given ' + ours };
  return {
    ok: false,
    detail:
      'their arm was measured on ' + theirs + ', ours on ' + ours + ' - not a comparison',
  };
}
