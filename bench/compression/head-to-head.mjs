/**
 * The head-to-head: both engines run over OUR corpus, scored by one instrument.
 *
 * WHOSE FIXTURES THESE ARE. All 12 workloads in `bench/compression/workloads/`
 * are ours -- captured from this project's own agent traffic. An earlier
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
 *    from a real tokeniser (cl100k_base) run over both arms' real output. An
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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { classifyIds, splitScorable } from './retention.mjs';
import { scanIdentifiers } from './identifiers.mjs';
import { classifyArms, declaredOffloadBytes } from './offload.mjs';
import { stubbedCaptureRefusal } from './capture-guard.mjs';
import { baseContextReadiness, measureBaseContext } from '../subscription/base-context.mjs';
import { loadRequests } from '../subscription/transcripts.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { get_encoding } from 'tiktoken';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { reproducibilityRefusal } from './reproducibility.mjs';
// THE ONE SEAM ON OUR SIDE. Both engines reach this scorer through a module
// that can be swapped for stub arms, so every figure below has an answer that
// can be stated before the run. See ours-engine.mjs; the other dist imports
// stay direct because they are instruments, not the thing being measured.
import {
  compressBlock,
  compressBody,
  KNOWN_ANSWER_OURS,
  stubbedScorerRefusal,
} from './ours-engine.mjs';
import { resolveTuning } from '../../dist/compress/options.js';
import { rehydrateSequence } from '../../dist/compress/rehydrate.js';
import { expandLongRepeats } from '../../dist/compress/runs.js';
import { describeImage, imageSize } from '../../dist/compress/images.js';
import { PathAddressedError } from '../../dist/compress/annotate.js';
import {
  DEFAULTS,
  breakEven,
  costAt,
  costLine,
  commonSessionCost,
  markerBytes,
  sumLines,
  usageMultiplier,
  worstAgainst,
} from './cost-model.mjs';

const dir = process.argv[2];
if (!dir) {
  console.error(
    'usage: node bench/compression/head-to-head.mjs <out-dir-from-run-theirs>'
  );
  process.exit(2);
}

const payloads = JSON.parse(readFileSync(join(dir, 'payloads.json'), 'utf8'));
const theirs = JSON.parse(readFileSync(join(dir, 'theirs.json'), 'utf8'));

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

// BASE CONTEXT, MEASURED HERE OR NOT CLAIMED AT ALL.
//
// Every session-cost figure below adds `baseContextTokens` to both arms, so the
// constant sits in the numerator and the denominator of every savings ratio.
// Understating it pushes the ratio away from 1 and inflates the saving, which
// is the flattering direction, and the 12000 this replaced understated the
// machine this harness runs on by 5.4x.
//
// There is no defensible default, because the number is a property of the
// environment -- its system prompt and its loaded tool schemas -- and not of
// the code. So this refuses rather than falling back, the same way
// `weeklyClaimReadiness` refuses a weekly claim with no offset-immune row.
const baseMeasured = measureBaseContext({ requests: (await loadRequests()).requests });
const baseReady = baseContextReadiness(baseMeasured);
if (!baseReady.ready) {
  console.error(`REFUSED: base context has not been measured for this environment.`);
  console.error(`  ${baseReady.reason}`);
  console.error('');
  console.error('  Every cost figure this harness prints adds base context to both arms, so');
  console.error('  quoting one without it would publish a saving nobody measured. Run:');
  console.error('    node bench/subscription/base-context.mjs');
  process.exit(2);
}
// The measured median, standing in for the parameter that used to be hardcoded.
const PARAMS = { ...DEFAULTS, baseContextTokens: baseReady.tokens };

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
const ENCODING_NAME = 'cl100k_base';
const encoding = get_encoding(ENCODING_NAME);

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
  return encoding.encode(stripped).length + imaged;
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

/**
 * EVERYTHING THE PUBLISHED DECODER CAN PUT BACK, given only the output.
 *
 * This is our side of the operation `resolve-theirs.py` performs on theirs,
 * and it is deliberately the SHIPPED decoder (`src/compress/rehydrate.ts`),
 * not a reimplementation: a bespoke expander written to score our own
 * benchmark would be our guess at our own losslessness, and a flattering guess
 * is indistinguishable from a result.
 *
 * IT HAS TO DESCEND INTO THE JSON. Most payloads here are a serialised
 * conversation, and the compressed tool output sits inside a string value with
 * its newlines escaped -- where the decoder's line-oriented grammars cannot
 * see it. Offered only the whole document, it recovers nothing at all on most
 * of these workloads, which would score them as total loss. So every string
 * leaf is offered to it as well.
 *
 * A refusal is not a failure of the run. An unregistered marker grammar means
 * the decoder declines to vouch for that fragment; the fragment then earns no
 * credit and is named at the end. That direction can only cost us.
 */
