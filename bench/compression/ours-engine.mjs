/**
 * OUR SIDE OF THE TABLE, MADE SUBSTITUTABLE -- to test the scorer, never to publish.
 *
 * `run-theirs.py` already has this seam (see known-answer/arms.py): their engine
 * can be replaced by arms whose output is a closed-form function of their input,
 * so the capture path can be checked against answers fixed before the run. That
 * proved the capture records what it was given. It says nothing about the
 * SCORER, because the scorer's other column comes from here, and a live
 * compressor produces numbers nobody can state in advance either.
 *
 * So this module is the matching seam. With BENCH_KNOWN_ANSWER_OURS pointing at
 * a stub module, `compressBlock` and `compressBody` come from the stub and every
 * figure head-to-head prints -- chars, tokens, retention, the session-cost table
 * -- becomes computable on paper. Everything else the scorer calls stays real:
 * the tokeniser, `classifyIds`, `classifyArms`, the decoder used by the
 * recoverability probe, the cost model. Those are the code under test. Only the
 * thing being MEASURED is replaced, exactly as on their side.
 *
 * A RUN THROUGH THIS SEAM IS NOT A MEASUREMENT OF ANYTHING. head-to-head stamps
 * the record and refuses to write one into the published results directory; see
 * `stubbedScorerRefusal` below.
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/** The stub module path, or null on a real run. Read once, so it cannot drift. */
export const KNOWN_ANSWER_OURS = process.env.BENCH_KNOWN_ANSWER_OURS || null;

let impl;
if (KNOWN_ANSWER_OURS) {
  impl = await import(pathToFileURL(resolve(KNOWN_ANSWER_OURS)).href);
  console.error(
    `KNOWN-ANSWER SCORER RUN via ${KNOWN_ANSWER_OURS} -- this measures the scorer, not any engine`
  );
} else {
  const [router, server] = await Promise.all([
    import('../../dist/compress/router.js'),
    import('../../dist/proxy/server.js'),
  ]);
  impl = { compressBlock: router.compressBlock, compressBody: server.compressBody };
}

/** Compress one text block. Returns at least `{ text }`. */
export const compressBlock = (text, options) => impl.compressBlock(text, options);

/** Compress a whole request buffer. Returns at least `{ body, summary }`. */
export const compressBody = (buffer, spill) => impl.compressBody(buffer, spill);

/**
 * A refusal message, or null when our column came from the real engine.
 *
 * The mirror of `stubbedCaptureRefusal`: a stubbed capture describes nobody's
 * engine, and a stubbed scorer run describes nobody's product. Both are
 * complete, well-formed and entirely fictional, which is exactly why they have
 * to announce themselves rather than be recognised by eye.
 */
export function stubbedScorerRefusal(at) {
  if (!KNOWN_ANSWER_OURS) return null;
  if (!/(^|[\\/])results[\\/]/.test(at)) return null;
  return (
    `refusing to record to ${at}: BENCH_KNOWN_ANSWER_OURS is set ` +
    `(${KNOWN_ANSWER_OURS}), so our column is a stub and this record measures ` +
    'the scorer rather than any engine. Published records live under results/ ' +
    'and must come from an unstubbed run.'
  );
}
