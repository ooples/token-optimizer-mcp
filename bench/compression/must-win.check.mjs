/**
 * THE GATE THE TWELVE STORIES ARE WRITTEN AGAINST.
 *
 * Issue #435 defines the must-wins per workload and asks for a check that
 * decides them from the recorded results rather than from a reading of the
 * tables. This is that check.
 *
 * FIVE CRITERIA, NOT THE THREE #435 WAS FILED WITH. Round trips began as a
 * clause of the cost criterion and were split out on 2026-09-25, because the
 * cost model already prices every one of them and the clause was the sole
 * reason four rows that win at BOTH ends of the fetch rate were failing. What
 * a round trip costs beyond tokens is the wall clock, which is a different
 * claim and now has to carry itself.
 *
 * `latency` is where it carries itself: #435's must-win 2b, added 2026-09-29.
 * The `speed` criterion compares transform time, which is the whole wall clock
 * only for an arm that hands the agent everything it will need, and neither arm
 * does. So an arm can win `speed` by deferring work into retrievals nobody
 * timed. `latency` adds the retrievals -- a MEASURED per-fetch figure times the
 * round trips the arm forces -- and states the comparison at both ends of the
 * fetch rate: p=0 is `speed` exactly, and p=1 is where a deferred win shows up.
 * It is UNMEASURED on every row until a sweep and `resolve-theirs.py` run back
 * to back inside their TTL, because a store past its TTL answers every lookup
 * with a refusal and a refusal is fast. See `fetch-latency.mjs`.
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
import { latencyVerdict } from './fetch-latency.mjs';
import { degradationRefusal } from './competitor-health.mjs';
import { reproducibilityRefusal } from './reproducibility.mjs';
import { inputParity } from './input-parity.mjs';
import { retentionVerdict, tightenFloor } from './retention-floor.mjs';
import { bothColumns, columnsFor } from './arm-selection.mjs';
import { agreeAcrossRecordings } from './replicate-agreement.mjs';
import {
  instrumentFingerprint,
  inheritance,
  retractionMap,
  writeEntry,
} from './ratchet.mjs';
import { sideFromRecord } from './store-effect.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// WHICH RECORD IS BEING JUDGED. The canonical one by default; `--results <path>`
// exists so a SECOND capture of the same corpus can be judged without copying it
// over the canonical record first. That copy is the trap `theirsDigest` was added
// for -- a stale out-dir once reproduced a competitor column that had already been
// retracted, and nothing in the record showed it.
//
// A RUN OVER AN OVERRIDDEN RECORD MAY NOT PROMOTE. Promotion writes the ratchet
// that every later run inherits from, and the canonical record is what a reader can
// check those entries against; earning a pass from a record that is not published
// makes the entry unverifiable by exactly the person the ratchet exists for. So the
// two flags refuse to combine rather than quietly recording the wrong provenance.
const resultsFlag = process.argv.indexOf('--results');
const RESULTS =
  resultsFlag === -1
    ? join(here, 'headroom', 'results', 'head-to-head.json')
    : process.argv[resultsFlag + 1];
const RATCHET = join(here, 'headroom', 'results', 'must-win.ratchet.json');
// THE SECOND RECORDING. Produced by running head-to-head.mjs again against the
// same capture dir, at the same commit, in a fresh process:
//
//   node bench/compression/head-to-head.mjs hr27 --record //     bench/compression/headroom/results/head-to-head.replicate.json
//
// It exists so a speed verdict has to survive being measured twice. Absent, the
// speed criteria read NOT ENFORCEABLE rather than passing on one reading.
//
// `--replicate <path>` overrides it for the same reason `--results` exists, and it
// is the half that makes judging a second capture possible AT ALL for speed. The
// replicate path is otherwise fixed, so scoring a new capture's second recording
// into it would overwrite the published one -- and a speed pair whose two recordings
// come from different captures is refused by `disqualify` anyway, so without this
// flag every speed row of an unpublished capture reads NOT ENFORCEABLE no matter how
// many times it was measured.
const replicateFlag = process.argv.indexOf('--replicate');
const REPLICATE =
  replicateFlag === -1
    ? join(here, 'headroom', 'results', 'head-to-head.replicate.json')
    : process.argv[replicateFlag + 1];
const promote = process.argv.includes('--promote');
if (promote && (resultsFlag !== -1 || replicateFlag !== -1)) {
  console.error(
    'refusing to promote from --results/--replicate: the ratchet records what a reader can check ' +
      'against the published record, so a pass earned from another one is unverifiable. ' +
      'Publish the record first, then promote.'
  );
  process.exit(2);
}
if (resultsFlag !== -1 && (RESULTS === undefined || RESULTS.startsWith('--'))) {
  console.error('--results needs a path');
  process.exit(2);
}
if (
  replicateFlag !== -1 &&
  (REPLICATE === undefined || REPLICATE.startsWith('--'))
) {
  console.error('--replicate needs a path');
  process.exit(2);
}
// A REPLICATE FROM THE PUBLISHED RECORD AGAINST AN UNPUBLISHED ONE IS NOT A PAIR, and
// it is the mistake this flag makes easy to make. `disqualify` catches it by capture
// dir, but it catches it row by row as NOT ENFORCEABLE, which reads like a missing
// measurement rather than a mismatched one. Said plainly here instead.
if (resultsFlag !== -1 && replicateFlag === -1) {
  console.error(
    'warning: --results without --replicate judges this capture against the PUBLISHED ' +
      'replicate, so every speed row will read NOT ENFORCEABLE -- two captures are not two ' +
      'recordings of one. Record a second pass of the same capture dir and pass --replicate.'
  );
}
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
 * A CRITERION NO ISSUE CLAIMED IS NOT AN OPEN MUST-WIN, and counting it as one
 * puts a false entry on the board. #438 claims cost, speed and turns; its
 * recorded baseline shows retention as a LOSS on that row -- 69 units against
 * their 254 -- so no issue ever approved a retention bar for `agent-loop`, and
 * `retention: null` above says exactly that. Reported as open it read
 * `#438 agent-loop/retention - UNMEASURED: 185/185 - not a must-win here`, which
 * is a line telling the reader both that it is open work and that it is not.
 *
 * THE TEST READS THE CONFIGURATION, NEVER THE VERDICT TEXT. A criterion leaves
 * the board only because a `ROWS` entry declares it out of scope, so a row that
 * was genuinely unmeasurable -- readings missing, instrument degraded, two
 * recordings disagreeing -- can never reach this branch and slip off the board
 * quietly. Nothing here can turn into a pass either: an unclaimed criterion is
 * never promoted and never enforced.
 */
