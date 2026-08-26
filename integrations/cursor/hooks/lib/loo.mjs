// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/loo.mjs. Regenerate with `npm run sync:hooks`.
/**
 * LAYER 2 -- what one finding is actually worth, measured by withholding it.
 *
 * Layer 1 asks whether the model went back and named a finding. This asks the
 * harder question and answers it causally: WITHHOLD ONE FINDING while serving
 * every other finding for the same touch, and compare what the session spent
 * READING that anchor afterwards. Nobody in this space measures per-item value
 * this way in production; the state of the art is an offline evaluation set.
 * That is also why this file is more refusal than statistics -- a causal claim
 * from four observations is worse than no claim, because it is a number and
 * numbers get quoted.
 *
 * THE ESTIMAND IS READ-SUPPRESSION, and it is deliberately DISJOINT from Layer
 * 1. Layer 1 keys on an explicit `query` naming a finding key. This keys on
 * `read` events against the injection's anchor. Neither signal appears in the
 * other's arithmetic: no `query` event is consulted here, and `usage.mjs`
 * consults no `read` event. Task 8 calibrates one against the other, and if
 * both derived from the same channel that calibration would report a strong
 * correlation between two spellings of one quantity and mean nothing.
 *
 * IT INVENTS NO JOIN. `recordToolOutcome` already joins each post-tool result
 * back to the injection that preceded it, recording `injectionId`,
 * `findingIds` and a `joinMethod` of `tool-call-id` / `episode-anchor` /
 * `none`. Every observation here is GATED on that join: an injection with no
 * joined outcome is unattributable and enters neither arm, exactly as Layer 1
 * treats `joinMethod: 'none'`. An earlier draft of this plan proposed a fresh
 * `(sessionId, findingKey)` join; it was rejected and is not here.
 *
 * WHAT IT COSTS THE USER, because an experiment that degrades a turn owes an
 * accounting. One withheld finding means the model may re-derive what it was
 * told last time, and the worst case is one read of that anchor: measured on
 * this machine, a median read is 3,769 tokens and the 90th percentile is
 * 14,082. Five guards bound that exposure, and they are the reason the numbers
 * below are as small as they are:
 *
 *   1. only on a FILE touch, because a command injection has no anchor a read
 *      event can be joined to -- withholding there would cost a user a finding
 *      and buy no observation at all (see `buildReport`, which excludes command
 *      injections from the holdout balance for the same reason);
 *   2. never when fewer than two findings were kept, so "leave one out" always
 *      leaves something in -- otherwise it degenerates into `inHoldout`, which
 *      withholds EVERY finding for an anchor and is a different experiment;
 *   3. never in the same breath as `inHoldout`: if that arm already withheld
 *      everything, there is nothing to leave out and a Layer 2 arm recorded
 *      there would be a fabricated observation;
 *   4. at most ONE finding per touch, or the effect is attributable to neither;
 *   5. at most ONE withheld finding per SESSION, so the worst case a user can
 *      experience is a single re-read -- not one per file they open.
 *
 * AND IT NEVER OVERRIDES A PERSON. A `pinned` or `origin: 'human'` finding is
 * an explicit human decision to keep something in front of the model.
 * Withholding it to run an experiment would overrule that decision for the
 * convenience of the measurement, so those findings are exempt: they are
 * always served, they get no causal score, and `looNote` says so rather than
 * leaving a reader to wonder why they are missing from the table.
 */

import { createHash } from 'node:crypto';
import { readEvidence, readMetrics, readTruncation, isFixtureAnchor } from './metrics.mjs';
import { retrievalPolicy } from './utility.mjs';
import { ORIGIN_HUMAN } from './curate.mjs';
import { canonicalPath } from './paths.mjs';
import { load } from './wiki.mjs';

/**
 * Injections of a finding before it may enter the experiment.
 *
 * A finding nobody has served yet has no established value to measure the
 * absence of, and withholding it would be measuring the cold start rather than
 * the finding. Four is also what makes the ratio below reachable: at a quarter
 * of (key, session) pairs armed, a key needs roughly a dozen enrolled
 * injections before it can reach a verdict at all.
 */
