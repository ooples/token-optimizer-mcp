/**
 * The one thing every consumer of a capture must ask before scoring it.
 *
 * `run-theirs.py` can be driven by stub arms whose output is arithmetic, so the
 * harness can be tested against answers fixed in advance (see known-answer/).
 * Those captures are the most dangerous file this project produces: complete,
 * well-formed, every field populated, and a description of nobody's engine.
 * Scored by accident they would read as an overwhelming win.
 *
 * This lives in its own module rather than inline in head-to-head.mjs so that
 * it can be exercised offline -- head-to-head pulls in tiktoken and the built
 * `dist/`, so a check that could only reach this guard by spawning the scorer
 * would be unrunnable exactly where it matters most, in a clean CI checkout.
 */

/** A refusal message, or null when the capture is a real measurement. */
export function stubbedCaptureRefusal(theirs, dir = '<capture>') {
  const stub = theirs?.__provenance__?.stubArms;
  if (typeof stub !== 'string' || stub.length === 0) return null;
  return (
    `refusing ${dir}: this capture was taken with stub arms (${stub}), so it ` +
    'measures the harness and not any engine. Re-run ' +
    'bench/compression/headroom/run-theirs.py without BENCH_KNOWN_ANSWER_ARMS.'
  );
}