const outOfScope = (criterion, cfg) =>
  criterion === 'retention' && cfg.retention === null;

/**
 * The four must-wins for one row, each as `{ pass, detail }`, with `pass: null`
 * when the inputs to decide it are not recorded. AN UNMEASURED CRITERION IS
 * NEVER A PASS -- that distinction is the whole reason speed is reported
 * separately instead of being quietly treated as satisfied.
 */
/**
 * Why the comparable column cannot be decided on this row, or `null` when it
 * can. Three cases, kept apart because they are different facts:
 *   - the record predates the column -> re-run the scorer;
 *   - the record has no comparable arm -> no arm of theirs retained what we
 *     retained, which is a real and reportable outcome but NOT a win for us;
 *   - the row was fed different bytes from ours -> not a comparison at all.
 * Every one of them is UNDECIDED. None of them is agreement.
 */
function comparableRefusal(row) {
  if (row.comparable === undefined || row.comparable === null)
    return 'comparable arm UNRECORDED (re-run head-to-head)';
  if (row.comparable.arm === null || row.comparable.arm === undefined)
    return 'no comparable arm: ' + String(row.comparable.detail ?? 'no detail');
  if (row.input?.comparableSame === false)
    return `${row.comparable.arm} was handed different bytes from ours`;
  if (row.input?.comparableSame === undefined)
    return `${row.comparable.arm}: input parity UNRECORDED`;
  return null;
}

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
  const costBest = {
    pass: p0ok && p1o < p1t && wok,
    detail:
      `p0 ${p0o} ${tie ? '<=' : '<'} ${p0t} ${p0ok ? 'ok' : 'NO'}; ` +
      `p1 ${p1o} < ${p1t} ${p1o < p1t ? 'ok' : 'NO'}; ` +
      (w === undefined
        ? 'worst UNRECORDED (re-run head-to-head)'
        : `worst@${(Number(w.fetchRate) * 100).toFixed(0)}% ${wo} < ${wt} ${wok ? 'ok' : 'NO'}`),
  };

  // THE SAME THREE CLAUSES AGAINST THE COMPARABLE ARM. Their redeem tokens are
  // unmeasured and priced at zero, so every figure here is a LOWER bound on
  // their cost -- which can only make the bar harder for us, never easier, and
  // is why a one-sided bound is still decidable. It is labelled as a bound in
  // the detail so nobody reads it back as their measured total.
  const costComp = (() => {
    const why = comparableRefusal(row);
    if (why !== null) return { pass: null, detail: why };
    const arm = row.comparable.arm;
    const p0c = num(c.session.p0.theirsComparableAtLeast);
    const p1c = num(c.session.p1.theirsComparableAtLeast);
    const wc = c.session.worstComparable;
    if (p0c === null || p1c === null || wc === null || wc === undefined)
      return {
        pass: null,
        detail: `${arm}: cost UNRECORDED (re-run head-to-head)`,
      };
    const woc = num(wc.ours);
    const wtc = num(wc.theirsAtLeast);
    const p0okc = tie ? p0o <= p0c : p0o < p0c;
    const wokc = tie && Number(wc.fetchRate) === 0 ? woc <= wtc : woc < wtc;
    return {
      pass: p0okc && p1o < p1c && wokc,
      detail:
        `${arm} (their redeem priced at 0, a LOWER bound on their cost): ` +
        `p0 ${p0o} ${tie ? '<=' : '<'} ${p0c} ${p0okc ? 'ok' : 'NO'}; ` +
        `p1 ${p1o} < ${p1c} ${p1o < p1c ? 'ok' : 'NO'}; ` +
        `worst@${(Number(wc.fetchRate) * 100).toFixed(0)}% ` +
        `${woc} < ${wtc} ${wokc ? 'ok' : 'NO'}`,
    };
  })();

  // THE SECOND COLUMN, GATED SEPARATELY. `cost` above prices the block arm --
  // what `compressBlock` does to one block of text, which is the surface the MCP
  // tools apply. This prices `compressBody` -- the proxy arm, which rewrites an
  // actual request body, and is the surface an AI subscription is metered on.
  //
  // TWO COLUMNS RATHER THAN ONE, and the reason is that no user pays both. A
  // user on the MCP tools pays the block arm; a user behind the proxy pays the
  // proxy arm. A single column would have to either change arm between rows --
  // and then a reader cannot tell which engine produced a number -- or price
  // the worse of the two on every row, which prices a user who runs both
  // surfaces over the same payload and is billed for the more expensive result.
  // Nobody is billed that way, so the honest shape is two columns, each with its
  // own must-win, and neither borrowing the other's wins.
  //
  // The same three clauses apply, against the same two opponents, because the
  // question is identical: is a subscriber cheaper at every fetch rate. What
  // differs is only which of our arms is being asked.
  //
  // `pass: null` where the payload has no proxy arm at all. Four rows in this
  // corpus are arrays of log lines and API records with no `role` and no
  // `content`: there is no request body to rewrite, so the arm does not apply.
  // That is UNMEASURED, not a loss, and it is not a pass either.
  const proxyRefusal = (() => {
    if (c.session.p0.proxy === null || c.session.p0.proxy === undefined)
      return (
        'no proxy arm on this payload: it is not a message list, so there ' +
        'is no request body for the proxy to rewrite'
      );
    if (c.session.worstProxy === undefined)
      return 'proxy worst point UNRECORDED (re-run head-to-head)';
    return null;
  })();
  const px0 = num(c.session.p0.proxy);
  const px1 = num(c.session.p1.proxy);
  const proxyBest = (() => {
    if (proxyRefusal !== null) return { pass: null, detail: proxyRefusal };
    const wp = c.session.worstProxy;
    if (wp === null)
      return { pass: null, detail: 'proxy worst point UNRECORDED' };
    const wpo = num(wp.proxy);
    const wpt = num(wp.theirs);
    const p0okp = tie ? px0 <= p0t : px0 < p0t;
    const wokp = tie && Number(wp.fetchRate) === 0 ? wpo <= wpt : wpo < wpt;
    return {
      pass: p0okp && px1 < p1t && wokp,
      detail:
        `proxy arm: p0 ${px0} ${tie ? '<=' : '<'} ${p0t} ${p0okp ? 'ok' : 'NO'}; ` +
        `p1 ${px1} < ${p1t} ${px1 < p1t ? 'ok' : 'NO'}; ` +
        `worst@${(Number(wp.fetchRate) * 100).toFixed(0)}% ${wpo} < ${wpt} ${wokp ? 'ok' : 'NO'}`,
    };
  })();
  const proxyComp = (() => {
    if (proxyRefusal !== null) return { pass: null, detail: proxyRefusal };
    const why = comparableRefusal(row);
    if (why !== null) return { pass: null, detail: why };
    const arm = row.comparable.arm;
    const p0c = num(c.session.p0.theirsComparableAtLeast);
    const p1c = num(c.session.p1.theirsComparableAtLeast);
    const wc = c.session.worstProxyComparable;
    if (p0c === null || p1c === null || wc === null || wc === undefined)
      return {
        pass: null,
        detail: `${arm}: proxy-vs-comparable cost UNRECORDED (re-run head-to-head)`,
      };
    const woc = num(wc.proxy);
    const wtc = num(wc.theirsAtLeast);
    const p0okc = tie ? px0 <= p0c : px0 < p0c;
    const wokc = tie && Number(wc.fetchRate) === 0 ? woc <= wtc : woc < wtc;
    return {
      pass: p0okc && px1 < p1c && wokc,
      detail:
        `proxy arm vs ${arm} (their redeem priced at 0, a LOWER bound on their cost): ` +
        `p0 ${px0} ${tie ? '<=' : '<'} ${p0c} ${p0okc ? 'ok' : 'NO'}; ` +
        `p1 ${px1} < ${p1c} ${px1 < p1c ? 'ok' : 'NO'}; ` +
        `worst@${(Number(wc.fetchRate) * 100).toFixed(0)}% ` +
        `${woc} < ${wtc} ${wokc ? 'ok' : 'NO'}`,
    };
  })();

  // ITS OWN CRITERION, because what it measures is not tokens. The one real
  // cost of a round trip the model cannot see is the wall clock, and speed
  // times compression rather than retrieval, so nothing else here presses on
  // chattiness. Kept visible and scored separately so a row reads `cheaper but
  // chattier` in the open, instead of a win by moving five blocks out of the
  // request passing quietly as a win by compressing them.
  const turnsBest = {
    pass: turnsO <= turnsT,
    detail: `${turnsO} round trip(s) vs ${turnsT}`,
  };
  const turnsComp = (() => {
    const why = comparableRefusal(row);
    if (why !== null) return { pass: null, detail: why };
    const turnsC = num(c.turns.theirsComparable);
    if (turnsC === null)
      return {
        pass: null,
        detail: `${row.comparable.arm}: round trips UNRECORDED`,
      };
    return {
      pass: turnsO <= turnsC,
      detail: `${turnsO} round trip(s) vs ${turnsC} (${row.comparable.arm})`,
    };
  })();

  // NO LOAD CONTROL, NO SPEED VERDICT -- ON EITHER COLUMN.
  //
  // Their arms are timed by run-theirs.py in a Python process; ours by
  // head-to-head.mjs in a Node process, later. Two runs of that Node recording,
  // minutes apart against the same capture, moved our own medians by 33%
  // (grep-output) to 122% (agent-loop-logs) with no change to the code under
  // test. The three-pass jitter band saw none of it, because passes inside one
  // run share the ambient load: run one's passes were 25/22/22, tight and all
  // three equally contaminated.
  //
  // A drift that large is bigger than most of the margins this criterion
  // decides, so a cross-session comparison with no load control is decided by
  // the machine rather than by either engine. Both sides now spawn the same
  // calibration loop (bench/compression/load-witness.mjs) and record it; when
  // the two readings disagree, or when either is missing, the speed criterion is
  // UNDECIDED on both columns. That is the honest reading and it is not a pass:
  // `bothColumns` resolves an undecided column to undecided, and the gate counts
  // it under NOT MEASURED.
  const load = (() => {
    const v = row.speed?.loadWitness?.verdict;
    if (v === null || v === undefined)
      return {
        ok: false,
        detail:
          'no load witness on this row (recorded before the witness existed) -- ' +
          're-run run-theirs.py and head-to-head.mjs back to back',
      };
    return { ok: v.ok === true, detail: String(v.detail ?? 'no detail') };
  })();

  // THE BEST-OF-ANY SPEED COLUMN PAIRS MECHANISMS, MIRRORING WHAT COST DOES.
  // Their best-of-any arm reaches its ratio by writing a content-store key and
  // reads 3 to 15ms; it is not analysing the block at all. Judging our
  // COMPRESSING arm against that asks whether compression is slower than
  // hashing, which needs no benchmark. So this column judges our REFERENCING
  // arm -- `spillWholeBlockBelow` 1, the published `sub` arm, the same arm the
  // cost column's best-of-any opponent is priced against -- and the comparable
  // column below keeps our compressing arm against their non-offloading
  // `pipeline@*` arms. Both of our readings are in the record either way, so
  // this is a pairing rule, not a selection of the flattering number.
  //
  // A capture from before the second arm was timed has no `oursSubMs*`, and the
  // verdict is refused rather than silently falling back to the default arm:
  // that fallback is exactly the mismatched pairing this replaced.
  // TWO AGREEING RECORDINGS, OR THE SPEED PAIR IS NOT ENFORCEABLE. The rule and
  // the measurements that forced it live in replicate-agreement.mjs, which has
  // its own known-answer suite -- including the arm that proves a copied record
  // is rejected as a second recording.
  const mustAgreeAcrossRecordings = (judge) =>
    agreeAcrossRecordings({
      judge,
      primary: results,
      replicate: replicateFile,
      name: row.name,
    });

  const speedBestOf = (speed) => {
    if (load.ok === false) return { pass: null, detail: load.detail };
    if (!Array.isArray(speed?.oursSubMsPasses))
      return {
        pass: null,
        detail:
          'our referencing arm was not timed in this capture -- re-record with ' +
          'head-to-head.mjs so both arms of ours are measured in the same passes',
      };
    const v = speedVerdict({
      ourSamples: speed?.oursSubMsSamples,
      ourPasses: speed?.oursSubMsPasses,
      theirSamples: speed?.theirsMsSamples,
      theirPasses: speed?.theirsMsPasses,
      ms: num(speed?.oursSubMs),
      theirMs: num(speed?.theirsMs),
    });
    return {
      pass: v.pass,
      detail: `ours-movewhole vs ${speed?.theirsArm ?? 'unnamed'}: ${v.detail}`,
    };
  };
  const speedBest = mustAgreeAcrossRecordings(speedBestOf);
  // THE SAME ESTIMATOR ON THE COMPARABLE ARM, from the readings `run-theirs.py`
  // now takes for every arm. Reusing `speedVerdict` rather than writing a
  // second comparison is the point: a column judged by a softer test than the
  // one beside it is not a second bar, it is a loophole.
  // AND THE COMPARABLE COLUMN CARRIES THE SAME PAIRING RULE, because the arm it
  // opposes is selected by RETENTION, not by mechanism -- on two rows the arm
  // that retained what we retained is `crusher` with its content store switched
  // on (2 markers on browser-session, 1 on repeated-reads). Judging our
  // compressing arm against that is the mismatch the best-of-any column was just
  // fixed to avoid, so when the comparable arm offloads on this row, this column
  // judges our referencing arm too.
  //
  // The test is the arm's OWN output -- how many `<<ccr:...>>` markers it wrote
  // -- not a list of arm names, so an arm that offloads on one payload and not
  // another is read correctly on each. A capture recorded before that count
  // existed has `theirsComparableTurns === null` and keeps the default arm,
  // which is what it was measured as.
  const speedCompOf = (speed) => {
    if (load.ok === false) return { pass: null, detail: load.detail };
    const why = comparableRefusal(row);
    if (why !== null) return { pass: null, detail: why };
    const offloads = (speed?.theirsComparableTurns ?? 0) > 0;
    if (offloads && !Array.isArray(speed?.oursSubMsPasses))
      return {
        pass: null,
        detail:
          'their comparable arm offloads here and our referencing arm was not ' +
          'timed in this capture -- re-record with head-to-head.mjs',
      };
    const v = speedVerdict({
      ourSamples: offloads ? speed?.oursSubMsSamples : speed?.oursMsSamples,
      ourPasses: offloads ? speed?.oursSubMsPasses : speed?.oursMsPasses,
      theirSamples: speed?.theirsComparableMsSamples,
      theirPasses: speed?.theirsComparableMsPasses,
      ms: num(offloads ? speed?.oursSubMs : speed?.oursMs),
      theirMs: num(speed?.theirsComparableMs),
    });
    const arm = speed?.theirsComparableArm ?? row.comparable.arm;
    return {
      pass: v.pass,
      detail: offloads
        ? `ours-movewhole vs ${arm} (offloads here: ${speed?.theirsComparableTurns} marker(s)): ${v.detail}`
        : `ours-default vs ${arm}: ${v.detail}`,
    };
  };
  const speedComp = mustAgreeAcrossRecordings(speedCompOf);

  // MUST-WIN 2b, PAIRING THE SAME ARMS THE SPEED COLUMN PAIRS. The arm choice
  // here is not a new rule and deliberately is not: `ours-movewhole` against
  // their best-of-any, because that is the arm whose mechanism matches theirs,
  // and `ours-default` against their comparable arm unless that arm offloads.
  // Inventing a different pairing for the latency column would let the gate pick
  // whichever of our arms wins each claim.
  //
  // The load witness gates this exactly as it gates `speed`. A modelled session
  // millisecond is a sum of wall-clock readings, so if the two arms' readings do
  // not describe the same machine, neither does the sum.
  const latencyBestOf = (speed) => {
    if (load.ok === false) return { pass: null, detail: load.detail };
    const v = latencyVerdict({
      ourTransformPasses: speed?.oursSubMsPasses,
      theirTransformPasses: speed?.theirsMsPasses,
      ourTurns: num(row.cost?.turns?.oursSub),
      theirTurns: turnsT,
      ourFetch: speed?.oursSubFetch ?? null,
      theirFetch: speed?.theirsFetch ?? null,
    });
    return {
      pass: v.pass,
      detail: `ours-movewhole vs ${speed?.theirsArm ?? 'unnamed'}: ${v.detail}`,
    };
  };
  const latencyBest = mustAgreeAcrossRecordings(latencyBestOf);
  const latencyCompOf = (speed) => {
    if (load.ok === false) return { pass: null, detail: load.detail };
    const why = comparableRefusal(row);
    if (why !== null) return { pass: null, detail: why };
    const offloads = (speed?.theirsComparableTurns ?? 0) > 0;
    const v = latencyVerdict({
      ourTransformPasses: offloads
        ? speed?.oursSubMsPasses
        : speed?.oursMsPasses,
      theirTransformPasses: speed?.theirsComparableMsPasses,
      ourTurns: num(
        offloads ? row.cost?.turns?.oursSub : row.cost?.turns?.ours
      ),
      theirTurns: num(c.turns.theirsComparable),
      ourFetch: offloads ? (speed?.oursSubFetch ?? null) : null,
      // THEIR RETRIEVAL IS THEIR STORE WHICHEVER ARM WROTE THE MARKER, so the
      // one per-fetch figure `resolve-theirs.py` took serves both columns. An
      // arm that offloads nothing here needs no figure at all, and asking for a
      // per-arm one would refuse the column over a number that multiplies zero.
      theirFetch: speed?.theirsFetch ?? null,
    });
    const arm = speed?.theirsComparableArm ?? row.comparable.arm;
    return {
      pass: v.pass,
      detail: offloads
        ? `ours-movewhole vs ${arm} (offloads here: ${speed?.theirsComparableTurns} marker(s)): ${v.detail}`
        : `ours-default vs ${arm}: ${v.detail}`,
    };
  };
  const latencyComp = mustAgreeAcrossRecordings(latencyCompOf);
  const retentionBest = retentionVerdict({
    ids: num(row.retention?.ids),
    ours: num(row.retention?.oursZeroTurn),
    theirs: num(row.retention?.theirsZeroTurn),
    story: cfg.retention,
    floor: floors[row.name],
  });

  // RETENTION KEEPS ONE COLUMN, and `columnsFor` says so in code rather than
  // here in a comment, so the decision is something a mutant can flip and a
  // check can catch. The narrowing is not a concession: the comparable arm is
  // DEFINED as retaining at least what we retained, so a retention comparison
  // against it returns the same answer on every row, for every engine, forever.
  // Requiring it would turn eleven recorded passes into permanent losses while
  // measuring nothing about the code under test. This branch honours whatever
  // `columnsFor` returns, so flipping it changes the verdicts rather than
  // leaving a dead comment behind.
  const retCols = columnsFor('retention');
  let retention = retentionBest;
  if (retCols.columns.includes('comparable')) {
    const why = comparableRefusal(row);
    const rc =
      why !== null
        ? { pass: null, detail: why }
        : retentionVerdict({
            ids: num(row.retention?.ids),
            ours: num(row.retention?.oursZeroTurn),
            theirs: num(row.retention?.theirsComparableZeroTurn),
            story: cfg.retention,
            floor: floors[row.name],
          });
    retention = {
      ...bothColumns(retentionBest, rc),
      lost: retentionBest.lost ?? null,
    };
  }

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
      'cost-proxy': undecided,
      turns: undecided,
      speed: undecided,
      latency: undecided,
      retention: { ...undecided, lost: null },
    };
  }
  // WIN BOTH OR IT IS NOT A WIN. A decided loss on either column outranks an
  // undecided one -- a measurement that refutes the claim refutes it whatever
  // the other column says -- and a MISSING second column is undecided, never
  // agreement.
  return {
    cost: bothColumns(costBest, costComp),
    'cost-proxy': bothColumns(proxyBest, proxyComp),
    turns: bothColumns(turnsBest, turnsComp),
    speed: bothColumns(speedBest, speedComp),
    latency: bothColumns(latencyBest, latencyComp),
    retention,
  };
}

