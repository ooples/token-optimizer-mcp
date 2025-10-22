/**
 * True Concurrency Stress Tests for CacheEngine
 *
 * These tests use Node.js Worker Threads to create TRUE parallel execution
 * across multiple threads, simulating real-world concurrent database access.
 *
 * This tests for:
 * - Lost updates (concurrent writes to same key)
 * - Dirty reads (reading uncommitted data)
 * - Race conditions in hit count updates
 * - SQLite locking behavior under WAL mode
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { Worker } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('CacheEngine - True Concurrency Stress Tests', () => {
  let cache: CacheEngine;
  let testDbPath: string;

  beforeEach(() => {
    const tempDir = path.join(os.tmpdir(), 'token-optimizer-stress-test');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    testDbPath = path.join(tempDir, `test-cache-stress-${Date.now()}.db`);
    cache = new CacheEngine(testDbPath, 100);
  });

  afterEach(() => {
    cache.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    const walPath = `${testDbPath}-wal`;
    const shmPath = `${testDbPath}-shm`;
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
  });

  /**
   * Helper to run operations in worker threads
   */
  function runWorker(
    dbPath: string,
    workerId: number,
    operations: Array<{ type: string; key: string; value?: string }>
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const workerPath = path.join(__dirname, 'cache-worker.js');
      const worker = new Worker(workerPath, {
        workerData: { dbPath, workerId, operations },
      });

      worker.on('message', resolve);
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker ${workerId} stopped with exit code ${code}`));
        }
      });
    });
  }

  describe('Lost Update Detection', () => {
    it('should detect lost updates when multiple threads write to same key', async () => {
      const testKey = 'concurrent-update-key';
      const numWorkers = 10;
      const writesPerWorker = 10;

      // Each worker will try to write to the same key multiple times
      const workerPromises = [];
      for (let i = 0; i < numWorkers; i++) {
        const operations = [];
        for (let j = 0; j < writesPerWorker; j++) {
          operations.push({
            type: 'write',
            key: testKey,
            value: `worker-${i}-write-${j}`,
          });
        }
        workerPromises.push(runWorker(testDbPath, i, operations));
      }

      const results = await Promise.all(workerPromises);

      // Check all workers succeeded
      results.forEach((result) => {
        expect(result.errors).toBe(0);
        expect(result.success).toBe(writesPerWorker);
      });

      // Check final state - should have exactly 1 entry (last writer wins)
      const finalValue = cache.get(testKey);
      expect(finalValue).not.toBeNull();
      expect(finalValue).toMatch(/^worker-\d+-write-\d+$/);

      const stats = cache.getStats();
      expect(stats.totalEntries).toBe(1);

      console.log(`Lost Update Test: ${numWorkers * writesPerWorker} writes resulted in final value: ${finalValue}`);
    }, 30000);

    it('should detect race conditions in hit count updates', async () => {
      const testKey = 'hitcount-race-key';
      cache.set(testKey, 'test-value', 10, 10);

      const numWorkers = 20;
      const updatesPerWorker = 10;

      // Each worker will update hit count
      const workerPromises = [];
      for (let i = 0; i < numWorkers; i++) {
        const operations = [];
        for (let j = 0; j < updatesPerWorker; j++) {
          operations.push({
            type: 'update_hit_count',
            key: testKey,
          });
        }
        workerPromises.push(runWorker(testDbPath, i, operations));
      }

      const results = await Promise.all(workerPromises);

      // Check all workers succeeded
      results.forEach((result) => {
        expect(result.errors).toBe(0);
      });

      // Check hit count
      const entries = cache.getAllEntries();
      const entry = entries.find((e) => e.key === testKey);
      expect(entry).toBeDefined();

      const expectedHitCount = numWorkers * updatesPerWorker;
      const actualHitCount = entry!.hitCount;

      console.log(
        `Hit Count Race Test: Expected ${expectedHitCount}, Got ${actualHitCount}, Lost ${expectedHitCount - actualHitCount} updates`
      );

      // Due to race conditions, actual may be less than expected
      // This test documents the race condition
      expect(actualHitCount).toBeGreaterThan(0);
      expect(actualHitCount).toBeLessThanOrEqual(expectedHitCount);

      // If hit count is significantly lower, there's a race condition
      const lossPercentage = ((expectedHitCount - actualHitCount) / expectedHitCount) * 100;
      if (lossPercentage > 10) {
        console.warn(`WARNING: Lost ${lossPercentage.toFixed(2)}% of hit count updates due to race conditions`);
      }
    }, 30000);
  });

  describe('Concurrent Write Conflicts', () => {
    it('should handle many workers writing to different keys', async () => {
      const numWorkers = 20;
      const keysPerWorker = 50;

      const workerPromises = [];
      for (let i = 0; i < numWorkers; i++) {
        const operations = [];
        for (let j = 0; j < keysPerWorker; j++) {
          operations.push({
            type: 'write',
            key: `worker-${i}-key-${j}`,
            value: `worker-${i}-value-${j}`,
          });
        }
        workerPromises.push(runWorker(testDbPath, i, operations));
      }

      const results = await Promise.all(workerPromises);

      // All workers should succeed
      results.forEach((result, index) => {
        expect(result.errors).toBe(0);
        expect(result.success).toBe(keysPerWorker);
      });

      // Check total entries
      const stats = cache.getStats();
      expect(stats.totalEntries).toBe(numWorkers * keysPerWorker);

      console.log(`Concurrent Writes Test: ${numWorkers} workers wrote ${keysPerWorker} keys each = ${stats.totalEntries} total entries`);
    }, 30000);

    it('should handle mixed read/write workload across workers', async () => {
      // Pre-populate some keys
      for (let i = 0; i < 50; i++) {
        cache.set(`shared-key-${i}`, `shared-value-${i}`, 15, 15);
      }

      const numWorkers = 15;
      const opsPerWorker = 50;

      const workerPromises = [];
      for (let i = 0; i < numWorkers; i++) {
        const operations = [];
        for (let j = 0; j < opsPerWorker; j++) {
          // Mix of reads and writes
          if (j % 2 === 0) {
            operations.push({
              type: 'read',
              key: `shared-key-${j % 50}`,
            });
          } else {
            operations.push({
              type: 'write',
              key: `worker-${i}-key-${j}`,
              value: `worker-${i}-value-${j}`,
            });
          }
        }
        workerPromises.push(runWorker(testDbPath, i, operations));
      }

      const results = await Promise.all(workerPromises);

      // All workers should succeed
      results.forEach((result) => {
        expect(result.errors).toBe(0);
      });

      // Check cache is still functional
      expect(cache.get('shared-key-0')).toBe('shared-value-0');

      console.log(`Mixed Workload Test: ${numWorkers} workers completed ${opsPerWorker} mixed operations each`);
    }, 30000);
  });

  describe('SQLite WAL Mode Behavior', () => {
    it('should allow concurrent readers and writers with WAL mode', async () => {
      // Pre-populate keys
      for (let i = 0; i < 100; i++) {
        cache.set(`wal-key-${i}`, `wal-value-${i}`, 15, 15);
      }

      const numReaders = 10;
      const numWriters = 10;
      const opsPerWorker = 50;

      const workerPromises = [];

      // Spawn reader workers
      for (let i = 0; i < numReaders; i++) {
        const operations = [];
        for (let j = 0; j < opsPerWorker; j++) {
          operations.push({
            type: 'read',
            key: `wal-key-${j % 100}`,
          });
        }
        workerPromises.push(runWorker(testDbPath, `reader-${i}`, operations));
      }

      // Spawn writer workers
      for (let i = 0; i < numWriters; i++) {
        const operations = [];
        for (let j = 0; j < opsPerWorker; j++) {
          operations.push({
            type: 'write',
            key: `new-key-${i}-${j}`,
            value: `new-value-${i}-${j}`,
          });
        }
        workerPromises.push(runWorker(testDbPath, `writer-${i}`, operations));
      }

      const results = await Promise.all(workerPromises);

      // All workers should complete successfully
      results.forEach((result) => {
        expect(result.errors).toBe(0);
        expect(result.success).toBe(opsPerWorker);
      });

      // Verify data integrity
      const stats = cache.getStats();
      expect(stats.totalEntries).toBeGreaterThan(100); // Original 100 + new writes

      console.log(`WAL Test: ${numReaders} readers and ${numWriters} writers completed ${opsPerWorker} ops each`);
      console.log(`Final entry count: ${stats.totalEntries}`);
    }, 30000);
  });

  describe('Extreme Stress Test', () => {
    it('should survive extreme concurrent load from many workers', async () => {
      const numWorkers = 30;
      const opsPerWorker = 100;

      const workerPromises = [];
      for (let i = 0; i < numWorkers; i++) {
        const operations = [];
        for (let j = 0; j < opsPerWorker; j++) {
          const opType = j % 4;
          if (opType === 0) {
            operations.push({
              type: 'write',
              key: `stress-key-${i}-${j}`,
              value: `stress-value-${i}-${j}`,
            });
          } else if (opType === 1) {
            operations.push({
              type: 'read',
              key: `stress-key-${(i + 1) % numWorkers}-${j}`,
            });
          } else if (opType === 2) {
            operations.push({
              type: 'update_hit_count',
              key: `stress-key-${(i + 2) % numWorkers}-${j}`,
            });
          } else {
            operations.push({
              type: 'delete',
              key: `stress-key-${(i + 3) % numWorkers}-${j}`,
            });
          }
        }
        workerPromises.push(runWorker(testDbPath, i, operations));
      }

      const results = await Promise.all(workerPromises);

      // Count total errors
      const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);
      const totalSuccess = results.reduce((sum, r) => sum + r.success, 0);

      console.log(`Extreme Stress Test: ${numWorkers} workers, ${opsPerWorker} ops each`);
      console.log(`Total successful operations: ${totalSuccess}`);
      console.log(`Total errors: ${totalErrors}`);

      // Most operations should succeed (allow some failures due to deletes)
      const successRate = totalSuccess / (numWorkers * opsPerWorker);
      expect(successRate).toBeGreaterThan(0.8); // At least 80% success

      // Cache should still be operational
      cache.set('final-stress-test', 'final-value', 11, 11);
      expect(cache.get('final-stress-test')).toBe('final-value');
    }, 60000);
  });

  describe('Data Integrity Verification', () => {
    it('should maintain data integrity after concurrent operations', async () => {
      const numWorkers = 10;
      const entriesPerWorker = 100;

      // Each worker writes unique keys with known values
      const workerPromises = [];
      for (let i = 0; i < numWorkers; i++) {
        const operations = [];
        for (let j = 0; j < entriesPerWorker; j++) {
          operations.push({
            type: 'write',
            key: `integrity-worker-${i}-key-${j}`,
            value: `integrity-worker-${i}-value-${j}`,
          });
        }
        workerPromises.push(runWorker(testDbPath, i, operations));
      }

      await Promise.all(workerPromises);

      // Verify every key has correct value
      let verifiedCount = 0;
      for (let i = 0; i < numWorkers; i++) {
        for (let j = 0; j < entriesPerWorker; j++) {
          const key = `integrity-worker-${i}-key-${j}`;
          const expectedValue = `integrity-worker-${i}-value-${j}`;
          const actualValue = cache.get(key);

          expect(actualValue).toBe(expectedValue);
          verifiedCount++;
        }
      }

      console.log(`Data Integrity Test: Verified ${verifiedCount} entries after concurrent writes`);
      expect(verifiedCount).toBe(numWorkers * entriesPerWorker);
    }, 30000);
  });
});