export const MIN_PRIOR_INJECTIONS = 4;

/** The observation floor. Below this there is no verdict -- and NOT a zero. */
export const MIN_SERVED = 6;
export const MIN_WITHHELD = 3;

/** Benjamini-Hochberg false-discovery rate for published verdicts. */
export const FDR_Q = 0.1;

/**
 * Exploration rate.
 *
 * Without this, utility feeds the ranking, the ranking feeds injection
 * frequency, injection frequency feeds the observation count, and a low score
 * becomes self-fulfilling: the finding is never served often enough to earn a
 * better one. A tenth of touches therefore ignore the utility order and
 * promote the LEAST-served candidate instead.
 */
export const EPSILON = 0.1;

/**
 * The share of (finding, session) pairs assigned to the withheld arm.
 *
 * Chosen against the floors rather than picked: MIN_SERVED / MIN_WITHHELD is
 * 2:1, so a quarter withheld reaches both floors at about the same time while
 * leaving three touches in four undamaged.
 */
export const WITHHOLD_FRACTION = 0.25;

/**
 * Withheld findings allowed per session. ONE.
 *
 * The per-touch cap alone bounds nothing across a session: a session that
 * opens twelve files with enrolled findings could have withheld twelve. This
 * makes the worst case a user can experience one re-read, at the price of a
 * mild confound that is stated rather than hidden -- when the cap binds, the
 * other armed findings in that session are served, so the served arm is
 * slightly enriched by sessions that touch many enrolled findings.
 */
export const MAX_WITHHELD_PER_SESSION = 1;

/**
 * Fallback shrinkage weight when the between-finding variance cannot be
 * estimated (fewer than two findings with both arms, or no dispersion at all).
 *
 * MIN_SERVED + MIN_WITHHELD, deliberately: a finding's own data outweighs the
 * population prior only once it has reached the publication floor.
 */
export const SHRINKAGE_K = MIN_SERVED + MIN_WITHHELD;

/** Bounds on the estimated shrinkage weight, so a degenerate variance ratio cannot run away. */
const K_MIN = 1;
const K_MAX = 100;

/**
 * Bumped BY HAND when the serving code changes in a way that could move a
 * finding's measured effect. It is the part of the policy version a hash of the
 * configuration cannot see.
 */
export const LOO_POLICY_GENERATION = 1;

/** Permutation budget before the exact null distribution is sampled instead of enumerated. */
const MAX_EXACT_PERMUTATIONS = 20_000;
const SAMPLED_PERMUTATIONS = 10_000;

/**
 * On by default, off by `TOKEN_OPTIMIZER_LOO=off`.
 *
 * Read per call rather than at module load, for the reason `holdoutFraction`
 * gives: a long-lived process started before the setting changed would
 * otherwise honour the old value forever with no way to tell.
 */
export function LOO_ENABLED() {
  return String(process.env.TOKEN_OPTIMIZER_LOO || '').trim().toLowerCase() !== 'off';
}

/**
 * The serving policy an observation was collected under.
 *
 * WHY EVERY OBSERVATION CARRIES ONE. An effect is only meaningful against a
 * fixed policy. Halve the touch budget or move the minimum net utility and the
 * same finding is served in different company, at a different rank, against a
 * different counterfactual -- so pooling observations from before and after
 * that change would average two different experiments and call the result
 * causal. `effects()` therefore groups by (finding, policy) and never across.
 *
 * IT IS DELIBERATELY ABSENT FROM THE ARM HASH. Including it would reassign
 * arms the moment a setting changed, which is precisely the mid-session flip
 * the arm hash exists to prevent. Configuration decides which experiment an
 * observation belongs to; it must never decide which arm.
 */
