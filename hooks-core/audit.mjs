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
import { detect } from './waste.mjs';
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
    if (event.kind !== 'advice' || event.action !== 'declined' || !event.id) continue;
    counts.set(event.id, (counts.get(event.id) || 0) + 1);
  }
  return counts;
}

const idOf = (finding) => finding.remedy
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
export function habitTrend(dir, detector, { events = readMetrics(dir), minSessions = 2 } = {}) {
  // SPLIT BY POSITION, NOT BY TIMESTAMP. The log is append-only, so its order is
  // authoritative -- while `at` has millisecond granularity, and a burst of
  // events inside one millisecond would land on the wrong side of the split or
  // collapse one side to nothing. Position is exact where the clock is not.
  const raisedAt = events.findIndex((e) => e.kind === 'advice' && e.detector === detector);
  if (raisedAt === -1) return null;

  const perSession = (from, to) => {
    const sessions = new Map();
    for (let i = from; i < Math.min(to, events.length); i++) {
      const event = events[i];
      if (event.kind !== 'read' || !event.tokens) continue;
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
  record(dir, { kind: 'advice', action: 'raised', id: idOf(finding), detector: finding.id });
}

/**
 * Builds the ranked queue.
 *
 * `findings` comes from the detectors; `extra` lets the cache and routing
 * modules contribute without this file importing the world.
 */
export function buildQueue(dir, findings = [], { events = readMetrics(dir) } = {}) {
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
    queue: queue.sort((a, b) => (b.costPerSession ?? 0) - (a.costPerSession ?? 0)),
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
export function renderAudit(dir, findings = [], { tier = 'opus', full = false, sessionsPerMonth = 60 } = {}) {
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
    const priced = item.costPerSession == null ? null : monthly(cost, { tier, sessionsPerMonth });
    const action = item.remedy?.kind === 'ours' ? `apply: waste_audit action="apply" id="${item.id}"`
      : item.remedy?.kind === 'yours' ? 'proposed edit -- needs your yes, nothing changed'
        : 'advice only -- no automatic fix';

    const text = `  ${item.title}\n      ${cost ? `${cost.toLocaleString()} tokens/session` : 'cost not yet measurable'}` +
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

  const head = shown.length ? ['What to do next, most expensive first:', ...lines] : ['Nothing addressable found.'];

  const body = [...head];

  if (withheld.length) {
    const worth = withheld.reduce((sum, w) => sum + (w.costPerSession || 0), 0);
    body.push('', `  ... ${withheld.length} more finding(s) worth ${worth.toLocaleString()} tokens/session in total, ` +
      'not shown -- printing them costs more than they are worth. Pass full=true to see all.');
  }

  // What we already told you, and what it bought.
  if (done.length) {
    body.push('', 'Already applied, and what it actually saved:');
    for (const rule of done.slice(0, 6)) {
      const saved = rule.savedPerSession;
      const priced = saved == null ? null : monthly(saved, { tier, sessionsPerMonth });
      body.push(`  + ${rule.id} -- ${saved == null
        ? 'not yet measurable (fewer than two sessions since)'
        : `measured ${saved.toLocaleString()} tokens/session${priced ? `, ~${money(priced.amount)}/month` : ''}`}`);
    }
  }

  if (suppressed.length) {
    body.push('', `Not repeating ${suppressed.length} recommendation(s) you have declined ` +
      `${DECLINE_LIMIT}+ times. Ask for full=true to see them.`);
    if (full) for (const item of suppressed) body.push(`  - ${item.title} (declined ${item.times}x)`);
  }

  // Whether the advice changed anything.
  const trends = [...new Set(findings.map((f) => f.id))]
    .map((detector) => habitTrend(dir, detector))
    .filter(Boolean);

  if (trends.length) {
    body.push('', 'Since the advice was given:');
    for (const trend of trends) {
      body.push(`  ${trend.detector}: ${trend.before.toLocaleString()} -> ${trend.after.toLocaleString()} tokens/session ` +
        `(${trend.improved ? 'improved' : 'worse'})`);
    }
  }

  const addressable = queue.reduce((sum, item) => sum + (item.costPerSession || 0), 0);
  const note = priceNote(tier);
  if (note) body.push('', note);

  // Held to its own standard.
  const selfCost = estimate(body.join('\n'));
  body.push('', `This report cost about ${selfCost.toLocaleString()} tokens and names ` +
    `${addressable.toLocaleString()} tokens/session of addressable waste` +
    `${addressable ? ` (~${money(monthly(addressable, { tier, sessionsPerMonth })?.amount)}/month across ${sessionsPerMonth} sessions)` : ''}.`);

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

/** Convenience: the full pass over the waste detectors, for callers with a graph. */
export function auditFindings(dir, graph) {
  return detect(dir, graph);
}

export { applyRemedy, proposal, dollars };
