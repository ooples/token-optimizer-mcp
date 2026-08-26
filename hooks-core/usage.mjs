/**
 * LAYER 1 -- did the model actually go back and use what we injected?
 *
 * The cheap behavioural label. One question, answered from the event log alone:
 * after we put a finding in front of the model, did the model later ASK FOR
 * THAT FINDING BY NAME?
 *
 * WHY EXPLICIT REFERENCE, AND NOT READ-SUPPRESSION. Read-suppression -- "the
 * file was not re-read, so the finding must have helped" -- is Layer 2's
 * estimand, measured causally by withholding a finding and comparing. Layer 1
 * exists to be calibrated AGAINST that. If both layers derived from
 * suppression, the calibration would compare two spellings of one quantity,
 * report a strong correlation, and mean nothing. So Layer 1 is deliberately
 * built on a signal Layer 2 does not touch: an explicit `query` naming the
 * finding key.
 *
 * WHAT THIS DOES NOT DO. It does not invent a join. `recordToolOutcome`
 * already joins each post-tool result back to the injection that preceded it,
 * recording `injectionId`, `findingIds` and a `joinMethod` of `tool-call-id`,
 * `episode-anchor` or `none` -- preferring an exact tool-call id, which is
 * strictly better evidence than the `(sessionId, findingKey)` approximation an
 * earlier draft of this plan proposed. This module consumes that join and adds
 * none of its own. `inject.mjs` needed no change: it has written `findingIds`
 * at every call site all along.
 *
 * WHAT `unknown` IS FOR, and it is the whole reason this file is careful. An
 * injection whose session simply stopped afterwards is not a miss. Nothing
 * happened, so nothing can be concluded, and counting it against the finding
 * would make the metric read worse the more often sessions end -- a number
 * that moves with session length rather than with usefulness. `unknown` is
 * therefore EXCLUDED from the denominator rather than scored zero, and
 * outcomes the join could not attribute at all are reported as
 * `unattributable` rather than folded into either arm.
 *
 * AND WHY THE RATE CAN BE `null`. This project has already shipped two metrics
 * whose only producer was their own test suite. A rate of 0% that actually
 * means "no data" is worse than a refusal, because it is a number and numbers
 * get quoted. So `rate` is null unless there is a denominator AND the
 * reference channel produced at least one usable event in the window. "Nothing
 * was referenced" and "nothing could be measured" are different answers and
 * this module gives different answers for them.
 */
import { readMetrics } from './metrics.mjs';

/**
 * The events that name a finding, and it is ONE kind, not the two the plan
 * assumed.
 *
 * The brief said "a later `query` or `expand` event". Checked against the code
 * and against every metrics log on this machine, `expand` does not qualify and
 * cannot be made to:
 *
 *   - `recordExpansion` writes `{ ref, tool, shape, asked, sessionId }`. `ref`
 *     is a TRUNCATION CAPTURE id (a 16-hex digest of captured tool output),
 *     not a finding key, and `asked` is free text naming a section of that
 *     output. Neither is a graph key, and no code path ever puts one there.
 *   - measured: 64 live `expand` events exist on this machine and all 64 carry
 *     `sessionId: null`, so they could not be scoped to an injection even if
 *     they did name one.
 *
 * Keying the classifier on `expand` would therefore have added a branch that
 * can never fire -- a metric with no producer, which is the exact defect this
 * whole effort exists to close. So it is excluded, deliberately and with the
 * measurement recorded, rather than included for symmetry with the brief.
 */
const REFERENCE_KINDS = new Set(['query']);

/**
 * What counts as the session having CONTINUED past the injection.
 *
 * The distinction between `not-referenced` and `unknown` rests entirely on
 * this, so the set is explicit rather than "any later event". These are the
 * kinds a tool call produces: if one of them follows the injection in the same
 * session, the model had the opportunity to ask and did not. If none does, the
 * session ended and there was no opportunity.
 *
 * `inject` is in the set because a later injection means a later tool call
 * happened. `forecast`, `mcp-client` and `mcp-tool` are NOT: they are written
 * by session bookkeeping rather than by the model doing something, and
 * treating them as opportunity would convert `unknown` rows into misses on
 * bookkeeping alone.
 */
