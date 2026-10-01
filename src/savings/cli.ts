#!/usr/bin/env node
/**
 * token-optimizer-savings -- what the optimizer saved, over time, in dollars.
 *
 * WHY THIS EXISTS. The analytics ledger has carried verified, priced savings
 * for a long time, and the only way to read it was to ask an agent to call the
 * `get_optimization_report` MCP tool. That is the wrong shape for the question:
 * "what did this save me this week" is asked by a person at a shell, usually
 * while deciding whether to keep the thing installed, and it was unanswerable
 * without a running agent and a tool call.
 *
 * It is also a different question from the one that tool answers. That report
 * breaks a caller-supplied date range down by tool, hook and MCP server. This
 * one breaks the last day, week and month down by MODEL and CLIENT, because
 * those are the dimensions a bill is denominated in.
 *
 * THERE IS NO `--reset`. The competing tool has one, and it deletes its ledger.
 * Ours is shared: the dashboard, the action and hook reports and the MCP report
 * all read the same rows, so a flag on this command that emptied it would
 * destroy four other surfaces to clear one. Clearing analytics is the
 * analytics layer's decision to offer, not this reader's.
 */

import { argv, stdout } from 'process';
import { AnalyticsManager } from '../analytics/analytics-manager.js';
import type { AnalyticsEntry } from '../analytics/analytics-types.js';
import {
  OPERATOR_PRICE_TABLE_ENV,
  PRICE_TABLE_NOTE,
  operatorPriceTableStatus,
  type OperatorPriceTableStatus,
} from '../analytics/operator-prices.js';
import { buildReport, type SavingsReport } from './windows.js';
import {
  INPUTS_NOTE,
  inputLines,
  renderProxySavings,
  renderSavings,
} from './render.js';
import { loadProxyInput, PROXY_INPUT, type ProxyInput } from './proxy.js';

const DEFAULT_TOP_N = 10;

export interface Options {
  readonly topN: number;
  readonly json: boolean;
  readonly help: boolean;
  /**
   * An explicit proxy ledger, or undefined to take the one
   * `TOKEN_OPTIMIZER_PROXY_ACCOUNTING` names. UNDEFINED IS NOT "NONE": there is
   * no flag that suppresses the second input, because a report that silently
   * dropped half of what the product does is the defect this command had.
   */
  readonly proxyLedger?: string;
}

/**
 * The two scopes this command can have, named rather than spelled inline, so
 * a consumer parsing the JSON can switch on the value instead of matching text.
 */
const SCOPE = Object.freeze({
  McpOnly: 'mcp-tool-traffic',
  Both: 'mcp-tool-traffic+proxy-wire-traffic',
} as const);

const USAGE = [
  'usage: token-optimizer-savings [--top <n>] [--json] [--proxy-ledger <path>]',
  '',
  '  --top <n>             rows per breakdown (default 10)',
  '  --json                emit the report as JSON instead of text',
  '  --proxy-ledger <path> read this proxy ledger instead of the configured one',
  '',
  INPUTS_NOTE,
  '',
  PRICE_TABLE_NOTE,
].join('\n');

/** A value, or null when the next argv item is really the next flag. */
function valueArgument(raw: string | undefined): string | null {
  if (raw === undefined || raw.startsWith('--')) return null;
  return raw.length > 0 ? raw : null;
}

/** A positive whole number, or null -- a flag is never read as its own value. */
function positiveInteger(raw: string | undefined): number | null {
  if (raw === undefined || raw.startsWith('--')) return null;
  if (!/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return value > 0 ? value : null;
}

export function parseArguments(args: readonly string[]): Options | string {
  let topN = DEFAULT_TOP_N;
  let json = false;
  let help = false;
  let proxyLedger: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--top') {
      const value = positiveInteger(args[i + 1]);
      if (value === null) return '--top needs a positive whole number';
      topN = value;
      i++;
    } else if (arg === '--proxy-ledger') {
      const value = valueArgument(args[i + 1]);
      if (value === null) return '--proxy-ledger needs a path';
      proxyLedger = value;
      i++;
    } else {
      return `unknown argument: ${arg}`;
    }
  }
  return proxyLedger === undefined
    ? { topN, json, help }
    : { topN, json, help, proxyLedger };
}

