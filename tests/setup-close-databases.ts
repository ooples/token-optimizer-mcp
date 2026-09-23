/**
 * Closes every SQLite handle this test file opened, before the file finishes.
 *
 * WHY HERE AND NOT IN globalTeardown. globalTeardown runs in the main Jest process, but test files
 * execute inside a sandboxed module registry whose global object is a DIFFERENT one -- a property
 * set on globalThis by src/ code is `undefined` when the teardown reads it (measured). So the
 * teardown cannot reach the registry that holds the handles, and under --runInBand its rmSync hit
 *   EBUSY: resource busy or locked, unlink '...\.token-optimizer-cache\cache.db'
 * because the handle was open in the very process doing the deleting.
 *
 * setupFilesAfterEnv runs inside each test file's own registry, so the module it imports here is
 * the same instance the tests used, and closing is possible at all.
 */
import { afterAll } from '@jest/globals';
import { closeAllDatabases } from '../src/core/database-registry.js';

afterAll(async () => {
  await closeAllDatabases();
});