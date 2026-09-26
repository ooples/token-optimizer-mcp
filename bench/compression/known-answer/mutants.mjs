/**
 * DOES THE KNOWN-ANSWER CHECK ACTUALLY CATCH A BROKEN INSTRUMENT?
 *
 * A check that passes tells you nothing about what it would refuse. Every green
 * run in this repository is evidence only if a deliberately broken instrument
 * turns it red, so this file breaks the instruments on purpose -- one defect at
 * a time, each one a defect this project has actually shipped, or one that would
 * move a published number without breaking anything visibly -- and reports how
 * many the checks caught.
 *
 * A SURVIVING MUTANT IS A HOLE IN A CHECK, not a curiosity. It means that exact
 * defect could be reintroduced tomorrow and every test would stay green. The
 * only legitimate response to a survivor is to ADD the missing assertion; the
 * score went 5/6 -> 6/6 that way once already, on the identifier floor.
 *
 * WHAT IS COVERED. Two chains, because two chains carry published numbers:
 *
 *   the scorer         head-to-head.mjs + retention.mjs, checked by
 *                      scorer.check.mjs against stub engines whose output is
 *                      known before the run
 *   the subscription   cost-split.mjs, base-context.mjs and the meter
 *     arithmetic       arithmetic in calibrate.mjs -- the chain that turns
 *                      tokens into "usage saved on a monthly plan", checked by
 *                      their own three .check.mjs files
 *
 * The second chain is here because it is the one the product claim rests on. Its
 * three checks all passed from the day they were written, which is exactly the
 * state the scorer check was in while it still had a hole in it.
 *
 * The mutation is textual and the original bytes are held in memory, restored in
 * a finally block, and verified by digest afterwards -- because a restore that
 * silently did not happen would leave the working tree broken and the next run
 * measuring a file nobody meant to change.
 *
 * TWO WAYS THIS SCORE CAN BE A FICTION, both of which happened before they were
 * guarded, and both of which report a PERFECT score rather than an error.
 *
 *   two runs at once   Each process snapshots the instruments, mutates them and
 *                      restores its own snapshot. Run two and the second
 *                      snapshots a file the first has mutated, calls those bytes
 *                      the original, and restores the tree to them on the way
 *                      out -- leaving a mutant sitting in the working copy while
 *                      the digest check passes, because that digest is taken
 *                      inside the same process. A lock file is the fix, and
 *                      refusing is the only safe behaviour: a battery that
 *                      queued would still be editing files the other one reads.
 *
 *   a poisoned         If an instrument is ALREADY broken when the run starts,
 *   baseline           its check is already red, so every mutant against it
 *                      "fails the check" and is scored as caught. That is how a
 *                      tree left mutated by the clobber above reported 46/46.
 *                      So each distinct check runs once unmutated first and must
 *                      pass: the control arm, without which a caught mutant is
 *                      not evidence of anything.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const comp = (...p) => join(REPO, 'bench', 'compression', ...p);
const sub = (...p) => join(REPO, 'bench', 'subscription', ...p);

const H2H = comp('head-to-head.mjs');
const RET = comp('retention.mjs');
const SPLIT = sub('cost-split.mjs');
const BASE = sub('base-context.mjs');
const METER = sub('calibrate.mjs');
const SPEED = comp('speed-verdict.mjs');
const REPRO = comp('reproducibility.mjs');
const HEALTH = comp('competitor-health.mjs');
const IDS = comp('identifiers.mjs');
const FLOOR = comp('retention-floor.mjs');
const PARITY = comp('input-parity.mjs');
const ARM = comp('arm-selection.mjs');

/** The check that is supposed to refuse each defect. */
const SCORER = join(HERE, 'scorer.check.mjs');
const SPLIT_CHECK = sub('cost-split.check.mjs');
const BASE_CHECK = sub('base-context.check.mjs');
const METER_CHECK = sub('calibrate.check.mjs');
const SPEED_CHECK = comp('speed-verdict.check.mjs');
const REPRO_CHECK = comp('reproducibility.check.mjs');
const HEALTH_CHECK = comp('competitor-health.check.mjs');
const IDS_CHECK = comp('identifiers.check.mjs');
const FLOOR_CHECK = comp('retention-floor.check.mjs');
const PARITY_CHECK = comp('input-parity.check.mjs');
const ARM_CHECK = comp('arm-selection.check.mjs');