export function servingPolicyVersion() {
  const policy = retrievalPolicy();
  const parts = [
    `g${LOO_POLICY_GENERATION}`,
    `touch=${Number(process.env.TOKEN_OPTIMIZER_TOUCH_BUDGET) || 500}`,
    `benefit=${policy.baseBenefitTokens}`,
    `minutility=${policy.minimumNetUtility}`,
    `cooldown=${policy.cooldownMs}`,
    `quarantine=${policy.quarantineHarmCount}`,
    `holdout=${process.env.TOKEN_OPTIMIZER_HOLDOUT ?? 'default'}`,
    `withhold=${WITHHOLD_FRACTION}`,
    `prior=${MIN_PRIOR_INJECTIONS}`,
    `epsilon=${EPSILON}`,
  ];
  const digest = createHash('sha256').update(parts.join('|')).digest('hex');
  return `${LOO_POLICY_GENERATION}-${digest.slice(0, 8)}`;
}

/**
 * A stable number in [0, 1) from a string.
 *
 * SHA-256 rather than SHA-1 for the same reason `inHoldout` uses it: this is a
 * bucketing hash and nothing here is secret, but arguing that a CodeQL finding
 * is benign is a worse habit than paying a cost that rounds to nothing.
 */
function bucket(text) {
  return createHash('sha256').update(String(text)).digest().readUInt32BE(0) / 4_294_967_296;
}

/**
 * The arm of one finding in one session.
 *
 * Keyed on (findingKey, sessionId) AND NOTHING ELSE, so a finding cannot
 * change arms partway through a session: not when the candidate set changes,
 * not when the budget changes, not when the graph grows. The measurement is a
 * comparison between sessions, and an arm that flips inside one contaminates
 * both sides of it.
 */
function armed(findingKey, sessionId) {
  return bucket(`loo-arm:${findingKey}:${sessionId}`) < WITHHOLD_FRACTION;
}

/** Deterministic tiebreak among armed candidates: lowest bucket, then key order. */
function armRank(findingKey, sessionId) {
  return bucket(`loo-rank:${findingKey}:${sessionId}`);
}

/** The graph node for a finding key, or null. Keys are unique per graph. */
function findingNode(graph, key) {
  const nodes = graph?.nodes;
  if (!nodes || typeof nodes.values !== 'function') return null;
  for (const node of nodes.values()) {
    if (node?.kind === 'finding' && node.key === key) return node;
    // A fixture graph may omit `kind`; key identity is what this needs.
    if (node?.key === key && node.kind === undefined) return node;
  }
  return null;
}

/**
 * May this finding ever be withheld?
 *
 * FAILS CLOSED ON AN UNKNOWN KEY, which is the opposite of how the rest of
 * this module fails. Everywhere else a missing input costs a measurement; here
 * it could cost a human their explicit decision, because a key whose node
 * cannot be read is a key whose `pinned` and `origin` cannot be checked.
 */
function withholdable(graph, key) {
  const node = findingNode(graph, key);
  if (!node) return false;
  if (node.pinned) return false;
  if (node.origin === ORIGIN_HUMAN) return false;
  if (node.retired) return false;
  return true;
}

/** Prior SERVED injections per finding key, and withheld injections per session. */
function history(dir, { evidence = null } = {}) {
  const priorServed = new Map();
  const withheldPerSession = new Map();
  const events = evidence || readEvidence(dir);
  for (const event of events) {
    if (event.kind !== 'inject') continue;
    if (typeof event.loo === 'string' && event.loo) {
      const session = typeof event.sessionId === 'string' ? event.sessionId : '';
      withheldPerSession.set(session, (withheldPerSession.get(session) || 0) + 1);
    }
    if (event.holdout) continue;
    const keys = Array.isArray(event.findingIds) ? event.findingIds : [];
    for (const raw of keys) {
      const key = String(raw);
      priorServed.set(key, (priorServed.get(key) || 0) + 1);
    }
  }
  return { priorServed, withheldPerSession };
}

