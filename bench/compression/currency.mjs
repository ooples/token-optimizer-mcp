/**
 * The currency every published figure is denominated in.
 *
 * WHAT THIS REPLACES, AND WHY IT HAD TO GO. Every number this harness has ever
 * printed was `Math.ceil(chars / 4)`. The defence of that was that an
 * approximation applied identically to both arms cancels out of a comparison.
 * Measured, it does not:
 *
 *   - IT IS NOT ONE RATIO. Our prose markers run 2.60 characters per token and
 *     the control's hex markers run 2.16, so chars/4 charged theirs less than
 *     ours for the same job. Whole bodies run 2.66 to 2.93.
 *   - IT IS NOT NEUTRAL ON A VERDICT. Re-denominated in cl100k, the
 *     `codebase-exploration` row moved 10.5 points -- 64.7% to 54.2% -- against
 *     a published competitor figure of 47.4%, while three other rows moved by a
 *     tenth. A currency that moves one row ten points and another by nothing is
 *     not cancelling; it is weighting.
 *   - IT ROUNDS. `Math.ceil` erases any difference under four characters, which
 *     is how a false invariant -- that re-anchoring is free -- stayed green on
 *     five fixtures while the thing it asserted was not true.
 *
 * cl100k is not the answer either: it is OpenAI's tokenizer, and nothing here
 * is billed by OpenAI. The only authority for what a request costs on a Claude
 * subscription is Anthropic's own count, so that is what this module serves --
 * `POST /v1/messages/count_tokens`, which is free and spends no quota, recorded
 * once into a fixture so CI stays hermetic and offline.
 *
 * HOW A COUNT IS DEFINED. `count_tokens` prices a whole request, so one string
 * is measured as one user message carrying one text block, less the envelope
 * that request costs when it carries nothing. The envelope is measured, never
 * assumed: a ladder of n copies of a single-token word returned 8, 9, 10, 11,
 * 15, 23, 39, 71 for n = 1, 2, 3, 4, 8, 16, 32, 64 -- exactly linear, slope 1,
 * intercept 7 -- so the envelope is 7 and `tokens(text)` is `count(text) - 7`.
 * The recorder re-measures that ladder on every re-record and refuses to write
 * a fixture if it is not linear.
 *
 * IT IS ALSO A CROSS-PROCESS DETERMINISM GATE, which is not what it was for.
 * A count is keyed on the exact bytes, so a figure derived from a string the
 * harness did not emit last time cannot be produced at all -- the lookup throws
 * and names the digest. That is how the random marker stamp was found: 206
 * strings differed on every run while the length multiset and the total
 * character count were identical, so `Math.ceil(chars / 4)` reported the same
 * figures twice. Nothing in the suite compared two runs' numbers, and under the
 * old currency nothing could have.
 *
 * WHAT REMAINS APPROXIMATE, stated plainly: a request's blocks are counted one
 * at a time and summed, so a BPE merge spanning two blocks is credited to
 * neither. That is the harness's block accounting rather than the currency, it
 * is identical for every arm, and it cannot weight one arm against another.
 *
 * ON A MISS IT REFUSES. A fixture keyed by content digest goes stale the moment
 * an engine changes a byte of what it emits, and the tempting thing then is to
 * fall back to chars/4 for whatever is missing. That publishes a figure which
 * is part measured and part estimated while reporting it as measured -- the
 * fabricated-measurement failure this repository guards against everywhere
 * else. So a miss throws, names the command that records it, and CI stays red
 * until the new content has been counted.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Digests and counts only. Never the text they were measured on. */
export const FIXTURE = join(HERE, 'token-counts.json');

export const RECORD_COMMAND = 'node bench/compression/record-token-counts.mjs';

/** The model the counts are for. A different model is a different fixture. */
export const MODEL = 'claude-sonnet-4-5-20250929';

export const digest = (text) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

let cache = null;

function fixture() {
  if (cache) return cache;
  if (!existsSync(FIXTURE))
    throw new Error(
      `no token-count fixture at ${FIXTURE}. Record it with:\n  ${RECORD_COMMAND}`
    );
  const parsed = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  if (parsed.model !== MODEL)
    throw new Error(
      `token-count fixture was recorded for ${parsed.model}, not ${MODEL}. Re-record with:\n  ${RECORD_COMMAND}`
    );
  if (typeof parsed.envelope !== 'number')
    throw new Error(`token-count fixture has no measured envelope`);
  cache = parsed;
  return cache;
}

/** The measured cost of a request that carries nothing, for the recorder. */
export const envelope = () => fixture().envelope;

/**
 * Census mode: used by the recorder, and by nothing else.
 *
 * Recording is a fixed point, not a single pass. The only way to know which
 * strings this harness asks about is to run it, and running it needs an answer
 * for every string -- including the ones that are not recorded yet. So in
 * census mode a miss is written down and answered provisionally with the old
 * chars/4 ratio, the run completes, the recorder counts what it collected, and
 * the recorder then runs the harness again in strict mode. Strict mode is the
 * guarantee: if the census had missed anything, the verification pass refuses.
 *
 * A provisional count can change which arm the harness calls best, so nothing
 * a census run prints is a measurement. The recorder discards its output, and
 * this announces itself on stderr so that a census run can never be mistaken
 * for a published one.
 */
const CENSUS = process.env.TOKEN_OPTIMIZER_BENCH_CENSUS;
let announced = false;

export function tokens(text) {
  // An empty block carries nothing, and `count_tokens` refuses to price a text
  // block that is empty or all whitespace, so there is no count to record.
  if (text.length === 0) return 0;

  const counts = fixture().counts;
  const key = digest(text);
  const have = counts[key];
  if (typeof have === 'number') {
    // A HIT IS WRITTEN DOWN TOO, so the census is the set of strings this
    // harness prices rather than only the ones it could not price. The
    // recorder prunes anything outside that set: without hits it could not
    // tell a count it still needs from one left behind by an encoding that no
    // longer exists, and 190 counts of a retired marker stamp sat in the
    // fixture looking exactly like live ones.
    if (CENSUS)
      appendFileSync(CENSUS, `${JSON.stringify({ d: key })}\n`, 'utf8');
    return have;
  }

  if (CENSUS) {
    if (!announced) {
      announced = true;
      process.stderr.write(
        'currency: CENSUS MODE -- counts are provisional, output is not a measurement\n'
      );
    }
    appendFileSync(CENSUS, `${JSON.stringify({ d: key, t: text })}\n`, 'utf8');
    return Math.ceil(text.length / 4);
  }

  throw new Error(
    `no recorded token count for ${key} (${text.length} chars, starts ${JSON.stringify(text.slice(0, 48))}).\n` +
      `The content being measured has changed since the counts were recorded. Re-record with:\n  ${RECORD_COMMAND}`
  );
}
