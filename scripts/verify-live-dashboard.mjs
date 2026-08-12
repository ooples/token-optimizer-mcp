#!/usr/bin/env node
/** Read-only Playwright verification against an already running dashboard. */

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || 'http://localhost:3100';
const output = join(ROOT, 'artifacts', 'live-dashboard');
const documentationOutput = process.argv[3] ? resolve(process.argv[3]) : null;
mkdirSync(output, { recursive: true });
if (documentationOutput) mkdirSync(documentationOutput, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console:${message.text()}`);
});
page.on('pageerror', (error) => errors.push(`page:${error.message}`));
page.on('requestfailed', (request) =>
  errors.push(`request:${request.url()}:${request.failure()?.errorText}`)
);
page.on('response', (response) => {
  if (response.url().includes('/api/') && !response.ok()) {
    errors.push(`response:${response.status()}:${response.url()}`);
  }
});

async function waitForCount(selector, minimum, label) {
  try {
    await page.waitForFunction(
      ({ selector: query, minimum: expected }) =>
        document.querySelectorAll(query).length >= expected,
      { selector, minimum },
      { timeout: 30_000 }
    );
  } catch (error) {
    const diagnostic = await page.evaluate(
      (query) => ({
        url: location.href,
        count: document.querySelectorAll(query).length,
        status:
          document.querySelector('#hook-health-status')?.textContent?.trim() ||
          null,
        state:
          document.querySelector('#hook-health-status')?.dataset.state || null,
      }),
      selector
    );
    throw new Error(`${label} did not render: ${JSON.stringify(diagnostic)}`, {
      cause: error,
    });
  }
}

async function measureCameraStability(host) {
  return host.evaluate(async (element) => {
    const samples = [];
    for (let index = 0; index < 12; index += 1) {
      samples.push({
        width: element.clientWidth,
        height: element.clientHeight,
        zoom: Number(element.dataset.zoom),
        yaw: Number(element.dataset.yaw),
        pitch: Number(element.dataset.pitch),
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const spread = (key) => {
      const values = samples.map((sample) => sample[key]);
      return Math.max(...values) - Math.min(...values);
    };
    return {
      first: samples[0],
      last: samples.at(-1),
      widthSpread: spread('width'),
      heightSpread: spread('height'),
      zoomSpread: spread('zoom'),
      yawSpread: spread('yaw'),
      pitchSpread: spread('pitch'),
    };
  });
}

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => {
      const saved = document.querySelector('#saved-tokens');
      return (
        ['measured', 'collecting', 'not-measured'].includes(
          saved?.dataset.state
        ) &&
        document.querySelectorAll('#accounting-grid .accounting-card')
          .length === 7 &&
        document.querySelectorAll('#client-ledger .client-ledger-row').length >
          0
      );
    },
    undefined,
    { timeout: 20_000 }
  );
  await page.waitForSelector('#constellation canvas', { timeout: 30_000 });
  await page.waitForTimeout(1_100);
  const overviewBody = await page.locator('body').innerText();
  const overview = {
    title: await page.title(),
    heading: await page.locator('.brand').first().innerText(),
    claudeHardcode: /what claude did/i.test(overviewBody),
    genericActivity:
      /which actions cost the most|what it has learned|agent activity/i.test(
        overviewBody
      ),
    staleLegacySession: /november 2025|2025-11-02/i.test(overviewBody),
    activityCards: await page.locator('#kpis .kpi').evaluateAll((cards) =>
      cards.map((card) => ({
        label:
          card
            .querySelector('.kpi-label')
            ?.childNodes[0]?.textContent?.trim() || '',
        value: card.querySelector('.kpi-value')?.textContent?.trim() || '',
      }))
    ),
    savedTokens: await page.locator('#saved-tokens').innerText(),
    savedMoney: await page.locator('#saved-money').innerText(),
    accessibility: {
      savings: await page.locator('#saved-card').ariaSnapshot(),
      accounting: await page.locator('#token-accounting').ariaSnapshot(),
      agents: await page.locator('#measured-by-agent').ariaSnapshot(),
    },
    accountingCards: await page
      .locator('#accounting-grid .accounting-card')
      .evaluateAll((cards) =>
        cards.map((card) => ({
          label:
            card.querySelector('.accounting-label')?.textContent?.trim() || '',
          value:
            card.querySelector('.accounting-value')?.textContent?.trim() || '',
          detail:
            card.querySelector('.accounting-detail')?.textContent?.trim() || '',
        }))
      ),
    clientRows: await page
      .locator('#client-ledger .client-ledger-row')
      .evaluateAll((rows) => rows.map((row) => row.textContent?.trim() || '')),
    recentRows: await page
      .locator('#timeline-container .event')
      .evaluateAll((rows) => rows.map((row) => row.textContent?.trim() || '')),
    actionRows: await page
      .locator('#tool-breakdown-body tr')
      .evaluateAll((rows) =>
        rows.map((row) =>
          [...row.querySelectorAll('td')].map(
            (cell) => cell.textContent?.trim() || ''
          )
        )
      ),
    cameraStability: await measureCameraStability(
      page.locator('#constellation')
    ),
  };
  await page.screenshot({
    path: join(output, 'overview.png'),
    fullPage: true,
  });
  if (documentationOutput) {
    await page.screenshot({
      path: join(documentationOutput, 'overview-live.png'),
      fullPage: true,
    });
    await page.locator('.client-accounting').screenshot({
      path: join(documentationOutput, 'agent-accounting-live.png'),
    });
  }

  await page.goto(`${base}/wiki`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#wiki-list li');
  await waitForCount(
    '#hook-health-grid .stat-card',
    14,
    'runtime health cards'
  );
  const captureHealth = await page.evaluate(() => {
    const values = [
      ...document.querySelectorAll('#hook-health-grid .stat-card'),
    ].map((card) => ({
      label: card.querySelector('.stat-label')?.textContent?.trim() || '',
      value: card.querySelector('.stat-value')?.textContent?.trim() || '',
    }));
    return {
      values,
      status:
        document.querySelector('#hook-health-status')?.textContent?.trim() ||
        '',
      state: document.querySelector('#hook-health-status')?.dataset.state || '',
      detail:
        document.querySelector('#hook-health-detail')?.textContent?.trim() ||
        '',
      clients: [
        ...document.querySelectorAll('#hook-health-clients .capture-client'),
      ].map((card) => card.textContent?.trim() || ''),
    };
  });
  await page.screenshot({
    path: join(output, 'wiki-capture-health.png'),
    fullPage: true,
  });
  if (documentationOutput) {
    await page
      .locator('section.wiki-balance')
      .nth(0)
      .screenshot({
        path: join(documentationOutput, 'capture-health-live.png'),
      });
    await page
      .locator('section.wiki-balance')
      .nth(1)
      .screenshot({
        path: join(documentationOutput, 'graph-balance-live.png'),
      });
  }
  const host = page.locator('#wiki-graph-3d');
  const graph3d = await host.evaluate((element) => ({
    width: element.clientWidth,
    height: element.clientHeight,
    projected: element.__knowledgeGraph3d?.projectedNodes?.().length ?? null,
    selected: element.dataset.selected || null,
  }));
  const cameraStability = await measureCameraStability(host);
  await page.locator('#mode-constellation').click();
  await page.waitForTimeout(800);
  await page.locator('#wiki-list li').first().click();
  await page.waitForTimeout(500);
  const afterSelect = await host.evaluate((element) => ({
    projected: element.__knowledgeGraph3d?.projectedNodes?.().length ?? null,
    selected: element.dataset.selected || null,
  }));
  const detailVisible = await page.locator('#wiki-detail').isVisible();
  if (documentationOutput) {
    await page.locator('#tab-explore').screenshot({
      path: join(documentationOutput, 'graph-explorer-live.png'),
    });
  }
  await page.locator('.wiki-tab[data-tab="evidence"]').click();
  await waitForCount('#evidence-summary .stat-card', 6, 'evidence cards');
  await page.waitForFunction(
    () => document.querySelectorAll('#ucr-missing tbody tr').length > 0
  );
  const evidence = await page.evaluate(() => ({
    summary: [...document.querySelectorAll('#evidence-summary .stat-card')].map(
      (card) => ({
        label: card.querySelector('.stat-label')?.textContent?.trim() || '',
        value: card.querySelector('.stat-value')?.textContent?.trim() || '',
      })
    ),
    status:
      document.querySelector('#evidence-status')?.textContent?.trim() || '',
    ucrSummary: [...document.querySelectorAll('#ucr-summary .stat-card')].map(
      (card) => ({
        label: card.querySelector('.stat-label')?.textContent?.trim() || '',
        value: card.querySelector('.stat-value')?.textContent?.trim() || '',
      })
    ),
    missingMetrics: document.querySelectorAll('#ucr-missing tbody tr').length,
  }));
  await page.screenshot({
    path: join(output, 'wiki-evidence.png'),
    fullPage: true,
  });
  if (documentationOutput) {
    await page.locator('#tab-evidence').screenshot({
      path: join(documentationOutput, 'evidence-console-live.png'),
    });
  }
  const wiki = {
    listCount: await page.locator('#wiki-list li').count(),
    scopeOptions: await page.locator('#wiki-scope option').count(),
    coverage: await page.locator('#wiki-coverage').innerText(),
    graphStats: await page.locator('#graph-stats').innerText(),
    aggregateCoverage: await page.evaluate(async () => {
      const [status, inventory] = await Promise.all([
        fetch('/api/wiki/status?scope=all').then((response) => response.json()),
        fetch('/api/wiki/projects').then((response) => response.json()),
      ]);
      return {
        nodes: status.nodes,
        capturedProjects: status.capturedProjects,
        largestProjectNodes: Math.max(
          0,
          ...inventory.projects.map((project) => project.nodes || 0)
        ),
        missingProjects: inventory.missing,
      };
    }),
    balanceCards: await page
      .locator('#balance-grid .stat-card')
      .evaluateAll((cards) =>
        cards.map((card) => ({
          label: card.querySelector('.stat-label')?.textContent?.trim() || '',
          value: card.querySelector('.stat-value')?.textContent?.trim() || '',
        }))
      ),
    balanceContract: await page.evaluate(async () => {
      const report = await fetch('/api/wiki/balance?scope=all').then(
        (response) => response.json()
      );
      return {
        coverage: report.measurement?.sourceCoverage || null,
        freshness: report.measurement?.freshness || null,
        metrics: report.measurement?.metrics || null,
        method:
          document.querySelector('#balance-method')?.textContent?.trim() || '',
      };
    }),
    captureHealth,
    graph3d,
    cameraStability,
    afterSelect,
    evidence,
    detailVisible,
    drawerOverlap: await page.evaluate(() => {
      const drawer = document
        .querySelector('#wiki-detail')
        ?.getBoundingClientRect();
      if (!drawer) return null;
      const selectors = [
        '#hook-health-grid .stat-card',
        '#balance-grid .stat-card',
        '.wiki-tabs',
        '.wiki-toolbar',
      ];
      return selectors.flatMap((selector) =>
        [...document.querySelectorAll(selector)]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.right > drawer.left && rect.left < drawer.right;
          })
          .map((element) => selector)
      );
    }),
  };
  await page.screenshot({
    path: join(output, 'wiki-3d.png'),
    fullPage: true,
  });

  const passed =
    !overview.claudeHardcode &&
    overview.genericActivity &&
    !overview.staleLegacySession &&
    overview.activityCards.length === 4 &&
    overview.activityCards.some(
      ({ label, value }) =>
        label === 'Lifecycle events' && Number(value.replaceAll(',', '')) > 0
    ) &&
    /^(?:[\d,]+|—)$/.test(overview.savedTokens) &&
    overview.savedMoney === 'Not priced' &&
    overview.accessibility.savings.includes(overview.savedTokens) &&
    /Returned context/i.test(overview.accessibility.accounting) &&
    /codex|claude-code|gemini/i.test(overview.accessibility.agents) &&
    overview.accountingCards.length === 7 &&
    overview.accountingCards.some(
      ({ label, value, detail }) =>
        label === 'Returned context' &&
        value !== 'Not measured' &&
        /Not priced|\$/.test(detail)
    ) &&
    overview.clientRows.length >= 2 &&
    overview.recentRows.some(
      (row) =>
        /Not priced|\$|excluded/i.test(row) &&
        /saved|baseline|excluded/i.test(row)
    ) &&
    overview.actionRows.some(
      (row) => row.length === 6 && row[3] === 'Not priced'
    ) &&
    overview.cameraStability.widthSpread <= 1 &&
    overview.cameraStability.heightSpread <= 1 &&
    overview.cameraStability.zoomSpread <= 0.0001 &&
    overview.cameraStability.yawSpread <= 0.0001 &&
    overview.cameraStability.pitchSpread <= 0.0001 &&
    wiki.listCount > 0 &&
    wiki.scopeOptions >= 3 &&
    /contain graph data/i.test(wiki.coverage) &&
    wiki.aggregateCoverage.capturedProjects >= 2 &&
    wiki.aggregateCoverage.nodes > wiki.aggregateCoverage.largestProjectNodes &&
    // Missing-source reporting must not turn complete capture into a failure.
    // The coverage assertion above accepts both the partial and complete-copy;
    // this field only needs to remain a valid non-negative count.
    wiki.aggregateCoverage.missingProjects >= 0 &&
    wiki.balanceCards.length === 8 &&
    wiki.balanceCards.every(({ value }) => value.length > 0 && value !== '—') &&
    wiki.balanceContract.coverage?.projects >= 1 &&
    wiki.balanceContract.coverage?.projectsWithTelemetry >= 1 &&
    wiki.balanceContract.freshness?.lastEventAt &&
    [
      'nativeSubstitutions',
      'memoryDeliveries',
      'memoryHoldouts',
      'rememberingCost',
      'readingAvoided',
    ].every((key) => wiki.balanceContract.metrics?.[key]?.source) &&
    /selected projects have telemetry/i.test(wiki.balanceContract.method) &&
    wiki.captureHealth.values.length === 14 &&
    wiki.captureHealth.clients.length >= 2 &&
    wiki.captureHealth.clients.every((client) =>
      /Activity|Runtime|Control|Coverage/.test(client)
    ) &&
    wiki.captureHealth.detail.length < 180 &&
    wiki.captureHealth.values.some(
      ({ label, value }) =>
        label === 'Hook runs' && Number(value.replaceAll(',', '')) > 0
    ) &&
    wiki.captureHealth.values.some(
      ({ label, value }) =>
        label === 'Policy blocks' && Number(value.replaceAll(',', '')) >= 0
    ) &&
    wiki.captureHealth.values.some(
      ({ label, value }) =>
        label === 'Abandoned' && Number(value.replaceAll(',', '')) === 0
    ) &&
    wiki.captureHealth.values.some(
      ({ label, value }) =>
        label === 'MCP handshakes' && Number(value.replaceAll(',', '')) > 0
    ) &&
    wiki.captureHealth.values.some(
      ({ label, value }) =>
        label === 'Tools advertised' && Number(value.replaceAll(',', '')) > 0
    ) &&
    wiki.captureHealth.values.some(
      ({ label, value }) =>
        label === 'MCP failures' && Number(value.replaceAll(',', '')) === 0
    ) &&
    wiki.captureHealth.state === 'ok' &&
    wiki.graph3d.width > 0 &&
    wiki.graph3d.height > 0 &&
    wiki.graph3d.projected > 0 &&
    wiki.cameraStability.widthSpread <= 1 &&
    wiki.cameraStability.heightSpread <= 1 &&
    wiki.cameraStability.zoomSpread <= 0.0001 &&
    wiki.cameraStability.yawSpread <= 0.0001 &&
    wiki.cameraStability.pitchSpread <= 0.0001 &&
    wiki.afterSelect.projected > 0 &&
    Boolean(wiki.afterSelect.selected) &&
    wiki.evidence.summary.length === 6 &&
    wiki.evidence.summary.every(
      ({ value }) => value.length > 0 && value !== '—'
    ) &&
    wiki.evidence.summary
      .filter(({ label }) =>
        ['Randomized runs', 'Handoff runs', 'Concurrency runs'].includes(label)
      )
      .every(({ value }) => value === 'Not run') &&
    /selected projects have evidence events/i.test(wiki.evidence.status) &&
    wiki.evidence.ucrSummary.some(
      ({ label, value }) =>
        label === 'UCR runtime events' && value === 'Not exercised'
    ) &&
    wiki.evidence.missingMetrics > 0 &&
    wiki.detailVisible &&
    wiki.drawerOverlap?.length === 0 &&
    errors.length === 0;
  process.stdout.write(
    `${JSON.stringify({ passed, base, overview, wiki, errors }, null, 2)}\n`
  );
  if (!passed) process.exitCode = 1;
} finally {
  await browser.close();
}
