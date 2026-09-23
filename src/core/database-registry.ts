/**
 * Every SQLite-backed component in this process that still holds an open file handle.
 *
 * WHY A REGISTRY AND NOT "each caller closes what it opened". On Windows an open handle makes the
 * file undeletable, and a caller that merely READS a cache has no reason to think it owns a handle
 * at all. The concrete failure was the Windows release-verification job: every test passed and
 * then globalTeardown died with
 *   EBUSY: resource busy or locked, unlink '...\.token-optimizer-cache\cache.db'
 * That job runs with --runInBand, so retrying the unlink could never win -- the handle was open in
 * the very process doing the deleting, and nothing was ever going to close it.
 *
 * WAL mode locks cache.db-wal and cache.db-shm alongside cache.db, so each owner is three files.
 */

/** A component that owns a database handle and can give it up on demand. */
export interface DatabaseOwner {
  close(): void | Promise<void>;
}

const openOwners = new Set<DatabaseOwner>();

/** Record an owner as holding an open handle. Returns the owner so it can be used inline. */
export function registerDatabaseOwner<T extends DatabaseOwner>(owner: T): T {
  openOwners.add(owner);
  return owner;
}

/** Forget an owner that has closed its handle. Unknown owners are ignored. */
export function unregisterDatabaseOwner(owner: DatabaseOwner): void {
  openOwners.delete(owner);
}

/** How many owners currently hold an open handle. */
export function openDatabaseCount(): number {
  return openOwners.size;
}

/**
 * Close every database handle open in this process, and report how many were closed.
 *
 * For shutdown paths and for test teardown. Safe to call more than once, and an owner that is
 * already closed is not an error: the point is that nothing is left holding the files.
 */
export async function closeAllDatabases(): Promise<number> {
  let closed = 0;
  for (const owner of [...openOwners]) {
    try {
      await owner.close();
      closed += 1;
    } catch {
      // Already closed, or a native handle that is past saving. Either way it is no longer ours
      // to worry about, and one bad owner must not strand the rest.
    } finally {
      openOwners.delete(owner);
    }
  }
  return closed;
}