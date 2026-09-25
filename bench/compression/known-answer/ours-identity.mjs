/**
 * PROFILE: IDENTITY. Every arm returns its input unchanged.
 *
 * The zero of the whole instrument. An engine that did nothing must be scored
 * as having done nothing, and every figure in the table has a value that can be
 * written down before the run:
 *
 *   chars.ours        0.0% on every workload, and 0.0% in the totals
 *   tokens.ours       0.0%, which also proves the token column is not being
 *                     derived from the char column by some other route
 *   retention         every identifier inOut, derived 0, gone 0
 *   recoverable       null on the headline arm (no sink) and 0 on sub/preset
 *                     (a sink that was given nothing), which is the distinction
 *                     retention.mjs exists to keep
 *   spillStore        0.00x
 *
 * A scorer that reports anything but zero here is measuring its own envelope,
 * its own denominator, or its own rounding -- and every one of those has
 * actually happened on this project.
 */

import { armOf, bodyResult } from './ours-arms.mjs';

export function compressBlock(text, options) {
  armOf(options); // still asserts head-to-head's arm shape hasn't drifted
  return { text };
}

export function compressBody(buffer) {
  return bodyResult(buffer.toString('utf8'));
}