export interface MainDependencies {
  /** Every analytics row, newest or oldest first -- the windows do not care. */
  readonly entries?: () => Promise<readonly AnalyticsEntry[]>;
  readonly now?: () => Date;
  readonly write?: (text: string) => void;
  /**
   * The proxy ledger's state, already read. Never throws -- see
   * `loadProxyInput`, whose four states are the point of the type.
   */
  readonly proxy?: (path: string | undefined, now: Date) => Promise<ProxyInput>;
}

/**
 * ALL ROWS, FILTERED IN MEMORY. The storage layer can filter by date range,
 * but this command needs four nested ranges at once and the widest of them is
 * "all time" -- so four queries would read the whole table anyway, three times
 * over, and would leave the windows unable to agree on what "now" was.
 */
async function readEntries(): Promise<readonly AnalyticsEntry[]> {
  const manager = new AnalyticsManager();
  try {
    return await manager.getEntries();
  } finally {
    await manager.close();
  }
}

/**
 * THE PROXY HALF OF THE JSON, INCLUDING WHEN THERE ISN'T ONE.
 *
 * `state` is always present and always one of the four loader states, so a
 * consumer can tell "the proxy saved nothing" from "the proxy was never
 * measured" without inferring it from a missing key.
 */
/**
 * READ THE CONFIGURED LEDGER, OR SAY WHY NOT. Separated from `main` only so a
 * test can hand in a state without putting a file on disk.
 */
function defaultProxy(
  path: string | undefined,
  now: Date
): Promise<ProxyInput> {
  return loadProxyInput(path === undefined ? { now } : { now, path });
}

export function proxyJson(proxy: ProxyInput): Record<string, unknown> {
  const base = {
    state: proxy.kind,
    path: proxy.kind === PROXY_INPUT.NotConfigured ? null : proxy.path,
  };
  if (proxy.kind === PROXY_INPUT.Unreadable) {
    return { ...base, reason: proxy.reason };
  }
  if (proxy.kind !== PROXY_INPUT.Read) return base;
  const { report } = proxy;
  return {
    ...base,
    measurement: {
      definition:
        'request bytes we sent against the bytes we would have sent, both counted locally, credited only to requests the provider answered 2xx',
      pricing:
        'the before-prompt price minus the after-prompt price at the model tiered rate, so a request carried back across a context threshold keeps the tier change it earned',
      calibration:
        'our count of the sent body against the prompt tokens the provider billed for that same body, summed, never averaged over per-request ratios',
    },
    windows: report.windows,
    byModel: report.byModel,
    totalRecords: report.totalRecords,
    measuredRecords: report.measuredRecords,
    unbilledRecords: report.unbilledRecords,
    uncountedRecords: report.uncountedRecords,
    skippedLines: report.skippedLines,
    unpricedModels: report.unpricedModels,
  };
}

export function savingsJson(
  report: SavingsReport,
  proxy: ProxyInput,
  priceTable: OperatorPriceTableStatus = operatorPriceTableStatus()
): Record<string, unknown> {
  return {
    scope: proxy.kind === PROXY_INPUT.Read ? SCOPE.Both : SCOPE.McpOnly,
    note: INPUTS_NOTE,
    pricing: {
      source: 'versioned-provider-model-catalog',
      definition:
        'one immediate uncached-input equivalent per verified transport delta; a model with no exact catalog entry is left unpriced rather than counted at zero',
      // THE OPERATOR'S OWN TABLE IS REPORTED, NOT FOLDED IN SILENTLY. A
      // consumer has to be able to tell a rate we can cite from one the
      // operator supplied, and a refused table has to be visible as a refusal
      // rather than as an unpriced model with no explanation.
      operatorTable: {
        env: OPERATOR_PRICE_TABLE_ENV,
        path: priceTable.path,
        contracts: priceTable.contracts,
        error: priceTable.error,
      },
    },
    measurement: {
      definition:
        'materialized undisclosed MCP payload tokens minus initial returned payload tokens, less later linked expansion payloads',
      windows:
        'nested calendar-day windows on the local clock, not a partition',
    },
    windows: report.windows,
    byModel: report.byModel,
    byClient: report.byClient,
    totalEntries: report.totalEntries,
    eligibleEntries: report.eligibleEntries,
    unpricedModels: report.unpricedModels,
    proxy: proxyJson(proxy),
  };
}