/**
 * Which single finding to withhold from this touch, or null.
 *
 * Called from `forTouch` AFTER `fit` has decided what would have been served,
 * which is the only ordering that produces a true leave-one-out. Withholding
 * BEFORE the budget runs would let a lower-ranked finding take the freed
 * tokens, so the withheld arm would receive different company as well as one
 * fewer finding, and the comparison would confound the two.
 *
 * @param {string[]} findingKeys keys that would otherwise be delivered
 * @param {string} sessionId the session, which pins the arm
 * @param {object} graph the loaded graph, for `pinned` / `origin`
 * @param {string|null} dir graph directory, for the injection history
 */
export function withheldFor(findingKeys, sessionId, graph, dir, options = {}) {
  try {
    if (!LOO_ENABLED()) return null;

    // Every guard that needs no I/O runs first: this is the PreToolUse path,
    // and on a project with one finding per anchor the answer is null before
    // anything is read.
    const keys = [...new Set((findingKeys || []).map((k) => String(k)).filter(Boolean))];
    if (keys.length < 2) return null;
    if (!sessionId || typeof sessionId !== 'string') return null;

    // FILE SURFACE ONLY. A command injection's anchor is the command text, and
    // no read event will ever match it -- so both arms would score zero
    // downstream and the finding would be scored on nothing.
    const { surface = 'file', anchor = '', holdout = false } = options;
    if (surface !== 'file' || !anchor) return null;
    // The all-findings holdout already withheld everything for this anchor.
    if (holdout) return null;

    const eligible = keys.filter((key) => withholdable(graph, key));
    if (!eligible.length) return null;

    const { priorServed, withheldPerSession } = history(dir, options);
    if ((withheldPerSession.get(sessionId) || 0) >= MAX_WITHHELD_PER_SESSION) return null;

    const enrolled = eligible.filter(
      (key) => (priorServed.get(key) || 0) >= MIN_PRIOR_INJECTIONS
    );
    if (!enrolled.length) return null;

    const candidates = enrolled.filter((key) => armed(key, sessionId));
    if (!candidates.length) return null;

    // AT MOST ONE. Sorted deterministically so the same touch always yields the
    // same choice; the findings that lose the tiebreak are SERVED, and the
    // observation records what actually happened rather than what the arm hash
    // intended.
    candidates.sort(
      (a, b) => armRank(a, sessionId) - armRank(b, sessionId) || (a < b ? -1 : a > b ? 1 : 0)
    );
    return candidates[0];
  } catch {
    // An experiment must never break a tool call. Failing open here means
    // serving everything, which is the undegraded behaviour.
    return null;
  }
}

/**
 * Reorders candidates so exploration can break the feedback loop.
 *
 * A tenth of touches -- deterministic in (session, anchor), not random, so the
 * same touch behaves the same way twice -- promote the LEAST-served candidate
 * ahead of the utility order, giving it a chance to survive `fit` and accrue
 * the observations it needs to earn a score. The other nine tenths are
 * untouched.
 *
 * @param {Array<{finding:{key:string}}>} items assessed candidates, best first
 */
export function exploreOrder(items, dir, options = {}) {
  try {
    if (!LOO_ENABLED()) return items;
    const list = Array.isArray(items) ? items : [];
    if (list.length < 2) return list;
    const { sessionId = '', anchor = '' } = options;
    if (bucket(`loo-explore:${sessionId}:${anchor}`) >= EPSILON) return list;

    const keyOf = (item) => String(item?.finding?.key ?? item?.key ?? '');
    const { priorServed } = history(dir, options);
    let promoted = 0;
    for (let i = 1; i < list.length; i += 1) {
      const a = priorServed.get(keyOf(list[i])) || 0;
      const b = priorServed.get(keyOf(list[promoted])) || 0;
      if (a < b || (a === b && keyOf(list[i]) < keyOf(list[promoted]))) promoted = i;
    }
    if (promoted === 0) return list;
    return [list[promoted], ...list.filter((_, i) => i !== promoted)];
  } catch {
    return Array.isArray(items) ? items : [];
  }
}

const mean = (values) =>
  values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;

/** Sample variance (n-1). Zero for a single observation: dispersion is unknown, not large. */
function variance(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((sum, v) => sum + (v - m) * (v - m), 0) / (values.length - 1);
}

