/**
 * Does the model still get the right answer after we compress its context?
 *
 * WHY THIS EXISTS. Every gate in bench/compression is compression-intrinsic --
 * needles survive, the relevant row survives, the cached prefix is not
 * rewritten. All of them are about the TEXT. None of them answers the question
 * a reviewer actually asks, which is whether the model's answer changes. That
 * gap mattered more once the head-to-head showed we keep 345 of 3,793
 * retention units directly visible against HeadRoom's 1,890: we reach a higher
 * reduction partly by eliding into a spill, and the cost of that shows up in
 * task accuracy or nowhere.
 *
 * HeadRoom publish GSM8K, TruthfulQA, SQuAD v2 and BFCL with a baseline column.
 * This is the SQuAD v2 arm of that, run through the Claude Code subscription
 * rather than an API key.
 *
 *   node bench/accuracy/squad-eval.mjs [--n 40] [--distractors 12] [--json out.json]
 *
 * THE DESIGN RULES, each of which exists because its absence has produced a
 * meaningless number in this repository before:
 *
 * 1. A BASELINE ARM, ASKED THE SAME WAY. Both arms get the identical prompt
 *    template and the identical question; only the context block differs. A
 *    compressed-only score is unreadable -- the model's own ceiling on this
 *    dataset is not 100%, so "ours scored 0.88" says nothing without the
 *    control beside it.
 *
 * 2. REAL BULK, OR THE ARM IS INERT. One SQuAD paragraph is ~700 characters
 *    and our engine correctly leaves it alone. So the gold paragraph is placed
 *    among distractor paragraphs from other articles and shaped as a tool
 *    result, which is the payload the product is actually for. A previous
 *    campaign here concluded an index "buys nothing measurable" while its
 *    largest fixture was 342 bytes.
 *
 * 3. A VACUITY GUARD ON COMPRESSION. If the mean reduction is trivial, the two
 *    arms are the same experiment run twice and the run FAILS rather than
 *    reporting parity. Parity on an inert arm is the single most flattering
 *    wrong answer available here.
 *
 * 4. GROUND TRUTH, NOT AGREEMENT. Scoring is "does a gold answer appear in the
 *    reply", normalised. Comparing the two arms' replies to EACH OTHER would
 *    score a pair of identically wrong answers as a pass.
 *
 * 5. ONLY ANSWERABLE ITEMS. SQuAD v2's unanswerable half is a different test
 *    (abstention), and mixing them lets a model that always says "not stated"
 *    bank half the set.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compressBlock } from '../../dist/compress/router.js';

const here = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const N = Number(arg('n', 40));
const DISTRACTORS = Number(arg('distractors', 12));
const JSON_OUT = arg('json', null);
const MIN_MEAN_REDUCTION = 0.15;

const ROWS_URL =
  'https://datasets-server.huggingface.co/rows' +
  '?dataset=rajpurkar%2Fsquad_v2&config=squad_v2&split=validation';

/** SQuAD v2 validation rows, answerable ones only, unauthenticated. */
async function fetchItems(want) {
  // Deliberately over-fetch. The split is ordered BY ARTICLE, so the first
  // `want` answerable rows are `want` paragraphs about one subject -- and
  // then the distractor slots fill with paragraphs from that same article,
  // several of which state the answer. That inflates both arms and hides
  // exactly what this eval is for. Selection below takes one item per
  // article, round robin, so a distractor is always off-subject.
  const items = [];
  let offset = 0;
  const want_ = want;
  want = Math.max(want * 12, 240);
  while (items.length < want && offset < want * 20 + 400) {
    const res = await fetch(`${ROWS_URL}&offset=${offset}&length=100`);
    if (!res.ok) throw new Error(`datasets-server ${res.status}`);
    const body = await res.json();
    if (!body.rows?.length) break;
    for (const { row } of body.rows) {
      const gold = (row.answers?.text || []).filter(Boolean);
      if (!gold.length) continue;
      if (!row.context || !row.question) continue;
      items.push({
        id: row.id,
        title: row.title,
        context: row.context,
        question: row.question,
        gold,
      });
      if (items.length >= want) break;
    }
    offset += 100;
  }
  // One per article first, then a second pass, and so on -- so a short run
  // is maximally diverse and a long one degrades gracefully.
  const byTitle = new Map();
  for (const it of items) {
    if (!byTitle.has(it.title)) byTitle.set(it.title, []);
    byTitle.get(it.title).push(it);
  }
  const buckets = [...byTitle.values()];
  const chosen = [];
  for (let round = 0; chosen.length < want_; round += 1) {
    let added = 0;
    for (const b of buckets) {
      if (b.length > round && chosen.length < want_) {
        chosen.push(b[round]);
        added += 1;
      }
    }
    if (!added) break;
  }
  if (chosen.length < want_) {
    throw new Error(
      `only ${chosen.length} answerable items available, wanted ${want_}`
    );
  }
  if (buckets.length < 2) {
    throw new Error(
      'every item came from one article, so no distractor can be off-subject'
    );
  }
  console.log(
    `corpus: ${chosen.length} items drawn from ${buckets.length} distinct articles`
  );
  return chosen;
}

