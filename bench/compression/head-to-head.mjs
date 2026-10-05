/**
 * The head-to-head: both engines run over OUR corpus, scored by one instrument.
 *
 * WHOSE FIXTURES THESE ARE, PER ROW. The 12 workloads in
 * `bench/compression/workloads/` are ours -- captured from this project's own
 * agent traffic. A capture may ALSO carry the six their own benchmark suite
 * generates, and those rows carry a different, much stronger claim: beating them
 * on fixtures they chose is not the same as beating them on fixtures we chose.
 * So the two are never summed into one headline. The table marks their rows with
 * `*`, the subtotals print separately, and the owner of each row is read from
 * THEIR provenance (`carriedPayloads`) rather than from a list kept on this side
 * that could drift away from what actually ran. An earlier
 * version of this comment called them "HeadRoom's own fixtures", which was
 * simply false, and it mattered: a corpus the opponent chose would make a win
 * far stronger evidence than a corpus we chose. Read every number below as
 * "on traffic we selected", and note that `run-theirs.py` hands their engine
 * the identical bytes -- verified byte-for-byte across captures -- so the
 * corpus is shared even though its provenance is not neutral.
 *
 * WHY IT IS COMMITTED. The numbers this project was quoting came from throwaway
 * scripts that no longer exist. An unreproducible headline is not evidence, it
 * is a memory -- so the instrument lives in the repo and the claim is
 * regenerated on demand rather than recalled.
 *
 * Run their side first, then redeem their markers, then score:
 *
 *   python bench/compression/headroom/run-theirs.py <headroom-clone> <out-dir>
 *   python bench/compression/headroom/resolve-theirs.py <headroom-clone> <out-dir>
 *   node bench/compression/head-to-head.mjs <out-dir>
 *
 * FOUR RULES, because each of them has already caught a wrong answer in this work:
 *
 * 1. SAME BYTES. Ours compresses the exact payload theirs was given, read from
 *    their harness's own dump. Not a reimplementation of their fixtures.
 *
 * 2. BOTH DENOMINATORS, NAMED, AND ACTUALLY DIFFERENT. Characters, and tokens
 *    from Anthropic's own count_tokens, run over both arms' real output. An
 *    earlier version counted tokens as chars/4, which made the second column a
 *    rescaling of the first and the phrase "both denominators" untrue.
 *
 * 3. SYMMETRIC CONFIGURATION. Their router takes a `question`; ours takes a
 *    `query`. Both get it, from the same place. Twice in this work a flattering
 *    number was the competitor misconfigured, and once an unflattering one was
 *    OUR side misconfigured -- the audit has to run on both arms or it is just
 *    a bias with extra steps.
 *
 * 4. RETENTION IS SCORED AFTER RECOVERY, ON BOTH ARMS, AND NOT ASSUMED. A
 *    compressor that deletes the answer wins on size and loses on the only
 *    thing that matters -- but so does a scorer that calls recoverable content
 *    lost. Both arms elide into something, so both arms are asked to give it
 *    back before anything is counted as gone: ours by decoding the output with
 *    the reference decoder in `src/compress/rehydrate.ts`, theirs by handing
 *    their marker text to their own resolver in a SEPARATE, LATER PROCESS
 *    (`resolve-theirs.py`). Searching raw output text for substrings, which is
 *    what this file used to do, reported factored-but-present identifiers as
 *    losses on BOTH sides and was the single largest error in it.
 *
 * Exits non-zero if we lose on either denominator, if any identifier is
 * unrecoverable.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

import {
  discriminatingFloor,
  unaccounted,
  FLOORS,
  MIN_WORD_LEN,
} from './conservation.mjs';

/** The lowest floor `discriminatingFloor` will try, named for the message. */
const MIN_FLOOR = Math.min(...FLOORS);
import { classifyIds, splitScorable } from './retention.mjs';
import { scanIdentifiers } from './identifiers.mjs';
import { bestByRatio, selectArms } from './arm-selection.mjs';
import { witness, witnessesAgree } from './load-witness.mjs';
import { resolutionUsable } from './store-resolution.mjs';
import { measureOurFetch, slowEstimate } from './fetch-latency.mjs';
import {
  classifyArms,
  declaredOffloadBytes,
  judgeRows,
  corpusFaults,
} from './offload.mjs';
import { stubbedCaptureRefusal } from './capture-guard.mjs';
import { readBaseContext } from '../subscription/base-context.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { FIXTURE, MODEL, tokens as countText } from './currency.mjs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { reproducibilityRefusal } from './reproducibility.mjs';
import { instrumentFingerprint } from './ratchet.mjs';
import { recoverable, refusals, pathRefusals } from './recovery.mjs';
// THE ONE SEAM ON OUR SIDE. Both engines reach this scorer through a module
// that can be swapped for stub arms, so every figure below has an answer that
// can be stated before the run. See ours-engine.mjs; the other dist imports
// stay direct because they are instruments, not the thing being measured.
import {
  compressBlock,
  engineNameFor,
  compressBody,
  anchorStore,
  KNOWN_ANSWER_OURS,
  stubbedScorerRefusal,
} from './ours-engine.mjs';
import { resolveTuning } from '../../dist/compress/options.js';
import { imageSize } from '../../dist/compress/images.js';
import {
  DEFAULTS,
  breakEven,
  breakEvenLabel,
  costAt,
  costLine,
  commonSessionCost,
  markerBytes,
  sumLines,
  usageMultiplier,
  worstAgainst,
} from './cost-model.mjs';
import { degradationRefusal } from './competitor-health.mjs';

const dir = process.argv[2];
if (!dir) {
  console.error(
    'usage: node bench/compression/head-to-head.mjs <out-dir-from-run-theirs>'
  );
  process.exit(2);
}

const payloads = JSON.parse(readFileSync(join(dir, 'payloads.json'), 'utf8'));
const theirs = JSON.parse(readFileSync(join(dir, 'theirs.json'), 'utf8'));

// THEIR ENGINE'S OWN HEALTH, READ BEFORE ANY OF ITS NUMBERS ARE USED.
//
// Their ML transform is wall-clock budgeted: when the box is loaded it logs
// `Kompress giving up (time budget exhausted)` and passes the content through
// UNCOMPRESSED. That does not merely slow their column down, it changes the
// bytes it is made of -- so a capture taken under load measures a handicapped
// opponent, and a win over one is not a win. hr30 recorded zero such warnings;
// hr31, taken while another job on this machine held the CPU, recorded sixteen.
//
// The refusal logic lives in `competitor-health.mjs` and was already enforced
// over the COMMITTED record by `must-win.check.mjs`. It was not enforced here,
// which is the gap this closes. This file is what prints the table a reader
// quotes and what writes the record in the first place, so a contaminated
// capture could be scored, read aloud and recorded, and refused only afterwards
// by a check that is not in `bench:instruments`.
const competitorDegraded = degradationRefusal(theirs.__provenance__ ?? null);

// ONE DEFINITION OF "THEIR BEST ARM", APPLIED BEFORE ANYTHING IS SCORED.
//
// `run-theirs.py` records a winner in `arm`, with its bytes in `bestText` and
// its pooled timings in `ms`/`msSamples`/`msPasses`. The scorer separately ranks
// every arm in `arm-selection.mjs`. On browser-session those two disagreed: the
// capture's winner was `router` at 284.4ms, while three arms including `crusher`
// at 16.7ms emitted byte-identical output, so the ratio could not separate them
// and each file broke the tie its own way. The record then carried `router`'s
// time as "their best arm" and `crusher`'s retained count as "their best arm",
// and our speed row was scored against the slowest arm that produced their best
// bytes.
//
// So the capture is re-pointed here, once, at the arm `arm-selection.mjs` ranks
// first -- including its tie-break on measured time, which is the hard
// direction for us. Every later `bestText`, `ms` and recorded chars/tokens then
// names that same arm. Nothing is recomputed: the bytes and the timings all come
// from the capture's own per-arm fields.
//
// A capture with no per-arm fields, or one whose arms cannot be ranked, is left
// exactly as it was and named in `bestArmRepointed` so the record says which
// rows this touched.
const bestArmRepointed = {};
for (const [name, t] of Object.entries(theirs)) {
  if (name === '__provenance__' || t === null || typeof t !== 'object')
    continue;
  if (!t.armTexts || !t.armBeforeTexts) continue;
  const ranked = bestByRatio(
    Object.entries(t.armTexts).map(([label, armText]) => ({
      arm: label,
      before: (t.armBeforeTexts[label] ?? '').length,
      after: typeof armText === 'string' ? armText.length : Number.NaN,
      ms: t.armMs?.[label],
    }))
  );
  if (ranked === null || ranked.arm === t.arm) continue;
  bestArmRepointed[name] = { from: t.arm, to: ranked.arm };
  t.arm = ranked.arm;
  t.bestText = t.armTexts[ranked.arm];
  t.bestBeforeText = t.armBeforeTexts[ranked.arm] ?? t.bestBeforeText;
  // THE TIMINGS MOVE WITH THE ARM OR THEY DESCRIBE A DIFFERENT ONE. `armMs` is
  // the capture's median of exactly the pool in `armMsPasses`, so both are taken
  // from there and the median cannot disagree with its own samples.
  if (typeof t.armMs?.[ranked.arm] === 'number') t.ms = t.armMs[ranked.arm];
  if (Array.isArray(t.armMsPasses?.[ranked.arm])) {
    t.msPasses = t.armMsPasses[ranked.arm];
    t.msSamples = t.armMsPasses[ranked.arm].flat();
  }
}

// A KNOWN-ANSWER CAPTURE IS CORRECT AND MEANINGLESS AT THE SAME TIME, which is
// the most dangerous thing a file in this directory can be. `run-theirs.py` can
// be driven by stub arms whose output is arithmetic, to test this harness --
// see bench/compression/known-answer/. Those captures parse cleanly, carry
// every field, and would score as a crushing win over an engine that was never
// run. Refusing them here is what keeps the test rig out of the record.
//
// THE ONE PERMITTED EXCEPTION: OUR COLUMN IS STUBBED TOO. Layer 2 has to score
// a fabricated capture -- that is how the scorer's own instruments get an
// answer fixed before the run. What must never happen is a fabricated column
// sitting beside a measured one, in either direction, because that is the
// comparison that reads as a result. So fiction is scored only against
// fiction, the pairing announces itself, and `stubbedScorerRefusal` below
// keeps the output of such a run out of results/.
const stubRefusal = stubbedCaptureRefusal(theirs, dir);
if (stubRefusal && !KNOWN_ANSWER_OURS) {
  console.error(stubRefusal);
  process.exit(2);
}
if (stubRefusal) {
  console.error(
    `KNOWN-ANSWER RUN: ${stubRefusal}\nPermitted only because BENCH_KNOWN_ANSWER_OURS is set, so both columns are stubs.`
  );
}
if (KNOWN_ANSWER_OURS && !stubRefusal) {
  console.error(
    'KNOWN-ANSWER RUN against a REAL capture: our column is a stub and theirs ' +
      'is a measurement. Only the symmetry properties mean anything here; no ' +
      'figure in this table describes our product.'
  );
}

// BASE CONTEXT, READ FROM THE RECORDING OR NOT PRICED AT ALL.
//
// Every session-cost figure below adds `baseContextTokens` to both arms, so the
// constant sits in the numerator and the denominator of every savings ratio.
// Understating it pushes the ratio away from 1 and inflates the saving, which
// is the flattering direction, and the 12000 this replaced understated the
// machine this harness runs on by 5.4x.
//
// There is no defensible default, because the number is a property of an
// environment -- its system prompt and its loaded tool schemas -- and not of
// the code. It used to be re-measured from the local agent transcripts on every
// run, which is worse than it sounds twice over: the published cost column was
// a function of whose laptop produced it, reproducible by nobody, and on a
// machine with no transcripts the harness exited 2 and took every unrelated
// instrument down with it. So the measurement is taken once, deliberately, and
// committed: `node bench/subscription/base-context.mjs --record`.
//
// AND AN UNPRICED RUN IS NOT A FAILED RUN. Only the cost figures rest on this
// parameter. With no recording, or one below the readiness bar, those figures
// are withheld -- printed as a refusal and recorded as `null` with the reason
// beside them -- and every instrument that prices nothing still runs.
const BASE = readBaseContext();
const COST_PRICED = BASE.ready;
if (!COST_PRICED) {
  console.error('WITHHELD: cost figures are not priced in this environment.');
  console.error(`  ${BASE.reason}`);
  console.error(
    '  record it with: node bench/subscription/base-context.mjs --record'
  );
}
// The recorded median, standing in for the parameter that used to be hardcoded.
// `null` when unrecorded, and every read of it sits behind `COST_PRICED`.
const PARAMS = { ...DEFAULTS, baseContextTokens: BASE.tokens };

/**
 * THEIR MARKERS, REDEEMED BY A PROCESS THAT IS NOT THE ONE THAT WROTE THEM.
 *
 * Optional only because it needs their package importable. Without it their
 * store is unmeasured, and this file says so rather than scoring it as empty.
 *
 *   python bench/compression/headroom/resolve-theirs.py <clone-or-dash> <out-dir>
 */
const resolvedPath = join(dir, 'theirs-resolved.json');
const resolved = existsSync(resolvedPath)
  ? JSON.parse(readFileSync(resolvedPath, 'utf8'))
  : null;

/**
 * A REAL tokeniser, applied to both arms' actual output.
 *
 * The first version of this file counted tokens as `chars / 4`, which is what
 * their MockTokenCounter does. That made the token column a rescaling of the
 * character column -- identical percentages to the decimal point -- so the
 * claim to have measured "both denominators" was measuring one of them twice.
 * A token denominator only means something if the tokeniser can disagree with
 * the byte count, which is exactly what happens when a compressor trades prose
 * for punctuation-dense markers.
 */
// NAMED, not repeated as a literal, because the record has to state which
// encoding the token column was measured in and a second literal is a second
// thing to forget. cl100k_base against o200k_base moves the same text by double
// digits.
// AND IT IS NOT OURS TO CHOOSE. This read `cl100k_base` -- OpenAI's tokenizer
// -- while every claim the column supports is about what a CLAUDE subscription
// spends. The two do not differ by a constant: they split code and punctuation
// differently, so a ratio taken under one is not preserved under the other, and
// the competitive gap measured under cl100k could be larger, smaller or the
// other way round. The only authority for the claim is Anthropic's own
// `count_tokens`, which `currency.mjs` serves from a recorded fixture keyed on
// the exact payload bytes so CI stays offline. A lookup throws on a miss rather
// than estimating, so a payload that changed since the counts were recorded
// cannot be priced at all -- which is the property that makes the figures
// reproducible rather than merely repeatable.
const ENCODING_NAME = `anthropic:${MODEL}`;

/**
 * The recorded counts this run was priced against, read for provenance only.
 *
 * A figure is only as good as the fixture behind it, and nothing in the record
 * said which fixture that was: a reader could see the encoding had changed and
 * had no way to tell whether two records had been priced against the same
 * counts. Read defensively -- a missing fixture is a problem for `tokens`, not
 * for the provenance block, and it must not turn into a second failure here.
 */
const COUNTS = (() => {
  try {
    return JSON.parse(readFileSync(FIXTURE, 'utf8'));
  } catch {
    return {};
  }
})();

/**
 * A FIXED MARKER STAMP, so this harness's payloads have the same bytes twice.
 *
 * A stamp is an HMAC keyed by `SECRET = randomBytes(32)` in annotate.ts, minted
 * once per process and never emitted. That is what makes a stamp unforgeable,
 * and it is also what made this harness unmeasurable in a currency keyed on
 * exact payload bytes: two census passes over the same capture produced
 * `run1 234 run2 234 only1 72 only2 72`, so 72 of its 234 payloads had fresh
 * digests every run and no recorded fixture could ever be complete.
 *
 * `options.stamp` is the seam built for exactly this. Production omits it and
 * still gets the keyed MAC, so nothing about the forgery guarantee changes; the
 * guarantee is held by tests/unit/compress/planted-marker-is-content.test.ts,
 * not by this constant. Nine characters because that is `STAMP_CHARS`.
 *
 * MEASURED DOWN IN TWO STEPS, NOT ASSUMED. Two census passes over one capture
 * went 72 of 234 payloads varying, then 29 once every `compressBlock` site took
 * the stamp -- the first pass had matched only options objects with a trailing
 * comma, so the main `ours` arm written on one line kept minting its own -- and
 * then 13. The last 13 are the proxy arm: `compressBody` takes positional
 * arguments and has no options parameter, so there is nowhere to hand it a
 * stamp. Giving it one is the remaining work before this harness can be
 * denominated in recorded counts at all.
 */
const BENCH_STAMP = '100000001';

// IMAGES ARE NOT BILLED AS THE TEXT THEY ARRIVE IN, and counting them that way
// was not a rounding error. browser-session carries four PNG screenshots; the
// provider charges width*height/750, which is 1,585 tokens each, while cl100k
// over the base64 charges 115,715 and 134,999. That is 501,428 tokens counted
// against 6,340 actually billed -- 79x -- and since the images are 95% of the
// payload's measured token count, EVERY token figure for that workload on BOTH
// arms was a statement about base64 rather than about cost.
//
// So base64 runs long enough to carry an image header are priced by their
// pixels and removed from the text before it is tokenised. This is done on raw
// text rather than on parsed blocks deliberately: the compressed outputs are no
// longer message lists, and an arm can only be compared with another if the
// same rule is applied to both.
//
// 750 is the divisor src/compress/images.ts uses; it is the provider's, not
// ours, and if they change it both arms move together.
const PIXELS_PER_TOKEN = 750;
const BASE64_RUN = /[A-Za-z0-9+/]{1000,}={0,2}/g;
const tokens = (text) => {
  let imaged = 0;
  const stripped = text.replace(BASE64_RUN, (run) => {
    const size = imageSize(run);
    if (!size) return run;
    imaged += Math.ceil((size.width * size.height) / PIXELS_PER_TOKEN);
    return '';
  });
  return countText(stripped) + imaged;
};

// The identifier extractor moved to its own module so it could be tested; see
// identifiers.mjs. It is imported at the top of this file.

/**
 * The last user turn, when the payload is a conversation.
 *
 * Read out of the SERIALISED payload rather than a parallel structure, because
 * the serialised payload is the only thing both arms are guaranteed to share.
 */
function queryOf(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  for (let i = parsed.length - 1; i >= 0; i--) {
    const message = parsed[i];
    if (
      message &&
      message.role === 'user' &&
      typeof message.content === 'string'
    ) {
      return message.content;
    }
  }
  return undefined;
}

// A SHORT DIGEST, for facts that are only useful if they can be re-checked.
// Sixteen hex characters of sha256: long enough that two different payloads do
// not collide in a record of eighteen rows, short enough to read in a diff.
const sha = (text) =>
  typeof text === 'string'
    ? createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
    : null;
const rows = [];
let lost = 0;

