#!/usr/bin/env node
/** Structured, capability-tiered certification for every supported CLI. */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLIENT_CAPABILITIES,
  CAPABILITY_TIERS,
} from '../hooks-core/capabilities.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PACKAGED_SURFACES = {
  'claude-code': [
    'plugin/hooks/hooks.json',
    'plugin/hooks/pretooluse-router.mjs',
    'plugin/hooks/stop.mjs',
  ],
  codex: [
    'integrations/codex/hooks/hooks.json',
    'integrations/codex/hooks/pre-tool.mjs',
    'integrations/codex/hooks/stop.mjs',
  ],
  copilot: [
    'integrations/copilot/.github/hooks/token-optimizer.json',
    'integrations/copilot/.github/hooks/pre-tool.mjs',
  ],
  gemini: [
    'gemini-extension.json',
    'hooks/hooks.json',
    'integrations/gemini/hooks/hooks.json',
    'integrations/gemini/hooks/pre-tool.mjs',
    'integrations/gemini/hooks/stop.mjs',
  ],
  qwen: [
    'integrations/qwen/hooks/hooks.json',
    'integrations/qwen/hooks/pre-tool.mjs',
    'integrations/qwen/hooks/stop.mjs',
  ],
  cursor: [
    'integrations/cursor/hooks.json',
    'integrations/cursor/hooks/pre-tool.mjs',
    'integrations/cursor/hooks/stop.mjs',
  ],
  cline: [
    'integrations/cline/hooks/PreToolUse',
    'integrations/cline/hooks/PostToolUse',
    'integrations/cline/token-optimizer.md',
  ],
  opencode: [
    'integrations/opencode/.opencode/plugins/token-optimizer.js',
    'integrations/opencode/hooks/pre-tool.mjs',
  ],
  kilo: [
    'integrations/kilo/.kilo/plugin/token-optimizer.js',
    'integrations/kilo/hooks/pre-tool.mjs',
  ],
  windsurf: [
    'integrations/windsurf/hooks.json',
    'integrations/windsurf/hooks/pre-tool.mjs',
  ],
  roo: ['integrations/roo/mcp.json', 'integrations/roo/token-optimizer.md'],
  zed: ['integrations/zed/settings.json', 'integrations/zed/AGENTS.md'],
  amp: ['integrations/amp/settings.json', 'integrations/amp/AGENTS.md'],
  continue: [
    'integrations/continue/config.yaml',
    'integrations/continue/token-optimizer.md',
  ],
  crush: ['integrations/crush/crush.json', 'integrations/crush/AGENTS.md'],
  droid: ['integrations/droid/mcp.json', 'integrations/droid/AGENTS.md'],
};

const ENFORCEMENT_SURFACES = {
  'claude-code': 'plugin/hooks/pretooluse-router.mjs',
  codex: 'integrations/codex/hooks/pre-tool.mjs',
  copilot: 'integrations/copilot/.github/hooks/pre-tool.mjs',
  gemini: 'integrations/gemini/hooks/pre-tool.mjs',
  qwen: 'integrations/qwen/hooks/pre-tool.mjs',
  cursor: 'integrations/cursor/hooks/pre-tool.mjs',
  cline: 'integrations/cline/hooks/token-optimizer/pre-tool.mjs',
  opencode: 'integrations/opencode/.opencode/plugins/token-optimizer.js',
  kilo: 'integrations/kilo/.kilo/plugin/token-optimizer.js',
  windsurf: 'integrations/windsurf/hooks/pre-tool.mjs',
  roo: 'integrations/roo/token-optimizer.md',
  zed: 'integrations/zed/AGENTS.md',
  amp: 'integrations/amp/AGENTS.md',
  continue: 'integrations/continue/token-optimizer.md',
  crush: 'integrations/crush/AGENTS.md',
  droid: 'integrations/droid/AGENTS.md',
};

function enforcementSurfaceIsValid(client, capability, relative) {
  if (!relative) return false;
  const path = join(ROOT, relative);
  if (!existsSync(path)) return false;
  const source = readFileSync(path, 'utf8');

  if (!capability.canDeny) {
    return (
      /\bMUST use\b/.test(source) &&
      /mandatory routing policy, not a preference/i.test(source)
    );
  }

  if (client === 'claude-code') {
    return (
      source.includes('optimizerToolsForHook') &&
      source.includes('decide(') &&
      source.includes('enforce(')
    );
  }
  if (client === 'opencode' || client === 'kilo') {
    return source.includes("invoke('pre-tool'");
  }
  return source.includes(`await run('${client}', 'pre-tool')`);
}

