/**
 * THEIR STORE'S ANSWER, ON CASES WHOSE ANSWER IS KNOWN IN ADVANCE.
 *
 * The decision under test moves their retention column between measured and
 * unmeasured, and it is the one decision in this harness whose failure mode
 * flatters US: a resolution taken after their store forgot reports every marker
 * unresolved, which scores as their loss and our win. So the cases below are
 * weighted toward refusing, and two of them are the real artifacts on disk.
 *
 * The cases that carry the weight:
 *
 *  - `zero of many redeemed is not a measurement` -- the hr24 signature, and the
 *    only one that can be mistaken for a retention win.
 *  - `some redeemed and some not IS a measurement` -- the converse, without which
 *    the refusal would swallow their genuine losses too and flatter them instead.
 *  - `no markers at all is fully measured` -- six of twelve workloads, which must
 *    not be refused for having nothing to redeem.
 *  - `an unrecognised shape is unusable, not assumed good` -- the direction of the
 *    default is the whole point.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolutionUsable } from './store-resolution.mjs';

let failures = 0;
const check = (cond, what, detail) => {
  if (cond) console.log(`ok   ${what}${detail === undefined ? '' : ` -- ${detail}`}`);
  else {
    failures += 1;
    console.log(`FAIL ${what}${detail === undefined ? '' : ` -- ${detail}`}`);
  }
};

console.log('no markers at all is fully measured');
{
  const r = resolutionUsable({ text: 'plain output', markers: 0, unresolved: 0 });
  check(r.usable === true, 'a workload their compressor elided nothing from', r.detail);
}

console.log('\nzero of many redeemed is not a measurement');
{
  const r = resolutionUsable({ text: 'x', markers: 4, unresolved: 4, reasons: [] });
  check(r.usable === false, '0 of 4 refuses', r.detail);
  check(r.detail.includes('served none of 4'), 'and says so in those terms', r.detail);
  const one = resolutionUsable({ text: 'x', markers: 1, unresolved: 1, reasons: [] });
  check(one.usable === false, '0 of 1 refuses too -- the rule is not about the count', one.detail);
}

console.log('\na quoted TTL is refused by name, whatever the counts');
{
  const r = resolutionUsable({
    text: 'x',
    markers: 4,
    unresolved: 3,
    reasons: ['Entry not found (CCR TTL: 1800 seconds)'],
  });
  check(r.usable === false, '3 of 4 missing WITH a quoted TTL still refuses', r.detail);
  check(r.detail.includes('1800s TTL'), 'and quotes their own bound back', r.detail);
}

console.log('\nsome redeemed and some not IS a measurement');
{
  // Load-bearing in the other direction. If this refused, every genuine partial
  // loss of theirs would be excused as unmeasured and their retention column
  // would be flattered instead of ours.
  const r = resolutionUsable({ text: 'x', markers: 4, unresolved: 1, reasons: ['gone'] });
  check(r.usable === true, '3 of 4 redeemed is a store that answered', r.detail);
  check(r.detail.includes('3 of 4'), 'and the credit is reported', r.detail);
}

console.log('\nan unrecognised shape is unusable, not assumed good');
{
  check(resolutionUsable(null).usable === false, 'a missing entry');
  check(resolutionUsable(undefined).usable === false, 'an absent entry');
  check(resolutionUsable({ markers: 2, unresolved: 0 }).usable === false, 'no resolved text');
  check(
    resolutionUsable({ text: 'x', markers: 2, unresolved: 0, error: 'RuntimeError: boom' })
      .usable === false,
    'their resolver raised'
  );
  check(
    resolutionUsable({ text: 'x', markers: 'two', unresolved: 0 }).usable === false,
    'counts that are not numbers'
  );
}

console.log('\na partial miss is their answer only if we asked in time');
{
  const partial = { text: 'x', markers: 4, unresolved: 1, reasons: ['gone'] };
  // Their resolver quoted 1800s SOMEWHERE in this run, so the bound is known; this
  // row's own entries were older than it, so its misses are not evidence.
  const late = resolutionUsable(partial, {
    theirStatedTtlSeconds: 1800,
    entryAgeSeconds: { slow: 2400, quick: 30 },
  }, 'slow');
  check(late.usable === false, 'a row older than the stated TTL is unmeasured', late.detail);
  check(late.detail.includes('2400s'), 'and the age is named', late.detail);

  // THE DISCRIMINATING CASE, and the reason the age is per workload. The same run,
  // the same quoted bound, a row that was well inside it: refusing this one too
  // would throw away a measurement because a DIFFERENT row expired.
  const inTime = resolutionUsable(partial, {
    theirStatedTtlSeconds: 1800,
    entryAgeSeconds: { slow: 2400, quick: 30 },
  }, 'quick');
  check(inTime.usable === true, 'a row inside it is still a measurement', inTime.detail);

  // No per-workload stamp to be had, so the oldest entry in the sweep stands in.
  // That is the strict direction on purpose.
  const noStamps = resolutionUsable(partial, {
    theirStatedTtlSeconds: 1800,
    elapsedSecondsOldestEntry: 3600,
  }, 'quick');
  check(noStamps.usable === false, 'an old capture falls back to the oldest entry', noStamps.detail);
  check(noStamps.detail.includes('not this row'), 'and says whose age it used', noStamps.detail);

  // A CLOCK ALONE DOES NOT CONDEMN A ROW. With no TTL quoted anywhere their store
  // never refused anything, and our elapsed time is not evidence about their
  // durability -- the same reason the header gives for not hardcoding a bound.
  const noTtl = resolutionUsable(partial, { elapsedSecondsOldestEntry: 999999 }, 'quick');
  check(noTtl.usable === true, 'no quoted bound means no lateness verdict', noTtl.detail);
}

console.log('\nthe two artifacts on disk, which differ only in when we asked');
{
  // The whole file in one assertion pair: same capture, same corpus, same code,
  // resolved ~50 minutes apart. If these two ever score the same, the refusal
  // has stopped working.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '..', '..');
  const load = (dir) => {
    const p = path.join(root, dir, 'out', 'theirs-resolved.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  };
  const score = (set) => {
    let refused = 0;
    for (const [k, v] of Object.entries(set)) {
      if (k.startsWith('__')) continue;
      if (!resolutionUsable(v, set.__provenance__ ?? null).usable) refused += 1;
    }
    return refused;
  };
  const late = load('hr24');
  const prompt = load('hr25');
  if (late === null || prompt === null)
    console.log(
      'skip  the hr24/hr25 artifacts are not in this tree -- the synthetic cases above ' +
        'carry the rule; these two only witness that it fired on real captures'
    );
  else {
    check(score(late) === 7, 'the late resolution refuses its 7 marker-carrying rows', String(score(late)));
    check(score(prompt) === 0, 'the prompt one refuses nothing', String(score(prompt)));
  }
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
