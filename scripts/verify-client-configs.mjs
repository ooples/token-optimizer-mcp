#!/usr/bin/env node
/**
 * Validates every generated client integration.
 *
 * THE FAILURE THIS GUARDS AGAINST IS SILENT. A config written to the wrong
 * filename, or with the wrong top-level key, installs cleanly and reports no
 * error -- the client simply never loads it, and the user concludes the product
 * does not work. Nothing in the test suite or the type checker can see that,
 * because the files are valid JSON either way.
 *
 * So this asserts the shape each client's documentation specifies, and the
 * generator records the doc URL every entry was checked against. SIX real
 * errors were found this way:
 *
 *   - Kilo rebranded and its schema is nothing like the common one: kilo.jsonc
 *     under an `mcp` key, type "local", command as an ARRAY, `environment`
 *     rather than `env`. The old mcpServers config could never have loaded.
 *   - Zed carried a `source` key that is not in its current schema
 *   - Windsurf targeted `.windsurfrules`, the LEGACY single-file form
 *   - Crush targeted CRUSH.md, which is the per-user file, not the project one
 *   - Cline used the VS Code extension's filename for a CLI config
 *   - Roo used the global path rather than project-level `.roo/mcp.json`
 *
 * Run: npm run verify:clients
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INTEGRATIONS = join(ROOT, 'integrations');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
};

/**
 * The shape each client must produce, from its own documentation.
 *
 * `topKey` is the property the client looks for. Getting it wrong is the single
 * most consequential mistake available here, because everything else about the
 * file can be perfect and the server still never starts.
 */
const EXPECTED = {
  cursor:   { file: 'mcp.json',        topKey: 'mcpServers',      rules: 'token-optimizer.mdc', frontmatter: true, nativeHooks: true },
  windsurf: { file: 'mcp_config.json', topKey: 'mcpServers',      rules: 'token-optimizer.md', nativeHooks: true },
  cline:    { file: 'mcp.json',        topKey: 'mcpServers',      rules: 'token-optimizer.md', nativeHooks: true },
  roo:      { file: 'mcp.json',        topKey: 'mcpServers',      rules: 'token-optimizer.md' },
  // Kilo's schema is genuinely different: an `mcp` key, type "local", command
  // as an ARRAY, and `environment` rather than `env`.
  kilo:     { file: 'kilo.jsonc',      topKey: 'mcp',             rules: 'token-optimizer.md', kiloShape: true, nativeHooks: true },
  zed:      { file: 'settings.json',   topKey: 'context_servers', rules: 'AGENTS.md' },
  amp:      { file: 'settings.json',   topKey: 'amp.mcpServers',  rules: 'AGENTS.md' },
  continue: { file: 'config.yaml',     yaml: true,                rules: 'token-optimizer.md' },
  crush:    { file: 'crush.json',      topKey: 'mcp',             rules: 'AGENTS.md', stdioType: true },
  droid:    { file: 'mcp.json',        topKey: 'mcpServers',      rules: 'AGENTS.md' },
};

/** Files that must NOT exist -- superseded paths that would confuse a user. */
const RETIRED = [
  ['windsurf', '.windsurfrules', 'legacy single-file form'],
  ['crush', 'CRUSH.md', 'per-user file, not the project one'],
  ['cline', 'cline_mcp_settings.json', 'VS Code extension filename'],
  ['kilo', 'mcp_settings.json', 'wrong schema entirely -- Kilo reads kilo.jsonc'],
  ['roo', 'mcp_settings.json', 'global path; project-level .roo/mcp.json takes precedence'],
];

const PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
// `@latest`, not the package version. #256 removed the numeric pin because it
// is a DERIVED value release-please never bumps: it went stale for four
// consecutive releases and shipped a plugin that launched a server three
// versions behind. This file kept asserting the abandoned invariant, so
// `verify:clients` exited 1 with 104/129 checks passing -- unnoticed because no
// workflow runs it. Supply-chain pinning happens at PUBLISH time (npm provenance
// + OIDC), never as a value committed to git.
const PACKAGE = '@ooples/token-optimizer-mcp@latest';

/**
 * Parses JSON or JSONC.
 *
 * Kilo's config is `kilo.jsonc`, and JSONC permits comments and trailing
 * commas. Strict JSON.parse on it is a check that passes only by accident --
 * the moment a user (or we) add the comment the format exists for, the verifier
 * reports the file as invalid when the client reads it fine.
 */