const BINARIES = {
  'claude-code': 'claude',
  codex: 'codex',
  copilot: 'copilot',
  gemini: 'gemini',
  qwen: 'qwen',
  cursor: 'cursor-agent',
  cline: 'cline',
  opencode: 'opencode',
  kilo: 'kilo',
  windsurf: 'windsurf',
  roo: 'roo',
  zed: 'zed',
  amp: 'amp',
  continue: 'cn',
  crush: 'crush',
  droid: 'droid',
};

function versionOf(binary) {
  try {
    const result = spawnSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      shell: false,
    });
    if (result.error || result.status !== 0) return null;
    return (
      `${result.stdout || result.stderr}`.trim().split('\n')[0].slice(0, 300) ||
      null
    );
  } catch {
    return null;
  }
}

export function certificationReport({ detectVersions = true } = {}) {
  const clients = Object.entries(CLIENT_CAPABILITIES).map(
    ([client, capability]) => {
      const files = PACKAGED_SURFACES[client] || [];
      const missing = files.filter(
        (relative) => !existsSync(join(ROOT, relative))
      );
      const version = detectVersions ? versionOf(BINARIES[client]) : null;
      const protocolCertified = files.length > 0 && missing.length === 0;
      const enforcementSurface = ENFORCEMENT_SURFACES[client] || null;
      const enforcementContract = capability.canDeny
        ? 'native-pre-execution-veto'
        : 'mandatory-always-on-rules';
      const enforcementCertified = enforcementSurfaceIsValid(
        client,
        capability,
        enforcementSurface
      );
      return {
        client,
        name: capability.name,
        tier: capability.tier,
        promisedCapture: capability.structuralCapture,
        semanticHarvest: capability.semanticHarvest,
        protocolCertified,
        enforcementContract,
        enforcementCertified,
        enforcementSurface,
        checkedFiles: files,
        missing,
        installedVersion: version,
        liveStatus: !detectVersions
          ? 'version detection not requested'
          : version
            ? 'installed version detected; run the live evidence suite for causal certification'
            : 'protocol-only; exact CLI not detected on this machine',
        continuationGuaranteed:
          capability.tier === CAPABILITY_TIERS.CONTINUATION,
      };
    }
  );
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    protocolPassed: clients.filter((client) => client.protocolCertified).length,
    enforcementPassed: clients.filter((client) => client.enforcementCertified)
      .length,
    total: clients.length,
    liveVersionsDetected: clients.filter((client) => client.installedVersion)
      .length,
    clients,
    note: 'Protocol and enforcement certification prove packaged wiring and default routing policy. Only randomized live eval runs prove model effectiveness.',
  };
}

const args = process.argv.slice(2);
const report = certificationReport({
  detectVersions: !args.includes('--no-version-check'),
});
if (args.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  for (const client of report.clients) {
    const protocol = client.protocolCertified ? 'PASS' : 'FAIL';
    const enforcement = client.enforcementCertified ? 'PASS' : 'FAIL';
    const live =
      client.installedVersion ||
      (args.includes('--no-version-check')
        ? 'version not checked'
        : 'not installed');
    process.stdout.write(
      `${protocol}/${enforcement} ${client.name} [${client.tier}] — ${live}\n`
    );
    if (client.missing.length)
      process.stdout.write(`  missing: ${client.missing.join(', ')}\n`);
    if (!client.enforcementCertified)
      process.stdout.write(
        `  invalid enforcement surface: ${client.enforcementSurface || 'missing'}\n`
      );
  }
  process.stdout.write(
    `${report.protocolPassed}/${report.total} protocol and ${report.enforcementPassed}/${report.total} enforcement certifications passed; ${report.liveVersionsDetected} exact CLI versions detected\n`
  );
}

const requireLiveArg = args.indexOf('--require-live');
const requiredLive =
  requireLiveArg >= 0
    ? new Set(
        String(args[requireLiveArg + 1] || '')
          .split(',')
          .filter(Boolean)
      )
    : new Set();
const missingRequiredLive = report.clients.filter(
  (client) => requiredLive.has(client.client) && !client.installedVersion
);
if (
  report.protocolPassed !== report.total ||
  report.enforcementPassed !== report.total ||
  missingRequiredLive.length
)
  process.exit(1);
