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
  appendFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { redact } from './redact.mjs';

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
const evidencePath = (dir) => join(dir, 'evidence.jsonl');

/** Kinds the net balance is computed from, and which therefore must survive. */
/**
 * Kinds written to balance.jsonl as well as the firehose, so the event window can never
 * starve the measurement. Exported because any reader that needs the unwindowed truth needs to
 * know which kinds it applies to, and a second copy of this set elsewhere would drift.
 */
export const BALANCE_KINDS = new Set([
  'inject',
  'harvest',
  'substitute',
  // The forecast's own score. Both kinds are rare and accumulate slowly -- MIN_SCORED is 8 --
  // while the firehose they shared is dominated by per-tool-call records, so they were evicted
  // faster than they could accumulate: calibrate() returned 'not yet calibrated (n/8)' forever
  // and an outcome whose forecast had scrolled away was dropped with no record at all.
  'forecast',
  'forecast-outcome',
  // The keep-warm tripwire's evidence. It needs TRIPWIRE_MIN outcomes before it may have an
  // opinion, and there is one outcome per refresh -- so through the windowed reader the tenth
  // aged out before it was written and the backstop was structurally unable to fire, reporting
  // "only N/10 refreshes observed" for the life of the project.
  'keepwarm',
]);

/** Latest timestamp without passing an unbounded event log as function arguments. */
export const latestEventTimestamp = (rows) =>
  rows.reduce((latest, event) => Math.max(latest, Number(event.at) || 0), 0);

/**
 * Causal records have their own bounded log.  Tool outcomes are much rarer
 * than read/capture telemetry but more frequent than balance records; mixing
 * them into either window would eventually evict the evidence needed to join
 * an injection to its result.
 */
export const EVIDENCE_KINDS = new Set([
  'inject',
  'harvest',
  'tool-outcome',
  'episode-outcome',
  'eval-run',
  'handoff-run',
  'concurrency-run',
  'finding-feedback',
  'retrieval-decision',
  'mcp-client',
  'mcp-tool',
]);

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
  // SHA-256, NOT SHA-1.
  //
  // This is a bucketing hash, not a security primitive -- nothing is kept
  // secret and nothing is authenticated, only spread evenly across two arms.
  // But CodeQL flags sha1 as a weak algorithm, seven high-severity alerts
  // across the core and its six vendored copies, and arguing that a finding is
  // benign is a worse habit than paying a cost that rounds to nothing here.
  // Both are deterministic, which is the only property this depends on.
  //
  // The change DOES reassign arms: a given (anchor, epoch) may land on the
  // other side than before. With nine holdout records in existence that costs
  // nothing, and stratification is a fresh draw either way.
  const digest = createHash('sha256').update(`${anchorKey}:${epoch}`).digest();
  return digest[0] / 256 < fraction;
}

/**
 * Records what a read of an anchor actually cost.
 *
 * Called from the router whenever a read is ALLOWED through, which is the only
 * moment the cost is knowable. This is the producer that makes the holdout
 * comparison a measurement rather than a subtraction of two zeroes.
 */
export function recordRead(dir, { anchor, sessionId, bytes, fp = null }) {
  if (!anchor || !bytes) return;
  record(dir, {
    kind: 'read',
    anchor,
    sessionId,
    tokens: Math.ceil(bytes / 4),
    // THE CHANGE DETECTOR, recorded AT READ TIME.
    //
    // Without it, 'was this re-read wasteful' is undecidable. Measured before
    // this field existed: 575 repeat reads of a file within one session, and
    // only 99 could be classified -- 4,735 capture events carried anchors on
    // just 122 of them, because most captures are bookkeeping calls that touch
    // no file at all. The waste figure was 98% unknowable, and the 14.6M I
    // first reported was really 213,651 confirmed plus a very large shrug.
    //
    // It belongs on the READ, not on a capture: the read already knows the
    // anchor, the session and the cost, so the fingerprint completes the record
    // rather than needing to be joined to another one.
    fp,
  });
}

/**
 * A cheap fingerprint of a file's current content: size and mtime.
 *
 * NOT a content hash, deliberately. This runs on the PreToolUse path before
 * every tool call, and hashing a file there would add a full read to the
 * critical path for a measurement. `statSync` is already being done to resolve
 * the operand, so this is free.
 *
 * WHAT IT CAN MISS: a write that leaves both size and mtime identical. That
 * requires deliberately restoring the timestamp, so for the question being
 * asked -- did this file change between two reads in one session -- it is
 * sound. Stated here because a change-detector that silently misses changes
 * would understate legitimate re-reads and overstate waste, which is the
 * direction this project must never err in.
 */
export function fingerprint(path) {
  try {
    const st = statSync(path);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return null;
  }
}

/**
 * A unique id per record. Counter plus randomness: the counter separates
 * records written in the same millisecond by one process, the random suffix
 * separates concurrent processes, which detached workers routinely are.
 */
let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `${idCounter.toString(36)}-${randomBytes(4).toString('hex')}`;
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
    // The CALLER'S timestamp wins when it supplied one. Overwriting it made
    // `rereadWaste`'s ordering depend on write order rather than on `at`, so a
    // test that set explicit times was passing by luck.
    //
    // `id` EXISTS SO DEDUPE IS EXACT. A record is written to both logs, so the
    // reader has to drop one copy -- and it was matching on a composite of the
    // fields, which cannot tell a duplicate from two genuinely distinct events
    // that happen to look alike. Twenty-five identical injections written in a
    // single millisecond collapsed to ONE, so a graph with ample data reported
    // 'insufficient data (2 treated, 1 holdout)'. Real events were being
    // discarded by the deduplicator, silently.
    const id = event.id || nextId();
    const complete = {
      schemaVersion: event.schemaVersion || 2,
      id,
      ...event,
      // An injection id is first-class rather than an inference from the log
      // record id.  Exporters may rewrite record ids while preserving causal
      // identity, and downstream tool outcomes refer to this value explicitly.
      ...(event.kind === 'inject'
        ? { injectionId: event.injectionId || id }
        : {}),
      at: event.at ?? Date.now(),
    };
    const line = JSON.stringify(complete) + '\n';
    appendFileSync(metricsPath(dir), line);
    // Balance-critical records go to their own log as well, so the windows on
    // the firehose can never starve the measurement. Written SECOND: a torn
    // write here costs a duplicate the reader dedupes, not a lost event.
    if (BALANCE_KINDS.has(event.kind)) appendFileSync(balancePath(dir), line);
    if (EVIDENCE_KINDS.has(event.kind)) appendFileSync(evidencePath(dir), line);
    return complete;
  } catch {
    // Metrics must never break a tool call.
    return null;
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
const MAX_BYTES =
  Number(process.env.TOKEN_OPTIMIZER_METRICS_BYTES) || 2_000_000;
const MAX_EVENTS = Number(process.env.TOKEN_OPTIMIZER_METRICS_WINDOW) || 5000;

/**
 * The event log, bounded. Exported because the forecast and calibration modules
 * are consumers of the same measured record -- duplicating the tail-reading
 * logic in each would be three places to get the bound wrong.
 */
export function readMetrics(dir) {
  return readAll(dir);
}

/**
 * How the last readAll truncated, if it did.
 *
 * Returned out of band rather than on the array, because callers pass the
 * events around freely and a property hung on an array would be lost the first
 * time anything filtered it -- which is exactly how `eventsTruncated` came to
 * report only half the truth.
 */
let lastReadTruncation = { byBytes: false, byEvents: false };

export function readTruncation() {
  return { ...lastReadTruncation };
}

function readAll(dir) {
  lastReadTruncation = { byBytes: false, byEvents: false };
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
      lastReadTruncation.byBytes = true;
    }
  } catch {
    return [];
  }

  const out = [];
  const lines = text.split('\n');
  if (lines.length > MAX_EVENTS) lastReadTruncation.byEvents = true;
  for (const line of lines.slice(-MAX_EVENTS)) {
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
    // The record's OWN id when it has one. The composite below is the legacy
    // path for records written before ids existed; it is lossy by nature, which
    // is precisely why new records carry an id instead.
    const id =
      e.id ??
      [e.kind, e.at, e.anchor ?? '', e.sessionId ?? '', e.tokens ?? ''].join(
        '|'
      );
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(e);
  }
  return out;
}