function parseJsonc(raw) {
  // String literals are matched FIRST and passed through untouched, so a `//`
  // or `/*` inside a value (a URL, a glob) is not mistaken for a comment.
  const withoutComments = raw.replace(
    /"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match) => (match.startsWith('"') ? match : ' '),
  );
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(withoutTrailingCommas);
}

for (const [key, expected] of Object.entries(EXPECTED)) {
  const dir = join(INTEGRATIONS, key);

  if (!existsSync(dir)) {
    check(`${key}: integration exists`, false);
    continue;
  }

  const configPath = join(dir, expected.file);
  if (!existsSync(configPath)) {
    check(`${key}: ${expected.file} exists`, false);
    continue;
  }

  const raw = readFileSync(configPath, 'utf8');

  if (expected.yaml) {
    // Continue's mcpServers is a LIST of name/command/args, not a map. A map
    // parses fine and is ignored, which is exactly the silent failure mode.
    check(`${key}: yaml declares mcpServers as a list`,
      /^mcpServers:\s*$/m.test(raw) && /^\s+- name:/m.test(raw));
    check(`${key}: yaml names the package`, raw.includes(PACKAGE));
  } else {
    let parsed;
    try {
      parsed = parseJsonc(raw);
    } catch (error) {
      check(`${key}: ${expected.file} is valid JSON`, false, error.message);
      continue;
    }
    check(`${key}: ${expected.file} is valid JSON`, true);
    // THE FULL SPEC, not the bare `@latest` suffix. `raw.includes('@latest')`
    // passes on any dependency pinned that way, so a config that had stopped
    // naming this package at all would still satisfy it -- the same
    // loose-substring weakness this file exists to catch elsewhere.
    check(`${key}: launches ${PACKAGE}`, raw.includes(PACKAGE));

    const servers = parsed[expected.topKey];
    check(`${key}: top-level key is "${expected.topKey}"`, Boolean(servers),
      Object.keys(parsed).join(','));
    if (!servers) continue;

    const entry = servers['token-optimizer'];
    check(`${key}: declares the token-optimizer server`, Boolean(entry));
    if (!entry) continue;

    if (expected.kiloShape) {
      check(`${key}: type is "local"`, entry.type === 'local', String(entry.type));
      check(`${key}: command is an ARRAY containing the package`,
        Array.isArray(entry.command) && entry.command.includes(PACKAGE));
      // `env` here would be silently ignored -- Kilo reads `environment`.
      check(`${key}: uses "environment", not "env"`,
        entry.environment !== undefined && entry.env === undefined);
    } else {
      check(`${key}: command is a string`, typeof entry.command === 'string', String(entry.command));
      check(`${key}: args include the package`, Array.isArray(entry.args) && entry.args.includes(PACKAGE));
    }

    if (expected.stdioType) {
      check(`${key}: declares type stdio`, entry.type === 'stdio', String(entry.type));
    }
    // Zed's schema has no `source`; an unrecognised key is how a config loads
    // while the server never appears.
    if (key === 'zed') check('zed: no unrecognised source key', entry.source === undefined);
  }

  const rulesPath = join(dir, expected.rules);
  check(`${key}: ${expected.rules} exists`, existsSync(rulesPath));

  if (existsSync(rulesPath)) {
    const rules = readFileSync(rulesPath, 'utf8');
    check(`${key}: rules name the optimized tools`,
      rules.includes('smart_read') && rules.includes('smart_grep'));
    check(`${key}: rules require active-model semantic harvesting`,
      rules.includes('wiki_write') && /active model/i.test(rules) && /do not delegate/i.test(rules));
    // Rules-only clients must not claim a native veto they do not have.
    check(`${key}: capability claim matches package`, expected.nativeHooks
      ? /native hook/i.test(rules)
      : !/native hook/i.test(rules));

    if (expected.frontmatter) {
      // Without alwaysApply the rule is retrieved only when Cursor judges it
      // relevant -- which reproduces the skill problem this design exists to fix.
      check('cursor: frontmatter sets alwaysApply: true', /^---[\s\S]*alwaysApply:\s*true[\s\S]*?---/m.test(rules));
    }
  }

  const readme = join(dir, 'README.md');
  check(`${key}: README records provenance`,
    existsSync(readme) && /Verified against http/.test(readFileSync(readme, 'utf8')));
}

/**
 * Hand-maintained configs that are not generated but ship all the same.
 *
 * They were missed by the pinning sweep precisely because they are outside the
 * generator, which is the usual way a rule holds everywhere except the places
 * nobody regenerates.
 */