/**
 * Every attributable Layer 2 observation, one per (injection, finding, arm).
 *
 * THREE THINGS ARE REPORTED SEPARATELY RATHER THAN FOLDED IN, because each of
 * them would otherwise turn an absence into a zero:
 *
 *   `unattributable`  the outcome join could not attach a tool call to the
 *                     injection, so nothing is known about what followed it.
 *   `excluded`        the injection could never produce a read-join at all
 *                     (command surface, session-start, fixture anchor) or was
 *                     already in the all-findings holdout.
 *   `costObservations` how many observations saw a non-zero read cost. If this
 *                     is zero, "withholding changed nothing" and "the read
 *                     channel never fired" are the same picture, and only one
 *                     of them is a finding about findings.
 */
export function observations(dir, { events = null, evidence = null } = {}) {
  const empty = {
    rows: [],
    unattributable: 0,
    unattributableOutcomes: 0,
    excluded: { command: 0, holdout: 0, fixture: 0, unanchored: 0 },
    injections: 0,
    withheldInjections: 0,
    costObservations: 0,
    policies: [],
    windowed: false,
  };
  try {
    const causal = evidence || readEvidence(dir);
    const all = events || readMetrics(dir);
    // OUT OF BAND and read IMMEDIATELY after the only read that sets it --
    // `readTruncation` describes the last `readAll`, so anything between the
    // two could overwrite it. False when the caller supplied its own events:
    // the read was theirs and its bounds are not ours to claim.
    const truncation = events ? null : readTruncation();

    // THE JOIN THIS MODULE CONSUMES AND DOES NOT REPLACE.
    const joined = new Set();
    let unattributableOutcomes = 0;
    for (const event of causal) {
      if (event.kind !== 'tool-outcome') continue;
      if (event.joinMethod === 'none' || !event.injectionId) {
        unattributableOutcomes += 1;
        continue;
      }
      joined.add(String(event.injectionId));
    }

    // Read cost, grouped the way `buildReport` groups it: (session, anchor),
    // canonicalised on both sides so two spellings of one file are one anchor.
    // A mismatch here would make every read invisible and report a clean zero
    // effect in both arms -- correct code, absent measurement.
    const reads = new Map();
    for (const event of all) {
      if (event.kind !== 'read' || !event.anchor) continue;
      const key = `${event.sessionId || ''}|${canonicalPath(event.anchor)}`;
      if (!reads.has(key)) reads.set(key, []);
      reads.get(key).push(event);
    }

    const injects = causal
      .filter((event) => event.kind === 'inject')
      .map((event, index) => ({ event, index }))
      .sort((a, b) => (a.event.at || 0) - (b.event.at || 0) || a.index - b.index)
      .map((row) => row.event);

    // How many injections share each (session, anchor), so a key's read total
    // is SPLIT between them rather than charged in full to each -- the same
    // correction `buildReport` applies, and for the same reason: without it the
    // arm means scale with injections-per-anchor instead of per-touch cost.
    const perKey = new Map();
    for (const event of injects) {
      if (!event.anchor) continue;
      const key = `${event.sessionId || ''}|${canonicalPath(event.anchor)}`;
      perKey.set(key, (perKey.get(key) || 0) + 1);
    }

    const rows = [];
    const excluded = { command: 0, holdout: 0, fixture: 0, unanchored: 0 };
    const priorServed = new Map();
    const policies = new Set();
    let unattributable = 0;
    let considered = 0;
    let withheldInjections = 0;

    for (const event of injects) {
      const served = (Array.isArray(event.findingIds) ? event.findingIds : []).map(String);
      const withheldKey = typeof event.loo === 'string' && event.loo ? event.loo : null;
      const bump = () => {
        for (const key of served) priorServed.set(key, (priorServed.get(key) || 0) + 1);
      };

      const isCommand =
        event.surface === 'command' ||
        event.trigger === 'command' ||
        event.surface === 'session-start';
      if (isCommand) {
        excluded.command += 1;
        bump();
        continue;
      }
      if (!event.anchor) {
        excluded.unanchored += 1;
        bump();
        continue;
      }
      if (isFixtureAnchor(event.anchor)) {
        excluded.fixture += 1;
        bump();
        continue;
      }
      if (event.holdout) {
        excluded.holdout += 1;
        bump();
        continue;
      }

      considered += 1;
      if (withheldKey) withheldInjections += 1;
      const policy = typeof event.looPolicy === 'string' && event.looPolicy
        ? event.looPolicy
        : 'unversioned';
      const injectionId = event.injectionId ? String(event.injectionId) : null;
      const attributable = Boolean(injectionId && joined.has(injectionId));

      // DOWNSTREAM MEANS AFTER, STRICTLY. The read that triggered the touch is
      // not caused by the advice; it happened before the advice existed.
      const key = `${event.sessionId || ''}|${canonicalPath(event.anchor)}`;
      const at = event.at || 0;
      const total = (reads.get(key) || []).reduce(
        (sum, read) => sum + ((read.at || 0) > at ? read.tokens || 0 : 0),
        0
      );
      const cost = total / Math.max(1, perKey.get(key) || 1);

      const observe = (findingKey, arm) => {
        // ENROLMENT IS RE-DERIVED FROM THE LOG rather than trusted from the
        // serving decision. It is the one field an old or hand-written record
        // could contradict, and a served observation from before a finding was
        // enrolled would compare an established finding against its own cold
        // start.
        //
        // CHECKED BEFORE ATTRIBUTABILITY, so `unattributable` counts only
        // observations the experiment actually wanted. Counting the rest there
        // would report a join failure for every finding that was never in the
        // experiment to begin with -- the same shape as the 2,559-row
        // measurement-bias defect Layer 1 found in its own first draft.
        if ((priorServed.get(findingKey) || 0) < MIN_PRIOR_INJECTIONS) return;
        if (!attributable) {
          unattributable += 1;
          return;
        }
        policies.add(policy);
        rows.push({ findingKey, arm, cost, policy, injectionId, anchor: event.anchor });
      };

      if (withheldKey) observe(withheldKey, 'withheld');
      for (const findingKey of served) observe(findingKey, 'served');
      bump();
    }

    return {
      rows,
      unattributable,
      unattributableOutcomes,
      excluded,
      injections: considered,
      withheldInjections,
      costObservations: rows.filter((row) => row.cost > 0).length,
      policies: [...policies].sort(),
      windowed: Boolean(truncation?.byBytes || truncation?.byEvents),
    };
  } catch {
    return empty;
  }
}

