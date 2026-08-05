#!/usr/bin/env node
/**
 * Keeps the pinned MCP spec in the HAND-MAINTAINED configs matching package.json.
 *
 * The generated configs get their pin from the generator, but several configs
 * are hand-written and ship all the same -- Copilot, the Gemini extension,
 * OpenCode, the Codex TOML and the Claude plugin's .mcp.json. They were the
 * ones still floating on `@latest` after the pinning sweep, precisely because
 * nothing regenerates them. This closes that gap so a release cannot leave half
 * the clients pinned to an old version and half floating.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const SPEC = `@ooples/token-optimizer-mcp@${version}`;

const TARGETS = [
  'integrations/copilot/mcp-config.json',
  'integrations/gemini/gemini-extension.json',
  'integrations/opencode/opencode.json',
  'integrations/codex/config.toml',
  'integrations/codex/plugin/.mcp.json',
  'plugin/.mcp.json',
  'mcp.json',
  'server.json',
  'gemini-extension.json',
];

const check = process.argv.includes('--check');
let changed = 0;

for (const relative of TARGETS) {
  const path = join(ROOT, relative);
  if (!existsSync(path)) continue;

  const before = readFileSync(path, 'utf8');
  const after = before.replace(/@ooples\/token-optimizer-mcp@[^"'\s,\]]+/g, SPEC);
  if (before === after) continue;

  if (check) {
    console.error(`DRIFT: ${relative} does not pin ${SPEC}`);
    changed++;
    continue;
  }
  writeFileSync(path, after);
  changed++;
}

if (check && changed > 0) {
  console.error(`\n${changed} config(s) are not pinned to ${version}. Run: npm run sync:hooks`);
  process.exit(1);
}

console.log(check ? `mcp version pinned to ${version} everywhere` : `pinned ${changed} config(s) to ${version}`);
