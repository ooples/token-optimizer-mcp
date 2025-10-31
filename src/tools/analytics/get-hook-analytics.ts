/**
 * MCP tool for retrieving per-hook token analytics
 */

import type { AnalyticsManager } from '../../analytics/analytics-manager.js';

export const GET_HOOK_ANALYTICS_TOOL_DEFINITION = {
  name: 'get_hook_analytics',
  description:
    'Get detailed token usage analytics broken down by hook phase (PreToolUse, PostToolUse, SessionStart, PreCompact, UserPromptSubmit). Shows which hook phases consume the most tokens and where optimization efforts should be focused.',
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

export function getHookAnalyticsTool(analyticsManager: AnalyticsManager) {
  return async (args: {
    startDate?: string;
    endDate?: string;
  }): Promise<string> => {
    try {
      const analytics = await analyticsManager.getHookAnalytics({
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
