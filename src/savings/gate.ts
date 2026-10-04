/**
 * DOES THIS INSTALL ACTUALLY CLEAR A BAR? -- the question a report cannot answer.
 *
 * `token-optimizer-savings` renders what happened. An operator rolling this out
 * across a team needs the other half: a number to hold it to, and a status code
 * when it is not met. Without that, "are we getting the savings we were told to
 * expect" is a question somebody has to answer by reading a table, which means
 * it is a question nobody answers twice.
 *
 * THE TWO HALVES ARE GATED SEPARATELY, NEVER BLENDED. The MCP half counts
 * materialized tool-payload tokens; the proxy half counts request bytes on the
 * wire against the bytes we would have sent. They are two measurements of two
 * things, and one combined percentage would be a headline that hides whichever
 * half was doing badly -- so each is checked against the target on its own and
 * the verdict names which one failed.
 *
 * AN ABSENT MEASUREMENT IS A FAILURE, NOT A PASS. This is the whole reason the
 * gate exists rather than a comparison in a shell script: a window with no
 * measured traffic has no percentage, a client that sent nothing has no
 * percentage, and `0 >= 0` would let both through as a success. Every check
 * below therefore carries the operations it was computed over, and a check with
 * none is reported as unmeasured and fails.
 *
 * A HALF THAT WAS NEVER CONFIGURED IS NOT CHECKED AND SAYS SO. An operator who
 * runs the MCP tools and no proxy has not failed a proxy target; the verdict
 * lists the scopes it checked, so a pass can never be read as covering
 * something that was not measured at all.
 *
 * READS NOTHING AND WRITES NOTHING. Every input is handed in.
 */

import type { AnalyticsEntry } from '../analytics/analytics-types.js';
import type { AnalyticsRollup } from '../analytics/analytics-rollup.js';
import {
  UNATTRIBUTED,
  foldedWithin,
  groupBy,
  summarize,
  windowBoundaries,
  withinWindow,
  type SavingsGroup,
  type SavingsWindow,
} from './windows.js';
import { PROXY_INPUT, type ProxyInput } from './proxy.js';

/**
 * The windows an operator can name, and the label each one asks for.
 *
 * THE TOKENS ARE NOT THE LABELS. A label is prose that belongs to the report
 * and may be reworded; a token is an interface that a CI job pins. Mapping one
 * to the other here means rewording a heading cannot silently change which
 * period a team's gate is measuring.
 */
export const GATE_WINDOW = Object.freeze({
  Today: 'today',
  SevenDays: '7d',
  ThirtyDays: '30d',
  AllTime: 'all',
} as const);

export type GateWindow = (typeof GATE_WINDOW)[keyof typeof GATE_WINDOW];

export const GATE_WINDOW_LABELS: Readonly<Record<GateWindow, string>> =
  Object.freeze({
    [GATE_WINDOW.Today]: 'Today',
    [GATE_WINDOW.SevenDays]: 'Last 7 days',
    [GATE_WINDOW.ThirtyDays]: 'Last 30 days',
    [GATE_WINDOW.AllTime]: 'All time',
  });

export const GATE_WINDOWS: readonly GateWindow[] = Object.freeze(
  Object.values(GATE_WINDOW)
);

/** What a check was measuring, as a value rather than as text to match. */
export const GATE_SCOPE = Object.freeze({
  Mcp: 'mcp-tool-traffic',
  Proxy: 'proxy-wire-traffic',
  Client: 'client',
} as const);

export type GateScope = (typeof GATE_SCOPE)[keyof typeof GATE_SCOPE];

/** Why a check failed, from a fixed vocabulary a consumer can switch on. */
export const GATE_REASON = Object.freeze({
  Met: 'met',
  BelowTarget: 'below-target',
  NoTraffic: 'no-measured-traffic',
  NotRecorded: 'client-never-recorded',
} as const);

export type GateReason = (typeof GATE_REASON)[keyof typeof GATE_REASON];

export interface GateCheck {
  readonly scope: GateScope;
  /** The client a `Client` check is about; null for the two halves. */
  readonly name: string | null;
  readonly targetPercent: number;
  /** The measured percentage, or null when nothing was measured. */
  readonly measuredPercent: number | null;
  /** The operations the measurement is over -- the denominator of the claim. */
  readonly operations: number;
  readonly passed: boolean;
  readonly reason: GateReason;
}