const results = JSON.parse(readFileSync(RESULTS, 'utf8'));
const replicateFile = existsSync(REPLICATE)
  ? JSON.parse(readFileSync(REPLICATE, 'utf8'))
  : null;
const ratchet = existsSync(RATCHET)
  ? JSON.parse(readFileSync(RATCHET, 'utf8'))
  : {
      note: 'pairs recorded as passing; a pass here may never regress',
      enforced: {},
      // Retention is a count, not a yes/no, so the ratchet keeps the number as
      // well as the verdict. `--promote` only ever raises these.
      retentionFloors: {},
    };

// THE INSTRUMENT THIS RUN MEASURED WITH, so that an entry recorded against a
// different one is not silently carried. See ratchet.mjs for the promotion this
// caught: five speed passes taken against their engine while its native
// detector was off and its model had not loaded.
const fingerprint = instrumentFingerprint(
  results.capture?.theirsProvenance ?? null
);

const report = {};
const regressed = [];
const stale = [];
const unverified = [];
const unpromoted = [];
const open = [];
const unclaimed = [];
const unclaimedKeys = [];
const next = {};
const retractions = {};
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
    // ENFORCED IS NOT THE SAME QUESTION AS INHERITABLE. An entry recorded from a
    // capture that said nothing about their engine's capabilities is a claim
    // whose instrument is unknown, and a pass may not be carried out of one.
    const carry = inheritance(ratchet.enforced?.[key], fingerprint);
    const was = carry.inherit;
    if (carry.reason !== null) stale.push(`${key} - ${carry.reason}`);
    (report[row.name] ??= { issue: cfg.issue })[criterion] = {
      pass: v.pass,
      detail: v.detail,
      enforced: was,
      staleReason: carry.reason,
      // So a consumer of --json can tell "no issue claims this" apart from "we
      // could not measure it", which the verdict text alone does not separate.
      claimed: !outOfScope(criterion, cfg),
    };
    // A pair stays enforced once enforced, so a regression is reported on every
    // later run rather than only on the one that caused it.
    if (v.pass === true)
      next[key] = writeEntry(results.capture?.dir ?? 'unrecorded', fingerprint);
    else if (was) next[key] = ratchet.enforced?.[key];
    // A CLAIM WHOSE INSTRUMENT IS UNKNOWN AND THAT DOES NOT PASS NOW IS RETRACTED,
    // in the file, with the verdict that replaced it. Deleting the key would
    // leave no trace that the claim was ever made.
    else if (carry.reason !== null)
      retractions[key] = {
        reason: carry.reason,
        verdict: v.detail,
        pass: v.pass,
      };
    if (v.pass === true && !was) unpromoted.push(`${key} - ${v.detail}`);
    // AN ENFORCED PAIR THAT NO LONGER PASSES FAILS THE GATE EITHER WAY, but the
    // two ways are different facts and get reported as such. `false` means the
    // claim was tested and lost. `null` means this run could not test it -- and
    // saying "regressed" there is the same category error as publishing a
    // saturated fit's zero residual: it reports as a finding about the code
    // something that is only a fact about the measurement.
    if (v.pass === false && was)
      regressed.push(`${key} - ${v.detail} (was enforced)`);
    if (v.pass === null && was)
      unverified.push(`${key} - ${v.detail} (was enforced)`);
    if (v.pass === false && !was)
      open.push(`#${cfg.issue} ${key} - ${v.detail}`);
    if (v.pass === null && !was && outOfScope(criterion, cfg)) {
      unclaimed.push(`#${cfg.issue} ${key} - ${v.detail}`);
      unclaimedKeys.push(key);
    } else if (v.pass === null && !was)
      open.push(`#${cfg.issue} ${key} - UNMEASURED: ${v.detail}`);
  }
}

