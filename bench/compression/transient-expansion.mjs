/**
 * AN EXPANSION DOES NOT STAY, AND THAT IS THE WHOLE FETCH COST.
 *
 * The preset arm reads 2.81x against their 1.69x with nothing fetched and
 * 1.43x with everything fetched, and the swing is almost entirely one term.
 * Decomposed from the cost model over its 61 trips, a fetch costs 61,962
 * tokens: 300 for the call the model writes, 8,428 for its share of an extra
 * request, and 53,234 -- 86% -- for RESIDENCY, because `costLine` charges a
 * fetched unit `size * (W + R*(N-at))`: resident for every remaining turn.
 *
 * That charge assumes the expansion stays in the conversation once it arrives.
 * For this engine it does not, and this file is the proof rather than the
 * argument. Measured on raw-build-log:
 *
 *   turn 1  157,949 -> 46,340 chars
 *   turn 2  204,289 -> 46,762   the expanded body handed back, re-withheld
 *   turn 3   46,340 -> 46,340   already compressed, idempotent, no growth
 *
 * Turn 2 is the case that matters: hand back the original content alongside the
 * compressed form -- what a client holds once an expansion has been spliced in
 * -- and the result collapses to within 1% of turn 1. The expansion is gone
 * again. Residency is therefore ONE turn, not the twenty-eight the model
 * charges, and correcting that is not a favour to our own arm; it is what the
 * arm demonstrably does.
 *
 * A deferring engine cannot assume the same. Its store is outside the
 * conversation and `retrieve()` puts content back in; whether anything then
 * removes it is a question about their pipeline that this file does not answer
 * and must not guess at. The same experiment run against their engine is what
 * would settle it.
 *
 * Turn 3 matters too, for a different reason: re-compressing an
 * already-compressed body returns it byte for byte. Without that, a per-turn
 * recompression would ratchet the payload upward and the saving would be a
 * one-turn illusion.
 *
 * AND IT ONLY HOLDS ON 2 OF 11 FIXTURES, WHICH IS WHY THIS FILE EXISTS. The
 * numbers above are raw-build-log, and generalising from them was wrong:
 * search-results grows 364% when its expansion is handed back, repeated-reads
 * 280%. Nine fixtures fail. Re-withholding happens on log-shaped content and
 * not on structured content, so transient expansion is a property this engine
 * has in places rather than a property it has.
 *
 * AND RUNNING IT PROPERLY KILLS THE SIMPLE VERSION OF THE IDEA. With the real
 * `spill` option and the spilling tuning, an expansion spliced back does
 * collapse -- search-results takes 92,173 characters to 77, sre-debugging
 * 33,096 to 77. But 77 characters is not re-withholding the expansion, it is
 * spilling the WHOLE BODY, and the idempotency arm proves it: recompressing an
 * already-compressed body takes sre-debugging from 9,064 characters to 76.
 *
 * So a per-turn recompression under a spilling policy does not hold the payload
 * steady, it ratchets everything out of the conversation. The tokens stop being
 * charged as residency and start being charged as fetches, which is the term
 * that was 86% of the cost to begin with. Transient expansion only pays if the
 * policy is STABLE -- a unit once kept must stay kept -- and the spilling
 * tuning is not. That is the constraint the design has to satisfy, and it is
 * the thing the first three versions of this file could not have told me,
 * because they never spilled anything at all.
 *
 * So this is a failing specification, not a passing measurement. The 86%
 * residency term can only be struck from the fetch cost for content that
 * demonstrably re-withholds, and the work is to make the other nine do it. The
 * count passing is the progress measure: 2 of 11 today.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compressBlock } from './ours-engine.mjs';
import { resolveTuning } from '../../dist/compress/options.js';

/**
 * THE SPILLING CONFIGURATION, WHICH IS NOT THE DEFAULT.
 *
 * A sink alone spills nothing: the first version of this file passed a sink,
 * never saw it called, and reported "spills nothing, so none can stay" for
 * every fixture -- eleven green assertions about an experiment that had not
 * run. The preset arm in head-to-head.mjs reaches the spilling behaviour
 * through `spillWholeBlockBelow`, and without it there is no withheld unit to
 * expand and nothing to measure.
 */
const SPILLING = resolveTuning({ spillWholeBlockBelow: 0.9 });

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, '..', '..', 'hr-corpus', 'natives-18.json');
const STAMP = '100000001';

