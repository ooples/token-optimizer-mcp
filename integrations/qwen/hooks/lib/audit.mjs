// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/audit.mjs. Regenerate with `npm run sync:hooks`.
/**
 * The one thing to run.
 *
 * The competing product runs six parallel agents that produce six reports, and
 * the gap its own users describe is that there is no obvious thing to run. A
 * fifth report does not fix that, so this is not a report.
 *
 * IT IS A QUEUE. One ranked list where every line is an action with a measured
 * price and a way to apply it, drawing on machinery that already exists: the
 * waste detectors, the cache attribution, the routing table, and the remedy
 * ratchet that can actually put a fix into force.
 *
 * IT REMEMBERS WHAT IT ALREADY TOLD YOU, which is the loop nobody closes. An
 * applied fix reports what it actually saved rather than what it promised. A
 * recommendation declined twice stops being offered -- repeating rejected
 * advice is how a coach becomes a nag, and the second telling is worth less
 * than the tokens it costs.
 *
 * AND IT MEASURES WHETHER THE ADVICE WORKED. A pattern analysis describes
 * behaviour; comparing the same habit before and after the advice says whether
 * anything changed. That is the difference between a horoscope and a training
 * log, and it is only possible because the events were being recorded anyway.
 *
 * IT IS ALSO HELD TO ITS OWN STANDARD. An audit that spends 8,000 tokens
 * describing 6,000 tokens of waste is a net loss. Since the queue is ranked by
 * measured value, it stops where the remaining lines are worth less than the
 * tokens required to print them, says how many it withheld, and states its own
 * cost at the bottom.
 */

import { record, readMetrics } from './metrics.mjs';
import { referenceNote } from './usage.mjs';
import { looNote } from './loo.mjs';
import { calibrationNote } from './crosslayer.mjs';
import { remedyLedger, applyRemedy, proposal } from './remedy.mjs';
import { money, monthly, priceNote, dollars } from './pricing.mjs';

const estimate = (text) => Math.ceil(String(text || '').length / 4);

/** Declines before a recommendation stops being offered. */
export const DECLINE_LIMIT = 2;

/** Records that the user does not want a recommendation. */
export function decline(dir, id) {
  if (!id) return false;
  record(dir, { kind: 'advice', action: 'declined', id });
  return true;
}

/** How many times each recommendation has been turned down. */
export function declines(dir, { events = readMetrics(dir) } = {}) {
  const counts = new Map();
  for (const event of events) {
    if (event.kind !== 'advice' || event.action !== 'declined' || !event.id)
      continue;
    counts.set(event.id, (counts.get(event.id) || 0) + 1);
  }
  return counts;
}

const idOf = (finding) =>
  finding.remedy
    ? `${finding.remedy.type}:${finding.remedy.anchor || finding.remedy.file || (finding.remedy.anchors || []).join(',')}`
    : `${finding.id}:${finding.anchor || finding.file || ''}`;

/**
 * Whether a habit improved after we said something about it.
 *
 * Compares the same detector's cost per session before and after the first time
 * it was raised. Returns null rather than a number when either side is too thin
 * -- a trend computed from one session on each side is a coin flip with a
 * percentage sign.
 */
