#!/usr/bin/env node
/**
 * Drives the wiki graph browser in a real headless Chromium and checks the
 * things a validator cannot.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE UNIT TESTS: the palette validator checks
 * colour, and the API tests check data. Neither can see a label collision, a
 * body that scrolls sideways, an SVG that renders zero nodes because the
 * viewport had no height when the layout ran, or a console error that only
 * fires in a browser. Those are the failures that make a page look broken to
 * the person who opens it, and the only way to catch them is to open it.
 *
 * Run: node scripts/verify-wiki-ui.mjs
 * Exits non-zero on any failed check, so CI can gate on it.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  cpSync,
  mkdtempSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'artifacts', 'wiki-ui');
const evidenceIndex = JSON.parse(
  readFileSync(
    join(ROOT, 'evals', 'ucr', 'results', 'evidence-index-v2.json'),
    'utf8'
  )
);
const expectedArtifactCount = evidenceIndex.artifacts.length;
/**
 * An isolated port, chosen at random and asserted free.
 *
 * The script previously assumed 3100. A server left running from an earlier
 * session kept answering there, so the freshly spawned one silently failed to
 * bind and the whole verification ran against a stale build -- passing or
 * failing for reasons unrelated to the code under test.
 */
const PORT = 3100 + Math.floor(Math.random() * 400) + 1;
const BASE = `http://localhost:${PORT}`;
/**
 * A THROWAWAY graph, never the repository's own.
 *
 * This pointed at <repo>/.token-optimizer/wiki -- the live graph for this
 * project -- and deleted it on entry and again in the `finally`. Running the UI
 * verification would have destroyed a developer's accumulated findings without
 * warning. wikiDir() honours TOKEN_OPTIMIZER_WIKI_DIR ahead of the cwd default,
 * so the server can be pointed at a temp directory instead.
 */
const GRAPH = mkdtempSync(join(tmpdir(), 'wiki-ui-graph-'));
process.env.TOKEN_OPTIMIZER_WIKI_DIR = GRAPH;
process.env.TOKEN_OPTIMIZER_SHARED_DIR = GRAPH;
process.env.TOKEN_OPTIMIZER_PROJECT_REGISTRY = join(GRAPH, 'projects.jsonl');
const UCR = mkdtempSync(join(tmpdir(), 'wiki-ui-ucr-'));
process.env.TOKEN_OPTIMIZER_UCR_DIR = UCR;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(
    `${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`
  );
};

