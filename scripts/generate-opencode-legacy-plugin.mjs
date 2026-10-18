#!/usr/bin/env node
/**
 * Generates the OpenCode plugin for OpenCode 1.3.3 and earlier.
 *
 * Those releases call every export of a plugin file as a plugin function
 * (packages/opencode/src/plugin/index.ts up to v1.3.3), and the current
 * plugin's default export is the object OpenCode 2.x requires, so a release
 * that old fails to load the whole file. No one module satisfies both loaders.
 * The legacy build is the current plugin cut at its LEGACY CUT marker, so the
 * two can never disagree about a hook.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  contentMatches,
  normalizeEol,
  readIfExists,
  writeIfChanged,
} from './lib/text.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'integrations/opencode/.opencode/plugins/token-optimizer.js';
const LEGACY = 'integrations/opencode/legacy/.opencode/plugins/token-optimizer.js';
const check = process.argv.includes('--check');

const text = normalizeEol(readFileSync(join(ROOT, SOURCE), 'utf8'));
const cut = text.indexOf('\n// LEGACY CUT.');
if (cut < 0) {
  console.error(`${SOURCE} has no LEGACY CUT marker`);
  process.exit(1);
}
const contents = `// GENERATED from ${SOURCE} by
// scripts/generate-opencode-legacy-plugin.mjs -- edit that file, then run
// \`npm run sync:hooks\`. For OpenCode 1.3.3 and earlier only: it exports the
// V1 plugin function and nothing else, because those releases call every
// export as a plugin. Install this file OR the current one, never both.
${text.slice(0, cut).trimEnd()}
`;

const destination = join(ROOT, LEGACY);
if (check) {
  if (!contentMatches(readIfExists(destination), contents)) {
    console.error(`DRIFT: ${LEGACY}\nRun: npm run sync:hooks`);
    process.exit(1);
  }
  console.log('opencode legacy plugin in sync');
} else {
  writeIfChanged(destination, contents);
  console.log(`generated ${LEGACY}`);
}
