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
 * WHAT THIS REPORT DOES NOT COUNT, SAID OUT LOUD.
 *
 * The analytics ledger is written by the MCP tool path. Requests routed through
 * `token-optimizer-proxy` are accounted separately and are not in it -- so a
 * user whose savings come mostly from the proxy would read this report as the
 * product barely working. Silence about a missing input is indistinguishable
 * from a measurement of zero, and this is the line that tells them apart.
 */
export const PROXY_SCOPE_NOTE =
  'Scope: MCP tool traffic. Requests through token-optimizer-proxy are not in this ledger -- see token-optimizer-inspect.';

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

export function renderSavings(
  report: SavingsReport,
  options: { readonly topN: number }
): string {
  const lines: string[] = [''];
  for (const window of report.windows) lines.push(windowLine(window));
  const model = groupLines(
    '\nCost avoided per model:',
    report.byModel,
    options.topN
  );
  const client = groupLines(
    '\nSavings by client:',
    report.byClient,
    options.topN
  );
  lines.push(...model, ...client);
  const gate = gateNote(report);
  lines.push('', PROXY_SCOPE_NOTE);
  if (gate !== '') lines.push(gate);
  return lines.join('\n');
}
