#!/usr/bin/env node
/**
 * Generates MCP config + always-on rules for clients that expose no hook API.
 *
 * Generates the MCP declaration and always-on rules for clients whose config
 * is project-file based. Cursor, Windsurf, Cline, and Kilo additionally ship
 * native lifecycle bridges; the remaining entries use the rules as their
 * strongest available active-model lever.
 *
 * Capability differences are stated in the generated README rather than
 * blurred into one promise.
 *
 * The rules text is generated from one source below, so a policy change reaches
 * every client at once instead of being hand-copied thirteen times.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentMatches, readIfExists, writeIfChanged } from './lib/text.mjs';
import {
  capabilityFor,
  CAPABILITY_TIERS,
} from '../hooks-core/capabilities.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The published package, resolved at launch rather than frozen here.
 *
 * THIS REVERSES A DELIBERATE DECISION, so the argument it reverses is kept: a
 * committed `@latest` means every launch resolves whatever is newest, so a broken
 * or compromised release reaches users immediately and two machines are not
 * guaranteed to run the same code. Pinning was meant to make upgrades explicit and
 * reviewable, with `sync:hooks` moving the pin each release "rather than rotting".
 *
 * It rotted. Nothing ran the sync during a release, because the only thing that
 * could -- a workflow on the release PR -- cannot be triggered: release-please opens
 * that PR with GITHUB_TOKEN and GitHub suppresses workflow runs from it. So the pin
 * lagged, and a lagging pin is not a reviewed pin, it is a wrong one. Measured from a
 * real installed plugin cache:
 *
 *     plugin 5.3.6.pre-refresh  spawns server 5.3.2
 *     plugin 5.4.0              spawns server 5.3.6   <- a downgrade
 *
 * That is the failure pinning existed to prevent, caused by pinning. Users ran stale
 * code while the config asserted a version it was not running. Meanwhile the
 * invariant "committed spec == package.json" cannot hold across a release, and the
 * four mechanisms built to enforce it cost four releases: v5.4.0 and v5.4.1 were
 * tagged with GitHub Releases and neither reached npm.
 *
 * `@latest` is what the ecosystem ships -- Microsoft's official Playwright MCP uses
 * `npx @playwright/mcp@latest`, GitHub's official MCP carries no version at all, and
 * this project used `@latest` at 5.0.2, before the sweep that introduced the drift.
 *
 * If reproducibility is wanted back, the way to get it is NOT a value committed here:
 * it is pinning at publish time only, so the tarball carries an exact version while
 * git carries none. Nothing in git can then go stale.
 */
const PACKAGE_SPEC = '@ooples/token-optimizer-mcp@latest';

