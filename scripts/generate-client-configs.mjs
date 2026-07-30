#!/usr/bin/env node
/**
 * Generates MCP config + always-on rules for clients that expose no hook API.
 *
 * TWO TIERS, AND THE DIFFERENCE IS PROTOCOL, NOT EFFORT:
 *
 *   ENFORCING tier -- Claude Code, Codex, OpenCode. These expose a hook that
 *   runs BEFORE a tool executes and can refuse it. The optimizer denies the
 *   expensive call outright, so optimized tooling is not a suggestion.
 *
 *   DIRECTIVE tier -- Cursor, Windsurf, Cline, Roo, Zed, Amp, Continue, Kilo,
 *   Crush, Droid, Copilot, Gemini, Qwen. These expose MCP but no pre-execution
 *   veto. The strongest available lever is the client's ALWAYS-APPLIED rules
 *   file, which is loaded unconditionally into every request -- unlike a skill,
 *   which the model must first decide to consult.
 *
 * The distinction is stated in the docs rather than blurred. Claiming
 * enforcement on a client that cannot enforce would be a lie a user discovers
 * on their first large read.
 *
 * The rules text is generated from one source below, so a policy change reaches
 * every client at once instead of being hand-copied thirteen times.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const MCP_STDIO = {
  command: 'npx',
  args: ['-y', '@ooples/token-optimizer-mcp@latest'],
  env: {},
};

/**
 * The clients we ship configuration for, and how each one wants to be told.
 *
 * `rulesFile` is the path, relative to a user's project or config root, of the
 * file that client loads on EVERY request. `mcpFile` is where the server is
 * declared. Both are what that client's own documentation specifies; a config
 * written to the wrong filename is an integration that silently does nothing.
 */
const CLIENTS = [
  { key: 'cursor',   name: 'Cursor',            mcpFile: '.cursor/mcp.json',        mcpShape: 'mcpServers', rulesFile: '.cursor/rules/token-optimizer.mdc', rulesFormat: 'mdc' },
  { key: 'windsurf', name: 'Windsurf',          mcpFile: 'mcp_config.json',         mcpShape: 'mcpServers', rulesFile: '.windsurfrules',                    rulesFormat: 'md' },
  { key: 'cline',    name: 'Cline',             mcpFile: 'cline_mcp_settings.json', mcpShape: 'mcpServers', rulesFile: '.clinerules/token-optimizer.md',    rulesFormat: 'md' },
  { key: 'roo',      name: 'Roo Code',          mcpFile: 'mcp_settings.json',       mcpShape: 'mcpServers', rulesFile: '.roo/rules/token-optimizer.md',     rulesFormat: 'md' },
  { key: 'kilo',     name: 'Kilo Code',         mcpFile: 'mcp_settings.json',       mcpShape: 'mcpServers', rulesFile: '.kilocode/rules/token-optimizer.md', rulesFormat: 'md' },
  { key: 'zed',      name: 'Zed',               mcpFile: 'settings.json',           mcpShape: 'context_servers', rulesFile: 'AGENTS.md',                    rulesFormat: 'md' },
  { key: 'amp',      name: 'Amp',               mcpFile: 'settings.json',           mcpShape: 'amp.mcpServers',  rulesFile: 'AGENTS.md',                    rulesFormat: 'md' },
  { key: 'continue', name: 'Continue',          mcpFile: 'config.yaml',             mcpShape: 'yaml',       rulesFile: '.continue/rules/token-optimizer.md', rulesFormat: 'md' },
  { key: 'crush',    name: 'Crush',             mcpFile: 'crush.json',              mcpShape: 'mcp',        rulesFile: 'CRUSH.md',                          rulesFormat: 'md' },
  { key: 'droid',    name: 'Droid (Factory)',   mcpFile: 'mcp.json',                mcpShape: 'mcpServers', rulesFile: 'AGENTS.md',                         rulesFormat: 'md' },
];

/** The policy, written once. */
function rules(clientName) {
  return `Prefer the token-optimizer MCP tools over built-in file and search tools.
They cut context usage 60-90% by caching, diffing, and bounding output. ${clientName}
has no pre-execution hook, so nothing enforces this automatically -- following it
is what produces the saving.

ALWAYS:
- Reading a file over ~25 KB, or ANY file already read this session
  -> smart_read (on a repeat it returns only what changed, not the file)
- Searching file contents -> smart_grep
- Finding files by name or pattern -> smart_glob
- Editing a file over ~25 KB -> smart_edit (returns a diff, not the whole file)
- Printing a large file via cat/head/tail/type/Get-Content -> smart_read
- Recursive shell searches (grep -r, rg) -> smart_grep

WHEN CONTEXT IS TIGHT: call optimize_session to move prior file operations out
of context. Call get_optimization_report to show the user what was saved.

STASHING BULKY OUTPUT: optimize_text stores it under a key, out of context.
Do NOT use compress_text for that -- its base64 output has MORE tokens than the
input; it is for at-rest storage only.

NOT WORTH IT: small one-off reads, tiny edits. The built-ins are fine there --
the overhead would exceed the saving.`;
}

function mcpConfig(shape) {
  if (shape === 'yaml') {
    return `mcpServers:\n  - name: token-optimizer\n    command: npx\n    args: ["-y", "@ooples/token-optimizer-mcp@latest"]\n`;
  }
  if (shape === 'context_servers') {
    return JSON.stringify({ context_servers: { 'token-optimizer': { source: 'custom', ...MCP_STDIO } } }, null, 2) + '\n';
  }
  if (shape === 'amp.mcpServers') {
    return JSON.stringify({ 'amp.mcpServers': { 'token-optimizer': MCP_STDIO } }, null, 2) + '\n';
  }
  if (shape === 'mcp') {
    return JSON.stringify({ mcp: { 'token-optimizer': { type: 'stdio', ...MCP_STDIO } } }, null, 2) + '\n';
  }
  return JSON.stringify({ mcpServers: { 'token-optimizer': MCP_STDIO } }, null, 2) + '\n';
}

for (const client of CLIENTS) {
  const dir = join(ROOT, 'integrations', client.key);
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, client.mcpFile.split('/').pop()), mcpConfig(client.mcpShape));

  const body = rules(client.name);
  // Cursor's .mdc format needs frontmatter, and alwaysApply is the whole point:
  // without it the rule is retrieved only when Cursor judges it relevant, which
  // reproduces exactly the skill problem this redesign exists to fix.
  const text = client.rulesFormat === 'mdc'
    ? `---\ndescription: Route file and search operations through token-optimizer MCP tools\nalwaysApply: true\n---\n\n${body}\n`
    : `# Token optimization\n\n${body}\n`;
  writeFileSync(join(dir, client.rulesFile.split('/').pop()), text);

  writeFileSync(join(dir, 'README.md'),
`# ${client.name} integration

Tier: **directive** -- ${client.name} exposes MCP but no pre-execution hook, so
the optimizer cannot refuse an expensive call. The rules file below is loaded on
every request, which is the strongest lever available on this client.

## Install

1. Add the MCP server. Merge \`${client.mcpFile.split('/').pop()}\` into your
   \`${client.mcpFile}\`.
2. Copy \`${client.rulesFile.split('/').pop()}\` to \`${client.rulesFile}\` in your project.

Both files in this directory are generated from
\`scripts/generate-client-configs.mjs\`; edit that, not these.
`);
}

console.log(`generated configs for ${CLIENTS.length} directive-tier client(s)`);