/** Enumerates or samples arm relabellings and returns a two-sided p-value. */
function permutationP(servedCosts, withheldCosts) {
  const pooled = [...servedCosts, ...withheldCosts];
  const n = pooled.length;
  const k = withheldCosts.length;
  if (!k || k === n) return null;
  const observed = Math.abs(mean(withheldCosts) - mean(servedCosts));
  const total = pooled.reduce((sum, v) => sum + v, 0);
  // Mean difference from the withheld-arm sum alone: the served sum is the
  // complement, so one number decides the statistic.
  const diffFrom = (withheldSum) =>
    Math.abs(withheldSum / k - (total - withheldSum) / (n - k));

  const choose = (a, b) => {
    let out = 1;
    for (let i = 1; i <= b; i += 1) out = (out * (a - b + i)) / i;
    return out;
  };

  const tolerance = 1e-9;
  if (choose(n, k) <= MAX_EXACT_PERMUTATIONS) {
    let extreme = 0;
    let count = 0;
    const walk = (start, chosen, sum) => {
      if (chosen === k) {
        count += 1;
        if (diffFrom(sum) >= observed - tolerance) extreme += 1;
        return;
      }
      for (let i = start; i <= n - (k - chosen); i += 1) walk(i + 1, chosen + 1, sum + pooled[i]);
    };
    walk(0, 0, 0);
    return count ? extreme / count : null;
  }

  // Mulberry32 off a fixed seed: reproducible, so the same data always yields
  // the same p-value and a verdict cannot flicker between two audit runs.
  let state = 0x9e3779b9;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  let extreme = 0;
  const order = [...pooled];
  for (let round = 0; round < SAMPLED_PERMUTATIONS; round += 1) {
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    let sum = 0;
    for (let i = 0; i < k; i += 1) sum += order[i];
    if (diffFrom(sum) >= observed - tolerance) extreme += 1;
  }
  return (extreme + 1) / (SAMPLED_PERMUTATIONS + 1);
}

