// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/ignore-self.mjs. Regenerate with `npm run sync:hooks`.
/**
 * A store directory the plugin creates ignores itself in git (#500).
 *
 * Every per-project store -- the graph, the metrics and evidence logs, the
 * authored-content store -- holds unreviewed, machine-local agent output, and
 * none of it belongs in the user's history. The marker used to be written only
 * by the graph write, so a session whose first write was a metrics record left
 * `metrics.jsonl` and `evidence.jsonl` unignored, and they were committed into
 * a user repository inside three unrelated feature PRs.
 *
 * THE MARKER GOES IN THE STORE, NEVER ITS PARENT. A store directory can be
 * pointed anywhere by an environment variable, and when it points at a
 * directory the user owns, a `*` in the parent ignores their whole repository.
 * Ignoring only what we create cannot reach outside the store.
 */
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function ignoreSelf(dir) {
  const marker = join(dir, '.gitignore');
  try {
    if (existsSync(marker)) return;
    appendFileSync(
      marker,
      '# Written by token-optimizer. Findings are unreviewed agent output;\n' +
        '# keeping them out of git history is the default. Delete this file to\n' +
        '# opt in to committing them.\n*\n'
    );
  } catch {
    // Best effort. Failing to write the marker must not fail the store write.
  }
}
