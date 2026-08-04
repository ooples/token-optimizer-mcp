// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/metrics.mjs. Regenerate with `npm run sync:hooks`.
/**
 * P5: proving the graph earns its keep.
 *
 * The design says plainly that a wiki which cannot show a positive token
 * balance is overhead wearing a knowledge-graph costume. This file is how that
 * gets found out from our own telemetry rather than from users.
 *
 * THE HOLDOUT, AND WHY IT IS STRATIFIED. Injection is silently skipped on a
 * random slice of touches, and cost is compared between served and withheld.
 * Naively randomising across all touches is noisy, because touches are wildly
 * heterogeneous -- a 40-line config and a 3,000-line module are not comparable
 * units. So the holdout is stratified BY ANCHOR: the decision for a given file
 * is made from a hash of (file, epoch), so the same file lands in the holdout
 * during some epochs and the treated arm in others. The comparison becomes
 * within-file, which removes the dominant source of variance and makes the
 * number mean something at far lower volume.
 */

import {
  appendFileSync, readFileSync, existsSync, mkdirSync, chmodSync,
  statSync, openSync, readSync, closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Read per call, not once at module load.
 *
 * Hooks are short-lived, but the same module is also imported by long-running
 * callers, and a process started before a config change would otherwise honour
 * the old value indefinitely with no way to tell. Reading here costs nothing
 * and removes a class of "I changed the setting and nothing happened" bug.
 */
function holdoutFraction() {
  const raw = Number(process.env.TOKEN_OPTIMIZER_HOLDOUT);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.1;
}

/** Epoch length for stratification: a file switches arms roughly daily. */
const EPOCH_MS = 86_400_000;

const metricsPath = (dir) => join(dir, 'metrics.jsonl');

/**
 * The balance log: `inject` and `harvest` only.
 *
 * WHY A SECOND FILE. The event window is measured in EVENTS, and injections are
 * a tiny minority of them -- 136 injections against 6,725 captures across every
 * graph on one machine. So the last 5,000 events are almost entirely captures
 * and reads, and the injections that carry the measurement age out first.
 *
 * Measured on this repository before the fix: 44 inject records in the file, 9
 * of them holdout, all at lines 60-76 of 9,058 -- every single one outside the
 * window. `report()` therefore said "0 holdout" while the file plainly
 * contained nine, and the net balance was uncomputable on all 122 graphs.
 *
 * A separate log fixes it structurally rather than by enlarging a number.
 * These records are rare, so the file stays small for years, and a tail window
 * on it drops BOTH arms proportionally instead of starving the rare one.
 */
const balancePath = (dir) => join(dir, 'balance.jsonl');

/** Kinds the net balance is computed from, and which therefore must survive. */
const BALANCE_KINDS = new Set(['inject', 'harvest']);

/**
 * Is this touch in the holdout arm?
 *
 * Deterministic in (anchor, epoch) rather than random per call, so repeated
 * touches of the same file within a session are consistently in one arm.
 * Flipping arms mid-session would contaminate both.
 */
export function inHoldout(anchorKey, now = Date.now()) {
  const fraction = holdoutFraction();
  if (fraction <= 0) return false;
  const epoch = Math.floor(now / EPOCH_MS);
  const digest = createHash('sha1').update(`${anchorKey}:${epoch}`).digest();
  return (digest[0] / 256) < fraction;
}

/**
 * Records what a read of an anchor actually cost.
 *
 * Called from the router whenever a read is ALLOWED through, which is the only
 * moment the cost is knowable. This is the producer that makes the holdout
 * comparison a measurement rather than a subtraction of two zeroes.
 */
export function recordRead(dir, { anchor, sessionId, bytes }) {
  if (!anchor || !bytes) return;
  record(dir, { kind: 'read', anchor, sessionId, tokens: Math.ceil(bytes / 4) });
}

export function record(dir, event) {
  try {
    // Same restriction as the graph directory: metrics name real file paths
    // from a private codebase.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Not POSIX, or not ours to chmod; the write still proceeds.
    }
    const line = JSON.stringify({ ...event, at: Date.now() }) + '\n';
    appendFileSync(metricsPath(dir), line);
    // Balance-critical records go to their own log as well, so the windows on
    // the firehose can never starve the measurement. Written SECOND: a torn
    // write here costs a duplicate the reader dedupes, not a lost event.
    if (BALANCE_KINDS.has(event.kind)) appendFileSync(balancePath(dir), line);
  } catch {
    // Metrics must never break a tool call.
  }
}