/**
 * EVERY WORKLOAD TIMED SEVERAL TIMES OVER, BECAUSE THE SPREAD THAT DECIDES THE
 * GATE IS BETWEEN RUNS AND NOT INSIDE ONE.
 *
 * Measured with five independent regenerations of this record: on the two
 * workloads whose verdict kept flipping, the standard deviation of our p90
 * BETWEEN runs was 34.05ms and 28.10ms, against 6.91ms and 13.39ms for the
 * bootstrapped spread WITHIN a single run. A confidence interval drawn from
 * one run's samples therefore understates the real uncertainty by a factor of
 * two to five, and would report a machine hiccup as a regression with a
 * straight face -- the same false confidence `calibrate.mjs` used to report
 * for a saturated fit.
 *
 * The interference is COMMON-MODE, which is what makes it tractable. In the
 * one contaminated run of the five, codebase-exploration went 46 -> 131.6ms,
 * raw-build-log 53 -> 125.2ms, grep-output 9.4 -> 21.7ms, human-authored-json
 * 5.4 -> 21.1ms and issue-triage 12.2 -> 24.1ms: everything at once, which no
 * code change does. So the passes are separated by a full sweep of every other
 * workload rather than run back to back -- a pass takes seconds, and an
 * interference event that outlasts one pass is visible as a pass that
 * disagrees with its neighbours instead of as a quietly inflated average.
 *
 * What the gate does with the disagreement is the gate's business; this
 * function's job is to hand over passes that were sampled at different
 * moments, and to keep them separate so the disagreement survives.
 */
function timeEveryWorkload(byName) {
  // THIRTY-ONE, NOT THE ELEVEN #435 ASKED FOR. Eleven is enough for a median
  // and not enough for the tails, and the tails are what the gate compares: at
  // eleven samples a single interference spike lands squarely on the 90th
  // percentile. Thirty-one puts three readings outside each tail.
  const SPEED_SAMPLES = 31;
  // THREE PASSES. Two cannot tell which of a disagreeing pair was the odd one
  // out, and the cost is linear: this is the whole runtime of the harness.
  const SPEED_PASSES = 3;
  const passes = new Map(Object.keys(byName).map((n) => [n, []]));
  // THE SUBSTITUTION ARM IS TIMED TOO, because the speed column was pairing our
  // COMPRESSING arm against their REFERENCING one. Their best-of-any arm writes
  // a 24-character content-cache key and reads 3 to 15ms; our default engines
  // analyse the block and read 6 to 117ms. Comparing those two answers the
  // question "is compression slower than hashing", which needs no benchmark.
  //
  // The cost column already splits this: best-of-any against comparable. Speed
  // now does the same, with the SAME two arms of ours that cost uses -- `sub`
  // (spillWholeBlockBelow 1, every block moved, like-for-like with a content
  // cache) against their best, and the default against their non-offloading
  // pipeline arms. Both readings are published, so neither column is a choice
  // about which fact to show.
  const subPasses = new Map(Object.keys(byName).map((n) => [n, []]));
  // A SINK THAT COSTS WHAT THE REAL ONE COSTS, MINUS THE DISK. The published
  // `sub` arm pushes the content onto an array and returns a path; timing a sink
  // that writes files would measure the filesystem, and timing one that returns
  // null would measure a code path that never moves anything. This keeps the
  // array push so the allocation is paid, and is fresh per call so the memo in
  // `spillFor` cannot turn the second pass into a lookup.
  const subTuning = resolveTuning({ spillWholeBlockBelow: 1 });
  // THE SAME LOAD CONTROL THEIR SWEEP TAKES, TAKEN THE SAME WAY. A reading
  // before each pass, pooled to a median, from the identical script
  // run-theirs.py spawns -- see bench/compression/load-witness.mjs for the 33%
  // to 122% drift between two runs of THIS function that forced it.
  const witnessReadings = [];
  const witnessErrors = [];
  const takeWitness = (when) => {
    try {
      const r = witness(1);
      witnessReadings.push({ at: when, ms: r.ms, checksum: r.checksum });
    } catch (err) {
      witnessErrors.push({
        at: when,
        error: String(err && err.message ? err.message : err),
      });
    }
  };
  for (let pass = 0; pass < SPEED_PASSES; pass += 1) {
    takeWitness(`before-pass-${pass}`);
    for (const [name, text] of Object.entries(byName)) {
      // MEASURED WITH `performance.now`, NOT `Date.now`. Several of these
      // payloads compress in under a millisecond, and a 1 ms clock reports
      // those as 0 -- indistinguishable from an arm that never ran.
      const samples = [];
      for (let i = 0; i < SPEED_SAMPLES; i += 1) {
        const t0 = performance.now();
        compressBlock(text, { query: queryOf(text), stamp: BENCH_STAMP });
        samples.push(performance.now() - t0);
      }
      // KEPT IN RUN ORDER. Sorting loses which reading was first, and the
      // first reading is the one that paid for the JIT: it is routinely
      // several times the rest, on both arms. The gate decides what to do
      // with that; the harness hands over the readings, not the flattering
      // ones.
      passes.get(name).push(samples.map((v) => Number(v.toFixed(3))));
      const subSamples = [];
      for (let i = 0; i < SPEED_SAMPLES; i += 1) {
        const held = [];
        const t0 = performance.now();
        compressBlock(text, {
          spill: (content, hint) => {
            held.push(content);
            return `.token-optimizer/spill/t${held.length}-${hint}`;
          },
          query: queryOf(text),
          stamp: BENCH_STAMP,
          tuning: subTuning,
        });
        subSamples.push(performance.now() - t0);
      }
      subPasses.get(name).push(subSamples.map((v) => Number(v.toFixed(3))));
    }
  }
  takeWitness('after-sweep');
  const sorted = [...witnessReadings.map((r) => r.ms)].sort((a, b) => a - b);
  return {
    passes,
    subPasses,
    loadWitness: {
      ms: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : null,
      readings: witnessReadings,
      errors: witnessErrors,
    },
  };
}

// TIMED BEFORE ANYTHING ELSE RUNS, so the passes see a comparable machine and
// not a process that has been compressing, tokenising and writing JSON for a
// minute by the time the last workload is reached.
const timed = timeEveryWorkload(payloads);
const speedPasses = timed.passes;
const subSpeedPasses = timed.subPasses;
const ourLoadWitness = timed.loadWitness;

