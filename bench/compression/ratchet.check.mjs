/**
 * KNOWN ANSWERS FOR THE RATCHET'S PROVENANCE RULES.
 *
 * The case that matters is the one that shipped wrong: an entry recorded from a
 * capture that said nothing about their engine's capabilities must not be
 * inheritable, because that is exactly how five speed claims survived for a day
 * against a competitor running its Python fallback detector.
 */
import {
  FINGERPRINT_VERSION,
  instrumentFingerprint,
  readEntry,
  inheritance,
  retractionMap,
  writeEntry,
} from './ratchet.mjs';

let failed = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`);
};

const whole = {
  detectBackend: 'rust',
  kompressWarmup: { ready: true, waitedSeconds: 63.6 },
  competitorWarnings: { degraded: [], advisory: [{ count: 1116 }] },
  loadWitness: { ms: 46.02 },
};
const WHOLE = `${FINGERPRINT_VERSION}:detect=rust kompress=ready degraded=none witness=yes`;

console.log('fingerprint');
eq('a whole capture', instrumentFingerprint(whole), WHOLE);
eq('no provenance at all', instrumentFingerprint(null), `${FINGERPRINT_VERSION}:detect=unrecorded kompress=unrecorded degraded=unrecorded witness=no`);
// THE hr6/hr7 SHAPE. These captures recorded a digest and nothing else, so every
// capability field is unrecorded -- which is what made the bad promotion possible.
eq('digest only', instrumentFingerprint({}), `${FINGERPRINT_VERSION}:detect=unrecorded kompress=unrecorded degraded=unrecorded witness=no`);
// ADVISORY WARNINGS ARE NOT DEGRADATION. Their cache-aligner advisory fires 1116
// times on a healthy run; folding it in would force a re-earn on every capture.
eq(
  'advisory only still reads none',
  instrumentFingerprint({ ...whole, competitorWarnings: { degraded: [], advisory: [{ count: 9 }] } }),
  WHOLE
);
// A WARM RE-CAPTURE MUST INHERIT. Same capabilities, different wait and witness
// reading: the fingerprint may not move, or the ratchet re-earns itself forever.
eq(
  'a second warm capture matches',
  instrumentFingerprint({
    detectBackend: 'rust',
    kompressWarmup: { ready: true, waitedSeconds: 7.8 },
    competitorWarnings: { degraded: [], advisory: [] },
    loadWitness: { ms: 45.17 },
  }),
  WHOLE
);
eq('a degraded capture differs', instrumentFingerprint({ ...whole, competitorWarnings: { degraded: ['kompress'], advisory: [] } }), `${FINGERPRINT_VERSION}:detect=rust kompress=ready degraded=1 witness=yes`);
eq('the python detector differs', instrumentFingerprint({ ...whole, detectBackend: 'python' }), `${FINGERPRINT_VERSION}:detect=python kompress=ready degraded=none witness=yes`);
eq('an unloaded model differs', instrumentFingerprint({ ...whole, kompressWarmup: { ready: false, why: 'download' } }), `${FINGERPRINT_VERSION}:detect=rust kompress=notready degraded=none witness=yes`);
// A CHUNKED CAPTURE IS A DIFFERENT INSTRUMENT. Each slice sweeps against a CCR
// store the earlier slices have already grown, and the speed passes are separated
// by a chunk-sized sweep rather than a roster-sized one -- both move the columns
// this ratchet guards, so a pass earned on one sweep is not evidence about the
// other.
//
// THE FIRST CASE IS WHY FINGERPRINT_VERSION DID NOT MOVE FOR THIS FIELD. `a whole
// capture` above asserts WHOLE by value, and this asserts that the other shape a
// non-chunked capture comes in -- the explicit `chunk: null` a post-chunking whole
// sweep writes -- produces exactly that string too. So no recorded entry changes
// meaning and none has to be re-earned; a chunked capture simply earns its own.
eq('a whole sweep says so explicitly and still matches', instrumentFingerprint({ ...whole, chunk: null }), WHOLE);
eq(
  'a merged capture differs',
  instrumentFingerprint({ ...whole, chunk: null, mergedFromChunks: 4 }),
  `${WHOLE} chunks=4`
);
// A LEGITIMATE RE-CAPTURE OF A CHUNKED SWEEP MUST STILL INHERIT, on the same
// grounds as `a second warm capture matches`: the seam's own numbers differ
// between two runs, the number of chunks does not.
eq(
  'the same split twice matches',
  instrumentFingerprint({
    ...whole,
    chunk: null,
    mergedFromChunks: 4,
    chunkSeam: { warmupsPaid: 4, speedPassSeparation: 'chunk' },
  }),
  `${WHOLE} chunks=4`
);
eq(
  'a different split differs',
  instrumentFingerprint({ ...whole, chunk: null, mergedFromChunks: 6 }),
  `${WHOLE} chunks=6`
);
// ONE CHUNK'S OWN FILE IS NOT A SWEEP. It holds part of a roster and no merge
// count; reading it as a whole capture is the flattering direction.
eq(
  'an unmerged chunk is not a whole capture',
  instrumentFingerprint({ ...whole, chunk: { selector: '--chunk 2/4', index: 2, of: 4 } }),
  `${WHOLE} chunks=unrecorded`
);

