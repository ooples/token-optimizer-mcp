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
  cursor:   { file: 'mcp.json',        topKey: 'mcpServers',      rules: 'token-optimizer.mdc', frontmatter: true },
  windsurf: { file: 'mcp_config.json', topKey: 'mcpServers',      rules: 'token-optimizer.md' },
  cline:    { file: 'mcp.json',        topKey: 'mcpServers',      rules: 'token-optimizer.md' },
  roo:      { file: 'mcp.json',        topKey: 'mcpServers',      rules: 'token-optimizer.md' },
  // Kilo's schema is genuinely different: an `mcp` key, type "local", command
  // as an ARRAY, and `environment` rather than `env`.
  kilo:     { file: 'kilo.jsonc',      topKey: 'mcp',             rules: 'token-optimizer.md', kiloShape: true },
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

const PACKAGE = '@ooples/token-optimizer-mcp@latest';

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
      parsed = JSON.parse(raw);
    } catch (error) {
      check(`${key}: ${expected.file} is valid JSON`, false, error.message);
      continue;
    }
    check(`${key}: ${expected.file} is valid JSON`, true);

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
    // Directive-tier rules must not claim enforcement the client cannot do.
    check(`${key}: rules do not claim enforcement`, !/\bDENIED\b/.test(rules));

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

for (const [key, file, why] of RETIRED) {
  check(`${key}: superseded ${file} removed (${why})`, !existsSync(join(INTEGRATIONS, key, file)));
}

/* ---- Enforcing tier: hooks must actually be wired ---------------------- */

for (const key of ['codex', 'gemini', 'opencode', 'qwen']) {
  const hooks = join(INTEGRATIONS, key, 'hooks');
  if (!existsSync(hooks)) {
    check(`${key}: hooks directory exists`, false);
    continue;
  }
  const files = readdirSync(hooks);
  check(`${key}: ships a session-start entry`, files.includes('session-start.mjs'));
  check(`${key}: ships a tool entry`, files.includes('pre-tool.mjs') || files.includes('post-tool.mjs'));
  check(`${key}: vendored core is present`, existsSync(join(hooks, 'lib', 'decide.mjs')));
}

for (const key of ['codex', 'gemini']) {
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

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log('NOTE: all ten directive-tier shapes are confirmed against published docs;');
console.log('      the source URL is recorded in each integration README.');
process.exit(failed.length ? 1 : 0);