/**
 * The payload the model reads: a search result over an article corpus, with
 * the gold paragraph buried among paragraphs about other subjects.
 *
 * Deterministic placement by index rather than at random, so a re-run of the
 * same N compares like with like and a regression is a regression rather than
 * a reshuffle.
 */
function payloadFor(item, index, pool) {
  const blocks = [];
  const goldSlot = index % (DISTRACTORS + 1);
  let taken = 0;
  for (let slot = 0; slot <= DISTRACTORS; slot += 1) {
    if (slot === goldSlot) {
      blocks.push({ title: item.title, text: item.context });
      continue;
    }
    // Skip the item's own article, or a "distractor" would carry the answer.
    let candidate;
    do {
      candidate = pool[(index * 7 + taken * 13 + 1) % pool.length];
      taken += 1;
    } while (candidate.title === item.title && taken < pool.length * 2);
    blocks.push({ title: candidate.title, text: candidate.context });
  }

  // SHAPE MATTERS MORE THAN SIZE, and this line is why the first version of
  // this eval measured 0.0% reduction and then reported a meaningless
  // baseline 1.000 / ours 1.000. Our engine engages on a pretty-printed JSON
  // array -- 94.6% on a 300-row log -- and is completely inert on the very
  // same rows emitted as JSON-lines, 0.0% at 55KB. A search API returning
  // documents is legitimately the former, so that is the shape used here,
  // rather than a bracketed text dump that no detector claims.
  return JSON.stringify(
    blocks.map((b, i) => ({ doc: i + 1, title: b.title, text: b.text })),
    null,
    2
  );
}

function compress(text, question) {
  const spilled = [];
  const spill = (content, hint) => {
    spilled.push(content);
    return `.token-optimizer/spill/${spilled.length}-${hint}`;
  };
  const out = compressBlock(text, { spill, query: question });
  return { text: out.text, spilledCount: spilled.length };
}

const PROMPT = (context, question) =>
  `Answer the question using only the documents below.\n` +
  `Reply with the answer and nothing else -- no preamble, no explanation.\n` +
  `If the documents do not contain the answer, reply exactly: NOT STATED\n\n` +
  `--- documents ---\n${context}\n--- end documents ---\n\n` +
  `Question: ${question}\nAnswer:`;

/** One subscription-backed model call. */
function ask(prompt) {
  try {
    return execFileSync('claude', ['-p', prompt], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 180_000,
    }).trim();
  } catch (err) {
    // A failed call is not a wrong answer, and must never be scored as one.
    return null;
  }
}

