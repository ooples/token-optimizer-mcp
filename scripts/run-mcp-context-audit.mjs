#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UCR_CLIENT_REGISTRY,
  canonicalJson,
  createTiktokenCounter,
  sha256,
} from '../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'dist', 'server', 'index.js');
const OUTPUT = join(
  ROOT,
  'evals',
  'ucr',
  'results',
  'mcp-context-audit-v1.json'
);
const temporary = mkdtempSync(join(tmpdir(), 'ucr-mcp-context-audit-'));
const tokenCounter = createTiktokenCounter('cl100k_base');

function listTools(profile, arm = 'full') {
  const messages = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'context-audit', version: '1.0.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ];
  const stateRoot = join(temporary, `${profile}-${arm}`);
  const result = spawnSync(process.execPath, [SERVER], {
    cwd: temporary,
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_TOOL_PROFILE: profile,
      TOKEN_OPTIMIZER_EXPERIMENT_ARM: arm,
      TOKEN_OPTIMIZER_CACHE_DIR: join(stateRoot, 'cache'),
      TOKEN_OPTIMIZER_WIKI_DIR: join(stateRoot, 'wiki'),
      TOKEN_OPTIMIZER_STATE_DIR: join(stateRoot, 'state'),
    },
    input: `${messages.map(JSON.stringify).join('\n')}\n`,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.status !== 0)
    throw new Error(
      `tools/list failed for ${profile}/${arm}: ${result.stderr}`
    );
  const responses = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return responses.find((response) => response.id === 2)?.result?.tools || [];
}

try {
  const configurations = [
    ['baseline', 'core', 'baseline'],
    ['attestation', 'attestation', 'full'],
    ['cognitive', 'cognitive', 'full'],
    ['core', 'core', 'full'],
    ['full', 'full', 'full'],
  ];
  const surfaces = configurations.map(([name, profile, arm]) => {
    const tools = listTools(profile, arm);
    const serialized = canonicalJson(tools);
    return {
      name,
      profile,
      arm,
      tools: tools.length,
      toolNames: tools.map((tool) => tool.name),
      schemaBytes: Buffer.byteLength(serialized),
      schemaTokens: tokenCounter.count(tools),
      tokenAccounting: tokenCounter.method,
    };
  });
  const full = surfaces.find((surface) => surface.name === 'full');
  const enriched = surfaces.map((surface) => ({
    ...surface,
    reductionVsFull:
      full.schemaTokens > 0
        ? 1 - surface.schemaTokens / full.schemaTokens
        : null,
    shareOf128kContext: surface.schemaTokens / 128_000,
    shareOf1mContext: surface.schemaTokens / 1_000_000,
  }));
  const cognitive = enriched.find((surface) => surface.name === 'cognitive');
  const attestation = enriched.find(
    (surface) => surface.name === 'attestation'
  );
  const core = enriched.find((surface) => surface.name === 'core');
  const body = {
    schemaVersion: 'ucr.mcp-context-audit/1',
    evidenceClass:
      'native-tokenized-real-tools-list-conformance-not-model-effectiveness',
    executedAt: new Date().toISOString(),
    serverSourceHash: sha256([
      readFileSync(join(ROOT, 'src', 'server', 'index.ts'), 'utf8'),
      readFileSync(join(ROOT, 'src', 'server', 'ucr-tools.ts'), 'utf8'),
      readFileSync(join(ROOT, 'src', 'server', 'tool-profile.ts'), 'utf8'),
    ]),
    surfaces: enriched,
    findings: {
      defaultProfile: 'core',
      graphCaptureProfile: 'cognitive',
      graphCaptureTools: cognitive.tools,
      attestationProfile: 'attestation',
      attestationTools: attestation.tools,
      attestationSchemaTokens: attestation.schemaTokens,
      fullCatalogTools: full.tools,
      graphCaptureSchemaTokens: cognitive.schemaTokens,
      defaultCoreSchemaTokens: core.schemaTokens,
      fullCatalogSchemaTokens: full.schemaTokens,
      graphCaptureReductionVsFull: cognitive.reductionVsFull,
      graphCaptureReductionVsCore:
        1 - cognitive.schemaTokens / core.schemaTokens,
      appliesToRegisteredClients: Object.keys(UCR_CLIENT_REGISTRY).length,
      userMcpServersAreAdditive:
        'Every enabled MCP server adds its own tool schemas and instructions; client isolation must disable unrelated servers during evals.',
    },
    passed:
      attestation.tools === 1 &&
      cognitive.tools === 5 &&
      full.tools === 103 &&
      attestation.schemaTokens < cognitive.schemaTokens &&
      cognitive.schemaTokens < core.schemaTokens &&
      core.schemaTokens < full.schemaTokens,
    limitations: [
      'tool-schema tokens are deterministic startup context, not total provider prompt tokens',
      'client hosts may add wrappers, instructions, resources, or other MCP servers beyond this server response',
      'model effectiveness and empty-session p95 overhead require paired live provider runs',
    ],
  };
  const report = { ...body, reportHash: sha256(body) };
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    canonicalJson({
      output: OUTPUT,
      passed: report.passed,
      findings: report.findings,
    })
  );
  if (!report.passed) process.exitCode = 1;
} finally {
  tokenCounter.close();
  rmSync(temporary, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