const ACTIVITY_KINDS = new Set([
  'tool-outcome',
  'read',
  'query',
  'expand',
  'substitute',
  'inject',
]);

/** A usable session id: a non-empty string. `null == null` is not a match. */
const sessionOf = (event) => {
  const id = event?.sessionId;
  return typeof id === 'string' && id ? id : null;
};

/** The finding key a reference event names, or null if it names none. */
const referencedKey = (event) => {
  const key = event?.key;
  return typeof key === 'string' && key ? key : null;
};

/** Ordering by the caller's timestamp, with log order breaking ties. */
function inTimeOrder(events) {
  return events
    .map((event, index) => ({ event, index }))
    .sort(
      (a, b) =>
        (a.event.at || 0) - (b.event.at || 0) || a.index - b.index
    )
    .map((row) => row.event);
}

/**
 * One row per (injection, finding) pair, labelled.
 *
 * Per injection rather than per finding: the same finding injected twice is two
 * separate opportunities, and collapsing them would let one reference excuse
 * every later injection of that key.
 *
 * FAILS OPEN. A malformed log yields an empty classification, never a throw:
 * this runs on report paths that must not break a tool call.
 */
export function classify(dir, { events = null } = {}) {
  let rows = [];
  try {
    const all = inTimeOrder(events || readMetrics(dir));

    // Every reference, keyed on the finding it names. Only references carrying
    // a session id are usable -- see `unscopedReferences` in `referenceRate`
    // for the ones this drops and why they are counted rather than credited.
    const references = new Map();
    for (const event of all) {
      if (!REFERENCE_KINDS.has(event.kind)) continue;
      const key = referencedKey(event);
      const session = sessionOf(event);
      if (!key || !session) continue;
      if (!references.has(key)) references.set(key, []);
      references.get(key).push({ at: event.at || 0, session });
    }

    // Which injections the existing outcome join could attribute. An outcome
    // carrying our injectionId is proof the tool call completed, which is
    // opportunity even when the session id is missing from the log.
    const attributed = new Set();
    for (const event of all) {
      if (event.kind !== 'tool-outcome') continue;
      if (event.joinMethod === 'none' || !event.injectionId) continue;
      attributed.add(String(event.injectionId));
    }

    // Activity per session, so "did anything follow?" is one lookup rather
    // than a scan per injection.
    const activity = new Map();
    for (const event of all) {
      if (!ACTIVITY_KINDS.has(event.kind)) continue;
      const session = sessionOf(event);
      if (!session) continue;
      if (!activity.has(session)) activity.set(session, []);
      activity.get(session).push(event.at || 0);
    }

    for (const event of all) {
      if (event.kind !== 'inject') continue;
      const keys = Array.isArray(event.findingIds) ? event.findingIds : [];
      if (!keys.length) continue;
      const injectionId = event.injectionId ? String(event.injectionId) : null;
      const at = event.at || 0;
      const session = sessionOf(event);
      // STRICTLY AFTER. A query that PRECEDED the injection is the model
      // asking on its own initiative; crediting it would let the metric take
      // the credit for a lookup it had nothing to do with.
      const followed = (times) => times.some((t) => t > at);
      const continued =
        (injectionId && attributed.has(injectionId)) ||
        (session ? followed(activity.get(session) || []) : false);

      for (const raw of keys) {
        const findingKey = String(raw);
        const hits = references.get(findingKey) || [];
        const referenced = session
          ? hits.some((hit) => hit.session === session && hit.at > at)
          : false;
        rows.push({
          findingKey,
          injectionId,
          label: referenced
            ? 'referenced'
            : continued
              ? 'not-referenced'
              : 'unknown',
        });
      }
    }
  } catch {
    rows = [];
  }
  return rows;
}

/**
 * The rate, with everything needed to tell a real 0 from an absent one.
 *
 * `denominator` counts only `referenced` + `not-referenced`. `unknown`,
 * `unattributable` and `unscopedReferences` are reported beside it, never
 * inside it.
 */
