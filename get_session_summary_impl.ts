// Implementation for get_session_summary tool
// To be integrated into src/server/index.ts

// Note: .js extensions are required for ES module imports in TypeScript.
// This is the correct syntax for runtime module resolution in Node.js ESM.
import { analyzeTokenUsage, SessionAnalysisOptions } from './analysis/session-analyzer.js';
import { TurnData } from './utils/thinking-mode.js';

// Analysis configuration constants
const TOP_N_DEFAULT = 10;
const ANOMALY_THRESHOLD_DEFAULT = 3;

case 'get_session_summary': {
  const { sessionId } = args as { sessionId?: string };

  try {
    const hooksDataPath = path.join(os.homedir(), '.claude-global', 'hooks', 'data');
    let targetSessionId = sessionId;

    // Get session ID from current-session.txt if not provided
    if (!targetSessionId) {
      const sessionFilePath = path.join(hooksDataPath, 'current-session.txt');
      if (!fs.existsSync(sessionFilePath)) {
        throw new Error('No active session found');
      }
      const sessionContent = fs.readFileSync(sessionFilePath, 'utf-8').replace(/^\uFEFF/, '');
      const sessionData = JSON.parse(sessionContent);
      targetSessionId = sessionData.sessionId;
    }

    // Read session-log.jsonl
    const jsonlFilePath = path.join(hooksDataPath, `session-log-${targetSessionId}.jsonl`);

    if (!fs.existsSync(jsonlFilePath)) {
      // Fallback: Use CSV format for backward compatibility
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: `JSONL log not found for session ${targetSessionId}. This session may not have JSONL logging enabled yet.`,
              jsonlFilePath,
              note: 'Use get_session_stats for CSV-based sessions',
            }),
          },
        ],
      };
    }

    // Parse JSONL file
    const jsonlContent = fs.readFileSync(jsonlFilePath, 'utf-8');
    const lines = jsonlContent.trim().split('\n');

    // Initialize statistics
    let sessionStartTime = '';
    let sessionEndTime = '';
    let totalTurns = 0;
    let totalTools = 0;
    let totalHooks = 0;

    const tokensByCategory: Record<string, number> = {
      tools: 0,
      hooks: 0,
      responses: 0,
      system_reminders: 0,
    };

    const tokensByServer: Record<string, number> = {};
    const toolDurations: number[] = [];
    const toolBreakdown: Record<string, { count: number; tokens: number; totalDuration: number }> = {};
    const hookBreakdown: Record<string, { count: number; tokens: number }> = {};
    const turnDataForAnalysis: TurnData[] = [];

    // Parse each JSONL event
    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);

        // Extract session start/end times
        if (event.type === 'session_start') {
          sessionStartTime = event.timestamp;
        }

        if (event.type === 'session_end') {
          sessionEndTime = event.timestamp;
        }

        // Count turns (maximum turn number seen)
        if (event.turn && event.turn > totalTurns) {
          totalTurns = event.turn;
        }

        // Process tool calls
        if (event.type === 'tool_call') {
          totalTools++;
          const tokens = event.estimatedTokens || 0;
          tokensByCategory.tools += tokens;

          // Track by tool name
          if (!toolBreakdown[event.toolName]) {
            toolBreakdown[event.toolName] = { count: 0, tokens: 0, totalDuration: 0 };
          }
          toolBreakdown[event.toolName].count++;
          toolBreakdown[event.toolName].tokens += tokens;

          // Track by MCP server (for tools starting with mcp__)
          if (event.toolName.startsWith('mcp__')) {
            const serverName = event.toolName.split('__')[1] || 'unknown';
            tokensByServer[serverName] = (tokensByServer[serverName] || 0) + tokens;
          }

          // Collect data for advanced analysis
          turnDataForAnalysis.push({
            timestamp: event.timestamp,
            toolName: event.toolName,
            tokens,
            metadata: event.metadata || '',
          });
        }

        // Process tool results (duration tracking)
        if (event.type === 'tool_result' && event.duration_ms) {
          toolDurations.push(event.duration_ms);

          // Add duration to tool breakdown
          if (toolBreakdown[event.toolName]) {
            toolBreakdown[event.toolName].totalDuration += event.duration_ms;
          }
        }

        // Process hook executions
        if (event.type === 'hook_execution') {
          totalHooks++;
          const tokens = event.estimated_tokens || 0;
          tokensByCategory.hooks += tokens;

          // Track by hook name
          if (!hookBreakdown[event.hookName]) {
            hookBreakdown[event.hookName] = { count: 0, tokens: 0 };
          }
          hookBreakdown[event.hookName].count++;
          hookBreakdown[event.hookName].tokens += tokens;
        }

        // Process system reminders
        if (event.type === 'system_reminder') {
          const tokens = event.tokens || 0;
          tokensByCategory.system_reminders += tokens;
        }
      } catch (parseError) {
        // Skip malformed JSONL lines
        continue;
      }
    }

    // Calculate total tokens
    const totalTokens = Object.values(tokensByCategory).reduce((sum, val) => sum + val, 0);

    // Calculate duration
    let duration = 'Unknown';
    if (sessionStartTime) {
      const endTime = sessionEndTime || new Date().toISOString().replace('T', ' ').substring(0, 19);
      const start = new Date(sessionStartTime);
      const end = new Date(endTime);
      const diffMs = end.getTime() - start.getTime();
      const minutes = Math.floor(diffMs / 60000);
      const seconds = Math.floor((diffMs % 60000) / 1000);
      duration = `${minutes}m ${seconds}s`;
    }

    // Calculate average tool duration
    const avgToolDuration = toolDurations.length > 0
      ? Math.round(toolDurations.reduce((sum, d) => sum + d, 0) / toolDurations.length)
      : 0;

    // Run advanced analysis with error handling
    let analysis = null;
    if (turnDataForAnalysis.length > 0) {
      try {
        const options: SessionAnalysisOptions = { topN: TOP_N_DEFAULT, anomalyThreshold: ANOMALY_THRESHOLD_DEFAULT };
        analysis = analyzeTokenUsage(turnDataForAnalysis, options);
      } catch (err) {
        // Gracefully degrade if analysis fails - session summary will continue without enhanced analytics
        analysis = null;
      }
    }

    // Helper function to calculate percentage with 2 decimal precision
    const calculatePercentage = (value: number, total: number): number => {
      return total > 0 ? Math.round(value / total * 10000) / 100 : 0;
    };

    // Build response
    const summary = {
      success: true,
      sessionId: targetSessionId,
      totalTokens,
      totalTurns,
      totalTools,
      totalHooks,
      duration,
      tokensByCategory: {
        tools: {
          tokens: tokensByCategory.tools,
          percent: calculatePercentage(tokensByCategory.tools, totalTokens),
        },
        hooks: {
          tokens: tokensByCategory.hooks,
          percent: calculatePercentage(tokensByCategory.hooks, totalTokens),
        },
        responses: {
          tokens: tokensByCategory.responses,
          percent: calculatePercentage(tokensByCategory.responses, totalTokens),
        },
        system_reminders: {
          tokens: tokensByCategory.system_reminders,
          percent: calculatePercentage(tokensByCategory.system_reminders, totalTokens),
        },
      },
      tokensByServer,
      toolBreakdown,
      hookBreakdown,
      performance: {
        avgToolDuration_ms: avgToolDuration,
        totalToolCalls: totalTools,
        toolsWithDuration: toolDurations.length,
      },
      // Enhanced analytics
      hourlyTrends: analysis?.hourlyTrend || [],
      toolCallPatterns: analysis?.topConsumers || [],
      serverEfficiency: analysis?.byServer || [],
      thinkingModeAnalysis: analysis ? {
        thinkingTurns: analysis.summary.thinkingTurns,
        planningTurns: analysis.summary.planningTurns,
        normalTurns: analysis.summary.normalTurns,
        thinkingModePercent: analysis.efficiency.thinkingModePercent,
      } : null,
      anomalies: analysis?.anomalies || [],
      recommendations: analysis?.recommendations || [],
      efficiency: analysis ? {
        tokensPerTool: Math.round(analysis.efficiency.tokensPerTool),
        cacheHitPotential: analysis.efficiency.cacheHitPotential,
      } : null,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      ],
      isError: true,
    };
  }
}
