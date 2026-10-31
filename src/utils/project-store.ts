/**
 * Where a project's store lives: `<root>/.token-optimizer`, or wherever the
 * tombstone a migration left there says it moved (#542).
 *
 * The TypeScript twin of `projectStore` in hooks-core/maintenance.mjs, for the
 * server paths that build a store path synchronously. After a migration,
 * `<root>/.token-optimizer` is a FILE, and a path built under it fails with
 * ENOTDIR; following the tombstone is what keeps these writers working.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function projectStore(root: string): string {
  const marker = join(root, '.token-optimizer');
  try {
    // eslint-disable-next-line n/no-sync -- one stat on a synchronous path builder
    if (statSync(marker).isFile()) {
      // eslint-disable-next-line n/no-sync -- the tombstone is a few hundred bytes
      const tomb = JSON.parse(readFileSync(marker, 'utf8')) as {
        movedTo?: unknown;
      };
      if (typeof tomb.movedTo === 'string') return tomb.movedTo;
    }
  } catch {
    // No store yet, or not a tombstone: the in-repo path.
  }
  return marker;
}
