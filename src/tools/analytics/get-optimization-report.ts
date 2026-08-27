/**
 * MCP tool: get_optimization_report
 *
 * One-stop, user-facing summary of everything token-optimizer has saved:
 * total tokens saved, overall savings %, and full breakdowns by action (tool),
 * by hook phase, and by MCP server. Returns both a structured object (for
 * programmatic use / dashboards) and a pre-rendered `formatted` text report so
 * any agent can show the user a clean summary without post-processing.
 */

import type { AnalyticsManager } from '../../analytics/analytics-manager.js';
import type { AggregatedStats } from '../../analytics/analytics-types.js';
import {
  hasObservedReturnedContext,
  isVerifiedSavingsEntry,
  verifiedTransportDelta,
} from '../../analytics/savings-classification.js';
import { priceTokenUsage } from '../../analytics/provider-pricing.js';
import type { AnalyticsEntry } from '../../analytics/analytics-types.js';
import path from 'path';
import { dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

export const GET_OPTIMIZATION_REPORT_TOOL_DEFINITION = {
  name: 'get_optimization_report',
  description:
    'Get a provenance-gated token report. Verified savings require a materialized MCP payload before and after optimization; historical and tool-reported estimates are excluded. Direct API-price equivalents use each exact captured model and route; ambiguous operations remain unpriced.',
  inputSchema: {
    type: 'object',
    properties: {
      startDate: {
        type: 'string',
        description:
          'Optional start date filter in ISO 8601 format (e.g., 2025-01-01T00:00:00Z)',
      },
      endDate: {
        type: 'string',
        description:
          'Optional end date filter in ISO 8601 format (e.g., 2025-12-31T23:59:59Z)',
      },
      sessionId: {
        type: 'string',
        description:
          'Optional session ID to scope the report to a single session.',
      },
      topN: {
        type: 'number',
        description:
          'Limit each breakdown to the top N rows by tokens saved (default: 10).',
      },
    },
  },
} as const;

function num(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function directPrice(entries: AnalyticsEntry[]): {
  amount: number | null;
  display: string;
  pricedOperations: number;
  eligibleOperations: number;
} {
  let amount = 0;
  let pricedOperations = 0;
  const eligible = entries.filter(
    (entry) => verifiedTransportDelta(entry) !== 0
  );
  for (const entry of eligible) {
    const tokens = verifiedTransportDelta(entry);
    const metadata = entry.metadata || {};
    const priced = priceTokenUsage({
      client: entry.client || String(metadata.client || ''),
      provider: String(metadata.provider || ''),
      route: String(metadata.pricingRoute || metadata.route || ''),
      model: entry.model || String(metadata.model || ''),
      timestamp: entry.timestamp,
      usage: { uncachedInputTokens: Math.abs(tokens) },
    });
    if (
      !priced.available ||
      priced.currency !== 'USD' ||
      priced.amount === null
    )
      continue;
    amount += Math.sign(tokens) * priced.amount;
    pricedOperations += 1;
  }
  return {
    amount: pricedOperations ? amount : null,
    display:
      pricedOperations === 0
        ? 'not priced'
        : Math.abs(amount) < 0.01
          ? '<$0.01'
          : `$${amount.toFixed(2)}`,
    pricedOperations,
    eligibleOperations: eligible.length,
  };
}

function bar(fraction: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function renderTable(
  title: string,
  rows: AggregatedStats[],
  topN: number
): string {
  if (rows.length === 0) return `${title}\n  (no data yet)\n`;
  const shown = rows.slice(0, topN);
  const maxSaved = Math.max(...shown.map((r) => r.totalTokensSaved), 1);
  const nameW = Math.max(4, ...shown.map((r) => r.name.length));

  const lines = shown.map((r) => {
    const name = r.name.padEnd(nameW);
    const saved = num(r.totalTokensSaved).padStart(10);
    const savePct = pct(r.savingsPercentage).padStart(7);
    const ops = String(r.totalOperations).padStart(5);
    return `  ${name}  ${saved}  ${savePct}  ${ops}  ${bar(
      r.totalTokensSaved / maxSaved
    )}`;
  });

  const header = `  ${'name'.padEnd(nameW)}  ${'saved'.padStart(
    10
  )}  ${'save%'.padStart(7)}  ${'ops'.padStart(5)}`;
  const extra =
    rows.length > topN ? `\n  ... and ${rows.length - topN} more\n` : '\n';
  return `${title}\n${header}\n${lines.join('\n')}\n${extra}`;
}

/** Resolves hooks-core relative to the built output, which lives in dist/tools/analytics. */
function coreUrl(name: string): string {
  return pathToFileURL(path.join(here, '..', '..', '..', 'hooks-core', name))
    .href;
}

interface GraphPricing {
  dollars: (n: number) => number | null;
  money: (a: number | null) => string;
  priceNote: () => string;
}

/**
 * The graph's own balance sheet, or nothing.
 *
 * FAILS OPEN, like every other hooks-core bridge in this codebase: the savings
 * report is what a user runs when something already looks wrong, so a missing
 * graph module must cost them a section rather than the report.
 */
async function graphSection(): Promise<{
  sheet: Record<string, unknown>;
  lines: string[];
} | null> {
  try {
    const [cross, wiki, pricing] = await Promise.all([
      import(coreUrl('crosslayer.mjs')),
      import(coreUrl('wiki.mjs')),
      import(coreUrl('pricing.mjs')),
    ]);
    const dir = wiki.wikiDir(process.cwd());
    const sheet = cross.graphBalanceSheet(dir);
    // THE OTHER HALF OF #204's ACCEPTANCE TEST. The issue asks for "hit rate
    // and token balance" together, and this block carried only the balance:
    // what the graph SPENT and SAVED, with nothing about whether anything it
    // injected was ever used. Those are the two halves of one question -- a
    // positive balance built on findings nobody read is the overhead this
    // project says it must not become -- so they belong in one block rather
    // than one here and one in `token_audit`.
    let reference: string | null = null;
    try {
      const usage = await import(coreUrl('usage.mjs'));
      reference = usage.referenceNote(dir);
    } catch {
      // A missing usage module costs the line, not the section.
    }
    return {
      sheet,
      lines: renderGraph(sheet, pricing as GraphPricing, reference),
    };
  } catch {
    return null;
  }
}

/**
 * The graph block, with CURRENCY ON EXACTLY ONE LINE.
 *
 * The rule is the project's own: a dollar figure may appear beside a MEASURED
 * COUNTERFACTUAL -- a substitution whose control arm's cost was recorded -- and
 * nowhere else. The holdout estimate, the consolidation ratio and the
 * calibration verdict are estimates, and pricing an estimate makes a headline
 * saving larger for free, which is exactly the measurement-bias class this work
 * exists to close. Each of those lines says "estimate" and carries no currency,
 * which a test checks by reading the rendered text rather than by trusting this
 * comment.
 */
function renderGraph(
  sheet: Record<string, any>,
  pricing: GraphPricing,
  reference: string | null = null
): string[] {
  const lines: string[] = ['▸ Graph balance sheet'];
  const mc = sheet.measuredCounterfactual || {};
  const avoided = Number(mc.tokensAvoidedNet || 0);
  // The ONE priced line: a substitution whose control arm was measured.
  lines.push(
    `  measured counterfactual : ${num(avoided)} tokens avoided net over ${num(
      Number(mc.substitutions || 0)
    )} substitution(s), ${num(
      Number(mc.withheld || 0)
    )} withheld; ${pricing.money(pricing.dollars(avoided))}`
  );

  const ec = sheet.estimatedCausal || {};
  lines.push(
    `  estimated causal        : ${num(
      Number(ec.tokensAvoided || 0)
    )} tokens from ${num(Number(ec.treated || 0))} treated and ${num(
      Number(ec.holdouts || 0)
    )} holdout injection(s) -- estimate, deliberately not priced`
  );

  const con = sheet.consolidation;
  lines.push(
    con && con.withDerivedCost
      ? `  consolidation           : ${num(con.withDerivedCost)} of ${num(
          con.findings
        )} finding(s) carry a derivation cost, ${(
          con.aggregate?.ratio || 0
        ).toFixed(
          1
        )}x cost-to-derive over cost-to-carry -- estimate, deliberately not priced`
      : '  consolidation           : no finding carries a derivation cost yet -- estimate, deliberately not priced'
  );

  // HIT RATE, and NULL IS AN ANSWER. `referenceNote` returns null when it has
  // nothing honest to say and its own sentence when it cannot measure yet, so
  // the absent case is stated rather than rendered as a zero -- an unmeasured
  // hit rate printed as 0% would read as "nothing is ever used", which is the
  // unknown-becomes-zero error this report corrects everywhere else.
  lines.push(
    reference
      ? `  hit rate                : ${reference}`
      : '  hit rate                : not measurable yet -- no injection has been followed by a query'
  );

  const waste = sheet.waste || {};
  // THE UNDECIDABLE COUNT TRAVELS WITH THE FIGURE. `rereadWaste` splits repeats
  // into confirmed waste, legitimate re-reads of a CHANGED file, and repeats
  // written before fingerprints existed -- and its own docstring says the third
  // group is reported rather than hidden, because a reader has to know the
  // classification is incomplete. Printing only the confirmed number is
  // conservative, but silently conservative is still a number without its
  // error bar.
  lines.push(
    `  re-read waste           : ${num(
      Number(waste.wastefulTokens || 0)
    )} tokens over ${num(
      Number(waste.wasteful || 0)
    )} unchanged repeat read(s), ${num(
      Number(waste.undecidable || 0)
    )} repeat(s) unclassifiable`
  );

  const l1 = sheet.layer1;
  lines.push(
    `  Layer 1 (reference)     : ${
      l1
        ? `${num(l1.referenced)}/${num(
            l1.denominator
          )} injected findings referenced later${
            l1.rate === null
              ? ', no rate published'
              : ` (${pct(l1.rate * 100)})`
          }`
        : 'unavailable'
    }`
  );
  const l2 = sheet.layer2;
  lines.push(
    `  Layer 2 (suppression)   : ${
      l2
        ? `${num(l2.observations)} observation(s), ${num(
            l2.published
          )} published effect(s)`
        : 'unavailable'
    }`
  );
  lines.push(
    `  calibration             : ${sheet.calibration?.verdict || 'unavailable'}`
  );

  // AN OFFLINE PROBE, AND THE LINE SAYS SO. It observes nothing a session did:
  // it deletes each anchor edge in memory and re-runs traversal and BM25 over
  // the graph as it stands. `rate` is deliberately absent more often than
  // present -- the by-construction check that always returns 1.0 is reported as
  // `integrity` and is never printed as a recall rate.
  const recall = sheet.recall;
  lines.push(
    `  recall (offline probe)  : ${
      recall
        ? recall.rate === null
          ? `no rate -- ${recall.reason}`
          : `${pct(recall.rate * 100)} of ${num(
              recall.probed
            )} finding(s) recovered without their own anchor edge -- offline probe over the current graph`
        : 'unavailable'
    }`
  );
  lines.push(`  ${pricing.priceNote()}`);
  return lines;
}

export function getOptimizationReportTool(analyticsManager: AnalyticsManager) {
  return async (args: {
    startDate?: string;
    endDate?: string;
    sessionId?: string;
    topN?: number;
  }): Promise<string> => {
    try {
      const topN = args.topN && args.topN > 0 ? args.topN : 10;
      const range = { startDate: args.startDate, endDate: args.endDate };

      const [hook, action, server, totalCount, scopedEntries] =
        await Promise.all([
          analyticsManager.getHookAnalytics(range),
          analyticsManager.getActionAnalytics(range),
          analyticsManager.getServerAnalytics(range),
          analyticsManager.count(),
          analyticsManager.getEntries({
            startDate: args.startDate,
            endDate: args.endDate,
            sessionId: args.sessionId,
          }),
        ]);

      // If scoped to a session, recompute the summary from filtered entries.
      let summary = action.summary;
      let byAction = action.byAction;
      if (args.sessionId) {
        const entries = scopedEntries;
        const verifiedEntries = entries.filter(isVerifiedSavingsEntry);
        const observedEntries = entries.filter(hasObservedReturnedContext);
        const totalOriginalTokens = verifiedEntries.reduce(
          (s, e) => s + e.originalTokens,
          0
        );
        const totalOptimizedTokens = observedEntries.reduce(
          (s, e) => s + e.optimizedTokens,
          0
        );
        const totalTokensSaved = entries.reduce(
          (s, e) => s + verifiedTransportDelta(e),
          0
        );
        summary = {
          totalOperations: entries.length,
          totalTokensSaved,
          totalOriginalTokens,
          totalOptimizedTokens,
        };
      }

      const savingsPercentage =
        summary.totalOriginalTokens > 0
          ? (summary.totalTokensSaved / summary.totalOriginalTokens) * 100
          : 0;

      const scope = args.sessionId
        ? `session ${args.sessionId}`
        : `${args.startDate || 'all time'} → ${args.endDate || 'present'}`;

      const cost = directPrice(scopedEntries);
      const graph = await graphSection();

      const formatted = [
        '╔══ Token Optimizer — Verified Savings Report ══╗',
        `  scope: ${scope}`,
        '',
        `  ✨ Verified saved     : ${num(summary.totalTokensSaved)}`,
        `  💵 Direct API price  : ${cost.display} (${num(cost.pricedOperations)}/${num(cost.eligibleOperations)} savings operations exactly modeled)`,
        `  \u{1F4E5} Original tokens    : ${num(summary.totalOriginalTokens)}`,
        `  \u{1F4E6} After optimization : ${num(summary.totalOptimizedTokens)}`,
        `  \u{1F4C9} Overall reduction  : ${pct(savingsPercentage)}  ${bar(
          savingsPercentage / 100
        )}`,
        `  \u{1F527} Operations tracked : ${num(
          summary.totalOperations
        )}  (${num(totalCount)} all-time)`,
        '',
        renderTable('▸ By action (tool)', byAction, topN),
        renderTable('▸ By hook phase', hook.byHook, topN),
        renderTable('▸ By MCP server', server.byServer, topN),
        ...(graph ? graph.lines : []),
      ].join('\n');

      return JSON.stringify(
        {
          success: true,
          scope,
          summary: { ...summary, savingsPercentage },
          costEquivalentUsd: cost.amount,
          pricing: {
            source: 'versioned-provider-model-catalog',
            pricedOperations: cost.pricedOperations,
            eligibleOperations: cost.eligibleOperations,
            definition:
              'one immediate uncached-input equivalent per verified transport delta; hypothetical future cache reuse is excluded',
          },
          measurement: {
            definition:
              'materialized undisclosed MCP payload tokens minus initial returned payload tokens, less later linked expansion payloads',
            legacyPolicy:
              'rows without versioned comparable-baseline provenance are excluded',
          },
          graph: graph ? graph.sheet : null,
          byAction,
          byHook: hook.byHook,
          byServer: server.byServer,
          formatted,
        },
        null,
        2
      );
    } catch (error) {
      return JSON.stringify(
        {
          success: false,
          error:
            error instanceof Error ? error.message : 'Unknown error occurred',
        },
        null,
        2
      );
    }
  };
}
