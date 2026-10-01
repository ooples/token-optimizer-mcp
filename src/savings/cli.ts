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
import { buildReport, type SavingsReport } from './windows.js';
import { renderSavings, PROXY_SCOPE_NOTE } from './render.js';

const DEFAULT_TOP_N = 10;

export interface Options {
  readonly topN: number;
  readonly json: boolean;
  readonly help: boolean;
}

const USAGE = [
  'usage: token-optimizer-savings [--top <n>] [--json]',
  '',
  '  --top <n>   rows per breakdown (default 10)',
  '  --json      emit the report as JSON instead of text',
  '',
  PROXY_SCOPE_NOTE,
].join('\n');

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
    } else {
      return `unknown argument: ${arg}`;
    }
  }
  return { topN, json, help };
}

export interface MainDependencies {
  /** Every analytics row, newest or oldest first -- the windows do not care. */
  readonly entries?: () => Promise<readonly AnalyticsEntry[]>;
  readonly now?: () => Date;
  readonly write?: (text: string) => void;
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

export function savingsJson(report: SavingsReport): Record<string, unknown> {
  return {
    scope: 'mcp-tool-traffic',
    note: PROXY_SCOPE_NOTE,
    pricing: {
      source: 'versioned-provider-model-catalog',
      definition:
        'one immediate uncached-input equivalent per verified transport delta; a model with no exact catalog entry is left unpriced rather than counted at zero',
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

  const report = buildReport(
    entries,
    (dependencies.now ?? (() => new Date()))()
  );

  if (parsed.json) {
    line(JSON.stringify(savingsJson(report), null, 2));
    return 0;
  }

  if (report.eligibleEntries === 0) {
    // NOT AN ERROR, AND NOT A BLANK TABLE. Zero measurable rows is the state a
    // fresh install is in, and the useful answer is how to leave it.
    line('No verified savings recorded yet.');
    line(
      report.totalEntries === 0
        ? 'Nothing has been recorded. Use the token-optimizer MCP tools, then re-run this command.'
        : `${report.totalEntries} ${
            report.totalEntries === 1 ? 'operation was' : 'operations were'
          } recorded, none with a provable before-state.`
    );
    line('');
    line(PROXY_SCOPE_NOTE);
    return 0;
  }

  line(renderSavings(report, { topN: parsed.topN }));
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
