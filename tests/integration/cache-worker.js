/**
 * Worker thread for testing true concurrent access to CacheEngine
 * This worker is loaded by cache-concurrency-stress.test.ts
 */

import { parentPort, workerData } from 'worker_threads';
import Database from 'better-sqlite3';

// Worker receives: { dbPath, workerId, operations }
const { dbPath, workerId, operations } = workerData;

// Each worker creates its own CacheEngine-like access to the database
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

let results = {
  workerId,
  success: 0,
  errors: 0,
  operations: [],
};

try {
  operations.forEach((op) => {
    try {
      if (op.type === 'write') {
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO cache
          (key, value, compressed_size, original_size, hit_count, created_at, last_accessed_at)
          VALUES (?, ?, ?, ?, 0, ?, ?)
        `);
        const now = Date.now();
        stmt.run(op.key, op.value, 10, 10, now, now);
        results.success++;
      } else if (op.type === 'read') {
        const stmt = db.prepare('SELECT value FROM cache WHERE key = ?');
        const row = stmt.get(op.key);
        results.success++;
        results.operations.push({ type: 'read', key: op.key, found: !!row });
      } else if (op.type === 'update_hit_count') {
        const stmt = db.prepare(`
          UPDATE cache SET hit_count = hit_count + 1, last_accessed_at = ? WHERE key = ?
        `);
        stmt.run(Date.now(), op.key);
        results.success++;
      } else if (op.type === 'delete') {
        const stmt = db.prepare('DELETE FROM cache WHERE key = ?');
        stmt.run(op.key);
        results.success++;
      }
    } catch (error) {
      results.errors++;
      results.operations.push({
        type: op.type,
        key: op.key,
        error: error.message,
      });
    }
  });

  db.close();
  parentPort.postMessage(results);
} catch (error) {
  parentPort.postMessage({
    workerId,
    success: results.success,
    errors: results.errors + 1,
    fatalError: error.message,
  });
}
