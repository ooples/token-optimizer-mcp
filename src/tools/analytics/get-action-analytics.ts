/**
 * MCP tool for retrieving per-action token analytics
 */

import type { AnalyticsManager } from '../../analytics/analytics-manager.js';

export const GET_ACTION_ANALYTICS_TOOL_DEFINITION = {
  name: 'get_action_analytics',
  description:
    'Get detailed token usage analytics broken down by tool/action (Read, Write, Grep, Bash, count_tokens, etc.). Shows which tools consume the most tokens and identifies optimization opportunities for specific operations.',
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
    },
  },
} as const;

export function getActionAnalyticsTool(analyticsManager: AnalyticsManager) {
  return async (args: {
    startDate?: string;
    endDate?: string;
  }): Promise<string> => {
    try {
      const analytics = await analyticsManager.getActionAnalytics({
        startDate: args.startDate,
        endDate: args.endDate,
      });

      return JSON.stringify(
        {
          success: true,
          analytics,
          dateRange: {
            start: args.startDate || 'all time',
            end: args.endDate || 'present',
          },
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