export function habitTrend(
  dir,
  detector,
  { events = readMetrics(dir), minSessions = 2, anchors = null } = {}
) {
  // SPLIT BY POSITION, NOT BY TIMESTAMP. The log is append-only, so its order is
  // authoritative -- while `at` has millisecond granularity, and a burst of
  // events inside one millisecond would land on the wrong side of the split or
  // collapse one side to nothing. Position is exact where the clock is not.
  const raisedAt = events.findIndex(
    (e) => e.kind === 'advice' && e.detector === detector
  );
  if (raisedAt === -1) return null;

  // SCOPED TO THE FILES THIS DETECTOR NAMED. Counting every read in the window
  // made the "trend" the project's total read volume printed under one
  // detector's name -- and because renderAudit raises every finding in one tight
  // loop, each detector's advice event lands at an adjacent index, so all of them
  // saw an identical set of reads and printed identical before/after numbers.
  // Three detectors would each claim that habit specifically improved or worsened
  // by the same amount. The existing test masked it by putting its reads on the
  // same anchor as its finding.
  const scope = anchors && anchors.length ? new Set(anchors) : null;

  const perSession = (from, to) => {
    const sessions = new Map();
    for (let i = from; i < Math.min(to, events.length); i++) {
      const event = events[i];
      if (event.kind !== 'read' || !event.tokens) continue;
      if (scope && !scope.has(event.anchor)) continue;
      const key = event.sessionId || 'unknown';
      sessions.set(key, (sessions.get(key) || 0) + event.tokens);
    }
    if (sessions.size < minSessions) return null;
    return [...sessions.values()].reduce((a, b) => a + b, 0) / sessions.size;
  };

  const before = perSession(0, raisedAt);
  const after = perSession(raisedAt + 1, events.length);
  if (before == null || after == null) return null;

  return {
    detector,
    before: Math.round(before),
    after: Math.round(after),
    change: before ? (after - before) / before : null,
    improved: after < before,
  };
}

/** Marks a recommendation as having been raised, so its effect can be scored. */
export function raise(dir, finding) {
  record(dir, {
    kind: 'advice',
    action: 'raised',
    id: idOf(finding),
    detector: finding.id,
  });
}

/**
 * Builds the ranked queue.
 *
 * `findings` comes from the detectors; `extra` lets the cache and routing
 * modules contribute without this file importing the world.
 */
export function buildQueue(
  dir,
  findings = [],
  { events = readMetrics(dir) } = {}
) {
  const declined = declines(dir, { events });
  const ledger = remedyLedger(dir);
  const applied = new Set(ledger.filter((r) => !r.revertedAt).map((r) => r.id));

  const queue = [];
  const suppressed = [];

  for (const finding of findings) {
    const id = idOf(finding);
    if (applied.has(id)) continue; // solved is not a problem

    const times = declined.get(id) || 0;
    if (times >= DECLINE_LIMIT) {
      // Repeating rejected advice is how a coach becomes a nag.
      suppressed.push({ id, title: finding.title, times });
      continue;
    }

    queue.push({ ...finding, id, declinedTimes: times });
  }

  return {
    queue: queue.sort(
      (a, b) => (b.costPerSession ?? 0) - (a.costPerSession ?? 0)
    ),
    suppressed,
    done: ledger.filter((r) => !r.revertedAt),
  };
}

/**
 * Renders the audit, stopping where it stops being worth printing.
 *
 * The truncation is not a display preference. Every line costs the reader
 * context, and the queue is already ordered by value, so there is a point past
 * which printing a finding costs more than the finding is worth. Saying how
 * many were withheld -- and what they are collectively worth -- keeps that from
 * being a silent cap.
 */
