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
  const [router, server, anchor] = await Promise.all([
    import('../../dist/compress/router.js'),
    import('../../dist/proxy/server.js'),
    import('../../dist/compress/anchor.js'),
  ]);
  impl = {
    compressBlock: router.compressBlock,
    compressBody: server.compressBody,
    engineNameFor: router.engineNameFor,
    anchorStore: anchor.anchorStore,
  };
}

/**
 * Which of our engines claims this text, or null when none of them does.
 *
 * WHY A BENCHMARK NEEDS THIS. An unclaimed block is returned untouched, so our
 * column reads a 0% saving -- which is indistinguishable, in the published
 * table, from an engine that ran and found nothing to remove. The two are not
 * the same claim: the first says our product declined the input, the second
 * says it examined it. A malformed fixture lands in the first case and would
 * publish as the second.
 *
 * MEASURED, not hypothetical: every payload in every capture under an `hr<n>` out-dir
 * is claimed by `json` today, and truncating one of those payloads to 98% of
 * its length makes it invalid JSON, drops the claim to null, and cuts its
 * measured time by ~3x. A scaling sweep built on prefixes of these payloads
 * therefore compares a real run against a no-op and reads as superlinear cost.
 *
 * Null on a known-answer run, where the question does not apply: the stub is
 * not an engine and head-to-head already refuses to publish such a record.
 */
export const engineNameFor = (text) =>
  typeof impl.engineNameFor === 'function' ? impl.engineNameFor(text) : null;

/** Compress one text block. Returns at least `{ text }`. */
export const compressBlock = (text, options) => impl.compressBlock(text, options);

/**
 * Compress a whole request buffer. Returns at least `{ body, summary }`.
 *
 * `anchors` IS NOT OPTIONAL IN PRODUCTION, so a harness that omits it is not
 * measuring the shipped arm. src/proxy/server.ts builds one store at startup
 * (`const anchors = anchorStore()`, :1306) and passes it on every request with
 * no env flag to turn it off, so every request after the first sees a warm
 * store. A benchmark that calls this with two arguments measures a permanently
 * cold proxy -- the first turn of a session, over and over.
 */
export const compressBody = (buffer, spill, anchors) =>
  impl.compressBody(buffer, spill, anchors);

/**
 * A fresh anchor store, or null when this run cannot have one.
 *
 * Null on a known-answer run: the stub is not an engine, it does not read a
 * store, and a warm column taken against it would be the cold column printed
 * twice under a second name.
 */
export const anchorStore = () =>
  typeof impl.anchorStore === 'function' ? impl.anchorStore() : null;

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