/**
 * True when `readEvidence` could not have read the whole log -- the file
 * exceeds the byte cap, so anything written before the tail it kept is
 * silently absent from what it returned. A caller that builds a per-claim
 * record from `readEvidence` (the wiki graph's derivation record) needs this
 * to say "operations existed but are not recorded here" rather than let an
 * empty result read as "nothing happened".
 */
export function evidenceTruncated(dir) {
  const path = evidencePath(dir);
  try {
    return statSync(path).size > MAX_BYTES;
  } catch {
    return false;
  }
}

/** Every causal evidence record inside the byte cap, deduplicated by id. */
export function readEvidence(dir) {
  const path = evidencePath(dir);
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

  const seen = new Set();
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (!EVIDENCE_KINDS.has(event.kind)) continue;
      const id = event.id || JSON.stringify(event);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(event);
    } catch {
      // A concurrently appended final line may be torn.  It costs one record,
      // never the user's tool call or the rest of the evidence report.
    }
  }
  return out;
}

/**
 * The captured-output budget, in characters.
 *
 * Small enough that a 3 MB test log cannot bloat the evidence log or a single
 * injected claim, large enough to hold the stack trace or compiler diagnostic
 * that makes a failure finding worth anything.
 */
const OUTPUT_MAX_BYTES = 4096;

/**
 * Joins a post-tool result to the most recent matching injection.  The exact
 * tool-call id wins; clients that omit it fall back to episode + surface +
 * anchor, in timestamp order, and the report states the weaker join method.
 */
export function recordToolOutcome(dir, outcome) {
  const evidence = readEvidence(dir);
  const anchor = String(outcome.anchor || '').slice(0, 120);
  const candidates = evidence
    .filter(
      (event) =>
        event.kind === 'inject' && event.episodeId === outcome.episodeId
    )
    .filter((event) => {
      if (outcome.toolCallId && event.toolCallId)
        return String(event.toolCallId) === String(outcome.toolCallId);
      return (
        event.surface === outcome.surface &&
        String(event.anchor || '').slice(0, 120) === anchor
      );
    })
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  const injection = candidates[0] || null;
  const joinMethod = injection
    ? outcome.toolCallId && injection.toolCallId
      ? 'tool-call-id'
      : 'episode-anchor'
    : 'none';

  // REDACTED AND CAPPED HERE, not at the call site. A claim built from this
  // text is INJECTED into model context and EXPORTED to markdown, so the
  // boundary is the only place that can guarantee it: a second caller added
  // later would otherwise have to remember, and the one that forgot would leak
  // a secret into two more places than the terminal it came from. `undefined`
  // rather than `''` when nothing was captured, so JSON.stringify omits the
  // key entirely and an absent capture is distinguishable from an empty one.
  const output =
    outcome.output === undefined || outcome.output === null
      ? undefined
      : redact(String(outcome.output), { max: OUTPUT_MAX_BYTES });
  // NULL RATHER THAN 0 when nothing is reported. Most clients supply no numeric
  // code at all, and 0 is the success value -- defaulting to it would claim
  // every unreported call exited cleanly, which is a fabricated observation
  // rather than a missing one.
  const exit = Number.isInteger(outcome.exit) ? outcome.exit : null;

  return record(dir, {
    kind: 'tool-outcome',
    ...outcome,
    anchor,
    // AFTER the spread, so a caller cannot smuggle raw text past the boundary
    // by setting the field itself.
    output,
    exit,
    injectionId: injection?.injectionId || null,
    findingIds: injection?.findingIds || [],
    joinMethod,
  });
}

export function recordEpisodeOutcome(dir, outcome) {
  return record(dir, { kind: 'episode-outcome', ...outcome });
}

export function recordFindingFeedback(dir, feedback) {
  const rating = ['helpful', 'neutral', 'harmful'].includes(feedback?.rating)
    ? feedback.rating
    : 'neutral';
  return record(dir, { kind: 'finding-feedback', ...feedback, rating });
}

/**
 * Is this anchor a test fixture rather than real work?
 *
 * Not fussiness. Measured on this machine: 366 of 370 substitutions pointed at
 * the enforcement suite's own big.ts fixture under a temp dir, and counting them made
 * the product look like it had avoided 40 MB of reads. It had avoided 154 KB.
 * A balance sheet that counts its own test suite as revenue is worse than none.
 */
export function isFixtureAnchor(anchor) {
  const p = String(anchor || '');

  // TWO CONDITIONS, BOTH REQUIRED. The previous version was a ternary chain in
  // which every branch evaluated to `underTemp`, so the scratch test was dead
  // code: it excluded ALL temp paths -- including a real project checked out
  // under /tmp -- and on macOS excluded nothing at all, because tmpdir() there
  // is /var/folders/<x>/<y>/T/ and did not match.
  const underTemp = new RegExp(
    '[\\\\/](AppData[\\\\/]Local[\\\\/])?(Temp|tmp)[\\\\/]' +
      '|[\\\\/]var[\\\\/]folders[\\\\/][^\\\\/]+[\\\\/][^\\\\/]+[\\\\/]T[\\\\/]',
    'i'
  ).test(p);
  if (!underTemp) return false;

  // Only names this suite actually creates. A user's own scratch checkout under
  // a temp directory is real work and must still be counted.
  return /(to-hooks-|ab-[a-z]+-|cooccur-|holdout-|reread-|feedback-e2e|standing-e2e|lesson-origin|archive-|gen-eol-|tear-|edge-src|fixture)/i.test(
    p
  );
}

/**
 * The balance sheet, with every line labelled by HOW it is known.
 *
 * The shipped report counted every cost and one benefit that has never been
 * computable, so it was negative by construction. These are the two things
 * actually known, kept apart because they are known differently and must never
 * be summed into a single hero number:
 *
 *   MEASURED-COUNTERFACTUAL  substitution. The file size is known exactly and
 *                            the replacement's size is known exactly, so the
 *                            saving is arithmetic -- resting on the one
 *                            assumption that the model would have read what it
 *                            explicitly asked for.
 *   ESTIMATED-CAUSAL         findings injection, from the holdout. Genuinely
 *                            causal when it has samples, and worth far less
 *                            token-wise.
 *
 * Fixture anchors are excluded from both.
 */