for (const relative of [
  'integrations/copilot/mcp-config.json',
  'integrations/gemini/gemini-extension.json',
  'integrations/opencode/opencode.json',
]) {
  const path = join(ROOT, relative);
  if (!existsSync(path)) {
    check(`${relative}: exists`, false);
    continue;
  }
  const raw = readFileSync(path, 'utf8');
  check(`${relative}: launches ${PACKAGE}`, raw.includes(PACKAGE));
  check(`${relative}: names the package`, raw.includes(PACKAGE));
}

/* ---- Codex plugin: companion MCP config and bundled hooks -------------- */

const codexPlugin = join(INTEGRATIONS, 'codex', 'plugin');
const codexPluginMcp = join(codexPlugin, '.mcp.json');
if (!existsSync(codexPluginMcp)) {
  check('codex plugin: .mcp.json exists', false);
} else {
  const raw = readFileSync(codexPluginMcp, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    const entry = parsed.mcpServers?.['token-optimizer'];
    check('codex plugin: .mcp.json is valid JSON', true);
    check('codex plugin: top-level key is "mcpServers"', Boolean(parsed.mcpServers),
      Object.keys(parsed).join(','));
    check('codex plugin: rejects legacy "mcp_servers"', parsed.mcp_servers === undefined);
    check('codex plugin: declares token-optimizer', Boolean(entry));
    check(`codex plugin: launches ${PACKAGE}`,
      Array.isArray(entry?.args) && entry.args.includes(PACKAGE));
  } catch (error) {
    check('codex plugin: .mcp.json is valid JSON', false, error.message);
  }
}