console.log('entries');
eq('the legacy bare true', readEntry(true), { enforced: true, fingerprint: null, capture: null });
eq('a provenanced entry', readEntry(writeEntry('hr27', WHOLE)), { enforced: true, fingerprint: WHOLE, capture: 'hr27' });
eq('an absent key', readEntry(undefined), { enforced: false, fingerprint: null, capture: null });
eq('false is not enforced', readEntry(false), { enforced: false, fingerprint: null, capture: null });

console.log('inheritance');
eq('matching fingerprint inherits', inheritance(writeEntry('hr27', WHOLE), WHOLE), { inherit: true, reason: null });
// THE LOAD-BEARING CASE, and the one that was wrong in production.
eq('a legacy entry does not inherit', inheritance(true, WHOLE), {
  inherit: false,
  reason: 'recorded before the instrument was fingerprinted, so what it was measured against is unknown',
});
eq('a changed instrument does not inherit', inheritance(writeEntry('hr7', `${FINGERPRINT_VERSION}:detect=python kompress=notready degraded=unrecorded witness=no`), WHOLE), {
  inherit: false,
  reason: `recorded against ${FINGERPRINT_VERSION}:detect=python kompress=notready degraded=unrecorded witness=no, this capture is ${WHOLE}`,
});
eq('an unenforced key has no reason', inheritance(undefined, WHOLE), { inherit: false, reason: null });

console.log('retraction map');
// THE BUG THIS RULE FIXES: a key that was retracted and has now passed again was
// left in both maps at once, with nothing to say which verdict was current.
eq(
  'a re-earned retraction is stamped, not dropped',
  retractionMap(
    { 'a/speed': { reason: 'unknown instrument', pass: false } },
    {},
    { 'a/speed': writeEntry('hr27', WHOLE) },
    'hr27',
    WHOLE
  ),
  { 'a/speed': { reason: 'unknown instrument', pass: false, supersededBy: { capture: 'hr27', fingerprint: WHOLE } } }
);
eq(
  'a retraction with no matching pass is left exactly as it was',
  retractionMap({ 'b/speed': { reason: 'unknown instrument', pass: false } }, {}, {}, 'hr27', WHOLE),
  { 'b/speed': { reason: 'unknown instrument', pass: false } }
);
// A FRESH RETRACTION WINS OVER A CARRIED ONE, so a key that failed again this run
// records THIS run's verdict rather than keeping a stale reason with a stamp.
eq(
  'a fresh retraction replaces the carried one',
  retractionMap(
    { 'c/speed': { reason: 'old', pass: false } },
    { 'c/speed': { reason: 'new', pass: false } },
    {},
    'hr27',
    WHOLE
  ),
  { 'c/speed': { reason: 'new', pass: false } }
);
eq('no retractions at all', retractionMap(undefined, undefined, {}, 'hr27', WHOLE), {});

console.log(failed === 0 ? 'ratchet provenance: all cases hold' : `ratchet provenance: ${failed} case(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
