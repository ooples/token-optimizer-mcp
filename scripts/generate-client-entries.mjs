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

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentMatches, readIfExists, writeIfChanged } from './lib/text.mjs';
import { HOOK_MCP_TOOLS } from '../hooks-core/capabilities.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_VERSION = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8')
).version;
const BUNDLED_MCP_CAPABILITIES = HOOK_MCP_TOOLS.join(',');

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

/**
 * Publish-time only, for the reason spelled out in scripts/sync-hook-core.mjs:
 * a committed version literal cannot survive a release commit, and the drift it
 * guarantees fails `publish-npm` at the tag. Thirty-seven entry files carried
 * one, which is why the surface was never going to be fixable by listing the
 * files somewhere.
 */
const stamp = process.argv.includes('--stamp');
const versionStamp = stamp
  ? `process.env.TOKEN_OPTIMIZER_VERSION = '${PACKAGE_VERSION}';\n`
  : '';
let drifted = 0;

for (const [dir, client, event, name] of ENTRIES) {
  const target = join(ROOT, dir);
  const destination = join(target, name);
  const contents =
`#!/usr/bin/env node
// GENERATED FILE -- do not edit. Regenerate with \`npm run sync:hooks\`.
// Client entry point: names the client and event; all policy lives in the
// shared core so no client can drift its own thresholds or guidance.
// Fail open: a defect in the optimizer must never cost the user a tool call.
// Bootstrap failures are still recorded so fail-open does not become fail-silent.
${versionStamp}// THE BUNDLED INVENTORY IS ASSERTED ONLY FOR AN ACTUAL PLUGIN INSTALL.
//
// This used to run unconditionally, on the grounds that these entry points ship
// beside an MCP declaration for the same package. That holds for a plugin --
// .mcp.json travels with the hooks -- and not otherwise: the script path wires
// hooks through settings.json without the server, a user can drop the server
// and keep the hooks, and the benchmark arm removes the mcp block outright.
//
// In those cases the fabricated list was persisted as PROVEN evidence and the
// model was told to call tools that do not exist. Measured over a debug-sized
// task with no server: 3,450 characters of advice built on the assumption,
// including "Call the token-optimizer MCP tool smart_read" after every repeated
// read -- a failed call and a retry each time, on a benchmark where turns
// dominate cost. Removing it from session-start alone took the debug segment
// from 1.309 to 1.107 and its turns from 2.231 to 2.003.
//
// THE OPT-OUT IS THE ENV VAR, NOT CLAUDE_PLUGIN_ROOT. Gating this on
// CLAUDE_PLUGIN_ROOT was tried and reverted: that variable is set by the Claude
// plugin runtime and by nothing else, while THESE entries are generated for
// codex, cursor, cline, gemini, qwen, copilot, windsurf and kilo -- whose
// installers write the hook and the MCP server config together, and which never
// set it. So the gate silently disabled enforcement-by-default for every one of
// them, and clients.test.mjs caught it across all eight ("denies a large read
// by default through its packaged pre-tool entry" -> received "allow").
//
// The nullish assignment below is what makes a narrower gate unnecessary: it
// assigns only when the variable is null or undefined, so an explicitly EMPTY
// value survives. A host, a user, or a benchmark arm measuring the hooks with
// no server states TOKEN_OPTIMIZER_MCP_CAPABILITIES='' and gets exactly the
// behaviour the gate reached for, without breaking installs that ship a server.
//
// NOTE FOR EDITORS: this whole block is inside a template literal. A backtick
// here terminates the string and the generator dies with a SyntaxError far from
// the cause -- which is exactly what happened writing this comment.
process.env.TOKEN_OPTIMIZER_MCP_CAPABILITIES ??= '${BUNDLED_MCP_CAPABILITIES}';
try {
  const { run } = await import('./lib/adapter.mjs');
  await run('${client}', '${event}');
} catch (error) {
  try {
    const { recordHookBootstrapFailure } = await import('./lib/observability.mjs');
    recordHookBootstrapFailure('${client}', '${event}', error);
  } catch {
    // A logger bootstrap failure is the only condition that remains silent.
  }
}
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