for (const [name, text] of Object.entries(payloads)) {
  // THE PUBLISHED ARM IS HANDED NO SINK, and that is the product default --
  // see `SpillSink` in src/compress/types.ts. With nowhere to spill to, every
  // engine either compresses losslessly or leaves the block alone, so this arm
  // costs the agent no round trips and every identifier it started with is
  // still in the request.
  //
  // IT STAYS AN ARRAY because the columns below are shared with the `sub` and
  // `preset` arms, which do spill and are published beside this one: the trade
  // has to stay visible, it just stops being the default. On `repeated-reads`
  // a sink buys 6,178 tokens of hand-off and costs a fetch, because the
  // lossless fold has already collapsed the repeated copies -- which is the
  // measurement that moved the default.
  const spilled = [];
  // Named rather than inferred from `spilled.length`, because `a sink that
  // evicted nothing` and `no sink at all` are different measurements and the
  // classifier is built to refuse to collapse them.
  const OURS_HAS_SINK = false;

  // THE TIMED ARM IS THE SINKLESS ARM, the same one the recorded call below
  // runs, so the published median times what is published. The passes were
  // taken up front by `timeEveryWorkload`; `msSamples` stays the pooled
  // reading every existing consumer expects, and `msPasses` keeps them apart
  // for the gate.
  const msPasses = speedPasses.get(name);
  const msSamples = msPasses.flat();
  const sorted = [...msSamples].sort((a, b) => a - b);
  const ms = sorted[(sorted.length - 1) >> 1];
  const msMin = sorted[0];
  const msMax = sorted[sorted.length - 1];
  // THE SUBSTITUTION ARM'S OWN TIMINGS, taken in the same passes on the same
  // machine, so the two arms of ours cannot be separated by machine state.
  const subMsPasses = subSpeedPasses.get(name);
  const subMsSamples = subMsPasses.flat();
  const subSorted = [...subMsSamples].sort((a, b) => a - b);
  const subMs = subSorted[(subSorted.length - 1) >> 1];
  const out = compressBlock(text, { query: queryOf(text), stamp: BENCH_STAMP });

  // THE SUBSTITUTION ARM, MEASURED SEPARATELY AND NAMED FOR WHAT IT IS. HeadRoom
  // reaches ~99.7% on the three workloads our engines find hardest by not
  // compressing them at all: a `<<ccr:hash,blob,32107>>` reference is 24
  // characters and the block is in a content store. `spillWholeBlockBelow` does
  // the same move for any block our engines could not take 90% off, and writes a
  // path the agent can `Read` itself instead of a key that costs a retrieval
  // call and can come back `[unresolved: entry not found]`.
  //
  // THE DIAL IS AT 1 HERE, NOT AT ITS RECOMMENDED SETTING, because this column
  // is a like-for-like against a content cache and a content cache moves every
  // block it touches. At 1 no saving is ever good enough to keep a block, so
  // the arm does exactly what theirs does and the two numbers mean the same
  // thing. A caller who actually wants this would run it nearer 0.9, which
  // leaves every well-compressed block in the request and moves only what the
  // engines had nothing to offer -- a better product and a worse headline, and
  // mixing the two into one column is how a headline stops being checkable.
  //
  // It is a THIRD COLUMN rather than a new default because the two arms are not
  // the same product, and the record says so in units a reader can re-derive:
  // the default arm leaves every one of the 13,784 scorable identifiers in the
  // request, available with no extra turn, where the preset arm below leaves 455
  // of them there and puts the rest behind a `Read`. Publishing one number would
  // mean choosing which of those facts to hide.
  //
  // (This used to cite "1,274 of the 1,582 identifiers". That split is not
  // measured any more and was never checkable -- see the header of
  // identifiers.mjs, which records that the 1,582 denominator named neither the
  // set nor the rule that admitted a member. The two counts above come straight
  // out of `retention` in the record.)
  const subSpilled = [];
  const sub = compressBlock(text, {
    spill: (content, hint) => {
      subSpilled.push(content);
      return `.token-optimizer/spill/s${subSpilled.length}-${hint}`;
    },
    query: queryOf(text),
    stamp: BENCH_STAMP,
    tuning: resolveTuning({ spillWholeBlockBelow: 1 }),
  });
  // OUR HALF OF MUST-WIN 2b, ON THE BLOCKS THIS ARM ACTUALLY MOVED OUT.
  //
  // This is the arm with fetches to price. The default arm above has no sink at
  // all (`OURS_HAS_SINK` is false), so its round trips are zero and its
  // per-fetch latency multiplies nothing at every fetch rate -- see
  // `fetch-latency.mjs` for why a figure that cannot change the answer is not
  // demanded rather than defaulted to one.
  //
  // The sink the arm ran with returns a fake `.token-optimizer/spill/...` path,
  // because what the cost model needs from it is the block's SIZE, not a file.
  // Latency needs the file: so the same bytes are written here, the way
  // `spillTo` in src/proxy/server.ts writes them, and read back the way the
  // agent reads them. The directory is removed immediately afterwards -- this
  // measures a retrieval, it is not a store.
  const fetchRoot = mkdtempSync(join(tmpdir(), 'to-h2h-fetch-'));
  let subFetch = null;
  try {
    subFetch = measureOurFetch(
      { blocks: subSpilled, root: join(fetchRoot, 'spill') },
      {
        mkdir: (at) => mkdirSync(at, { recursive: true }),
        write: (at, content) =>
          writeFileSync(at, content, { encoding: 'utf8', mode: 0o600 }),
        read: (at) => readFileSync(at, 'utf8'),
        now: () => Number(process.hrtime.bigint()) / 1e6,
      }
    );
  } finally {
    rmSync(fetchRoot, { recursive: true, force: true });
  }

  // THE PRESET ARM: THE DIAL AT THE SETTING A CALLER WOULD ACTUALLY RUN.
  //
  // The `sub` column above is a like-for-like against a content cache and is
  // deliberately unusable as a product -- at a threshold of 1 no saving is ever
  // good enough, so a block the engines took 96% off is moved out anyway and the
  // reader loses it. At 0.9 the move fires only where the engines could not reach
  // 90%, which on this corpus is the three log-and-grep shapes and nothing else.
  // Every well-compressed block stays in the request, so the reduction is mostly
  // real and the zero-turn column mostly survives; that pair is the claim, and it
  // is only checkable if the arm is published separately from the one at 1.
  const presetSpilled = [];
  const preset = compressBlock(text, {
    spill: (content, hint) => {
      presetSpilled.push(content);
      return `.token-optimizer/spill/p${presetSpilled.length}-${hint}`;
    },
    query: queryOf(text),
    stamp: BENCH_STAMP,
    tuning: resolveTuning({ spillWholeBlockBelow: 0.9 }),
  });

  // THE SECOND ARM. compressBlock takes a text string, so a payload's image
  // blocks reach it only as base64 inside serialised JSON -- browser-session is
  // 88.6% screenshots, and src/compress/images.ts (which deduplicates them) is
  // unreachable from the block router. compressBody takes the request buffer and
  // sees structured content blocks. Both are published because the difference
  // between the layer and the pipeline is a fact about the product, not a choice
  // of which number to show.
  //
  // The wrapper adds a model/max_tokens envelope of ~60 bytes to both sides of
  // the ratio, which is under 0.1% of every payload here; it is not corrected
  // for, so the body ratios are very slightly pessimistic.
  const bodySpilled = [];
  let body = null;
  try {
    const parsed = JSON.parse(text);
    // A MESSAGE LIST, NOT MERELY AN ARRAY. `Array.isArray` alone let the four
    // raw-data payloads here -- log-entries, search-results, api-responses,
    // database-rows, which are arrays of log lines and API records with no
    // `role` and no `content` -- be wrapped as `messages` and handed to the
    // proxy. No client sends that, so the arm was being scored on a request
    // shape that cannot occur, and it was scored generously: those four are the
    // four rows stored pretty-printed, so the re-serialisation this used to do
    // handed them 18.4% to 32.9% before any compression ran. One wrong gate
    // produced both, which is why the fix is the gate.
    const isMessageList =
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (m) =>
          m !== null &&
          typeof m === 'object' &&
          typeof m.role === 'string' &&
          m.content !== undefined
      );
    if (isMessageList) {
      // THE CAPTURED BYTES, NOT A RE-SERIALISATION OF THEM. This built the
      // request body with `JSON.stringify({ ..., messages: parsed })`, which
      // discards the payload's own formatting and rebuilds it compact. On the
      // four raw-data rows in this corpus that alone is worth 18.4%, 18.9%,
      // 32.9% and 24.5% of the characters BEFORE any compression runs, because
      // those captures are indented and `JSON.stringify` is not. The proxy arm
      // was then priced on that smaller baseline against the other arms' price
      // on the original, so it collected up to a third of a row as a saving it
      // had not made -- a bias in OUR favour, which is the direction that has
      // to be caught here rather than explained later.
      //
      // Concatenating keeps `text` byte for byte, so the arm is handed exactly
      // what a client sent and exactly what `compressBlock` above was handed.
      // The envelope is the only difference between the two denominators, which
      // is the ~15 tokens the cost model already discloses as charged against
      // us. `parsed` is still what decides whether there is a proxy arm at all:
      // the payload has to be a message list.
      const wrapped = `{"model":"claude-sonnet-5","max_tokens":1024,"messages":${text}}`;
      // NO FINDINGS, SO THE NET-SAVING GUARD CANNOT MOVE A FIGURE HERE, and this
      // arm reports one column rather than two for that reason. The guard
      // (TOKEN_OPTIMIZER_PROXY_NET_SAVING) only ever drops a cached-knowledge
      // block, and a block is only composed from findings this call does not pass.
      // Measured rather than argued: this corpus recorded twice at one commit, once
      // with the guard off and once on, differs in 0 non-timing leaves across all 18
      // workloads. Publishing a second column would be publishing the same number
      // twice and implying the guard had been exercised.
      // WITH THE ANCHOR STORE, BECAUSE THE SHIPPED PROXY HAS NO WAY TO RUN
      // WITHOUT ONE. src/proxy/server.ts builds a store at startup (:1306) and
      // passes it on every request, with no env flag to turn it off, so an arm
      // measured with two arguments is an arm that does not exist. It is not a
      // small difference: with no store the arm respects the client's marker on
      // every payload, and with one, a request at or below `coldMessageLimit`
      // comes back `first-turn` with `reanchor` set, which clears `respect` in
      // src/compress/strategy.ts:784 and lets it rewrite the cached prefix.
      // Priced through cost-model.mjs that re-anchoring is cheaper on eight of
      // the nine rows where the two differ -- even against a marker-respecting
      // arm credited with a spliced, byte-identical prefix it does not yet
      // produce -- so this is the stronger arm as well as the real one.
      //
      // ONE COLUMN, NOT TWO. A second pass through the same store returns a
      // byte-identical body on every payload here, so there is no warm column
      // to report: whatever the store is worth, it is worth on turn one.
      const result = compressBody(
        Buffer.from(wrapped, 'utf8'),
        (c, hint) => {
          bodySpilled.push(c);
          return `.token-optimizer/spill/b${bodySpilled.length}-${hint}`;
        },
        anchorStore()
      );
      // WHY A ZERO IS A ZERO. compressBody declines to rewrite anything behind
      // the client's own cache_control marker, because a rewritten prefix costs
      // a 1.25x cache write. Claude Code puts that marker on the second-to-last
      // user turn, so on a real multi-turn agent loop the marker sits at the END
      // and the whole payload is off limits -- agent-loop reports 0.0% with 0
      // elisions while compressBlock gets 93.8% off the same bytes.
      //
      // That is a refusal, not an inability, and the two need different
      // responses. Printing the share behind the marker is what makes the
      // difference visible instead of leaving a bare zero to be read as a
      // missing engine.
      // THE CACHE CREDIT IS MEASURED FROM THE BYTES, NOT INFERRED FROM THE
      // MARKER. cost-model.mjs bills a prefix an arm passed through byte for
      // byte at R*(N+1) instead of W + R*N, and byte-identical is the whole
      // condition: a prefix that was re-indented or re-encoded is a cache miss,
      // not a cheap read. Deriving this from `behind` would hand the arm a 25%
      // discount for a hit it does not get, so it is the actual common prefix
      // of what went in and what came out.
      //
      // IT COMES OUT AT 57 CHARACTERS ON EVERY ROW THAT COMPRESSES -- the
      // `{"model":...,"messages":` envelope and nothing more -- because the
      // proxy rebuilds the request with `JSON.stringify(result.request)` and
      // these captures are indented. The arm can leave a prefix alone in every
      // sense that matters and still destroy the cache hit on the way out. The
      // two rows that keep a real prefix are the two that return their input
      // untouched. This is recorded rather than corrected for: it is a true
      // statement about what the arm hands the provider today.
      const identical = (() => {
        const outText = result.body.toString('utf8');
        const n = Math.min(wrapped.length, outText.length);
        let i = 0;
        while (i < n && wrapped[i] === outText[i]) i++;
        return outText.slice(0, i);
      })();
      let marker = -1;
      parsed.forEach((m, i) => {
        if (Array.isArray(m.content))
          for (const b of m.content) if (b?.cache_control) marker = i;
      });
      const behind =
        marker < 0
          ? 0
          : JSON.stringify(parsed.slice(0, marker + 1)).length /
            JSON.stringify(parsed).length;
      body = {
        behind,
        cachedPrefixChars: identical.length,
        cachedPrefixTok: tokens(identical),
        before: Buffer.byteLength(wrapped, 'utf8'),
        after: result.body.length,
        text: result.body.toString('utf8'),
        // THE KEYS, CARRIED OUT WITH THE TEXT. They are what makes the output
        // decodable, and the recovery oracle below is the only reader of it.
        // They never reach a row: a key is derived from the content, so it has
        // no place in a number anybody publishes.
        stamps: result.stamps ?? [],
        tokBefore: tokens(wrapped),
        tokAfter: tokens(result.body.toString('utf8')),
        reason: result.summary.compressed
          ? ''
          : `${result.summary.reason ?? ''}; ${(behind * 100).toFixed(0)}% of the payload is behind the client's cache marker`,
      };
    }
  } catch {
    /* a payload that is not a message list has no body arm */
  }

  const before = text.length;
  const after = out.text.length;

  // CONSERVATION, stated so it can actually fail.
  //
  // The first version of this check read `after + spilled <= before + after`,
  // which is not a conservation law -- it is an inequality that holds unless
  // the spill alone exceeds the whole input, and it fired on a workload that
  // was behaving correctly. Two claims that CAN be false replace it:
  //
  //   never grows      the output must not be larger than the input.
  //   spill is sane    the side-store must not be a multiple of the input. It
  //                    legitimately exceeds `before - after` by a little,
  //                    because spilled rows are re-serialised without the JSON
  //                    string escaping they arrived in and with indentation
  //                    added; measured at 1.02x here. A 2x store would mean
  //                    the same bytes are being written twice, which is a real
  //                    defect and is what this bound catches.
  const spilledChars = spilled.reduce((n, s) => n + s.length, 0);
  const grew = after > before;
  const spillRatio = spilledChars / before;
  // NAMED FOR WHAT IT CHECKS. It was called `conserved`, which reads as a
  // statement about content and is not one: an arm could delete half the prose
  // and still satisfy both bounds. Whole-payload content conservation is
  // measured separately, below, by `conservation.mjs`.
  const sizeSane = !grew && spillRatio <= 2;

  // SPLIT BEFORE ANYTHING COUNTS. `identifiers()` admits keyed and quoted values
  // down to MIN_SYMBOL (5), but an identifier is only scorable by `includes` at
  // eight characters, so the shorter ones are excluded -- and they have to be
  // excluded HERE, not inside `classifyIds`, because the five loops below walk
  // this set directly. Until they did, our arm was scored on the safe subset and
  // theirs on the whole scrape, with the whole scrape printed as the denominator
  // for both.
  // AND THE PHANTOMS ARE COUNTED, NOT DISCARDED QUIETLY. `scanIdentifiers`
  // drops any unit that is not a literal substring of this payload, because
  // `includes` can never find one; the number it dropped is carried up to the
  // retention block so that a denominator narrowing by 283 units is a line of
  // output rather than a silent improvement in every loss column at once.
  const scan = scanIdentifiers(text);
  const phantomIds = scan.phantoms.length;
  const { want, unsafeIds } = splitScorable(scan.units);

  // RECOVER FIRST, THEN SEARCH -- on both arms -- because a substring oracle
  // cannot see factored content and was reporting healthy compression as
  // catastrophic loss.
  //
  // The grep engine hoists line numbers out of the body and states them once in
  // a hunk header: 100 lines of `src/x.ts:142:...` become `src/x.ts:101-200`
  // plus the bodies. Every number is still there and none of them is a literal
  // substring any more, so `includes` turned 912 retained into 912 gone on a
  // change that decodes back exactly. The instrument moved, not the thing being
  // measured.
  //
  // WHAT THE FIX IS NOT. A first attempt demanded that a block declaring
  // `lossless: true` reconstruct BYTE FOR BYTE, and promptly accused the JSON
  // engine of a broken promise. It had not made one: on a JSON document the
  // claim is about the VALUE, and dropping 38KB of indentation changes no
  // value. A gate that cannot state the contract it is checking manufactures
  // its own failures, which is worse than the gap it replaced.
  //
  // So the question asked here is the narrow one retention actually needs, and
  // it is the same question asked of their arm: run the published decoder over
  // the output and see what comes back. An identifier counts as recovered only
  // if it is really there afterwards. Nothing is credited on a promise.
  // WITH THE KEY THE ENGINE MINTED FOR THIS TEXT. `compressBlock` authenticates
  // every marker it writes, so the oracle decodes nothing without it and the
  // conservation column would read as a wall of losses the product does not
  // have.
  const recoveredOut = recoverable(out.text, name, out.stamp ?? []);

  // SUBSTRING, not set membership, for what is LITERALLY present. Compression
  // reformats -- a value that arrived as a JSON field may leave as part of a
  // folded line -- and scoring by exact token equality would report
  // reformatting as data loss. At eight characters with a digit, a coincidental
  // substring match is not a real risk.
  // THE CLASSIFICATION LIVES IN `retention.mjs` so it can be checked. It used
  // to be this loop, and for as long as it was, `inSpill` reported 0 on every
  // workload -- not because nothing spilled, but because THIS arm has no sink
  // (`spilled` above is a literal empty array), so the branch could not fire.
  // A zero meaning `never asked` sat in a table beside three columns that
  // meant `measured`. It now reports null, and `retention.check.mjs` arms a
  // positive control so a null can only ever mean no sink.
  const haveSpill = spilled.join('\n');
  const classified = classifyIds({
    ids: want,
    output: out.text,
    reconstructed: recoveredOut,
    spill: haveSpill,
    hasSink: OURS_HAS_SINK,
  });
  const { inOut, derived, inSpill, gone, missing } = classified;
  // AND THE SAME QUESTION OVER EVERYTHING THE IDENTIFIER LIST LEAVES OUT.
  // `want` is a scrape of paths, hashes and ids; the prose between them is
  // outside its denominator, so this walks every word of the payload long enough
  // to locate. Same three places count as survival, same sink semantics.
  //
  // THE FLOOR IS CHOSEN BY THE CONTROL BELOW, NOT FIXED HERE, because at eight
  // characters the control loses nothing on code-search, issue-triage and
  // relevance-probe -- their long words are a few repeated template strings and
  // half the document still holds every one. `discriminatingFloor` takes the
  // LARGEST floor at which the control still detects a loss, so a row is judged
  // with the least coincidence risk that still leaves the oracle any power, and
  // a row where no floor discriminates gets `null` rather than a number. See
  // that function for why a 48-byte segment was measured here and rejected.
  const mutilated = out.text.slice(0, Math.floor(out.text.length / 2));
  const floor = discriminatingFloor(text, mutilated);
  const minLen = floor.minLen ?? MIN_WORD_LEN;
  const kept = unaccounted({
    before: text,
    output: out.text,
    reconstructed: recoveredOut,
    spill: haveSpill,
    hasSink: OURS_HAS_SINK,
    minLen,
  });
  // AND A POSITIVE CONTROL, BECAUSE A ZERO HAS TWO CAUSES. `gone 0` means either
  // that the arm lost nothing or that this payload's vocabulary is too small for
  // the oracle to notice a loss at all -- several of these fixtures repeat ten
  // distinct long words across 100KB, and half of such a document still contains
  // all ten. So the same oracle is run against a deliberately mutilated output,
  // half the real one, with no expansion and no spill to fall back on. It MUST
  // report loss. Where it does not, the row's real reading is not evidence of
  // conservation and this harness says so instead of printing a clean zero.
  const control = unaccounted({
    before: text,
    output: mutilated,
    reconstructed: '',
    spill: '',
    hasSink: false,
    minLen,
  });
  // THE BUCKETS MUST SUM TO THE DENOMINATOR, and until the split above they did
  // not: four buckets counted over one set, printed beside the size of a larger
  // one. `ka-items` read `25 | 24 0 null 0` under an identity arm and nothing
  // caught it. The assertion costs nothing and is the only thing standing
  // between this table and an arithmetic that does not close.
  const bucketed = inOut + derived + (inSpill ?? 0) + gone;
  if (classified.ids !== want.size || bucketed !== want.size) {
    throw new Error(
      `${name}: retention buckets do not close -- denominator ${want.size}, ` +
        `classified ${classified.ids}, buckets ${bucketed} ` +
        `(inOut ${inOut} + derived ${derived} + inSpill ${inSpill ?? 0} + gone ${gone}). ` +
        'The scored set and the printed denominator have drifted apart again.'
    );
  }
  lost += gone;

  // THE BODY ARM IS SCORED THE SAME WAY. A compression ratio published without a
  // loss column is the exact thing this harness exists to stop, so the body arm
  // answers the same question: after the decoder has run and the spill is read,
  // how many identifiers is a reader unable to reach at all?
  // THE SUBSTITUTION ARM IS SCORED THE SAME WAY, and it is the arm most likely
  // to lose something: it moves whole blocks out, so every identifier in one has
  // to come back off the spill or it is gone. A ratio near 100% earned by losing
  // content is the exact claim this harness exists to refuse.
  let subGone = 0;
  const subRecovered = recoverable(sub.text, `${name} (sub)`, sub.stamp ?? []);
  const subSpill = subSpilled.join('\n');
  for (const id of want)
    if (
      !sub.text.includes(id) &&
      !subRecovered.includes(id) &&
      !subSpill.includes(id)
    )
      subGone++;

  // THE PRESET ARM IS SCORED ON BOTH COLUMNS, because its whole claim is that it
  // buys reduction without buying it out of the reader's pocket. `presetFree` is
  // the zero-turn count: in the text, or rebuilt from the text alone. `presetGone`
  // is the loss column every other arm here answers.
  const presetRecovered = recoverable(
    preset.text,
    `${name} (preset)`,
    preset.stamp ?? []
  );
  const presetSpill = presetSpilled.join('\n');
  let presetGone = 0;
  let presetFree = 0;
  for (const id of want) {
    if (preset.text.includes(id) || presetRecovered.includes(id)) presetFree++;
    else if (!presetSpill.includes(id)) presetGone++;
  }

  let bodyGone = 0;
  if (body !== null) {
    // ONE KEY PER BLOCK HERE, not one for the text: `compressBody` runs the
    // engine once per block, so the markers in different blocks verify under
    // different keys and the oracle is handed the whole set.
    const bodyRecovered = recoverable(
      body.text,
      `${name} (body)`,
      body.stamps ?? []
    );
    const bodySpill = bodySpilled.join('\n');
    for (const id of want)
      if (
        !body.text.includes(id) &&
        !bodyRecovered.includes(id) &&
        !bodySpill.includes(id)
      )
        bodyGone++;
  }

  const t = theirs[name];
  // REFUSE A MISSING ENTRY RATHER THAN SUBSTITUTE OUR OWN TEXT FOR IT. The
  // fallbacks below read `t.bestBeforeText ?? text`, so an absent workload
  // silently scored the competitor as having done nothing to OUR content --
  // a fabricated comparison that reads as a win. Other sites guarded the same
  // value and this one did not, which is how the inconsistency hid. A result
  // that cannot be attributed to their actual output is not evidence.
  if (!t) {
    throw new Error(
      `theirs.json has no entry for workload "${name}". Re-run ` +
        'bench/compression/headroom/run-theirs.py so both arms cover the same ' +
        'set, rather than scoring this workload against our own text.'
    );
  }
  // Their token reduction, measured on THEIR OWN before/after text with the
  // same tokeniser. For the pipeline arm those two texts are the wrapped
  // conversation, so the ratio is theirs and the envelope cancels.
  const theirBefore = tokens(t.bestBeforeText ?? text);
  const theirAfter = tokens(t.bestText ?? text);

  // THEIR RETENTION, MEASURED THE SAME WAY -- the hole an adversarial review
  // found in this harness. Their winning arm is chosen by SMALLEST OUTPUT, so
  // the selection actively prefers their most aggressive mode; scoring our
  // verified zero loss against their unmeasured loss compared a careful
  // compressor to a possibly reckless one and called the size difference a win.
  //
  // Their elided rows go to a retrieval store this harness cannot read, so a
  // needle absent from their output is "not in the text they send" -- the same
  // thing our `gone` column would mean if we ignored the spill. It is therefore
  // reported beside ours as a like-for-like in-context figure, NOT as proof
  // they lost it: their CCR store may still hold it, exactly as our spill holds
  // ours. What it can do is stop a silent asymmetry being quoted as a win.
  const theirText = t.bestText ?? text;

  // THEIR ARM, SPLIT THE WAY OURS ALREADY IS.
  //
  // `theirAfter` above is their best arm of any kind, chosen by ratio. Several
  // of their arms reach that ratio by writing the content to a local store and
  // leaving a marker behind, which is what our `sub` arm does and what the
  // report calls "SUBSTITUTION, not reduction" when we do it. Comparing our
  // encoding arm against their substitution arm is the wrong comparison, so
  // their best NON-offloading arm is measured here alongside it.
  //
  // THREE STATES, NOT TWO. A capture taken before `run-theirs.py` recorded every
  // arm's bytes cannot answer the question at all, and that is not the same as
  // a capture that answered "no such arm". `theirCleanState` names which:
  //   'measured'    -- a non-offloading arm exists and was scored
  //   'none'        -- every arm offloaded, so no like-for-like number exists
  //   'unrecorded'  -- this capture predates arm capture and cannot be asked
  let theirCleanState = 'unrecorded';
  let theirCleanTok = null;
  let theirCleanBeforeTok = null;
  let theirCleanArm = null;
  if (t.armTexts && t.armBeforeTexts) {
    const arms = Object.fromEntries(
      Object.entries(t.armTexts).map(([label, armText]) => [
        label,
        { text: armText, beforeText: t.armBeforeTexts[label] ?? text },
      ])
    );
    const split = classifyArms(arms, { size: tokens });
    if (split.clean === null) {
      theirCleanState = 'none';
    } else {
      theirCleanState = 'measured';
      theirCleanArm = split.clean.label;
      theirCleanBeforeTok = tokens(t.armBeforeTexts[split.clean.label] ?? text);
      theirCleanTok = tokens(t.armTexts[split.clean.label]);
    }
  }
  // THEIR TWO ARMS, NOT JUST THEIR BEST ONE.
  //
  // `arm-selection.mjs` carries the measurement that forced this: their ratio
  // winner keeps 4 of 1045 identifiers on grep-output, 3 of 430 on
  // raw-build-log, 5 of 590 on codebase-exploration. Chars, cost and speed were
  // all scored against an arm that had deleted the payload, and the speed
  // criterion in particular was comparing our encode against their delete.
  //
  // So both arms are named and recorded: their ratio winner, and their best arm
  // that kept at least as much as we kept. The selection rule lives in the
  // instrument so it can be mutated and caught; this block only feeds it.
  const armCandidates = [];
  for (const [label, armText] of Object.entries(t.armTexts ?? {})) {
    const armBefore = t.armBeforeTexts?.[label] ?? text;
    // A NON-STRING ARM IS HANDED OVER AS UNRANKABLE, NOT SKIPPED. Skipping it
    // would quietly substitute a worse comparable arm; the instrument refuses
    // the whole selection instead, and the row then says why.
    let kept = Number.NaN;
    if (typeof armText === 'string') {
      kept = 0;
      for (const id of want) if (armText.includes(id)) kept += 1;
    }
    armCandidates.push({
      arm: label,
      before: typeof armBefore === 'string' ? armBefore.length : Number.NaN,
      after: typeof armText === 'string' ? armText.length : Number.NaN,
      retained: kept,
      // FED IN SO A RATIO TIE IS BROKEN ON MEASURED TIME, not on the name. An
      // arm the capture never timed arrives as undefined and sorts last among
      // the tied, which is the only honest place for it: an unmeasured time
      // cannot be claimed to be faster.
      ms: t.armMs?.[label],
    });
  }
  const picked = selectArms(armCandidates, { ourRetained: inOut + derived });
  const compArm = picked.comparable === null ? null : picked.comparable.arm;
  const compText = compArm === null ? null : t.armTexts[compArm];
  const compBeforeText =
    compArm === null ? null : (t.armBeforeTexts?.[compArm] ?? text);
  const compMarkers =
    compText === null
      ? []
      : [...new Set(compText.match(/<<ccr:[^>]*>>/g) ?? [])];
  let compIn = 0;
  if (compText !== null)
    for (const id of want) if (compText.includes(id)) compIn += 1;

  // What their published arm claims it put on disk, so the substitution
  // comparison can print a store size beside its ratio the way ours does.
  const theirOffloadBytes = declaredOffloadBytes(theirText);

  // WHAT A RECOVERY COSTS IN ROUND TRIPS, on both sides, counted the same
  // way: one fetch per distinct place content was moved to. Theirs is a
  // `<<ccr:HASH,...>>` marker redeemed by `headroom_retrieve`; ours is a
  // spill path redeemed by a Read. Distinct, because two markers naming the
  // same hash are one retrieval, and a byte figure cannot see either.
  const theirMarkers = [...new Set(theirText.match(/<<ccr:[^>]*>>/g) ?? [])];
  const theirTurns = theirMarkers.length;
  let theirIn = 0;
  for (const id of want) if (theirText.includes(id)) theirIn++;

  // THEIR STORE, OPENED -- the other half of the same correction.
  //
  // The paragraph above was right that their markers are not proof of loss,
  // and then scored them as loss anyway for want of a way to check. There is
  // one: their resolver, run from a process that did not write the markers.
  // It redeems them, so their elisions belong in the recoverable column
  // exactly as our spill does, and only what neither arm can produce is gone.
  //
  // The difference that remains is the one worth stating plainly: our
  // recoverable content is a path the agent already has and can open with a
  // Read it was going to make anyway, theirs is a marker that costs a
  // `headroom_retrieve` round trip. That is a turn, not a byte, and this file
  // measures bytes -- so it reports the counts and leaves the trade visible
  // rather than folding it into a score.
  //
  // AND A RESOLUTION IS NOT AUTOMATICALLY A MEASUREMENT. Their store keeps an
  // entry for a bounded time, so a resolver run too late reports every marker
  // unresolved and reads, in the file, exactly like a store that held nothing --
  // handing us a retention win built out of our own sequencing. That case is
  // refused as unmeasured rather than scored. See store-resolution.mjs.
  const theirEntry = resolved?.[name] ?? null;
  const theirUsable = resolutionUsable(
    theirEntry,
    resolved?.__provenance__ ?? null,
    name
  );
  const theirResolved = theirUsable.usable ? (theirEntry?.text ?? null) : null;
  let theirRedeemed = 0;
  if (theirResolved !== null)
    for (const id of want)
      if (!theirText.includes(id) && theirResolved.includes(id))
        theirRedeemed++;
  const theirGone = want.size - theirIn - theirRedeemed;
  rows.push({
    name,
    before,
    after,
    ours: 1 - after / before,
    theirs: t ? 1 - t.after / t.before : 0,
    oursTokBefore: tokens(text),
    oursTokAfter: tokens(out.text),
    oursTok: 1 - tokens(out.text) / tokens(text),
    theirsTok: 1 - theirAfter / theirBefore,
    arm: t ? t.arm : 'n/a',
    // WHICH OF OUR ENGINES CLAIMED THIS PAYLOAD, or null when none did.
    // An unclaimed payload is returned untouched, so `ours` reads 0% --
    // our product declining the input, not our product examining it and
    // finding nothing. See engineNameFor in ours-engine.mjs.
    oursEngine: engineNameFor(text),
    ids: want.size,
    // Scraped but too short to score by substring. Printed rather than dropped,
    // so a denominator that shrank is visible instead of merely smaller.
    unsafe: unsafeIds.length,
    // Scraped at one level of escaping and searched for at another, so no arm
    // could ever have been credited with keeping one. Same reason for printing.
    phantoms: phantomIds,
    inOut,
    derived,
    inSpill,
    gone,
    theirIn,
    theirRedeemed,
    theirGone,
    theirMeasured: theirResolved !== null,
    theirUnmeasuredWhy: theirUsable.usable ? null : theirUsable.detail,
    bodyBefore: body?.before ?? 0,
    bodyAfter: body?.after ?? 0,
    bodyRatio: body ? 1 - body.after / body.before : null,
    bodyTokBefore: body?.tokBefore ?? 0,
    bodyTokAfter: body?.tokAfter ?? 0,
    bodyReason: body?.reason ?? '',
    bodyBehind: body?.behind ?? 0,
    bodyCachedPrefixChars: body?.cachedPrefixChars ?? 0,
    bodyCachedPrefixTok: body?.cachedPrefixTok ?? 0,
    bodyGone,
    // WHAT THE PROXY ARM PUT ON DISK, tokenised per block the way the block
    // arm's `oursBlockTok` is, so the cost model can price its round trips
    // instead of assuming it never spills.
    bodyBlockTok: bodySpilled.map(tokens),
    // THEIR LIKE-FOR-LIKE ARM. See `theirCleanState` above for why this is
    // three-valued: null here means either "no such arm" or "this capture
    // cannot be asked", and the state says which. Summing null as zero would
    // report a reduction nobody measured, on their side of the table.
    theirCleanState,
    theirCleanArm,
    theirCleanTok,
    theirCleanBeforeTok,
    theirOffloadBytes,
    // THE COMPARABLE COLUMN. `compArm === null` means either that no arm of
    // theirs retained what we retained, or that the capture could not be ranked;
    // `compDetail` says which. It is never filled in with the next-best arm.
    compArm,
    compDetail: picked.detail,
    compRatio: picked.comparable === null ? null : 1 - picked.comparable.ratio,
    compRetained:
      picked.comparable === null ? null : picked.comparable.retained,
    compTokBefore: compBeforeText === null ? null : tokens(compBeforeText),
    compTokAfter: compText === null ? null : tokens(compText),
    compIn: compText === null ? null : compIn,
    compTurns: compText === null ? null : compMarkers.length,
    compMarkerBytes: compMarkers.map(markerBytes),
    compBeforeDigest: compBeforeText === null ? null : sha(compBeforeText),
    // Their BEST arm's retention, recorded beside its ratio, so no row can show
    // a 99.6% next to a speed loss again without showing what it kept.
    bestRetained: picked.best === null ? null : picked.best.retained,
    subAfter: sub.text.length,
    subStore: subSpilled.reduce((n, c) => n + c.length, 0),
    subRatio: 1 - sub.text.length / before,
    subTok: 1 - tokens(sub.text) / tokens(text),
    subTokAfter: tokens(sub.text),
    subGone,
    presetAfter: preset.text.length,
    presetRatio: 1 - preset.text.length / before,
    presetTok: 1 - tokens(preset.text) / tokens(text),
    presetTokAfter: tokens(preset.text),
    presetFree,
    presetGone,
    missing,
    sizeSane,
    // Whole-payload content conservation, carried per row so the gate and the
    // table can both read it without recomputing.
    wordsAll: kept.words,
    // THE BUCKETS, NOT JUST THE TOTALS, because `gone 0` has two readings and
    // only the split tells them apart: a word still in the handed text is a word
    // the reader has, while a word reached only through the decoder or only out
    // of the spill costs something to get back.
    wordsInOutput: kept.inOutput,
    wordsInReconstruction: kept.inReconstruction,
    wordsInSpill: kept.inSpill,
    wordsGone: kept.gone,
    wordsGoneMass: kept.goneMass,
    wordsBeforeMass: kept.beforeMass,
    wordsGoneShare: kept.goneShare,
    wordsMissing: kept.missing,
    // What the mutilated-output control saw. Zero here invalidates the zero above.
    wordsControlGone: control.gone,
    wordsControlAll: control.words,
    // THE FLOOR THIS ROW WAS JUDGED AT, and every floor tried to get there, so a
    // reader can see that the choice was the control's and not this file's.
    // `wordsFloorChosen` is null where no floor discriminated, which is the only
    // row shape that stays blind.
    wordsMinLen: minLen,
    wordsFloorChosen: floor.minLen,
    wordsFloorTried: floor.tried,
    grew,
    spillRatio,
    // TURNS, and the tokens a turn drags back into context with it. The
    // in-context figure alone flatters whichever arm moved the most out, so
    // both are carried: what the agent is handed, and what it ends up paying
    // for if it needs all of it back.
    oursTurns: spilled.length,
    subTurns: subSpilled.length,
    // THE TIMED RETRIEVAL FOR THOSE TURNS. `subTurns` says how many round trips
    // this arm forces; this says what one of them costs in milliseconds, so the
    // two can be multiplied instead of one of them being assumed.
    subFetch,
    presetTurns: presetSpilled.length,
    theirTurns,
    // PER BLOCK, not just the total. A session cost model has to know how
    // many separate round trips the bytes arrive in and how big each one is;
    // a single sum cannot tell one 40k fetch from thirteen 3k ones.
    oursBlockTok: spilled.map(tokens),
    subBlockTok: subSpilled.map(tokens),
    presetBlockTok: presetSpilled.map(tokens),
    theirMarkerBytes: theirMarkers.map(markerBytes),
    oursTokSpill: tokens(haveSpill),
    subTokSpill: tokens(subSpill),
    presetTokSpill: tokens(presetSpill),
    theirTokRedeem:
      theirResolved === null
        ? 0
        : Math.max(0, tokens(theirResolved) - theirAfter),
    ms,
    msMin,
    msMax,
    msSamples,
    msPasses,
    subMs,
    subMsSamples,
    subMsPasses,
  });
}

