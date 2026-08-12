#!/usr/bin/env node
/**
 * Proves the complete live-graph path with production entry points.
 *
 * The graph and telemetry are deliberately isolated from the working repository:
 * a verifier must not improve the live balance by inserting made-up savings. The
 * controlled arm below records real read events after treated and withheld
 * touches, then asks the same report and dashboard routes used in production to
 * calculate the result.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(ROOT, 'plugin', 'hooks', 'pretooluse-router.mjs');
const temp = mkdtempSync(join(tmpdir(), 'token-optimizer-live-flow-'));
const projectA = join(temp, 'project-a');
const projectB = join(temp, 'project-b');
const shared = join(temp, 'shared');
const state = join(temp, 'state');
const wikiA = join(projectA, '.token-optimizer', 'wiki');
const anchor = join(projectA, 'src', 'test-runner.mjs');
const claim =
  'Run this ESM suite with npm test instead of bare npx jest, because bare Jest can skip the configured ESM test path.';

const originalEnv = {
  shared: process.env.TOKEN_OPTIMIZER_SHARED_DIR,
  registry: process.env.TOKEN_OPTIMIZER_PROJECT_REGISTRY,
  state: process.env.TOKEN_OPTIMIZER_STATE_DIR,
  holdout: process.env.TOKEN_OPTIMIZER_HOLDOUT,
};

let dashboard = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function runHook(payload) {
  const result = spawnSync(process.execPath, [HOOK], {
    cwd: ROOT,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_SHARED_DIR: shared,
      TOKEN_OPTIMIZER_STATE_DIR: state,
      TOKEN_OPTIMIZER_HOLDOUT: '0',
    },
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `PreToolUse hook exited ${result.status}: ${String(result.stderr).slice(0, 500)}`
    );
  }

  const output = String(result.stdout || '').trim();
  if (!output) return {};
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(
      `PreToolUse hook returned invalid JSON: ${output.slice(0, 500)}`
    );
  }
}

function additionalContext(output) {
  return output?.hookSpecificOutput?.additionalContext || '';
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  assert(port > 0, 'could not allocate an isolated dashboard port');
  return port;
}

async function waitForDashboard(base, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // The child has not begun listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`dashboard did not start at ${base}`);
}

async function stopDashboard() {
  if (!dashboard || dashboard.exitCode !== null) return;
  const exited = new Promise((resolve) => dashboard.once('exit', resolve));
  dashboard.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (dashboard.exitCode === null) dashboard.kill('SIGKILL');
}

async function main() {
  for (const project of [projectA, projectB]) {
    mkdirSync(join(project, '.git'), { recursive: true });
  }
  mkdirSync(dirname(anchor), { recursive: true });
  mkdirSync(shared, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(anchor, 'export const configuredRunner = "npm test";\n');

  process.env.TOKEN_OPTIMIZER_SHARED_DIR = shared;
  process.env.TOKEN_OPTIMIZER_PROJECT_REGISTRY = join(temp, 'projects.jsonl');
  process.env.TOKEN_OPTIMIZER_STATE_DIR = state;
  process.env.TOKEN_OPTIMIZER_HOLDOUT = '0';

  // This is the implementation behind the MCP wiki_write tool. The caller is
  // the working model; no second semantic model or transcript RAG step exists.
  const { wikiWrite } = await import(
    '../dist/tools/intelligence/wiki-write.js'
  );
  const write = await wikiWrite({
    claim,
    anchors: [anchor],
    evidence:
      'The fixture package test script exits unless Jest is launched through the documented project command.',
    applicability:
      'Use when running the fixture verification suite from this project root.',
    confidenceLabel: 'verified',
    // This verifier intentionally exercises the explicit cross-project path.
    // A normal project-specific finding remains project scoped by default.
    scope: 'global',
    invalidators: [
      'The fixture package test script or its documented verification command changes.',
    ],
    type: 'command',
    trigger: '\\bnpx\\s+jest\\b',
    confidence: 0.99,
    sessionId: 'flow-harvest-session',
    projectRoot: projectA,
  });
  assert(
    write.success && write.written === 1,
    `wiki_write failed: ${write.error || 'unknown error'}`
  );

  const { load } = await import('../hooks-core/wiki.mjs');
  const localFinding = [...load(wikiA).nodes.values()].find(
    (node) => node.kind === 'finding' && node.claim === claim
  );
  assert(
    localFinding?.origin === 'agent',
    'wiki_write did not preserve active-model provenance'
  );

  // A different session reaches for the anchor through the actual hook and is
  // given the conclusion without querying a memory or RAG system.
  const nextSession = runHook({
    session_id: 'flow-read-session',
    cwd: projectA,
    tool_name: 'Read',
    tool_input: { file_path: anchor },
  });
  const nextSessionContext = additionalContext(nextSession);
  assert(
    nextSessionContext.includes(claim),
    'a later session did not receive the finding'
  );

  // A separate repository has an empty local graph. Its production hook must
  // retrieve the portable command lesson from the machine-wide tier.
  const otherProject = runHook({
    session_id: 'flow-cross-project-session',
    cwd: projectB,
    tool_name: 'Bash',
    tool_input: { command: 'npx jest tests/unit' },
  });
  const otherProjectContext = additionalContext(otherProject);
  assert(
    otherProjectContext.includes(claim),
    'the other project did not receive the shared finding'
  );
  assert(
    otherProjectContext.includes('From other projects on this machine'),
    'cross-project provenance was not identified'
  );

  // Controlled A/B observations. Each touch has a unique session and a real
  // read event written after it, which is what report() joins in production.
  const { record, recordRead, report } = await import(
    '../hooks-core/metrics.mjs'
  );
  const base = Date.now() - 60_000;
  for (let index = 0; index < 25; index += 1) {
    const sessionId = `flow-treated-${index}`;
    record(wikiA, {
      kind: 'inject',
      surface: 'file',
      anchor,
      holdout: false,
      tokens: 100,
      sessionId,
      at: base + index,
    });
    recordRead(wikiA, { anchor, sessionId, bytes: 800 });
  }
  for (let index = 0; index < 8; index += 1) {
    const sessionId = `flow-holdout-${index}`;
    record(wikiA, {
      kind: 'inject',
      surface: 'file',
      anchor,
      holdout: true,
      tokens: 0,
      sessionId,
      at: base + 100 + index,
    });
    recordRead(wikiA, { anchor, sessionId, bytes: 8_000 });
  }
  const directBalance = report(wikiA);
  assert(
    directBalance.harvestTokens > 0,
    'successful production wiki_write did not record semantic persistence cost'
  );
  assert(
    directBalance.sufficientData,
    `balance remained insufficient: ${directBalance.verdict}`
  );
  assert(
    directBalance.netTokens > 0,
    `balance was not positive: ${directBalance.verdict}`
  );

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  dashboard = spawn(
    process.execPath,
    [join(ROOT, 'dist', 'server', 'web-server.js')],
    {
      cwd: ROOT,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        PORT: String(port),
        TOKEN_OPTIMIZER_WIKI_DIR: wikiA,
        TOKEN_OPTIMIZER_PROJECT_REGISTRY: join(temp, 'projects.jsonl'),
      },
    }
  );
  await waitForDashboard(baseUrl);

  const [pageResponse, statusResponse, searchResponse, balanceResponse] =
    await Promise.all([
      fetch(`${baseUrl}/wiki`),
      fetch(`${baseUrl}/api/wiki/status`),
      fetch(`${baseUrl}/api/wiki/search?q=configured%20ESM`),
      fetch(`${baseUrl}/api/wiki/balance`),
    ]);
  assert(pageResponse.ok, 'dashboard page did not load');
  assert(
    statusResponse.ok && searchResponse.ok && balanceResponse.ok,
    'a dashboard graph route failed'
  );

  const status = await statusResponse.json();
  const search = await searchResponse.json();
  const dashboardBalance = await balanceResponse.json();
  const dashboardFinding = search.items?.find((item) => item.claim === claim);

  assert(
    String(status.dir).replaceAll('\\', '/').toLowerCase() ===
      String(wikiA).replaceAll('\\', '/').toLowerCase(),
    `dashboard served ${status.dir}, expected ${wikiA}`
  );
  assert(status.findings >= 1, 'dashboard did not count the harvested finding');
  assert(
    dashboardFinding?.origin === 'agent',
    'dashboard did not expose active-model provenance'
  );
  assert(
    dashboardBalance.sufficientData,
    'dashboard reported insufficient balance data'
  );
  assert(
    dashboardBalance.netTokens > 0,
    'dashboard did not report a positive net balance'
  );

  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        activeModelWrite: {
          written: write.written,
          origin: dashboardFinding.origin,
          key: write.keys[0],
        },
        crossSession: {
          delivered: true,
          sessionId: 'flow-read-session',
        },
        crossProject: {
          delivered: true,
          sourceNamed: true,
          project: projectB,
        },
        dashboard: {
          page: '/wiki',
          findings: status.findings,
          graphDirectoryVerified: true,
        },
        balance: dashboardBalance,
        scope:
          'isolated controlled verification; live repository telemetry was not modified',
      },
      null,
      2
    )
  );
}

try {
  await main();
} finally {
  await stopDashboard();
  restoreEnv('TOKEN_OPTIMIZER_SHARED_DIR', originalEnv.shared);
  restoreEnv('TOKEN_OPTIMIZER_PROJECT_REGISTRY', originalEnv.registry);
  restoreEnv('TOKEN_OPTIMIZER_STATE_DIR', originalEnv.state);
  restoreEnv('TOKEN_OPTIMIZER_HOLDOUT', originalEnv.holdout);
  try {
    rmSync(temp, { recursive: true, force: true });
  } catch {
    // Windows can retain a child-process handle briefly; the OS temp cleaner
    // can recover the directory without affecting the verification result.
  }
}