/**
 * Bytes of the metrics log to read. Everything older is not consulted.
 *
 * The log is append-only and never rotated, and `indexBudget` reads it on the
 * SessionStart hook path -- so an unbounded read turns into startup latency
 * that grows forever on a long-lived project. Reading only the TAIL bounds both
 * the I/O and the parse, which slicing the parsed array alone did not: the
 * whole file still had to be read into memory first.
 *
 * It is also the right statistics. A saving measured months ago says little
 * about the code as it stands now.
 */
const MAX_BYTES = Number(process.env.TOKEN_OPTIMIZER_METRICS_BYTES) || 2_000_000;
const MAX_EVENTS = Number(process.env.TOKEN_OPTIMIZER_METRICS_WINDOW) || 5000;

/**
 * The event log, bounded. Exported because the forecast and calibration modules
 * are consumers of the same measured record -- duplicating the tail-reading
 * logic in each would be three places to get the bound wrong.
 */
export function readMetrics(dir) {
  return readAll(dir);
}

function readAll(dir) {
  const path = metricsPath(dir);
  if (!existsSync(path)) return [];

  let text;
  try {
    const { size } = statSync(path);
    if (size <= MAX_BYTES) {
      text = readFileSync(path, 'utf8');
    } else {
      // Seek to the tail rather than reading the whole file.
      const fd = openSync(path, 'r');
      try {
        const buffer = Buffer.allocUnsafe(MAX_BYTES);
        const read = readSync(fd, buffer, 0, MAX_BYTES, size - MAX_BYTES);
        text = buffer.subarray(0, read).toString('utf8');
      } finally {
        closeSync(fd);
      }
      // The first line is almost certainly cut mid-record; drop it rather than
      // letting it fail to parse and look like corruption.
      text = text.slice(text.indexOf('\n') + 1);
    }
  } catch {
    return [];
  }

  const out = [];
  for (const line of text.split('\n').slice(-MAX_EVENTS)) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A truncated final line is normal; skip it.
    }
  }
  return out;
}

/**
 * Balance records, read WITHOUT the event window that was starving them.
 *
 * Reads the dedicated log in full, and merges in whatever the firehose still
 * holds so graphs that predate the split are not left unmeasurable. Duplicates
 * are inevitable once both logs carry the same record, so they are removed on
 * an identity built from the fields that make an event unique.
 *
 * The byte cap still applies to the dedicated log, but it means something very
 * different here: these records are rare, so the cap is years of history rather
 * than hours, and it drops BOTH arms proportionally when it finally bites.
 */
/**
 * Every balance record in a file, with NO event window.
 *
 * The byte cap still bounds the read, because the firehose can be enormous. The
 * event cap does not apply: it is what buried these records in the first place,
 * and they are rare enough that keeping all of them inside the byte window costs
 * nothing.
 */
function scanForBalance(path) {
  if (!existsSync(path)) return [];
  let text = '';
  try {
    const { size } = statSync(path);
    if (size <= MAX_BYTES) {
      text = readFileSync(path, 'utf8');
    } else {
      const fd = openSync(path, 'r');
      try {
        const buffer = Buffer.allocUnsafe(MAX_BYTES);
        const read = readSync(fd, buffer, 0, MAX_BYTES, size - MAX_BYTES);
        text = buffer.subarray(0, read).toString('utf8');
      } finally {
        closeSync(fd);
      }
      text = text.slice(text.indexOf('\n') + 1);
    }
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (BALANCE_KINDS.has(e.kind)) out.push(e);
    } catch {
      /* a torn line costs a record, not the report */
    }
  }
  return out;
}

export function readBalance(dir) {
  const merged = [];
  const path = balancePath(dir);
  if (existsSync(path)) {
    let text = '';
    try {
      const { size } = statSync(path);
      if (size <= MAX_BYTES) {
        text = readFileSync(path, 'utf8');
      } else {
        const fd = openSync(path, 'r');
        try {
          const buffer = Buffer.allocUnsafe(MAX_BYTES);
          const read = readSync(fd, buffer, 0, MAX_BYTES, size - MAX_BYTES);
          text = buffer.subarray(0, read).toString('utf8');
        } finally {
          closeSync(fd);
        }
        text = text.slice(text.indexOf('\n') + 1);
      }
    } catch {
      text = '';
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        merged.push(JSON.parse(line));
      } catch {
        /* a torn line costs a record, not the report */
      }
    }
  }

  // MIGRATION, not a fallback. Every graph written before the split has its
  // only copy of these records in the firehose; ignoring them would reset the
  // measurement to zero on 122 existing graphs.
  //
  // IT MUST NOT GO THROUGH readAll. The first version of this fix did, and
  // readAll applies the very event window that was starving the measurement --
  // so the migration inherited the bug it existed to repair and the real graphs
  // still reported zero holdouts. Verified against them: unchanged at 0 until
  // this scan stopped windowing.
  for (const e of scanForBalance(metricsPath(dir))) merged.push(e);

  const seen = new Set();
  const out = [];
  for (const e of merged) {
    const id = [e.kind, e.at, e.anchor ?? '', e.sessionId ?? '', e.tokens ?? ''].join('|');
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(e);
  }
  return out;
}

