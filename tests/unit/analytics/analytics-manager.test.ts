/**
 * Unit tests for Analytics Manager
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { AnalyticsManager } from '../../../src/analytics/analytics-manager.js';
import { SqliteAnalyticsStorage } from '../../../src/analytics/analytics-storage.js';
import type { AnalyticsEntry } from '../../../src/analytics/analytics-types.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('AnalyticsManager', () => {
  let manager: AnalyticsManager;
  let testDbPath: string;

  beforeEach(() => {
    // Use a temporary database for testing
    testDbPath = path.join(os.tmpdir(), `test-analytics-${Date.now()}.db`);
    const storage = new SqliteAnalyticsStorage(testDbPath);
    manager = new AnalyticsManager(storage);
  });

  afterEach(async () => {
    // Clean up test database
    await manager.clear();
    
    // Close the database connection
    if (manager && (manager as any).storage && (manager as any).storage.close) {
      (manager as any).storage.close();
    }
    
    // Wait a bit for the file handle to be released
    await new Promise(resolve => setTimeout(resolve, 100));
    
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch (e) {
        // File might still be locked, that's okay
      }
    }
  });

  describe('track', () => {
    it('should track a single analytics entry', async () => {
      await manager.track({
        hookPhase: 'PreToolUse',
        toolName: 'smart_read',
        mcpServer: 'token-optimizer',
        originalTokens: 1000,
        optimizedTokens: 800,
        tokensSaved: 200,
      });

      const count = await manager.count();
      expect(count).toBe(1);
    });

    it('should track multiple entries', async () => {
      const entries = [
        {
          hookPhase: 'PreToolUse' as const,
          toolName: 'smart_read',
          mcpServer: 'token-optimizer',
          originalTokens: 1000,
          optimizedTokens: 800,
          tokensSaved: 200,
        },
        {
          hookPhase: 'PostToolUse' as const,
          toolName: 'smart_write',
          mcpServer: 'filesystem',
          originalTokens: 500,
          optimizedTokens: 400,
          tokensSaved: 100,
        },
      ];

      for (const entry of entries) {
        await manager.track(entry);
      }

      const count = await manager.count();
      expect(count).toBe(2);
    });
  });

  describe('getHookAnalytics', () => {
    it('should aggregate analytics by hook phase', async () => {
      await manager.trackBatch([
        {
          hookPhase: 'PreToolUse',
          toolName: 'smart_read',
          mcpServer: 'token-optimizer',
          originalTokens: 1000,
          optimizedTokens: 800,
          tokensSaved: 200,
        },
        {
          hookPhase: 'PreToolUse',
          toolName: 'smart_write',
          mcpServer: 'token-optimizer',
          originalTokens: 500,
          optimizedTokens: 400,
          tokensSaved: 100,
        },
        {
          hookPhase: 'PostToolUse',
          toolName: 'smart_grep',
          mcpServer: 'filesystem',
          originalTokens: 300,
          optimizedTokens: 250,
          tokensSaved: 50,
        },
      ]);

      const analytics = await manager.getHookAnalytics();

      expect(analytics.summary.totalOperations).toBe(3);
      expect(analytics.summary.totalTokensSaved).toBe(350);
      expect(analytics.byHook).toHaveLength(2);

      const preToolUse = analytics.byHook.find((h) => h.name === 'PreToolUse');
      expect(preToolUse).toBeDefined();
      expect(preToolUse?.totalOperations).toBe(2);
      expect(preToolUse?.totalTokensSaved).toBe(300);
    });
  });

  describe('getActionAnalytics', () => {
    it('should aggregate analytics by tool/action', async () => {
      await manager.trackBatch([
        {
          hookPhase: 'PreToolUse',
          toolName: 'smart_read',
          mcpServer: 'token-optimizer',
          originalTokens: 1000,
          optimizedTokens: 800,
          tokensSaved: 200,
        },
        {
          hookPhase: 'PostToolUse',
          toolName: 'smart_read',
          mcpServer: 'token-optimizer',
          originalTokens: 500,
          optimizedTokens: 400,
          tokensSaved: 100,
        },
        {
          hookPhase: 'PreToolUse',
          toolName: 'smart_write',
          mcpServer: 'filesystem',
          originalTokens: 300,
          optimizedTokens: 250,
          tokensSaved: 50,
        },
      ]);

      const analytics = await manager.getActionAnalytics();

      expect(analytics.summary.totalOperations).toBe(3);
      expect(analytics.summary.totalTokensSaved).toBe(350);
      expect(analytics.byAction).toHaveLength(2);

      const smartRead = analytics.byAction.find((a) => a.name === 'smart_read');
      expect(smartRead).toBeDefined();
      expect(smartRead?.totalOperations).toBe(2);
      expect(smartRead?.totalTokensSaved).toBe(300);
    });
  });

  describe('getServerAnalytics', () => {
    it('should aggregate analytics by MCP server', async () => {
      await manager.trackBatch([
        {
          hookPhase: 'PreToolUse',
          toolName: 'smart_read',
          mcpServer: 'token-optimizer',
          originalTokens: 1000,
          optimizedTokens: 800,
          tokensSaved: 200,
        },
        {
          hookPhase: 'PostToolUse',
          toolName: 'smart_write',
          mcpServer: 'token-optimizer',
          originalTokens: 500,
          optimizedTokens: 400,
          tokensSaved: 100,
        },
        {
          hookPhase: 'PreToolUse',
          toolName: 'smart_grep',
          mcpServer: 'filesystem',
          originalTokens: 300,
          optimizedTokens: 250,
          tokensSaved: 50,
        },
      ]);

      const analytics = await manager.getServerAnalytics();

      expect(analytics.summary.totalOperations).toBe(3);
      expect(analytics.summary.totalTokensSaved).toBe(350);
      expect(analytics.byServer).toHaveLength(2);

      const tokenOptimizer = analytics.byServer.find(
        (s) => s.name === 'token-optimizer'
      );
      expect(tokenOptimizer).toBeDefined();
      expect(tokenOptimizer?.totalOperations).toBe(2);
      expect(tokenOptimizer?.totalTokensSaved).toBe(300);
    });
  });

  describe('exportAsJson', () => {
    it('should export analytics data as JSON', async () => {
      await manager.track({
        hookPhase: 'PreToolUse',
        toolName: 'smart_read',
        mcpServer: 'token-optimizer',
        originalTokens: 1000,
        optimizedTokens: 800,
        tokensSaved: 200,
      });

      const json = await manager.exportAsJson();
      const data = JSON.parse(json);

      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(1);
      expect(data[0].toolName).toBe('smart_read');
    });
  });

  describe('exportAsCsv', () => {
    it('should export analytics data as CSV', async () => {
      await manager.track({
        hookPhase: 'PreToolUse',
        toolName: 'smart_read',
        mcpServer: 'token-optimizer',
        originalTokens: 1000,
        optimizedTokens: 800,
        tokensSaved: 200,
      });

      const csv = await manager.exportAsCsv();

      expect(csv).toContain('hookPhase,toolName,mcpServer');
      expect(csv).toContain('PreToolUse,smart_read,token-optimizer');
      expect(csv).toContain('1000,800,200');
    });
  });

  describe('clear', () => {
    it('should clear all analytics data', async () => {
      await manager.track({
        hookPhase: 'PreToolUse',
        toolName: 'smart_read',
        mcpServer: 'token-optimizer',
        originalTokens: 1000,
        optimizedTokens: 800,
        tokensSaved: 200,
      });

      let count = await manager.count();
      expect(count).toBe(1);

      await manager.clear();

      count = await manager.count();
      expect(count).toBe(0);
    });
  });
});