const digest = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/**
 * Each mutant names the defect it reintroduces, the check that should refuse it,
 * and the property inside that check which does the refusing. `file` and the
 * from/to pair must match exactly once, or the mutant is reported as STALE
 * rather than silently doing nothing -- a mutant that fails to apply is the most
 * dangerous kind, because it counts as caught.
 */
const MUTANTS = [
  {
    name: 'retention denominator is the raw scrape again',
    defect: 'the buckets were counted over the safe subset and printed beside a larger set',
    caughtBy: 'the buckets must close, and the denominator is enumerated by name',
    file: H2H,
    check: SCORER,
    from: 'const { want, unsafeIds } = splitScorable(scan.units);',
    to: 'const { unsafeIds } = splitScorable(scan.units);\n  const want = scan.units;',
  },
  {
    name: 'a sinkless arm reports a measured zero',
    defect: 'inSpill read 0 on every workload because the branch could not fire',
    caughtBy: 'identity: the sinkless headline arm reports null',
    file: RET,
    check: SCORER,
    from: 'inSpill: hasSink ? inSpill : null,',
    to: 'inSpill,',
  },
  {
    name: 'their token column is estimated, ours is tokenised',
    defect: 'their own counter is len(text) // 4; using it for one side only biases every ratio',
    caughtBy: 'mirror: the same bytes must score the same token saving',
    file: H2H,
    check: SCORER,
    from: 'const theirAfter = tokens(t.bestText ?? text);',
    to: 'const theirAfter = Math.max(1, Math.floor((t.bestText ?? text).length / 4));',
  },
  {
    name: 'our denominator is taken after the envelope, theirs before',
    defect: 'the base = len(text) escape layer 1 found, in the other column',
    caughtBy: 'mirror: the same bytes must score the same size saving',
    file: H2H,
    check: SCORER,
    from: 'ours: 1 - after / before,',
    to: 'ours: 1 - after / (before + 1),',
  },
  {
    name: 'a short identifier is scored by substring after all',
    defect: 'a three-character id matches by accident and lands in inOut as a free pass',
    caughtBy: 'identity: the denominator is the set that was actually scored',
    file: RET,
    check: SCORER,
    from: 'const MIN_ID_LEN = 8;',
    to: 'const MIN_ID_LEN = 1;',
  },
  {
    name: 'identifiers found in the payload rather than the output',
    defect: 'scoring retention against the input always reports perfect retention',
    caughtBy: 'lossy: exactly DROP identifiers must have left the context',
    file: RET,
    check: SCORER,
    from: 'if (output.includes(id)) inOut++;',
    to: 'inOut++;',
  },
  {
    name: 'a cache read billed at the full input rate',
    defect: 'cacheRead priced at 1.0 instead of 0.1, so cached traffic costs 10x',
    caughtBy: 'cost-split: ten cache reads cost one plain input token',
    file: SPLIT,
    check: SPLIT_CHECK,
    from: 'read: t.cacheRead * rates.cacheRead,',
    to: 'read: t.cacheRead,',
  },
  {
    name: 'output billed as input',
    defect: 'output priced at 1x rather than 5x, understating the output share',
    caughtBy: 'cost-split: each priced quantity converts at its own published rate',
    file: SPLIT,
    check: SPLIT_CHECK,
    from: 'output: t.output * rates.outputPerInput,',
    to: 'output: t.output,',
  },
  {
    name: 'both cache TTLs charged at the 5-minute rate',
    defect: '1-hour writes billed at 1.25 instead of 2.0',
    caughtBy: 'cost-split: each priced quantity converts at its own published rate',
    file: SPLIT,
    check: SPLIT_CHECK,
    from: 'write: t.cacheWrite5m * rates.cacheWrite5m + t.cacheWrite1h * rates.cacheWrite1h,',
    to: 'write: (t.cacheWrite5m + t.cacheWrite1h) * rates.cacheWrite5m,',
  },
  {
    name: 'turnsAfter divided by the 5-minute writes alone',
    defect: 'the denominator drops 1-hour writes, inflating turnsAfter and every saving with it',
    caughtBy: 'cost-split: both write TTLs count as writes',
    file: SPLIT,
    check: SPLIT_CHECK,
    from: 'return totals.cacheRead / written;',
    to: 'return totals.cacheRead / totals.cacheWrite5m;',
  },
  {
    name: 'no traffic reported as a measured zero',
    defect: 'an empty window returns turnsAfter 0 instead of null, so unmeasured reads as settled',
    caughtBy: 'cost-split: no writes gives null, not zero and not Infinity',
    file: SPLIT,
    check: SPLIT_CHECK,
    from: 'if (written === 0) return null;',
    to: 'if (written === 0) return 0;',
  },
  {
    name: 'one session is enough to quote a base context',
    defect: 'the readiness gate drops to a single session, so an unmeasured constant prints',
    caughtBy: 'base-context: fewer than 5 sessions is not a measurement',
    file: BASE,
    check: BASE_CHECK,
    from: 'export const MIN_SESSIONS = 5;',
    to: 'export const MIN_SESSIONS = 1;',
  },
  {
    name: 'a zero-token prefix counted as a small session',
    defect: 'sessions with no usage drag the median down, understating the base and inflating savings',
    caughtBy: 'base-context: a zero-token prefix is dropped, not counted as a small session',
    file: BASE,
    check: BASE_CHECK,
    from: '    .filter((s) => s.tokens > 0);',
    to: '    .filter((s) => s.tokens >= 0);',
  },
  {
    name: 'first request seen instead of first request stamped',
    defect: 'transcript order decides the prefix, so a later request can define the session base',
    caughtBy: 'base-context: the earliest request of a session is the prefix',
    file: BASE,
    check: BASE_CHECK,
    from: 'if (!held || r.at < held.at) first.set(r.sessionId, r);',
    to: 'if (!held) first.set(r.sessionId, r);',
  },
  {
    name: 'spread taken over the maximum rather than the median',
    defect: 'the reported spread shrinks, so a volatile environment looks settled',
    caughtBy: 'base-context: the spread is the range over the median',
    file: BASE,
    check: BASE_CHECK,
    from: 'spread: median ? (sorted[sorted.length - 1] - sorted[0]) / median : null,',
    to: 'spread: median ? (sorted[sorted.length - 1] - sorted[0]) / sorted[sorted.length - 1] : null,',
  },
  {
    name: 'every metered kind priced at 1x',
    defect: 'rowCost ignores the rate table, so the cap bracket is in the wrong unit entirely',
    caughtBy: 'calibrate: a mixed row prices at the published rates',
    file: METER,
    check: METER_CHECK,
    from: '    cost += rate * tokens;',
    to: '    cost += tokens;',
  },
  {
    name: 'an unbounded cap given a floor anyway',
    defect: 'a saving with no upper bound on the cap still prints a floor, which is the half a claim needs',
    caughtBy: 'calibrate: an unbounded cap leaves a saving with no floor',
    file: METER,
    check: METER_CHECK,
    from: '  const floor = Number.isFinite(bracket.hi) ? (100 * tokens) / bracket.hi : 0;',
    to: '  const floor = Number.isFinite(bracket.hi) ? (100 * tokens) / bracket.hi : 1;',
  },
  {
    name: 'a meter delta of 1 clears the weekly bar',
    defect: 'a one-point delta bounds the cap from below only, so the weekly claim gets a ceiling and no floor',
    caughtBy: 'calibrate: deltas of 1 do not clear the bar, however many there are',
    file: METER,
    check: METER_CHECK,
    from: '  const qualifying = rows.filter((r) => r.y >= 2);',
    to: '  const qualifying = rows.filter((r) => r.y >= 1);',
  },
  {
    name: 'their passes pooled instead of reduced pass by pass',
    defect:
      'the asymmetry this file was extended for: their side back to one p10 over every reading, so a contaminated pass of theirs is no longer discarded',
    caughtBy: 'speed-verdict: a contaminated minority of their passes is discarded, not pooled',
    file: SPEED,
    check: SPEED_CHECK,
    from: '  const theirFast = quantile(theirPerPass, 0.5);',
    to: '  const theirFast = quantile(theirSamples, 0.1);',
  },
  {
    name: 'one pass on their side decides the row anyway',
    defect:
      'the refusal covered our side only, which is the state that shipped: their between-run spread assumed away while ours was measured',
    caughtBy: 'speed-verdict: one pass on their side cannot decide it either, and the refusal says whose',
    file: SPEED,
    check: SPEED_CHECK,
    from: '  theirPasses.length < 2',
    to: '  theirPasses.length < 1',
  },
  {
    name: 'the refusal names the wrong side',
    defect:
      'a refusal that misreports which column is short sends the next capture to re-measure the wrong arm',
    caughtBy: 'speed-verdict: one pass on their side cannot decide it either, and the refusal says whose',
    file: SPEED,
    check: SPEED_CHECK,
    from: "    Array.isArray(theirPasses) && theirPasses.length >= 2 ? null : 'theirs',",
    to: "    Array.isArray(theirPasses) && theirPasses.length >= 2 ? null : 'ours',",
  },
  {
    name: 'our within-pass median stands in for our p90',
    defect:
      'the bar softened to median-against-p10, which hands us every row we win only while the machine is quiet',
    caughtBy: 'speed-verdict: our spikes count against us',
    file: SPEED,
    check: SPEED_CHECK,
    from: '  const perPass = ourPasses.map((xs) => quantile(xs, 0.9));',
    to: '  const perPass = ourPasses.map((xs) => quantile(xs, 0.5));',
  },
  {
    name: 'an unmeasured competitor reads as a pass',
    defect:
      'the third verdict state collapsed into a pass, so a row nobody timed on their side is published as our win',
    caughtBy: 'speed-verdict: an unmeasured competitor is not a win',
    file: SPEED,
    check: SPEED_CHECK,
    from: '  return { pass: null, detail: `ours ${ms}ms, theirs unmeasured` };',
    to: '  return { pass: true, detail: `ours ${ms}ms, theirs unmeasured` };',
  },
  {
    name: 'a truncated sha passes as a commit',
    defect:
      'a sha that lost characters to a double slice still names a commit, and the record reads as stamped',
    caughtBy: 'reproducibility: commit as a 39-character sha is refused',
    file: REPRO,
    check: REPRO_CHECK,
    from: 'const SHA40 = /^[0-9a-f]{40}$/;',
    to: 'const SHA40 = /^[0-9a-f]+$/;',
  },
  {
    name: 'a modified tree stops being a refusal',
    defect:
      'the one field whose honest value is a refusal turned into a field that is merely present',
    caughtBy: 'reproducibility: a record from a modified tree is refused, and the reason says why the sha is not enough',
    file: REPRO,
    check: REPRO_CHECK,
    from: '  if (prov.dirty === true) {',
    to: "  if (prov.dirty === 'modified') {",
  },
  {
    name: 'one pass clears the reproduction bar',
    defect:
      'the bar that makes a speed verdict decidable lowered to a single pass, which is the capture that shipped',
    caughtBy: 'reproducibility: one pass on their side is refused, and the refusal names their side',
    file: REPRO,
    check: REPRO_CHECK,
    from: '      if (!Number.isInteger(n) || n < MIN_PASSES) {',
    to: '      if (!Number.isInteger(n) || n < 1) {',
  },
  {
    name: 'only the first problem is reported',
    defect:
      'eight deficiencies reported one at a time, at one capture run each, while the count says eight',
    caughtBy: 'reproducibility: five problems are reported as five, not as the first one',
    file: REPRO,
    check: REPRO_CHECK,
    from: "  return `${problems.length} thing(s) stop this record being re-runnable: ` + problems.join('; ');",
    to: '  return `${problems.length} thing(s) stop this record being re-runnable: ` + problems[0];',
  },
  {
    name: 'their digest drops out of the required set',
    defect:
      'the field that catches a stale out-dir quietly stops being required, and the per-field loop stops asking for it too',
    caughtBy: 'reproducibility: the required set is exactly the 8 fields a re-run needs',
    file: REPRO,
    check: REPRO_CHECK,
    from: "  theirsDigest: { look: HEX16, says: 'sha256 of their output, first 16' },",
    to: '  // theirsDigest: no longer required',
  },
  {
    name: 'a field that is present and unusable passes',
    defect:
      'an empty digest and the literal sentinel for a failed git call read as recorded, which is how both reached a published record',
    caughtBy: 'reproducibility: payloadsDigest as an empty string is refused',
    file: REPRO,
    check: REPRO_CHECK,
    from: "    } else if (typeof value !== 'string' || !look.test(value)) {",
    to: "    } else if (typeof value !== 'string') {",
  },
  {
    name: 'a capture that never recorded warnings reads as whole',
    defect:
      'the check for whether degradation was recorded at all removed, so every capture taken before the recording existed passes as a clean comparison',
    caughtBy: 'competitor-health: a provenance with no competitorWarnings key is refused as not having said',
    file: HEALTH,
    check: HEALTH_CHECK,
    from: "  if (!('competitorWarnings' in provenance)) {",
    to: '  if (false) {',
  },
  {
    name: 'the capture certifies its own allow-list',
    defect:
      'the gate stops recognising advisory messages independently, so widening the list in run-theirs.py would wave any degradation through',
    caughtBy: 'competitor-health: an advisory this gate does not recognise is refused',
    file: HEALTH,
    check: HEALTH_CHECK,
    from: '    } else if (!ADVISORY_SIGNATURES.some((signature) => entry.message.includes(signature))) {',
    to: '    } else if (false) {',
  },
  {
    name: 'a zero-count warning reads as a real entry',
    defect:
      'an entry whose count is 0 or fractional accepted as readable, which is a degradation that can be written down and not counted',
    caughtBy: 'competitor-health: an entry with count 0 is refused as unreadable',
    file: HEALTH,
    check: HEALTH_CHECK,
    from: '  entry.count >= 1;',
    to: '  entry.count >= 0;',
  },
  {
    name: 'recorded degradations are not read',
    defect:
      'the degraded list walked as empty, so a Kompress model that never loaded is recorded and then ignored',
    caughtBy: 'competitor-health: a recorded degradation is refused, named and counted',
    file: HEALTH,
    check: HEALTH_CHECK,
    from: '  for (const entry of seen.degraded) {',
    to: '  for (const entry of []) {',
  },
  {
    name: 'an unreadable warnings block reads as empty',
    defect:
      'the shape check dropped, so competitorWarnings of {} passes and nothing is ever refused again',
    caughtBy: 'competitor-health: a block that is not two arrays is refused as unreadable',
    file: HEALTH,
    check: HEALTH_CHECK,
    from: '    !Array.isArray(seen.degraded) ||',
    to: '    false ||',
  },
  {
    name: 'the quoted-run scan loses its parity again',
    defect:
      'a length bound inside the pattern makes the scan skip short runs and pair every closing quote with the next opening one, capturing `: 2345, ` instead of `user_id`',
    caughtBy: 'identifiers: the separator between two keys is not a unit',
    file: IDS,
    check: IDS_CHECK,
    from: 'export const QUOTED_RUN = /"([^"\\n]*)"/g;',
    to: 'export const QUOTED_RUN = /"([^"\\n]{5,120})"/g;',
  },
  {
    name: 'units that are not in their own payload are admitted',
    defect:
      '283 of 14,067 units were not substrings of the payload they came from, so no arm could be credited with keeping them and every loss column carried them',
    caughtBy: 'identifiers: every admitted unit is a literal substring of the payload',
    file: IDS,
    check: IDS_CHECK,
    from: '    if (!text.includes(unit)) {',
    to: '    if (false) {',
  },
  {
    name: 'a phantom is dropped without being counted',
    defect:
      'the denominator narrows and nothing says by how much, which is the silent version of the same defect',
    caughtBy: 'identifiers: and every dropped one really was not a substring',
    file: IDS,
    check: IDS_CHECK,
    from: '      phantoms.push(unit);',
    to: '      void unit;',
  },
  {
    name: 'the identifier floor is lowered again',
    defect:
      'a four-character unit is found by `includes` anywhere, so admitting one inflates every arm at once',
    caughtBy: 'identifiers: four characters is below the floor and excluded',
    file: IDS,
    check: IDS_CHECK,
    from: '      if (inner.length >= MIN_SYMBOL && inner.length <= MAX_UNIT) into.add(inner);',
    to: '      if (inner.length >= 1 && inner.length <= MAX_UNIT) into.add(inner);',
  },
  {
    name: 'the unit ceiling is removed',
    defect:
      'a whole paragraph admitted as one identifier, which makes a single elision read as a single lost unit',
    caughtBy: 'identifiers: 121 characters is over the ceiling and excluded',
    file: IDS,
    check: IDS_CHECK,
    from: '      if (inner.length >= MIN_SYMBOL && inner.length <= MAX_UNIT) into.add(inner);\n    }',
    to: '      if (inner.length >= MIN_SYMBOL) into.add(inner);\n    }',
  },
  {
    name: 'the dropped-unit count is recorded as a constant zero',
    defect:
      'a published record whose denominator narrowed with nothing saying it had',
    caughtBy: 'scorer: the record says how many were dropped',
    file: H2H,
    check: SCORER,
    from: 'phantomIds: String(r.phantoms),',
    to: "phantomIds: '0',",
  },
  {
    name: 'the story bar is not capped at the denominator',
    defect:
      'nine rows reported a retention regression while holding every unit available to them',
    caughtBy: 'retention floor: the wider denominator passes, the story bar capped',
    file: FLOOR,
    check: FLOOR_CHECK,
    from: "  const bar = story === 'ceiling' ? ids : Math.min(story, ids);",
    to: "  const bar = story === 'ceiling' ? ids : story;",
  },
  {
    name: 'the loss ratchet is removed',
    defect:
      'a perfect row could give up a fifth of its identifiers and still clear a low story bar',
    caughtBy: 'retention floor: one unit lost against a recorded zero fails',
    file: FLOOR,
    check: FLOOR_CHECK,
    from: '  const lostOk = lostBar === null || lost <= lostBar;',
    to: '  const lostOk = true;',
  },
  {
    name: 'a floor with no denominator is compared anyway',
    defect:
      'a bar in units the instrument no longer uses, read as a fact about the engine',
    caughtBy: 'retention floor: a floor with no denominator is refused, not compared',
    file: FLOOR,
    check: FLOOR_CHECK,
    from: "  if (typeof floor === 'number')",
    to: '  if (false)',
  },
  {
    name: 'an empty denominator counts as a perfect score',
    defect:
      'the "0 for us, 0 for them" tie this project published once, restored',
    caughtBy: 'retention floor: an empty denominator is not a perfect score',
    file: FLOOR,
    check: FLOOR_CHECK,
    from: '  if (ids === 0)',
    to: '  if (false)',
  },
  {
    name: 'the ceiling label is not checked against their column',
    defect:
      'a bar named for their ceiling still called that after their column fell below it',
    caughtBy: 'retention floor: a bar named for their ceiling is refused once their column leaves it',
    file: FLOOR,
    check: FLOOR_CHECK,
    from: "  if (story === 'ceiling' && theirs !== ids)",
    to: '  if (false)',
  },
  {
    name: 'the ratchet loosens on a worse run',
    defect:
      'a floor that follows the latest run downward, which is no ratchet at all',
    caughtBy: 'retention floor: a worse run never loosens the floor',
    file: FLOOR,
    check: FLOOR_CHECK,
    from: '  if (had !== null && had <= lost) return floor;',
    to: '  if (false) return floor;',
  },
  {
    name: 'the missing parity field is read as agreement',
    defect:
      'a capture from before the precondition existed, scored as though it had been met',
    caughtBy: 'input parity: an absent parity field is undecided',
    file: PARITY,
    check: PARITY_CHECK,
    from: '  if (input === null || input === undefined)',
    to: '  if (false)',
  },
  {
    name: 'the recorded flag outranks the digests it was written beside',
    defect:
      'one bug in the recorder, and every row vouches for its own comparability',
    caughtBy: 'input parity: a flag that claims agreement cannot override the digests',
    file: PARITY,
    check: PARITY_CHECK,
    from: '  const agree = ours === theirs;',
    to: '  const agree = input.same === true || ours === theirs;',
  },
  {
    name: 'a wrapped input on their side is called a comparison',
    defect:
      'a ratio taken over an input 15% larger than ours, published as like-for-like',
    caughtBy: 'input parity: a wrapped input on their side is not a comparison',
    file: PARITY,
    check: PARITY_CHECK,
    from: '  if (agree) return { ok: true, detail:',
    to: '  if (true) return { ok: true, detail:',
  },
  {
    name: 'a half-recorded row is compared against nothing',
    defect:
      'a row with one digest missing, decided by comparing a string with null',
    caughtBy: 'input parity: one digest missing is undecided too',
    file: PARITY,
    check: PARITY_CHECK,
    from: '  if (ours === null || theirs === null)',
    to: '  if (false)',
  },
  {
    name: 'a record that contradicts itself is resolved rather than refused',
    defect:
      'the flag and the digests disagree, and the gate picks the flattering one',
    caughtBy: 'input parity: digests that agree under a flag that says they do not',
    file: PARITY,
    check: PARITY_CHECK,
    from: '  if (typeof input.same === ',
    to: '  if (false && typeof input.same === ',
  },

  // WHICH OF THEIR ARMS EVERY CLAIM IS MEASURED AGAINST. An instrument with no
  // mutants is untested, and this one decides the opponent for cost, speed and
  // round trips on every row -- so each way it could quietly substitute an
  // easier bar gets an entry.
  {
    name: 'comparable means strictly more retained, not at least as much',
    defect:
      'an arm that kept exactly what we kept is the tightest honest bar and was skipped',
    caughtBy: 'ties break by name and input order does not change the selection',
    file: ARM,
    check: ARM_CHECK,
    from: 'ordered.filter((c) => c.retained >= ourRetained)',
    to: 'ordered.filter((c) => c.retained > ourRetained)',
  },
  {
    name: 'no comparable arm falls back to the next best arm',
    defect:
      'a row with no honest opponent silently gets a destructive one instead of saying so',
    caughtBy: 'an arm that kept less than ours is never comparable',
    file: ARM,
    check: ARM_CHECK,
    from: 'const comparable = eligible.length > 0 ? eligible[0] : null;',
    to: 'const comparable = eligible.length > 0 ? eligible[0] : best;',
  },
  {
    name: 'an unknown retained count defaults to zero',
    defect:
      'every arm becomes comparable, including the one that kept 4 of 1045',
    caughtBy: 'an unknown retained count refuses instead of defaulting to zero',
    file: ARM,
    check: ARM_CHECK,
    from: 'if (!Number.isFinite(ourRetained) || ourRetained < 0)',
    to: 'if (false)',
  },
  {
    name: 'an unscannable arm is skipped rather than refusing the selection',
    defect:
      'the skipped arm could have been the comparable one, so a worse bar is substituted in silence',
    caughtBy: 'a capture that cannot be ranked is refused, not ranked anyway',
    file: ARM,
    check: ARM_CHECK,
    from: 'if (!Number.isFinite(c.retained) || c.retained < 0)',
    to: 'if (false)',
  },
  {
    name: 'an undecided column resolves as a pass',
    defect:
      'a column with no reading counts as agreement, which is the whole reason the verdicts are three-valued',
    caughtBy: 'win both or it is not a win',
    file: ARM,
    check: ARM_CHECK,
    from: '  if (b.pass === null || c.pass === null) return { pass: null, detail };',
    to: '  if (b.pass === null || c.pass === null) return { pass: true, detail };',
  },
  {
    name: 'a decided loss beside an undecided column resolves as undecided',
    defect:
      'a measurement that refutes the claim is outranked by a column that was never read',
    caughtBy: 'win both or it is not a win',
    file: ARM,
    check: ARM_CHECK,
    from: '  if (b.pass === false || c.pass === false) return { pass: false, detail };',
    to: '  if (b.pass === false && c.pass === false) return { pass: false, detail };',
  },
  {
    name: 'a missing second column reads as agreement',
    defect:
      'the classic spelling: `comparable && comparable.pass === false` treats an absent column as a pass on it',
    caughtBy: 'win both or it is not a win',
    file: ARM,
    check: ARM_CHECK,
    from: "      ? { pass: null, detail: 'no ' + which + ' column recorded for this row' }",
    to: "      ? { pass: true, detail: 'no ' + which + ' column recorded for this row' }",
  },
  {
    name: 'retention is judged on both columns after all',
    defect:
      'a bar that cannot be failed for any reason to do with the code under test is reported as one',
    caughtBy: 'retention keeps one column and says why',
    file: ARM,
    check: ARM_CHECK,
    from: "      columns: ['best'],",
    to: "      columns: ['best', 'comparable'],",
  },
  {
    name: 'the arms are taken in capture order instead of ranked',
    defect:
      'the opponent becomes whichever arm their sweep happened to try first, so two runs of the same capture can pick different bars',
    caughtBy: 'ties break by name and input order does not change the selection',
    file: ARM,
    check: ARM_CHECK,
    from: 'const ordered = [...scored].sort(rank);',
    to: 'const ordered = [...scored];',
  },
];

