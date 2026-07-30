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
  // `docs` is the page each entry was verified against. A config written to the
  // wrong filename or with the wrong top-level key is an integration that
  // silently does nothing -- it installs cleanly, reports no error, and never
  // loads. Recording the source is what makes these re-checkable when a client
  // changes its schema, rather than trusting a memory of how it worked once.
  { key: 'cursor',   name: 'Cursor',          mcpFile: '.cursor/mcp.json',        mcpShape: 'mcpServers',      rulesFile: '.cursor/rules/token-optimizer.mdc', rulesFormat: 'mdc',
    docs: 'https://cursor.com/docs/context/rules', verified: 'rules path, .mdc extension and alwaysApply frontmatter confirmed' },

  // CORRECTED: `.windsurfrules` is the LEGACY single-file form. Current
  // Windsurf reads per-rule markdown from a rules directory; the old path is
  // still honoured, so this targets the current one.
  { key: 'windsurf', name: 'Windsurf',        mcpFile: 'mcp_config.json',         mcpShape: 'mcpServers',      rulesFile: '.windsurf/rules/token-optimizer.md', rulesFormat: 'md',
    docs: 'https://docs.windsurf.com/windsurf/cascade/memories', verified: 'directory form is current, .windsurfrules is legacy' },

  { key: 'cline',    name: 'Cline',           mcpFile: 'mcp.json',                mcpShape: 'mcpServers',      rulesFile: '.clinerules/token-optimizer.md',    rulesFormat: 'md',
    docs: 'https://docs.cline.bot/mcp/configuring-mcp-servers', verified: 'mcpServers key confirmed; CLI reads ~/.cline/mcp.json, the VS Code extension reads cline_mcp_settings.json' },

  // Project-level .roo/mcp.json is preferred over the global mcp_settings.json:
  // it is version-controllable and takes precedence.
  { key: 'roo',      name: 'Roo Code',        mcpFile: '.roo/mcp.json',           mcpShape: 'mcpServers',      rulesFile: '.roo/rules/token-optimizer.md',     rulesFormat: 'md',
    docs: 'https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo', verified: 'mcpServers key and project-level .roo/mcp.json precedence confirmed' },

  // CORRECTED, and the largest error found: Kilo rebranded (kilocode.ai now
  // redirects to kilo.ai) and its schema is nothing like the common one. It
  // reads kilo.jsonc under an `mcp` key, with type "local", `command` as an
  // ARRAY, and `environment` rather than `env`. The previous mcp_settings.json
  // /mcpServers config would never have loaded.
  { key: 'kilo',     name: 'Kilo',            mcpFile: '.kilo/kilo.jsonc',        mcpShape: 'kilo',            rulesFile: '.kilo/rules/token-optimizer.md',    rulesFormat: 'md',
    docs: 'https://kilo.ai/docs/features/mcp/using-mcp-in-kilo-code', verified: 'kilo.jsonc with mcp key, type local, command ARRAY and environment -- confirmed' },

  // CORRECTED: Zed's current schema has no `source` key; command is a string
  // beside an args array.
  { key: 'zed',      name: 'Zed',             mcpFile: 'settings.json',           mcpShape: 'context_servers', rulesFile: 'AGENTS.md',                         rulesFormat: 'md',
    docs: 'https://zed.dev/docs/ai/mcp', verified: 'context_servers shape confirmed; no source key in the current schema' },

  { key: 'amp',      name: 'Amp',             mcpFile: 'settings.json',           mcpShape: 'amp.mcpServers',  rulesFile: 'AGENTS.md',                         rulesFormat: 'md',
    docs: 'https://ampcode.com/manual', verified: 'amp.mcpServers key and AGENTS.md both confirmed' },

  { key: 'continue', name: 'Continue',        mcpFile: 'config.yaml',             mcpShape: 'yaml',            rulesFile: '.continue/rules/token-optimizer.md', rulesFormat: 'md',
    docs: 'https://docs.continue.dev/reference', verified: 'mcpServers is a LIST of name/command/args -- confirmed' },

  // CORRECTED: Crush reads AGENTS.md for project instructions by default.
  // CRUSH.md is the global per-user file, not the project one.
  { key: 'crush',    name: 'Crush',           mcpFile: 'crush.json',              mcpShape: 'mcp',             rulesFile: 'AGENTS.md',                         rulesFormat: 'md',
    docs: 'https://github.com/charmbracelet/crush', verified: 'mcp key with type:stdio confirmed; AGENTS.md is the project default' },

  { key: 'droid',    name: 'Droid (Factory)', mcpFile: 'mcp.json',                mcpShape: 'mcpServers',      rulesFile: 'AGENTS.md',                         rulesFormat: 'md',
    docs: 'https://docs.factory.ai/cli/configuration/mcp', verified: 'mcpServers key confirmed; the CLI reads ~/.factory/mcp.json' },
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
    // No `source` key: it is not in Zed's current schema, and an unrecognised
    // key is how a config file loads without the server ever appearing.
    return JSON.stringify({ context_servers: { 'token-optimizer': MCP_STDIO } }, null, 2) + '\n';
  }
  if (shape === 'amp.mcpServers') {
    return JSON.stringify({ 'amp.mcpServers': { 'token-optimizer': MCP_STDIO } }, null, 2) + '\n';
  }
  if (shape === 'kilo') {
    return JSON.stringify({
      mcp: {
        'token-optimizer': {
          type: 'local',
          // An array, not a string plus args -- Kilo's schema differs here.
          command: ['npx', '-y', '@ooples/token-optimizer-mcp@latest'],
          environment: {},
          enabled: true,
        },
      },
    }, null, 2) + '\n';
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

## Provenance

Verified against ${client.docs}
(${client.verified}).

Both files in this directory are generated from
\`scripts/generate-client-configs.mjs\`; edit that, not these.
`);
}

console.log(`generated configs for ${CLIENTS.length} directive-tier client(s)`);