export interface GateVerdict {
  readonly window: GateWindow;
  readonly label: string;
  readonly targetPercent: number;
  readonly checks: readonly GateCheck[];
  /**
   * Whether every check passed AND there was at least one.
   *
   * A GATE THAT CHECKED NOTHING HAS NOT PASSED. `checks.every(...)` on an empty
   * list is true, and that is exactly the shape of the defect this gate is for:
   * a CI job that reports success because no measurement reached it.
   */
  readonly passed: boolean;
}

export interface GateRequest {
  readonly targetPercent: number;
  readonly window: GateWindow;
  /** Clients that must each have traffic in the window and meet the target. */
  readonly clients: readonly string[];
}

export interface GateInput {
  readonly entries: readonly AnalyticsEntry[];
  readonly rollups: readonly AnalyticsRollup[];
  readonly proxy: ProxyInput;
  readonly now: Date;
}

/** The boundary the named window opens at, from the report's own definition. */
function boundaryFor(
  window: GateWindow,
  now: Date
): { readonly label: string; readonly since: Date | null } {
  const label = GATE_WINDOW_LABELS[window];
  const found = windowBoundaries(now).find((bound) => bound.label === label);
  // NOT A FALLBACK, A CONTRACT. The labels above are the report's own, and a
  // rename there has to fail loudly here rather than quietly gating a
  // different period than the operator named.
  if (found === undefined) {
    throw new Error(`no savings window is labelled '${label}'`);
  }
  return found;
}

/** One check over a measured percentage and the operations behind it. */
function check(
  scope: GateScope,
  name: string | null,
  targetPercent: number,
  measured: { readonly percent: number; readonly operations: number } | null,
  absent: GateReason
): GateCheck {
  if (measured === null || measured.operations === 0) {
    return {
      scope,
      name,
      targetPercent,
      measuredPercent: null,
      operations: measured === null ? 0 : measured.operations,
      passed: false,
      reason: absent,
    };
  }
  const passed = measured.percent >= targetPercent;
  return {
    scope,
    name,
    targetPercent,
    measuredPercent: measured.percent,
    operations: measured.operations,
    passed,
    reason: passed ? GATE_REASON.Met : GATE_REASON.BelowTarget,
  };
}

/** The window's figures from the MCP half, by the report's own summarizer. */
function mcpWindow(input: GateInput, window: GateWindow): SavingsWindow {
  const bound = boundaryFor(window, input.now);
  return summarize(input.entries, bound.label, bound.since, input.rollups);
}

/**
 * The window's client breakdown.
 *
 * GROUPED OVER THE SAME ROWS THE WINDOW IS, not over all time: a client that
 * met the target last month and sent nothing this week must fail a weekly gate,
 * and an all-time breakdown would pass it. The filtering is `withinWindow`, the
 * one the report uses, so the period a client is held to is the period printed.
 */
function clientsInWindow(
  input: GateInput,
  window: GateWindow
): readonly SavingsGroup[] {
  const bound = boundaryFor(window, input.now);
  return groupBy(
    withinWindow(input.entries, bound.since),
    (entry) => String(entry.client || (entry.metadata || {}).client || ''),
    {
      rollups: foldedWithin(input.rollups, bound.since),
      key: (folded) => folded.client,
    }
  );
}

/**
 * Match a required client name to a breakdown row.
 *
 * CASE-INSENSITIVE AND TRIMMED, because the name comes from a CI argument and
 * the row comes from a client's own self-report; `Claude-Code` and
 * `claude-code` are the same client, and failing a gate over the difference
 * would teach an operator to delete the requirement rather than fix anything.
 *
 * `(unattributed)` IS NEVER MATCHED. It is the bucket for rows that named no
 * client at all, so treating it as a client would let traffic we cannot
 * attribute satisfy a requirement about one we can.
 */
function rowFor(
  rows: readonly SavingsGroup[],
  name: string
): SavingsGroup | undefined {
  const wanted = name.trim().toLowerCase();
  if (wanted === UNATTRIBUTED.toLowerCase()) return undefined;
  return rows.find((row) => row.name.trim().toLowerCase() === wanted);
}

