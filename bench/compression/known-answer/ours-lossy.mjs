/**
 * PROFILE: LOSSY BY A STATED AMOUNT. The arms drop identifiers on purpose.
 *
 * Retention is the column that keeps a compression ratio honest, and it has
 * never been tested against an arm whose losses were known in advance -- only
 * against whatever our engine happened to do, where "336 retained" is a number
 * nobody can check. Here the loss is chosen, so the instrument has a right
 * answer:
 *
 *   default   deletes every occurrence of the LAST `DROP` identifiers.
 *             Each fixture identifier appears exactly once (a premise layer 1
 *             verifies), and each is `ID_CHARS` characters, so
 *                 after  = before - DROP * ID_CHARS
 *                 gone   = DROP
 *                 inOut  = ids - DROP
 *             on ka-identifiers, and after == before with gone == 0 everywhere
 *             else, because no other fixture plants one.
 *
 *   sub       deletes the same identifiers AND writes them to the spill sink.
 *             Nothing is unreachable: `subUnrecoverable` must be 0. This is the
 *             positive control for the third retention bucket -- a null or a
 *             zero here would mean the probe cannot see a sink that is plainly
 *             there.
 *
 *   preset    deletes nothing. The arm that loses nothing sits in the same
 *             table as the two that do, so a gate reading `gone` cannot be
 *             passing because every arm agrees.
 *
 * THE THREE ARMS MUST DISAGREE. A stub where they behaved alike would let a
 * scorer that scored one arm three times look correct.
 */

import { armOf, bodyResult, ID } from './ours-arms.mjs';

/** How many of the planted identifiers the lossy arms delete. */
export const DROP = 16;
/** `KA-ID-0000` -- fixed width, so the byte arithmetic above is exact. */
export const ID_CHARS = 10;

/** The last `DROP` identifiers present in `text`, in first-appearance order. */
export function dropped(text) {
  const seen = [...new Set(text.match(ID) ?? [])];
  return seen.slice(-DROP);
}

function strip(text) {
  let out = text;
  for (const id of dropped(text)) out = out.split(id).join('');
  return out;
}

export function compressBlock(text, options) {
  const arm = armOf(options);
  if (arm === 'preset') return { text };
  const out = strip(text);
  if (arm === 'sub') {
    const gone = dropped(text);
    // One spilled block per evicted identifier, so the sink is exercised the
    // way a real arm exercises it rather than with a single concatenation.
    for (const id of gone) options.spill(`${id} value=spilled`, 'ka');
  }
  return { text: out };
}

export function compressBody(buffer) {
  return bodyResult(strip(buffer.toString('utf8')));
}