// The files to snapshot come from the table, so adding a mutant against a new
// instrument cannot forget to protect that instrument's bytes.
// ONE BATTERY AT A TIME, enforced rather than requested. `wx` fails if the path
// exists, so the second run refuses instead of snapshotting files the first has
// already mutated. Stale lock after a hard kill: delete the file the message
// names -- it is printed in full for exactly that reason.
const LOCK = join(HERE, '.mutants.lock');
let lockFd = null;
try {
  lockFd = openSync(LOCK, 'wx');
  writeFileSync(LOCK, `pid ${process.pid} started ${new Date().toISOString()}`, 'utf8');
} catch (err) {
  if (err && err.code === 'EEXIST') {
    console.log('another mutation battery holds the lock, so this run refuses:');
    console.log('  ' + LOCK);
    console.log(readFileSync(LOCK, 'utf8').trim());
    console.log('two batteries at once leave a mutant in the working tree and still');
    console.log('report a perfect score; wait for it, or delete that file if it is stale.');
    process.exit(3);
  }
  throw err;
}

const releaseLock = () => {
  if (lockFd === null) return;
  closeSync(lockFd);
  lockFd = null;
  rmSync(LOCK, { force: true });
};
process.on('exit', releaseLock);
const originals = new Map();
for (const m of MUTANTS) if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file, 'utf8'));
const before = new Map([...originals.keys()].map((f) => [f, digest(f)]));

