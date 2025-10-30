/**
 * Unit tests for session-analyzer.ts
 * Tests hourly trends, tool call patterns, and server efficiency analytics
 */

import { describe, it, expect } from '@jest/globals';
import {
  analyzeTokenUsage,
  SessionAnalysisOptions,
  ToolUsageStats,
  ServerUsageStats,
  HourlyUsageStats,
} from '../../src/analysis/session-analyzer.js';
import { TurnData } from '../../src/utils/thinking-mode.js';

describe('Session Analyzer - Enhanced Analytics', () => {
  // Sample test data
  const createSampleOperations = (): TurnData[] => {
    return [
      {
        timestamp: '2025-10-29 10:15:00',
        toolName: 'Read',
        tokens: 500,
        metadata: '/path/to/file1.ts',
      },
      {
        timestamp: '2025-10-29 10:15:00',
        toolName: 'Grep',
        tokens: 300,
        metadata: 'pattern search',
      },
      {
        timestamp: '2025-10-29 10:30:00',
        toolName: 'Read',
        tokens: 600,
        metadata: '/path/to/file2.ts',
      },
      {
        timestamp: '2025-10-29 10:30:00',
        toolName: 'mcp__ambiance__local_context',
        tokens: 800,
        metadata: 'context analysis',
      },
      {
        timestamp: '2025-10-29 11:00:00',
        toolName: 'Write',
        tokens: 400,
        metadata: '/path/to/output.ts',
      },
      {
        timestamp: '2025-10-29 11:00:00',
        toolName: 'mcp__sequential-thinking__analyze',
        tokens: 1200,
        metadata: 'thinking mode',
      },
      {
        timestamp: '2025-10-29 11:15:00',
        toolName: 'Bash',
        tokens: 200,
        metadata: 'npm test',
      },
      {
        timestamp: '2025-10-29 11:15:00',
        toolName: 'mcp__ambiance__local_context',
        tokens: 750,
        metadata: 'context update',
      },
    ];
  };

  describe('Hourly Token Usage Trends', () => {
    it('should calculate hourly trends correctly', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      expect(result.hourlyTrend).toBeDefined();
      expect(Array.isArray(result.hourlyTrend)).toBe(true);
      expect(result.hourlyTrend.length).toBeGreaterThan(0);
    });

    it('should group operations by hour', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      const hourlyTrend = result.hourlyTrend;

      // Should have data for 10:00 and 11:00 hours
      const hours = hourlyTrend.map((h) => h.hour);
      expect(hours).toContain('10:00');
      expect(hours).toContain('11:00');
    });

    it('should calculate total tokens per hour correctly', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      const hour10 = result.hourlyTrend.find((h) => h.hour === '10:00');
      expect(hour10).toBeDefined();
      // 10:15: 500 + 300 = 800
      // 10:30: 600 + 800 = 1400
      // Total: 2200
      expect(hour10!.totalTokens).toBe(2200);

      const hour11 = result.hourlyTrend.find((h) => h.hour === '11:00');
      expect(hour11).toBeDefined();
      // 11:00: 400 + 1200 = 1600
      // 11:15: 200 + 750 = 950
      // Total: 2550
      expect(hour11!.totalTokens).toBe(2550);
    });

    it('should calculate operation count per hour', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      const hour10 = result.hourlyTrend.find((h) => h.hour === '10:00');
      expect(hour10!.operationCount).toBe(4); // 2 at 10:15 + 2 at 10:30

      const hour11 = result.hourlyTrend.find((h) => h.hour === '11:00');
      expect(hour11!.operationCount).toBe(4); // 2 at 11:00 + 2 at 11:15
    });

    it('should calculate average tokens per operation in each hour', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      const hour10 = result.hourlyTrend.find((h) => h.hour === '10:00');
      expect(hour10!.averageTokens).toBe(2200 / 4); // 550

      const hour11 = result.hourlyTrend.find((h) => h.hour === '11:00');
      expect(hour11!.averageTokens).toBe(2550 / 4); // 637.5
    });

    it('should sort hourly trends chronologically', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      const hours = result.hourlyTrend.map((h) => h.hour);
      const sortedHours = [...hours].sort();
      expect(hours).toEqual(sortedHours);
    });

    it('should handle single hour of operations', () => {
      const operations: TurnData[] = [
        {
          timestamp: '2025-10-29 14:00:00',
          toolName: 'Read',
          tokens: 500,
          metadata: 'test',
        },
        {
          timestamp: '2025-10-29 14:30:00',
          toolName: 'Write',
          tokens: 300,
          metadata: 'test',
        },
      ];

      const result = analyzeTokenUsage(operations);
      expect(result.hourlyTrend.length).toBe(1);
      expect(result.hourlyTrend[0].hour).toBe('14:00');
      expect(result.hourlyTrend[0].totalTokens).toBe(800);
    });
  });

  describe('Tool Call Patterns', () => {
    it('should return top tool consumers', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations, { topN: 5 });

      expect(result.topConsumers).toBeDefined();
      expect(Array.isArray(result.topConsumers)).toBe(true);
      expect(result.topConsumers.length).toBeGreaterThan(0);
      expect(result.topConsumers.length).toBeLessThanOrEqual(5);
    });

    it('should calculate total tokens per tool', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      const readTool = result.topConsumers.find((t) => t.toolName === 'Read');
      expect(readTool).toBeDefined();
      expect(readTool!.totalTokens).toBe(1100); // 500 + 600
    });

    it('should calculate tool call count', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      const readTool = result.topConsumers.find((t) => t.toolName === 'Read');
      expect(readTool!.count).toBe(2);

      const ambianceTool = result.topConsumers.find((t) =>
        t.toolName.includes('ambiance')
      );
      expect(ambianceTool!.count).toBe(2); // 800 + 750
    });

    it('should calculate average tokens per tool call', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      const readTool = result.topConsumers.find((t) => t.toolName === 'Read');
      expect(readTool!.averageTokens).toBe(550); // (500 + 600) / 2
    });

    it('should calculate percentage of total tokens', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      const totalTokens = operations.reduce((sum, op) => sum + op.tokens, 0);

      for (const tool of result.topConsumers) {
        const expectedPercent = (tool.totalTokens / totalTokens) * 100;
        expect(tool.percentOfTotal).toBeCloseTo(expectedPercent, 2);
      }
    });

    it('should sort tools by total tokens descending', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      for (let i = 0; i < result.topConsumers.length - 1; i++) {
        expect(result.topConsumers[i].totalTokens).toBeGreaterThanOrEqual(
          result.topConsumers[i + 1].totalTokens
        );
      }
    });

    it('should respect topN parameter', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations, { topN: 3 });

      expect(result.topConsumers.length).toBeLessThanOrEqual(3);
    });

    it('should handle tool with single call', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      const bashTool = result.topConsumers.find((t) => t.toolName === 'Bash');
      expect(bashTool).toBeDefined();
      expect(bashTool!.count).toBe(1);
      expect(bashTool!.averageTokens).toBe(200);
    });
  });

  describe('Server Efficiency Comparisons', () => {
    it('should analyze token usage by MCP server', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      expect(result.byServer).toBeDefined();
      expect(Array.isArray(result.byServer)).toBe(true);
      expect(result.byServer.length).toBeGreaterThan(0);
    });

    it('should group MCP tools by server name', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      const ambianceServer = result.byServer.find(
        (s) => s.serverName === 'ambiance'
      );
      expect(ambianceServer).toBeDefined();
      expect(ambianceServer!.count).toBe(2); // Two ambiance tool calls
    });

    it('should group non-MCP tools as core', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      const coreServer = result.byServer.find((s) => s.serverName === 'core');
      expect(coreServer).toBeDefined();
      // Read (2), Write (1), Grep (1), Bash (1) = 5 calls
      expect(coreServer!.count).toBe(5);
    });

    it('should calculate total tokens per server', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      const ambianceServer = result.byServer.find(
        (s) => s.serverName === 'ambiance'
      );
      expect(ambianceServer!.totalTokens).toBe(1550); // 800 + 750
    });

    it('should calculate average tokens per server operation', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      const ambianceServer = result.byServer.find(
        (s) => s.serverName === 'ambiance'
      );
      expect(ambianceServer!.averageTokens).toBe(775); // 1550 / 2
    });

    it('should calculate server percentage of total tokens', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      const totalTokens = operations.reduce((sum, op) => sum + op.tokens, 0);

      for (const server of result.byServer) {
        const expectedPercent = (server.totalTokens / totalTokens) * 100;
        expect(server.percentOfTotal).toBeCloseTo(expectedPercent, 2);
      }
    });

    it('should track unique tools per server', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      const ambianceServer = result.byServer.find(
        (s) => s.serverName === 'ambiance'
      );
      expect(ambianceServer!.tools.length).toBe(1); // Only local_context

      const coreServer = result.byServer.find((s) => s.serverName === 'core');
      expect(coreServer!.tools.length).toBe(4); // Read, Write, Grep, Bash
    });

    it('should sort servers by total tokens descending', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      for (let i = 0; i < result.byServer.length - 1; i++) {
        expect(result.byServer[i].totalTokens).toBeGreaterThanOrEqual(
          result.byServer[i + 1].totalTokens
        );
      }
    });

    it('should handle multiple MCP servers', () => {
      const operations: TurnData[] = [
        {
          timestamp: '2025-10-29 10:00:00',
          toolName: 'mcp__ambiance__local_context',
          tokens: 500,
          metadata: 'test',
        },
        {
          timestamp: '2025-10-29 10:00:00',
          toolName: 'mcp__sequential-thinking__analyze',
          tokens: 800,
          metadata: 'test',
        },
        {
          timestamp: '2025-10-29 10:00:00',
          toolName: 'mcp__memory__store',
          tokens: 300,
          metadata: 'test',
        },
      ];

      const result = analyzeTokenUsage(operations);

      const serverNames = result.byServer.map((s) => s.serverName);
      expect(serverNames).toContain('ambiance');
      expect(serverNames).toContain('sequential-thinking');
      expect(serverNames).toContain('memory');
    });
  });

  describe('Integration Tests', () => {
    it('should provide comprehensive analytics in one call', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      // Verify all analytics are present
      expect(result.summary).toBeDefined();
      expect(result.topConsumers).toBeDefined();
      expect(result.byServer).toBeDefined();
      expect(result.hourlyTrend).toBeDefined();
      expect(result.anomalies).toBeDefined();
      expect(result.recommendations).toBeDefined();
      expect(result.efficiency).toBeDefined();
    });

    it('should handle empty operations array', () => {
      const operations: TurnData[] = [];

      expect(() => analyzeTokenUsage(operations)).not.toThrow();
    });

    it('should handle operations with zero tokens', () => {
      const operations: TurnData[] = [
        {
          timestamp: '2025-10-29 10:00:00',
          toolName: 'Read',
          tokens: 0,
          metadata: 'test',
        },
      ];

      const result = analyzeTokenUsage(operations);
      expect(result.summary.totalTokens).toBe(0);
    });

    it('should handle malformed MCP tool names gracefully', () => {
      const operations: TurnData[] = [
        {
          timestamp: '2025-10-29 10:00:00',
          toolName: 'mcp__',
          tokens: 500,
          metadata: 'test',
        },
        {
          timestamp: '2025-10-29 10:00:00',
          toolName: 'mcp__unknown',
          tokens: 300,
          metadata: 'test',
        },
      ];

      const result = analyzeTokenUsage(operations);
      expect(result.byServer).toBeDefined();
      expect(result.byServer.length).toBeGreaterThan(0);
    });

    it('should apply anomaly threshold correctly', () => {
      const operations: TurnData[] = [
        {
          timestamp: '2025-10-29 10:00:00',
          toolName: 'Read',
          tokens: 100,
          metadata: 'test',
        },
        {
          timestamp: '2025-10-29 10:15:00',
          toolName: 'Read',
          tokens: 100,
          metadata: 'test',
        },
        {
          timestamp: '2025-10-29 10:30:00',
          toolName: 'Read',
          tokens: 100,
          metadata: 'test',
        },
        {
          timestamp: '2025-10-29 10:45:00',
          toolName: 'Read',
          tokens: 5000, // Anomaly: this turn has 5000 tokens vs avg ~100
          metadata: 'test',
        },
      ];

      const result = analyzeTokenUsage(operations, { anomalyThreshold: 3 });
      // The anomaly detection groups by turn timestamp, so turn at 10:45 should be detected
      expect(result.anomalies.length).toBeGreaterThan(0);
    });

    it('should generate recommendations based on patterns', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      expect(result.recommendations).toBeDefined();
      expect(Array.isArray(result.recommendations)).toBe(true);
    });

    it('should calculate efficiency metrics', () => {
      const operations = createSampleOperations();
      const result = analyzeTokenUsage(operations);

      expect(result.efficiency.tokensPerTool).toBeGreaterThan(0);
      expect(result.efficiency.thinkingModePercent).toBeGreaterThanOrEqual(0);
      expect(result.efficiency.thinkingModePercent).toBeLessThanOrEqual(100);
      expect(result.efficiency.cacheHitPotential).toBeDefined();
    });
  });

  describe('Edge Cases', () => {
    it('should handle operations all in same minute', () => {
      const operations: TurnData[] = [
        {
          timestamp: '2025-10-29 10:15:23',
          toolName: 'Read',
          tokens: 500,
          metadata: 'test',
        },
        {
          timestamp: '2025-10-29 10:15:45',
          toolName: 'Write',
          tokens: 300,
          metadata: 'test',
        },
      ];

      const result = analyzeTokenUsage(operations);
      expect(result.hourlyTrend.length).toBe(1);
      expect(result.hourlyTrend[0].hour).toBe('10:00');
    });

    it('should handle large token values', () => {
      const operations: TurnData[] = [
        {
          timestamp: '2025-10-29 10:00:00',
          toolName: 'Read',
          tokens: 1000000,
          metadata: 'test',
        },
      ];

      const result = analyzeTokenUsage(operations);
      expect(result.summary.totalTokens).toBe(1000000);
    });

    it('should handle special characters in tool names', () => {
      const operations: TurnData[] = [
        {
          timestamp: '2025-10-29 10:00:00',
          toolName: 'Tool-With-Dashes_And_Underscores',
          tokens: 500,
          metadata: 'test',
        },
      ];

      const result = analyzeTokenUsage(operations);
      expect(result.topConsumers.length).toBeGreaterThan(0);
    });

    it('should handle metadata with various formats', () => {
      const operations: TurnData[] = [
        {
          timestamp: '2025-10-29 10:00:00',
          toolName: 'Read',
          tokens: 500,
          metadata: '',
        },
        {
          timestamp: '2025-10-29 10:00:00',
          toolName: 'Write',
          tokens: 300,
          metadata: '/very/long/path/to/file.ts',
        },
      ];

      const result = analyzeTokenUsage(operations);
      expect(result.summary.totalOperations).toBe(2);
    });
  });
});
