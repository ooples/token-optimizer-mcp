/**
 * THE GATE THE TWELVE STORIES ARE WRITTEN AGAINST.
 *
 * Issue #435 defines the must-wins per workload and asks for a check that
 * decides them from the recorded results rather than from a reading of the
 * tables. This is that check.
 *
 * FOUR CRITERIA, NOT THE THREE #435 WAS FILED WITH. Round trips began as a
 * clause of the cost criterion and were split out on 2026-09-25, because the
 * cost model already prices every one of them and the clause was the sole
 * reason four rows that win at BOTH ends of the fetch rate were failing. What
 * a round trip costs beyond tokens is the wall clock, which is a different
 * claim and now has to carry itself.
 *
 * IT IS A RATCHET, NOT A WALL. Nine of the twelve rows fail at least one
 * must-win today, and a gate that failed the build for all of them would be
 * switched off within the week. So: every pair that passes is ENFORCED and can
 * never regress; every pair that fails is LISTED as an open must-win and does
 * not fail the build. The ratchet file records which is which, and the only way
 * a pair moves from open to enforced is a deliberate `--promote`.
 *
 * WHY A PASS CAN ALSO FAIL THE BUILD. An improvement that nobody records is an
 * improvement that can be silently undone. When a row starts passing a criterion
 * the ratchet has as open, this exits non-zero and says to promote it. That is a
 * one-line change to a JSON file, and it is the step that makes the ratchet
 * tighten instead of drift.
 *
 *   node bench/compression/must-win.check.mjs                  # check
 *   node bench/compression/must-win.check.mjs --promote        # record new passes
 *
 * NOTHING HERE RE-RUNS THE COMPRESSION. It reads
 * `headroom/results/head-to-head.json`, which `head-to-head.mjs --record`
 * writes, so the gate and the published numbers can never disagree.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { speedVerdict } from './speed-verdict.mjs';
import { degradationRefusal } from './competitor-health.mjs';
import { reproducibilityRefusal } from './reproducibility.mjs';
import { inputParity } from './input-parity.mjs';
import { retentionVerdict, tightenFloor } from './retention-floor.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(here, 'headroom', 'results', 'head-to-head.json');
const RATCHET = join(here, 'headroom', 'results', 'must-win.ratchet.json');
const promote = process.argv.includes('--promote');
// `--json` exists so anything that QUOTES these verdicts -- an issue body, a
// summary, a dashboard -- can read them from the judge instead of restating
// them by hand. A number copied by hand is a number that drifts.
const asJson = process.argv.includes('--json');

/**
 * PER-ROW CONFIGURATION, EACH LINE TRACEABLE TO THE ISSUE THAT APPROVED IT.
 *
 * `costFloor` is the one place the rows genuinely differ. On most of them a cost
 * win means strictly cheaper at both ends. On the four rows where their `p = 0`
 * hand-off is a 24-character content-cache reference -- 302, 468, 312 effective
 * tokens -- no encoder competes with that, and the 2026-09-25 decision on #435
 * is to match the mechanism and let `p > 0` decide. There `p = 0` may tie.
 *
 * `retention` is the bar from each story:
 *   'ceiling' -- their arm holds 100% of the identifiers, so the achievable form
 *                of "beat theirs" is to hold all of them too.
 *   a number  -- an explicit floor, from a story that traded retention for cost.
 *                It is a retained count, so it is capped at the units the
 *                payload actually holds; see `retention-floor.mjs`.
 *   null      -- not a must-win on this row; the ratchet still guards it.
 */
