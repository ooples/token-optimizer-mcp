/**
 * MCP tool for retrieving per-MCP-server token analytics
 */

import type { AnalyticsManager } from '../../analytics/analytics-manager.js';

export const GET_MCP_SERVER_ANALYTICS_TOOL_DEFINITION = {
  name: 'get_mcp_server_analytics',
  description:
    'Get detailed token usage analytics broken down by MCP server (token-optimizer, filesystem, github, etc.). Shows which MCP servers are contributing the most to token usage and helps identify cross-server optimization opportunities.',
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

export function getMcpServerAnalyticsTool(analyticsManager: AnalyticsManager) {
  return async (args: {
    startDate?: string;
    endDate?: string;
  }): Promise<string> => {
    try {
      const analytics = await analyticsManager.getServerAnalytics({
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
