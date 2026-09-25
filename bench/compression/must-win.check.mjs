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

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(here, 'headroom', 'results', 'head-to-head.json');
const RATCHET = join(here, 'headroom', 'results', 'must-win.ratchet.json');
const promote = process.argv.includes('--promote');

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

  // BOTH ENDPOINTS, AND NOTHING ELSE. Cost is affine in the fetch rate, so
  // an arm cheaper at p=0 and at p=1 is cheaper at every rate in between --
  // there is no third point to check. Round trips used to be a third clause
  // here and are not any more: `perFetch` already charges each one for the
  // extra pass over context and the 300 effective tokens of the tool call the
  // model writes, so requiring `turns` as well billed the same round trip
  // twice, and it was the only thing failing four rows that win both ends.
  const tie = cfg.costFloor === 'tie-at-p0';
  const p0ok = tie ? p0o <= p0t : p0o < p0t;
  const cost = {
    pass: p0ok && p1o < p1t,
    detail:
      `p0 ${p0o} ${tie ? '<=' : '<'} ${p0t} ${p0ok ? 'ok' : 'NO'}; ` +
      `p1 ${p1o} < ${p1t} ${p1o < p1t ? 'ok' : 'NO'}`,
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

  const ms = num(row.speed?.oursMs);
  const theirMs = num(row.speed?.theirsMs);
  const speed =
    theirMs === null
      ? { pass: null, detail: `ours ${ms}ms, theirs unmeasured` }
      : { pass: ms <= theirMs, detail: `${ms}ms vs ${theirMs}ms` };

  const ids = num(row.retention?.ids);
  const oursZt = num(row.retention?.oursZeroTurn);
  let retention;
  if (cfg.retention === null) {
    retention = { pass: null, detail: `${oursZt}/${ids} - not a must-win here` };
  } else if (ids === null) {
    retention = { pass: null, detail: 'ids not recorded' };
  } else {
    // THE STORY'S BAR OR TODAY'S SCORE, WHICHEVER IS HIGHER. Two of the floors
    // were set below a score that is already perfect -- `grep-output` holds all
    // 1,046 identifiers against a floor of 837, `raw-build-log` all 430 against
    // 344 -- so taking the bar literally would license giving up a fifth of a
    // perfect result. The recorded floor is what stops that.
    const stated = cfg.retention === 'ceiling' ? ids : cfg.retention;
    const bar = Math.max(stated, floors[row.name] ?? 0);
    const note =
      cfg.retention === 'ceiling'
        ? ' (their ceiling)'
        : bar > stated
          ? ` (story says ${stated}; ratcheted to ${bar})`
          : '';
    retention = {
      pass: oursZt >= bar,
      value: oursZt,
      detail: `${oursZt} of ${ids}, bar ${bar}${note}`,
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

const regressed = [];
const unpromoted = [];
const open = [];
const next = {};
const floors = { ...(ratchet.retentionFloors ?? {}) };
const nextFloors = { ...floors };

for (const row of results.workloads) {
  const cfg = ROWS[row.name];
  if (!cfg) continue;
  for (const [criterion, v] of Object.entries(judge(row, cfg, floors))) {
    if (criterion === 'retention' && typeof v.value === 'number')
      nextFloors[row.name] = Math.max(nextFloors[row.name] ?? 0, v.value);
    const key = `${row.name}/${criterion}`;
    const was = ratchet.enforced?.[key] === true;
    // A pair stays enforced once enforced, so a regression is reported on every
    // later run rather than only on the one that caused it.
    if (v.pass === true || was) next[key] = true;
    if (v.pass === true && !was) unpromoted.push(`${key} - ${v.detail}`);
    if (v.pass !== true && was)
      regressed.push(`${key} - ${v.detail} (was enforced)`);
    if (v.pass === false && !was) open.push(`#${cfg.issue} ${key} - ${v.detail}`);
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

const enforcedCount = Object.keys(ratchet.enforced ?? {}).length;
console.log(
  `must-win gate: ${enforcedCount} enforced, ${open.length} open, ` +
    `${regressed.length} regressed, ${unpromoted.length} unrecorded pass(es)`
);
if (open.length)
  console.log(`\nOPEN MUST-WINS (not a build failure):\n  ${open.join('\n  ')}`);
if (unpromoted.length)
  console.log(
    '\nNEWLY PASSING - run with --promote so they can never regress:\n  ' +
      unpromoted.join('\n  ')
  );
if (regressed.length)
  console.error(
    `\nREGRESSED - these were enforced and now fail:\n  ${regressed.join('\n  ')}`
  );

process.exit(regressed.length || unpromoted.length ? 1 : 0);