const ROWS = {
  'codebase-exploration': { issue: 436, costFloor: 'tie-at-p0', retention: 5 },
  'sre-debugging': { issue: 437, costFloor: 'tie-at-p0', retention: 89 },
  'agent-loop': { issue: 438, costFloor: 'strict', retention: null },
  'agent-loop-logs': { issue: 439, costFloor: 'strict', retention: 2043 },
  'grep-output': { issue: 440, costFloor: 'tie-at-p0', retention: 837 },
  'raw-build-log': { issue: 441, costFloor: 'tie-at-p0', retention: 344 },
  'relevance-probe': { issue: 442, costFloor: 'strict', retention: 'ceiling' },
  'code-search': { issue: 443, costFloor: 'strict', retention: 'ceiling' },
  'issue-triage': { issue: 444, costFloor: 'strict', retention: 'ceiling' },
  'human-authored-json': {
    issue: 445,
    costFloor: 'strict',
    retention: 'ceiling',
  },
  'repeated-reads': { issue: 446, costFloor: 'strict', retention: 'ceiling' },
  'browser-session': { issue: 447, costFloor: 'strict', retention: 'ceiling' },
};

const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * The four must-wins for one row, each as `{ pass, detail }`, with `pass: null`
 * when the inputs to decide it are not recorded. AN UNMEASURED CRITERION IS
 * NEVER A PASS -- that distinction is the whole reason speed is reported
 * separately instead of being quietly treated as satisfied.
 */
function judge(row, cfg, floors) {
  const c = row.cost;
  const p0o = num(c.session.p0.ours);
  const p0t = num(c.session.p0.theirs);
  const p1o = num(c.session.p1.ours);
  const p1t = num(c.session.p1.theirs);
  const turnsO = num(c.turns.ours);
  const turnsT = num(c.turns.theirs);

  // BOTH ENDPOINTS AND THE WORST POINT BETWEEN THEM. The endpoints alone used
  // to be the whole test, on the grounds that cost was affine in the fetch rate
  // and an arm ahead at 0% and 100% was ahead everywhere between. That stopped
  // being true when the model became quadratic: the round-pass re-reads a
  // prefix whose own blocks are only present with probability p, so two
  // independent p's multiply. A difference that opens upward has its minimum in
  // the MIDDLE, and an arm can lead at both ends while briefly trailing between
  // them -- exactly the shape a two-point gate is blind to.
  //
  // `worstAgainst` finds that point exactly (a parabola turns once, so the two
  // ends and the vertex decide the interval), and `head-to-head` records it.
  // Requiring it is what makes "cheaper at every fetch rate" a checked claim
  // rather than an inference from a linearity the model no longer has.
  //
  // A row recorded before that field existed cannot be judged on it, and an
  // unmeasured criterion is never a pass: it fails, and says why.
  //
  // Round trips used to be a clause here and are not any more: the fetch term
  // already charges each one for the extra pass over context and the tool call
  // the model writes, so requiring `turns` as well billed the same round trip
  // twice, and it was the only thing failing four rows that win both ends.
  const tie = cfg.costFloor === 'tie-at-p0';
  const p0ok = tie ? p0o <= p0t : p0o < p0t;
  const w = c.session.worst;
  const wo = w ? num(w.ours) : null;
  const wt = w ? num(w.theirs) : null;
  // The worst point is an endpoint whenever the difference is concave, and at
  // p=0 a tie-floor row is allowed to tie, so the worst clause honours the
  // same floor rather than contradicting it.
  const wok =
    w === undefined
      ? false
      : tie && Number(w.fetchRate) === 0
        ? wo <= wt
        : wo < wt;
  const cost = {
    pass: p0ok && p1o < p1t && wok,
    detail:
      `p0 ${p0o} ${tie ? '<=' : '<'} ${p0t} ${p0ok ? 'ok' : 'NO'}; ` +
      `p1 ${p1o} < ${p1t} ${p1o < p1t ? 'ok' : 'NO'}; ` +
      (w === undefined
        ? 'worst UNRECORDED (re-run head-to-head)'
        : `worst@${(Number(w.fetchRate) * 100).toFixed(0)}% ${wo} < ${wt} ${wok ? 'ok' : 'NO'}`),
  };

  // ITS OWN CRITERION, because what it measures is not tokens. The one real
  // cost of a round trip the model cannot see is the wall clock, and speed
  // times compression rather than retrieval, so nothing else here presses on
  // chattiness. Kept visible and scored separately so a row reads `cheaper but
  // chattier` in the open, instead of a win by moving five blocks out of the
  // request passing quietly as a win by compressing them.
  const turns = {
    pass: turnsO <= turnsT,
    detail: `${turnsO} round trip(s) vs ${turnsT}`,
  };

  const speed = speedVerdict({
    ourSamples: row.speed?.oursMsSamples,
    ourPasses: row.speed?.oursMsPasses,
    theirSamples: row.speed?.theirsMsSamples,
    theirPasses: row.speed?.theirsMsPasses,
    ms: num(row.speed?.oursMs),
    theirMs: num(row.speed?.theirsMs),
  });

  // THE RETENTION BAR AND ITS RATCHET LIVE IN THEIR OWN MODULE, because they
  // were decided here for months in units that belong to the instrument: an
  // absolute count of identifiers, whose denominator the scan defines. See
  // `retention-floor.mjs` for what that cost and what replaced it.
  const retention = retentionVerdict({
    ids: num(row.retention?.ids),
    ours: num(row.retention?.oursZeroTurn),
    theirs: num(row.retention?.theirsZeroTurn),
    story: cfg.retention,
    floor: floors[row.name],
  });

  // NONE OF THE FOUR IS A COMPARISON IF THE TWO COLUMNS WERE HANDED DIFFERENT
  // BYTES, so the precondition is checked once and collapses all four rather
  // than being argued per criterion: a ratio over a larger input is a larger
  // ratio, and a millisecond spent on more text is not a slower engine. It is
  // UNDECIDED and not failed, because the engine has done nothing wrong when the
  // harness measured two different things. `input-parity.mjs` holds the rest --
  // which of their arms see a wrapped input, why an absent field is undecided
  // rather than agreement, and why the digests outrank the flag beside them.
  const parity = inputParity(row.input);
  if (parity.ok !== true) {
    const undecided = { pass: null, detail: parity.detail };
    return {
      cost: undecided,
      turns: undecided,
      speed: undecided,
      retention: { ...undecided, lost: null },
    };
  }
  return { cost, turns, speed, retention };
}