export async function main(
  args: readonly string[],
  dependencies: MainDependencies = {}
): Promise<number> {
  const write =
    dependencies.write ?? ((text: string) => void stdout.write(text));
  const line = (text: string): void => write(`${text}\n`);

  const parsed = parseArguments(args);
  if (typeof parsed === 'string') {
    // THE REFUSAL GOES ABOVE THE USAGE, not below it: the reader's eye lands at
    // the top of the new output, and a reason printed under a wall of help text
    // is a reason nobody reads.
    line(`token-optimizer-savings: ${parsed}`);
    line('');
    line(USAGE);
    return 2;
  }
  if (parsed.help) {
    line(USAGE);
    return 0;
  }

  let entries: readonly AnalyticsEntry[];
  try {
    entries = await (dependencies.entries ?? readEntries)();
  } catch (error) {
    // AN UNREADABLE LEDGER IS NAMED, NOT SWALLOWED. The usual cause is that
    // nothing has written one yet, and the usual next question is "where would
    // it be" -- so the reason travels with the refusal.
    line(
      `token-optimizer-savings: could not read analytics: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return 1;
  }

  const now = (dependencies.now ?? (() => new Date()))();
  const report = buildReport(entries, now);
  // THE SECOND INPUT IS READ EVEN WHEN THE FIRST ONE IS EMPTY. A fresh install
  // that routed everything through the proxy has no analytics rows at all, and
  // the old command answered it with "No verified savings recorded yet" while a
  // ledger full of measured reductions sat unread beside it.
  const proxy = await (dependencies.proxy ?? defaultProxy)(
    parsed.proxyLedger,
    now
  );

  if (parsed.json) {
    line(JSON.stringify(savingsJson(report, proxy), null, 2));
    return 0;
  }

  if (report.eligibleEntries === 0) {
    // NOT AN ERROR, AND NOT A BLANK TABLE. Zero measurable MCP rows is the
    // state a fresh install is in, and the useful answer is how to leave it --
    // but it is only half the report, so the proxy section and the inputs
    // block still print under it.
    line('No verified MCP savings recorded yet.');
    line(
      report.totalEntries === 0
        ? 'Nothing has been recorded. Use the token-optimizer MCP tools, then re-run this command.'
        : `${report.totalEntries} ${
            report.totalEntries === 1 ? 'operation was' : 'operations were'
          } recorded, none with a provable before-state.`
    );
    if (proxy.kind === PROXY_INPUT.Read) {
      for (const text of renderProxySavings(proxy.report, {
        topN: parsed.topN,
      }))
        line(text);
    }
    line('');
    for (const text of inputLines(report, proxy)) line(text);
    return 0;
  }

  line(
    renderSavings(report, {
      topN: parsed.topN,
      proxy,
      priceTable: operatorPriceTableStatus(),
    })
  );
  return 0;
}

/*
 * ENTRY GUARD, NOT A BARE CALL. Importing this module from a test must not run
 * the command, and `process.exitCode` rather than `process.exit` because a
 * closing handle plus `process.exit()` aborts on Windows inside libuv and the
 * shell is handed 127 instead of the status this function worked out.
 */
const invoked = argv[1] ?? '';
if (/savings[\\/]cli\.(js|ts)$/.test(invoked)) {
  main(argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      stdout.write(
        `token-optimizer-savings failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
      process.exitCode = 1;
    }
  );
}
