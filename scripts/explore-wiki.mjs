#!/usr/bin/env node
/**
 * EXPLORATORY driver. Not a test suite.
 *
 * verify-wiki-interactions.mjs asserts things I already expected to be true.
 * This does the opposite: it performs awkward, impatient, out-of-order things a
 * real person does -- double-clicking, typing while a render is mid-flight,
 * switching modes repeatedly, resizing the 3D scene, reloading after a
 * mutation, retiring findings until none are left -- and REPORTS anomalies
 * rather than checking for known answers.
 *
 * An anomaly is anything a user would call broken: a console error, an
 * unhandled rejection, a control that stops responding, state that disagrees
 * with itself, layout that overflows, or a view that empties when it should not.
 *
 * Run against a live dashboard: node scripts/explore-wiki.mjs [baseUrl]
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || 'http://localhost:3100';
const SHOTS = join(ROOT, 'artifacts', 'explore');

const anomalies = [];
const note = (where, what) => {
  anomalies.push({ where, what });
  console.log(`  ANOMALY  [${where}] ${what}`);
};
const ok = (what) => console.log(`  ok       ${what}`);

const listCount = (page) => page.locator('#wiki-list li').count();
const drawerOpen = (page) => page.locator('#wiki-detail').isVisible();

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });

  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) =>
    errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`)
  );
  page.on('dialog', async (d) => {
    note('dialog', `unexpected: ${d.message()}`);
    await d.dismiss();
  });

  const drain = (where) => {
    while (errors.length) note(where, errors.shift());
  };

  await page.goto(`${BASE}/wiki`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#wiki-list li');
  drain('load');
  ok(`loaded with ${await listCount(page)} findings`);

  /* --- 1. Impatience: double and triple clicking a list item ------------- */
  const first = page.locator('#wiki-list li').first();
  await first.click({ clickCount: 3, delay: 20 });
  await page.waitForTimeout(900);
  drain('triple-click list item');
  if (!(await drawerOpen(page))) note('triple-click', 'drawer did not open');
  const selected = await page
    .locator('#wiki-graph-3d')
    .getAttribute('data-selected');
  if (!selected)
    note('triple-click', 'rapid selection left no selected 3D node');
  else ok('rapid clicking leaves one selected 3D node');

  /* --- 2. Mode toggle hammered ------------------------------------------ */
  for (let i = 0; i < 6; i++) {
    await page.locator('#mode-constellation').click();
    await page.locator('#mode-focus').click();
  }
  await page.waitForTimeout(1500);
  drain('mode hammering');
  const nodesAfter = await page.locator('#wiki-graph .wiki-node').count();
  if (nodesAfter === 0)
    note('mode hammering', 'graph is empty after rapid mode switching');
  else ok(`graph survives rapid mode switching (${nodesAfter} nodes)`);

  const activeModes = await page.locator('.wiki-mode.is-active').count();
  if (activeModes !== 1)
    note('mode hammering', `${activeModes} modes marked active`);
  else ok('exactly one mode is active');

  /* --- 3. Typing while a render is in flight ---------------------------- */
  await page.locator('#wiki-list li').first().click();
  await page.locator('#wiki-search').type('retry', { delay: 15 });
  await page.locator('#mode-constellation').click();
  await page.locator('#wiki-search').fill('');
  await page.waitForTimeout(1600);
  drain('type during render');
  const afterRace = await listCount(page);
  if (afterRace === 0)
    note(
      'type during render',
      'list empty after search race with an empty query'
    );
  else ok(`list intact after search/render race (${afterRace})`);

  /* --- 4. Fast successive searches (debounce race) ---------------------- */
  for (const q of ['a', 'ab', 'abc', 'ret', 'retry', 'r', '']) {
    await page.locator('#wiki-search').fill(q);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(900);
  drain('debounce race');
  const settled = await listCount(page);
  const reported = await page.locator('#wiki-count').innerText();
  if (!reported.startsWith(String(settled))) {
    note(
      'debounce race',
      `list shows ${settled} but counter says "${reported}"`
    );
  } else ok(`search settles consistently (${reported})`);

  /* --- 5. Keyboard-only traversal --------------------------------------- */
  // Reload to reset the focus point. `document.body.focus()` is a NO-OP -- body
  // is not focusable -- so traversal silently began wherever focus already sat,
  // which was past the controls it was meant to prove reachable. It reported
  // real controls as unreachable purely because of where it started.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#wiki-list li');
  const reachable = new Set();
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      return el.id || el.className || el.tagName;
    });
    if (id) reachable.add(String(id));
  }
  drain('keyboard traversal');
  for (const needed of [
    'wiki-search',
    'wiki-type',
    'mode-focus',
    'mode-constellation',
  ]) {
    if (![...reachable].some((r) => r.includes(needed))) {
      note('keyboard', `${needed} is not reachable by Tab`);
    }
  }
  ok(`Tab reaches ${reachable.size} distinct controls`);

  /* --- 6. Walk every node in the focus graph ---------------------------- */
  // Deliberately begin this walk from 3D. Selection must remain in 3D until the
  // user explicitly asks for the bounded one-hop Focus view.
  await page.locator('#mode-constellation').click();
  await page.waitForTimeout(1200);
  await page.locator('#wiki-list li').first().click();
  const modesAfterSelect = await page
    .locator('.wiki-mode.is-active')
    .evaluateAll((modes) => modes.map((mode) => mode.id));
  if (
    modesAfterSelect.length !== 1 ||
    modesAfterSelect[0] !== 'mode-constellation'
  ) {
    note(
      'mode desync',
      `selecting a node left ${JSON.stringify(modesAfterSelect)} marked active`
    );
  } else ok('selecting a node preserves the 3D view');
  await page.locator('#mode-focus').click();
  await page.waitForSelector('#wiki-graph .wiki-node.is-center');
  let walked = 0;
  for (let hop = 0; hop < 8; hop++) {
    const next = await page.evaluate(
      () =>
        document.querySelector('#wiki-graph .wiki-node:not(.is-center)')
          ?.dataset.id || null
    );
    if (!next) break;
    await page.locator(`#wiki-graph .wiki-node[data-id="${next}"]`).click();
    await page.waitForTimeout(500);
    const centre = await page.evaluate(
      () =>
        document.querySelector('#wiki-graph .wiki-node.is-center')?.dataset
          .id || null
    );
    if (centre !== next) {
      note('graph walk', `clicked ${next} but centre is ${centre}`);
      break;
    }
    walked++;
  }
  drain('graph walk');
  ok(`walked ${walked} hops through the graph without desync`);

  /* --- 7. Resize the 3D constellation ------------------------------------ */
  await page.locator('#mode-constellation').click();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(300);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(1500);
  drain('resize 3D scene');
  const projection = await page.evaluate(() => {
    const host = document.getElementById('wiki-graph-3d');
    if (!host) return { hostPresent: false, spread: null };
    const nodes = host.__knowledgeGraph3d?.projectedNodes() || [];
    if (nodes.length < 2) return { hostPresent: true, spread: -1 };
    const xs = nodes.map((node) => node.x);
    return {
      hostPresent: true,
      spread: Math.round(Math.max(...xs) - Math.min(...xs)),
    };
  });
  if (!projection.hostPresent)
    note('resize 3D scene', '3D graph host is missing after resize');
  else if (projection.spread === -1)
    note(
      'resize 3D scene',
      'fewer than two projected nodes remain after resize'
    );
  else if (projection.spread <= 0)
    note('resize 3D scene', 'all nodes collapsed to one point');
  else ok(`3D layout survives resize (${projection.spread}px spread)`);

  const clipped = await page.evaluate(() => {
    const host = document.getElementById('wiki-graph-3d');
    if (!host) return null;
    const box = host.getBoundingClientRect();
    const nodes = host.__knowledgeGraph3d?.projectedNodes() || [];
    return nodes.filter(
      (node) =>
        node.x < 0 || node.y < 0 || node.x > box.width || node.y > box.height
    ).length;
  });
  if (clipped === null)
    note(
      'resize 3D scene',
      'cannot check clipping because the 3D host is missing'
    );
  else if (clipped)
    note('resize 3D scene', `${clipped} projected nodes clipped after resize`);
  else ok('no projected nodes clipped after resize');

  /* --- 8. Tab switching with a drawer open ------------------------------ */
  await page.locator('#mode-focus').click();
  await page.locator('#wiki-list li').first().click();
  await page.waitForTimeout(500);
  await page.locator('.wiki-tab[data-tab="audit"]').click();
  await page.waitForTimeout(500);
  drain('tab switch with drawer open');
  if (await drawerOpen(page)) {
    const exploreHidden = await page.locator('#tab-explore').isHidden();
    if (exploreHidden)
      note(
        'tab switch',
        'drawer still shows an Explore selection while the Audit tab is active'
      );
  }
  await page.locator('.wiki-tab[data-tab="explore"]').click();
  await page.waitForTimeout(400);

  /* --- 9. Zoom ----------------------------------------------------------- */
  for (const zoom of [2, 0.5, 1]) {
    await page.evaluate((z) => {
      document.body.style.zoom = String(z);
    }, zoom);
    await page.waitForTimeout(600);
    const overflow = await page.evaluate(() => {
      const el = document.scrollingElement;
      return el.scrollWidth - el.clientWidth;
    });
    if (overflow > 2)
      note('zoom', `horizontal overflow of ${overflow}px at zoom ${zoom}`);
    else ok(`no horizontal overflow at zoom ${zoom}`);
  }
  drain('zoom');

  /* --- 10. Reload after a mutation --------------------------------------- */
  await page.locator('#wiki-list li').first().click();
  await page.waitForSelector('#wiki-detail:visible');
  await page.locator('#detail-pin').click();
  await page.waitForTimeout(800);
  const beforeReload = await listCount(page);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#wiki-list li');
  const afterReload = await listCount(page);
  drain('reload after mutation');
  if (afterReload !== beforeReload) {
    note(
      'reload after mutation',
      `list was ${beforeReload}, is ${afterReload} after reload`
    );
  } else ok(`state survives reload (${afterReload} findings)`);

  /* --- 11. Chained corrections ------------------------------------------- */
  for (let round = 0; round < 3; round++) {
    await page.locator('#wiki-list li').first().click();
    await page.waitForSelector('#wiki-detail:visible');
    await page
      .locator('#detail-claim')
      .fill(`chained correction round ${round}`);
    await page.locator('#detail-correct').click();
    await page.waitForTimeout(800);
    drain(`correction round ${round}`);
  }
  const chained = await page
    .locator('#wiki-list li', { hasText: 'chained correction round 2' })
    .count();
  if (!chained)
    note('chained corrections', 'the final correction is not in the list');
  else ok('corrections can be chained');

  /* --- 12. Retire everything, then look at the empty state ---------------- */
  let guard = 0;
  while ((await listCount(page)) > 0 && guard++ < 40) {
    await page.locator('#wiki-list li').first().click();
    await page
      .waitForSelector('#wiki-detail:visible', { timeout: 4000 })
      .catch(() => {});
    const retire = page.locator('#detail-retire');
    if (!(await retire.count())) break;
    await retire.click();
    await page.waitForTimeout(450);
  }
  drain('retire everything');
  const remaining = await listCount(page);
  ok(`retired down to ${remaining} findings in ${guard} steps`);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  drain('empty state');

  const emptyIndexNull = await page.evaluate(async () => {
    const s = await (await fetch('/api/wiki/search?limit=5')).json();
    return s.total;
  });
  const stats = await page.locator('#graph-stats').innerText();
  const balance = await page
    .locator('#balance-verdict')
    .innerText()
    .catch(() => '');
  await page
    .locator('.wiki-tab[data-tab="audit"]')
    .click()
    .catch(() => note('empty state', 'audit tab is missing'));
  await page.waitForTimeout(700);
  const auditText = await page
    .locator('#audit-groups')
    .innerText()
    .catch(() => '');
  if (!auditText) note('empty state', 'audit groups are missing or empty');

  if (emptyIndexNull === 0) {
    if (!/0 findings|No graph|healthy|Nothing/i.test(`${stats} ${auditText}`)) {
      note(
        'empty state',
        `graph is empty but UI says "${stats.trim()}" / audit "${auditText.slice(0, 60)}"`
      );
    } else ok('empty state reads sensibly');
  } else ok(`${emptyIndexNull} findings remain (nothing fully emptied)`);

  if (balance) ok(`balance still reports: ${balance.slice(0, 70)}`);

  await page.screenshot({
    path: join(SHOTS, 'after-exploration.png'),
    fullPage: true,
  });
  drain('final');

  await browser.close();

  console.log(
    `\n${anomalies.length} anomal${anomalies.length === 1 ? 'y' : 'ies'} found`
  );
  for (const a of anomalies) console.log(`  [${a.where}] ${a.what}`);
  console.log(`screenshots: ${SHOTS}`);
}

main().catch((error) => {
  console.error('exploration crashed:', error.message);
  process.exit(1);
});