/**
 * Passes that need THEIR store warm, which are not ours to enforce.
 *
 * `store-pair.check.mjs` refuses to let an enforced criterion depend on the
 * competitor's cache being warm, and it caught three the first time this gate
 * promoted a full set -- code-search/speed, code-search/latency and
 * sre-debugging/speed pass warm and fail the comparable arm from an empty
 * store. It caught them AFTERWARDS, with the ratchet already written, and the
 * only ways back were hand-editing a generated file or re-running against a
 * record chosen not to contain the pass.
 *
 * So the judgement moves to where the decision is made. These are reported and
 * NOT counted as unrecorded passes: a gate that demanded they be promoted
 * while promote withheld them could never go green, which is the deadlock the
 * first version of this created. They are also never retracted -- this only
 * withholds a promotion.
 *
 * THE DECISION IS PERSISTED IN THE RATCHET, not re-derived from a file beside
 * the results. The first version read the store-empty record as a sibling path
 * of whatever `--results` named, so a run against a copy elsewhere -- which is
 * exactly what tests/bench/must-win-exit-status.test.mjs does -- could not see
 * it, fell back to calling the three "newly passing", and failed. Where a pair
 * is enforceable is a fact about the pair, so it belongs with the other facts
 * about the pair.
 */
const warmOnly = [...(ratchet.warmOnly ?? [])].filter((key) =>
  unpromoted.some((line) => line.split(' - ')[0] === key)
);
for (const key of warmOnly)
  unpromoted.splice(
    unpromoted.findIndex((line) => line.split(' - ')[0] === key),
    1
  );
{
  const emptyPath = RESULTS.replace(/\.json$/, '.store-empty.json');
  const emptyReplicate = RESULTS.replace(
    /\.json$/,
    '.store-empty.replicate.json'
  );
  if (existsSync(emptyPath) && unpromoted.length > 0) {
    const side = sideFromRecord(
      'empty',
      emptyPath,
      existsSync(emptyReplicate) ? emptyReplicate : undefined
    );
    for (const line of [...unpromoted]) {
      const key = line.split(' - ')[0];
      const cut = key.lastIndexOf('/');
      const onEmpty =
        side.verdicts?.[key.slice(0, cut)]?.[key.slice(cut + 1)]?.pass ?? null;
      if (onEmpty !== true && !warmOnly.includes(key)) {
        warmOnly.push(key);
        unpromoted.splice(unpromoted.indexOf(line), 1);
      }
    }
  }
}