/** A graph with enough shape to exercise every view. */
async function seed() {
  const { putNode, putEdge, nodeId } = await import('../hooks-core/wiki.mjs');
  const { indexFile } = await import('../hooks-core/staleness.mjs');
  const { record } = await import('../hooks-core/metrics.mjs');
  const ucr = await import('../ucr/index.mjs');

  const store = new ucr.EventStore(UCR);
  const clock = new ucr.HybridLogicalClock('dashboard-writer');
  store.append(
    ucr.createEvent({
      type: 'finding.activated',
      payload: {
        object: {
          id: 'claim:dashboard',
          type: 'claim',
          state: 'active',
          confidence: 0.99,
          claim: 'Dashboard UCR fixture',
          applicability: ['dashboard verification'],
        },
      },
      traceId: 'dashboard-trace',
      writer: { id: 'dashboard-writer', sequence: 0 },
      actor: {
        agentId: 'dashboard-agent',
        client: 'codex',
        capabilityTier: 'continuable',
      },
      scope: {
        sessionId: 'dashboard',
        projectId: 'dashboard',
        workspaceId: 'dashboard',
      },
      clock,
    })
  );
  // Exercise the honest initial state. Deterministic UI fixtures cannot make a
  // live-model release verdict pass.
  const metrics = { writerIntegrity: true };
  writeFileSync(
    join(UCR, 'release-evidence.json'),
    JSON.stringify({
      metrics,
      verdict: ucr.releaseVerdict(metrics),
    })
  );

  const src = join(GRAPH, 'demo-src');
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, 'auth.ts'),
    'export function verify(token) {\n  return token.exp > Date.now();\n}\n\nexport class Session {\n  refresh() { return true; }\n}\n'
  );
  writeFileSync(
    join(src, 'cache.ts'),
    'export function evict(key) {\n  return key;\n}\n'
  );

  indexFile(GRAPH, join(src, 'auth.ts'));
  indexFile(GRAPH, join(src, 'cache.ts'));

  const seeds = [
    [
      'f1',
      'verify() compares exp against the local clock, so clock skew on the node causes spurious 401s for valid tokens',
      0.92,
      'finding',
      'auth.ts',
    ],
    [
      'f2',
      'tried a single shared retry budget across all hosts; it deadlocked under burst load because slow hosts starved fast ones',
      0.88,
      'failure',
      'cache.ts',
    ],
    ['f3', 'the cache is write-back', 0.55, 'finding', 'cache.ts'],
    ['f4', 'the cache is write-through', 0.55, 'finding', 'cache.ts'],
    [
      'f5',
      'chose per-host retry budgets over a global one; rejected global because of the deadlock above',
      0.9,
      'decision',
      'cache.ts',
    ],
    [
      'f6',
      'Session.refresh() is never called from the request path, only from the background sweeper',
      0.8,
      'map',
      'auth.ts',
    ],
    // Below the 0.4 audit threshold on purpose, so the low-confidence group is
    // actually exercised rather than silently empty.
    [
      'f7',
      'evict() may be reentrant, but this was not confirmed',
      0.25,
      'finding',
      'cache.ts',
    ],
  ];

  const ids = {};
  for (const [key, claim, confidence, type, file] of seeds) {
    ids[key] = putNode(GRAPH, {
      kind: 'finding',
      key,
      claim,
      confidence,
      type,
    });
    putEdge(GRAPH, ids[key], 'derived_from', nodeId('file', join(src, file)));
  }
  // A contradiction, so the audit tab has something real to surface.
  putEdge(GRAPH, ids.f3, 'contradicts', ids.f4);

  for (let i = 0; i < 25; i++)
    record(GRAPH, {
      kind: 'inject',
      holdout: false,
      tokens: 120,
      downstream: 300,
    });
  for (let i = 0; i < 8; i++)
    record(GRAPH, {
      kind: 'inject',
      holdout: true,
      tokens: 0,
      downstream: 2400,
    });
  record(GRAPH, { kind: 'harvest', tokens: 800 });
  for (let pair = 1; pair <= 5; pair++) {
    for (const [arm, totalTokens, toolCalls] of [
      ['baseline', 1000, 10],
      ['optimizer', 900, 9],
      ['retrieval', 750, 7],
      ['full', 600, 6],
    ]) {
      record(GRAPH, {
        kind: 'eval-run',
        pairId: `ui-${pair}`,
        taskId: 'ui-recovery',
        arm,
        client: 'codex',
        clientVersion: 'ui-fixture',
        model: 'fixture-model',
        modelVersion: '1',
        correct: true,
        totalTokens,
        toolCalls,
        latencyMs: totalTokens,
      });
    }
  }
  for (let pair = 1; pair <= 10; pair++) {
    for (const arm of ['empty', 'natural', 'oracle', 'irrelevant', 'stale']) {
      const prevented = ['natural', 'oracle'].includes(arm);
      record(GRAPH, {
        kind: 'handoff-run',
        pairId: `ui-handoff-${pair}`,
        scenarioId: 'verification-entry-point',
        arm,
        producer: {
          client: 'codex',
          model: 'gpt-5.6-sol',
          captureSuccess: true,
        },
        consumer: {
          client: 'claude-code',
          model: 'claude-sonnet-5',
          correct: true,
          firstPass: prevented,
          mistakeAttempted: !prevented,
          mistakeExecuted: !prevented,
          totalTokens: prevented ? 800 : 1000,
          toolCalls: prevented ? 5 : 7,
          failedToolCalls: prevented ? 0 : 1,
        },
        delivery: { beforeFirstExecutedMistake: arm === 'natural' },
      });
    }
  }
  for (const arm of ['empty', 'natural']) {
    record(GRAPH, {
      kind: 'concurrency-run',
      pairId: 'ui-concurrent-1',
      arm,
      writerCount: 3,
      captureSuccesses: 3,
      integrity: { zeroLoss: true, parseable: true, orphanedFindings: 0 },
      delivery: {
        expected: arm === 'natural' ? 3 : 0,
        delivered: arm === 'natural' ? 3 : 0,
      },
      consumer: {
        client: 'claude-code',
        model: 'claude-sonnet-5',
        correct: arm === 'empty',
        firstPass: false,
        mistakeAttempted: true,
        mistakeExecuted: true,
      },
    });
  }
}