let failures = 0;
/** Fixtures with nothing withheld: no experiment ran on them. */
const skipped = [];
const ok = (name, detail) => console.log(`ok   ${name} -- ${detail}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`FAIL ${name} -- ${detail}`);
};

function fixtures() {
  if (!existsSync(CORPUS)) return [];
  const parsed = JSON.parse(readFileSync(CORPUS, 'utf-8'));
  const list = Array.isArray(parsed)
    ? parsed
    : Object.entries(parsed).map(([name, value]) => ({
        name,
        ...(typeof value === 'object' ? value : { text: value }),
      }));
  return list.map((entry) => ({
    name: entry.name,
    text: Object.keys(entry)
      .filter((key) => /^[0-9]+$/.test(key))
      .map((key) => entry[key])
      .map((m) =>
        typeof m.content === 'string'
          ? m.content
          : JSON.stringify(m.content ?? m)
      )
      .join('\n'),
  }));
}

const rows = fixtures().filter((f) => f.text.length > 20000);
if (rows.length === 0) {
  console.log(
    'no fixture corpus vendored here; run with hr-corpus present to measure transient expansion'
  );
} else {
  for (const { name, text } of rows) {
    // SPILLING, BECAUSE ONLY A SPILLED UNIT IS EVER FETCHED. The default arm
    // hands back zero blocks and makes zero round trips, so the residency term
    // this file is about does not apply to it. The sink records what left the
    // body and under which path, which is what an expansion puts back.
    const spilled = new Map();
    // `spill`, NOT `sink`. The option is named `spill` in the engine, and a
    // wrong key is silently ignored: the previous version passed `sink`, was
    // never called, and reported every fixture as having nothing to expand.
    const spill = (content, hint) => {
      const path = `.token-optimizer/spill/t${spilled.size + 1}-${hint}`;
      spilled.set(path, content);
      return path;
    };
    const first = compressBlock(text, {
      spill,
      stamp: STAMP,
      tuning: SPILLING,
    }).text;
    if (spilled.size === 0) {
      // NOT A PASS. A fixture that spills nothing under the spilling
      // configuration means this experiment did not run on it, and calling
      // that "no unit can be fetched" is how the first version reported eleven
      // green assertions for a sink that was never called.
      // OUT OF SCOPE, AND COUNTED. At a 0.9 threshold the move fires only where
      // the engines could not reach 90%, which on this corpus is the log and
      // grep shapes. A fixture that spills nothing has no withheld unit, so
      // there is nothing here to stay resident -- but it is counted as skipped
      // rather than passed, because a skip that reads as a pass is how the
      // first two versions of this file reported green.
      skipped.push(name);
      continue;
    }
    // ONE MARKER, REPLACED BY WHAT IT STANDS FOR. The earlier version appended
    // the whole original beside the compressed form, so the body held both
    // copies -- a shape no client ever sends, and one that made nine fixtures
    // look like failures because the duplicate was what went unremoved.
    const [path, content] = [...spilled][0];
    if (!first.includes(path)) {
      bad(
        `${name} names its spilled unit in the body`,
        `no occurrence of ${path}, so an expansion cannot be simulated`
      );
      continue;
    }
    const expanded = first.replace(path, content);
    const reoffered = compressBlock(expanded, {
      spill,
      stamp: STAMP,
      tuning: SPILLING,
    }).text;
    const again = compressBlock(first, {
      spill,
      stamp: STAMP,
      tuning: SPILLING,
    }).text;
    const grew = reoffered.length / first.length;
    if (!(grew < 1.1))
      bad(
        `${name} re-withholds an expansion`,
        `${first.length} -> ${reoffered.length} chars, ${((grew - 1) * 100).toFixed(1)}% larger, so the expansion stayed`
      );
    else
      ok(
        `${name} re-withholds an expansion`,
        `${expanded.length} chars spliced back collapse to ${reoffered.length}, against ${first.length} before`
      );
    if (again !== first)
      bad(
        `${name} is idempotent once compressed`,
        `${first.length} -> ${again.length} chars, so a per-turn recompression ratchets the payload`
      );
  }
  if (skipped.length === rows.length)
    bad(
      'the experiment ran on at least one fixture',
      `all ${rows.length} spilled nothing, so every assertion above is about nothing`
    );
  else
    ok(
      'the experiment ran',
      `${rows.length - skipped.length} of ${rows.length} fixture(s) withheld a unit; skipped ${skipped.join(', ') || 'none'}`
    );
  console.log(
    failures === 0
      ? '\nan expansion is resident for one turn, not for the rest of the session'
      : `\n${failures} assertion(s) failed`
  );
}
process.exitCode = failures === 0 ? 0 : 1;