const pct = (n) => `${(n * 100).toFixed(1)}%`;
const n = (v, w) => String(v).padStart(w);
// THE SAME FOUR BUCKETS ON BOTH SIDES, so a column can be read across the bar:
//   ctx    literally present in the text the model is handed
//   derv   not literal, but reconstructible from that text alone (ours)
//   ccr    not literal, redeemed from their store by a later process (theirs)
//   spill  in a file the agent can Read without asking us anything (ours)
//   gone   produced by neither the output nor any recovery path
// `derv`/`spill` and `ccr` are not the same cost -- see the note at the theirs
// scoring above -- but they are the same KIND of claim, and lining them up is
// what stops one arm's recovery counting and the other's being ignored.
// `body` is the same product measured one layer up: compressBody over the whole
// request, which sees structured content blocks where compressBlock sees only a
// serialised string. It is printed beside `ours`, never instead of it.
const bodyPct = (r) =>
  r.bodyRatio === null ? '     -' : pct(r.bodyRatio).padStart(6);
const bodyTokPct = (r) =>
  r.bodyRatio === null
    ? '     -'
    : pct(1 - r.bodyTokAfter / r.bodyTokBefore).padStart(6);
// `sub` is the SUBSTITUTION arm and the header calls it that, because it is the
// one column here that is not a compression ratio. A block it moved is on disk
// behind a path; nothing about it got smaller. It is the like-for-like against
// their content-cache column, which works the same way.
// Read once, here, because the table prints before the mixed-corpus block runs.
// ABSENT IS NOT "ALL OURS": a capture written before this field existed cannot say
// who generated a row, and defaulting it to ours would credit us with their
// fixtures -- the stronger claim -- on exactly the captures that cannot support it.
const carriedList = theirs?.__provenance__?.carriedPayloads ?? null;
const carriedEarly = new Set(carriedList ?? rows.map((r) => r.name));
console.log(
  'workload                  before     ours    body     sub   theirs |   ours    body     sub  theirs (tokens) |  ids | ours:  ctx  derv spill  gone | body: gone | sub: gone | theirs:  ctx   ccr  gone | their arm'
);
for (const r of rows) {
  console.log(
    // `*` marks a fixture THEY generated -- see the mixed-corpus block below.
    `${(carriedEarly.has(r.name) ? r.name : r.name + ' *').padEnd(22)} ${n(r.before, 8)}  ${pct(r.ours).padStart(6)}  ` +
      `${bodyPct(r)}  ${pct(r.subRatio).padStart(6)}  ${pct(r.theirs).padStart(6)} | ` +
      `${pct(r.oursTok).padStart(6)} ` +
      `${bodyTokPct(r)} ${pct(r.subTok).padStart(6)} ${pct(r.theirsTok).padStart(6)} | ` +
      `${n(r.ids, 5)} | ${n(r.inOut, 10)} ${n(r.derived, 5)} ${n(r.inSpill, 5)} ` +
      `${n(r.gone, 5)} | ${r.bodyRatio === null ? '         -' : n(r.bodyGone, 10)} | ` +
      `${n(r.subGone, 9)} | ` +
      `${n(r.theirIn, 12)} ${r.theirMeasured ? n(r.theirRedeemed, 5) : '    ?'} ` +
      `${r.theirMeasured ? n(r.theirGone, 5) : '    ?'} | ${r.arm}` +
      (r.sizeSane ? '' : '  !! SIZE BOUND FAILED') +
      (r.bodyReason ? `  [body: ${r.bodyReason}]` : '')
  );
}

// THE THIRD COLUMN: WHAT COSTS A TURN.
//
// Neither reduction figure answers the question that decides the bill. Both
// arms reach a high one the same way -- by not sending some of the bytes --
// and what separates them is what the agent does next.
//
// THIS IS NOT MEASURED IN BYTES, and the first version of it was. `after +
// spill` looks like the cost of full redemption and is not: our engines
// spill the WHOLE block and keep a skeleton of it in the output, so that sum
// counts the skeleton twice and reported -15.1% on codebase-exploration --
// a reconstruction larger than the thing reconstructed. Capping it at the
// payload would have hidden the double count rather than removed it.
//
// Information is the unit that survives the objection. Of the identifiers
// planted in each workload, how many can the agent have WITHOUT spending a
// turn? Ours: the ones still in the text, plus the ones the text alone
// rebuilds. Theirs: the ones still in the text. A `<<ccr:...>>` marker is
// never in the second group -- redeeming it is a `headroom_retrieve` call,
// and it re-injects the block at close to its original size.
console.log('');
console.log(
  'zero-turn information                       ids     ours   theirs   preset | ours = ctx + reconstructible'
);
for (const r of rows) {
  const oursFree = r.inOut + r.derived;
  console.log(
    `${r.name.padEnd(40)} ${n(r.ids, 8)}  ${n(oursFree, 6)}  ${n(r.theirIn, 6)} ${n(r.presetFree, 8)} | ` +
      `${n(r.inOut, 5)} + ${n(r.derived, 5)}`
  );
}

// WHAT THE WHOLE JOB COSTS, not what the first message costs.
//
// A reduction column answers "how big is the text the agent is handed". It
// cannot answer "what did the agent pay", because content moved to a store is
// absent from the first number and arrives in full the moment anybody wants
// it. Both arms move content, so both get the same two bounds:
//
//   handed   the compressed text alone -- the optimistic case, nothing fetched
//   whole    handed + everything the arm moved out, fetched back
//
// `whole` deliberately double-counts a skeleton that survives in the text and
// arrives again inside its own spill, because that is what the agent is
// actually billed for. It is a COST, not a reduction, and a cost above the
// original payload is a real outcome rather than an arithmetic fault.
//
// PRICE IS A PARAMETER. The dollar columns exist to make the two bounds
// comparable at a glance; every one of them scales linearly with this rate,
// so a reader on another price multiplies rather than re-runs.
const USD_PER_MTOK = 5;
const usd = (tok) => (tok / 1e6) * USD_PER_MTOK;
const money = (tok) => `$${usd(tok).toFixed(4)}`;

console.log(
  '\nturns and cost                          turns          handed tokens            whole tokens |        handed $            whole $'
);
console.log(
  'workload                            ours theirs      ours    theirs       ours    theirs |    ours   theirs     ours   theirs'
);
for (const r of rows) {
  const oursWhole = r.oursTokAfter + r.oursTokSpill;
  const theirHanded = tokens(theirs[r.name].bestText ?? '');
  const theirWhole = theirHanded + r.theirTokRedeem;
  console.log(
    `${r.name.padEnd(34)} ${n(r.oursTurns, 5)} ${n(r.theirTurns, 6)} ${n(r.oursTokAfter, 9)} ${n(theirHanded, 9)} ${n(oursWhole, 10)} ${n(theirWhole, 9)} | ` +
      `${n(money(r.oursTokAfter), 7)} ${n(money(theirHanded), 8)} ${n(money(oursWhole), 8)} ${n(money(theirWhole), 8)}`
  );
}

const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
const beforeAll = sum((r) => r.before);
const oursAll = sum((r) => r.after);
const theirsAll = sum((r) => theirs[r.name].after);
// `sum` is over every row; this is the same fold over an explicit subset, for
// totals that are only defined on some workloads.
const sum2 = (subset, f) => subset.reduce((n, r) => n + f(r), 0);
const beforeTokAll = sum((r) => r.oursTokBefore);
const oursTokAll = sum((r) => r.oursTokAfter);
// Their per-workload token ratio applied to the common denominator, so the
// corpus total is not skewed by their envelope on three of six workloads.
const theirsTokAll = sum((r) =>
  Math.round(r.oursTokBefore * (1 - r.theirsTok))
);

// THE SUBSTITUTION ARM'S OWN TOTALS, on the same denominators as the two above.
// They are not a compression ratio and the line below says so: a moved block is
// on disk, and `spill store` reports what that costs.
const subAll = sum((r) => r.subAfter);
// THE PRESET ARM'S TOTALS, likewise. Part of this one IS a compression ratio --
// the blocks the engines kept -- and part of it is a move, which is why it is
// reported next to its own zero-turn count rather than on its own.
const presetAll = sum((r) => r.presetAfter);
const presetTokAll = sum((r) => r.presetTokAfter);
const subTokAll = sum((r) => r.subTokAfter);

// WHAT THE WHOLE SESSION COSTS, which is what a subscription is metered on.
//
// The two bounds above price a payload as if it were sent once and then
// forgotten. An agent re-sends the conversation on every request, so the real
// question is what the payload costs over the turns that FOLLOW it -- with the
// cached prefix billed at a tenth, and with each retrieval charged the extra
// request it forces rather than only the bytes it hands back. That last term
// is the one a byte column cannot see, and it is the one that decides this
// comparison. `cost-model.mjs` holds the model and names its two assumptions.
const armsFor = (r, params) => {
  const theirHanded = tokens(theirs[r.name].bestText ?? '');
  // Their per-block split is read off their own markers; the TOTAL is measured
  // from their resolver. A rounded `156.3KB` can move how the bytes spread
  // across turns, never how many of them there are.
  const bytes = r.theirMarkerBytes;
  const byteSum = bytes.reduce((a, b) => a + b, 0);
  const theirBlocks = bytes.map((b) =>
    byteSum === 0 ? 0 : (r.theirTokRedeem * b) / byteSum
  );
  const L = (handed, blocks, cachedPrefix = 0) =>
    costLine({ handed, blocks, cachedPrefix, params });
  // The comparable arm is not one we resolved, so its redeem cost is UNMEASURED.
  // Pricing every one of its markers at zero redeem tokens is a LOWER BOUND on
  // their cost, which can only make the bar we have to clear harder, never
  // easier -- so the comparison stays sound and decidable. It must be reported
  // as a bound, not as their measured cost.
  const compBlocks = r.compMarkerBytes.map(() => 0);
  return {
    none: L(r.oursTokBefore, []),
    ours: L(r.oursTokAfter, r.oursBlockTok),
    theirs: L(theirHanded, theirBlocks),
    theirsComparable:
      r.compTokAfter === null ? null : L(r.compTokAfter, compBlocks),
    preset: L(r.presetTokAfter, r.presetBlockTok),
    // THE PROXY ARM, PRICED BUT NOT YET THE PUBLISHED COLUMN. `ours` above is
    // `compressBlock`, which is what the MCP tools apply to one block of text.
    // Every payload in this corpus is a request BODY, and the surface that
    // shrinks a request body -- the one an AI subscription is billed for -- is
    // the proxy, `compressBody`. The two arms disagree by up to 60 points in
    // BOTH directions, so which one the published column prices is a decision
    // about what we are claiming, not a detail; this records the proxy arm's
    // cost so that decision can be made against measured numbers.
    //
    // `null` ONLY WHERE THERE IS NO PROXY ARM, AND EVERY ZERO IS PRICED. This
    // also nulled `bodyRatio === 0`, on the reasoning that the proxy declines
    // to rewrite content behind the client's cache marker and a refusal is not
    // a zero-saving result. The reasoning is sound and it covered the wrong
    // rows. Seven rows here read 0.0%, and on five of them `bodyBehind` is
    // exactly 0.000000: nothing was behind a marker, the arm was handed the
    // whole payload, and it returned it unchanged. Nulling those took a
    // zero-saving arm off the board rather than pricing it, which is a credit
    // to us on rows where we earned nothing.
    //
    // NO THRESHOLD SEPARATES THE TWO KINDS OF ZERO, which is why the fix is to
    // price both rather than to test for a refusal. `bodyBehind` on agent-loop
    // is 0.999537 and on agent-loop-logs 0.999771 -- never exactly 1, because
    // the marker sits on the second-to-last turn and the turns after it are
    // real bytes -- so `=== 1` matches neither, and any cutoff above 0.99 is a
    // number I would be choosing to make two rows disappear. `summary.reason`
    // cannot separate them either: all seven say "compression did not pay".
    //
    // AND THE COLUMN ASKS A QUESTION THE REASON DOES NOT CHANGE. This prices
    // how much of a subscription a user stops spending. A payload the proxy was
    // right to leave alone is a payload the user still pays for in full, so its
    // price is zero either way; `bodyBehind` is recorded per row so the reason
    // for each zero stays visible, and the disclosure is the place for it.
    //
    // `bodyTokBefore` counts the `model`/`max_tokens` envelope the harness
    // wraps around the messages, so this arm is charged about 15 tokens the
    // other arms are not -- a bias against us, kept rather than corrected so
    // the number cannot be accused of being tuned. On a 0.0% row that bias is
    // the whole difference: rag-conversation prices ABOVE doing nothing.
    proxy:
      r.bodyRatio === null
        ? null
        : L(
            r.bodyTokAfter,
            r.bodyBlockTok,
            Math.min(r.bodyCachedPrefixTok, r.bodyTokAfter)
          ),
  };
};