async function waitForServer(attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(`${BASE}/api/wiki/status`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Copies the dashboard assets into dist before launching.
 *
 * The server serves from dist/, not src/. Without this the script cheerfully
 * verifies the PREVIOUS build and reports whatever the last one did -- which is
 * worse than not running it, because it produces a confident pass on code that
 * is not the code under test. (Learned the direct way: a CSS fix appeared not
 * to work for a full run because dist still held the old file.)
 */
function syncAssets() {
  cpSync(
    join(ROOT, 'src', 'dashboard', 'public'),
    join(ROOT, 'dist', 'dashboard', 'public'),
    { recursive: true }
  );
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  syncAssets();
  await seed();

  const server = spawn(
    process.execPath,
    [join(ROOT, 'dist', 'server', 'web-server.js')],
    {
      cwd: ROOT,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, PORT: String(PORT) },
    }
  );

  if (!(await waitForServer())) {
    console.error(`server never came up on ${BASE}`);
    server.kill();
    process.exit(1);
  }

  // Prove we are talking to OUR server against OUR graph, not something that
  // was already listening. Without this the run can pass against a stale build.
  const status = await (await fetch(`${BASE}/api/wiki/status`)).json();
  if (status.dir !== GRAPH) {
    console.error(`server is serving ${status.dir}, expected ${GRAPH}`);
    server.kill();
    process.exit(1);
  }

  const browser = await chromium.launch();
  const consoleErrors = [];

  try {
    for (const [label, width, height] of [
      ['desktop', 1440, 900],
      ['narrow', 700, 900],
    ]) {
      const page = await browser.newPage({ viewport: { width, height } });
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(`${label}: ${m.text()}`);
      });
      page.on('pageerror', (e) => consoleErrors.push(`${label}: ${e.message}`));

      await page.goto(`${BASE}/wiki`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.wiki-list li', { timeout: 10_000 });

      // A page body that scrolls sideways is the single most common layout
      // defect, and it is invisible to every check that is not a browser.
      const overflow = await page.evaluate(() => {
        const el = document.scrollingElement;
        return { scroll: el.scrollWidth, client: el.clientWidth };
      });
      check(
        `${label}: no horizontal page scroll`,
        overflow.scroll <= overflow.client + 1,
        `${overflow.scroll} vs ${overflow.client}`
      );
      if (label === 'narrow') {
        const splitTracks = await page
          .locator('.wiki-split')
          .evaluate((split) =>
            getComputedStyle(split).gridTemplateColumns.trim().split(/\s+/)
          );
        check(
          'narrow: knowledge layout stacks into one column',
          splitTracks.length === 1,
          splitTracks.join(' | ')
        );
      }

      if (label === 'desktop') {
        const stats = await page.textContent('#graph-stats');
        check(
          'status line reports the graph',
          /\d+ findings/.test(stats || ''),
          stats?.trim()
        );

        const tiles = await page.$$eval('#balance-grid .stat-value', (els) =>
          els.map((e) => e.textContent.trim())
        );
        check(
          'balance renders four figures',
          tiles.length === 4,
          tiles.join(' | ')
        );

        const method = await page.textContent('#balance-method');
        // The claim that separates this from every competitor's estimate.
        check(
          'balance states the control-arm method',
          /control/i.test(method || '') && /not estimated/i.test(method || '')
        );

        const verdictState = await page.getAttribute(
          '#balance-verdict',
          'data-state'
        );
        check(
          'verdict is classified',
          ['positive', 'negative', 'insufficient'].includes(verdictState),
          verdictState
        );

        const auditCount = await page.textContent('#audit-count');
        check(
          'audit badge counts the contradiction',
          Number(auditCount) >= 2,
          auditCount
        );

        // The default view is a real, navigable 3D projection. A previous test
        // only counted SVG nodes, so a flat and nearly blank graph passed.
        await page.waitForFunction(
          () =>
            Number(document.querySelector('#wiki-graph-3d')?.dataset.frame) > 0,
          null,
          { timeout: 5000 }
        );
        const graph3d = await page.evaluate(() => {
          const host = document.getElementById('wiki-graph-3d');
          const canvas = host.querySelector('canvas');
          const context = canvas.getContext('2d');
          const pixels = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height
          ).data;
          const colours = new Set();
          for (let index = 0; index < pixels.length; index += 256) {
            colours.add(
              `${pixels[index]},${pixels[index + 1]},${pixels[index + 2]}`
            );
          }
          const projected = host.__knowledgeGraph3d.projectedNodes();
          const xs = projected.map((node) => node.x);
          const ys = projected.map((node) => node.y);
          return {
            renderer: host.dataset.renderer,
            nodes: Number(host.dataset.nodes),
            edges: Number(host.dataset.edges),
            frame: Number(host.dataset.frame),
            colours: colours.size,
            spread:
              projected.length < 2
                ? 0
                : Math.max(
                    Math.max(...xs) - Math.min(...xs),
                    Math.max(...ys) - Math.min(...ys)
                  ),
          };
        });
        check(
          '3D graph uses the perspective renderer',
          graph3d.renderer === 'perspective-3d',
          graph3d.renderer
        );
        check(
          '3D graph renders real nodes',
          graph3d.nodes > 0,
          `${graph3d.nodes} nodes`
        );
        check(
          '3D graph renders real edges',
          graph3d.edges > 0,
          `${graph3d.edges} edges`
        );
        check(
          '3D graph paints a non-blank scene',
          graph3d.colours > 8,
          `${graph3d.colours} sampled colours`
        );
        check(
          '3D projection spreads nodes through the scene',
          graph3d.spread > 60,
          `${Math.round(graph3d.spread)}px extent`
        );

        const graphCanvas = page.locator(
          '#wiki-graph-3d .knowledge-graph-canvas'
        );
        check(
          '3D graph exposes an interactive accessibility role',
          (await graphCanvas.getAttribute('role')) === 'application'
        );
        await graphCanvas.focus();
        await page.keyboard.press('Alt+ArrowRight');
        const keyboardSelection = await page
          .locator('#wiki-graph-3d')
          .getAttribute('data-selected');
        check(
          'keyboard selection moves to a 3D node',
          Boolean(keyboardSelection),
          keyboardSelection || ''
        );
        await page.keyboard.press('Enter');
        await page.waitForSelector('#wiki-detail:not([hidden])');
        check(
          'keyboard selection opens the node record',
          await page.isVisible('#wiki-detail')
        );
        await page.click('#detail-close');

        const graphHost = page.locator('#wiki-graph-3d');
        await graphHost.scrollIntoViewIfNeeded();
        const graphBox = await graphHost.boundingBox();
        const yawBefore = Number(await graphHost.getAttribute('data-yaw'));
        const zoomBefore = Number(await graphHost.getAttribute('data-zoom'));
        await page.mouse.move(
          graphBox.x + graphBox.width * 0.35,
          graphBox.y + graphBox.height * 0.52
        );
        await page.mouse.down();
        await page.mouse.move(
          graphBox.x + graphBox.width * 0.64,
          graphBox.y + graphBox.height * 0.34,
          { steps: 10 }
        );
        await page.mouse.up();
        await page.mouse.move(
          graphBox.x + graphBox.width / 2,
          graphBox.y + graphBox.height / 2
        );
        await page.mouse.wheel(0, -360);
        await page.waitForTimeout(200);
        const yawAfter = Number(await graphHost.getAttribute('data-yaw'));
        const zoomAfter = Number(await graphHost.getAttribute('data-zoom'));
        check(
          'dragging orbits the 3D camera',
          Math.abs(yawAfter - yawBefore) > 0.2,
          `${yawBefore.toFixed(2)} -> ${yawAfter.toFixed(2)}`
        );
        check(
          'scrolling zooms the 3D camera',
          zoomAfter > zoomBefore,
          `${zoomBefore.toFixed(2)} -> ${zoomAfter.toFixed(2)}`
        );

        await page.click('#wiki-graph-3d .graph-3d-reset');
        await page.waitForTimeout(100);
        const target = await page.evaluate(
          () =>
            document
              .getElementById('wiki-graph-3d')
              .__knowledgeGraph3d.projectedNodes()[0]
        );
        await page.mouse.click(graphBox.x + target.x, graphBox.y + target.y);
        await page.waitForSelector('#wiki-detail:not([hidden])');
        const selected3d = await graphHost.getAttribute('data-selected');
        check(
          'clicking a 3D node selects its record',
          selected3d === target.id,
          selected3d
        );
        await page.screenshot({
          path: join(SHOTS, 'constellation.png'),
          fullPage: true,
        });

        // Focus mode remains available for a readable one-hop explanation.
        await page.click('#detail-close');
        await page.click('#mode-focus');
        await page.waitForSelector('#wiki-graph .wiki-node', { timeout: 5000 });
        const focusNodes = await page.$$eval(
          '#wiki-graph .wiki-node',
          (n) => n.length
        );
        check(
          'focus mode renders nodes',
          focusNodes > 0,
          `${focusNodes} nodes`
        );

        const centred = await page.$$eval(
          '#wiki-graph .wiki-node.is-center',
          (n) => n.length
        );
        check('focus has exactly one centre', centred === 1, String(centred));

        // Every mark must carry a text label -- identity is never colour alone.
        const labelled = await page.$$eval(
          '#wiki-graph .wiki-node',
          (nodes) =>
            nodes.filter(
              (n) =>
                (n.querySelector('text')?.textContent || '').trim().length > 0
            ).length
        );
        check(
          'every node carries a text label',
          labelled === focusNodes,
          `${labelled}/${focusNodes}`
        );

        const detailOpen = await page.isVisible('#wiki-detail');
        check('detail panel opens on selection', detailOpen);

        const provenance = await page.textContent('#wiki-detail');
        check(
          'detail shows provenance',
          /harvested|asserted by a person/.test(provenance || '')
        );

        await page.screenshot({
          path: join(SHOTS, 'focus.png'),
          fullPage: true,
        });

        // Marks must not spill outside the SVG viewport.
        const svgBox = await page.evaluate(() => {
          const svg = document
            .getElementById('wiki-graph')
            .getBoundingClientRect();
          const nodes = [
            ...document.querySelectorAll('#wiki-graph .wiki-node'),
          ].map((n) => n.getBoundingClientRect());
          return {
            // The RIGHT edge was missing from this list, which is exactly why
            // truncated labels passed a green run: node bounding boxes include
            // their text, and every caption was running off the right side.
            outside: nodes.filter(
              (b) =>
                b.left < svg.left - 2 ||
                b.right > svg.right + 2 ||
                b.top < svg.top - 2 ||
                b.bottom > svg.bottom + 2
            ).length,
            total: nodes.length,
          };
        });
        check(
          'no node escapes the graph viewport',
          svgBox.outside === 0,
          `${svgBox.outside}/${svgBox.total} outside`
        );

        // Overlapping captions are unreadable and invisible to every check
        // that does not measure rendered text.
        const focusCollisions = await page.evaluate(() => {
          const boxes = [
            ...document.querySelectorAll('#wiki-graph .wiki-node text'),
          ].map((t) => t.getBoundingClientRect());
          let hits = 0;
          for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
              const a = boxes[i];
              const b = boxes[j];
              if (
                a.left < b.right &&
                b.left < a.right &&
                a.top < b.bottom &&
                b.top < a.bottom
              )
                hits++;
            }
          }
          return hits;
        });
        check(
          'focus labels do not collide',
          focusCollisions === 0,
          `${focusCollisions} overlaps`
        );

        // Rendered text size, on screen. A scaled coordinate space silently
        // shrank 11px labels to about 6px and every other check still passed --
        // the nodes were present, labelled, inside the viewport, and unreadable.
        const smallest = await page.evaluate(() =>
          Math.min(
            ...[
              ...document.querySelectorAll('#wiki-graph .wiki-node text'),
            ].map((t) => t.getBoundingClientRect().height)
          )
        );
        check(
          'labels render at a legible size',
          smallest >= 10,
          `${smallest.toFixed(1)}px tall`
        );

        // Returning to 3D must preserve a functional renderer after focus and
        // drawer reflow, not recreate a blank surface.
        await page.click('#detail-close');
        const frameBeforeRoundTrip = Number(
          await page.getAttribute('#wiki-graph-3d', 'data-frame')
        );
        await page.click('#mode-constellation');
        await page.waitForFunction(
          (baseline) =>
            Number(document.querySelector('#wiki-graph-3d')?.dataset.frame) >
            baseline,
          frameBeforeRoundTrip,
          { timeout: 5000 }
        );
        check(
          '3D graph survives focus-mode round trip',
          await page.isVisible('#wiki-graph-3d canvas')
        );

        // Audit tab.
        await page.click('.wiki-tab[data-tab="audit"]');
        await page.waitForTimeout(400);
        const auditText = await page.textContent('#audit-groups');
        check(
          'audit surfaces the contradiction',
          /Contradicted/i.test(auditText || '')
        );
        check(
          'audit surfaces low confidence',
          /Low confidence/i.test(auditText || '')
        );
        await page.screenshot({
          path: join(SHOTS, 'audit.png'),
          fullPage: true,
        });

        // Evidence console: causal cohorts, live traces, and honest client tiers.
        await page.click('.wiki-tab[data-tab="evidence"]');
        await page.waitForSelector('#evidence-capabilities tbody tr', {
          timeout: 5000,
        });
        const evidenceState = await page.getAttribute(
          '#evidence-status',
          'data-state'
        );
        check(
          'evidence console distinguishes sufficient causal data',
          evidenceState === 'ok',
          evidenceState
        );
        const cohortText = await page.textContent('#evidence-cohorts');
        check(
          'evidence renders matched effect intervals',
          /full/i.test(cohortText || '') && /400/.test(cohortText || '')
        );
        const transferText = await page.textContent('#evidence-transfer');
        check(
          'evidence renders cross-client natural transfer separately',
          /codex/i.test(transferText || '') &&
            /claude-code/i.test(transferText || '') &&
            /gates passed/i.test(transferText || '')
        );
        const concurrencyText = await page.textContent('#evidence-concurrency');
        check(
          'evidence renders concurrent writer integrity and later delivery',
          /100%/.test(concurrencyText || '') &&
            /0%/.test(concurrencyText || '') &&
            /3/.test(concurrencyText || '')
        );
        const capabilityCount = await page
          .locator('#evidence-capabilities tbody tr')
          .count();
        check(
          'evidence lists all supported client capabilities',
          capabilityCount === 16,
          String(capabilityCount)
        );
        const capabilityText = await page.textContent('#evidence-capabilities');
        check(
          'rules-only clients are labelled MCP-visible only',
          /mcp-visible-only/i.test(capabilityText || '')
        );
        await page.waitForSelector('#ucr-summary .stat-card', {
          timeout: 5000,
        });
        const ucrText = await page.textContent('#ucr-summary');
        const ucrState = await page.getAttribute('#ucr-verdict', 'data-state');
        check(
          'UCR dashboard renders event, graph, and client coverage',
          /1\.0\.0/.test(ucrText || '') &&
            /1/.test(ucrText || '') &&
            /16/.test(ucrText || '')
        );
        check(
          'UCR dashboard renders signed artifacts and live directions',
          new RegExp(
            `Evidence artifacts\\s*${expectedArtifactCount}/${expectedArtifactCount}`,
            'i'
          ).test(ucrText || '') &&
            /Live directions\s*2\/3/i.test(ucrText || '') &&
            /Consumer MCP schema\s*0 tokens max/i.test(ucrText || '') &&
            /Combined token reduction\s*5\.66%/i.test(ucrText || '') &&
            /Combined latency reduction\s*-4\.73%/i.test(ucrText || '') &&
            /Known mistake recurrence\s*0 control → 0 runtime/i.test(
              ucrText || ''
            ) &&
            /Native guard denials\s*0/i.test(ucrText || '') &&
            /Capture model calls\s*0 additional max/i.test(ucrText || '')
        );
        check(
          'UCR dashboard separates frozen design from observed evidence',
          /Frozen study design\s*54,054 trials \/ 113,022 calls/i.test(
            ucrText || ''
          ) &&
            /Release metrics mapped\s*37/i.test(ucrText || '') &&
            /Universal CLI drivers\s*16 protocol-mapped \/ 3 in powered live matrix/i.test(
              ucrText || ''
            )
        );
        const tierCount = await page.locator('#ucr-tiers tbody tr').count();
        const artifactCount = await page
          .locator('#ucr-artifacts tbody tr')
          .count();
        check(
          'UCR dashboard separates all six evidence tiers',
          tierCount === 6,
          String(tierCount)
        );
        check(
          'UCR dashboard exposes every integrity-checked study',
          artifactCount === expectedArtifactCount,
          String(artifactCount)
        );
        check(
          'UCR dashboard fails closed without live effectiveness evidence',
          ucrState === 'insufficient',
          ucrState
        );
        await page.screenshot({
          path: join(SHOTS, 'evidence.png'),
          fullPage: true,
        });
      } else {
        await page.screenshot({
          path: join(SHOTS, 'narrow.png'),
          fullPage: true,
        });
      }

      await page.close();
    }

    // Overview contract: exercise the real browser renderer against the exact
    // object/event shapes returned by the session API. This catches regressions
    // where `toolName` became the useless fallback "action" and an object-shaped
    // toolBreakdown silently rendered as an empty table.
    const overview = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    overview.on('console', (message) => {
      if (message.type() === 'error')
        consoleErrors.push(`overview: ${message.text()}`);
    });
    overview.on('pageerror', (error) =>
      consoleErrors.push(`overview: ${error.message}`)
    );
    // Force the compatibility path so this fixture continues proving that a
    // legacy client's object-shaped token totals render correctly. The live
    // dashboard test separately proves the preferred cross-client diagnostics
    // path and its explicit "not measured" states.
    await overview.route('**/api/diagnostics/hooks*', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ summary: { available: false }, events: [] }),
      })
    );
    await overview.route('**/api/session-summary*', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          totalTokens: 910,
          totalTurns: 3,
          totalTools: 2,
          duration: '4m',
          tokensByCategory: {
            tools: { tokens: 910, percent: '100.00' },
          },
          tokensByServer: {},
          toolBreakdown: {
            Read: { count: 1, tokens: 610 },
            Grep: { count: 1, tokens: 300 },
          },
        }),
      })
    );
    await overview.route('**/api/session-events*', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          events: [
            {
              type: 'tool_call',
              toolName: 'Read',
              estimatedTokens: 610,
              timestamp: '2026-08-10T15:00:00Z',
            },
            {
              type: 'tool_call',
              toolName: 'Grep',
              estimatedTokens: 300,
              timestamp: '2026-08-10T15:01:00Z',
            },
          ],
        }),
      })
    );
    await overview.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await overview.waitForSelector('#constellation canvas');
    const overviewText = await overview.textContent('body');
    check(
      'overview is provider and CLI neutral',
      !/claude(?: code)?/i.test(overviewText || '')
    );
    const eventText = await overview.locator('.event').first().textContent();
    check(
      'overview names the observed tool and token cost',
      /Read/.test(eventText || '') &&
        /610 context tokens/.test(eventText || ''),
      eventText?.trim()
    );
    check(
      'overview never falls back to generic action rows',
      !(await overview.locator('.ev-name').allTextContents()).some(
        (name) => name.trim().toLowerCase() === 'action'
      )
    );
    const breakdownRows = await overview
      .locator('#tool-breakdown-body tr')
      .count();
    check(
      'overview renders object-shaped tool totals',
      breakdownRows === 2,
      `${breakdownRows} rows`
    );
    const actionCostRows = await overview.locator('#server-chart .legend li');
    check(
      'overview charts object-shaped action costs instead of showing an empty state',
      (await actionCostRows.count()) === 2 &&
        /Read/.test((await actionCostRows.first().textContent()) || ''),
      `${await actionCostRows.count()} chart rows`
    );
    check(
      'overview embeds the same 3D graph renderer',
      (await overview.getAttribute('#constellation', 'data-renderer')) ===
        'perspective-3d'
    );
    await overview.screenshot({
      path: join(SHOTS, 'overview.png'),
      fullPage: true,
    });
    await overview.close();

    check(
      'no console or page errors',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' ; ')
    );
  } finally {
    await browser.close();
    server.kill();
    rmSync(GRAPH, { recursive: true, force: true });
    rmSync(UCR, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed`
  );
  console.log(`screenshots: ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
