#!/usr/bin/env node
/** Read-only Playwright verification against an already running dashboard. */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || 'http://localhost:3101';
const output = join(ROOT, 'artifacts', 'live-dashboard');
mkdirSync(output, { recursive: true });

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

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  const overviewBody = await page.locator('body').innerText();
  const overview = {
    title: await page.title(),
    heading: await page.locator('.brand').first().innerText(),
    claudeHardcode: /what claude did/i.test(overviewBody),
    genericActivity:
      /which actions cost the most|what it has learned|agent activity/i.test(
        overviewBody
      ),
  };
  await page.screenshot({
    path: join(output, 'overview.png'),
    fullPage: true,
  });

  await page.goto(`${base}/wiki`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#wiki-list li');
  const host = page.locator('#wiki-graph-3d');
  const graph3d = await host.evaluate((element) => ({
    width: element.clientWidth,
    height: element.clientHeight,
    projected:
      element.__knowledgeGraph3d?.projectedNodes?.().length ?? null,
    selected: element.dataset.selected || null,
  }));
  await page.locator('#mode-constellation').click();
  await page.waitForTimeout(800);
  await page.locator('#wiki-list li').first().click();
  await page.waitForTimeout(500);
  const afterSelect = await host.evaluate((element) => ({
    projected:
      element.__knowledgeGraph3d?.projectedNodes?.().length ?? null,
    selected: element.dataset.selected || null,
  }));
  const wiki = {
    listCount: await page.locator('#wiki-list li').count(),
    graph3d,
    afterSelect,
    detailVisible: await page.locator('#wiki-detail').isVisible(),
  };
  await page.screenshot({
    path: join(output, 'wiki-3d.png'),
    fullPage: true,
  });

  const passed =
    !overview.claudeHardcode &&
    overview.genericActivity &&
    wiki.listCount > 0 &&
    wiki.graph3d.width > 0 &&
    wiki.graph3d.height > 0 &&
    wiki.graph3d.projected > 0 &&
    wiki.afterSelect.projected > 0 &&
    Boolean(wiki.afterSelect.selected) &&
    wiki.detailVisible &&
    errors.length === 0;
  process.stdout.write(
    `${JSON.stringify({ passed, base, overview, wiki, errors }, null, 2)}\n`
  );
  if (!passed) process.exitCode = 1;
} finally {
  await browser.close();
}