export function referenceRate(dir, { events = null } = {}) {
  const empty = {
    referenced: 0,
    notReferenced: 0,
    unknown: 0,
    denominator: 0,
    rate: null,
    unattributable: 0,
    unattributableWithInjectedToolCall: 0,
    referenceEvents: 0,
    unscopedReferences: 0,
  };
  try {
    const all = events || readMetrics(dir);
    const rows = classify(dir, { events: all });
    const count = (label) => rows.filter((row) => row.label === label).length;
    const referenced = count('referenced');
    const notReferenced = count('not-referenced');
    const denominator = referenced + notReferenced;

    // Usable reference events in the window: the numerator's producer. If this
    // is zero the channel never fired, and a 0% rate would be measuring the
    // absence of a producer rather than the uselessness of findings.
    let referenceEvents = 0;
    let unscopedReferences = 0;
    for (const event of all) {
      if (!REFERENCE_KINDS.has(event.kind)) continue;
      if (!referencedKey(event)) continue;
      if (sessionOf(event)) referenceEvents += 1;
      // Names a finding but cannot be scoped to one injection. `sessionId` is
      // an OPTIONAL input the caller of wiki_query has to volunteer, so this
      // is the expected loss rather than an edge case -- counted here so it is
      // visible instead of silently deflating the numerator.
      else unscopedReferences += 1;
    }

    // The tool calls that DID receive findings, keyed the way
    // `recordToolOutcome` keys its own primary join: the tool-call id. An
    // unattributable outcome for one of these is a join that FAILED. An
    // unattributable outcome for any other tool call had nothing to join to.
    //
    // KEYED ON THE TOOL CALL, NOT THE EPISODE, and the first draft of this
    // got it wrong in a way worth recording because it is the exact
    // measurement-bias class this plan hunts. `episodeId` equals the SESSION
    // id, so "unattributable outcomes in an episode that had an injection"
    // scored all 2,559 tool calls of a session in which ONE injection
    // happened. It would have published 2,559 join failures where the true
    // number is zero -- correct code, lying number, and biased pessimistic
    // rather than flattering, which is no better.
    const injectedToolCalls = new Set();
    for (const event of all) {
      if (event.kind !== 'inject') continue;
      if (!Array.isArray(event.findingIds) || !event.findingIds.length)
        continue;
      if (event.toolCallId) injectedToolCalls.add(String(event.toolCallId));
    }
    let unattributable = 0;
    let unattributableWithInjectedToolCall = 0;
    for (const event of all) {
      if (event.kind !== 'tool-outcome' || event.joinMethod !== 'none')
        continue;
      unattributable += 1;
      // BOTH FIGURES, because the raw one alone lies in the pessimistic
      // direction. Measured on this machine: 2,991 of 2,992 live outcomes
      // report `joinMethod: 'none'`, and every one of them because NO
      // INJECTION EXISTED for that tool call -- the graph holds one finding.
      // Quoting only the raw count would read as a join that fails 99.97% of
      // the time, which is a different and false claim.
      if (event.toolCallId && injectedToolCalls.has(String(event.toolCallId)))
        unattributableWithInjectedToolCall += 1;
    }

    return {
      referenced,
      notReferenced,
      unknown: count('unknown'),
      denominator,
      rate:
        denominator > 0 && referenceEvents > 0
          ? referenced / denominator
          : null,
      unattributable,
      unattributableWithInjectedToolCall,
      referenceEvents,
      unscopedReferences,
    };
  } catch {
    return empty;
  }
}

/**
 * One line for the audit, or nothing at all.
 *
 * Says which of the three things is true -- a measured rate, a live channel
 * with no opportunities yet, or no channel at all -- rather than printing a
 * figure and letting the reader assume the first.
 */
export function referenceNote(dir, { events = null } = {}) {
  const r = referenceRate(dir, { events });
  if (!r.denominator && !r.unknown && !r.referenceEvents) return null;
  if (r.rate == null) {
    const why = !r.referenceEvents
      ? 'no finding was ever queried by key in this window'
      : `no injection had a chance to be referenced yet (${r.unknown} unknown)`;
    return `Injected findings referenced later: not measurable -- ${why}.`;
  }
  return (
    `Injected findings referenced later: ${r.referenced}/${r.denominator} ` +
    `(${Math.round(r.rate * 100)}%); ${r.unknown} unknown, excluded.`
  );
}