const MCP_STDIO = {
  command: 'npx',
  args: ['-y', PACKAGE_SPEC],
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
  {
    key: 'cursor',
    name: 'Cursor',
    nativeHooks: true,
    mcpFile: '.cursor/mcp.json',
    mcpShape: 'mcpServers',
    rulesFile: '.cursor/rules/token-optimizer.mdc',
    rulesFormat: 'mdc',
    docs: 'https://cursor.com/docs/context/rules',
    verified:
      'rules path, .mdc extension and alwaysApply frontmatter confirmed; project hooks use .cursor/hooks.json',
    hookInstall:
      'copy `hooks/` to `.cursor/hooks/token-optimizer/`, then merge `hooks.json` into `.cursor/hooks.json`',
  },

  // CORRECTED: `.windsurfrules` is the LEGACY single-file form. Current
  // Windsurf reads per-rule markdown from a rules directory; the old path is
  // still honoured, so this targets the current one.
  {
    key: 'windsurf',
    name: 'Windsurf',
    nativeHooks: true,
    mcpFile: 'mcp_config.json',
    mcpShape: 'mcpServers',
    rulesFile: '.windsurf/rules/token-optimizer.md',
    rulesFormat: 'md',
    docs: 'https://docs.windsurf.com/windsurf/cascade/memories',
    verified:
      'directory form is current, .windsurfrules is legacy; Cascade pre/post hook contract verified',
    hookInstall:
      'copy `hooks/` to `.windsurf/hooks/token-optimizer/`, then merge `hooks.json` into `.windsurf/hooks.json`',
  },

  {
    key: 'cline',
    name: 'Cline',
    nativeHooks: true,
    mcpFile: 'mcp.json',
    mcpShape: 'mcpServers',
    rulesFile: '.clinerules/token-optimizer.md',
    rulesFormat: 'md',
    docs: 'https://docs.cline.bot/mcp/configuring-mcp-servers',
    verified:
      'mcpServers key confirmed; CLI reads ~/.cline/mcp.json; project hooks use .clinerules/hooks with OS-specific wrappers',
    hookInstall:
      'copy the contents of `hooks/` to `.clinerules/hooks/`; on macOS/Linux mark the extensionless wrappers executable and enable them',
  },

  // Project-level .roo/mcp.json is preferred over the global mcp_settings.json:
  // it is version-controllable and takes precedence.
  {
    key: 'roo',
    name: 'Roo Code',
    mcpFile: '.roo/mcp.json',
    mcpShape: 'mcpServers',
    rulesFile: '.roo/rules/token-optimizer.md',
    rulesFormat: 'md',
    docs: 'https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo',
    verified:
      'mcpServers key and project-level .roo/mcp.json precedence confirmed',
  },

  // CORRECTED, and the largest error found: Kilo rebranded (kilocode.ai now
  // redirects to kilo.ai) and its schema is nothing like the common one. It
  // reads kilo.jsonc under an `mcp` key, with type "local", `command` as an
  // ARRAY, and `environment` rather than `env`. The previous mcp_settings.json
  // /mcpServers config would never have loaded.
  {
    key: 'kilo',
    name: 'Kilo',
    nativeHooks: true,
    mcpFile: '.kilo/kilo.jsonc',
    mcpShape: 'kilo',
    rulesFile: '.kilo/rules/token-optimizer.md',
    rulesFormat: 'md',
    docs: 'https://kilo.ai/docs/features/mcp/using-mcp-in-kilo-code',
    verified:
      'kilo.jsonc MCP schema confirmed; Kilo plugin tool before/after and system-transform hooks verified',
    hookInstall:
      'copy `.kilo/plugin/token-optimizer.js` to the same project path, and copy `hooks/` to `.kilo/hooks/token-optimizer/`',
  },

  // CORRECTED: Zed's current schema has no `source` key; command is a string
  // beside an args array.
  {
    key: 'zed',
    name: 'Zed',
    mcpFile: 'settings.json',
    mcpShape: 'context_servers',
    rulesFile: 'AGENTS.md',
    rulesFormat: 'md',
    docs: 'https://zed.dev/docs/ai/mcp',
    verified:
      'context_servers shape confirmed; no source key in the current schema',
  },

  {
    key: 'amp',
    name: 'Amp',
    mcpFile: 'settings.json',
    mcpShape: 'amp.mcpServers',
    rulesFile: 'AGENTS.md',
    rulesFormat: 'md',
    docs: 'https://ampcode.com/manual',
    verified: 'amp.mcpServers key and AGENTS.md both confirmed',
  },

  {
    key: 'continue',
    name: 'Continue',
    mcpFile: 'config.yaml',
    mcpShape: 'yaml',
    rulesFile: '.continue/rules/token-optimizer.md',
    rulesFormat: 'md',
    docs: 'https://docs.continue.dev/reference',
    verified: 'mcpServers is a LIST of name/command/args -- confirmed',
  },

  // CORRECTED: Crush reads AGENTS.md for project instructions by default.
  // CRUSH.md is the global per-user file, not the project one.
  {
    key: 'crush',
    name: 'Crush',
    mcpFile: 'crush.json',
    mcpShape: 'mcp',
    rulesFile: 'AGENTS.md',
    rulesFormat: 'md',
    docs: 'https://github.com/charmbracelet/crush',
    verified:
      'mcp key with type:stdio confirmed; AGENTS.md is the project default',
  },

  {
    key: 'droid',
    name: 'Droid (Factory)',
    mcpFile: 'mcp.json',
    mcpShape: 'mcpServers',
    rulesFile: 'AGENTS.md',
    rulesFormat: 'md',
    docs: 'https://docs.factory.ai/cli/configuration/mcp',
    verified: 'mcpServers key confirmed; the CLI reads ~/.factory/mcp.json',
  },
];

for (const client of CLIENTS) {
  const capability = capabilityFor(client.key);
  if (!capability)
    throw new Error(`missing capability registry entry for ${client.key}`);
  const registrySaysNative = capability.tier !== CAPABILITY_TIERS.RULES;
  if (Boolean(client.nativeHooks) !== registrySaysNative) {
    throw new Error(
      `capability drift for ${client.key}: generator and registry disagree`
    );
  }
}

/** The policy, written once. */
function rules(client) {
  const enforcement = client.nativeHooks
    ? `${client.name}'s packaged native hook enforces the pre-tool routes below and injects graph findings when its lifecycle permits.`
    : `${client.name} has no packaged pre-execution bridge, so following these always-on rules is what produces the saving.`;
  return `Use a token-optimizer MCP tool only when that exact tool is visible in
the current CLI's registered tool inventory. A config file or installed plugin
is not proof that the server started successfully. If a named optimizer tool is
absent, keep the native tool available and use a bounded native operation; never
retry or redirect to an unregistered schema.

When registered, prefer the token-optimizer MCP tools over built-in file and
search tools. They cache, diff, and bound output. ${enforcement}

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

LIVE GRAPH — THE ACTIVE MODEL DOES THE SEMANTIC HARVEST:
- When wiki_write is visible in the current tool inventory, call it as soon as
  you establish a durable, non-obvious conclusion:
  a failed approach and why, a decision and its rejected alternative, or the
  command that finally worked.
- Anchor every claim to a real file path or path#symbol. Never invent a claim
  merely to populate the graph, and do not delegate harvesting to another model.
- Include the concrete evidence, when it applies, confidenceLabel
  (verified/probable/speculative), scope (project/organization/global), and any
  condition that would invalidate it. Use project scope unless transfer is
  genuinely justified.
- Before finishing substantive work, reflect once and write any still-unrecorded
  conclusion while you hold the reasoning. This is what makes the lesson
  available across sessions and projects instead of losing it to compaction.
- If wiki_write is absent, do not claim the conclusion was harvested. Continue
  the work with native tools; lifecycle hooks may still capture structural facts.

NOT WORTH IT: small one-off reads, tiny edits. The built-ins are fine there --
the overhead would exceed the saving.`;
}