/**
 * The per-finding causal effect, shrunk, and whether it may be published.
 *
 * `raw` is `mean(withheld) - mean(served)`: POSITIVE means the session read the
 * anchor more when the finding was withheld, which is the finding earning its
 * place. `shrunk` is the number a reader should use.
 *
 * EMPIRICAL BAYES, and both halves of it come from the data. The prior mean is
 * the population effect across findings; the weight `k` is the ratio of
 * within-finding noise to between-finding spread, so a population where every
 * finding behaves alike shrinks hard and one where they genuinely differ
 * shrinks little. `SHRINKAGE_K` is the fallback when that spread cannot be
 * estimated at all. Two observations therefore cannot post a wild score.
 *
 * PUBLICATION IS NOT THE SAME QUESTION as having an estimate. A row is
 * published only if it clears the observation floor AND its permutation
 * p-value survives Benjamini-Hochberg at q = 0.10 across every candidate row.
 * Everything else gets `published: false` -- which is not a zero effect, and
 * `looNote` says which of the two it is. An all-zero-cost population needs no
 * separate guard: p is exactly 1 there, so nothing can publish anyway.
 *
 * NEVER POOLED ACROSS POLICY VERSIONS: rows are keyed on (findingKey, policy).
 */
export function effects(dir, options = {}) {
  try {
    // `obs` is accepted so `looNote` can read the logs once for both.
    const obs = options.obs || observations(dir, options);
    const groups = new Map();
    for (const row of obs.rows) {
      const id = JSON.stringify([row.findingKey, row.policy]);
      if (!groups.has(id))
        groups.set(id, { findingKey: row.findingKey, policy: row.policy, served: [], withheld: [] });
      groups.get(id)[row.arm === 'withheld' ? 'withheld' : 'served'].push(row.cost);
    }

    const raws = [];
    const withinVars = [];
    for (const group of groups.values()) {
      if (!group.served.length || !group.withheld.length) continue;
      raws.push(mean(group.withheld) - mean(group.served));
      withinVars.push(
        variance(group.withheld) / group.withheld.length +
          variance(group.served) / group.served.length
      );
    }
    const prior = raws.length ? mean(raws) : 0;
    const within = withinVars.length ? mean(withinVars) : 0;
    const between = raws.length > 1 ? Math.max(0, variance(raws) - within) : 0;
    const weight =
      between > 0 && within > 0
        ? Math.min(K_MAX, Math.max(K_MIN, within / between))
        : SHRINKAGE_K;

    const rows = [...groups.values()]
      .map((group) => {
        const served = group.served.length;
        const withheld = group.withheld.length;
        const both = served > 0 && withheld > 0;
        const raw = both ? mean(group.withheld) - mean(group.served) : null;
        const n = served + withheld;
        const shrunk = raw === null ? null : (n * raw + weight * prior) / (n + weight);
        const eligible = served >= MIN_SERVED && withheld >= MIN_WITHHELD;
        return {
          findingKey: group.findingKey,
          policy: group.policy,
          served,
          withheld,
          servedMean: mean(group.served),
          withheldMean: mean(group.withheld),
          raw,
          shrunk,
          p: eligible ? permutationP(group.served, group.withheld) : null,
          published: false,
        };
      })
      .sort((a, b) =>
        a.findingKey < b.findingKey ? -1 : a.findingKey > b.findingKey ? 1 : a.policy < b.policy ? -1 : 1
      );

    // BENJAMINI-HOCHBERG at q = 0.10 over every row that cleared the floor.
    // One finding tested in isolation would publish at p < 0.10; a hundred
    // would publish ten false ones, and this module's whole claim is that its
    // numbers can be quoted.
    //
    // THERE IS NO SEPARATE "WAS ANY READ COST OBSERVED" GATE HERE, and its
    // absence is deliberate rather than an omission. One was written, and
    // mutation testing showed it could not change a single verdict: if every
    // observation has zero cost then both arm means are zero, the permutation
    // statistic is zero for every relabelling, and p is exactly 1 -- which no
    // BH threshold can pass. The guard was unfalsifiable, and an unfalsifiable
    // guard is worse than none because it reads as protection nobody can test.
    // `costObservations` survives as what it can honestly be: a DISCLOSURE, so
    // `looNote` can say the read channel never fired instead of letting a
    // reader take an arithmetic zero for a measured one.
    const candidates = rows
      .filter((row) => row.p !== null)
      .sort((a, b) => a.p - b.p);
    const m = candidates.length;
    let cutoff = 0;
    for (let i = 0; i < m; i += 1) {
      if (candidates[i].p <= ((i + 1) / m) * FDR_Q) cutoff = i + 1;
    }
    for (let i = 0; i < cutoff; i += 1) candidates[i].published = true;

    return rows;
  } catch {
    return [];
  }
}