const norm = (s) =>
  s
    .toLowerCase()
    .replace(/\b(a|an|the)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function correct(reply, gold) {
  if (reply === null) return null;
  const r = norm(reply);
  if (!r) return false;
  return gold.some((g) => {
    const n = norm(g);
    return n.length > 0 && r.includes(n);
  });
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

async function main() {
  console.log(
    `SQuAD v2 accuracy, baseline vs compressed -- n=${N}, ${DISTRACTORS} distractor docs per item`
  );
  console.log('scored on ground-truth match; model calls via the Claude Code subscription\n');

  const items = await fetchItems(N);
  const pool = items;

  const rows = [];
  let baselineOk = 0;
  let oursOk = 0;
  let scored = 0;
  let errors = 0;
  let reductionSum = 0;

  for (const [i, item] of items.entries()) {
    const full = payloadFor(item, i, pool);
    const { text: squeezed, spilledCount } = compress(full, item.question);
    const reduction = full.length ? 1 - squeezed.length / full.length : 0;
    reductionSum += reduction;

    const baseReply = ask(PROMPT(full, item.question));
    const oursReply = ask(PROMPT(squeezed, item.question));

    const baseHit = correct(baseReply, item.gold);
    const oursHit = correct(oursReply, item.gold);

    if (baseHit === null || oursHit === null) {
      errors += 1;
    } else {
      scored += 1;
      if (baseHit) baselineOk += 1;
      if (oursHit) oursOk += 1;
    }

    rows.push({
      id: item.id,
      question: item.question,
      gold: item.gold,
      chars: { before: full.length, after: squeezed.length },
      reduction,
      spilledCount,
      baseline: { reply: baseReply, correct: baseHit },
      ours: { reply: oursReply, correct: oursHit },
    });

    const mark = (h) => (h === null ? '!' : h ? 'y' : 'n');
    console.log(
      `${String(i + 1).padStart(3)}/${items.length}  ` +
        `${String(full.length).padStart(6)} -> ${String(squeezed.length).padStart(6)} ` +
        `(${pct(reduction).padStart(6)})  base ${mark(baseHit)}  ours ${mark(oursHit)}  ` +
        `${item.question.slice(0, 52)}`
    );
  }

  const meanReduction = reductionSum / items.length;
  const baseAcc = scored ? baselineOk / scored : 0;
  const oursAcc = scored ? oursOk / scored : 0;

  console.log('\n--- result ---');
  console.log(`scored items        ${scored}${errors ? ` (${errors} dropped: model call failed)` : ''}`);
  console.log(`mean reduction      ${pct(meanReduction)}`);
  console.log(`baseline accuracy   ${baseAcc.toFixed(3)}  (${baselineOk}/${scored})`);
  console.log(`ours accuracy       ${oursAcc.toFixed(3)}  (${oursOk}/${scored})`);
  console.log(`delta               ${(oursAcc - baseAcc >= 0 ? '+' : '')}${(oursAcc - baseAcc).toFixed(3)}`);

  if (JSON_OUT) {
    // resolve(), not join(cwd, ...): an ABSOLUTE --json path joined onto the
    // working directory becomes C:\repo\C:\tmp\..., which threw ENOENT after
    // a completed 30-item run and discarded the machine-readable copy of it.
    mkdirSync(dirname(resolve(JSON_OUT)), { recursive: true });
    writeFileSync(
      resolve(JSON_OUT),
      JSON.stringify(
        { n: N, distractors: DISTRACTORS, meanReduction, baseAcc, oursAcc, scored, errors, rows },
        null,
        2
      )
    );
    console.log(`\nwrote ${JSON_OUT}`);
  }

  const failures = [];
  if (meanReduction < MIN_MEAN_REDUCTION) {
    failures.push(
      `mean reduction ${pct(meanReduction)} is below ${pct(MIN_MEAN_REDUCTION)} -- ` +
        'the compressed arm barely differs from the baseline, so this run compares ' +
        'nothing and its accuracy numbers mean nothing'
    );
  }
  if (scored < Math.ceil(items.length * 0.8)) {
    failures.push(
      `only ${scored} of ${items.length} items scored -- too many model calls failed ` +
        'to report an accuracy'
    );
  }

  console.log('\n--- gate: the comparison must be real before its result is readable ---');
  if (failures.length) {
    for (const f of failures) console.log(`GATE FAILED: ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log('GATE PASSED.');
  console.log(
    '\nNote on reading the delta: at this n a few points either way sits inside\n' +
      'the interval. The number worth quoting is the pair, with n, never the delta alone.'
  );
}

main().catch((err) => {
  console.error(`squad-eval failed: ${err.message}`);
  process.exitCode = 1;
});