const results = JSON.parse(readFileSync(RESULTS, 'utf8'));
const ratchet = existsSync(RATCHET)
  ? JSON.parse(readFileSync(RATCHET, 'utf8'))
  : {
      note: 'pairs recorded as passing; a pass here may never regress',
      enforced: {},
      // Retention is a count, not a yes/no, so the ratchet keeps the number as
      // well as the verdict. `--promote` only ever raises these.
      retentionFloors: {},
    };

const report = {};
const regressed = [];
const unverified = [];
const unpromoted = [];
const open = [];
const next = {};
const floors = { ...(ratchet.retentionFloors ?? {}) };
const nextFloors = { ...floors };

for (const row of results.workloads) {
  const cfg = ROWS[row.name];
  if (!cfg) continue;
  for (const [criterion, v] of Object.entries(judge(row, cfg, floors))) {
    // THE FLOOR IS THE FEWEST UNITS EVER LOST, not the most ever retained, and
    // it carries the denominator that count was taken over. A ratchet may only
    // tighten, which `tightenFloor` is responsible for.
    if (criterion === 'retention') {
      const next = tightenFloor(nextFloors[row.name], {
        ids: num(row.retention?.ids),
        lost: v.lost,
      });
      if (next === undefined) delete nextFloors[row.name];
      else nextFloors[row.name] = next;
    }
    const key = `${row.name}/${criterion}`;
    const was = ratchet.enforced?.[key] === true;
    (report[row.name] ??= { issue: cfg.issue })[criterion] = {
      pass: v.pass,
      detail: v.detail,
      enforced: was,
    };
    // A pair stays enforced once enforced, so a regression is reported on every
    // later run rather than only on the one that caused it.
    if (v.pass === true || was) next[key] = true;
    if (v.pass === true && !was) unpromoted.push(`${key} - ${v.detail}`);
    // AN ENFORCED PAIR THAT NO LONGER PASSES FAILS THE GATE EITHER WAY, but the
    // two ways are different facts and get reported as such. `false` means the
    // claim was tested and lost. `null` means this run could not test it -- and
    // saying "regressed" there is the same category error as publishing a
    // saturated fit's zero residual: it reports as a finding about the code
    // something that is only a fact about the measurement.
    if (v.pass === false && was) regressed.push(`${key} - ${v.detail} (was enforced)`);
    if (v.pass === null && was) unverified.push(`${key} - ${v.detail} (was enforced)`);
    if (v.pass === false && !was)
      open.push(`#${cfg.issue} ${key} - ${v.detail}`);
    if (v.pass === null && !was)
      open.push(`#${cfg.issue} ${key} - UNMEASURED: ${v.detail}`);
  }
}

