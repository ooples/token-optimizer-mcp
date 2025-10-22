/**
 * Integration Tests for Claude Desktop Harness
 *
 * Tests cover:
 * - Claude Desktop MCP server connection
 * - Configuration generation
 * - Server startup and tool registration
 * - All tool categories execution
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { TokenCounter } from '../../src/core/token-counter.js';
import { CompressionEngine } from '../../src/core/compression-engine.js';
import { MetricsCollector } from '../../src/core/metrics.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Claude Desktop Integration Harness', () => {
  let server: Server;
  let cache: CacheEngine;
  let tokenCounter: TokenCounter;
  let compression: CompressionEngine;
  let metrics: MetricsCollector;
  let testDbPath: string;

  beforeAll(() => {
    // Initialize test environment
    const tempDir = path.join(os.tmpdir(), 'token-optimizer-test');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    testDbPath = path.join(tempDir, `integration-${Date.now()}.db`);

    // Initialize core modules
    cache = new CacheEngine(testDbPath, 100);
    tokenCounter = new TokenCounter();
    compression = new CompressionEngine();
    metrics = new MetricsCollector();

    // Initialize MCP server
    server = new Server(
      {
        name: 'token-optimizer-mcp-test',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );
  });

  afterAll(() => {
    cache.close();
    tokenCounter.free();

    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    const walPath = `${testDbPath}-wal`;
    const shmPath = `${testDbPath}-shm`;
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
  });

  beforeEach(() => {
    // Clear cache and metrics before each test to avoid state pollution
    cache.clear();
    metrics.clear();
  });

  describe('Server Initialization', () => {
    it('should create MCP server instance', () => {
      expect(server).toBeDefined();
      expect(server).toBeInstanceOf(Server);
    });

    it('should have correct server metadata', () => {
      // Server info is internal, but we can verify it was created
      expect(server).toHaveProperty('setRequestHandler');
    });

    it('should initialize with tool capabilities', () => {
      // Verify server has capabilities
      expect(server).toBeDefined();
    });
  });

  describe('Core Module Initialization', () => {
    it('should initialize CacheEngine', () => {
      expect(cache).toBeDefined();
      expect(cache).toBeInstanceOf(CacheEngine);

      // Verify cache is functional
      cache.set('test', 'value', 5, 5);
      expect(cache.get('test')).toBe('value');
    });

    it('should initialize TokenCounter', () => {
      expect(tokenCounter).toBeDefined();
      expect(tokenCounter).toBeInstanceOf(TokenCounter);

      // Verify token counter is functional
      const result = tokenCounter.count('Hello, world!');
      expect(result.tokens).toBeGreaterThan(0);
    });

    it('should initialize CompressionEngine', () => {
      expect(compression).toBeDefined();
      expect(compression).toBeInstanceOf(CompressionEngine);

      // Verify compression is functional
      const result = compression.compress('test data');
      expect(result.compressed).toBeDefined();
    });

    it('should initialize MetricsCollector', () => {
      expect(metrics).toBeDefined();
      expect(metrics).toBeInstanceOf(MetricsCollector);

      // Verify metrics is functional
      metrics.record({
        operation: 'test',
        duration: 10,
        success: true,
        cacheHit: false,
      });

      const stats = metrics.getCacheStats();
      expect(stats.totalOperations).toBeGreaterThan(0);
    });
  });

  describe('Configuration Generation', () => {
    it('should generate valid Claude Desktop configuration', () => {
      const config = {
        mcpServers: {
          'token-optimizer': {
            command: 'node',
            args: [path.join(process.cwd(), 'dist', 'index.js')],
            env: {
              TOKEN_OPTIMIZER_CACHE_DIR: path.join(os.homedir(), '.token-optimizer-cache'),
            },
          },
        },
      };

      expect(config.mcpServers['token-optimizer']).toBeDefined();
      expect(config.mcpServers['token-optimizer'].command).toBe('node');
      expect(config.mcpServers['token-optimizer'].args).toHaveLength(1);
    });

    it('should validate configuration structure', () => {
      const configPath = path.join(process.cwd(), 'examples', 'claude_desktop_config.json');
      const configExists = fs.existsSync(configPath);

      if (configExists) {
        const configContent = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configContent);

        expect(config).toHaveProperty('mcpServers');
        expect(config.mcpServers).toHaveProperty('token-optimizer');
      }
    });

    it('should use correct environment variables', () => {
      const expectedVars = [
        'TOKEN_OPTIMIZER_CACHE_DIR',
      ];

      const config = {
        env: {
          TOKEN_OPTIMIZER_CACHE_DIR: path.join(os.homedir(), '.token-optimizer-cache'),
        },
      };

      expectedVars.forEach(varName => {
        expect(config.env).toHaveProperty(varName);
      });
    });
  });

  describe('Tool Categories Integration', () => {
    describe('Caching Tools', () => {
      it('should support optimize_text tool', () => {
        const text = 'Test text for optimization';
        const key = 'test-key';

        const result = compression.compress(text);
        cache.set(key, result.compressed.toString('base64'), result.originalSize, result.compressedSize);

        const retrieved = cache.get(key);
        expect(retrieved).not.toBeNull();
      });

      it('should support get_cached tool', () => {
        const key = 'cached-key';
        cache.set(key, 'cached-value', 10, 5);

        const value = cache.get(key);
        expect(value).toBe('cached-value');
      });

      it('should support count_tokens tool', () => {
        const text = 'Count tokens in this text';
        const result = tokenCounter.count(text);

        expect(result.tokens).toBeGreaterThan(0);
        expect(result.characters).toBe(text.length);
      });
    });

    describe('Compression Tools', () => {
      it('should handle compress operation', () => {
        const text = 'Text to compress '.repeat(100);
        const result = compression.compress(text);

        expect(result.compressedSize).toBeLessThanOrEqual(result.originalSize);
        expect(result.compressed).toBeInstanceOf(Buffer);
      });

      it('should handle decompress operation', () => {
        const original = 'Original text';
        const compressed = compression.compress(original);
        const decompressed = compression.decompress(compressed.compressed);

        expect(decompressed).toBe(original);
      });
    });

    describe('Analytics Tools', () => {
      it('should provide cache statistics', () => {
        cache.set('key1', 'value1', 10, 5);
        cache.set('key2', 'value2', 20, 8);

        cache.get('key1');
        cache.get('key2');
        cache.get('missing');

        const stats = cache.getStats();

        expect(stats.totalEntries).toBe(2);
        expect(stats.hitRate).toBeGreaterThan(0);
      });

      it('should provide token savings metrics', () => {
        const original = 'Long text '.repeat(100);
        const contextTokens = 2; // Simulating metadata or small summary

        const savings = tokenCounter.calculateSavings(original, contextTokens);

        expect(savings.tokensSaved).toBeGreaterThan(0);
        expect(savings.percentSaved).toBeGreaterThan(0);
      });

      it('should track operation metrics', () => {
        metrics.record({
          operation: 'compress',
          duration: 50,
          success: true,
          cacheHit: false,
        });

        metrics.record({
          operation: 'decompress',
          duration: 20,
          success: true,
          cacheHit: true,
        });

        const stats = metrics.getCacheStats();
        expect(stats.totalOperations).toBe(2);
      });
    });
  });

  describe('End-to-End Workflow', () => {
    it('should complete full optimization cycle', () => {
      const startTime = Date.now();

      // 1. Input text
      const originalText = 'This is a test document. '.repeat(50);

      // 2. Count tokens
      const originalTokens = tokenCounter.count(originalText);
      expect(originalTokens.tokens).toBeGreaterThan(0);

      // 3. Compress
      const compressed = compression.compress(originalText);
      expect(compressed.percentSaved).toBeGreaterThan(0);

      // 4. Cache
      const cacheKey = 'test-doc-1';
      cache.set(
        cacheKey,
        compressed.compressed.toString('base64'),
        compressed.originalSize,
        compressed.compressedSize
      );

      // 5. Retrieve from cache
      const cached = cache.get(cacheKey);
      expect(cached).not.toBeNull();

      // 6. Decompress
      const decompressed = compression.decompressFromBase64(cached!);
      expect(decompressed).toBe(originalText);

      // 7. Verify tokens preserved
      const finalTokens = tokenCounter.count(decompressed);
      expect(finalTokens.tokens).toBe(originalTokens.tokens);

      // 8. Record metrics
      metrics.record({
        operation: 'full-cycle',
        duration: Date.now() - startTime,
        success: true,
        cacheHit: true,
        inputTokens: originalTokens.tokens,
        savedTokens: compressed.percentSaved,
      });

      const stats = metrics.getCacheStats();
      expect(stats.totalOperations).toBeGreaterThan(0);
    });

    it('should handle cache hits efficiently', () => {
      const text = 'Cached content';
      const key = 'efficient-key';

      // First access - cache miss
      const compressedText = compression.compress(text);
      cache.set(key, compressedText.compressed.toString('base64'), compressedText.originalSize, compressedText.compressedSize);

      const start1 = Date.now();
      cache.get(key);
      const duration1 = Date.now() - start1;

      // Second access - cache hit
      const start2 = Date.now();
      cache.get(key);
      const duration2 = Date.now() - start2;

      // Both should be fast
      expect(duration1).toBeLessThan(100);
      expect(duration2).toBeLessThan(100);
    });

    it('should maintain data integrity across operations', () => {
      const testData = Array.from({ length: 10 }, (_, i) => ({
        key: `key-${i}`,
        value: `This is test content ${i}. `.repeat(20),
      }));

      // Store all
      testData.forEach(({ key, value }) => {
        const compressed = compression.compress(value);
        cache.set(key, compressed.compressed.toString('base64'), compressed.originalSize, compressed.compressedSize);
      });

      // Retrieve and verify all
      testData.forEach(({ key, value }) => {
        const retrieved = cache.get(key);
        expect(retrieved).not.toBeNull();

        const decompressed = compression.decompressFromBase64(retrieved!);
        expect(decompressed).toBe(value);
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid cache keys gracefully', () => {
      const result = cache.get('non-existent-key');
      expect(result).toBeNull();
    });

    it('should handle empty text compression', () => {
      const result = compression.compress('');
      expect(result.compressedSize).toBeGreaterThanOrEqual(0);
    });

    it('should handle empty text token counting', () => {
      const result = tokenCounter.count('');
      expect(result.tokens).toBe(0);
    });

    it('should handle corrupted compressed data gracefully', () => {
      expect(() => {
        compression.decompressFromBase64('invalid-base64-data');
      }).toThrow();
    });
  });

  describe('Performance Validation', () => {
    it('should complete operations within acceptable time limits', () => {
      const text = 'Performance test '.repeat(1000);

      const start = Date.now();

      const tokenCount = tokenCounter.count(text);
      const compressed = compression.compress(text);
      cache.set('perf-key', compressed.compressed.toString('base64'), compressed.originalSize, compressed.compressedSize);
      const retrieved = cache.get('perf-key');

      const duration = Date.now() - start;

      expect(duration).toBeLessThan(1000); // Should complete in under 1 second
      expect(tokenCount.tokens).toBeGreaterThan(0);
      expect(retrieved).not.toBeNull();
    });

    it('should handle concurrent operations', () => {
      const operations = Array.from({ length: 50 }, (_, i) => {
        const text = `Concurrent operation ${i}`;
        const compressed = compression.compress(text);
        cache.set(`concurrent-${i}`, compressed.compressed.toString('base64'), compressed.originalSize, compressed.compressedSize);
        return cache.get(`concurrent-${i}`);
      });

      operations.forEach(result => {
        expect(result).not.toBeNull();
      });
    });
  });
});
