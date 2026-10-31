/**
 * Where a project's store lives, as hooks-core/maintenance.mjs decides it.
 *
 * NOT A SECOND COPY OF THE RULE. The store's location depends on its tombstone,
 * whether an in-repo store still exists, and an id hashed from the canonical
 * path (case-folded on Windows and macOS). A TypeScript re-implementation would
 * have to reproduce canonicalPath exactly to land in the same directory, and a
 * one-character difference would split a project's data across two stores.
 * The server loads the one implementation instead.
 */
import { loadHooksCore } from '../tools/intelligence/hooks-core-loader.js';

export async function projectStore(root: string): Promise<string> {
  const maintenance = await loadHooksCore<{
    projectStore: (root: string) => string;
  }>('maintenance.mjs');
  return maintenance.projectStore(root);
}

/** The project root a per-user store belongs to, or null. */
export async function storeProjectRoot(
  storeDir: string
): Promise<string | null> {
  const maintenance = await loadHooksCore<{
    storeProjectRoot: (dir: string) => string | null;
  }>('maintenance.mjs');
  return maintenance.storeProjectRoot(storeDir);
}