export function renderAudit(
  dir,
  findings = [],
  { tier = 'opus', full = false, sessionsPerMonth = 60 } = {}
) {
  const { queue, suppressed, done } = buildQueue(dir, findings);
  const lines = [];

  const shown = [];
  const withheld = [];
  let printed = 0;

  for (const item of queue) {
    const cost = item.costPerSession ?? 0;
    // No price on an unmeasured cost. `monthly(0)` returns a real $0.00, which
    // read as "this costs nothing" beside a finding whose cost we simply do not
    // know -- the same unknown-becomes-zero error the rest of this project
    // corrects, in the one unit that gets quoted to other people.
    const priced =
      item.costPerSession == null
        ? null
        : monthly(cost, { tier, sessionsPerMonth });
    // The id appears on EVERY actionable line, not just the appliable ones. It is the only
    // handle `decline` accepts and it cannot be guessed from the title, so omitting it made the
    // advertised decline path unreachable for precisely the findings most likely to be
    // unwanted -- model-routing findings carry no remedy, so they could never be suppressed no
    // matter how many times a user declined them.
    const action =
      item.remedy?.kind === 'ours'
        ? `apply: waste_audit action="apply" id="${item.id}"`
        : item.remedy?.kind === 'yours'
          ? `proposed edit -- needs your yes, nothing changed; decline: ${item.id}`
          : `advice only -- no automatic fix; decline: ${item.id}`;

    // MEASURED ZERO IS NOT UNMEASURED. Testing `cost` for truthiness sent a real 0 down the
    // "not yet measurable" branch while `priced` above, which tests for null, still rendered
    // $0.00 beside it -- producing `cost not yet measurable (~$0.00/month)`, the exact string
    // the test suite declares must never appear. waste.mjs defaults every finding to 0 and
    // hard-sets it on the co-occurrence detector, so this is reachable, not theoretical.
    const text =
      `  ${item.title}\n      ${item.costPerSession != null ? `${cost.toLocaleString()} tokens/session` : 'cost not yet measurable'}` +
      `${priced ? ` (~${money(priced.amount)}/month)` : ''}; ${action}`;

    const printCost = estimate(text);
    // Value of what remains, against what it costs to say it.
    //
    // A finding with NO measured cost is never withheld on this test. Treating
    // an unknown cost as zero would silently drop exactly the findings that are
    // real but not yet priceable -- routing advice, cache attribution before a
    // transcript exists -- and it is the same "unknown must not render as none"
    // error this project corrects everywhere else. Unpriceable is not worthless.
    const priceable = item.costPerSession != null;
    if (!full && shown.length && priceable && cost * 4 < printCost) {
      withheld.push(item);
      continue;
    }
    shown.push(item);
    printed += printCost;
    lines.push(text);
  }

  // SCOPED TO THE QUEUE, because that is all it ever described. The bare
  // sentence "Nothing addressable found." was printed directly above a Layer 1
  // reference note and a published Layer 2 causal verdict -- so a reader was
  // told nothing had been found immediately before being shown a finding. The
  // headline is about the remediation queue and nothing else, and saying so
  // costs four words and removes a false negative shown to a human.
  const head = shown.length
    ? ['What to do next, most expensive first:', ...lines]
    : ['Nothing addressable found in the remediation queue.'];

  const body = [...head];

  if (withheld.length) {
    const worth = withheld.reduce((sum, w) => sum + (w.costPerSession || 0), 0);
    body.push(
      '',
      `  ... ${withheld.length} more finding(s) worth ${worth.toLocaleString()} tokens/session in total, ` +
        'not shown -- printing them costs more than they are worth. Pass full=true to see all.'
    );
  }

  // What we already told you, and what it bought.
  if (done.length) {
    body.push('', 'Already applied, and what it actually saved:');
    for (const rule of done.slice(0, 6)) {
      const saved = rule.savedPerSession;
      const priced =
        saved == null ? null : monthly(saved, { tier, sessionsPerMonth });
      body.push(
        `  + ${rule.id} -- ${
          saved == null
            ? 'not yet measurable (fewer than two sessions since)'
            : `measured ${saved.toLocaleString()} tokens/session${priced ? `, ~${money(priced.amount)}/month` : ''}`
        }`
      );
    }
    // Never a silent cap: the withheld block above states its remainder and so must this one.
    // Truncating to six with no disclosure showed a user six savings and let them conclude that
    // was everything the tool had bought them, which understates its own measured value.
    if (done.length > 6) {
      body.push(
        `  ... and ${done.length - 6} more applied fix(es), not shown.`
      );
    }
  }

  if (suppressed.length) {
    body.push(
      '',
      `Not repeating ${suppressed.length} recommendation(s) you have declined ` +
        `${DECLINE_LIMIT}+ times. Ask for full=true to see them.`
    );
    if (full)
      for (const item of suppressed)
        body.push(`  - ${item.title} (declined ${item.times}x)`);
  }

  // Whether the advice changed anything.
  // Scoped per detector to the anchors that detector actually named, or every trend line
  // reports the project's total read volume and they all print the same numbers.
  const anchorsBy = new Map();
  for (const f of findings) {
    const anchors = f.anchors || [f.anchor || f.file].filter(Boolean);
    if (!anchors.length) continue;
    if (!anchorsBy.has(f.id)) anchorsBy.set(f.id, new Set());
    for (const a of anchors) anchorsBy.get(f.id).add(a);
  }
  const trends = [...new Set(findings.map((f) => f.id))]
    .map((detector) =>
      habitTrend(dir, detector, {
        anchors: anchorsBy.has(detector) ? [...anchorsBy.get(detector)] : null,
      })
    )
    .filter(Boolean);

  if (trends.length) {
    body.push('', 'Since the advice was given:');
    for (const trend of trends) {
      body.push(
        `  ${trend.detector}: ${trend.before.toLocaleString()} -> ${trend.after.toLocaleString()} tokens/session ` +
          `(${trend.improved ? 'improved' : 'worse'})`
      );
    }
  }

  // WHETHER THE FINDINGS WE INJECTED GOT USED (Layer 1).
  //
  // Printed here because this is the report that already asks "did the advice
  // change anything", and because a measurement with no reader is how this
  // project shipped two metrics whose only consumer was their own test suite.
  // `referenceNote` returns null when it has nothing honest to say, so a
  // project with no injections and no queries gains no line at all.
  const reference = referenceNote(dir);
  if (reference) body.push('', reference);

  // WHAT ONE FINDING IS CAUSALLY WORTH (Layer 2).
  //
  // The same reasoning as above, and the same refusal: `looNote` returns null
  // until the leave-one-out experiment has collected an observation, and says
  // NOT MEASURABLE YET rather than printing a mean until it clears the floor.
  // A causal number is the most quotable thing this project can produce, so it
  // is the one that most needs to be absent when it is not earned.
  const causal = looNote(dir);
  if (causal) body.push('', causal);

  // WHETHER LAYER 1'S CHEAP LABEL PREDICTS LAYER 2'S EXPENSIVE EFFECT.
  //
  // The reason this is printed rather than kept for a dashboard: the reference
  // rate is the number a reader is most likely to quote as a saving, and it is
  // not one until this comparison says so. `calibrationNote` returns null while
  // both layers are silent, and otherwise prints the refusal -- naming which
  // input was insufficient -- rather than a gap of zero.
  const calibrated = calibrationNote(dir);
  if (calibrated) body.push('', calibrated);

  const addressable = queue.reduce(
    (sum, item) => sum + (item.costPerSession || 0),
    0
  );
  const addressableMonthly = addressable
    ? monthly(addressable, { tier, sessionsPerMonth })
    : null;
  const note = priceNote(tier);
  if (note) body.push('', note);

  // Held to its own standard.
  // Held to its own standard -- INCLUDING the closing sentence. Measuring the body before
  // pushing it left the report's longest line out of its own reported cost, understating it by
  // 10-20% on a short audit. This figure exists to prove the audit is not a net loss, so
  // understating the cost side biases exactly the comparison it was written to be honest about.
  const closing = (n) =>
    `This report cost about ${n.toLocaleString()} tokens and names ` +
    `${addressable.toLocaleString()} tokens/session of addressable waste` +
    `${addressableMonthly ? ` (~${money(addressableMonthly.amount)}/month across ${sessionsPerMonth} sessions)` : ''}.`;
  const selfCost = estimate([...body, '', closing(0)].join('\n'));
  body.push('', closing(selfCost));

  return {
    text: body.join('\n'),
    shown: shown.length,
    withheld: withheld.length,
    suppressed: suppressed.length,
    addressablePerSession: addressable,
    selfCostTokens: selfCost,
    printedTokens: printed,
  };
}

export { applyRemedy, proposal, dollars };