// THE CONTROL ARM. A mutant is scored as caught when its check exits non-zero,
// so a check that was ALREADY failing catches everything and proves nothing. Run
// each distinct check once against the untouched instruments first: if any of
// them is red before a single byte has been changed, there is no score to report.
const checks = [...new Set(MUTANTS.map((m) => m.check))];
const red = [];
for (const c of checks) {
  const run = spawnSync('node', [c], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) red.push(c.slice(REPO.length + 1).split(sep).join('/'));
}
if (red.length) {
  console.log('NO SCORE: these checks are red before anything was mutated, so every');
  console.log('mutant against them would be counted as caught without being tested:');
  for (const c of red) console.log('  ' + c);
  console.log('restore the instruments (git status, then git checkout --) and re-run.');
  process.exit(4);
}
console.log(`control arm: ${checks.length} check(s) pass unmutated`);
let caught = 0;
let survived = 0;
let stale = 0;
let lastCheck = null;

try {
  for (const m of MUTANTS) {
    if (m.check !== lastCheck) {
      lastCheck = m.check;
      console.log('');
      console.log('against ' + m.check.slice(REPO.length + 1).split(sep).join('/'));
    }
    const src = originals.get(m.file);
    const hits = src.split(m.from).length - 1;
    if (hits !== 1) {
      stale++;
      console.log(`  STALE   ${m.name}`);
      console.log(`          its anchor matches ${hits} times, so it mutated nothing`);
      continue;
    }
    writeFileSync(m.file, src.replace(m.from, m.to), 'utf8');
    const run = spawnSync('node', [m.check], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    writeFileSync(m.file, src, 'utf8');
    if (run.status !== 0) {
      caught++;
      console.log(`  caught  ${m.name}`);
    } else {
      survived++;
      console.log(`  SURVIVED ${m.name}`);
      console.log(`           defect: ${m.defect}`);
      console.log(`           should have been refused by: ${m.caughtBy}`);
    }
  }
} finally {
  for (const [f, src] of originals) writeFileSync(f, src, 'utf8');
}

for (const [f, d] of before) {
  if (digest(f) !== d) {
    console.log(`\nFAILED TO RESTORE ${f} -- check it out before running anything else`);
    process.exit(2);
  }
}

const total = caught + survived + stale;
console.log(`\nmutation score ${caught}/${total} caught` + (stale ? `, ${stale} stale` : ''));
if (survived || stale) {
  console.log(
    survived
      ? 'each surviving mutant is a defect that could be reintroduced with every test green'
      : 'a stale mutant counts as caught without testing anything; fix its anchor'
  );
}
process.exit(survived || stale ? 1 : 0);
