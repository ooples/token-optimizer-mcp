#!/usr/bin/env node
/**
 * Generates the per-client hook entry files.
 *
 * They are formulaic on purpose: a client entry exists only to name its client
 * and its event, so that the shared core in hooks-core/adapter.mjs makes every
 * actual decision. Generating them is what guarantees that stays true -- there
 * is no room for a client to quietly grow its own threshold or its own guidance
 * string, which is precisely how the previous Codex/Gemini/Claude advisors
 * drifted apart.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** [directory, client key, event, filename] */
const ENTRIES = [
  ['integrations/codex/hooks', 'codex', 'session-start', 'session-start.mjs'],
  ['integrations/codex/hooks', 'codex', 'pre-tool', 'pre-tool.mjs'],
  ['integrations/codex/plugin/hooks', 'codex', 'session-start', 'session-start.mjs'],
  ['integrations/codex/plugin/hooks', 'codex', 'pre-tool', 'pre-tool.mjs'],
  ['integrations/gemini/hooks', 'gemini', 'session-start', 'session-start.mjs'],
  // Gemini's only tool hook is AfterTool, which fires once the read has already
  // been paid for. It advises about the next call rather than pretending to a
  // veto it does not have.
  ['integrations/gemini/hooks', 'gemini', 'post-tool', 'post-tool.mjs'],
  ['integrations/qwen/hooks', 'qwen', 'session-start', 'session-start.mjs'],
  ['integrations/qwen/hooks', 'qwen', 'post-tool', 'post-tool.mjs'],
  ['integrations/opencode/hooks', 'opencode', 'session-start', 'session-start.mjs'],
  ['integrations/opencode/hooks', 'opencode', 'pre-tool', 'pre-tool.mjs'],
];

// --check verifies rather than writes. Without it CI validated only the
// vendored core, so a hand-edited generated entry sailed through green even
// though `sync:hooks` would have overwritten it -- exactly the drift the check
// exists to prevent, just one level up.
const check = process.argv.includes('--check');
let drifted = 0;

for (const [dir, client, event, name] of ENTRIES) {
  const target = join(ROOT, dir);
  const destination = join(target, name);
  const contents =
`#!/usr/bin/env node
// GENERATED FILE -- do not edit. Regenerate with \`npm run sync:hooks\`.
// Client entry point: names the client and event; all policy lives in the
// shared core so no client can drift its own thresholds or guidance.
import { run } from './lib/adapter.mjs';

// Fail open: a defect in the optimizer must never cost the user a tool call.
run('${client}', '${event}').catch(() => process.exit(0));
`;

  if (check) {
    const current = existsSync(destination) ? readFileSync(destination, 'utf8') : null;
    if (current !== contents) {
      console.error(`DRIFT: ${destination.slice(ROOT.length + 1)}`);
      drifted++;
    }
    continue;
  }

  mkdirSync(target, { recursive: true });
  writeFileSync(destination, contents);
}

if (check && drifted > 0) {
  console.error(`
${drifted} generated entry file(s) differ. Run: npm run sync:hooks`);
  process.exit(1);
}

console.log(check
  ? 'client entries in sync'
  : `generated ${ENTRIES.length} client entry file(s)`);