// The fold belongs to the model, not to this file. A local copy that knew only
// the field names of an older cost line would drop the rest in silence, and the
// corpus row -- the one the README quotes -- would be quietly wrong while every
// per-session row above it stayed right.
// AND NOT COMPUTED AT ALL WHEN THE BASE CONTEXT IS NOT RECORDED: every line
// in here is denominated in effective input tokens, which is the payload plus
// `baseContextTokens`, and arithmetic on a missing term still prints as a
// number.
const sessionCosts = !COST_PRICED
  ? []
  : rows.map((r) => {
      const arms = armsFor(r, PARAMS);
      return {
        name: r.name,
        r,
        arms,
        cross: breakEven(arms.ours, arms.theirs),
        crossComparable:
          arms.theirsComparable === null
            ? null
            : breakEven(arms.ours, arms.theirsComparable),
      };
    });
const foldCorpus = (all) => {
  const keys = ['none', 'ours', 'theirs', 'preset'];
  const out = {};
  for (const key of keys) out[key] = sumLines(all.map((a) => a[key]));
  // A total over a SUBSET of rows is not comparable with a total over all of
  // them, so the comparable arm folds only when every row has one. Otherwise
  // it is null -- unmeasured, never quietly summed over the rows that happen
  // to have it.
  const comps = all.map((a) => a.theirsComparable);
  out.theirsComparable = comps.every((c) => c !== null && c !== undefined)
    ? sumLines(comps)
    : null;
  out.cross = breakEven(out.ours, out.theirs);
  out.crossComparable =
    out.theirsComparable === null
      ? null
      : breakEven(out.ours, out.theirsComparable);
  return out;
};
const corpus = !COST_PRICED
  ? null
  : foldCorpus(sessionCosts.map((c) => c.arms));
// Keyed for the record block, which walks `rows` rather than `sessionCosts`.
const byName = !COST_PRICED
  ? {}
  : Object.fromEntries(sessionCosts.map((c) => [c.name, c.arms]));
const crossByName = !COST_PRICED
  ? {}
  : Object.fromEntries(sessionCosts.map((c) => [c.name, c.cross]));
const crossComparableByName = !COST_PRICED
  ? {}
  : Object.fromEntries(sessionCosts.map((c) => [c.name, c.crossComparable]));

const k = (t) => `${(t / 1000).toFixed(1)}k`;
// EVERY `times` HERE IS A CORPUS RATIO, SO THE COMMON TERM IS PER SESSION
// TIMES THE NUMBER OF SESSIONS. A workload is one session, and the assistant
// writes its own output in each of them regardless of which arm packed the
// context. That output is 11.6% of the measured bill and no arm touches it, so
// it belongs on BOTH sides of a "what the cap buys" ratio -- omitted, it
// pushed every multiple away from 1, always in our favour.
const CORPUS_COMMON = !COST_PRICED
  ? null
  : commonSessionCost(PARAMS) * sessionCosts.length;
const times = (base, arm) =>
  `${usageMultiplier(base, arm, { commonCost: CORPUS_COMMON, params: PARAMS }).toFixed(2)}x`;

if (!COST_PRICED) {
  // THE WHOLE COST SECTION, WITHHELD IN ONE PLACE. Printing a dash per column
  // would leave the banner, the break-even sentence and the sensitivity grid
  // all still claiming to describe something, so the section says what is
  // missing and what to run rather than printing a shape with nothing in it.
  console.log('');
  console.log(
    'session cost, effective input tokens: WITHHELD -- base context is not ' +
      'recorded for this environment'
  );
  console.log(`  ${BASE.reason}`);
  console.log(
    '  Every cost figure adds base context to both arms, so quoting one ' +
      'without it would'
  );
  console.log(
    '  publish a saving nobody measured. Record it and this section prices ' +
      'itself:'
  );
  console.log('    node bench/subscription/base-context.mjs --record');
} else {
  console.log(
    `
session cost, effective input tokens -- ${PARAMS.turnsAfter} turns after the ` +
      `payload, ${k(PARAMS.baseContextTokens)} of prior context (RECORDED over ` +
      `${BASE.record.sessions} sessions, not assumed -- ` +
      `bench/subscription/results/base-context.json)`
  );
  console.log(
    '                          spill sites |     nothing fetched      |  everything fetched  | ours vs'
  );
  console.log(
    'workload                 ours pre theirs |   none    ours  preset  theirs |   ours  preset  theirs | theirs'
  );
  for (const c of sessionCosts) {
    console.log(
      `${c.name.padEnd(24)} ${n(c.r.oursTurns, 4)} ${n(c.r.presetTurns, 3)} ${n(c.r.theirTurns, 6)} | ` +
        `${n(k(costAt(c.arms.none, 0)), 6)} ${n(k(costAt(c.arms.ours, 0)), 7)} ` +
        `${n(k(costAt(c.arms.preset, 0)), 7)} ${n(k(costAt(c.arms.theirs, 0)), 7)} | ` +
        `${n(k(costAt(c.arms.ours, 1)), 6)} ${n(k(costAt(c.arms.preset, 1)), 7)} ` +
        `${n(k(costAt(c.arms.theirs, 1)), 7)} | ` +
        `${n(breakEvenLabel(c.cross), 7)}`
    );
  }
  // Our spilling arm against theirs, which is the comparison that decides whether
  // eviction or in-place compression is the better answer to a cache-read bill.
  {
    const pre = breakEven(corpus.preset, corpus.theirs);
    console.log(
      `  preset (our spilling arm) vs theirs, whole corpus: ` +
        `${k(costAt(corpus.preset, 0))} -> ${k(costAt(corpus.preset, 1))} against ` +
        `${k(costAt(corpus.theirs, 0))} -> ${k(costAt(corpus.theirs, 1))}, ` +
        `preset wins ${breakEvenLabel(pre)}`
    );
  }

  // THE SUBSCRIPTION QUESTION, answered in the unit a plan is metered in. A cap
  // is a token budget, so "costs 40% as much" and "the cap buys 2.5x as much of
  // this work" are one sentence; the second is the one that was asked.
  console.log(
    '\nwhat a plan buys, whole corpus          effective tokens          the same cap buys'
  );
  console.log(
    'fetch rate    nothing      ours    theirs |     ours   theirs   vs them'
  );
  for (const p of [0, 0.25, 0.5, 1]) {
    const none = costAt(corpus.none, p);
    const ours = costAt(corpus.ours, p);
    const them = costAt(corpus.theirs, p);
    console.log(
      `${n(`${(p * 100).toFixed(0)}%`, 10)} ${n(k(none), 10)} ${n(k(ours), 9)} ${n(k(them), 9)} | ` +
        `${n(times(none, ours), 8)} ${n(times(none, them), 8)} ${n(times(them, ours), 9)}`
    );
  }
  console.log(
    corpus.cross.p === null
      ? `${corpus.cross.cheaper === 'a' ? 'ours' : 'theirs'} is cheaper at every ` +
          `fetch rate from 0 to 100%`
      : `${corpus.cross.cheaper === 'a' ? 'ours' : 'theirs'} is cheaper than the ` +
          `other while the agent fetches back less than ` +
          `${(corpus.cross.p * 100).toFixed(0)}% of what was moved out` +
          (corpus.cross.crossings.length > 1
            ? `, and they swap back at ${(corpus.cross.crossings[1] * 100).toFixed(0)}%`
            : '')
  );

  // THE OBVIOUS ATTACK ON THE ABOVE, run rather than waited for. Both numbers in
  // DEFAULTS are guesses about how a session is used, so the table prints how far
  // the answer moves when they move.
  // AT HALF THE BLOCKS FETCHED, not at none. With nothing fetched the cache
  // factor is common to every arm and cancels, so a p = 0 column would print
  // the same ratio on every row and prove only that it had been divided out.
  console.log('\nsensitivity, at a 50% fetch rate');
  console.log('turns after   prior ctx |  ours x   theirs x | ours wins below');
  // THE GRID IS DERIVED FROM THE MEASUREMENT, NOT PINNED TO ROUND NUMBERS.
  // It was [4000, 12000, 40000], every value of which is below what this
  // machine actually carries -- a sensitivity band that does not contain the
  // real parameter tests nothing about the real claim.
  for (const turnsAfter of [5, 20, 60])
    for (const baseContextTokens of [
      BASE.record.min,
      BASE.record.p50,
      BASE.record.max,
    ]) {
      const params = { ...PARAMS, turnsAfter, baseContextTokens };
      const c = foldCorpus(rows.map((r) => armsFor(r, params)));
      const none = costAt(c.none, 0.5);
      console.log(
        `${n(turnsAfter, 11)} ${n(k(baseContextTokens), 11)} | ` +
          `${n(times(none, costAt(c.ours, 0.5)), 7)} ` +
          `${n(times(none, costAt(c.theirs, 0.5)), 9)} | ` +
          `${n(breakEvenLabel(c.cross), 12)}`
      );
    }
}

const oursChars = 1 - oursAll / beforeAll;
const theirsChars = 1 - theirsAll / beforeAll;
const oursTokens = 1 - oursTokAll / beforeTokAll;
const theirsTokens = 1 - theirsTokAll / beforeTokAll;

console.log('');
console.log(
  `chars   ours ${pct(oursChars)}   theirs ${pct(theirsChars)}   (denominator: the payload bytes both arms were given; theirs is best-of-any arm, offload included -- see like4like)`
);
console.log(
  `tokens  ours ${pct(oursTokens)}   theirs ${pct(theirsTokens)}   (denominator: the same payload; ${ENCODING_NAME} on text, pixels/750 on images, both arms' real output; theirs is best-of-any arm, offload included -- see like4like)`
);
// THE LIKE-FOR-LIKE ROW: our encoding arm against their best NON-offloading
// arm, over the workloads where such an arm exists on their side.
//
// The `theirs` line above is their best arm of any kind. Several of their arms
// reach their ratio by writing content to a local store, which is exactly what
// our `sub` line below is labelled "SUBSTITUTION, not reduction" for doing. So
// the line above compares our encoding arm with their substitution arm, and
// this line is the comparison that is actually apples to apples.
//
// IT IS SCORED ONLY OVER THE WORKLOADS WHERE IT IS DEFINED, and says how many
// those are. Counting a workload where every arm of theirs offloaded as "their
// non-offload arm reduced 0%" would invent a measurement, and it would invent
// one on their side of the table, which flatters us.
// HOISTED OUT OF A BARE BLOCK so the record and the gate can both reach these.
// They were computed where only console.log could see them, so the one
// comparison this harness calls apples-to-apples could be neither published
// nor enforced -- and the gate below judged our non-offloading arm against
// their offloading one.
const like4like = (() => {
  const measured = rows.filter((r) => r.theirCleanState === 'measured');
  const noClean = rows.filter((r) => r.theirCleanState === 'none');
  const unrecorded = rows.filter((r) => r.theirCleanState === 'unrecorded');
  if (measured.length === 0)
    return { ours: null, theirs: null, measured, noClean, unrecorded };
  return {
    ours:
      1 -
      sum2(measured, (r) => r.oursTokAfter) /
        sum2(measured, (r) => r.oursTokBefore),
    theirs:
      1 -
      sum2(measured, (r) => r.theirCleanTok) /
        sum2(measured, (r) => r.theirCleanBeforeTok),
    measured,
    noClean,
    unrecorded,
  };
})();
if (like4like.ours !== null)
  console.log(
    `like4like  ours ${pct(like4like.ours)}   theirs ${pct(like4like.theirs)}   ` +
      `(tokens, over the ${like4like.measured.length} of ${rows.length} workloads where they have a ` +
      'non-offloading arm; their column above is best-of-any and includes offload)'
  );
if (like4like.noClean.length > 0)
  console.log(
    `           no like-for-like number on ${like4like.noClean.length}: ` +
      `${like4like.noClean.map((r) => r.name).join(', ')} -- every arm of theirs moved bytes to the store`
  );
if (like4like.unrecorded.length > 0)
  console.log(
    `           cannot be asked on ${like4like.unrecorded.length}: ` +
      `${like4like.unrecorded.map((r) => r.name).join(', ')} -- captured before run-theirs.py recorded ` +
      'every arm; re-capture to score these'
  );
// TRAILING ON THE OFFLOAD-INCLUSIVE FIGURE IS SAID OUT LOUD. It stopped being
// the gate because it compares arms that are not comparable, and a number that
// is no longer enforced is exactly the kind that goes quiet. This line keeps it
// audible: it is what a user of their tool actually receives, whatever the
// like-for-like row says.
if (oursTokens <= theirsTokens)
  console.log(
    `NOTE  offload included, their best arm takes ${pct(theirsTokens)} of tokens off to our ` +
      `${pct(oursTokens)}. We lead like-for-like above; on the store column our sub arm ` +
      `takes ${pct(1 - subTokAll / beforeTokAll)} off with ${sum((r) => r.subGone)} identifier(s) unrecoverable. ` +
      'Both columns are gated; this mixed one is disclosure, not a verdict.'
  );
console.log(
  `free    ours ${sum((r) => r.inOut + r.derived)}   theirs ${sum((r) => r.theirIn)}   ` +
    `of ${sum((r) => r.ids)} identifiers, available with no extra turn`
);
console.log(
  `preset  chars ${pct(1 - presetAll / beforeAll)}   tokens ${pct(1 - presetTokAll / beforeTokAll)}   ` +
    `free ${sum((r) => r.presetFree)}   lost ${sum((r) => r.presetGone)}   ` +
    '(spillWholeBlockBelow 0.9: move only what the engines could not take 90% off)'
);
console.log(
  `sub     chars ${pct(1 - subAll / beforeAll)}   tokens ${pct(1 - subTokAll / beforeTokAll)}   ` +
    `(SUBSTITUTION, not reduction: the moved blocks are on disk, see the store line below)`
);
// The body arm's own denominator, over the workloads it could run -- NOT the
// corpus denominator above. Mixing them would let a body total that skipped a
// workload be read against a block total that did not.
const bodyRows = rows.filter((r) => r.bodyRatio !== null);
if (bodyRows.length > 0) {
  const bSum = (f) => bodyRows.reduce((n, r) => n + f(r), 0);
  const bChars = 1 - bSum((r) => r.bodyAfter) / bSum((r) => r.bodyBefore);
  const bTok = 1 - bSum((r) => r.bodyTokAfter) / bSum((r) => r.bodyTokBefore);
  const blockSame = 1 - bSum((r) => r.after) / bSum((r) => r.before);
  console.log(
    `body    chars ${pct(bChars)}   tokens ${pct(bTok)}   over ${bodyRows.length}/${rows.length} workloads ` +
      `(compressBlock on the same ${bodyRows.length}: ${pct(blockSame)} chars)`
  );
}
// STATED NEUTRALLY, because the first version of this summary was one-sided in
// our favour and the second was one-sided against us. BOTH arms elide with a
// recovery path, so "absent from the text" is not loss on either side -- and
// the fix for counting their store as empty was never to count ours as empty
// too, it was to open both. Both are opened now, so the numbers below are
// post-recovery on both arms and a `gone` is a real gone.
//
// In-context presence still does not favour us on these fixtures: the higher
// reduction is reached partly BY eliding more, so fewer needles stay directly
// visible. What differs is the price of the follow-up -- a path we already
// handed the agent versus a retrieval call -- and that is a turn, which this
// harness does not measure and must not quietly score.
const oursIn = sum((r) => r.inOut);
const oursDerived = sum((r) => r.derived);
const oursSpilled = sum((r) => r.inSpill);
const theirsIn = sum((r) => r.theirIn);
const theirsRedeemed = sum((r) => r.theirRedeemed);
// OUR OWN COLUMN, DISCLOSED THE SAME WAY THEIRS IS.
//
// A payload no engine of ours claims comes back untouched, so it scores a 0%
// saving. Printed beside eleven rows that WERE compressed, that zero reads as
// "our engine found nothing here" when what happened is "our engine declined
// to look". Both are legitimate outcomes to publish -- a user pasting that
// content really does save nothing -- but they are different claims, and only
// one of them is also what a malformed fixture looks like. Every payload in
// every capture is claimed today, so this block prints nothing; it exists so
// that a fixture regenerated tomorrow cannot quietly become a measured zero.
//
// Silent on a known-answer run: the stub is not an engine, so the question
// does not apply and `engineNameFor` returns null for every row by design.
// WHOSE FIXTURE EACH ROW IS, taken from the sweep's own provenance.
// `carriedPayloads` is what run-theirs.py was handed by us; everything else in the
// capture came from their generators. Read that way round, a fixture we stop
// carrying cannot silently keep being credited as ours.
for (const r of rows)
  r.fixtureOwner =
    carriedList === null ? null : carriedEarly.has(r.name) ? 'ours' : 'theirs';
const theirFixtureRows = rows.filter((r) => r.fixtureOwner === 'theirs');
if (carriedList === null) {
  console.log('');
  console.log(
    '  FIXTURE OWNERSHIP UNKNOWN: this capture predates the carriedPayloads ' +
      'provenance field, so no row here may be quoted as a win on their own corpus.'
  );
} else if (theirFixtureRows.length) {
  console.log('');
  console.log(
    `  MIXED CORPUS: ${theirFixtureRows.length} of ${rows.length} row(s) are THEIR OWN ` +
      'fixtures, marked * in the table above. Those rows and ours are not one headline:'
  );
  const part = (label, set) => {
    if (!set.length) return;
    const b = set.reduce((a, r) => a + r.before, 0);
    const o = set.reduce((a, r) => a + r.after, 0);
    const t = set.reduce((a, r) => a + r.before * (1 - r.theirs), 0);
    // BOTH METRICS, NAMED. The two headlines disagree on this corpus -- we lead on
    // chars and trail on tokens -- so a subtotal that printed one unnamed would be
    // read as whichever half of the split the reader already had in mind.
    const bt = set.reduce((a, r) => a + r.oursTokBefore, 0);
    const ot = set.reduce((a, r) => a + r.oursTokAfter, 0);
    const tt = set.reduce(
      (a, r) => a + Math.round(r.oursTokBefore * (1 - r.theirsTok)),
      0
    );
    console.log(
      `    ${label.padEnd(20)} ${String(set.length).padStart(2)} row(s)   ` +
        `chars ours ${pct(1 - o / b)} theirs ${pct(1 - t / b)}   ` +
        `tokens ours ${pct(1 - ot / bt)} theirs ${pct(1 - tt / bt)}`
    );
    // AND THE LIKE-FOR-LIKE HALF OF IT, for the same reason the corpus line carries
    // one: the `theirs` figures just printed are best-of-any, so on a half where
    // their winning arm offloads to their store, that column is their substitution
    // arm against our encoding arm. Scored only over the rows of this half where a
    // non-offloading arm of theirs was actually measured, and says how many.
    const clean = set.filter((r) => r.theirCleanState === 'measured');
    if (clean.length > 0) {
      const cb = clean.reduce((a, r) => a + r.oursTokBefore, 0);
      const co = clean.reduce((a, r) => a + r.oursTokAfter, 0);
      const ctb = clean.reduce((a, r) => a + r.theirCleanBeforeTok, 0);
      const ct = clean.reduce((a, r) => a + r.theirCleanTok, 0);
      console.log(
        `    ${''.padEnd(20)} ${String(clean.length).padStart(2)} of those   ` +
          `like4like ours ${pct(1 - co / cb)} theirs ${pct(1 - ct / ctb)}   (tokens, their non-offloading arm)`
      );
    }
  };
  part('their own fixtures', theirFixtureRows);
  part(
    'our fixtures',
    rows.filter((r) => r.fixtureOwner === 'ours')
  );
  console.log(
    '    Beating them on fixtures they chose is the stronger claim, beating them on ' +
      'ours the weaker one. Quote whichever is being made, never the blend.'
  );
}
const oursDeclined = KNOWN_ANSWER_OURS
  ? []
  : rows.filter((r) => r.oursEngine === null);
