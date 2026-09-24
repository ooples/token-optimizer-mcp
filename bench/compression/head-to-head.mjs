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
import { resolveTuning } from '../../dist/compress/options.js';
import { compressBody } from '../../dist/proxy/server.js';
import { rehydrateSequence } from '../../dist/compress/rehydrate.js';
import { describeImage, imageSize } from '../../dist/compress/images.js';
import { PathAddressedError } from '../../dist/compress/annotate.js';

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
// NOT A DEFECT, AND IT USED TO SHARE A LIST WITH ONE. `rehydrate` rebuilds from
// the output ALONE, so a `[... what went -> path]` marker is something it can
// never expand -- the path is the whole point of it. Six of those sat on a
// queue the comment above calls the work queue, which is how a queue stops
// being read. They are counted, because a column of them growing IS worth
// seeing, but they are not named as gaps.
const pathRefusals = new Map();
function recoverable(text, label) {
  const parts = [];
  let step = rehydrateSequence();
  const decode = (fragment) => {
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

  const walk = (node) => {
    if (typeof node === 'string') decode(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object')
      Object.values(node).forEach(walk);
  };
  // A SERIALISED MESSAGE LIST IS NOT A BLOCK, and handing one to a line-oriented
  // decoder asks a question with no answer: the document is one line with every
  // newline escaped, so a marker claiming 8 folded rows meets 135 candidates and
  // the decoder correctly refuses. That refusal said nothing about our output --
  // it was the harness mis-addressing the decoder -- and it produced four of the
  // names on the gap list. The blocks are the string leaves, so when the payload
  // parses, the leaves are the whole of the attempt.
  if (parsed !== undefined) walk(parsed);
  else decode(text);
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
    bodyBefore: body?.before ?? 0,
    bodyAfter: body?.after ?? 0,
    bodyRatio: body ? 1 - body.after / body.before : null,
    bodyTokBefore: body?.tokBefore ?? 0,
    bodyTokAfter: body?.tokAfter ?? 0,
    bodyReason: body?.reason ?? '',
    bodyBehind: body?.behind ?? 0,
    bodyGone,
    subAfter: sub.text.length,
    subStore: subSpilled.reduce((n, c) => n + c.length, 0),
    subRatio: 1 - sub.text.length / before,
    subTok: 1 - tokens(sub.text) / tokens(text),
    subTokAfter: tokens(sub.text),
    subGone,
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

// THE SUBSTITUTION ARM'S OWN TOTALS, on the same denominators as the two above.
// They are not a compression ratio and the line below says so: a moved block is
// on disk, and `spill store` reports what that costs.
const subAll = sum((r) => r.subAfter);
const subTokAll = sum((r) => r.subTokAfter);

const oursChars = 1 - oursAll / beforeAll;
const theirsChars = 1 - theirsAll / beforeAll;
const oursTokens = 1 - oursTokAll / beforeTokAll;
const theirsTokens = 1 - theirsTokAll / beforeTokAll;

console.log('');
console.log(
  `chars   ours ${pct(oursChars)}   theirs ${pct(theirsChars)}   (denominator: the payload bytes both arms were given)`
);
console.log(
  `tokens  ours ${pct(oursTokens)}   theirs ${pct(theirsTokens)}   (denominator: the same payload; cl100k_base on text, pixels/750 on images, both arms' real output)`
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
const failed =
  lost > 0 ||
  bodyLost > 0 ||
  lostWorkloads.length > 0 ||
  unconserved.length > 0 ||
  oursChars <= theirsChars ||
  oursTokens <= theirsTokens;
process.exit(failed ? 1 : 0);
