/**
 * A counter that changes whenever this server writes to the filesystem.
 *
 * WHY A SEARCH RESULT CANNOT BE CACHED ON ITS ARGUMENTS ALONE.
 *
 * smart_grep and smart_glob cached results keyed on `{pattern, options}` and
 * nothing else. Measured live: search a tree, create a matching file, search
 * again with the same arguments -- the pre-creation result came back. The
 * entries live in SQLite with no expiry, so the stale answer survived a
 * process restart.
 *
 * The uncomfortable part is WHEN that cache gets hit. An identical search is
 * usually repeated *because* something changed; the moment the cache is most
 * likely to answer is the moment it is most likely to be wrong.
 *
 * This counter closes the case that dominates a session: a file written
 * through this server. Including it in a search's cache key means any write we
 * performed invalidates every cached search, exactly and for free.
 *
 * It cannot see a change made by anything else -- an editor, a git checkout, a
 * second agent. That is why `useCache` now defaults to FALSE for the two
 * search tools: opting in says "nothing outside this server is touching the
 * tree", which is a claim only the caller can make.
 */

let generation = 0;

/** Records that this server changed the filesystem. */
export function bumpFsGeneration(): void {
  generation++;
}

/** The current generation, for inclusion in a cache key. */
export function fsGeneration(): number {
  return generation;
}