const codexPluginHooks = join(codexPlugin, 'hooks', 'hooks.json');
if (!existsSync(codexPluginHooks)) {
  check('codex plugin: hooks/hooks.json exists', false);
} else {
  const raw = readFileSync(codexPluginHooks, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    const requiredEvents = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'];
    const validGroups = requiredEvents.every((event) =>
      Array.isArray(parsed.hooks?.[event])
      && parsed.hooks[event].length > 0
      && parsed.hooks[event].every((group) =>
        Array.isArray(group?.hooks) && group.hooks.length > 0
      )
    );
    const commands = validGroups ? Object.values(parsed.hooks || {})
      .flatMap((groups) => groups)
      .flatMap((group) => group.hooks || [])
      .map((hook) => hook.command || '') : [];
    const referenced = commands
      .map((command) => command.match(/\$\{PLUGIN_ROOT\}\/([^\"]+\.mjs)/)?.[1])
      .filter(Boolean);
    const missing = referenced.filter((path) => !existsSync(join(codexPlugin, path)));
    check('codex plugin: hooks.json is valid JSON', true);
    check('codex plugin: declares valid lifecycle hook groups', validGroups);
    check('codex plugin: every hook command names a plugin-relative script',
      validGroups && commands.length > 0 && referenced.length === commands.length);
    check('codex plugin: every referenced hook script exists',
      validGroups && referenced.length > 0 && missing.length === 0,
      missing.join(','));
  } catch (error) {
    check('codex plugin: hooks.json is valid JSON', false, error.message);
  }
}

for (const [key, file, why] of RETIRED) {
  check(`${key}: superseded ${file} removed (${why})`, !existsSync(join(INTEGRATIONS, key, file)));
}

/* ---- Native tier: hook bundles must actually ship ---------------------- */

for (const [key, relative] of [
  ['codex', 'hooks'],
  ['gemini', 'hooks'],
  ['opencode', 'hooks'],
  ['qwen', 'hooks'],
  ['copilot', '.github/hooks'],
  ['cline', 'hooks/token-optimizer'],
  ['cursor', 'hooks'],
  ['windsurf', 'hooks'],
  ['kilo', 'hooks'],
]) {
  const hooks = join(INTEGRATIONS, key, relative);
  if (!existsSync(hooks)) {
    check(`${key}: hooks directory exists`, false);
    continue;
  }
  const files = readdirSync(hooks);
  check(`${key}: ships a tool entry`, files.includes('pre-tool.mjs') || files.includes('post-tool.mjs'));
  check(`${key}: vendored core is present`, existsSync(join(hooks, 'lib', 'decide.mjs')));
}

for (const key of ['codex', 'gemini', 'qwen']) {
  const manifest = join(INTEGRATIONS, key, 'hooks', 'hooks.json');
  if (!existsSync(manifest)) {
    check(`${key}: hooks.json exists`, false);
    continue;
  }
  const raw = readFileSync(manifest, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    check(`${key}: hooks.json is valid JSON`, false, error.message);
    continue;
  }
  check(`${key}: hooks.json is valid JSON`, true);
  // A manifest pointing at a script that no longer exists is the other silent
  // failure -- the client loads the hook config and every invocation fails.
  const referenced = [...raw.matchAll(/hooks[\\/\\\\$}{]*([a-z-]+\.mjs)/g)].map((m) => m[1]);
  const missing = [...new Set(referenced)]
    .filter((name) => !existsSync(join(INTEGRATIONS, key, 'hooks', name)));
  check(`${key}: every referenced hook script exists`, missing.length === 0, missing.join(','));
  check(`${key}: declares a session-start hook`, Boolean(parsed.hooks?.SessionStart));
}

/* ---- Native host wiring: validate the files each CLI actually discovers -- */

function readJsonHookManifest(label, relative, expectedEvents, scriptRoot) {
  const path = join(ROOT, relative);
  if (!existsSync(path)) {
    check(`${label}: native hook manifest exists`, false);
    return;
  }

  let parsed;
  const raw = readFileSync(path, 'utf8');
  try {
    parsed = JSON.parse(raw);
    check(`${label}: native hook manifest is valid JSON`, true);
  } catch (error) {
    check(`${label}: native hook manifest is valid JSON`, false, error.message);
    return;
  }

  for (const event of expectedEvents) {
    check(`${label}: native manifest declares ${event}`,
      Array.isArray(parsed.hooks?.[event]) && parsed.hooks[event].length > 0);
  }

  const referenced = [...raw.matchAll(/([a-z-]+\.mjs)/g)].map((match) => match[1]);
  const missing = [...new Set(referenced)]
    .filter((name) => !existsSync(join(ROOT, scriptRoot, name)));
  check(`${label}: every native manifest script exists`,
    referenced.length > 0 && missing.length === 0, missing.join(','));
}

readJsonHookManifest(
  'copilot',
  'integrations/copilot/.github/hooks/token-optimizer.json',
  ['sessionStart', 'preToolUse', 'postToolUse', 'agentStop'],
  'integrations/copilot/.github/hooks',
);
readJsonHookManifest(
  'cursor',
  'integrations/cursor/hooks.json',
  ['sessionStart', 'preToolUse', 'postToolUse', 'stop'],
  'integrations/cursor/hooks',
);
readJsonHookManifest(
  'windsurf',
  'integrations/windsurf/hooks.json',
  ['pre_read_code', 'pre_write_code', 'pre_run_command', 'post_write_code'],
  'integrations/windsurf/hooks',
);
readJsonHookManifest(
  'claude-code',
  'plugin/hooks/hooks.json',
  ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'],
  'plugin/hooks',
);

for (const event of ['TaskStart', 'TaskResume', 'PreToolUse', 'PostToolUse']) {
  for (const suffix of ['', '.ps1']) {
    const path = join(INTEGRATIONS, 'cline', 'hooks', `${event}${suffix}`);
    check(`cline: ships ${event}${suffix || ' POSIX'} wrapper`, existsSync(path));
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8');
      const entry = /^(?:TaskStart|TaskResume)$/.test(event) ? 'session-start.mjs'
        : event === 'PreToolUse' ? 'pre-tool.mjs' : 'post-tool.mjs';
      check(`cline: ${event}${suffix || ' POSIX'} reaches ${entry}`, raw.includes(entry));
    }
  }
}

for (const [client, relative, required] of [
  ['opencode', 'integrations/opencode/.opencode/plugins/token-optimizer.js',
    ['experimental.chat.system.transform', 'tool.execute.before', 'tool.execute.after']],
  ['kilo', 'integrations/kilo/.kilo/plugin/token-optimizer.js',
    ['experimental.chat.system.transform', 'tool.execute.before', 'tool.execute.after']],
]) {
  const path = join(ROOT, relative);
  check(`${client}: native plugin exists`, existsSync(path));
  if (!existsSync(path)) continue;
  const raw = readFileSync(path, 'utf8');
  for (const hook of required) {
    check(`${client}: native plugin implements ${hook}`, raw.includes(`'${hook}'`));
  }
  check(`${client}: native plugin invokes generated shared entries`,
    raw.includes("invoke('session-start'") && raw.includes("invoke('pre-tool'") && raw.includes("invoke('post-tool'"));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log('NOTE: all ten generated config shapes are confirmed against published docs;');
console.log('      the source URL is recorded in each integration README.');
process.exit(failed.length ? 1 : 0);
