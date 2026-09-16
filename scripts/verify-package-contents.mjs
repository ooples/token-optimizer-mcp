#!/usr/bin/env node
/** Check the npm file list, not just files available in the source checkout. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.env.npm_execpath;
if (!npm) throw Error('Run with npm run verify:package-contents');
const [pack] = JSON.parse(
  execFileSync(
    process.execPath,
    [npm, 'pack', '--dry-run', '--ignore-scripts', '--json'],
    { cwd: root, encoding: 'utf8', windowsHide: true }
  )
);
const files = new Set(pack.files.map((file) => file.path));
const runtimeArtifact =
  /(?:^|\/)(?:logs|\.cache|\.token-optimizer)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:log|tmp|temp|db(?:-[^/]*)?|sqlite3?(?:-[^/]*)?)$|(?:^|\/)\.token-optimizer-edit-.*\.lock$/i;
for (const path of files)
  assert.ok(
    !runtimeArtifact.test(path),
    `npm package includes runtime artifact ${path}`
  );
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const gemini = JSON.parse(
  readFileSync(join(root, 'gemini-extension.json'), 'utf8')
);
const required = [
  'scripts/opencode-plugin.mjs',
  'scripts/session-routing.mjs',
  'dist/proxy/chat-completions.js',
  ...Object.values(pkg.bin).map((path) => path.replace(/^\.\//, '')),
  'gemini-extension.json',
  gemini.contextFileName,
  'hooks/hooks.json',
  'integrations/gemini/hooks/session-start.mjs',
  'integrations/gemini/hooks/pre-tool.mjs',
  'integrations/gemini/hooks/post-tool.mjs',
  'integrations/gemini/hooks/stop.mjs',
  'plugin/.claude-plugin/plugin.json',
  'plugin/.mcp.json',
  'plugin/launch.mjs',
  'plugin/hooks/hooks.json',
  'integrations/codex/plugin/.codex-plugin/plugin.json',
  'integrations/codex/plugin/.mcp.json',
  'integrations/codex/plugin/hooks/hooks.json',
];
for (const path of required)
  assert.ok(files.has(path), `npm package omits ${path}`);
console.log(
  `Package ${pack.name}@${pack.version}: ${required.length} required entrypoints and client assets present (${files.size} files).`
);
