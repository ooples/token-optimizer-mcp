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

export const GET_OPTIMIZATION_REPORT_TOOL_DEFINITION = {
  name: 'get_optimization_report',
  description:
    'Get a complete token-savings report: total tokens saved, overall savings %, and full breakdowns by action/tool, by hook phase, and by MCP server. Returns structured data plus a ready-to-display formatted text summary. Use this to show the user how much context/token budget token-optimizer has saved them.',
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

/** Approximate USD saved, assuming input-token pricing (~$3 / 1M tokens). */
function approxCost(tokens: number): string {
  const usd = (tokens / 1_000_000) * 3;
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
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

      const [hook, action, server, totalCount] = await Promise.all([
        analyticsManager.getHookAnalytics(range),
        analyticsManager.getActionAnalytics(range),
        analyticsManager.getServerAnalytics(range),
        analyticsManager.count(),
      ]);

      // If scoped to a session, recompute the summary from filtered entries.
      let summary = action.summary;
      let byAction = action.byAction;
      if (args.sessionId) {
        const entries = await analyticsManager.getEntries({
          sessionId: args.sessionId,
          startDate: args.startDate,
          endDate: args.endDate,
        });
        const totalOriginalTokens = entries.reduce(
          (s, e) => s + e.originalTokens,
          0
        );
        const totalOptimizedTokens = entries.reduce(
          (s, e) => s + e.optimizedTokens,
          0
        );
        const totalTokensSaved = entries.reduce((s, e) => s + e.tokensSaved, 0);
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

      const formatted = [
        '╔══ Token Optimizer — Savings Report ══╗',
        `  scope: ${scope}`,
        '',
        `  ✨ Total tokens saved : ${num(
          summary.totalTokensSaved
        )}  (~${approxCost(summary.totalTokensSaved)} @ $3/1M)`,
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
      ].join('\n');

      return JSON.stringify(
        {
          success: true,
          scope,
          summary: { ...summary, savingsPercentage },
          approxUsdSaved: approxCost(summary.totalTokensSaved),
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
