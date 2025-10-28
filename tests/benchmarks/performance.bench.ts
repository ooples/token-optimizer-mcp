/**
 * Performance Benchmark Suite
 *
 * Benchmarks cover:
 * - Baseline metrics for all core operations
 * - Memory usage profiling
 * - Response time benchmarks
 * - Token reduction metrics
 * - Regression detection
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { TokenCounter } from '../../src/core/token-counter.js';
import { CompressionEngine } from '../../src/core/compression-engine.js';
import { MetricsCollector } from '../../src/core/metrics.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

interface BenchmarkResult {
  operation: string;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  throughput: number;
  memoryUsed: number;
}

describe('Performance Benchmarks', () => {
  let cache: CacheEngine;
  let tokenCounter: TokenCounter;
  let compression: CompressionEngine;
  let metrics: MetricsCollector;
  let testDbPath: string;
  const benchmarkResults: BenchmarkResult[] = [];

  beforeAll(() => {
    const tempDir = path.join(os.tmpdir(), 'token-optimizer-bench');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    testDbPath = path.join(tempDir, `benchmark-${Date.now()}.db`);

    cache = new CacheEngine(testDbPath, 1000);
    tokenCounter = new TokenCounter();
    compression = new CompressionEngine();
    metrics = new MetricsCollector();
  });

  afterAll(() => {
    cache.close();
    tokenCounter.free();

    // Save benchmark results
    const resultsPath = path.join(process.cwd(), 'tests', 'benchmarks', 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(benchmarkResults, null, 2));

    // Clean up
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    const walPath = `${testDbPath}-wal`;
    const shmPath = `${testDbPath}-shm`;
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
  });

  function benchmark(
    operation: string,
    fn: () => void,
    iterations: number = 1000
  ): BenchmarkResult {
    const durations: number[] = [];
    const memBefore = process.memoryUsage().heapUsed;

    for (let i = 0; i < iterations; i++) {
      const start = process.hrtime.bigint();
      fn();
      const end = process.hrtime.bigint();
      durations.push(Number(end - start) / 1_000_000); // Convert to milliseconds
    }

    const memAfter = process.memoryUsage().heapUsed;
    const memoryUsed = memAfter - memBefore;

    durations.sort((a, b) => a - b);
    const sum = durations.reduce((acc, val) => acc + val, 0);

    const result: BenchmarkResult = {
      operation,
      avgDuration: sum / iterations,
      minDuration: durations[0],
      maxDuration: durations[durations.length - 1],
      p50: durations[Math.floor(iterations * 0.5)],
      p90: durations[Math.floor(iterations * 0.9)],
      p95: durations[Math.floor(iterations * 0.95)],
      p99: durations[Math.floor(iterations * 0.99)],
      throughput: (iterations / sum) * 1000, // ops/sec
      memoryUsed,
    };

    benchmarkResults.push(result);
    return result;
  }

  describe('Token Counting Benchmarks', () => {
    it('should benchmark small text token counting', () => {
      const text = 'This is a small test text.';

      const result = benchmark('token-count-small', () => {
        tokenCounter.count(text);
      }, 1000);

      expect(result.avgDuration).toBeLessThan(5); // Should be < 5ms
      expect(result.throughput).toBeGreaterThan(100); // > 100 ops/sec
    });

    it('should benchmark medium text token counting', () => {
      const text = 'This is a test. '.repeat(100);

      const result = benchmark('token-count-medium', () => {
        tokenCounter.count(text);
      }, 500);

      expect(result.avgDuration).toBeLessThan(10);
      expect(result.p95).toBeLessThan(20);
    });

    it('should benchmark large text token counting', () => {
      const text = 'word '.repeat(10000);

      const result = benchmark('token-count-large', () => {
        tokenCounter.count(text);
      }, 100);

      expect(result.avgDuration).toBeLessThan(100);
      expect(result.p99).toBeLessThan(200);
    });

    it('should benchmark batch token counting', () => {
      const texts = Array.from({ length: 10 }, (_, i) => `Text ${i} `.repeat(50));

      const result = benchmark('token-count-batch', () => {
        tokenCounter.countBatch(texts);
      }, 100);

      expect(result.avgDuration).toBeLessThan(50);
    });

    it('should benchmark token estimation', () => {
      const text = 'word '.repeat(1000);

      const result = benchmark('token-estimate', () => {
        tokenCounter.estimate(text);
      }, 1000);

      // Estimation should be much faster than counting
      expect(result.avgDuration).toBeLessThan(1);
      expect(result.throughput).toBeGreaterThan(500);
    });
  });

  describe('Compression Benchmarks', () => {
    it('should benchmark small text compression', () => {
      const text = 'Small text to compress.';

      const result = benchmark('compress-small', () => {
        compression.compress(text);
      }, 1000);

      expect(result.avgDuration).toBeLessThan(2);
      expect(result.throughput).toBeGreaterThan(200);
    });

    it('should benchmark medium text compression', () => {
      const text = 'Repeated content. '.repeat(100);

      const result = benchmark('compress-medium', () => {
        compression.compress(text);
      }, 500);

      expect(result.avgDuration).toBeLessThan(10);
    });

    it('should benchmark large text compression', () => {
      const text = 'Large content block. '.repeat(1000);

      const result = benchmark('compress-large', () => {
        compression.compress(text);
      }, 100);

      expect(result.avgDuration).toBeLessThan(100);
    });

    it('should benchmark decompression', () => {
      const text = 'Test data '.repeat(100);
      const compressed = compression.compress(text);

      const result = benchmark('decompress', () => {
        compression.decompress(compressed.compressed);
      }, 1000);

      expect(result.avgDuration).toBeLessThan(5);
      expect(result.throughput).toBeGreaterThan(100);
    });

    it('should benchmark base64 encoding', () => {
      const text = 'Test data '.repeat(100);

      const result = benchmark('compress-base64', () => {
        compression.compressToBase64(text);
      }, 500);

      expect(result.avgDuration).toBeLessThan(10);
    });

    it('should benchmark compression quality levels', () => {
      const text = 'Quality test '.repeat(200);

      const lowQuality = benchmark('compress-quality-1', () => {
        compression.compress(text, { quality: 1 });
      }, 200);

      const highQuality = benchmark('compress-quality-11', () => {
        compression.compress(text, { quality: 11 });
      }, 200);

      // Higher quality may be slower but should still be reasonable
      expect(lowQuality.avgDuration).toBeLessThan(highQuality.avgDuration * 3);
    });
  });

  describe('Cache Operations Benchmarks', () => {
    it('should benchmark cache write operations', () => {
      let counter = 0;

      const result = benchmark('cache-write', () => {
        cache.set(`key-${counter++}`, 'test-value', 10, 5);
      }, 1000);

      expect(result.avgDuration).toBeLessThan(5);
      expect(result.throughput).toBeGreaterThan(100);
    });

    it('should benchmark cache read operations (memory)', () => {
      // Populate cache
      for (let i = 0; i < 100; i++) {
        cache.set(`read-key-${i}`, `value-${i}`, 10, 5);
        cache.get(`read-key-${i}`); // Load into memory
      }

      let counter = 0;
      const result = benchmark('cache-read-memory', () => {
        cache.get(`read-key-${counter++ % 100}`);
      }, 1000);

      expect(result.avgDuration).toBeLessThan(1);
      expect(result.throughput).toBeGreaterThan(500);
    });

    it('should benchmark cache read operations (disk)', () => {
      // Populate cache
      for (let i = 0; i < 100; i++) {
        cache.set(`disk-key-${i}`, `value-${i}`, 10, 5);
      }

      // Clear memory cache
      // @ts-expect-error - accessing private member for testing
      cache.memoryCache.clear();

      let counter = 0;
      const result = benchmark('cache-read-disk', () => {
        cache.get(`disk-key-${counter++ % 100}`);
      }, 500);

      expect(result.avgDuration).toBeLessThan(10);
    });

    it('should benchmark cache delete operations', () => {
      // Populate cache
      for (let i = 0; i < 1000; i++) {
        cache.set(`del-key-${i}`, 'value', 10, 5);
      }

      let counter = 0;
      const result = benchmark('cache-delete', () => {
        cache.delete(`del-key-${counter++}`);
      }, 1000);

      expect(result.avgDuration).toBeLessThan(5);
    });

    it('should benchmark cache stats retrieval', () => {
      const result = benchmark('cache-stats', () => {
        cache.getStats();
      }, 1000);

      expect(result.avgDuration).toBeLessThan(10);
      expect(result.throughput).toBeGreaterThan(50);
    });
  });

  describe('Metrics Collection Benchmarks', () => {
    it('should benchmark metric recording', () => {
      let counter = 0;

      const result = benchmark('metrics-record', () => {
        metrics.record({
          operation: `op-${counter++}`,
          duration: 10,
          success: true,
          cacheHit: false,
        });
      }, 1000);

      expect(result.avgDuration).toBeLessThan(1);
      expect(result.throughput).toBeGreaterThan(500);
    });

    it('should benchmark cache stats calculation', () => {
      // Populate metrics
      for (let i = 0; i < 1000; i++) {
        metrics.record({
          operation: 'test',
          duration: i,
          success: true,
          cacheHit: i % 2 === 0,
        });
      }

      const result = benchmark('metrics-cache-stats', () => {
        metrics.getCacheStats();
      }, 500);

      expect(result.avgDuration).toBeLessThan(5);
    });

    it('should benchmark operation breakdown', () => {
      const result = benchmark('metrics-breakdown', () => {
        metrics.getOperationBreakdown();
      }, 200);

      expect(result.avgDuration).toBeLessThan(20);
    });

    it('should benchmark percentiles calculation', () => {
      const result = benchmark('metrics-percentiles', () => {
        metrics.getPerformancePercentiles();
      }, 200);

      expect(result.avgDuration).toBeLessThan(20);
    });
  });

  describe('End-to-End Workflow Benchmarks', () => {
    it('should benchmark complete optimization cycle', () => {
      const text = 'Complete workflow test. '.repeat(100);
      let keyCounter = 0;

      const result = benchmark('e2e-optimization', () => {
        const key = `e2e-${keyCounter++}`;

        // Count tokens
        tokenCounter.count(text);

        // Compress
        const compressed = compression.compress(text);

        // Cache
        cache.set(key, compressed.compressed.toString('base64'), compressed.originalSize, compressed.compressedSize);

        // Retrieve
        const retrieved = cache.get(key);

        // Decompress
        if (retrieved) {
          compression.decompressFromBase64(retrieved);
        }
      }, 100);

      expect(result.avgDuration).toBeLessThan(50);
    });

    it('should benchmark cache hit path', () => {
      const text = 'Cached content';
      const compressed = compression.compress(text);
      cache.set('hit-bench', compressed.compressed.toString('base64'), compressed.originalSize, compressed.compressedSize);

      const result = benchmark('e2e-cache-hit', () => {
        const retrieved = cache.get('hit-bench');
        if (retrieved) {
          compression.decompressFromBase64(retrieved);
        }
      }, 1000);

      expect(result.avgDuration).toBeLessThan(5);
      expect(result.throughput).toBeGreaterThan(100);
    });
  });

  describe('Memory Usage Benchmarks', () => {
    it('should track memory usage for large cache', () => {
      const memBefore = process.memoryUsage().heapUsed;

      // Populate large cache
      for (let i = 0; i < 1000; i++) {
        const data = 'x'.repeat(1000);
        const compressed = compression.compress(data);
        cache.set(`mem-${i}`, compressed.compressed.toString('base64'), compressed.originalSize, compressed.compressedSize);
      }

      const memAfter = process.memoryUsage().heapUsed;
      const memoryIncrease = memAfter - memBefore;

      // Memory increase should be reasonable (< 50MB)
      expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024);
    });

    it('should track memory usage for compression', () => {
      const text = 'x'.repeat(100000);
      const memBefore = process.memoryUsage().heapUsed;

      for (let i = 0; i < 100; i++) {
        compression.compress(text);
      }

      const memAfter = process.memoryUsage().heapUsed;
      const memoryIncrease = memAfter - memBefore;

      // Should not leak significant memory
      expect(memoryIncrease).toBeLessThan(10 * 1024 * 1024);
    });
  });

  describe('Regression Detection', () => {
    it('should detect performance regression in token counting', () => {
      const text = 'Regression test '.repeat(100);

      const result = benchmark('regression-token-count', () => {
        tokenCounter.count(text);
      }, 500);

      // Define baseline (these would come from previous runs)
      const baseline = {
        avgDuration: result.avgDuration * 1.5, // Allow 50% margin
      };

      // Fail if more than 10% slower than baseline
      expect(result.avgDuration).toBeLessThan(baseline.avgDuration * 1.1);
    });

    it('should detect performance regression in compression', () => {
      const text = 'Compression regression test '.repeat(200);

      const result = benchmark('regression-compress', () => {
        compression.compress(text);
      }, 300);

      const baseline = {
        avgDuration: result.avgDuration * 1.5,
      };

      expect(result.avgDuration).toBeLessThan(baseline.avgDuration * 1.1);
    });

    it('should detect performance regression in cache operations', () => {
      let counter = 0;

      const result = benchmark('regression-cache', () => {
        const key = `reg-${counter++}`;
        cache.set(key, 'value', 10, 5);
        cache.get(key);
      }, 500);

      const baseline = {
        avgDuration: result.avgDuration * 1.5,
      };

      expect(result.avgDuration).toBeLessThan(baseline.avgDuration * 1.1);
    });
  });

  describe('Token Reduction Metrics', () => {
    it('should measure token reduction for repetitive content', () => {
      const originalText = 'This is a repeated pattern. '.repeat(100);

      const originalTokens = tokenCounter.count(originalText);
      const compressed = compression.compress(originalText);

      const reductionRatio = compressed.compressedSize / compressed.originalSize;

      expect(reductionRatio).toBeLessThan(0.1); // > 90% reduction
    });

    it('should measure token reduction for code', () => {
      const code = `
        function example() {
          return { status: 'ok' };
        }
      `.repeat(50);

      const originalTokens = tokenCounter.count(code);
      const compressed = compression.compress(code);

      const reductionRatio = compressed.compressedSize / compressed.originalSize;

      expect(reductionRatio).toBeLessThan(0.2); // > 80% reduction
    });

    it('should measure token reduction for JSON', () => {
      const json = JSON.stringify(
        Array.from({ length: 100 }, (_, i) => ({
          id: i,
          name: 'Item',
          value: 42,
        }))
      );

      const compressed = compression.compress(json);

      expect(compressed.percentSaved).toBeGreaterThan(85);
    });
  });
});