/**
 * One or two lines for the audit, or nothing at all.
 *
 * THE REFUSAL IS THE PRODUCT HERE. On a machine with two injections in sixteen
 * thousand events, the only honest output is that nothing is measurable yet,
 * and this says so with the counts that make it checkable rather than printing
 * a mean of nothing. It returns `null` when Layer 2 has not collected a single
 * observation, so an idle experiment costs the reader no line at all -- the
 * same standard `referenceNote` holds itself to.
 */
export function looNote(dir, options = {}) {
  try {
    const obs = options.obs || observations(dir, options);
    const rows = effects(dir, { ...options, obs });
    if (!obs.rows.length && !obs.withheldInjections) return null;

    let graph = options.graph;
    if (graph === undefined) {
      try {
        graph = load(dir);
      } catch {
        graph = null;
      }
    }
    let exempt = 0;
    if (graph?.nodes?.values) {
      for (const node of graph.nodes.values()) {
        if (node?.kind !== 'finding' || node.retired) continue;
        if (node.pinned || node.origin === ORIGIN_HUMAN) exempt += 1;
      }
    }

    const published = rows.filter((row) => row.published);
    const head = published.length
      ? `Per-finding causal value (leave-one-out): ${published.length} of ${rows.length} ` +
        `findings show a verdict at q=${FDR_Q}` +
        published
          .slice(0, 3)
          .map(
            (row) =>
              `; ${row.findingKey} saves ~${Math.round(row.shrunk)} tokens/touch ` +
              `(${row.served} served, ${row.withheld} withheld, p=${row.p.toFixed(3)})`
          )
          .join('') +
        '.'
      : `Per-finding causal value (leave-one-out): NOT MEASURABLE YET -- ` +
        `${obs.rows.length} attributable observations across ${rows.length} findings, ` +
        `${obs.withheldInjections} withheld touches; the floor is ${MIN_SERVED} served ` +
        `and ${MIN_WITHHELD} withheld per finding` +
        (obs.costObservations ? '' : ', and no read cost has been observed in either arm') +
        '. No effect is reported, which is not the same as an effect of zero.';

    const caveats = [];
    if (obs.unattributable)
      caveats.push(
        `${obs.unattributable} observations were unattributable (no joined tool outcome) and are in neither arm`
      );
    if (exempt)
      caveats.push(
        `${exempt} pinned or human-origin findings are exempt from withholding and get no causal score`
      );
    if (obs.policies.length > 1)
      caveats.push(
        `observations span ${obs.policies.length} serving-policy versions and are never pooled across them`
      );
    if (obs.windowed)
      caveats.push('the read log was truncated, so downstream cost can understate');
    return caveats.length ? `${head} ${caveats.join('; ')}.` : head;
  } catch {
    return null;
  }
}