function mcpConfig(shape) {
  if (shape === 'yaml') {
    return `mcpServers:\n  - name: token-optimizer\n    command: npx\n    args: ["-y", "${PACKAGE_SPEC}"]\n`;
  }
  if (shape === 'context_servers') {
    // No `source` key: it is not in Zed's current schema, and an unrecognised
    // key is how a config file loads without the server ever appearing.
    return (
      JSON.stringify(
        { context_servers: { 'token-optimizer': MCP_STDIO } },
        null,
        2
      ) + '\n'
    );
  }
  if (shape === 'amp.mcpServers') {
    return (
      JSON.stringify(
        { 'amp.mcpServers': { 'token-optimizer': MCP_STDIO } },
        null,
        2
      ) + '\n'
    );
  }
  if (shape === 'kilo') {
    return (
      JSON.stringify(
        {
          mcp: {
            'token-optimizer': {
              type: 'local',
              // An array, not a string plus args -- Kilo's schema differs here.
              command: ['npx', '-y', PACKAGE_SPEC],
              environment: {},
              enabled: true,
            },
          },
        },
        null,
        2
      ) + '\n'
    );
  }
  if (shape === 'mcp') {
    return (
      JSON.stringify(
        { mcp: { 'token-optimizer': { type: 'stdio', ...MCP_STDIO } } },
        null,
        2
      ) + '\n'
    );
  }
  return (
    JSON.stringify({ mcpServers: { 'token-optimizer': MCP_STDIO } }, null, 2) +
    '\n'
  );
}

const check = process.argv.includes('--check');
let drifted = 0;

/**
 * Writes, or in check mode reports a mismatch without touching the file.
 *
 * The comparison is EOL-insensitive. These files are stored LF and checked out
 * CRLF on Windows, so a byte comparison reports drift on every Windows clone
 * while Linux CI stays green. See scripts/lib/text.mjs.
 */
function emit(path, contents) {
  if (check) {
    if (!contentMatches(readIfExists(path), contents)) {
      console.error(`DRIFT: ${path.slice(ROOT.length + 1)}`);
      drifted++;
    }
    return;
  }
  writeIfChanged(path, contents);
}

for (const client of CLIENTS) {
  const dir = join(ROOT, 'integrations', client.key);
  if (!check) mkdirSync(dir, { recursive: true });

  emit(join(dir, client.mcpFile.split('/').pop()), mcpConfig(client.mcpShape));

  const body = rules(client);
  // Cursor's .mdc format needs frontmatter, and alwaysApply is the whole point:
  // without it the rule is retrieved only when Cursor judges it relevant, which
  // reproduces exactly the skill problem this redesign exists to fix.
  const text =
    client.rulesFormat === 'mdc'
      ? `---\ndescription: Route file and search operations through token-optimizer MCP tools\nalwaysApply: true\n---\n\n${body}\n`
      : `# Token optimization\n\n${body}\n`;
  emit(join(dir, client.rulesFile.split('/').pop()), text);

  emit(
    join(dir, 'README.md'),
    `# ${client.name} integration

Tier: **${client.nativeHooks ? 'native hook + rules' : 'rules'}** -- ${
      client.nativeHooks
        ? `${client.name}'s native lifecycle bridge routes expensive calls, captures structural graph evidence, and injects applicable findings. The rules require the active model to perform semantic wiki_write harvesting.`
        : `${client.name} has no packaged lifecycle continuation, so its always-applied rules route expensive calls and require the active model to perform semantic wiki_write harvesting before completion.`
    }

## Install

1. **MCP server** -- merge the contents of \`${client.mcpFile.split('/').pop()}\`
   (in this directory) into your \`${client.mcpFile}\`.
2. **Rules** -- copy \`${client.rulesFile.split('/').pop()}\` (in this directory)
   to \`${client.rulesFile}\` in your project.
${client.nativeHooks ? `3. **Hooks** -- ${client.hookInstall}.\n` : ''}

Both destinations are the paths ${client.name}'s own documentation specifies;
the file names in this directory are flat because a repository cannot ship a
dot-directory for every client. The destination, not the source name, is what
matters.

## Provenance

Verified against ${client.docs}
(${client.verified}).

Both files in this directory are generated from
\`scripts/generate-client-configs.mjs\`; edit that, not these.
`
  );
}

if (check && drifted > 0) {
  console.error(`
${drifted} generated config file(s) differ. Run: npm run sync:hooks`);
  process.exit(1);
}

console.log(
  check
    ? 'client configs in sync'
    : `generated configs for ${CLIENTS.length} client integration(s)`
);
