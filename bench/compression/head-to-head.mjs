/**
 * The head-to-head, against HeadRoom's own fixtures and their own recorded result.
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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { get_encoding } from 'tiktoken';
import { compressBlock } from '../../dist/compress/router.js';
import { rehydrate } from '../../dist/compress/rehydrate.js';

const dir = process.argv[2];
if (!dir) {
  console.error(
    'usage: node bench/compression/head-to-head.mjs <out-dir-from-run-theirs>'
  );
  process.exit(2);
}

const payloads = JSON.parse(readFileSync(join(dir, 'payloads.json'), 'utf8'));
const theirs = JSON.parse(readFileSync(join(dir, 'theirs.json'), 'utf8'));

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
const encoding = get_encoding('cl100k_base');
const tokens = (text) => encoding.encode(text).length;

/**
 * Things whose loss would be silent and fatal.
 *
 * THE FIRST VERSION OF THIS WAS NEARLY VACUOUS. It looked for UUIDs and hex
 * runs with `\b` boundaries and found ZERO identifiers in four of six
 * workloads -- so "zero lost" was mostly a statement about an empty set. Worse,
 * the one shape these fixtures are full of is `trace_84aa3ff0fa334b02`, and
 * `\b` does not match between `_` and `8` because both are word characters, so
 * the pattern could not see the very needles it was written for.
 *
 * This version derives the set STRUCTURALLY instead: every distinctive string
 * value in the payload, where distinctive means at least eight characters and
 * containing a digit. That catches trace ids, hostnames like `server-18`,
 * usernames, emails, paths and timestamps -- everything a later turn might
 * search for -- and excludes prose and bare small integers, which would report
 * noise as loss and make the check meaningless in the other direction.
 */
const DISTINCTIVE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{7,}$/;

function collect(value, into) {
  if (typeof value === 'string') {
    if (DISTINCTIVE.test(value) && /\d/.test(value)) into.add(value);
    // Structured content arrives as a string inside a tool result, so the
    // identifiers in it are one parse deeper than the top level.
    if (value.length > 2 && (value[0] === '{' || value[0] === '[')) {
      try {
        collect(JSON.parse(value), into);
      } catch {
        /* not nested JSON */
      }
    }
    // Free text carries them too -- a log line is one string, not a field.
    for (const word of value.split(/[\s",]+/)) {
      if (DISTINCTIVE.test(word) && /\d/.test(word)) into.add(word);
    }
    // PROSE NEEDS ITS OWN UNIT, or the check is vacuous on prose. The whole
    // identifier rule keys on "contains a digit", and a documentation heading
    // like `## API Reference: /users` contains none -- so the RAG workload
    // reported ONE identifier in 172KB and "zero lost" was a statement about
    // an almost empty set. A section heading is what a reader of a document
    // comes back for, exactly as a trace id is in a log, so distinct headings
    // are counted as retention units too.
    for (const heading of value.match(/^#{1,6} .+$/gm) || []) {
      into.add(heading.trim());
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collect(item, into);
  }
}

function identifiers(text) {
  const found = new Set();
  try {
    collect(JSON.parse(text), found);
  } catch {
    collect(text, found);
  }
  return found;
}

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
const refusals = new Map();
function recoverable(text, label) {
  const parts = [];
  const decode = (fragment) => {
    try {
      const back = rehydrate(fragment);
      if (back !== fragment) parts.push(back);
    } catch (error) {
      const first = String(error.message).split('\n')[0];
      if (!refusals.has(label)) refusals.set(label, first);
    }
  };
  decode(text);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const walk = (node) => {
    if (typeof node === 'string') decode(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object')
      Object.values(node).forEach(walk);
  };
  if (parsed !== undefined) walk(parsed);
  return parts.join('\n');
}

const rows = [];
let lost = 0;

for (const [name, text] of Object.entries(payloads)) {
  // CAPTURED, NOT DISCARDED. Content that moved to a spill is recoverable and
  // must be scored as retained; a harness that ignored the spill would report
  // our own elisions as data loss.
  const spilled = [];
  const spill = (content, hint) => {
    spilled.push(content);
    return `.token-optimizer/spill/${spilled.length}-${hint}`;
  };

  const started = Date.now();
  const out = compressBlock(text, { spill, query: queryOf(text) });
  const ms = Date.now() - started;

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

  const want = identifiers(text);

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
  const haveOut = out.text;
  const haveSpill = spilled.join('\n');
  let inOut = 0;
  let derived = 0;
  let inSpill = 0;
  let gone = 0;
  const missing = [];
  for (const id of want) {
    if (haveOut.includes(id)) inOut++;
    else if (recoveredOut.includes(id)) derived++;
    else if (haveSpill.includes(id)) inSpill++;
    else {
      gone++;
      if (missing.length < 5) missing.push(id);
    }
  }
  lost += gone;

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
    inOut,
    derived,
    inSpill,
    gone,
    theirIn,
    theirRedeemed,
    theirGone,
    theirMeasured: theirResolved !== null,
    missing,
    conserved,
    grew,
    spillRatio,
    ms,
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
console.log(
  'workload                  before     ours   theirs |   ours  theirs (tokens) |  ids | ours:  ctx  derv spill  gone | theirs:  ctx   ccr  gone | their arm'
);
for (const r of rows) {
  console.log(
    `${r.name.padEnd(22)} ${n(r.before, 8)}  ${pct(r.ours).padStart(6)}  ` +
      `${pct(r.theirs).padStart(6)} | ${pct(r.oursTok).padStart(6)} ${pct(r.theirsTok).padStart(6)} | ` +
      `${n(r.ids, 5)} | ${n(r.inOut, 10)} ${n(r.derived, 5)} ${n(r.inSpill, 5)} ` +
      `${n(r.gone, 5)} | ${n(r.theirIn, 12)} ${r.theirMeasured ? n(r.theirRedeemed, 5) : '    ?'} ` +
      `${r.theirMeasured ? n(r.theirGone, 5) : '    ?'} | ${r.arm}` +
      (r.conserved ? '' : '  !! CONSERVATION FAILED')
  );
}

const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
const beforeAll = sum((r) => r.before);
const oursAll = sum((r) => r.after);
const theirsAll = sum((r) => theirs[r.name].after);
const beforeTokAll = sum((r) => r.oursTokBefore);
const oursTokAll = sum((r) => r.oursTokAfter);
// Their per-workload token ratio applied to the common denominator, so the
// corpus total is not skewed by their envelope on three of six workloads.
const theirsTokAll = sum((r) =>
  Math.round(r.oursTokBefore * (1 - r.theirsTok))
);

const oursChars = 1 - oursAll / beforeAll;
const theirsChars = 1 - theirsAll / beforeAll;
const oursTokens = 1 - oursTokAll / beforeTokAll;
const theirsTokens = 1 - theirsTokAll / beforeTokAll;

console.log('');
console.log(
  `chars   ours ${pct(oursChars)}   theirs ${pct(theirsChars)}   (denominator: the payload bytes both arms were given)`
);
console.log(
  `tokens  ours ${pct(oursTokens)}   theirs ${pct(theirsTokens)}   (denominator: the same payload, tokenised with cl100k_base, both arms' real output)`
);
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

const failed =
  lost > 0 ||
  lostWorkloads.length > 0 ||
  unconserved.length > 0 ||
  oursChars <= theirsChars ||
  oursTokens <= theirsTokens;
process.exit(failed ? 1 : 0);