if (oursDeclined.length) {
  console.log('');
  console.log(
    `  OUR ENGINE DECLINED ${oursDeclined.length} of ${rows.length} workload(s). Their 0% saving is ` +
      'our product refusing the input, NOT our product examining it and finding nothing:'
  );
  for (const r of oursDeclined)
    console.log(`    ${r.name}: no engine claimed this payload`);
  console.log(
    '    Check the fixture before reading the row: a payload truncated or rewrapped ' +
      'so it no longer parses loses its claim, and then measures a no-op.'
  );
}
const theirsUnmeasured = rows.filter((r) => !r.theirMeasured);
const allIds = sum((r) => r.ids);
console.log(`retention units           ${allIds}`);
// THE TWO EXCLUSIONS, NAMED, because both of them make every loss column below
// smaller and neither of them is a measurement of the compressor. `unsafe` is
// too short to locate by substring; `phantom` is not a substring of its own
// payload at the depth the search runs, so it is unretainable by construction
// and was being charged to whichever arm normalised the escaping around it.
console.log(
  `  excluded       ${sum((r) => r.unsafe)} too short to locate, ` +
    `${sum((r) => r.phantoms)} not literal in their own payload`
);
console.log(
  `  in context     ours ${oursIn}   theirs ${theirsIn}` +
    (theirsIn > oursIn ? '   <-- THEY keep more directly visible' : '')
);
console.log(
  `  reconstructible  ours ${oursDerived} from the output alone, no extra turn`
);
console.log(
  `  recoverable    ours ${oursSpilled} via a path in the output (one Read)   ` +
    `theirs ${theirsRedeemed} via their CCR store (one retrieval call)`
);
console.log(
  `  unrecoverable  ours ${lost}   theirs ${sum((r) => (r.theirMeasured ? r.theirGone : 0))}`
);
if (theirsUnmeasured.length) {
  console.log(
    `  THEIR STORE UNMEASURED on ${theirsUnmeasured.length} workload(s). Their column is not ` +
      'comparable on those rows, and an unmeasured store is never scored as their loss.'
  );
  // The reason, per row. "No resolution at all" and "a resolution taken after
  // their store forgot" need different fixes, and only the second one can be
  // mistaken for a win.
  for (const r of theirsUnmeasured)
    console.log(
      `    ${r.name}: ${r.theirUnmeasuredWhy ?? 'no theirs-resolved.json for this out-dir'}`
    );
  console.log(
    '    Fix: run the sweep and resolve-theirs.py back to back, in one session, ' +
      'inside their store TTL.'
  );
}
// SAID OUT LOUD. Most retained identifiers live in the spill, and the spill is
// about the size of the input -- so the saving is a saving in CONTEXT, not on
// disk. That is the design (context tokens are the billed resource and a spill
// is fetched only by an explicit Read), but a reader is entitled to see the
// number rather than be told the conclusion.
console.log(
  `spill store: ${(sum((r) => r.spillRatio * r.before) / beforeAll).toFixed(2)}x the input, on disk, ` +
    `read only when an elision is followed up`
);
// Said out loud for the same reason: a reader comparing these columns is
// entitled to know we configured their side, and which way that cuts.
{
  const backend = theirs.__provenance__?.detectBackend ?? null;
  const byUs = theirs.__provenance__?.detectBackendSetByHarness ?? null;
  if (backend)
    console.log(
      `their detector: ${backend}${byUs === true ? ' -- set by this harness' : ' -- preset by the operator'}` +
        (byUs === true
          ? ', not their Windows default. It is their fastest and best-routing backend, ' +
            'so their column here is the strongest version of them.'
          : '')
    );
}
// SAID OUT LOUD, ABOVE THE SUBTOTALS, because the reader of a table is the one
// who would otherwise quote it. A degraded capture is refused at the bottom of
// this file too, but a refusal that only shows up as an exit code is invisible
// to someone reading the output.
if (competitorDegraded) {
  console.log(
    `THEIR SIDE IS NOT HEALTHY IN THIS CAPTURE: ${competitorDegraded}. Their column is ` +
      'a floor on their engine, not a measurement of it, so no row here may be quoted ' +
      'as a win. Re-capture on a quiesced machine.'
  );
}
console.log(
  // THE SUBSTITUTION ARM'S STORE, PRINTED BESIDE ITS RATIO, because a column
  // reading 100.0% has to be readable as what it is. Nothing was compressed
  // there: the blocks are on disk at about their original size, and the ratio
  // measures how little of them is left in the request. Their content cache
  // column is the same trade with the same store behind it.
  `  substitution arm: ${(sum((r) => r.subStore) / beforeAll).toFixed(2)}x the input on disk, ` +
    `${sum((r) => r.subGone)} identifiers unrecoverable`
);

// LOST OR TIED, JUDGED LIKE-FOR-LIKE.
//
// This was `r.ours <= r.theirs`, and `r.theirs` is their best arm of ANY kind.
// It therefore failed us on every row where their winner had moved the payload
// to their store and left a marker -- the same mixed comparison the corpus gate
// carried, one row at a time. `r.compRatio` is their comparable arm on that row,
// which is the arm that is still holding the content.
//
// A row where that arm does not exist cannot be judged this way at all. It is
// listed separately rather than counted as a win, because passing a row on
// absent evidence is exactly how a gate goes quiet.
const verdict = judgeRows(rows);
const { lost: lostWorkloads, unjudgeable, behindOffload } = verdict;
if (lostWorkloads.length)
  console.log(
    `LOST OR TIED ON: ${lostWorkloads.join(', ')} (like-for-like, against their ` +
      'comparable arm)'
  );
if (unjudgeable.length)
  console.log(
    `NOT JUDGEABLE LIKE-FOR-LIKE ON: ${unjudgeable.join(', ')} -- no arm of theirs ` +
      'kept the content, so these rows are counted neither way'
  );
if (behindOffload.length)
  console.log(
    `BEHIND THEIR BEST-OF-ANY ARM ON: ${behindOffload.join(', ')} -- offload included. ` +
      'Disclosure, not the gate: see the NOTE beside the corpus totals.'
  );
if (lostWorkloads.length)
  console.log(`LOST OR TIED ON: ${lostWorkloads.join(', ')}`);
// WHOLE-PAYLOAD CONSERVATION, printed whatever it says.
//
// The retention block above is scored over a scrape of identifiers. This is
// scored over every word of every payload long enough to locate, which is the
// denominator that includes the prose an identifier oracle cannot see. A row
// with words gone is not automatically a defect -- an arm may be deliberately
// lossy -- but it is the number that decides whether a reduction has been
// EXPLAINED, and it was never measured before.
{
  const wAll = sum((r) => r.wordsAll);
  const wGone = sum((r) => r.wordsGone);
  const mass = sum((r) => r.wordsGoneShare * r.before);
  console.log('');
  console.log(
    `content conservation   ${wAll} word(s) at ${8}+ chars   gone ${wGone}   ` +
      `(${((wGone / Math.max(1, wAll)) * 100).toFixed(2)}% of words, ` +
      `${((mass / beforeAll) * 100).toFixed(2)}% of the payload's bytes)`
  );
  const offenders = rows.filter((r) => r.wordsGone > 0);
  for (const r of offenders)
    console.log(
      `  ${r.name.padEnd(22)} ${String(r.wordsGone).padStart(6)} of ${String(r.wordsAll).padStart(6)}   ` +
        `${(r.wordsGoneShare * 100).toFixed(2)}% of its bytes   e.g. ${r.wordsMissing.join(', ')}`
    );
  if (offenders.length === 0)
    console.log(
      '  every word of every payload is in the output, its expansion, or the spill it points at'
    );
  // THE CONTROL, REPORTED BESIDE THE RESULT. A row whose control saw no loss is
  // a row where this oracle cannot see one, so its clean reading is withdrawn
  // rather than counted. Blindness is now a much stronger statement than it was,
  // because the floor was already lowered as far as four characters looking for a
  // reading: a row here is one where the control found nothing at ANY floor.
  const blind = rows.filter((r) => r.wordsFloorChosen === null);
  // THE TWO WAYS OF SAYING IT MUST AGREE. `minLen` falls back to the default when
  // no floor discriminates, so a row with a chosen floor whose control saw
  // nothing would mean the floor was picked from a reading nobody can reproduce.
  const floorMismatch = rows.filter(
    (r) => (r.wordsFloorChosen === null) !== (r.wordsControlGone === 0)
  );
  if (floorMismatch.length) {
    console.error(
      `
FLOOR AND CONTROL DISAGREE on ${floorMismatch.length} row(s), so one of ` +
        'them is not measuring what it claims: ' +
        floorMismatch
          .map(
            (r) =>
              `${r.name}(chosen ${r.wordsFloorChosen}, controlGone ${r.wordsControlGone})`
          )
          .join(', ')
    );
    process.exit(1);
  }
  if (blind.length)
    console.log(
      `  NOT EVIDENCE ON ${blind.length} of ${rows.length}: the control (half the output, no expansion, no spill) ` +
        `lost nothing there at any floor down to ${MIN_FLOOR}, so a clean reading on these rows means only that the ` +
        'oracle is blind to them -- ' +
        blind.map((r) => `${r.name}(${r.wordsAll} word(s))`).join(', ')
    );
  else
    console.log(
      `  control: mutilating the output loses ${sum((r) => r.wordsControlGone)} word(s) across all ` +
        `${rows.length} rows, so a clean reading above is a reading and not a blind spot`
    );
  // THE FLOOR EACH ROW WAS JUDGED AT. Eight is where fifteen rows resolve, so
  // anything else named here is a row the control could not read at eight and
  // the floor it could be read at instead. This is the whole of what replaced
  // the 48-byte segment unit, which was measured on all eighteen rows and
  // rejected: it disagreed with the word oracle on thirteen of the fifteen rows
  // where the word oracle resolves, because a segment breaks on a reformat and
  // this engine reformats everything.
  const lowered = rows.filter((r) => r.wordsMinLen !== MIN_WORD_LEN);
  console.log(
    `  floors: ${rows.length - lowered.length} row(s) judged at the ${MIN_WORD_LEN}-character floor` +
      (lowered.length
        ? `, ${lowered.length} lowered by the control -- ` +
          lowered
            .map(
              (r) =>
                `${r.name}(floor ${r.wordsMinLen}, ${r.wordsAll} word(s), gone ${r.wordsGone}, control ${r.wordsControlGone})`
            )
            .join(', ')
        : '')
  );
  for (const r of blind)
    console.log(
      `    ${r.name.padEnd(22)} NO FLOOR DISCRIMINATES -- ` +
        r.wordsFloorTried
          .map((t) => `${t.minLen}:${t.words}w/ctl${t.controlGone}`)
          .join('  ')
    );
}

const unconserved = rows.filter((r) => !r.sizeSane).map((r) => r.name);
if (unconserved.length)
  console.log(`SIZE BOUND FAILED ON: ${unconserved.join(', ')}`);
// NAMED, BECAUSE A DECODER GAP LOOKS EXACTLY LIKE DATA LOSS IN THE COLUMNS
// ABOVE and the two want opposite fixes. Anything listed here was scored as if
// unrecoverable, so the gap costs us.
//
// AND NOW A GATE, NOT A WORK QUEUE. It was left ungating while the queue had
// entries on it, so that the gap stayed visible while it was being worked
// rather than blocking every run. The queue is empty: hr30 and hr31 both score
// with zero refusals. A list that is empty and ungated is one silent
// regression away from being neither, and the two things this catches are both
// disqualifying -- our own shipped decoder unable to read our own output, or
// the harness mis-addressing it, which is the `harness: n of m
// back-references` case and means the recovery column was measuring less than
// it claimed.
for (const [label, reason] of refusals)
  console.log(`DECODER REFUSED on ${label}: ${reason}`);

// COUNTED SEPARATELY AND PRINTED SEPARATELY, because the two lines want opposite
// fixes. The one above is a decoder that cannot read our own output; this one is
// the design working -- content moved to a spill, one `Read` away -- and it was
// being tallied into a variable nothing ever printed, which is the same as not
// measuring it. A column of these growing is worth seeing; a column of these
// being called defects is what put six by-design markers on the work queue.
for (const [label, n] of pathRefusals)
  console.log(`moved to a spill path on ${label}: ${n}`);

// MUST-WIN 2b prices the round trips this arm forces, and the figure it prices
// them at can only be taken while the sweep is running. A figure that came back
// null would otherwise surface days later as an UNMEASURED gate, long after the
// only run that could have measured it. So say here what was timed, and name the
// rows that moved content out without a figure to multiply.
const fetchTimed = rows.filter((r) => r.subFetch != null);
const fetchMissing = rows.filter((r) => r.subTurns > 0 && r.subFetch == null);
if (fetchTimed.length > 0) {
  const per = fetchTimed.map((r) => slowEstimate(r.subFetch.passes));
  console.log(
    `our per-fetch latency: ${fetchTimed.length} row(s) timed, ` +
      `${Math.min(...per).toFixed(3)}-${Math.max(...per).toFixed(3)}ms per read ` +
      `(p90 within a pass, median of ${fetchTimed[0].subFetch.passes.length} passes)`
  );
}
if (fetchMissing.length > 0)
  console.log(
    `our per-fetch latency UNMEASURED on ${fetchMissing.length} row(s) that moved ` +
      `content out: ${fetchMissing.map((r) => r.name).join(', ')}`
  );
// A body-arm loss fails the run even though the body RATIO does not gate it.
// The ratio is published side by side because the locked decision was to show
// the difference rather than pick a column; a lost identifier is not a column,
// it is a defect in the pipeline that actually ships.
const bodyLost = sum((r) => r.bodyGone);
if (bodyLost > 0)
  console.log(
    `BODY ARM LOST ${bodyLost} identifier(s) on: ` +
      rows
        .filter((r) => r.bodyGone > 0)
        .map((r) => `${r.name}(${r.bodyGone})`)
        .join(', ')
  );
/**
 * The run, written down where a check that cannot run it can still read it.
 *
 * WHY A FILE AND NOT THE STDOUT. This harness needs a HeadRoom clone and their
 * Python harness to produce the arm it scores against, so CI cannot run it the
 * way `readme-table.check.mjs` runs `proof.mjs`. Without somewhere to put the
 * result, the twelve-row table in the README would be the one thing this
 * repository keeps saying it will not ship: a figure with nothing behind it.
 *
 * SO THE CHAIN HAS TWO LINKS, AND BOTH ARE CHECKABLE. Prose against this record
 * is checked in CI on every commit, by `readme-headroom.check.mjs`. This record
 * against the live harness is checked by anyone holding the clone, by re-running
 * with --record and diffing -- which is also exactly what regenerating it does.
 * Neither link is an assertion; the second one is simply not free.
 *
 * The strings are recorded ALREADY FORMATTED, the same way the table prints
 * them, so the comparison is text against text. A checker that re-derived "46.0%"
 * from 0.4604 would be re-implementing the rounding, and a rounding that drifted
 * would make the two agree on a number neither of them shows.
 */
