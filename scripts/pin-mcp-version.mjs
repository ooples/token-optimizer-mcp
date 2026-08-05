#!/usr/bin/env node
/**
 * Keeps every client config on one MCP spec: `@latest`.
 *
 * WHY NOT THE EXACT VERSION. It used to write package.json's version into nine
 * configs, which made "the configs match package.json" an invariant that CANNOT
 * hold: release-please bumps package.json, so the configs are wrong the instant a
 * release starts, and every fix to the machinery that repaired them was itself a
 * release. Four releases were burned before one published.
 *
 * It also failed at the job it was added for. Pinning was meant to stop plugin and
 * server drifting apart; a pin that lags does the opposite. Measured from the
 * installed plugin cache on a real machine:
 *
 *     plugin 5.3.6.pre-refresh  spawns server 5.3.2
 *     plugin 5.4.0              spawns server 5.3.6   <- a downgrade
 *
 * Only 5.3.6 ever matched itself. `@latest` cannot produce that.
 *
 * `@latest` is also what the ecosystem does. Microsoft's official Playwright MCP
 * ships `npx @playwright/mcp@latest`; GitHub's official MCP carries no version at
 * all (it is a remote endpoint); and this project itself shipped `@latest` at 5.0.2,
 * before the pinning sweep introduced the drift.
 *
 * The invariant is now version-independent, so there is nothing left to keep in
 * step: no release-PR sync, no repair step, no drift.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = '@ooples/token-optimizer-mcp@latest';

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
  console.error(`\n${changed} config(s) do not use ${SPEC}. Run: npm run sync:hooks`);
  process.exit(1);
}

console.log(
  check ? `every config uses ${SPEC}` : `set ${changed} config(s) to ${SPEC}`
);
