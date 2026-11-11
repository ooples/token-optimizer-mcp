#!/usr/bin/env node
/**
 * The product's own between-session fold, run by the learned benchmark mode
 * between two plugin-arm runs. Spawned with the arm's environment, so every
 * path the product resolves -- its home, the repository's store -- is the one
 * the sessions themselves used.
 *
 *   node fold.mjs <plugin hooks lib dir> <repository cwd> <transcript dir> <claude binary>
 *
 * WHAT IT STANDS IN FOR. An installed product folds finished sessions at each
 * session start and writes a new prune only once every session of the
 * repository has been quiet for an hour (toolprune.mjs). A sequential benchmark
 * never has a quiet hour between runs, and nothing else is live, so the fold
 * is run with its clock moved past the quiet window: exactly what the detached
 * waiter would do after that hour, without the hour. The catalog probe is the
 * product's own, pointed at the binary under test rather than whichever
 * `claude` is first on PATH (a launcher shim on the machine this was built on).
 *
 * Prints one JSON object: the store directory, the repository root, and the
 * fold's summary (applied, pending, restored, blocked).
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [lib, cwd, transcriptDir, claude] = process.argv.slice(2);
if (!lib || !cwd || !transcriptDir || !claude) {
  console.error('usage: fold.mjs <plugin hooks lib dir> <repository cwd> <transcript dir> <claude binary>');
  process.exit(2);
}

const toolprune = await import(pathToFileURL(join(lib, 'toolprune.mjs')).href);
const { dir, root } = toolprune.learnedLocation(cwd);
const settings = toolprune.toolpruneSettings();
if (settings.mode !== 'off' && toolprune.catalogDue(toolprune.loadStore(dir))) {
  const probed = await toolprune.probeCatalog({ cli: claude });
  if (probed?.tools?.length) {
    const store = toolprune.loadStore(dir);
    store.catalog = { tools: probed.tools, probedAt: Date.now(), clientVersion: probed.clientVersion };
    toolprune.saveStore(dir, store);
  }
}
const summary = toolprune.runFold({
  dir,
  root,
  transcriptDir,
  currentSession: null,
  now: Date.now() + settings.quietMinutes * 60_000 + 1000,
});
process.stdout.write(`${JSON.stringify({ dir, root, ...summary })}\n`);