if (process.argv[3] === '--record') {
  const at = process.argv[4];
  if (!at) {
    console.error('head-to-head: --record needs a path to write to');
    process.exit(1);
  }
  // A STUBBED RUN MAY BE RECORDED, BUT NEVER WHERE A PUBLISHED ONE LIVES.
  // known-answer/scorer.check.mjs needs this record -- it is the assertion
  // surface for every figure the table prints. What it must not be able to do
  // is land in results/ and be read later as a measurement.
  const scorerRefusal =
    stubbedScorerRefusal(at) ??
    (stubRefusal && /(^|[\\/])results[\\/]/.test(at)
      ? `refusing to record to ${at}: ${stubRefusal}`
      : null);
  if (scorerRefusal) {
    console.error(scorerRefusal);
    process.exit(2);
  }
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    // A tarball is not a repository. The record is still the record.
  }

  // WAS THE TREE CLEAN? The sha is a claim that the code which produced these
  // numbers can be checked out again, and a modified tree makes that claim
  // false while leaving the sha perfectly well formed. `null` means the
  // question could not be asked, which the gate treats as unanswered, not as
  // clean.
  let dirty = null;
  try {
    dirty =
      execFileSync('git', ['status', '--porcelain'], {
        encoding: 'utf8',
      }).trim().length > 0;
  } catch {
    dirty = null;
  }
  // THE TOKENISER'S OWN VERSION. The token column is a function of it: a
  // different build re-segments every payload without one line changing in our
  // code or theirs. Resolved by walking up from the module it loads, because
  // the package does not export its own package.json.
  let tiktokenVersion = 'unknown';
  try {
    let at = dirname(createRequire(import.meta.url).resolve('tiktoken'));
    for (let up = 0; up < 5; up += 1) {
      const manifest = join(at, 'package.json');
      if (existsSync(manifest)) {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
        if (parsed.name === 'tiktoken' && typeof parsed.version === 'string') {
          tiktokenVersion = parsed.version;
          break;
        }
      }
      at = dirname(at);
    }
  } catch {
    // Left as 'unknown', which the gate refuses. It does not guess.
  }
  // HOW MANY SEPARATED PASSES EACH SIDE WAS TIMED OVER -- the minimum across
  // rows, not the constant either program aims for, because the row with the
  // fewest passes is the one whose verdict cannot be trusted. Their side counts
  // only rows they measured at all: a workload their engine declined has no
  // timing to repeat, and counting it as 0 would describe the whole capture as
  // single-pass.
  const ourPassCounts = rows.map((r) =>
    Array.isArray(r.msPasses) ? r.msPasses.length : 0
  );
  const theirPassCounts = rows
    .map((r) => theirs[r.name])
    .filter((row) => row && Array.isArray(row.msSamples))
    .map((row) => (Array.isArray(row.msPasses) ? row.msPasses.length : 0));
  const reproduction = {
    commit,
    dirty,
    node: process.versions.node,
    // THE TOKENISER PACKAGE, WHICH NO LONGER GOVERNS ANY NUMBER HERE. The
    // column was counted by tiktoken for the life of this file and the version
    // was recorded because a different version tokenises differently. It is now
    // counted by Anthropic's `count_tokens`, served from a recorded fixture, so
    // this version is kept for the history of older records and is no longer
    // what a reader should check.
    tiktoken: tiktokenVersion,
    encoding: ENCODING_NAME,
    // WHAT A READER SHOULD CHECK INSTEAD. A recorded count is only as good as
    // the fixture it came from, and two records priced against different
    // fixtures are not comparable however alike their columns look -- the same
    // reason the payload digest below exists. `envelope` is the per-request
    // overhead the counts were derived with, re-measured on every recording and
    // refused if it is not linear, so a change in it changes every figure.
    counts: {
      model: COUNTS.model ?? 'unknown',
      recordedAt: COUNTS.recordedAt ?? 'unknown',
      envelope: COUNTS.envelope ?? null,
      strings: Object.keys(COUNTS.counts ?? {}).length,
    },
    // THE INPUT THE RATIOS ARE A FUNCTION OF. The payload set is generated, so
    // it drifts, and two records taken over different payloads are not
    // comparable however alike their columns look.
    payloadsDigest: createHash('sha256')
      .update(readFileSync(join(dir, 'payloads.json')))
      .digest('hex')
      .slice(0, 16),
    theirsDigest: null,
    headroomVersion: theirs.__provenance__?.headroomVersion ?? null,
    // WHICH FIELDS A READER IS OWED DEPENDS ON WHETHER AN ENGINE RAN. A capture
    // taken under BENCH_KNOWN_ANSWER_ARMS drives this same path with arms whose
    // output is arithmetic, so there is no competitor version to record and
    // demanding one would demand a fabrication. The reproducibility gate reads
    // this to decide which rule applies, so it travels in the block it governs
    // rather than being inferred from the stub name on our side.
    stubArms: theirs.__provenance__?.stubArms ?? null,
    python: theirs.__provenance__?.python ?? null,
    // THEIR DETECTOR WAS OUR CHOICE, AND THE RECORD SAYS SO. Their content
    // detector falls back to a slower, worse-routing pure-Python backend on
    // Windows; the sweep asks for their native one instead. That is the strongest
    // version of them and therefore the right opponent, but it is not what a
    // reader would assume, so it is stated rather than left in a comment.
    theirDetectBackend: theirs.__provenance__?.detectBackend ?? null,
    theirDetectBackendSetByUs:
      theirs.__provenance__?.detectBackendSetByHarness ?? null,
    // WHICH ENGINE, IN WHICH STATE, PRODUCED THEIR COLUMN. Their redeeming arms
    // read out of a durable store, so a sweep that starts from an empty one is
    // measuring an engine with nothing to redeem, and the arms that decide the
    // comparable cost and retention columns move by up to two orders of magnitude
    // between the two. That is a different experiment, not a noisier one.
    //
    // THIS IS THE STRING THE RATCHET ALREADY KEYS ITS PASSES ON, deliberately.
    // The store state, the detector backend and the chunk count all move columns,
    // and the ratchet has carried a fingerprint over all three for a while; a
    // record that spelled the same facts out again in its own fields could drift
    // out of agreement with the ratchet and neither would be wrong on its face.
    instrument: instrumentFingerprint(theirs.__provenance__ ?? null),
    speedPasses: {
      ours: ourPassCounts.length ? Math.min(...ourPassCounts) : 0,
      theirs: theirPassCounts.length ? Math.min(...theirPassCounts) : 0,
    },
  };
  const record = {
    harness: 'bench/compression/head-to-head.mjs',
    // THE CURRENCY, RECORDED RATHER THAN REMEMBERED. The token column was
    // counted in tiktoken cl100k_base for the life of this file and nothing in
    // the record said so, so a reader had no way to know the figures were in
    // OpenAI's units while the claim was about Claude subscription spend. A
    // consumer can now check what it is reading.
    encoding: ENCODING_NAME,
    // NOT NULL MEANS NOT A MEASUREMENT -- our column came from stub arms and
    // this record describes the scorer, not the product. The mirror of
    // `__provenance__.stubArms` on their side.
    stubOurs: KNOWN_ANSWER_OURS,
    // The one thing a reader cannot re-derive from this file: what produced the
    // arm on the other side of the table.
    regenerate:
      'python bench/compression/headroom/run-theirs.py <headroom-clone> <out-dir> && ' +
      'python bench/compression/headroom/resolve-theirs.py <headroom-clone> <out-dir> && ' +
      'node bench/compression/head-to-head.mjs <out-dir> --record ' +
      'bench/compression/headroom/results/head-to-head.json',
    recordedAt: new Date().toISOString().slice(0, 10),
    commit,
    // WHICH CAPTURE THIS WAS SCORED AGAINST, because the out-dir is a
    // positional argument and a stale one is silent. A re-record pointed at an
    // out-dir left over from an earlier session reproduced a competitor column
    // that had already been retracted: our side moved, theirs reverted, and the
    // published standing went from nine workloads to five. Nothing in the
    // record showed it, because the record held only the ratios -- and a ratio
    // that changes looks exactly like a measurement that changed. The digest
    // and the per-row arm below are what make that diff legible.
    capture: {
      // The tail only. This file is public and the out-dir is a scratch path on
      // whoever ran it; the digest is what identifies the capture, the name is
      // only there to say which one a re-run should replace.
      dir: dir.split(/[\\/]/).filter(Boolean).slice(-2).join('/'),
      // HASHED WITHOUT THE TIMINGS. `ms` is a wall-clock reading and differs on
      // every capture, so hashing the file whole would move the digest on a
      // re-run where their compression produced identical bytes -- which is
      // exactly the case the digest exists to rule out. Stripping it keeps the
      // digest a statement about their OUTPUT. It changed once, deliberately,
      // when the timings were added.
      // THE STORE STATE THE CAPTURE RAN AGAINST, carried from `run-theirs.py`.
      //
      // Their `pipeline@*` arms hand blocks to a durable CCR store, so those
      // arms return different bytes against different store states -- measured
      // at up to 100x on the same workload, same version, same payload. The
      // digest below proves two captures saw the same OUTPUT; this proves they
      // ran the same EXPERIMENT. A record without it cannot support a
      // per-workload comparison, because nothing says the two runs are
      // comparable, and a ratchet built on one is comparing two experiments.
      theirsProvenance: theirs.__provenance__ ?? null,
      theirsDigest: createHash('sha256')
        .update(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(
                JSON.parse(readFileSync(join(dir, 'theirs.json'), 'utf8'))
              ).map(([name, row]) => {
                const { ms, msMin, msMax, msSamples, msPasses, ...rest } = row;
                return [name, rest];
              })
            )
          )
        )
        .digest('hex')
        .slice(0, 16),
    },
    workloads: rows.map((r) => ({
      name: r.name,
      payload: String(r.before),
      // Their nine-arm sweep picks a winner per workload, and which one it
      // picked is the difference between "they compressed it" and "they moved
      // it to a store". A ratio alone cannot say that.
      arm: theirs[r.name]?.arm ?? null,
      // AND WHETHER THAT IS THE ARM THE CAPTURE ITSELF NAMED. A ratio tie broken
      // on measured time can move this off the capture's winner; when it does,
      // both names are recorded so the row cannot be read as if one arm had been
      // scored throughout.
      armFromCapture:
        bestArmRepointed[r.name] === undefined
          ? (theirs[r.name]?.arm ?? null)
          : bestArmRepointed[r.name].from,
      // THE TWO OPPONENTS, NAMED. `arm` is their lowest-ratio arm whatever it
      // retained; `comparable.arm` is their lowest-ratio arm that retained at
      // least what we did. A compression, cost or speed claim is only honest
      // against the second, and the 2026-09-25 decision is to require BOTH.
      // `comparable.arm === null` means no arm of theirs held our identifiers,
      // which is an UNMEASURED second column, never an agreement.
      comparable: {
        arm: r.compArm,
        detail: r.compDetail,
        retained: r.compRetained === null ? null : String(r.compRetained),
        oursRetained: String(r.inOut + r.derived),
        bestRetained: r.bestRetained === null ? null : String(r.bestRetained),
      },
      // AND WHETHER THAT ARM WAS FED WHAT OURS WAS FED, which is the
      // precondition for every other number on this row and was nowhere
      // recorded. Their sweep wraps a non-transcript payload into a role/content
      // envelope for the `pipeline@*` arms: on four of these workloads six of
      // their nine arms therefore run on an input 13-15% LARGER than ours, and a
      // ratio taken over a bigger denominator is a bigger ratio. No credited
      // winner is one of those arms today -- all eighteen match byte for byte,
      // which is why this records `true` rather than refusing -- but nothing
      // made that so, and the day a wrapped arm wins, its inflated percentage
      // would be published as a like-for-like comparison. The digests are here
      // so the claim can be checked rather than believed.
      input: (() => {
        const theirInput =
          theirs[r.name]?.armBeforeTexts?.[theirs[r.name]?.arm] ??
          theirs[r.name]?.bestBeforeText ??
          null;
        const mine = payloads[r.name];
        return {
          oursDigest: sha(mine),
          theirsDigest: typeof theirInput === 'string' ? sha(theirInput) : null,
          same: typeof theirInput === 'string' && theirInput === mine,
          // THE COMPARABLE ARM'S INPUT, digested separately. A second column is
          // only a bar if it was fed the same bytes we were; a different input
          // makes it undecidable, exactly as it does for the best-of-any arm.
          comparableDigest: r.compBeforeDigest,
          comparableSame: r.compBeforeDigest === sha(mine),
        };
      })(),
      chars: {
        ours: pct(r.ours),
        body: r.bodyRatio === null ? null : pct(r.bodyRatio),
        // THE SHARE OF THE PAYLOAD THE PROXY ARM WAS NOT ALLOWED TO TOUCH.
        // Without it a `body` of 0.0% is two different results wearing one
        // number: an arm that refused because the client's cache marker covers
        // the payload, and an arm that was handed all of it and achieved
        // nothing. Both are priced -- see the proxy arm in `armsFor` for why no
        // threshold separates them -- so this is what tells a reader which
        // happened. SIX DECIMALS, not three: the two refusals in this corpus
        // read 0.999537 and 0.999771, and rounding either to 1.000 would print
        // the exact claim the arm cannot support.
        bodyBehind: r.bodyRatio === null ? null : r.bodyBehind.toFixed(6),
        // HOW MUCH OF THE PREFIX SURVIVED, which this file has always measured
        // and never recorded. A re-serialised request is a cache miss even when
        // nothing in it changed, and the agreement between what came in and what
        // went out has been 57 characters on every row that compresses -- so the
        // arm pays a write for a prefix it could have sent at the read rate.
        // Without this in the record there is no way to tell from a recording
        // whether an arm preserved the prefix or destroyed it, which is the
        // difference between residency at R and residency at W: a factor of 20
        // on the one-hour cache rate.
        bodyCachedPrefixChars: String(r.bodyCachedPrefixChars ?? 0),
        bodyCachedPrefixTok: String(r.bodyCachedPrefixTok ?? 0),
        // WHAT THE PROVIDER ACTUALLY SERVED FROM CACHE, in characters and in
        // the tokens cost-model.mjs discounts. Near-zero on every row that
        // compresses, because the proxy re-serialises the request; recorded so
        // the gap between "left the prefix alone" and "kept the cache hit" is
        // visible in the record rather than only in the code.
        bodyCachedPrefixChars:
          r.bodyRatio === null ? null : r.bodyCachedPrefixChars,
        bodyCachedPrefixTok:
          r.bodyRatio === null ? null : r.bodyCachedPrefixTok,
        preset: pct(r.presetRatio),
        sub: pct(r.subRatio),
        theirs: pct(r.theirs),
        theirsComparable: r.compRatio === null ? null : pct(r.compRatio),
      },
      tokens: {
        ours: pct(r.oursTok),
        body:
          r.bodyRatio === null
            ? null
            : pct(1 - r.bodyTokAfter / r.bodyTokBefore),
        preset: pct(r.presetTok),
        sub: pct(r.subTok),
        theirs: pct(r.theirsTok),
        theirsComparable:
          r.compTokAfter === null
            ? null
            : pct(1 - r.compTokAfter / r.compTokBefore),
      },
      retention: {
        // THE DENOMINATOR. Every other number in this object is a count of
        // identifiers out of this total, and without it a gate cannot tell
        // "retained 336" from "retained 336 of 336". Their arm is at 100% on
        // seven of these rows, which is only visible once the total is here.
        ids: String(r.ids),
        unsafeIds: String(r.unsafe),
        // Recorded beside the denominator for the same reason it is printed:
        // this many units were dropped as not being substrings of their own
        // payload, and a record that shows a narrower denominator without
        // saying why is a record that cannot be audited.
        phantomIds: String(r.phantoms),
        inContext: String(r.inOut),
        reconstructible: String(r.derived),
        // null, not "null": a sinkless arm never measured this, and a JSON
        // null says so to every consumer. See `retention.mjs`.
        recoverable: r.inSpill === null ? null : String(r.inSpill),
        theirsInContext: String(r.theirIn),
        oursZeroTurn: String(r.inOut + r.derived),
        presetZeroTurn: String(r.presetFree),
        theirsZeroTurn: String(r.theirIn),
        // RECORDED, NOT GATED. The comparable arm is DEFINED as retaining at
        // least what we do, so a retention comparison against it has the same
        // answer on every row for every engine and can never fail for any
        // reason to do with the code under test. It is kept here as provenance
        // -- it should always be >= oursZeroTurn, and a row where it is not is
        // a bug in the selection, not a win.
        theirsComparableZeroTurn: r.compIn === null ? null : String(r.compIn),
        subUnrecoverable: String(r.subGone),
      },
      // WHOLE-PAYLOAD CONTENT CONSERVATION, RECORDED RATHER THAN ONLY PRINTED.
      // Until now these figures existed for the length of one process: the
      // harness computed them, gated on them, printed them, and wrote a record
      // that said nothing about them. So no later check could verify the claim,
      // no ratchet could hold it, and a reader of the record could not tell a
      // conserving run from one whose oracle never looked. The gate inside the
      // harness is not the problem -- a number nobody can re-read afterwards is.
      //
      // `controlGone` IS RECORDED BESIDE `gone`, AND IT IS THE ONE THAT SAYS
      // WHETHER `gone` MEANS ANYTHING. The control mutilates the output (half of
      // it, no expansion, no spill) and asks the same question; where it also
      // loses nothing, this payload's vocabulary is too small for the oracle to
      // resolve a loss and a clean reading is a blind spot wearing the shape of
      // evidence. `blind` carries that conclusion so a consumer cannot read
      // `gone: 0` without it.
      conservation: {
        words: String(r.wordsAll),
        inOutput: String(r.wordsInOutput),
        inReconstruction: String(r.wordsInReconstruction),
        // null, not "0": an arm with no sink never looked in a spill.
        inSpill: r.wordsInSpill === null ? null : String(r.wordsInSpill),
        gone: String(r.wordsGone),
        goneMass: String(r.wordsGoneMass),
        beforeMass: String(r.wordsBeforeMass),
        goneShare: pct(r.wordsGoneShare),
        // A BOUNDED SAMPLE, not the whole list: `gone` is the count, and a row
        // that loses thousands of words would otherwise write thousands of
        // strings into a record that is read on every check. Twenty is enough
        // to see WHAT was lost; the count is what is compared.
        missingSample: r.wordsMissing.slice(0, 20),
        missingSampleTruncated: r.wordsMissing.length > 20,
        controlWords: String(r.wordsControlAll),
        controlGone: String(r.wordsControlGone),
        blind: r.wordsFloorChosen === null,
        // THE FLOOR THIS READING WAS TAKEN AT, recorded beside it, because a
        // count of lost words means nothing without the floor that defined the
        // word set -- and the floor is not a constant any more. `floorTried` is
        // every candidate with what the control saw at it, so the choice can be
        // re-derived from the record rather than trusted.
        minLen: String(r.wordsMinLen),
        floorChosen:
          r.wordsFloorChosen === null ? null : String(r.wordsFloorChosen),
        floorTried: r.wordsFloorTried.map((t) => ({
          minLen: String(t.minLen),
          words: String(t.words),
          controlGone: String(t.controlGone),
        })),
      },
      // WITHHELD, NOT GUESSED, WHEN THE BASE CONTEXT IS NOT RECORDED. Every
      // figure under `cost` is denominated in effective input tokens, which is
      // the payload plus a measured base context; with no measurement there is
      // no figure. `null` says the arm was never priced and `costRefusal` says
      // why, which is the one thing a zero could never say.
      costRefusal: COST_PRICED ? null : BASE.reason,
      // THE TWO BOUNDS, RECORDED. `handed` is the text the agent is given;
      // `whole` is that plus everything the arm moved out, fetched back.
      // Recording only the first is how a store-backed arm reads as free.
      cost: !COST_PRICED
        ? null
        : {
            turns: {
              ours: String(r.oursTurns),
              // THE REFERENCING ARM'S TURNS, RECORDED BESIDE THE DEFAULT ARM'S.
              // The speed column already pairs `ours-movewhole` against their
              // best-of-any because that is the arm whose mechanism matches theirs;
              // must-win 2b prices that same pairing, and it cannot without the
              // round-trip count for the arm being timed.
              oursSub: String(r.subTurns),
              theirs: String(r.theirTurns),
              theirsComparable:
                r.compTurns === null ? null : String(r.compTurns),
              preset: String(r.presetTurns),
            },
            handedTokens: {
              ours: String(r.oursTokAfter),
              theirs: String(tokens(theirs[r.name].bestText ?? '')),
              theirsComparable:
                r.compTokAfter === null ? null : String(r.compTokAfter),
            },
            wholeTokens: {
              ours: String(r.oursTokAfter + r.oursTokSpill),
              theirs: String(
                tokens(theirs[r.name].bestText ?? '') + r.theirTokRedeem
              ),
              // A LOWER BOUND, NOT A MEASUREMENT. We never resolved the comparable
              // arm, so its redeem tokens are unknown and priced at zero here.
              // Their whole cost is therefore AT LEAST this, which only makes our
              // bar harder -- but it must not be read as their measured total.
              theirsComparableAtLeast:
                r.compTokAfter === null ? null : String(r.compTokAfter),
            },
            // THE SESSION MODEL, which is what a subscription is metered on.
            // `p0` assumes nothing is ever fetched back and `p1` that everything
            // is; `breakEven` is the fetch rate at which the two arms cost the
            // same, and is the only one of the three that rests on no guess about
            // how long a session runs or how much context precedes the payload.
            session: {
              p0: {
                none: String(Math.round(costAt(byName[r.name].none, 0))),
                ours: String(Math.round(costAt(byName[r.name].ours, 0))),
                // THE PROXY ARM, MEASURED AND NOT YET PUBLISHED AS `ours`. See
                // `armsFor` for why this exists: `ours` is the block arm the MCP
                // tools apply, and this is the arm a proxy user is actually billed
                // for. `null` means the arm does not apply to this payload or the
                // proxy declined to rewrite cached content.
                proxy:
                  byName[r.name].proxy === null
                    ? null
                    : String(Math.round(costAt(byName[r.name].proxy, 0))),
                preset: String(Math.round(costAt(byName[r.name].preset, 0))),
                theirs: String(Math.round(costAt(byName[r.name].theirs, 0))),
                theirsComparableAtLeast:
                  byName[r.name].theirsComparable === null
                    ? null
                    : String(
                        Math.round(costAt(byName[r.name].theirsComparable, 0))
                      ),
              },
              p1: {
                ours: String(Math.round(costAt(byName[r.name].ours, 1))),
                proxy:
                  byName[r.name].proxy === null
                    ? null
                    : String(Math.round(costAt(byName[r.name].proxy, 1))),
                preset: String(Math.round(costAt(byName[r.name].preset, 1))),
                theirs: String(Math.round(costAt(byName[r.name].theirs, 1))),
                theirsComparableAtLeast:
                  byName[r.name].theirsComparable === null
                    ? null
                    : String(
                        Math.round(costAt(byName[r.name].theirsComparable, 1))
                      ),
              },
              breakEven: breakEvenLabel(crossByName[r.name]),
              breakEvenComparable:
                crossComparableByName[r.name] === null
                  ? null
                  : breakEvenLabel(crossComparableByName[r.name]),
              // THE RATE THAT FLATTERS US LEAST, so a gate has something to stand
              // on. Cost is quadratic in the fetch rate, so the two endpoints no
              // longer bound the interval between them: a difference that opens
              // upward dips in the middle, and an arm can lead at 0% and at 100%
              // while trailing somewhere between. This is that point, found
              // exactly rather than sampled.
              worst: (() => {
                const w = worstAgainst(
                  byName[r.name].ours,
                  byName[r.name].theirs
                );
                return {
                  fetchRate: w.p.toFixed(4),
                  ours: String(Math.round(costAt(byName[r.name].ours, w.p))),
                  theirs: String(
                    Math.round(costAt(byName[r.name].theirs, w.p))
                  ),
                };
              })(),
              // THE SAME WORST POINT against the comparable arm, found separately:
              // the two arms are different quadratics, so the rate that flatters us
              // least against one is not the rate that flatters us least against
              // the other.
              worstComparable: (() => {
                const comp = byName[r.name].theirsComparable;
                if (comp === null) return null;
                const w = worstAgainst(byName[r.name].ours, comp);
                return {
                  fetchRate: w.p.toFixed(4),
                  ours: String(Math.round(costAt(byName[r.name].ours, w.p))),
                  theirsAtLeast: String(Math.round(costAt(comp, w.p))),
                };
              })(),
              // THE PROXY ARM'S OWN WORST POINTS, because the two columns are now
              // gated separately and a column without a worst point cannot be
              // gated at all. `worst` above is the block arm's quadratic; the proxy
              // arm is a different quadratic with a different vertex, so reusing
              // one rate for the other would price the proxy arm at a rate chosen
              // to flatter a different arm.
              //
              // `null` propagates the shape test rather than a zero: four payloads
              // in this corpus are arrays of log lines and API records with no
              // `role` and no `content`, so there is no request body for a proxy to
              // rewrite and no arm to price. That is a different statement from an
              // arm that ran and saved nothing.
              worstProxy: (() => {
                const px = byName[r.name].proxy;
                if (px === null) return null;
                const w = worstAgainst(px, byName[r.name].theirs);
                return {
                  fetchRate: w.p.toFixed(4),
                  proxy: String(Math.round(costAt(px, w.p))),
                  theirs: String(
                    Math.round(costAt(byName[r.name].theirs, w.p))
                  ),
                };
              })(),
              worstProxyComparable: (() => {
                const px = byName[r.name].proxy;
                const comp = byName[r.name].theirsComparable;
                if (px === null || comp === null) return null;
                const w = worstAgainst(px, comp);
                return {
                  fetchRate: w.p.toFixed(4),
                  proxy: String(Math.round(costAt(px, w.p))),
                  theirsAtLeast: String(Math.round(costAt(comp, w.p))),
                };
              })(),
            },
          },
      // SPEED, THE SECOND MUST-WIN. Ours is measured; theirs is null until a
      // capture carries it, because `run-theirs.py` has to time their resolver
      // in the process that runs it. A null here means UNMEASURED, and the gate
      // treats it as unmeasured rather than as a pass.
      speed: {
        // WHETHER THIS ROW'S TWO TIMES DESCRIBE THE SAME MACHINE. Our medians
        // moved 33% to 122% between two runs of the same recording, minutes
        // apart, with no code change -- more than most of the margins below. So
        // both sides now spawn the same calibration loop and the scorer refuses
        // the criterion when their readings disagree. A capture taken before the
        // witness existed has none, which is a refusal, not a quiet machine.
        loadWitness: {
          ours: ourLoadWitness,
          theirs: theirs.__provenance__?.loadWitness ?? null,
          verdict: (() => {
            const v = witnessesAgree(
              ourLoadWitness?.ms ?? null,
              theirs.__provenance__?.loadWitness?.ms ?? null
            );
            return { ok: v.ok, detail: v.detail };
          })(),
        },
        oursMs: r.ms.toFixed(3),
        oursMsMin: r.msMin.toFixed(3),
        oursMsMax: r.msMax.toFixed(3),
        oursMsSamples: r.msSamples,
        // THE PASSES, KEPT APART. Pooling them would average an interference
        // event into the reading instead of exposing it; the gate compares the
        // passes with each other and refuses to decide when they disagree.
        oursMsPasses: r.msPasses,
        // THE SECOND ARM OF OURS, so the speed column can pair mechanisms the
        // way the cost column already does. `oursMs` above is our COMPRESSING
        // arm and is judged against their non-offloading `pipeline@*` arms;
        // these three fields are our REFERENCING arm (`spillWholeBlockBelow` 1,
        // the published `sub` arm) and are judged against their best-of-any,
        // which reaches its ratio by writing a content-store key. Both are
        // recorded, so the pairing is a stated rule rather than a choice about
        // which of our numbers to show.
        oursSubMs: r.subMs.toFixed(3),
        oursSubMsSamples: r.subMsSamples,
        oursSubMsPasses: r.subMsPasses,
        // THE PER-FETCH LATENCY OF THAT ARM'S RETRIEVAL, MEASURED. `null` where
        // the arm moved nothing out on this row, which is not a zero: an arm
        // with no round trips has no retrieval to time, and must-win 2b asks for
        // the figure only where it multiplies something. Their side of the same
        // measurement is in `theirsFetch` below, taken by `resolve-theirs.py`
        // inside their TTL with their own resolver.
        oursSubFetch: r.subFetch,
        theirsFetch: theirs.__provenance__?.perFetch ?? null,
        // WHICH OF THEIR ARMS EACH COLUMN IS, NAMED IN THE ROW. Their arms
        // differ by more than a percentage: a 13.7ms `crusher` reading and a
        // 37.4ms `pipeline@0.10` reading are different mechanisms, and a reader
        // who only sees a number cannot tell which verdict used which. The cost
        // block records these names too; repeating them here means the speed
        // verdict is legible without cross-referencing another block.
        theirsArm: theirs[r.name]?.arm ?? null,
        theirsComparableArm: r.compArm ?? null,
        // WHETHER THE COMPARABLE ARM OFFLOADS ON THIS ROW, counted from its own
        // output rather than from a list of arm names: `compTurns` is how many
        // `<<ccr:...>>` markers that arm's text carries, so a non-zero count is
        // that arm moving content to a store on this payload. The retention
        // selection picks the comparable arm by what it KEPT, which on some rows
        // is an offloading arm; the speed verdict needs to know so it does not
        // re-create the mechanism mismatch it was built to remove.
        theirsComparableTurns: r.compTurns ?? null,
        theirsMs:
          typeof theirs[r.name]?.ms === 'number'
            ? theirs[r.name].ms.toFixed(3)
            : null,
        theirsMsSamples: Array.isArray(theirs[r.name]?.msSamples)
          ? theirs[r.name].msSamples
          : null,
        // THEIR PASSES, FOR THE SAME REASON OURS ARE KEPT APART -- and until
        // the capture recorded them, the gate had a pass-aware estimate for our
        // column and a single unrepeated reading for theirs. Their statistic is
        // a FAST percentile, so a noisy pass on their side inflates it, widens
        // the gap and reads as our win. A capture from before this is null here
        // and the verdict refuses it rather than deciding asymmetrically.
        theirsMsPasses: Array.isArray(theirs[r.name]?.msPasses)
          ? theirs[r.name].msPasses
          : null,
        // THE COMPARABLE ARM'S READINGS. `run-theirs.py` times EVERY arm, not
        // just the ratio winner, precisely so that this column arrives measured
        // -- an arm the scorer may select but the capture never timed would
        // have to be refused, which is the same as not measuring it at all.
        theirsComparableMs:
          r.compArm !== null &&
          typeof theirs[r.name]?.armMs?.[r.compArm] === 'number'
            ? theirs[r.name].armMs[r.compArm].toFixed(3)
            : null,
        theirsComparableMsPasses:
          r.compArm !== null &&
          Array.isArray(theirs[r.name]?.armMsPasses?.[r.compArm])
            ? theirs[r.name].armMsPasses[r.compArm]
            : null,
        // THE POOL, FLATTENED FROM THOSE PASSES rather than recorded twice.
        // `armMs` above is the capture's median of exactly this pool, so
        // deriving the samples here keeps one source of truth: a capture cannot
        // disagree with itself about which readings the median came from.
        theirsComparableMsSamples:
          r.compArm !== null &&
          Array.isArray(theirs[r.name]?.armMsPasses?.[r.compArm])
            ? theirs[r.name].armMsPasses[r.compArm].flat()
            : null,
      },
    })),
    totals: {
      chars: { ours: pct(oursChars), theirs: pct(theirsChars) },
      costRefusal: COST_PRICED ? null : BASE.reason,
      cost: !COST_PRICED
        ? null
        : {
            usdPerMtok: String(USD_PER_MTOK),
            turns: {
              ours: String(sum((r) => r.oursTurns)),
              theirs: String(sum((r) => r.theirTurns)),
              preset: String(sum((r) => r.presetTurns)),
            },
            handedTokens: {
              ours: String(sum((r) => r.oursTokAfter)),
              theirs: String(sum((r) => tokens(theirs[r.name].bestText ?? ''))),
            },
            wholeTokens: {
              ours: String(sum((r) => r.oursTokAfter + r.oursTokSpill)),
              theirs: String(
                sum(
                  (r) =>
                    tokens(theirs[r.name].bestText ?? '') + r.theirTokRedeem
                )
              ),
            },
            // THE SAME MODEL OVER THE WHOLE CORPUS, plus the two session-shape
            // assumptions it was evaluated under, so a reader can tell which of
            // these figures would move if they disagreed with either.
            session: {
              turnsAfter: String(DEFAULTS.turnsAfter),
              baseContextTokens: String(PARAMS.baseContextTokens),
              baseContextSessions: String(BASE.record.sessions),
              // NAMED, SO A READER CAN GO AND LOOK. This said 'measured', which is
              // a claim about an act nobody could locate afterwards -- the act
              // happened on whichever machine ran the harness and left nothing
              // behind. The file it now names is committed, and carries when it was
              // taken and over what.
              baseContextSource: 'bench/subscription/results/base-context.json',
              baseContextRecordedAt: BASE.record.recordedAt,
              p0: {
                none: String(Math.round(costAt(corpus.none, 0))),
                ours: String(Math.round(costAt(corpus.ours, 0))),
                preset: String(Math.round(costAt(corpus.preset, 0))),
                theirs: String(Math.round(costAt(corpus.theirs, 0))),
              },
              p1: {
                none: String(Math.round(costAt(corpus.none, 1))),
                ours: String(Math.round(costAt(corpus.ours, 1))),
                preset: String(Math.round(costAt(corpus.preset, 1))),
                theirs: String(Math.round(costAt(corpus.theirs, 1))),
              },
              breakEven: breakEvenLabel(corpus.cross),
              // The `ours` arm above compresses in place and spills nothing, so
              // against a cache-read bill it is the wrong arm to quote alone.
              // `preset` is the one that evicts, and it is the one that wins.
              presetBreakEven: breakEvenLabel(
                breakEven(corpus.preset, corpus.theirs)
              ),
              // What the same subscription cap buys, against doing nothing at all.
              capMultiple: {
                oursP0: times(costAt(corpus.none, 0), costAt(corpus.ours, 0)),
                theirsP0: times(
                  costAt(corpus.none, 0),
                  costAt(corpus.theirs, 0)
                ),
                oursP50: times(
                  costAt(corpus.none, 0.5),
                  costAt(corpus.ours, 0.5)
                ),
                theirsP50: times(
                  costAt(corpus.none, 0.5),
                  costAt(corpus.theirs, 0.5)
                ),
                // THE ARM THAT EVICTS, AND THE ONE A USER SHOULD BE GIVEN.
                //
                // `ours` above compresses in place and spills nothing, so its
                // multiple is the same at every fetch rate and it loses to them
                // at all of them. The preset arm evicts, which is why it is 17.9x
                // cheaper at rest -- and the published verdict has rested on the
                // arm that does not, with the preset computed on every workload
                // and then dropped before the cost comparison.
                //
                // Recorded at both ends so the trade is visible rather than
                // argued: at p=0 nothing is fetched and the eviction is free, at
                // p=1 every one of its 61 round trips is paid, and the break-even
                // between those is `presetBreakEven`.
                presetP0: times(
                  costAt(corpus.none, 0),
                  costAt(corpus.preset, 0)
                ),
                presetP50: times(
                  costAt(corpus.none, 0.5),
                  costAt(corpus.preset, 0.5)
                ),
                presetP1: times(
                  costAt(corpus.none, 1),
                  costAt(corpus.preset, 1)
                ),
              },
            },
          },
      tokens: { ours: pct(oursTokens), theirs: pct(theirsTokens) },
      // THE COMPARISON THIS HARNESS CALLS APPLES-TO-APPLES, now in the record.
      //
      // `tokens` above is our encoding arm against their best arm of ANY kind,
      // offload included. `sub` below is our substitution arm, which this
      // harness refuses to credit as reduction. So the `tokens` row pits the
      // one arm of ours that does not move bytes against the one arm of theirs
      // that does, and it is the only pairing here that is neither
      // like-for-like nor store-for-store. It stays, because it is what their
      // users actually get -- it is simply no longer the only thing a reader or
      // a gate can see.
      like4like:
        like4like.ours === null
          ? null
          : {
              ours: pct(like4like.ours),
              theirs: pct(like4like.theirs),
              workloads: String(like4like.measured.length),
              of: String(rows.length),
              noCleanArm: like4like.noClean.map((r) => r.name),
              unrecorded: like4like.unrecorded.map((r) => r.name),
            },
      sub: {
        chars: pct(1 - subAll / beforeAll),
        tokens: pct(1 - subTokAll / beforeTokAll),
        // SUBSTITUTION, NOT REDUCTION. The store is recorded beside the ratio for
        // the same reason it is printed beside it.
        store: `${(sum((r) => r.subStore) / beforeAll).toFixed(2)}x`,
        unrecoverable: String(sum((r) => r.subGone)),
      },
      spillStore: `${(sum((r) => r.spillRatio * r.before) / beforeAll).toFixed(2)}x`,
      unrecoverable: {
        ours: String(lost),
        theirs: String(sum((r) => (r.theirMeasured ? r.theirGone : 0))),
      },
      retention: {
        units: String(allIds),
        inContext: { ours: String(oursIn), theirs: String(theirsIn) },
        reconstructible: String(oursDerived),
        recoverable: {
          ours: String(oursSpilled),
          theirs: String(theirsRedeemed),
        },
      },
    },
  };
  // THE DIGEST IS COMPUTED ONCE, in the capture block above, and copied here
  // rather than hashed twice: two hashes of the same file are two chances to
  // hash it differently.
  reproduction.theirsDigest = record.capture.theirsDigest;
  record.reproduction = reproduction;
  // THE REFUSAL TRAVELS IN THE RECORD, it is not thrown. Recording from a
  // modified tree is how this repository is worked on and pretending otherwise
  // would only mean recording less; what must never happen is a number reaching
  // a reader with nothing said about whether it can be re-run. So the reason is
  // written down, the warning here is loud, and the gate that has to be green
  // before anything is published is the one over the COMMITTED record.
  record.reproduction.refusal = reproducibilityRefusal(reproduction);
  if (record.reproduction.refusal) {
    console.error(
      'WARNING: this record is not re-runnable as written: ' +
        record.reproduction.refusal
    );
  }
  // A DEGRADED CAPTURE IS NEVER WRITTEN. Everything else this file refuses, it
  // records with the reason attached, because a disclosed limit is still
  // evidence. This one is not: the bytes their engine produced under load are
  // not the bytes their engine produces, so the record would be a measurement
  // of this machine's scheduler. There is no disclosure that makes it quotable.
  if (competitorDegraded) {
    console.error(
      `REFUSING to record: ${competitorDegraded}. ` +
        'Re-capture with run-theirs.py on a quiesced machine.'
    );
    process.exit(1);
  }
  writeFileSync(
    at,
    `${JSON.stringify(record, null, 2)}
`
  );
  console.log(`recorded ${rows.length} workloads to ${at}`);
}