/**
 * The report.
 *
 * `tokensAvoided` is an ESTIMATE and is labelled as one everywhere it appears.
 * It is the difference in mean downstream cost between the treated and holdout
 * arms, multiplied by treated touches. Reporting it as a measured fact would be
 * the same overclaiming this project criticises competitors for.
 */
export function report(dir) {
  const events = readAll(dir);
  // Injections and harvests come from the log that cannot be starved.
  const balance = readBalance(dir);

  // COMMAND INJECTIONS ARE COUNTED SEPARATELY, not mixed into the balance.
  //
  // The saving is measured by joining an injection to the READS of its anchor
  // afterwards. A command injection's anchor is the command text, which no read
  // event will ever match, so both arms would contribute zero downstream and
  // every command record would pull both means toward zero -- diluting a real
  // file-touch saving in proportion to how many commands ran.
  //
  // They still take part in the holdout, and are reported, because a structural
  // exclusion is how 95 of 136 injections came to be unmeasurable. What is
  // missing is a downstream join for them, and that is stated rather than
  // papered over with a number.
  const allInjections = balance.filter((e) => e.kind === 'inject');
  // `trigger` is the pre-`surface` spelling. Records written before the split
  // carry it and no surface at all, so keying only on surface would silently
  // file 95 historical command injections into the file-read balance -- exactly
  // the dilution the split exists to prevent.
  const isCommand = (e) => e.surface === 'command' || e.trigger === 'command';
  const commandInjections = allInjections.filter(isCommand);
  const injections = allInjections.filter((e) => !isCommand(e));
  const treated = injections.filter((e) => !e.holdout);
  const withheld = injections.filter((e) => e.holdout);

  const mean = (rows, field) =>
    rows.length ? rows.reduce((sum, r) => sum + (r[field] || 0), 0) / rows.length : 0;

  const injectedTokens = treated.reduce((sum, e) => sum + (e.tokens || 0), 0);
  const harvestTokens = balance
    .filter((e) => e.kind === 'harvest')
    .reduce((sum, e) => sum + (e.tokens || 0), 0);

  // DOWNSTREAM COST, JOINED FROM REAL READ EVENTS.
  //
  // This previously read a `downstream` field that NOTHING in the product ever
  // wrote -- only the tests and the demo seeder did. So both arm means were
  // zero, their difference was zero, and the headline saving would have been
  // reported as zero forever while every test passed. A metric whose only
  // producer is its own test suite is not a metric.
  //
  // The real quantity: tokens the session spent READING an anchor after it was
  // touched. In the treated arm the model often does not need the file, because
  // it already received the conclusions; in the control arm it does. That
  // difference is the saving, and `recordRead` below is what supplies it.
  // Grouped by (session, anchor) AND ordered by time, because "downstream"
  // means reads that happened AFTER the touch. Summing every read for the
  // anchor would credit the injection with reads that preceded it -- including
  // the very read that triggered the injection in the first place, which
  // inflates the treated arm with cost it did not cause.
  const reads = new Map();
  for (const event of events) {
    if (event.kind !== 'read' || !event.anchor) continue;
    const key = `${event.sessionId || ''}|${event.anchor}`;
    if (!reads.has(key)) reads.set(key, []);
    reads.get(key).push(event);
  }

  // How many injections share each key, so a key's read total is SPLIT between
  // them rather than charged in full to each. Without this the arm means scale
  // with injections-per-anchor instead of measuring per-touch cost: three
  // injections against one anchor each claimed the whole read total, tripling
  // the apparent downstream cost of that arm purely because it was touched more.
  const injectionsPerKey = new Map();
  for (const event of injections) {
    const key = `${event.sessionId || ''}|${event.anchor}`;
    injectionsPerKey.set(key, (injectionsPerKey.get(key) || 0) + 1);
  }

  const downstreamOf = (event) => {
    if (event.downstream != null) return event.downstream;
    const key = `${event.sessionId || ''}|${event.anchor}`;
    const bucket = reads.get(key);
    if (!bucket) return 0;

    const after = event.at ?? 0;
    const total = bucket.reduce(
      (sum, r) => sum + ((r.at ?? 0) >= after ? (r.tokens || 0) : 0), 0);

    // Split across the injections that share this key. Each touch is one
    // observation, so charging every one the full total would count the same
    // tokens repeatedly.
    return total / Math.max(1, injectionsPerKey.get(key) || 1);
  };

  const meanDownstream = (rows) =>
    rows.length ? rows.reduce((sum, r) => sum + downstreamOf(r), 0) / rows.length : 0;

  const treatedCost = meanDownstream(treated);
  const withheldCost = meanDownstream(withheld);

  const perTouchSaving = withheldCost - treatedCost;
  const estimatedAvoided = Math.max(0, Math.round(perTouchSaving * treated.length));

  // Below this, arm means are noise and a ratio would be theatre.
  const sufficient = treated.length >= 20 && withheld.length >= 5;

  return {
    injections: treated.length,
    commandInjections: commandInjections.length,
    commandHoldouts: commandInjections.filter((e) => e.holdout).length,
    holdouts: withheld.length,
    staleServed: injections.filter((e) => e.stale).length,
    staleRate: injections.length ? injections.filter((e) => e.stale).length / injections.length : 0,
    injectedTokens,
    harvestTokens,
    estimatedTokensAvoided: sufficient ? estimatedAvoided : null,
    netTokens: sufficient ? estimatedAvoided - injectedTokens - harvestTokens : null,
    sufficientData: sufficient,
    verdict: !sufficient
      ? `insufficient data (${treated.length} treated, ${withheld.length} holdout; need 20 and 5)`
      : estimatedAvoided > injectedTokens + harvestTokens
        ? 'the graph is saving more than it costs'
        : 'the graph is NOT yet paying for itself',
  };
}