if (promote) {
  // PROMOTE MAY NOT RESOLVE A REGRESSION. A pair whose instrument matches and
  // whose claim lost is the one case the ratchet exists for, and re-recording
  // the file around it is exactly the relaxation it is meant to prevent.
  if (regressed.length) {
    console.error(
      `\nREFUSING TO PROMOTE - ${regressed.length} pair(s) were measured with this ` +
        `instrument and lost:\n  ${regressed.join('\n  ')}\n  Fix the code, or reopen ` +
        'the pair deliberately by hand.'
    );
    process.exit(1);
  }
  for (const key of warmOnly) delete next[key];
  const enforced = Object.fromEntries(
    Object.keys(next)
      .sort()
      .map((k) => [k, next[k]])
  );
  // `retractionMap` in ratchet.mjs, and ratchet.check.mjs for the cases.
  const retracted = retractionMap(
    ratchet.retracted,
    retractions,
    next,
    results.capture?.dir ?? 'unrecorded',
    fingerprint
  );
  writeFileSync(
    RATCHET,
    `${JSON.stringify(
      {
        ...ratchet,
        note: ratchet.note,
        enforced,
        retracted,
        // Reported every run, never enforced; see `warmOnly` above.
        warmOnly: [...warmOnly].sort(),
        retentionFloors: nextFloors,
      },
      null,
      2
    )}
`
  );
  console.log(
    `promoted ${Object.keys(enforced).length} pair(s) against ${fingerprint}, ` +
      `retracted ${Object.keys(retractions).length} to ${RATCHET}`
  );
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
// THE UNCLAIMED SET IS DERIVED TWICE, AND THE TWO DERIVATIONS MUST AGREE: once
// by the branch that routed each verdict, and once straight from `ROWS`. If a
// later edit widens `outOfScope`, or sends anything else down that branch, a
// criterion could leave the board without any issue having declined to claim it,
// and the board would then understate the open work while looking healthier. The
// check is one pass over a handful of strings, so there is no reason not to run
// it on every invocation rather than in a test that a future edit can forget.
const declaredUnclaimed = new Set(
  Object.entries(ROWS)
    .filter(([, cfg]) => cfg.retention === null)
    .map(([name]) => `${name}/retention`)
);
const undeclared = unclaimedKeys.filter((k) => !declaredUnclaimed.has(k));
if (undeclared.length)
  console.error(
    `\nBOARD IS WRONG - ${undeclared.length} criterion(s) left the board that no ` +
      `ROWS entry declares out of scope:\n  ${undeclared.join(`\n  `)}`
  );

// THE VERDICT IS ONE EXPRESSION AND EVERY MODE EXITS ON IT. --json used to
// print the report and exit zero whatever the report said, so a caller that ran
// the gate for its machine-readable output -- CI above all -- was told the run
// passed while that same report, in that same process, recorded an enforced
// pair regressing. A gate whose exit status does not depend on its own verdict
// is not a gate. The condition is named once here and read by both paths.
const failed =
  undeclared.length > 0 ||
  Boolean(degraded) ||
  Boolean(notReproducible) ||
  regressed.length > 0 ||
  stale.length > 0 ||
  unverified.length > 0 ||
  unpromoted.length > 0;

// PRINTED BEFORE THE EXIT AND NOT INSTEAD OF IT: a --json caller still gets the
// whole report on a failing run, which is what it needs in order to say what
// failed. Only the status changes.
if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(failed ? 1 : 0);
}