// EVERY REASON THIS RUN SHOULD FAIL, NAMED RATHER THAN OR-ED INTO A BOOLEAN.
// `corpusFaults` in offload.mjs holds the rule and the reasoning; it lives
// there so the same suite that pins what counts as offload also pins what
// counts as losing to it. The names are printed because a bare non-zero exit
// tells whoever is reading CI nothing about which column gave way.
const corpusFaultList = corpusFaults({
  subGone: sum((r) => r.subGone),
  oursChars,
  theirsChars,
  like4likeOurs: like4like.ours,
  like4likeTheirs: like4like.theirs,
  subTokens: 1 - subTokAll / beforeTokAll,
  theirsTokens,
});
if (corpusFaultList.length)
  console.log(`CORPUS FAULTS: ${corpusFaultList.join(', ')}`);

const failed =
  // Their side having run degraded is a gate, not a note: see the record
  // refusal above. Scoring without `--record` lands here.
  competitorDegraded !== null ||
  // A decoder that refuses our own output, or a harness that never handed it
  // the marker, ratcheted from a printed note to a gate on an empty queue.
  refusals.size > 0 ||
  lost > 0 ||
  bodyLost > 0 ||
  // Whole-payload conservation is a gate, not a note. A word of the payload that
  // is in neither the output, its expansion nor the spill it points at is content
  // this arm cannot give back, and no reduction figure is worth publishing beside
  // one. Rows where the control says the oracle is blind are disclosed above and
  // are deliberately NOT failed here: that is a limit of the instrument on that
  // fixture, not a loss by the engine, and failing it would hide the difference.
  sum((r) => r.wordsGone) > 0 ||
  lostWorkloads.length > 0 ||
  unconserved.length > 0 ||
  corpusFaultList.length > 0;
process.exit(failed ? 1 : 0);
