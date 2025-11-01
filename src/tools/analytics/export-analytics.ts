/**
 * MCP tool for exporting analytics data in JSON or CSV format
 */

import type { AnalyticsManager } from '../../analytics/analytics-manager.js';
import type {
  ExportFormat,
  HookPhase,
} from '../../analytics/analytics-types.js';

export const EXPORT_ANALYTICS_TOOL_DEFINITION = {
  name: 'export_analytics',
  description:
    'Export all analytics data in JSON or CSV format. Supports filtering by date range, hook phase, tool name, and MCP server. Useful for external analysis, reporting, and data integration.',
  inputSchema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['json', 'csv'],
        description: 'Output format: json or csv',
      },
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
      hookPhase: {
        type: 'string',
        enum: [
          'PreToolUse',
          'PostToolUse',
          'SessionStart',
          'PreCompact',
          'UserPromptSubmit',
          'Unknown',
        ],
        description: 'Optional filter by hook phase',
      },
      toolName: {
        type: 'string',
        description: 'Optional filter by tool/action name',
      },
      mcpServer: {
        type: 'string',
        description: 'Optional filter by MCP server name',
      },
    },
    required: ['format'],
  },
} as const;

export function getExportAnalyticsTool(analyticsManager: AnalyticsManager) {
  return async (args: {
    format: ExportFormat;
    startDate?: string;
    endDate?: string;
    hookPhase?: HookPhase;
    toolName?: string;
    mcpServer?: string;
  }): Promise<string> => {
    try {
      let data: string;
      const filters = {
        startDate: args.startDate,
        endDate: args.endDate,
        hookPhase: args.hookPhase,
        toolName: args.toolName,
        mcpServer: args.mcpServer,
      };

      if (args.format === 'json') {
        data = await analyticsManager.exportAsJson(filters);
      } else if (args.format === 'csv') {
        data = await analyticsManager.exportAsCsv(filters);
      } else {
        return JSON.stringify(
          {
            success: false,
            error: `Invalid format: ${args.format}. Must be 'json' or 'csv'.`,
          },
          null,
          2
        );
      }

      const entries = await analyticsManager.getEntries(filters);

      return JSON.stringify(
        {
          success: true,
          format: args.format,
          entryCount: entries.length,
          filters: {
            startDate: args.startDate || 'none',
            endDate: args.endDate || 'none',
            hookPhase: args.hookPhase || 'none',
            toolName: args.toolName || 'none',
            mcpServer: args.mcpServer || 'none',
          },
          data,
          exportedAt: new Date().toISOString(),
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
