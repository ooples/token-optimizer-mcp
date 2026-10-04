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
 * So this is a failing specification, not a passing measurement. The 86%
 * residency term can only be struck from the fetch cost for content that
 * demonstrably re-withholds, and the work is to make the other nine do it. The
 * count passing is the progress measure: 2 of 11 today.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compressBlock } from './ours-engine.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, '..', '..', 'hr-corpus', 'natives-18.json');
const STAMP = '100000001';

let failures = 0;
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
    const first = compressBlock(text, { stamp: STAMP }).text;
    // The client's view after an expansion: the original content is back in the
    // body, alongside what was already compressed.
    const reoffered = compressBlock(`${text}\n${first}`, {
      stamp: STAMP,
    }).text;
    const again = compressBlock(first, { stamp: STAMP }).text;
    const grew = reoffered.length / first.length;
    if (!(grew < 1.1))
      bad(
        `${name} re-withholds an expansion`,
        `${first.length} -> ${reoffered.length} chars, ${((grew - 1) * 100).toFixed(1)}% larger, so the expansion stayed`
      );
    else
      ok(
        `${name} re-withholds an expansion`,
        `${first.length} -> ${reoffered.length} chars from a body ${((text.length + first.length) / first.length).toFixed(1)}x larger`
      );
    if (again !== first)
      bad(
        `${name} is idempotent once compressed`,
        `${first.length} -> ${again.length} chars, so a per-turn recompression ratchets the payload`
      );
  }
  console.log(
    failures === 0
      ? '\nan expansion is resident for one turn, not for the rest of the session'
      : `\n${failures} assertion(s) failed`
  );
}
process.exitCode = failures === 0 ? 0 : 1;