/** The shape every back-reference marker shares, whichever form it took. */
const MARKER_SHAPED = /\[\.\.\. [\d,]+ bytes, /;

const refusals = new Map();
// NOT A DEFECT, AND IT USED TO SHARE A LIST WITH ONE. `rehydrate` rebuilds from
// the output ALONE, so a `[... what went -> path]` marker is something it can
// never expand -- the path is the whole point of it. Six of those sat on a
// queue the comment above calls the work queue, which is how a queue stops
// being read. They are counted, because a column of them growing IS worth
// seeing, but they are not named as gaps.
const pathRefusals = new Map();
function recoverable(text, label) {
  const parts = [];

  // THE WHOLE DOCUMENT FIRST, BECAUSE THAT IS WHAT WAS FOLDED. Every other
  // pass rewrites the inside of one block, so decoding block by block matches
  // how they were written. `foldLongRepeats` is the exception: it runs over
  // the text `compressBlock` was handed, which for these payloads is the whole
  // serialised request, and its marker names a run that may live in an EARLIER
  // block. Handing the decoder one block at a time therefore asks it to
  // resolve a back-reference against text it was never shown -- which is not a
  // finding about the engine but about the order these two lines were in. The
  // engine restores both folded payloads byte for byte when it is given the
  // same scope it compressed: 735,340 -> 50,602 -> 735,340 on browser-session.
  try {
    const unfolded = expandLongRepeats(text);
    if (unfolded !== text) {
      parts.push(unfolded);
      text = unfolded;
    }
  } catch (error) {
    if (!refusals.has(label))
      refusals.set(label, String(error.message).split(/\r?\n/)[0]);
  }

  let handed = 0;
  let step = rehydrateSequence();
  const decode = (fragment) => {
    if (MARKER_SHAPED.test(fragment)) handed += 1;
    try {
      const back = step(fragment);
      if (back !== fragment) parts.push(back);
    } catch (error) {
      if (error instanceof PathAddressedError) {
        pathRefusals.set(label, (pathRefusals.get(label) ?? 0) + 1);
        return;
      }
      const first = String(error.message).split('\n')[0];
      if (!refusals.has(label)) refusals.set(label, first);
    }
  };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  // THE IMAGES ARE READ OFF THE OUTPUT, NOT OFF THE INPUT, because the question
  // is what a reader holding only the output can rebuild. `dedupImages` keeps
  // the first copy of every distinct image and numbers the rest against it, so
  // the first copies are still here -- but only the parsed structure says which
  // string leaf is an image, which is why the decoder is handed them rather
  // than left to guess from the bytes.
  const imagesAbove = [];
  const findImages = (node) => {
    if (Array.isArray(node)) {
      node.forEach(findImages);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const image = describeImage(node);
    if (image) {
      if (!imagesAbove.includes(image.data)) imagesAbove.push(image.data);
      return;
    }
    Object.values(node).forEach(findImages);
  };
  if (parsed !== undefined) findImages(parsed);
  step = rehydrateSequence(imagesAbove);

  // A BLOCK, NOT EVERY STRING. `rehydrateSequence` resolves the run form by
  // ORDER -- it names the block after the one the reference above it resolved
  // to -- so it has to be handed the block texts, in reader order, and nothing
  // else. Walking every string leaf interleaves each block's own `"text"` type
  // discriminator between the markers, which breaks the walk the form
  // describes. The quoted forms survived that because they resolve by CONTENT
  // and a stray string never matches a quote; the first order-addressed marker
  // is what made the sloppiness visible. These are the keys `mapBlocks` writes
  // through, so they are the whole set of places a marker can be.
  const TEXT_BEARING = new Set(['messages', 'system', 'content', 'text']);
  const walk = (node) => {
    if (typeof node === 'string') decode(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object')
      for (const [key, value] of Object.entries(node))
        if (TEXT_BEARING.has(key)) walk(value);
  };
  // A SERIALISED MESSAGE LIST IS NOT A BLOCK, and handing one to a line-oriented
  // decoder asks a question with no answer: the document is one line with every
  // newline escaped, so a marker claiming 8 folded rows meets 135 candidates and
  // the decoder correctly refuses. That refusal said nothing about our output --
  // it was the harness mis-addressing the decoder -- and it produced four of the
  // names on the gap list. So when the payload parses, the attempt is made over
  // its BLOCKS -- see the walk above for why the string leaves are not them.
  if (parsed !== undefined) walk(parsed);
  else decode(text);
  // NOT TAKEN ON TRUST. Narrowing the walk could quietly stop handing the
  // decoder a marker, and a marker never handed over is a marker that never
  // refuses -- which turns a gap into a clean row and reads as an improvement.
  // So count the back-references anywhere in the payload and insist the walk
  // above was given every one of them.
  let reachable = 0;
  const countMarkers = (node) => {
    if (typeof node === 'string') {
      if (MARKER_SHAPED.test(node)) reachable += 1;
    } else if (Array.isArray(node)) node.forEach(countMarkers);
    else if (node && typeof node === 'object')
      Object.values(node).forEach(countMarkers);
  };
  if (parsed !== undefined) countMarkers(parsed);
  else if (MARKER_SHAPED.test(text)) reachable += 1;
  if (handed < reachable && !refusals.has(label))
    refusals.set(
      label,
      `harness: ${reachable - handed} of ${reachable} back-references were ` +
        'never handed to the decoder'
    );
  return parts.join('\n');
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
  for (let pass = 0; pass < SPEED_PASSES; pass += 1) {
    for (const [name, text] of Object.entries(byName)) {
      // MEASURED WITH `performance.now`, NOT `Date.now`. Several of these
      // payloads compress in under a millisecond, and a 1 ms clock reports
      // those as 0 -- indistinguishable from an arm that never ran.
      const samples = [];
      for (let i = 0; i < SPEED_SAMPLES; i += 1) {
        const t0 = performance.now();
        compressBlock(text, { query: queryOf(text) });
        samples.push(performance.now() - t0);
      }
      // KEPT IN RUN ORDER. Sorting loses which reading was first, and the
      // first reading is the one that paid for the JIT: it is routinely
      // several times the rest, on both arms. The gate decides what to do
      // with that; the harness hands over the readings, not the flattering
      // ones.
      passes.get(name).push(samples.map((v) => Number(v.toFixed(3))));
    }
  }
  return passes;
}

// TIMED BEFORE ANYTHING ELSE RUNS, so the passes see a comparable machine and
// not a process that has been compressing, tokenising and writing JSON for a
// minute by the time the last workload is reached.
const speedPasses = timeEveryWorkload(payloads);

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
  const out = compressBlock(text, { query: queryOf(text) });

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
  // the same product. The default arm leaves those blocks in the request, where
  // 1,274 of the 1,582 identifiers a reader can rebuild from the output alone
  // happen to live. Publishing one number would mean choosing which of those
  // facts to hide.
  const subSpilled = [];
  const sub = compressBlock(text, {
    spill: (content, hint) => {
      subSpilled.push(content);
      return `.token-optimizer/spill/s${subSpilled.length}-${hint}`;
    },
    query: queryOf(text),
    tuning: resolveTuning({ spillWholeBlockBelow: 1 }),
  });

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
    if (Array.isArray(parsed)) {
      const wrapped = JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        messages: parsed,
      });
      const result = compressBody(Buffer.from(wrapped, 'utf8'), (c, hint) => {
        bodySpilled.push(c);
        return `.token-optimizer/spill/b${bodySpilled.length}-${hint}`;
      });
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
        before: Buffer.byteLength(wrapped, 'utf8'),
        after: result.body.length,
        text: result.body.toString('utf8'),
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
  const conserved = !grew && spillRatio <= 2;

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
  const recoveredOut = recoverable(out.text, name);

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
  const subRecovered = recoverable(sub.text, `${name} (sub)`);
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
  const presetRecovered = recoverable(preset.text, `${name} (preset)`);
  const presetSpill = presetSpilled.join('\n');
  let presetGone = 0;
  let presetFree = 0;
  for (const id of want) {
    if (preset.text.includes(id) || presetRecovered.includes(id)) presetFree++;
    else if (!presetSpill.includes(id)) presetGone++;
  }

  let bodyGone = 0;
  if (body !== null) {
    const bodyRecovered = recoverable(body.text, `${name} (body)`);
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
  const theirResolved = resolved?.[name]?.text ?? null;
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
    bodyBefore: body?.before ?? 0,
    bodyAfter: body?.after ?? 0,
    bodyRatio: body ? 1 - body.after / body.before : null,
    bodyTokBefore: body?.tokBefore ?? 0,
    bodyTokAfter: body?.tokAfter ?? 0,
    bodyReason: body?.reason ?? '',
    bodyBehind: body?.behind ?? 0,
    bodyGone,
    // THEIR LIKE-FOR-LIKE ARM. See `theirCleanState` above for why this is
    // three-valued: null here means either "no such arm" or "this capture
    // cannot be asked", and the state says which. Summing null as zero would
    // report a reduction nobody measured, on their side of the table.
    theirCleanState,
    theirCleanArm,
    theirCleanTok,
    theirCleanBeforeTok,
    theirOffloadBytes,
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
    conserved,
    grew,
    spillRatio,
    // TURNS, and the tokens a turn drags back into context with it. The
    // in-context figure alone flatters whichever arm moved the most out, so
    // both are carried: what the agent is handed, and what it ends up paying
    // for if it needs all of it back.
    oursTurns: spilled.length,
    subTurns: subSpilled.length,
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
console.log(
  'workload                  before     ours    body     sub   theirs |   ours    body     sub  theirs (tokens) |  ids | ours:  ctx  derv spill  gone | body: gone | sub: gone | theirs:  ctx   ccr  gone | their arm'
);
for (const r of rows) {
  console.log(
    `${r.name.padEnd(22)} ${n(r.before, 8)}  ${pct(r.ours).padStart(6)}  ` +
      `${bodyPct(r)}  ${pct(r.subRatio).padStart(6)}  ${pct(r.theirs).padStart(6)} | ` +
      `${pct(r.oursTok).padStart(6)} ` +
      `${bodyTokPct(r)} ${pct(r.subTok).padStart(6)} ${pct(r.theirsTok).padStart(6)} | ` +
      `${n(r.ids, 5)} | ${n(r.inOut, 10)} ${n(r.derived, 5)} ${n(r.inSpill, 5)} ` +
      `${n(r.gone, 5)} | ${r.bodyRatio === null ? '         -' : n(r.bodyGone, 10)} | ` +
      `${n(r.subGone, 9)} | ` +
      `${n(r.theirIn, 12)} ${r.theirMeasured ? n(r.theirRedeemed, 5) : '    ?'} ` +
      `${r.theirMeasured ? n(r.theirGone, 5) : '    ?'} | ${r.arm}` +
      (r.conserved ? '' : '  !! CONSERVATION FAILED') +
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
  const L = (handed, blocks) => costLine({ handed, blocks, params });
  return {
    none: L(r.oursTokBefore, []),
    ours: L(r.oursTokAfter, r.oursBlockTok),
    theirs: L(theirHanded, theirBlocks),
    preset: L(r.presetTokAfter, r.presetBlockTok),
  };
};

// The fold belongs to the model, not to this file. A local copy that knew only
// the field names of an older cost line would drop the rest in silence, and the
// corpus row -- the one the README quotes -- would be quietly wrong while every
// per-session row above it stayed right.
const sessionCosts = rows.map((r) => {
  const arms = armsFor(r, PARAMS);
  return { name: r.name, r, arms, cross: breakEven(arms.ours, arms.theirs) };
});
const foldCorpus = (all) => {
  const keys = ['none', 'ours', 'theirs', 'preset'];
  const out = {};
  for (const key of keys) out[key] = sumLines(all.map((a) => a[key]));
  out.cross = breakEven(out.ours, out.theirs);
  return out;
};
const corpus = foldCorpus(sessionCosts.map((c) => c.arms));
// Keyed for the record block, which walks `rows` rather than `sessionCosts`.
const byName = Object.fromEntries(sessionCosts.map((c) => [c.name, c.arms]));
const crossByName = Object.fromEntries(
  sessionCosts.map((c) => [c.name, c.cross])
);

const k = (t) => `${(t / 1000).toFixed(1)}k`;
// EVERY `times` HERE IS A CORPUS RATIO, SO THE COMMON TERM IS PER SESSION
// TIMES THE NUMBER OF SESSIONS. A workload is one session, and the assistant
// writes its own output in each of them regardless of which arm packed the
// context. That output is 11.6% of the measured bill and no arm touches it, so
// it belongs on BOTH sides of a "what the cap buys" ratio -- omitted, it
// pushed every multiple away from 1, always in our favour.
const CORPUS_COMMON = commonSessionCost(PARAMS) * sessionCosts.length;
const times = (base, arm) =>
  `${usageMultiplier(base, arm, { commonCost: CORPUS_COMMON, params: PARAMS }).toFixed(2)}x`;
// A crossing outside [0, 1] is not a missing answer, it is the strongest one:
// the arm is cheaper at every fetch rate there is.
// `breakEven(ours, theirs)` names ours `a`. Three things can happen, and the
// column header says "ours wins below", so only one of them may be printed as a
// bare percentage: if theirs is the cheaper arm at rest, the SAME number means
// the opposite thing, and printing it unqualified would invert the claim. A
// second crossing gets a marker rather than being dropped -- with a quadratic
// cost there is no longer any guarantee that one rate settles the question.
const rate = (c) => {
  if (c.p === null) return c.cheaper === 'a' ? 'always' : 'never';
  const more = c.crossings.length > 1 ? '+' : '';
  const pct = `${(c.p * 100).toFixed(0)}%${more}`;
  return c.cheaper === 'a' ? pct : `above ${pct}`;
};

console.log(
  `
session cost, effective input tokens -- ${PARAMS.turnsAfter} turns after the ` +
    `payload, ${k(PARAMS.baseContextTokens)} of prior context (MEASURED over ` +
    `${baseMeasured.sessions} sessions on this machine, not assumed)`
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
      `${n(rate(c.cross), 7)}`
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
      `preset wins ${rate(pre)}`
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
for (const turnsAfter of [5, 20, 60])
  // THE GRID IS DERIVED FROM THE MEASUREMENT, NOT PINNED TO ROUND NUMBERS.
  // It was [4000, 12000, 40000], every value of which is below what this
  // machine actually carries -- a sensitivity band that does not contain the
  // real parameter tests nothing about the real claim.
  for (const baseContextTokens of [baseMeasured.min, baseMeasured.p50, baseMeasured.max]) {
    const params = { ...PARAMS, turnsAfter, baseContextTokens };
    const c = foldCorpus(rows.map((r) => armsFor(r, params)));
    const none = costAt(c.none, 0.5);
    console.log(
      `${n(turnsAfter, 11)} ${n(k(baseContextTokens), 11)} | ` +
        `${n(times(none, costAt(c.ours, 0.5)), 7)} ` +
        `${n(times(none, costAt(c.theirs, 0.5)), 9)} | ` +
        `${n(rate(c.cross), 12)}`
    );
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
  `tokens  ours ${pct(oursTokens)}   theirs ${pct(theirsTokens)}   (denominator: the same payload; cl100k_base on text, pixels/750 on images, both arms' real output; theirs is best-of-any arm, offload included -- see like4like)`
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
{
  const measured = rows.filter((r) => r.theirCleanState === 'measured');
  const noClean = rows.filter((r) => r.theirCleanState === 'none');
  const unrecorded = rows.filter((r) => r.theirCleanState === 'unrecorded');
  if (measured.length > 0) {
    const ourSide = 1 - sum2(measured, (r) => r.oursTokAfter) / sum2(measured, (r) => r.oursTokBefore);
    const theirSide =
      1 - sum2(measured, (r) => r.theirCleanTok) / sum2(measured, (r) => r.theirCleanBeforeTok);
    console.log(
      `like4like  ours ${pct(ourSide)}   theirs ${pct(theirSide)}   ` +
        `(tokens, over the ${measured.length} of ${rows.length} workloads where they have a ` +
        'non-offloading arm; their column above is best-of-any and includes offload)'
    );
  }
  if (noClean.length > 0)
    console.log(
      `           no like-for-like number on ${noClean.length}: ` +
        `${noClean.map((r) => r.name).join(', ')} -- every arm of theirs moved bytes to the store`
    );
  if (unrecorded.length > 0)
    console.log(
      `           cannot be asked on ${unrecorded.length}: ` +
        `${unrecorded.map((r) => r.name).join(', ')} -- captured before run-theirs.py recorded ` +
        'every arm; re-capture to score these'
    );
}
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
if (theirsUnmeasured.length)
  console.log(
    `  THEIR STORE UNMEASURED on ${theirsUnmeasured.length} workload(s): no ${'theirs-resolved.json'}. ` +
      'Their column is not comparable until ' +
      'bench/compression/headroom/resolve-theirs.py has been run over this out-dir.'
  );
// SAID OUT LOUD. Most retained identifiers live in the spill, and the spill is
// about the size of the input -- so the saving is a saving in CONTEXT, not on
// disk. That is the design (context tokens are the billed resource and a spill
// is fetched only by an explicit Read), but a reader is entitled to see the
// number rather than be told the conclusion.
console.log(
  `spill store: ${(sum((r) => r.spillRatio * r.before) / beforeAll).toFixed(2)}x the input, on disk, ` +
    `read only when an elision is followed up`
);
console.log(
  // THE SUBSTITUTION ARM'S STORE, PRINTED BESIDE ITS RATIO, because a column
  // reading 100.0% has to be readable as what it is. Nothing was compressed
  // there: the blocks are on disk at about their original size, and the ratio
  // measures how little of them is left in the request. Their content cache
  // column is the same trade with the same store behind it.
  `  substitution arm: ${(sum((r) => r.subStore) / beforeAll).toFixed(2)}x the input on disk, ` +
    `${sum((r) => r.subGone)} identifiers unrecoverable`
);

const lostWorkloads = rows.filter((r) => r.ours <= r.theirs).map((r) => r.name);
if (lostWorkloads.length)
  console.log(`LOST OR TIED ON: ${lostWorkloads.join(', ')}`);
const unconserved = rows.filter((r) => !r.conserved).map((r) => r.name);
if (unconserved.length)
  console.log(`CONSERVATION FAILED ON: ${unconserved.join(', ')}`);
// NAMED, BECAUSE A DECODER GAP LOOKS EXACTLY LIKE DATA LOSS IN THE COLUMNS
// ABOVE and the two want opposite fixes. Anything listed here was scored as if
// unrecoverable, so the gap costs us and the list is the work queue.
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
    dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
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
  const ourPassCounts = rows.map((r) => (Array.isArray(r.msPasses) ? r.msPasses.length : 0));
  const theirPassCounts = rows
    .map((r) => theirs[r.name])
    .filter((row) => row && Array.isArray(row.msSamples))
    .map((row) => (Array.isArray(row.msPasses) ? row.msPasses.length : 0));
  const reproduction = {
    commit,
    dirty,
    node: process.versions.node,
    tiktoken: tiktokenVersion,
    encoding: ENCODING_NAME,
    // THE INPUT THE RATIOS ARE A FUNCTION OF. The payload set is generated, so
    // it drifts, and two records taken over different payloads are not
    // comparable however alike their columns look.
    payloadsDigest: createHash('sha256')
      .update(readFileSync(join(dir, 'payloads.json')))
      .digest('hex')
      .slice(0, 16),
    theirsDigest: null,
    headroomVersion: theirs.__provenance__?.headroomVersion ?? null,
    python: theirs.__provenance__?.python ?? null,
    speedPasses: {
      ours: ourPassCounts.length ? Math.min(...ourPassCounts) : 0,
      theirs: theirPassCounts.length ? Math.min(...theirPassCounts) : 0,
    },
  };
  const record = {
    harness: 'bench/compression/head-to-head.mjs',
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
        };
      })(),
      chars: {
        ours: pct(r.ours),
        body: r.bodyRatio === null ? null : pct(r.bodyRatio),
        preset: pct(r.presetRatio),
        sub: pct(r.subRatio),
        theirs: pct(r.theirs),
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
        subUnrecoverable: String(r.subGone),
      },
      // THE TWO BOUNDS, RECORDED. `handed` is the text the agent is given;
      // `whole` is that plus everything the arm moved out, fetched back.
      // Recording only the first is how a store-backed arm reads as free.
      cost: {
        turns: {
          ours: String(r.oursTurns),
          theirs: String(r.theirTurns),
          preset: String(r.presetTurns),
        },
        handedTokens: {
          ours: String(r.oursTokAfter),
          theirs: String(tokens(theirs[r.name].bestText ?? '')),
        },
        wholeTokens: {
          ours: String(r.oursTokAfter + r.oursTokSpill),
          theirs: String(
            tokens(theirs[r.name].bestText ?? '') + r.theirTokRedeem
          ),
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
            preset: String(Math.round(costAt(byName[r.name].preset, 0))),
            theirs: String(Math.round(costAt(byName[r.name].theirs, 0))),
          },
          p1: {
            ours: String(Math.round(costAt(byName[r.name].ours, 1))),
            preset: String(Math.round(costAt(byName[r.name].preset, 1))),
            theirs: String(Math.round(costAt(byName[r.name].theirs, 1))),
          },
          breakEven: rate(crossByName[r.name]),
          // THE RATE THAT FLATTERS US LEAST, so a gate has something to stand
          // on. Cost is quadratic in the fetch rate, so the two endpoints no
          // longer bound the interval between them: a difference that opens
          // upward dips in the middle, and an arm can lead at 0% and at 100%
          // while trailing somewhere between. This is that point, found
          // exactly rather than sampled.
          worst: (() => {
            const w = worstAgainst(byName[r.name].ours, byName[r.name].theirs);
            return {
              fetchRate: w.p.toFixed(4),
              ours: String(Math.round(costAt(byName[r.name].ours, w.p))),
              theirs: String(Math.round(costAt(byName[r.name].theirs, w.p))),
            };
          })(),
        },
      },
      // SPEED, THE SECOND MUST-WIN. Ours is measured; theirs is null until a
      // capture carries it, because `run-theirs.py` has to time their resolver
      // in the process that runs it. A null here means UNMEASURED, and the gate
      // treats it as unmeasured rather than as a pass.
      speed: {
        oursMs: r.ms.toFixed(3),
        oursMsMin: r.msMin.toFixed(3),
        oursMsMax: r.msMax.toFixed(3),
        oursMsSamples: r.msSamples,
        // THE PASSES, KEPT APART. Pooling them would average an interference
        // event into the reading instead of exposing it; the gate compares the
        // passes with each other and refuses to decide when they disagree.
        oursMsPasses: r.msPasses,
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
      },
    })),
    totals: {
      chars: { ours: pct(oursChars), theirs: pct(theirsChars) },
      cost: {
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
            sum((r) => tokens(theirs[r.name].bestText ?? '') + r.theirTokRedeem)
          ),
        },
        // THE SAME MODEL OVER THE WHOLE CORPUS, plus the two session-shape
        // assumptions it was evaluated under, so a reader can tell which of
        // these figures would move if they disagreed with either.
        session: {
          turnsAfter: String(DEFAULTS.turnsAfter),
          baseContextTokens: String(PARAMS.baseContextTokens),
          baseContextSessions: String(baseMeasured.sessions),
          baseContextSource: 'measured',
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
          breakEven: rate(corpus.cross),
          // The `ours` arm above compresses in place and spills nothing, so
          // against a cache-read bill it is the wrong arm to quote alone.
          // `preset` is the one that evicts, and it is the one that wins.
          presetBreakEven: rate(breakEven(corpus.preset, corpus.theirs)),
          // What the same subscription cap buys, against doing nothing at all.
          capMultiple: {
            oursP0: times(costAt(corpus.none, 0), costAt(corpus.ours, 0)),
            theirsP0: times(costAt(corpus.none, 0), costAt(corpus.theirs, 0)),
            oursP50: times(costAt(corpus.none, 0.5), costAt(corpus.ours, 0.5)),
            theirsP50: times(
              costAt(corpus.none, 0.5),
              costAt(corpus.theirs, 0.5)
            ),
          },
        },
      },
      tokens: { ours: pct(oursTokens), theirs: pct(theirsTokens) },
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
    console.error('WARNING: this record is not re-runnable as written: ' + record.reproduction.refusal);
  }
  writeFileSync(
    at,
    `${JSON.stringify(record, null, 2)}
`
  );
  console.log(`recorded ${rows.length} workloads to ${at}`);
}

const failed =
  lost > 0 ||
  bodyLost > 0 ||
  lostWorkloads.length > 0 ||
  unconserved.length > 0 ||
  oursChars <= theirsChars ||
  oursTokens <= theirsTokens;
process.exit(failed ? 1 : 0);