/**
 * Re-read waste, split into what is KNOWN and what is not.
 *
 * The question is narrow on purpose: how often does one session read the same
 * file twice with the file UNCHANGED in between? That is waste the graph can
 * remove, and it needs no holdout, no estimate and no join -- the reads carry
 * their own fingerprints.
 *
 * A repeat read of a file that CHANGED is not waste and is reported as such.
 * Conflating the two is how the first version of this measurement turned
 * 213,651 confirmed tokens into a 14.6M headline.
 *
 * `undecidable` is reported rather than hidden. Reads written before the
 * fingerprint existed cannot be classified, and a measurement that quietly
 * counted them either way would be inventing its own answer.
 */
export function rereadWaste(
  dir,
  // `includeFixtures` exists so the suite can exercise this against files it
  // creates under the temp directory -- which the fixture filter otherwise
  // excludes by design, making the real path untestable.
  { events = readMetrics(dir), includeFixtures = false } = {}
) {
  const groups = new Map();
  for (const e of events) {
    if (e.kind !== 'read' || !e.anchor) continue;
    if (!includeFixtures && isFixtureAnchor(e.anchor)) continue;
    const key = `${e.sessionId || ''}|${canonicalKeyish(e.anchor)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const out = {
    repeats: 0,
    wasteful: 0,
    wastefulTokens: 0,
    legitimate: 0,
    legitimateTokens: 0,
    undecidable: 0,
    undecidableTokens: 0,
  };

  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => (a.at || 0) - (b.at || 0));
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      const tokens = cur.tokens || 0;
      out.repeats += 1;
      if (!prev.fp || !cur.fp) {
        out.undecidable += 1;
        out.undecidableTokens += tokens;
      } else if (prev.fp === cur.fp) {
        out.wasteful += 1;
        out.wastefulTokens += tokens;
      } else {
        out.legitimate += 1;
        out.legitimateTokens += tokens;
      }
    }
  }

  const decided = out.wasteful + out.legitimate;
  out.coverage = out.repeats ? decided / out.repeats : null;
  return out;
}

export function balanceSheet(dir) {
  const balance = readBalance(dir).filter((e) => !isFixtureAnchor(e.anchor));
  const events = readMetrics(dir);
  const truncation = readTruncation();

  const subs = balance.filter((e) => e.kind === 'substitute');
  const served = subs.filter((e) => !e.holdout);
  const withheldSubs = subs.filter((e) => e.holdout);

  // NET, not gross: the skeleton was still sent.
  const netAvoided = served.reduce(
    (sum, e) =>
      sum +
      (e.tokensNetAvoided ??
        Math.max(0, Math.ceil((e.bytesAvoided || 0) / 4) - (e.tokens || 0))),
    0
  );
  const substitutionCost = served.reduce((sum, e) => sum + (e.tokens || 0), 0);

  const injectCost = balance
    .filter((e) => e.kind === 'inject' && !e.holdout)
    .reduce((sum, e) => sum + (e.tokens || 0), 0);
  const harvestCost = balance
    .filter((e) => e.kind === 'harvest')
    .reduce((sum, e) => sum + (e.tokens || 0), 0);
  const standingCost = events
    .filter((e) => e.kind === 'standing')
    .reduce((sum, e) => sum + (e.tokens || 0), 0);

  // RE-READS, decided by fingerprint rather than assumed.
  const waste = rereadWaste(dir, { events });

  return {
    measuredCounterfactual: {
      what: 'substitution: a skeleton sent instead of the file the model asked for',
      substitutions: served.length,
      withheld: withheldSubs.length,
      tokensAvoidedNet: netAvoided,
      tokensSpent: substitutionCost,
      // THE CONTROL ARM'S ACTUAL COST. `tokensFullFile` was recorded and read
      // by nothing, so the comparison the holdout exists for was not
      // computable from the report.
      controlArmTokens: withheldSubs.reduce(
        (sum, e) => sum + (e.tokensFullFile || 0),
        0
      ),
      assumption:
        'that the model would have read the file it explicitly requested',
    },
    estimatedCausal: {
      what: 'findings injection, from the stratified holdout',
      ...(() => {
        const r = report(dir);
        return {
          treated: r.injections,
          holdouts: r.holdouts,
          tokensAvoided: r.estimatedTokensAvoided,
          sufficientData: r.sufficientData,
          verdict: r.verdict,
        };
      })(),
      // THE CONTROL ARM'S CONTENT, for the same reason `controlArmTokens` sits
      // in the substitution block above: `candidateCount` and
      // `shadowFindingIds` recorded what the holdout withheld and nothing read
      // them, so the report could count the arms and never say what was in
      // them.
      ...(() => {
        const shadow = shadowDelivery(dir);
        return {
          selected: shadow.selected,
          delivered: shadow.delivered,
          controlArmSelected: shadow.withheldSelected,
          controlArmFindings: shadow.withheldFindings,
          indexStaleEntries: shadow.staleEntries,
        };
      })(),
    },
    costs: {
      injection: injectCost,
      harvest: harvestCost,
      standing: standingCost,
      substitution: substitutionCost,
    },
    waste,
    // Deliberately NOT a single number. The two benefit lines are known
    // differently; adding them would launder an assumption into a measurement.
    // TWO WINDOWS, STATED RATHER THAN BLENDED. Balance records are read in
    // full; everything derived from `events` sees only the tail of
    // metrics.jsonl. Once that log rolls past its cap these cover different
    // periods, and a reader has to be able to see that rather than assume one
    // consistent balance.
    windows: {
      balance: 'all balance.jsonl records within the byte cap',
      events: `tail of metrics.jsonl (<= ${MAX_BYTES} bytes, <= ${MAX_EVENTS} events)`,
      // BOTH CAPS, from the reader itself. The previous flag tested the event
      // count only, so a log truncated by the BYTE cap with fewer than
      // MAX_EVENTS surviving records reported `false` -- the one case where the
      // window silently covers a shorter period than the balance side.
      eventsTruncated: truncation.byBytes || truncation.byEvents,
      truncatedBy: truncation,
    },
    note: 'benefit lines are reported separately by evidence strength and are never summed',
  };
}

/** Cheap path normalisation for grouping reads; not the identity canonicaliser. */
function canonicalKeyish(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

/**
 * The report.
 *
 * `tokensAvoided` is an ESTIMATE and is labelled as one everywhere it appears.
 * It is the difference in mean downstream cost between the treated and holdout
 * arms, multiplied by treated touches. Reporting it as a measured fact would be
 * the same overclaiming this project criticises competitors for.
 */
function buildReport(events, balance, sourceCoverage = {}) {
  const substitutions = balance.filter(
    (event) => event.kind === 'substitute' && !isFixtureAnchor(event.anchor)
  );
  const servedSubstitutions = substitutions.filter((event) => !event.holdout);
  const substitutionTokensSaved = servedSubstitutions.reduce(
    (sum, event) =>
      sum +
      (event.tokensNetAvoided ??
        Math.max(
          0,
          Math.ceil((event.bytesAvoided || 0) / 4) - (event.tokens || 0)
        )),
    0
  );
  const substitutionTokensReturned = servedSubstitutions.reduce(
    (sum, event) => sum + (event.tokens || 0),
    0
  );
  const substitutionByClient = {};
  for (const event of servedSubstitutions) {
    const name = event.client || 'Historical — client not recorded';
    const current = substitutionByClient[name] || {
      substitutions: 0,
      tokensReturned: 0,
      tokensSaved: 0,
    };
    current.substitutions += 1;
    current.tokensReturned += event.tokens || 0;
    current.tokensSaved +=
      event.tokensNetAvoided ??
      Math.max(
        0,
        Math.ceil((event.bytesAvoided || 0) / 4) - (event.tokens || 0)
      );
    substitutionByClient[name] = current;
  }

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
  // Session-start delivery has no file anchor or downstream read join either.
  // Report its cost independently so it cannot dilute the file-touch estimate.
  const isSessionStart = (e) => e.surface === 'session-start';
  const sessionStartInjections = allInjections.filter(isSessionStart);
  const commandInjections = allInjections.filter(
    (e) => !isSessionStart(e) && isCommand(e)
  );
  const injections = allInjections.filter(
    (e) => !isSessionStart(e) && !isCommand(e)
  );
  const treated = injections.filter((e) => !e.holdout);
  const withheld = injections.filter((e) => e.holdout);

  const mean = (rows, field) =>
    rows.length
      ? rows.reduce((sum, r) => sum + (r[field] || 0), 0) / rows.length
      : 0;

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
      (sum, r) => sum + ((r.at ?? 0) >= after ? r.tokens || 0 : 0),
      0
    );

    // Split across the injections that share this key. Each touch is one
    // observation, so charging every one the full total would count the same
    // tokens repeatedly.
    return total / Math.max(1, injectionsPerKey.get(key) || 1);
  };

  const meanDownstream = (rows) =>
    rows.length
      ? rows.reduce((sum, r) => sum + downstreamOf(r), 0) / rows.length
      : 0;

  const treatedCost = meanDownstream(treated);
  const withheldCost = meanDownstream(withheld);

  const perTouchSaving = withheldCost - treatedCost;
  const estimatedAvoided = Math.max(
    0,
    Math.round(perTouchSaving * treated.length)
  );

  const downstreamSamples = injections.filter((event) => {
    if (event.downstream != null) return true;
    const key = `${event.sessionId || ''}|${event.anchor}`;
    return (reads.get(key) || []).some(
      (read) => (read.at ?? 0) >= (event.at ?? 0)
    );
  }).length;
  const downstreamMeasured = downstreamSamples > 0;

  // Below this, arm means are noise and a ratio would be theatre.
  const sufficient =
    downstreamMeasured && treated.length >= 20 && withheld.length >= 5;

  const coverageNumber = (value, fallback) => {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : fallback;
  };
  const projectCount = coverageNumber(sourceCoverage.projects, 1);
  const telemetryProjects = coverageNumber(
    sourceCoverage.projectsWithTelemetry,
    0
  );
  const balanceProjects = coverageNumber(
    sourceCoverage.projectsWithBalanceEvents,
    balance.length ? 1 : 0
  );
  const lastEventAt = Math.max(
    latestEventTimestamp(events),
    latestEventTimestamp(balance)
  );
  const measured =
    telemetryProjects > 0 || events.length > 0 || balance.length > 0;
  const balanceMeasured = balanceProjects > 0 || balance.length > 0;
  const metric = (status, source, samples, extra = {}) => ({
    status,
    source,
    samples,
    ...extra,
  });

  return {
    nativeOptimizer: {
      substitutions: servedSubstitutions.length,
      holdouts: substitutions.filter((event) => event.holdout).length,
      tokensReturned: substitutionTokensReturned,
      tokensSaved: substitutionTokensSaved,
      byClient: substitutionByClient,
      recent: servedSubstitutions
        .slice()
        .sort((a, b) => (b.at || 0) - (a.at || 0))
        .slice(0, 40)
        .map((event) => {
          const tokensSaved =
            event.tokensNetAvoided ??
            Math.max(
              0,
              Math.ceil((event.bytesAvoided || 0) / 4) - (event.tokens || 0)
            );
          return {
            name: 'live_graph_substitution',
            client: event.client || 'Historical — client not recorded',
            originalTokens: (event.tokens || 0) + tokensSaved,
            optimizedTokens: event.tokens || 0,
            tokensSaved,
            savingsMeasured: false,
            classification: 'modeled-counterfactual',
            reportedTokensSaved: tokensSaved,
            timestamp: event.at ? new Date(event.at).toISOString() : null,
          };
        }),
      source:
        'balance.jsonl: modeled full-file counterfactual minus annotated-skeleton tokens; excluded from verified MCP savings',
    },
    memoryDeliveries: allInjections.filter((event) => !event.holdout).length,
    memoryHoldouts: allInjections.filter((event) => event.holdout).length,
    deliveryTokens: allInjections
      .filter((event) => !event.holdout)
      .reduce(
        (sum, event) => sum + (event.deliveredTokens ?? event.tokens ?? 0),
        0
      ),
    injections: treated.length,
    sessionStartInjections: sessionStartInjections.length,
    sessionStartInjectedTokens: sessionStartInjections.reduce(
      (sum, event) => sum + (event.deliveredTokens ?? event.tokens ?? 0),
      0
    ),
    commandInjections: commandInjections.length,
    commandHoldouts: commandInjections.filter((e) => e.holdout).length,
    holdouts: withheld.length,
    staleServed: injections.filter((e) => e.stale).length,
    staleRate: injections.length
      ? injections.filter((e) => e.stale).length / injections.length
      : 0,
    injectedTokens,
    harvestTokens,
    estimatedTokensAvoided: sufficient ? estimatedAvoided : null,
    netTokens: sufficient
      ? estimatedAvoided - injectedTokens - harvestTokens
      : null,
    sufficientData: sufficient,
    verdict: !sufficient
      ? `insufficient data (${treated.length} treated, ${withheld.length} holdout; need 20 and 5)`
      : estimatedAvoided > injectedTokens + harvestTokens
        ? 'the graph is saving more than it costs'
        : 'the graph is NOT yet paying for itself',
    measurement: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceCoverage: {
        projects: projectCount,
        projectsWithTelemetry: telemetryProjects || (measured ? 1 : 0),
        projectsWithBalanceEvents: balanceProjects,
        projectsWithoutTelemetry: Math.max(
          0,
          projectCount - (telemetryProjects || (measured ? 1 : 0))
        ),
      },
      freshness: {
        lastEventAt: lastEventAt || null,
        ageMs: lastEventAt ? Math.max(0, Date.now() - lastEventAt) : null,
        status: !lastEventAt
          ? 'not-measured'
          : Date.now() - lastEventAt <= 7 * 86_400_000
            ? 'fresh'
            : 'stale',
      },
      metrics: {
        nativeSubstitutions: metric(
          balanceMeasured ? 'measured' : 'not-measured',
          'balance.jsonl: modeled full-file counterfactual minus annotated-skeleton tokens; not a materialized MCP before/after pair',
          servedSubstitutions.length,
          { classification: 'modeled-counterfactual' }
        ),
        memoryDeliveries: metric(
          balanceMeasured ? 'measured' : 'not-measured',
          'balance.jsonl: inject events in the treated arm',
          allInjections.filter((event) => !event.holdout).length
        ),
        memoryHoldouts: metric(
          balanceMeasured ? 'measured' : 'not-measured',
          'balance.jsonl: inject events in the withheld arm',
          allInjections.filter((event) => event.holdout).length
        ),
        rememberingCost: metric(
          balanceMeasured ? 'measured' : 'not-measured',
          'balance.jsonl: delivered injection tokens plus semantic harvest tokens',
          allInjections.length +
            balance.filter((event) => event.kind === 'harvest').length
        ),
        readingAvoided: metric(
          !downstreamMeasured
            ? 'not-measured'
            : sufficient
              ? 'measured'
              : 'collecting',
          'stratified file-touch holdout joined to downstream read events',
          downstreamSamples,
          {
            treated: treated.length,
            holdouts: withheld.length,
            requiredTreated: 20,
            requiredHoldouts: 5,
          }
        ),
      },
    },
  };
}

export function report(dir) {
  const events = readAll(dir);
  const balance = readBalance(dir);
  return buildReport(events, balance, {
    projects: 1,
    projectsWithTelemetry: events.length || balance.length ? 1 : 0,
    projectsWithBalanceEvents: balance.length ? 1 : 0,
  });
}

/**
 * One statistically valid machine/project-group report.
 *
 * Summing per-project verdicts is wrong: five projects with four treated reads
 * each do not individually meet the threshold, but together they are twenty
 * observations. Pooling the underlying events preserves the randomized arms
 * and computes the means once over the selected population.
 */
export function reportMany(dirs) {
  const unique = [...new Set((dirs || []).map((dir) => String(dir)))];
  const eventSources = unique.map((dir) => readAll(dir));
  const balanceSources = unique.map((dir) => readBalance(dir));
  const report = buildReport(eventSources.flat(), balanceSources.flat(), {
    projects: unique.length,
    projectsWithTelemetry: eventSources.filter(
      (events, index) => events.length || balanceSources[index].length
    ).length,
    projectsWithBalanceEvents: balanceSources.filter((events) => events.length)
      .length,
  });
  return { ...report, projects: unique.length };
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
export function substitutionBudget(
  dir,
  anchor,
  { floor = 300, base = 1200, ceiling = 3000 } = {}
) {
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
      total += bucket.reduce(
        (sum, r) => sum + ((r.at ?? 0) >= after ? r.tokens || 0 : 0),
        0
      );
    }
    return total / rows.length;
  };

  const saved = downstream(withheld) - downstream(treated);
  const spent =
    treated.reduce((sum, e) => sum + (e.tokens || 0), 0) / treated.length;

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
export function indexBudget(
  dir,
  { floor = 150, base = 300, ceiling = 1200 } = {}
) {
  const events = readAll(dir);
  const listed = events.filter((e) => e.kind === 'index').length;
  const queries = events.filter((e) => e.kind === 'query').length;

  if (listed < 5) return base;

  const hitRate = queries / listed;
  // 0% hit rate falls to the floor; ~50% and above reaches the ceiling.
  const scaled = Math.round(
    floor + (ceiling - floor) * Math.min(1, hitRate * 2)
  );
  return Math.max(floor, Math.min(ceiling, scaled));
}

/**
 * What retrieval decided NOT to inject, and why.
 *
 * THE OTHER HALF OF THE BUDGET, and it had no reader. `assessFindings` rejects a
 * finding for one of three reasons -- it has been quarantined as harmful, it is
 * in cooldown after being injected recently, or its expected value is negative
 * -- and inject.mjs records every one of those decisions as a
 * `retrieval-decision` event, from four separate call sites. Nothing read them.
 *
 * WHY THAT MATTERS RATHER THAN BEING TIDY. #204 makes the per-touch token budget
 * load-bearing: "without it the most heavily-worked files accumulate the most
 * findings and become the most expensive to touch, and the optimizer becomes
 * its own token problem." A budget that silently drops what it cannot afford is
 * indistinguishable, from outside, from a graph that had nothing to say. These
 * are the two states a user most needs told apart, and the records to tell them
 * apart were already being written.
 *
 * READ FROM THE EVIDENCE LOG, not the firehose. `retrieval-decision` is in
 * EVIDENCE_KINDS precisely because it is rare relative to per-tool-call
 * telemetry, and the windowed reader would evict it before it accumulated --
 * the same eviction that made `report()` say "0 holdout" over a file containing
 * nine.
 */
export function declinedAtBudget(dir, { limit = 500 } = {}) {
  const decisions = readEvidence(dir)
    .filter((event) => event.kind === 'retrieval-decision')
    .slice(-limit);

  const byReason = new Map();
  const keys = new Set();
  let declined = 0;
  for (const decision of decisions) {
    for (const item of decision.rejected || []) {
      declined += 1;
      if (item.key) keys.add(item.key);
      // An unlabelled rejection is counted, not dropped: an unknown reason is
      // still a finding the model did not get, and reporting the count as
      // smaller than it is would understate exactly the cost this exists to
      // surface.
      const reason = item.reason || 'unspecified';
      byReason.set(reason, (byReason.get(reason) || 0) + 1);
    }
  }

  return {
    decisions: decisions.length,
    declined,
    distinctFindings: keys.size,
    byReason: [...byReason.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count })),
  };
}

/**
 * The injection arm's SHADOW: what retrieval selected, against what was served.
 *
 * THE SAME GAP `controlArmTokens` WAS CREATED TO CLOSE, one arm over. That
 * field exists because `tokensFullFile` "was recorded and read by nothing, so
 * the comparison the holdout exists for was not computable from the report" --
 * and the injection side had the identical hole: every `inject` record carries
 * `candidateCount` and `shadowFindingIds`, which are what WOULD have been
 * delivered, non-zero in BOTH arms, while `count` and `findingIds` go to zero
 * in the holdout. The shadow pair was written on every injection since the
 * holdout shipped and read by nothing, so the report could say how many touches
 * landed in each arm and never which findings the holdout actually withheld.
 *
 * `staleCount` is the same shape on the session-start index: `stale` (a
 * boolean, "was any of this stale") had a reader, the count did not, so a index
 * with one rotten entry in forty was indistinguishable from one rotten
 * throughout.
 *
 * READ FROM THE BALANCE LOG, because `inject` is a BALANCE_KIND: the firehose
 * evicts injections first -- 136 of them against 6,725 captures on one machine
 * -- which is the eviction that made `report()` say "0 holdout" over a file
 * containing nine.
 */
export function shadowDelivery(dir) {
  const injections = readBalance(dir).filter((event) => event.kind === 'inject');

  let selected = 0;
  let delivered = 0;
  let withheldSelected = 0;
  const withheldKeys = new Set();
  let staleEntries = 0;
  let indexRecords = 0;

  for (const event of injections) {
    const candidates = Number(event.candidateCount) || 0;
    selected += candidates;
    delivered += Number(event.count) || 0;
    if (event.holdout) {
      withheldSelected += candidates;
      for (const key of event.shadowFindingIds || []) withheldKeys.add(key);
    }
    if (event.surface === 'session-start') {
      indexRecords += 1;
      staleEntries += Number(event.staleCount) || 0;
    }
  }

  return {
    injections: injections.length,
    // Everything retrieval chose, across both arms.
    selected,
    // What actually reached a model.
    delivered,
    // Chosen and deliberately not delivered, because the anchor was in the
    // withheld arm. This is the control arm's content, which is the thing the
    // holdout exists to make comparable.
    withheldSelected,
    withheldFindings: withheldKeys.size,
    // Index staleness as a rate rather than a boolean.
    indexRecords,
    staleEntries,
  };
}

/**
 * Which MCP clients have actually handshaked with this server.
 *
 * `mcp-client` was written on every `initialize` and read by nothing -- a
 * producer with no reader, and the last one the census found. Deleting it was
 * the other option and would have been wrong: `mcp-tool` records a client only
 * once it CALLS something, and the project registry records a name only, so a
 * client that connected and then called nothing -- which is exactly the failure
 * this project's doctor exists to diagnose -- appeared in neither. The
 * handshake is the only record that a connection happened at all.
 *
 * `clientTitle` is the field that made the record unique and it was unread too:
 * the display name a client reports for itself, which is how a user recognises
 * their own editor in a list where `name` is a slug.
 */
export function mcpClientsSeen(dir, { limit = 200 } = {}) {
  const seen = new Map();
  for (const event of readEvidence(dir)) {
    if (event.kind !== 'mcp-client') continue;
    const name = String(event.client || 'unknown');
    const at = Number(event.at) || 0;
    const previous = seen.get(name);
    // LAST HANDSHAKE WINS on the mutable fields: a client that upgraded should
    // be reported at the version it is now, not the one it first connected on.
    if (!previous || at >= previous.at) {
      seen.set(name, {
        client: name,
        title: event.clientTitle || null,
        version: event.clientVersion || null,
        at,
        connections: (previous?.connections || 0) + 1,
      });
    } else {
      previous.connections += 1;
    }
  }
  return [...seen.values()].sort((a, b) => b.at - a.at).slice(0, limit);
}

/* ----------------------------------------------------------------------
 * Episode-level causal evidence
 * ------------------------------------------------------------------- */

const numeric = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const average = (values) => {
  const finite = values.map(numeric).filter((value) => value !== null);
  return finite.length
    ? finite.reduce((sum, value) => sum + value, 0) / finite.length
    : null;
};

/** Deterministic PRNG so regenerating a report does not move its interval. */
function seededRandom(seedText) {
  let seed = 2166136261;
  for (const char of String(seedText)) {
    seed ^= char.charCodeAt(0);
    seed = Math.imul(seed, 16777619);
  }
  return () => {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap interval for a mean, paired delta, or other scalar. */
export function bootstrapMeanInterval(
  values,
  { samples = 1000, seed = 'token-optimizer' } = {}
) {
  const finite = values.map(numeric).filter((value) => value !== null);
  if (!finite.length) return { mean: null, low: null, high: null, n: 0 };
  if (finite.length === 1) {
    return { mean: finite[0], low: finite[0], high: finite[0], n: 1 };
  }

  const random = seededRandom(`${seed}:${finite.join(',')}`);
  const means = [];
  for (let sample = 0; sample < samples; sample++) {
    let total = 0;
    for (let index = 0; index < finite.length; index++) {
      total += finite[Math.floor(random() * finite.length)];
    }
    means.push(total / finite.length);
  }
  means.sort((a, b) => a - b);
  return {
    mean: average(finite),
    low: means[Math.floor(means.length * 0.025)],
    high: means[Math.min(means.length - 1, Math.floor(means.length * 0.975))],
    n: finite.length,
  };
}

/** Wilson interval keeps small correctness samples honest and inside 0..1. */
export function proportionInterval(successes, total, z = 1.96) {
  if (!total) return { rate: null, low: null, high: null, n: 0 };
  const rate = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = (rate + (z * z) / (2 * total)) / denominator;
  const radius =
    (z / denominator) *
    Math.sqrt((rate * (1 - rate)) / total + (z * z) / (4 * total * total));
  return {
    rate,
    low: Math.max(0, centre - radius),
    high: Math.min(1, centre + radius),
    n: total,
  };
}

const cohortKey = (run) =>
  [
    run.client || 'unknown',
    run.clientVersion || 'unknown',
    run.model || 'unknown',
    run.modelVersion || 'unknown',
    run.taskId || 'unknown',
  ].join('|');

function armMetrics(runs) {
  const correct = runs.filter((run) => run.correct === true).length;
  const interval = (field) =>
    bootstrapMeanInterval(
      runs.map((run) => run[field]).filter((value) => numeric(value) !== null),
      { seed: field }
    );
  return {
    runs: runs.length,
    correctness: proportionInterval(correct, runs.length),
    uncachedInputTokens: interval('uncachedInputTokens'),
    cacheCreationInputTokens: interval('cacheCreationInputTokens'),
    cachedInputTokens: interval('cachedInputTokens'),
    outputTokens: interval('outputTokens'),
    totalTokens: interval('totalTokens'),
    toolCalls: interval('toolCalls'),
    failedToolCalls: interval('failedToolCalls'),
    latencyMs: interval('latencyMs'),
    costUsd: interval('costUsd'),
    injectedTokens: interval('injectedTokens'),
    harmfulFindings: runs.reduce(
      (sum, run) => sum + (numeric(run.harmfulFindings) || 0),
      0
    ),
  };
}

function pairedEffects(
  runs,
  controlArm,
  treatmentArm,
  contrastType = 'incremental'
) {
  const pairs = new Map();
  for (const run of runs) {
    if (!run.pairId || ![controlArm, treatmentArm].includes(run.arm)) continue;
    if (!pairs.has(run.pairId)) pairs.set(run.pairId, {});
    pairs.get(run.pairId)[run.arm] = run;
  }
  const complete = [...pairs.values()].filter(
    (pair) => pair[controlArm] && pair[treatmentArm]
  );
  const delta = (field, lowerIsBetter = true) =>
    bootstrapMeanInterval(
      complete
        .map((pair) => {
          const baseline = numeric(pair[controlArm][field]);
          const treatment = numeric(pair[treatmentArm][field]);
          if (baseline === null || treatment === null) return null;
          return lowerIsBetter ? baseline - treatment : treatment - baseline;
        })
        .filter((value) => value !== null),
      { seed: `${controlArm}:${treatmentArm}:${field}` }
    );
  return {
    arm: treatmentArm,
    controlArm,
    comparison: `${treatmentArm} vs ${controlArm}`,
    contrastType,
    pairs: complete.length,
    // Positive values always mean the treatment improved the metric.
    totalTokensSaved: delta('totalTokens'),
    uncachedInputTokensSaved: delta('uncachedInputTokens'),
    cacheCreationInputTokensSaved: delta('cacheCreationInputTokens'),
    cachedInputTokensSaved: delta('cachedInputTokens'),
    outputTokensSaved: delta('outputTokens'),
    toolCallsAvoided: delta('toolCalls'),
    latencyMsSaved: delta('latencyMs'),
    costUsdSaved: delta('costUsd'),
    correctnessDelta: delta('correct', false),
  };
}

function matchesFilters(event, filters) {
  for (const field of [
    'client',
    'clientVersion',
    'model',
    'modelVersion',
    'taskId',
    'arm',
  ]) {
    if (!filters[field]) continue;
    let actual = event[field];
    if (event.kind === 'handoff-run') {
      actual =
        field === 'taskId'
          ? event.scenarioId
          : field === 'arm'
            ? event.arm
            : (event.consumer?.[field] ??
              event.producer?.[field] ??
              event[field]);
    } else if (event.kind === 'concurrency-run') {
      actual =
        field === 'taskId'
          ? 'concurrent-combined'
          : field === 'arm'
            ? event.arm
            : (event.consumer?.[field] ?? event[field]);
    }
    if (String(actual || '') !== String(filters[field])) return false;
  }
  return true;
}

function handoffArmMetrics(runs) {
  const consumers = runs.map((run) => run.consumer || {});
  const count = (field) =>
    consumers.filter((consumer) => consumer[field] === true).length;
  const interval = (field) =>
    bootstrapMeanInterval(
      consumers
        .map((consumer) => consumer[field])
        .filter((value) => numeric(value) !== null),
      { seed: `handoff:${field}` }
    );
  return {
    runs: runs.length,
    delivery: proportionInterval(
      runs.filter((run) => run.delivery?.delivered === true).length,
      runs.length
    ),
    correctness: proportionInterval(count('correct'), runs.length),
    firstPass: proportionInterval(count('firstPass'), runs.length),
    mistakeAttempted: proportionInterval(
      count('mistakeAttempted'),
      runs.length
    ),
    mistakeExecuted: proportionInterval(count('mistakeExecuted'), runs.length),
    totalTokens: interval('totalTokens'),
    toolCalls: interval('toolCalls'),
    failedToolCalls: interval('failedToolCalls'),
    latencyMs: interval('latencyMs'),
  };
}

function handoffPairedEffect(runs, controlArm, treatmentArm) {
  const pairs = new Map();
  for (const run of runs) {
    if (!run.pairId || ![controlArm, treatmentArm].includes(run.arm)) continue;
    if (!pairs.has(run.pairId)) pairs.set(run.pairId, {});
    pairs.get(run.pairId)[run.arm] = run;
  }
  const complete = [...pairs.values()].filter(
    (pair) => pair[controlArm] && pair[treatmentArm]
  );
  const effect = (field, positiveWhenLower = true) =>
    bootstrapMeanInterval(
      complete
        .map((pair) => {
          const control = numeric(pair[controlArm].consumer?.[field]);
          const treatment = numeric(pair[treatmentArm].consumer?.[field]);
          if (control === null || treatment === null) return null;
          return positiveWhenLower ? control - treatment : treatment - control;
        })
        .filter((value) => value !== null),
      { seed: `handoff:${controlArm}:${treatmentArm}:${field}` }
    );
  return {
    comparison: `${treatmentArm} vs ${controlArm}`,
    pairs: complete.length,
    attemptedMistakesPrevented: effect('mistakeAttempted'),
    executedMistakesPrevented: effect('mistakeExecuted'),
    firstPassDelta: effect('firstPass', false),
    correctnessDelta: effect('correct', false),
    totalTokensSaved: effect('totalTokens'),
    toolCallsAvoided: effect('toolCalls'),
    failedToolCallsAvoided: effect('failedToolCalls'),
    latencyMsSaved: effect('latencyMs'),
  };
}

const handoffKey = (run) =>
  [
    run.producer?.client || 'unknown',
    run.producer?.model || 'unknown',
    run.consumer?.client || 'unknown',
    run.consumer?.model || 'unknown',
    run.scenarioId || 'unknown',
  ].join('|');

const HANDOFF_REPORT_ARMS = [
  'empty',
  'natural',
  'oracle',
  'irrelevant',
  'stale',
];
const handoffMinimumPairs = () =>
  Math.max(2, Number(process.env.TOKEN_OPTIMIZER_HANDOFF_MIN_PAIRS) || 10);

function handoffCohorts(runs) {
  const grouped = new Map();
  for (const run of runs) {
    const key = handoffKey(run);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(run);
  }
  const minimumPairs = handoffMinimumPairs();
  return [...grouped.entries()].map(([key, rows]) => {
    const arms = Object.fromEntries(
      HANDOFF_REPORT_ARMS.map((arm) => [
        arm,
        handoffArmMetrics(rows.filter((row) => row.arm === arm)),
      ])
    );
    const naturalRows = rows.filter((row) => row.arm === 'natural');
    const naturalVsEmpty = handoffPairedEffect(rows, 'empty', 'natural');
    const naturalVsOracle = handoffPairedEffect(rows, 'oracle', 'natural');
    const captureRate = naturalRows.length
      ? naturalRows.filter((row) => row.producer?.captureSuccess).length /
        naturalRows.length
      : null;
    const preActionDeliveryRate = naturalRows.length
      ? naturalRows.filter((row) => row.delivery?.beforeFirstExecutedMistake)
          .length / naturalRows.length
      : null;
    const emptyRecurrence = arms.empty.mistakeExecuted.rate;
    const naturalRecurrence = arms.natural.mistakeExecuted.rate;
    const relativeRecurrenceReduction =
      emptyRecurrence !== null &&
      naturalRecurrence !== null &&
      emptyRecurrence !== 0
        ? (emptyRecurrence - naturalRecurrence) / emptyRecurrence
        : null;
    const controlsSafe = ['irrelevant', 'stale'].every(
      (arm) =>
        arms[arm].correctness.rate !== null &&
        arms.empty.correctness.rate !== null &&
        arms[arm].correctness.rate >= arms.empty.correctness.rate - 0.1
    );
    const irrelevantSuppressed =
      arms.irrelevant.delivery.rate !== null &&
      arms.irrelevant.delivery.rate === 0;
    const gates = {
      minimumPairs: naturalVsEmpty.pairs >= minimumPairs,
      capture: captureRate !== null && captureRate >= 0.8,
      recurrenceMagnitude:
        relativeRecurrenceReduction !== null &&
        relativeRecurrenceReduction >= 0.5,
      recurrenceInterval:
        (naturalVsEmpty.executedMistakesPrevented.low ?? -Infinity) > 0,
      correctness:
        arms.natural.correctness.rate !== null &&
        arms.empty.correctness.rate !== null &&
        arms.natural.correctness.rate >= arms.empty.correctness.rate - 0.1,
      preActionDelivery:
        preActionDeliveryRate !== null && preActionDeliveryRate >= 0.8,
      negativeControls: controlsSafe && irrelevantSuppressed,
    };
    const claimReady = Object.values(gates).every(Boolean);
    return {
      key,
      producerClient: rows[0]?.producer?.client || 'unknown',
      producerModel: rows[0]?.producer?.model || null,
      consumerClient: rows[0]?.consumer?.client || 'unknown',
      consumerModel: rows[0]?.consumer?.model || null,
      scenarioId: rows[0]?.scenarioId || null,
      arms,
      effects: { naturalVsEmpty, naturalVsOracle },
      captureRate,
      preActionDeliveryRate,
      relativeRecurrenceReduction,
      gates,
      evidenceStatus: claimReady
        ? 'pre-registered transfer gates passed'
        : `insufficient or failed transfer gates (need ${minimumPairs} pairs)`,
    };
  });
}

function concurrencySummary(runs) {
  const natural = runs.filter((run) => run.arm === 'natural');
  const writers = natural.reduce((sum, run) => sum + (run.writerCount || 0), 0);
  const captures = natural.reduce(
    (sum, run) => sum + (run.captureSuccesses || 0),
    0
  );
  const integrityPasses = natural.filter(
    (run) =>
      run.integrity?.zeroLoss &&
      run.integrity?.parseable &&
      run.integrity?.orphanedFindings === 0
  ).length;
  const delivered = natural.reduce(
    (sum, run) => sum + (run.delivery?.delivered || 0),
    0
  );
  const expected = natural.reduce(
    (sum, run) => sum + (run.delivery?.expected || 0),
    0
  );
  const effect = handoffPairedEffect(runs, 'empty', 'natural');
  return {
    runs: runs.length,
    naturalRuns: natural.length,
    writers,
    captureRate: writers ? captures / writers : null,
    integrityPassRate: natural.length ? integrityPasses / natural.length : null,
    deliveryCoverage: expected ? delivered / expected : null,
    naturalCorrectness: proportionInterval(
      natural.filter((run) => run.consumer?.correct).length,
      natural.length
    ),
    effect,
  };
}

/**
 * The dashboard-facing evidence console.  Deterministic fixture verification,
 * live hook traces, and randomized model evals remain visibly distinct: only
 * `eval-run` records with paired arms can produce a causal effect interval.
 */
function buildEvidenceReport(
  evidence,
  { filters = {}, episodeLimit = 100 } = {}
) {
  evidence = evidence.filter((event) => matchesFilters(event, filters));
  const runs = evidence.filter((event) => event.kind === 'eval-run');
  const handoffRuns = evidence.filter((event) => event.kind === 'handoff-run');
  const concurrencyRuns = evidence.filter(
    (event) => event.kind === 'concurrency-run'
  );
  const injections = evidence.filter((event) => event.kind === 'inject');
  const outcomes = evidence.filter((event) => event.kind === 'tool-outcome');
  const feedback = evidence.filter(
    (event) => event.kind === 'finding-feedback'
  );

  const byInjection = new Map(
    outcomes
      .filter((event) => event.injectionId)
      .map((event) => [event.injectionId, event])
  );
  const traced = injections
    .slice()
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, Math.max(1, Math.min(500, episodeLimit)))
    .map((injection) => ({
      injectionId: injection.injectionId,
      episodeId: injection.episodeId || injection.sessionId || null,
      at: injection.at,
      arm: injection.arm || (injection.holdout ? 'holdout' : 'treated'),
      client: injection.client || 'unknown',
      clientVersion: injection.clientVersion || null,
      model: injection.model || null,
      taskId: injection.taskId || null,
      surface: injection.surface || injection.trigger || 'file',
      anchor: injection.anchor,
      findingIds: injection.findingIds || [],
      deliveredTokens: injection.deliveredTokens ?? injection.tokens ?? 0,
      shadowTokens: injection.shadowTokens ?? injection.tokens ?? 0,
      outcome: byInjection.get(injection.injectionId) || null,
    }));

  const grouped = new Map();
  for (const run of runs) {
    const key = cohortKey(run);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(run);
  }

  const minimumPairs = Math.max(
    2,
    Number(process.env.TOKEN_OPTIMIZER_EVAL_MIN_PAIRS) || 5
  );
  const cohorts = [...grouped.entries()].map(([key, cohortRuns]) => {
    const arms = Object.fromEntries(
      ['baseline', 'optimizer', 'retrieval', 'full'].map((arm) => [
        arm,
        armMetrics(cohortRuns.filter((run) => run.arm === arm)),
      ])
    );
    const effects = [
      pairedEffects(cohortRuns, 'baseline', 'optimizer'),
      pairedEffects(cohortRuns, 'optimizer', 'retrieval'),
      pairedEffects(cohortRuns, 'retrieval', 'full'),
      pairedEffects(cohortRuns, 'baseline', 'full', 'total-system'),
    ];
    const enough = effects.every((effect) => effect.pairs >= minimumPairs);
    return {
      key,
      client: cohortRuns[0]?.client || 'unknown',
      clientVersion: cohortRuns[0]?.clientVersion || null,
      model: cohortRuns[0]?.model || null,
      modelVersion: cohortRuns[0]?.modelVersion || null,
      taskId: cohortRuns[0]?.taskId || null,
      arms,
      effects,
      evidenceStatus: enough
        ? 'causal estimate available'
        : `insufficient paired runs (need ${minimumPairs})`,
    };
  });

  const joined = injections.filter((injection) =>
    byInjection.has(injection.injectionId)
  ).length;
  const harmful = feedback.filter((event) => event.rating === 'harmful').length;
  const transferCohorts = handoffCohorts(handoffRuns);
  const concurrency = concurrencySummary(concurrencyRuns);
  return {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    filters,
    summary: {
      liveInjections: injections.length,
      joinedOutcomes: joined,
      causalJoinCoverage: injections.length ? joined / injections.length : null,
      evalRuns: runs.length,
      handoffRuns: handoffRuns.length,
      concurrencyRuns: concurrencyRuns.length,
      cohorts: cohorts.length,
      harmfulFeedback: harmful,
      harmRate: feedback.length ? harmful / feedback.length : null,
      evidenceStatus: cohorts.some(
        (cohort) => cohort.evidenceStatus === 'causal estimate available'
      )
        ? 'causal estimates available'
        : 'insufficient randomized evidence',
    },
    cohorts,
    transferCohorts,
    concurrency,
    episodes: traced,
    methodology: {
      intervals:
        'deterministic percentile bootstrap (95%); Wilson interval for correctness',
      causalRule:
        'matched pairs estimate optimizer vs baseline, retrieval vs optimizer, full vs retrieval, and full vs baseline',
      minimumPairs,
      handoffMinimumPairs: handoffMinimumPairs(),
      deterministicChecksAreCausalProof: false,
    },
  };
}

export function evidenceReport(dir, options = {}) {
  const events = readEvidence(dir);
  const report = buildEvidenceReport(events, options);
  const hasMatchingEvidence = events.some((event) =>
    matchesFilters(event, options.filters || {})
  );
  return {
    ...report,
    sourceCoverage: {
      projects: 1,
      projectsWithEvidence: hasMatchingEvidence ? 1 : 0,
      projectsWithoutEvidence: hasMatchingEvidence ? 0 : 1,
    },
  };
}

/**
 * Pools evidence across registered projects before computing cohorts.
 *
 * A cohort split across two worktrees is still one experiment. Summing already
 * aggregated reports would lose pairing and produce invalid confidence
 * intervals, so this combines the append-only source events first and runs the
 * estimator exactly once.
 */
export function evidenceReportMany(dirs, options = {}) {
  const unique = [...new Set((dirs || []).map((dir) => String(dir)))];
  const sources = unique.map((dir) => readEvidence(dir));
  const report = buildEvidenceReport(sources.flat(), options);
  const projectsWithEvidence = sources.filter((events) =>
    events.some((event) => matchesFilters(event, options.filters || {}))
  ).length;
  return {
    ...report,
    sourceCoverage: {
      projects: unique.length,
      projectsWithEvidence,
      projectsWithoutEvidence: unique.length - projectsWithEvidence,
    },
  };
}