/**
 * The substitution budget for ONE file, earned from measured effect.
 *
 * THIS IS THE PART A COMPETITOR CANNOT COPY. A fixed cap is a guess; ours is an
 * experiment. Every substitution for a file is a bet that annotating it prevents
 * downstream reading, and the holdout already measures exactly that -- so the
 * budget follows the evidence per file rather than a constant somebody tuned
 * once.
 *
 * A file whose annotations demonstrably suppress later reads earns more room. A
 * file whose annotations are ignored shrinks back toward a bare skeleton, which
 * costs almost nothing. Without a control arm there is no way to tell those two
 * apart, which is why nobody else can do this.
 */
export function substitutionBudget(dir, anchor, { floor = 300, base = 1200, ceiling = 3000 } = {}) {
  const events = readAll(dir);

  const mine = events.filter((e) => e.kind === 'inject' && e.anchor === anchor);
  const treated = mine.filter((e) => !e.holdout);
  const withheld = mine.filter((e) => e.holdout);

  // Below this the arms are noise; a new file starts at the default rather than
  // inheriting a verdict from three data points.
  if (treated.length < 4 || withheld.length < 2) return base;

  const reads = new Map();
  for (const event of events) {
    if (event.kind !== 'read' || event.anchor !== anchor) continue;
    const key = event.sessionId || '';
    if (!reads.has(key)) reads.set(key, []);
    reads.get(key).push(event);
  }

  const downstream = (rows) => {
    if (!rows.length) return 0;
    let total = 0;
    for (const row of rows) {
      const bucket = reads.get(row.sessionId || '') || [];
      const after = row.at ?? 0;
      total += bucket.reduce((sum, r) => sum + ((r.at ?? 0) >= after ? (r.tokens || 0) : 0), 0);
    }
    return total / rows.length;
  };

  const saved = downstream(withheld) - downstream(treated);
  const spent = treated.reduce((sum, e) => sum + (e.tokens || 0), 0) / treated.length;

  // Ratio of what annotating this file avoided to what annotating it cost.
  // Above 1 it is paying for itself and earns room; below, it shrinks.
  const ratio = spent > 0 ? saved / spent : 1;
  const scaled = Math.round(base * Math.max(0.25, Math.min(2.5, ratio)));
  return Math.max(floor, Math.min(ceiling, scaled));
}

/**
 * The earned index budget.
 *
 * Answers a real objection to a fixed cap: a mature project with a dense,
 * useful graph deserves a richer session index than a young one, but scaling
 * with graph SIZE makes the worst case unbounded exactly where the graph is
 * largest -- and size is not the same as usefulness.
 *
 * So the budget is earned from measured hit rate and bounded at both ends. A
 * graph whose index leads to queries grows its allowance; a noisy one shrinks
 * back toward the floor. Nobody configures it, and it cannot run away.
 */
export function indexBudget(dir, { floor = 150, base = 300, ceiling = 1200 } = {}) {
  const events = readAll(dir);
  const listed = events.filter((e) => e.kind === 'index').length;
  const queries = events.filter((e) => e.kind === 'query').length;

  if (listed < 5) return base;

  const hitRate = queries / listed;
  // 0% hit rate falls to the floor; ~50% and above reaches the ceiling.
  const scaled = Math.round(floor + (ceiling - floor) * Math.min(1, hitRate * 2));
  return Math.max(floor, Math.min(ceiling, scaled));
}
