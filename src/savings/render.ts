/**
 * Text rendering for the savings report.
 *
 * SEPARATE FROM THE AGGREGATION ON PURPOSE. Every accuracy question in this
 * feature -- which rows count, what a percentage is a percentage of, whether a
 * price is known -- is settled in `windows.ts` and testable without parsing a
 * line of output. What is left here is presentation, and the one rule it has to
 * keep is that it must not invent a number the aggregation refused to produce:
 * a null cost prints as `not priced`, never as `$0.00`.
 */

import type { SavingsGroup, SavingsReport, SavingsWindow } from './windows.js';
import {
  PROXY_INPUT,
  type ProxyInput,
  type ProxySavingsReport,
  type ProxySavingsWindow,
  type LatencyBound,
} from './proxy.js';
import {
  OPERATOR_PRICE_TABLE_ENV,
  type OperatorPriceTableStatus,
} from '../analytics/operator-prices.js';
import type {
  OutputSavingsEstimate,
  OutputWaste,
} from '../proxy/output-savings.js';

const BAR_WIDTH = 16;

export function bar(percent: number, width: number = BAR_WIDTH): string {
  if (!Number.isFinite(percent)) return '-'.repeat(width);
  const filled = Math.max(
    0,
    Math.min(width, Math.round((percent / 100) * width))
  );
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function count(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/**
 * Money, or the admission that there is none.
 *
 * SUB-CENT AMOUNTS ARE NOT ROUNDED TO ZERO. A day of light use genuinely is
 * worth a fraction of a cent, and `$0.00` would read as the feature having
 * done nothing rather than having done a little.
 */
export function money(amount: number | null): string {
  if (amount === null) return 'not priced';
  const magnitude = Math.abs(amount);
  const text =
    magnitude === 0
      ? '$0.00'
      : magnitude < 0.01
        ? `$${magnitude.toFixed(4)}`
        : `$${magnitude.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}`;
  // A negative total is a net expansion debit, and the sign has to survive.
  return amount < 0 ? `-${text}` : text;
}

/**
 * One window line.
 *
 * THE PRICED FRACTION TRAVELS WITH THE PRICE. `$1.20 (8/12 priced)` is a
 * different claim from `$1.20`, and the second one invites a reader to treat a
 * partial figure as the whole bill. When every eligible operation was priced
 * the parenthetical is dropped, because then the two claims are the same.
 */
export function windowLine(window: SavingsWindow): string {
  const pct = `${window.savingsPercent.toFixed(1)}%`.padStart(6);
  const label = window.label.padEnd(12);
  const saved = `${count(window.tokensSaved)} / ${count(window.tokensBefore)}`;
  const priced =
    window.costUsd !== null &&
    window.pricedOperations < window.eligibleOperations
      ? ` (${count(window.pricedOperations)}/${count(
          window.eligibleOperations
        )} priced)`
      : '';
  return `${label} ${bar(window.savingsPercent)} ${pct}  saved ${saved} tokens  ${money(window.costUsd)}${priced}`;
}

export function groupLines(
  title: string,
  rows: readonly SavingsGroup[],
  topN: number
): readonly string[] {
  if (rows.length === 0) return [];
  const shown = rows.slice(0, topN);
  const width = Math.max(4, ...shown.map((row) => row.name.length));
  const lines = [title];
  for (const row of shown) {
    lines.push(
      `  ${row.name.padEnd(width)}  ${count(row.tokensSaved).padStart(
        12
      )} tokens  ${count(row.operations).padStart(5)} ops  ${money(row.costUsd)}`
    );
  }
  if (rows.length > shown.length) {
    const rest = rows.length - shown.length;
    lines.push(`  ... and ${count(rest)} more ${rest === 1 ? 'row' : 'rows'}`);
  }
  return lines;
}

/**
 * THE SHORT FORM OF "WHAT THIS READS", for `--help`.
 *
 * This replaced a note that disclaimed the proxy's absence. The disclaimer was
 * honest while the proxy ledger was unread, and it is the wrong text now that
 * it is an input: a reader who sees "requests through the proxy are not in this
 * ledger" concludes the proxy figures below it belong to something else.
 */
export const INPUTS_NOTE =
  'Reads two inputs: the MCP analytics database, and the token-optimizer-proxy wire ledger when TOKEN_OPTIMIZER_PROXY_ACCOUNTING names one.';

const MCP_SECTION = 'MCP tool traffic';
const PROXY_SECTION = 'Proxy wire traffic';
const INPUT_LABEL_WIDTH = Math.max(MCP_SECTION.length, PROXY_SECTION.length);

/**
 * BOTH INPUTS, AND WHETHER EACH ONE WAS THERE.
 *
 * Silence about a missing input is indistinguishable from a measurement of
 * zero. Every state of both inputs gets a line, and the three proxy states
 * that an operator can act on say what the action is rather than only that
 * there are no numbers.
 */
/**
 * How much of an input came from days that are no longer rows.
 *
 * DISCLOSED ON THE INPUT LINE, NOT HIDDEN BEHIND EQUAL TOTALS. The fold keeps
 * every figure in this report exact, so nothing above this line changes when a
 * day ages out -- but what can still be *asked* of that day does change: it can
 * no longer be filtered by session or exported row by row. An operator who
 * queried a folded day and got nothing back would otherwise have no way to tell
 * "nothing happened" from "it is a total now".
 */
export function foldedNote(operations: number, days: number): string {
  if (days <= 0 || operations <= 0) return '';
  return ` (${count(operations)} from ${count(days)} folded ${
    days === 1 ? 'day' : 'days'
  })`;
}

export function inputLines(
  report: SavingsReport,
  proxy: ProxyInput
): readonly string[] {
  const label = (text: string): string =>
    `  ${text.padEnd(INPUT_LABEL_WIDTH)}  `;
  const operations = `${count(report.totalEntries)} ${
    report.totalEntries === 1 ? 'operation' : 'operations'
  } read, ${count(report.eligibleEntries)} measurable`;
  const lines = [
    'Inputs:',
    `${label(MCP_SECTION)}analytics database -- ${operations}${foldedNote(
      report.foldedOperations,
      report.foldedDays
    )}`,
  ];
  if (proxy.kind === PROXY_INPUT.NotConfigured) {
    lines.push(
      `${label(PROXY_SECTION)}not configured -- set TOKEN_OPTIMIZER_PROXY_ACCOUNTING to a ledger path to include it`
    );
    return lines;
  }
  if (proxy.kind === PROXY_INPUT.Missing) {
    lines.push(
      `${label(PROXY_SECTION)}${proxy.path} -- nothing written there yet`
    );
    return lines;
  }
  if (proxy.kind === PROXY_INPUT.Unreadable) {
    lines.push(
      `${label(PROXY_SECTION)}${proxy.path} -- could not be read: ${proxy.reason}`
    );
    return lines;
  }
  const { report: proxyReport } = proxy;
  const requests = `${count(proxyReport.totalRecords)} ${
    proxyReport.totalRecords === 1 ? 'request' : 'requests'
  } read, ${count(proxyReport.measuredRecords)} measurable`;
  const skipped =
    proxyReport.skippedLines > 0
      ? `, ${count(proxyReport.skippedLines)} unparseable ${
          proxyReport.skippedLines === 1 ? 'line' : 'lines'
        } skipped`
      : '';
  const folded = foldedNote(
    proxyReport.rolledUpRecords,
    proxyReport.rolledUpDays
  );
  lines.push(
    `${label(PROXY_SECTION)}${proxy.path} -- ${requests}${skipped}${folded}`
  );
  return lines;
}

/**
 * A proxy window, printed by the same function as an MCP window.
 *
 * ONE FORMAT FOR BOTH TABLES, which is why this adapts rather than reimplements
 * `windowLine`. The two aggregations count different things -- operations
 * against requests -- but a reader comparing the two sections is comparing
 * columns, and two hand-written formats drift into two different column layouts
 * the first time one of them is touched.
 */
export function asSavingsWindow(window: ProxySavingsWindow): SavingsWindow {
  return {
    label: window.label,
    since: window.since,
    operations: window.countedRequests,
    tokensSaved: window.tokensSaved,
    tokensBefore: window.tokensBefore,
    savingsPercent: window.savingsPercent,
    costUsd: window.costUsd,
    pricedOperations: window.pricedRequests,
    eligibleOperations: window.countedRequests,
  };
}

/**
 * THE INSTRUMENT'S OWN ERROR, PRINTED AS A PAIR.
 *
 * Both numbers describe one identical byte sequence -- the body we sent -- so
 * the gap between them is encoder disagreement and nothing else. The percentage
 * is taken from the two sums rather than averaged over per-request ratios,
 * which would weight a three-hundred-token request the same as a
 * three-hundred-thousand-token one.
 */
export function calibrationLine(report: ProxySavingsReport): string {
  const all = report.windows.find((window) => window.since === null);
  if (all === undefined || all.calibratedRequests === 0) return '';
  const { oursTokens: ours, billedTokens: billed } = all;
  const gap =
    billed === 0
      ? ''
      : ` (${(ours - billed) / billed >= 0 ? '+' : ''}${(((ours - billed) / billed) * 100).toFixed(1)}%)`;
  const requests = `${count(all.calibratedRequests)} ${
    all.calibratedRequests === 1 ? 'request' : 'requests'
  }`;
  return (
    `Encoder check: we counted ${count(ours)} prompt tokens where the provider ` +
    `billed ${count(billed)}${gap}, over ${requests} it priced.`
  );
}

/**
 * The other half of the trade: what the saving cost in latency.
 *
 * WHY THIS LINE EXISTS AT ALL. Every figure above it is a reduction, and a
 * report made only of reductions argues one side of a decision. An extension
 * that halves the bill and adds two hundred milliseconds to every request is a
 * trade, and an operator cannot accept or refuse a trade they can only see one
 * half of -- so our own transform cost is printed beside the saving it bought,
 * in the same report, from the same rows.
 *
 * THE UPSTREAM FIGURE IS THE SCALE, not a second claim. Two milliseconds of
 * transform in front of a two-second provider call and the same two in front of
 * a thirty-millisecond one are different trades, and the number that separates
 * them is the one we do not control.
 *
 * SAYS SO WHEN IT DOES NOT KNOW. A ledger written by a proxy built before the
 * timings existed carries none, and the line then reports that rather than
 * disappearing -- an absent latency line beside a large saving reads as a
 * saving that cost nothing.
 */
export function latencyLine(report: ProxySavingsReport): string {
  const all = report.windows.find((window) => window.since === null);
  if (all === undefined || all.requests === 0) return '';
  if (
    all.timedRequests === 0 ||
    all.transformMsMean === null ||
    all.upstreamMsMean === null
  ) {
    return 'Latency cost: not recorded -- this ledger carries no request timings.';
  }
  const requests = `${count(all.timedRequests)} timed ${
    all.timedRequests === 1 ? 'request' : 'requests'
  }`;
  const spread = [
    bound('median', all.transformMsP50),
    bound('95th', all.transformMsP95),
    all.transformMsMax === null
      ? ''
      : `slowest ${all.transformMsMax.toFixed(1)} ms`,
  ].filter((part) => part !== '');
  const detail = spread.length > 0 ? ` (${spread.join(', ')})` : '';
  return (
    `Latency cost: our transform added ${all.transformMsMean.toFixed(1)} ms per ` +
    `request on average${detail}, in front of an upstream call averaging ` +
    `${all.upstreamMsMean.toFixed(0)} ms, over ${requests}.`
  );
}

/**
 * The output-token tiers, each labelled with the evidence it actually has.
 *
 * TWO LINES, NEVER BLENDED INTO ONE. The estimated tier compares requests we
 * compressed against requests we happened not to, and the measured tier
 * compares the shaper's two randomized arms. They are different populations
 * answering different questions, and a single combined "output savings" figure
 * would be readable as neither -- so each prints under its own name, and the
 * weaker one prints the word `estimated` inside the sentence rather than in a
 * footnote a reader can skip.
 *
 * A SIGNED FIGURE, BECAUSE THE ANSWER MAY BE THAT WE COST THE OPERATOR TOKENS.
 * A terser context can plausibly make a model restate more of its own earlier
 * work, and a renderer that printed `0` or dropped the line in that case would
 * turn a real negative result into silence.
 */
export function outputLines(report: ProxySavingsReport): readonly string[] {
  const all = report.windows.find((window) => window.since === null);
  if (all === undefined) return [];
  const lines: string[] = [];
  const estimated = outputLine(
    'Output tokens (estimated, from requests we did not compress)',
    all.outputEstimated,
    'Observational: the band covers sampling noise, not the chance that the ' +
      'uncompressed requests differed for some other reason.'
  );
  if (estimated !== '') lines.push(estimated);
  if (all.outputMeasured !== null) {
    const measured = outputLine(
      "Output tokens (measured, from the shaper's randomized holdout)",
      all.outputMeasured,
      'Randomized: the only output figure here that is a measurement.'
    );
    if (measured !== '') lines.push(measured);
  }
  if (all.outputWaste !== null) lines.push(wasteLine(all.outputWaste));
  return lines;
}

/**
 * Tier 3, worded so it cannot be read as a saving.
 *
 * NO TOKEN COUNT APPEARS IN THIS LINE, deliberately. The figure is a share of
 * a reply with no counterfactual behind it, and converting it to tokens would
 * invite exactly the arithmetic the ledger refuses -- adding an opportunity to
 * a measurement. It is named as waste still present, not as anything saved.
 */
function wasteLine(waste: OutputWaste): string {
  const band =
    waste.interval === null
      ? ''
      : ` (95% CI ${percent(waste.interval.lowRatio)} to ${percent(
          waste.interval.highRatio
        )})`;
  const requests = `${count(waste.requests)} scanned ${
    waste.requests === 1 ? 'reply' : 'replies'
  }`;
  return (
    `Output waste (observed, no counterfactual): ${percent(waste.meanRatio)}` +
    `${band} of the average reply repeats text the model had already been ` +
    `shown, over ${requests}. Not a saving -- this is the waste still there ` +
    'to attack.'
  );
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** One tier, or '' when the tier saw nothing and has nothing to report. */
function outputLine(
  label: string,
  estimate: OutputSavingsEstimate,
  note: string
): string {
  if (estimate.requests === 0) return '';
  const magnitude = count(Math.abs(estimate.tokens));
  const direction = estimate.tokens < 0 ? 'more' : 'fewer';
  const share =
    estimate.percent === null
      ? 'share not computable'
      : `${estimate.percent.toFixed(1)}%`;
  const band =
    estimate.interval === null
      ? ' (no interval: too few requests per stratum to estimate a spread)'
      : ` (95% CI ${estimate.interval.lowPercent.toFixed(
          1
        )}% to ${estimate.interval.highPercent.toFixed(1)}%)`;
  const strata = `${count(estimate.strata)} ${
    estimate.strata === 1 ? 'stratum' : 'strata'
  }`;
  const requests = `${count(estimate.requests)} ${
    estimate.requests === 1 ? 'request' : 'requests'
  }`;
  const pooled =
    estimate.pooledRequests > 0
      ? ` ${count(estimate.pooledRequests)} of those requests sit in a stratum ` +
        'seen once, so their spread is borrowed from the pool.'
      : '';
  return (
    `${label}: ${magnitude} ${direction} output ${
      estimate.tokens === 1 ? 'token' : 'tokens'
    }, ` +
    `${share}${band}, over ${requests} in ${strata}. ${note}${pooled}`
  );
}

/**
 * One bucketed quantile, rendered as the bound it actually is.
 *
 * "UNDER", NOT "=", because the histogram knows which bucket the request fell
 * in and not where in it (`transformQuantile`); and "over" for the open last
 * bucket, so the slowest requests are never printed as a measurement.
 */
function bound(name: string, value: LatencyBound | null): string {
  if (value === null) return '';
  const digits = value.ms < 10 ? 1 : 0;
  return value.exceeded
    ? `${name} over ${value.ms.toFixed(digits)} ms`
    : `${name} under ${value.ms.toFixed(digits)} ms`;
}

/**
 * WHY THE UNCOUNTED ROWS ARE NAMED SEPARATELY FROM THE UNBILLED ONES. A request
 * the provider rejected is not a failed measurement -- there was no bill to
 * reduce -- while a billed request we could not count is exactly that, and the
 * two numbers lead an operator to different places.
 */
export function proxyGateNote(report: ProxySavingsReport): string {
  const parts: string[] = [];
  if (report.unbilledRecords > 0) {
    parts.push(
      `${count(report.unbilledRecords)} ${
        report.unbilledRecords === 1 ? 'request was' : 'requests were'
      } never billed (no 2xx response)`
    );
  }
  if (report.uncountedRecords > 0) {
    parts.push(
      `${count(report.uncountedRecords)} billed ${
        report.uncountedRecords === 1 ? 'request carries' : 'requests carry'
      } no token count`
    );
  }
  if (parts.length === 0) return '';
  const verb = parts.length === 1 ? 'is' : 'are';
  return `${parts.join(' and ')} -- ${verb} excluded from every proxy figure above.`;
}

export function renderProxySavings(
  report: ProxySavingsReport,
  options: { readonly topN: number }
): readonly string[] {
  const lines = [`\n${PROXY_SECTION}`];
  for (const window of report.windows)
    lines.push(windowLine(asSavingsWindow(window)));
  lines.push(
    ...groupLines('\nCost avoided per model:', report.byModel, options.topN)
  );
  const calibration = calibrationLine(report);
  if (calibration !== '') lines.push('', calibration);
  const latency = latencyLine(report);
  if (latency !== '') lines.push(latency);
  lines.push(...outputLines(report));
  const gate = proxyGateNote(report);
  if (gate !== '') lines.push(gate);
  const unpriced = unpricedNote(report.unpricedModels);
  if (unpriced !== '') lines.push(unpriced);
  return lines;
}

/**
 * WHY A GATE NOTE AND NOT JUST A NUMBER. An operator who ran a hundred
 * operations and sees twelve counted needs to know that the other eighty-eight
 * were not failures of compression but rows without a provable before-state.
 */
export function gateNote(report: SavingsReport): string {
  const { eligibleEntries: eligible, totalEntries: total } = report;
  const skipped = total - eligible;
  if (skipped <= 0) return '';
  // TWO AGREEMENTS, NOT ONE, and they are governed by different numbers: the
  // noun agrees with the TOTAL ("of 1 recorded operation") while the verbs
  // agree with how many were SKIPPED ("1 ... carries ... and is excluded").
  // Getting one right and the other wrong is how "1 of 1 recorded operation
  // carry" happens, and a report that looks sloppy about grammar is read as
  // sloppy about arithmetic.
  const noun = total === 1 ? 'operation' : 'operations';
  const carry = skipped === 1 ? 'carries' : 'carry';
  const excluded = skipped === 1 ? 'is excluded' : 'are excluded';
  return (
    `${count(skipped)} of ${count(total)} recorded ${noun} ${carry} ` +
    `no provable before-state and ${excluded} from every figure above.`
  );
}

/**
 * The models the catalog has no price for, named.
 *
 * ONE FORMATTER FOR BOTH TABLES, taking the id list rather than either report,
 * so the MCP half and the proxy half cannot end up describing the same gap in
 * two different sentences.
 *
 * WHAT IT DOES NOT SAY is that the figures are wrong. The token columns are
 * measured for these rows exactly as for any other; it is only the dollar
 * column that cannot be filled, and the sentence has to leave a reader with
 * that distinction rather than a vague doubt about the whole table.
 */
export function unpricedNote(models: readonly string[]): string {
  if (models.length === 0) return '';
  const noun = models.length === 1 ? 'model' : 'models';
  const their = models.length === 1 ? 'its' : 'their';
  return (
    `No catalog price for ${count(models.length)} ${noun} ` +
    `(${models.join(', ')}), so ${their} tokens count toward the ` +
    `percentages above but not the money.`
  );
}

/**
 * SECTION HEADINGS EXIST BECAUSE THERE ARE TWO INPUTS NOW. One column of
 * windows followed by another, unlabelled, reads as one table that repeats --
 * and the two prove different things, so the figures must not be addable by
 * eye. The proxy section is omitted entirely when its ledger was not read; the
 * inputs block at the bottom is what says so.
 */
/**
 * WHERE EACH RATE CAME FROM, AND HOW TO SUPPLY A MISSING ONE.
 *
 * Three different facts share this one line because an operator reading an
 * unpriced model needs exactly one of them: that their own table supplied some
 * of these rates, that it was refused and why, or that such a table is how the
 * gap gets closed. A refusal is named rather than swallowed -- a typo in the
 * path would otherwise read as money that quietly went missing.
 */
export function priceTableNote(
  status: OperatorPriceTableStatus,
  unpricedModels: number
): string {
  if (status.path !== null && status.error !== null) {
    return (
      `The operator price table at ${status.path} was refused ` +
      `(${status.error}), so no rate from it was used.`
    );
  }
  if (status.contracts > 0 && status.path !== null) {
    const noun = status.contracts === 1 ? 'rate' : 'rates';
    return (
      `${count(status.contracts)} ${noun} came from the operator price table ` +
      `at ${status.path}, labelled as yours wherever they priced a request.`
    );
  }
  if (unpricedModels > 0) {
    return (
      `To price a model the catalog does not publish, name a JSON price table ` +
      `in ${OPERATOR_PRICE_TABLE_ENV}; its rates are reported as yours, and ` +
      `nothing is ever charged at a default rate.`
    );
  }
  return '';
}

export function renderSavings(
  report: SavingsReport,
  options: {
    readonly topN: number;
    readonly proxy: ProxyInput;
    readonly priceTable: OperatorPriceTableStatus;
  }
): string {
  const lines: string[] = ['', MCP_SECTION];
  for (const window of report.windows) lines.push(windowLine(window));
  lines.push(
    ...groupLines('\nCost avoided per model:', report.byModel, options.topN),
    ...groupLines('\nSavings by client:', report.byClient, options.topN)
  );
  const gate = gateNote(report);
  if (gate !== '') lines.push('', gate);
  const unpriced = unpricedNote(report.unpricedModels);
  if (unpriced !== '') lines.push('', unpriced);
  if (options.proxy.kind === PROXY_INPUT.Read) {
    lines.push(
      ...renderProxySavings(options.proxy.report, { topN: options.topN })
    );
  }
  const table = priceTableNote(
    options.priceTable,
    report.unpricedModels.length +
      (options.proxy.kind === PROXY_INPUT.Read
        ? options.proxy.report.unpricedModels.length
        : 0)
  );
  if (table !== '') lines.push('', table);
  lines.push('', ...inputLines(report, options.proxy));
  return lines.join('\n');
}