console.log(
  `must-win gate: ${enforcedCount} enforced, ${open.length} open, ` +
    `${regressed.length} regressed, ${stale.length} stale, ` +
    `${unverified.length} unverified, ${unpromoted.length} unrecorded pass(es), ` +
    `${unclaimed.length} unclaimed`
);
console.log(
  `capture: ${results.capture?.dir ?? 'unrecorded'}` +
    (resultsFlag === -1
      ? ''
      : ` (--results ${RESULTS}, not the published record)`) +
    ` | replicate: ${replicateFile?.capture?.dir ?? 'none'}` +
    (replicateFlag === -1 ? '' : ` (--replicate ${REPLICATE})`)
);
console.log(`instrument: ${fingerprint}`);
if (open.length)
  console.log(
    `\nOPEN MUST-WINS (not a build failure):\n  ${open.join('\n  ')}`
  );
if (unclaimed.length)
  console.log(
    `\nNOT CLAIMED BY ANY ISSUE - measured, reported, and not counted as open ` +
      `work:\n  ${unclaimed.join('\n  ')}`
  );
if (warmOnly.length)
  console.log(
    `\nPASSES ONLY FROM A WARM STORE - reported, and not enforceable:\n  ${warmOnly.join('\n  ')}\n  Their cache being warm is not a property of our code, so the ratchet does not take these.`
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

// NEITHER A PASS NOR A REGRESSION. The pair was recorded, the recording cannot
// be tied to an instrument, and this run's verdict -- whatever it is -- is the
// only one standing on measured provenance. Reported apart from a regression so
// a reader is never told the code changed when what changed was the measurement.
if (stale.length)
  console.error(
    `\nINSTRUMENT UNKNOWN - recorded passes that cannot be inherited:\n  ${stale.join('\n  ')}` +
      `\n  Re-earn them with --promote against this capture; each one that no longer ` +
      `passes is written to the ratchet as retracted, with the verdict that replaced it.`
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

process.exit(failed ? 1 : 0);