if (promote) {
  const enforced = Object.fromEntries(
    Object.keys(next)
      .sort()
      .map((k) => [k, true])
  );
  writeFileSync(
    RATCHET,
    `${JSON.stringify({ ...ratchet, enforced, retentionFloors: nextFloors }, null, 2)}
`
  );
  console.log(`promoted ${Object.keys(enforced).length} pair(s) to ${RATCHET}`);
  process.exit(0);
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

// IS THE RECORD THESE VERDICTS CAME FROM RE-RUNNABLE BY ANYONE ELSE? Every
// line above compares the recorded figures against the ratchet, and not one of
// them asks whether the recording itself could be repeated. A record with no
// provenance can still pass every claim in the ratchet, and an outside reader
// has nothing to check it with.
//
// IT IS A BLOCKER AND NOT A FLIPPED CLAIM, deliberately. Marking all 53 pairs
// unverified because their provenance is thin would destroy the ratchet, which
// is the thing keeping the claims honest. The claims still stand on the numbers
// that were measured; what fails is the publication.
const notReproducible = reproducibilityRefusal(results.reproduction ?? null);
// AND THE SAME QUESTION ABOUT THE OTHER SIDE: was their engine whole when it
// was measured? Their optional paths fail soft, each one makes their output
// bigger, and a bigger output for them is a better number for us. So a capture
// that recorded a missing capability of theirs -- or that recorded nothing
// about it, which reads identically in the score -- cannot publish a win.
//
// A BLOCKER FOR THE SAME REASON as the one above: the claims stand on what was
// measured, and what fails is the publication of a comparison against an
// engine that was not all there.
const degraded = degradationRefusal(results.capture?.theirsProvenance ?? null);
const enforcedCount = Object.keys(ratchet.enforced ?? {}).length;
console.log(
  `must-win gate: ${enforcedCount} enforced, ${open.length} open, ` +
    `${regressed.length} regressed, ${unverified.length} unverified, ` +
    `${unpromoted.length} unrecorded pass(es)`
);
if (open.length)
  console.log(
    `\nOPEN MUST-WINS (not a build failure):\n  ${open.join('\n  ')}`
  );
if (unpromoted.length)
  console.log(
    '\nNEWLY PASSING - run with --promote so they can never regress:\n  ' +
      unpromoted.join('\n  ')
  );
if (unverified.length)
  console.log(
    `\nNOT MEASURED - these are enforced and this run could not test them:\n  ` +
      `${unverified.join('\n  ')}`
  );
if (regressed.length)
  console.error(
    `\nREGRESSED - these were enforced and now fail:\n  ${regressed.join('\n  ')}`
  );

if (degraded)
  console.log(
    `\nNOT A COMPARISON - their engine was not whole, or the capture did not say:\n  ` +
      degraded +
      `\n  Re-capture with run-theirs.py once their optional paths are available.`
  );
if (notReproducible)
  console.error(
    `\nNOT RE-RUNNABLE - the recorded run cannot be reproduced from what it wrote down:\n  ` +
      notReproducible +
      `\n  Re-record with head-to-head.mjs --record from a clean tree against a capture that carries it.`
  );

process.exit(
  degraded || notReproducible || regressed.length || unverified.length || unpromoted.length
    ? 1
    : 0
);