export function evaluateGate(
  input: GateInput,
  request: GateRequest
): GateVerdict {
  const label = GATE_WINDOW_LABELS[request.window];
  const checks: GateCheck[] = [];

  const mcp = mcpWindow(input, request.window);
  checks.push(
    check(
      GATE_SCOPE.Mcp,
      null,
      request.targetPercent,
      { percent: mcp.savingsPercent, operations: mcp.eligibleOperations },
      GATE_REASON.NoTraffic
    )
  );

  // THE PROXY HALF ONLY WHEN ITS LEDGER WAS READ. Configured-but-unreadable and
  // never-configured are both "we did not measure this", and inventing a check
  // for them would turn an operator's choice not to run the proxy into a
  // failure of the product.
  if (input.proxy.kind === PROXY_INPUT.Read) {
    const wire = input.proxy.report.windows.find(
      (candidate) => candidate.label === label
    );
    checks.push(
      check(
        GATE_SCOPE.Proxy,
        null,
        request.targetPercent,
        wire === undefined
          ? null
          : {
              percent: wire.savingsPercent,
              operations: wire.countedRequests,
            },
        GATE_REASON.NoTraffic
      )
    );
  }

  if (request.clients.length > 0) {
    const rows = clientsInWindow(input, request.window);
    for (const name of request.clients) {
      const row = rowFor(rows, name);
      checks.push(
        check(
          GATE_SCOPE.Client,
          name,
          request.targetPercent,
          row === undefined
            ? null
            : {
                percent: row.savingsPercent,
                operations: row.eligibleOperations,
              },
          // A REQUIRED CLIENT THAT NEVER APPEARS IS ITS OWN FAILURE, told apart
          // from one that appeared and saved nothing: the first is usually a
          // client that was never pointed at us, which is a rollout problem,
          // and the second is a compression problem.
          row === undefined ? GATE_REASON.NotRecorded : GATE_REASON.NoTraffic
        )
      );
    }
  }

  return {
    window: request.window,
    label,
    targetPercent: request.targetPercent,
    checks: Object.freeze(checks),
    passed: checks.length > 0 && checks.every((one) => one.passed),
  };
}

/** One check as a line: what was measured, over what, against what. */
function checkLine(one: GateCheck): string {
  const what =
    one.scope === GATE_SCOPE.Client ? `client ${one.name ?? ''}` : one.scope;
  const verdict = one.passed ? 'met' : 'FAILED';
  if (one.measuredPercent === null) {
    const why =
      one.reason === GATE_REASON.NotRecorded
        ? 'no operations recorded for it in this window'
        : 'no measured operations in this window';
    // THE TARGET IS STILL PRINTED, because the reader's next question is what
    // the bar was, and an unmeasured check that hid it would read as a
    // different kind of failure than it is.
    return `  ${verdict}  ${what}: not measured -- ${why} (target ${one.targetPercent.toFixed(1)}%)`;
  }
  return (
    `  ${verdict}  ${what}: ${one.measuredPercent.toFixed(1)}% of ` +
    `${one.operations} ${one.operations === 1 ? 'operation' : 'operations'} ` +
    `(target ${one.targetPercent.toFixed(1)}%)`
  );
}

/**
 * The verdict as text, for a person reading a failed CI job.
 *
 * THE FAILING CHECKS ARE NOT BURIED. Every check is printed, in the order they
 * were made, so a reader can see what passed as well -- but the first line says
 * whether the gate passed, because that is the only line most readers get.
 */
export function renderGate(verdict: GateVerdict): readonly string[] {
  const lines: string[] = [''];
  lines.push(
    `Savings gate: ${verdict.passed ? 'PASS' : 'FAIL'} -- ` +
      `${verdict.label}, target ${verdict.targetPercent.toFixed(1)}%`
  );
  if (verdict.checks.length === 0) {
    // UNREACHABLE THROUGH `evaluateGate`, which always checks the MCP half,
    // and printed anyway: a gate that checked nothing must never render as a
    // pass if a future caller builds a verdict some other way.
    lines.push('  FAILED  nothing was checked, so nothing passed');
    return Object.freeze(lines);
  }
  for (const one of verdict.checks) lines.push(checkLine(one));
  if (!verdict.passed) {
    lines.push(
      '  Each half is held to the target on its own, because they measure',
      '  different things: MCP tool payloads against the proxy wire bytes.'
    );
  }
  return Object.freeze(lines);
}

/** The verdict as data, for a consumer that is not a person. */
export function gateJson(verdict: GateVerdict): Record<string, unknown> {
  return {
    passed: verdict.passed,
    window: verdict.window,
    label: verdict.label,
    targetPercent: verdict.targetPercent,
    definition:
      'each measured half is held to the target separately, never blended; a check with no measured operations fails rather than passing at zero',
    checks: verdict.checks,
  };
}
