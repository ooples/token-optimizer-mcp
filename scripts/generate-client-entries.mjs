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

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentMatches, readIfExists, writeIfChanged } from './lib/text.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** [directory, client key, event, filename] */
const ENTRIES = [
  ['integrations/codex/hooks', 'codex', 'session-start', 'session-start.mjs'],
  ['integrations/codex/hooks', 'codex', 'pre-tool', 'pre-tool.mjs'],
  ['integrations/codex/hooks', 'codex', 'post-tool', 'post-tool.mjs'],
  ['integrations/codex/hooks', 'codex', 'stop', 'stop.mjs'],
  ['integrations/codex/plugin/hooks', 'codex', 'session-start', 'session-start.mjs'],
  ['integrations/codex/plugin/hooks', 'codex', 'pre-tool', 'pre-tool.mjs'],
  ['integrations/codex/plugin/hooks', 'codex', 'post-tool', 'post-tool.mjs'],
  ['integrations/codex/plugin/hooks', 'codex', 'stop', 'stop.mjs'],
  ['integrations/gemini/hooks', 'gemini', 'session-start', 'session-start.mjs'],
  ['integrations/gemini/hooks', 'gemini', 'pre-tool', 'pre-tool.mjs'],
  ['integrations/gemini/hooks', 'gemini', 'post-tool', 'post-tool.mjs'],
  ['integrations/gemini/hooks', 'gemini', 'stop', 'stop.mjs'],
  ['integrations/qwen/hooks', 'qwen', 'session-start', 'session-start.mjs'],
  ['integrations/qwen/hooks', 'qwen', 'pre-tool', 'pre-tool.mjs'],
  ['integrations/qwen/hooks', 'qwen', 'post-tool', 'post-tool.mjs'],
  ['integrations/qwen/hooks', 'qwen', 'stop', 'stop.mjs'],
  ['integrations/opencode/hooks', 'opencode', 'session-start', 'session-start.mjs'],
  ['integrations/opencode/hooks', 'opencode', 'pre-tool', 'pre-tool.mjs'],
  ['integrations/opencode/hooks', 'opencode', 'post-tool', 'post-tool.mjs'],
  ['plugin/hooks', 'claude-code', 'post-tool', 'post-tool.mjs'],
  ['plugin/hooks', 'claude-code', 'stop', 'stop.mjs'],
  ['integrations/copilot/.github/hooks', 'copilot', 'session-start', 'session-start.mjs'],
  ['integrations/copilot/.github/hooks', 'copilot', 'pre-tool', 'pre-tool.mjs'],
  ['integrations/copilot/.github/hooks', 'copilot', 'post-tool', 'post-tool.mjs'],
  ['integrations/copilot/.github/hooks', 'copilot', 'stop', 'stop.mjs'],
  ['integrations/cline/hooks/token-optimizer', 'cline', 'session-start', 'session-start.mjs'],
  ['integrations/cline/hooks/token-optimizer', 'cline', 'pre-tool', 'pre-tool.mjs'],
  ['integrations/cline/hooks/token-optimizer', 'cline', 'post-tool', 'post-tool.mjs'],
  ['integrations/cursor/hooks', 'cursor', 'session-start', 'session-start.mjs'],
  ['integrations/cursor/hooks', 'cursor', 'pre-tool', 'pre-tool.mjs'],
  ['integrations/cursor/hooks', 'cursor', 'post-tool', 'post-tool.mjs'],
  ['integrations/cursor/hooks', 'cursor', 'stop', 'stop.mjs'],
  ['integrations/windsurf/hooks', 'windsurf', 'pre-tool', 'pre-tool.mjs'],
  ['integrations/windsurf/hooks', 'windsurf', 'post-tool', 'post-tool.mjs'],
  ['integrations/kilo/hooks', 'kilo', 'session-start', 'session-start.mjs'],
  ['integrations/kilo/hooks', 'kilo', 'pre-tool', 'pre-tool.mjs'],
  ['integrations/kilo/hooks', 'kilo', 'post-tool', 'post-tool.mjs'],
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
    // EOL-insensitive: these are stored LF and checked out CRLF on Windows, so
    // a byte comparison reported all ten entries drifted on every Windows clone
    // while Linux CI stayed green. See scripts/lib/text.mjs.
    if (!contentMatches(readIfExists(destination), contents)) {
      console.error(`DRIFT: ${destination.slice(ROOT.length + 1)}`);
      drifted++;
    }
    continue;
  }

  writeIfChanged(destination, contents);
}

if (check && drifted > 0) {
  console.error(`
${drifted} generated entry file(s) differ. Run: npm run sync:hooks`);
  process.exit(1);
}

console.log(check
  ? 'client entries in sync'
  : `generated ${ENTRIES.length} client entry file(s)`);
