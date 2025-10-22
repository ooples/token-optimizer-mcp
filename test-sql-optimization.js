import Database from 'better-sqlite3';
import fs from 'fs';
import { performance } from 'perf_hooks';

// Create a test database
const dbPath = '.test-sql-optimization.db';
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Create table
db.exec(`
  CREATE TABLE cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    compressed_size INTEGER NOT NULL,
    original_size INTEGER NOT NULL,
    hit_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_accessed_at INTEGER NOT NULL
  );
`);

console.log('Testing SQL Optimization: INSERT OR REPLACE vs ON CONFLICT DO UPDATE\n');

// Test 1: Old method (INSERT OR REPLACE with subqueries)
console.log('=== Test 1: INSERT OR REPLACE (OLD METHOD) ===');
const oldStmt = db.prepare(`
  INSERT OR REPLACE INTO cache
  (key, value, compressed_size, original_size, hit_count, created_at, last_accessed_at)
  VALUES (?, ?, ?, ?,
    COALESCE((SELECT hit_count FROM cache WHERE key = ?), 0),
    COALESCE((SELECT created_at FROM cache WHERE key = ?), ?),
    ?)
`);

const iterations = 1000;
const key1 = 'test-key-1';
const now1 = Date.now();

const start1 = performance.now();
for (let i = 0; i < iterations; i++) {
  oldStmt.run(key1, `value${i}`, 10, 5, key1, key1, now1, now1 + i);
}
const duration1 = performance.now() - start1;
const opsPerSec1 = (iterations / duration1) * 1000;

console.log(`Updates: ${iterations}`);
console.log(`Duration: ${duration1.toFixed(2)}ms`);
console.log(`Ops/sec: ${opsPerSec1.toFixed(0)}`);

// Verify the data
const row1 = db.prepare('SELECT * FROM cache WHERE key = ?').get(key1);
console.log(`Final hit_count: ${row1.hit_count} (should be 0)`);
console.log(`Final created_at: ${row1.created_at} (should be ${now1})`);

// Clean up for next test
db.exec('DELETE FROM cache');

// Test 2: New method (ON CONFLICT DO UPDATE)
console.log('\n=== Test 2: ON CONFLICT DO UPDATE (NEW METHOD) ===');
const newStmt = db.prepare(`
  INSERT INTO cache
  (key, value, compressed_size, original_size, hit_count, created_at, last_accessed_at)
  VALUES (?, ?, ?, ?, 0, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    compressed_size = excluded.compressed_size,
    original_size = excluded.original_size,
    last_accessed_at = excluded.last_accessed_at
`);

const key2 = 'test-key-2';
const now2 = Date.now();

const start2 = performance.now();
for (let i = 0; i < iterations; i++) {
  newStmt.run(key2, `value${i}`, 10, 5, now2, now2 + i);
}
const duration2 = performance.now() - start2;
const opsPerSec2 = (iterations / duration2) * 1000;

console.log(`Updates: ${iterations}`);
console.log(`Duration: ${duration2.toFixed(2)}ms`);
console.log(`Ops/sec: ${opsPerSec2.toFixed(0)}`);

// Verify the data
const row2 = db.prepare('SELECT * FROM cache WHERE key = ?').get(key2);
console.log(`Final hit_count: ${row2.hit_count} (should be 0)`);
console.log(`Final created_at: ${row2.created_at} (should be ${now2})`);

// Compare results
console.log('\n=== PERFORMANCE COMPARISON ===');
const improvement = ((opsPerSec2 - opsPerSec1) / opsPerSec1) * 100;
console.log(`OLD METHOD: ${opsPerSec1.toFixed(0)} ops/sec`);
console.log(`NEW METHOD: ${opsPerSec2.toFixed(0)} ops/sec`);
console.log(`IMPROVEMENT: ${improvement > 0 ? '+' : ''}${improvement.toFixed(1)}% ${improvement > 0 ? 'FASTER' : 'SLOWER'}`);

// Clean up
db.close();
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
if (fs.existsSync(`${dbPath}-wal`)) fs.unlinkSync(`${dbPath}-wal`);
if (fs.existsSync(`${dbPath}-shm`)) fs.unlinkSync(`${dbPath}-shm`);

console.log('\n✅ SQL optimization test completed!');
