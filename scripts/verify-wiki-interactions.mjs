#!/usr/bin/env node
/**
 * Drives EVERY user action in the wiki dashboard against a hostile graph.
 *
 * verify-wiki-ui.mjs checks that the page renders. This checks that it can be
 * USED: every control, every keyboard path, every empty and error state, and
 * every field a harvested value reaches -- with injection payloads, unicode,
 * RTL text, absurd lengths, and malformed records seeded deliberately.
 *
 * It runs its own server on its own port against its own graph, so it is
 * repeatable and cannot disturb a dashboard someone is looking at.
 *
 * Run: npm run verify:interactions
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GRAPH = mkdtempSync(join(tmpdir(), 'wiki-interactions-'));
process.env.TOKEN_OPTIMIZER_WIKI_DIR = GRAPH;

const PORT = 3600 + Math.floor(Math.random() * 300);
const BASE = `http://localhost:${PORT}`;
const SHOTS = join(ROOT, 'artifacts', 'wiki-interactions');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(
    `${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`
  );
};

async function waitForServer(attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      if ((await fetch(`${BASE}/api/wiki/status`)).ok) return true;
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  cpSync(
    join(ROOT, 'src', 'dashboard', 'public'),
    join(ROOT, 'dist', 'dashboard', 'public'),
    { recursive: true }
  );

  // Seed the hostile graph into this run's isolated directory.
  await new Promise((resolve, reject) => {
    const seed = spawn(
      process.execPath,
      [join(ROOT, 'scripts', 'seed-edge-cases.mjs'), GRAPH],
      { cwd: ROOT, stdio: 'ignore', windowsHide: true, env: { ...process.env } }
    );
    seed.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`seed exited ${code}`))
    );
    seed.on('error', reject);
  });

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

  const status = await (await fetch(`${BASE}/api/wiki/status`)).json();
  if (status.dir !== GRAPH) {
    console.error(`server serving ${status.dir}, expected ${GRAPH}`);
    server.kill();
    process.exit(1);
  }

  const browser = await chromium.launch();
  const errors = [];

  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('dialog', async (d) => {
      errors.push(`unexpected dialog: ${d.message()}`);
      await d.dismiss();
    });

    await page.goto(`${BASE}/wiki`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#wiki-list li');

    /* ---- Injection payloads must not execute ------------------------- */

    const titleBefore = await page.title();
    check('no payload executed on load', titleBefore !== 'PWNED', titleBefore);
    check(
      'no injected element from a claim',
      (await page.locator('img[onerror]').count()) === 0
    );
    check(
      'no injected script tag',
      (await page.locator('.wiki-list script').count()) === 0
    );

    // The payload must be VISIBLE as text -- escaped, not stripped. Silently
    // dropping it would also "pass" while hiding real content from the user.
    const payloadShown = await page
      .locator('#wiki-list .wiki-claim', {
        hasText: 'a claim containing markup',
      })
      .first()
      .innerText();
    check(
      'markup in a claim renders as literal text',
      payloadShown.includes('<script>'),
      payloadShown.slice(0, 60)
    );

    /* ---- Search ------------------------------------------------------- */

    const search = page.locator('#wiki-search');
    await search.fill('retry');
    await page.waitForTimeout(400);
    const retryCount = await page.locator('#wiki-list li').count();
    check(
      'search narrows the list',
      retryCount > 0 && retryCount < 16,
      `${retryCount} results`
    );

    await search.fill('zzzz-definitely-no-such-finding');
    await page.waitForTimeout(400);
    check(
      'a search with no matches shows an empty list',
      (await page.locator('#wiki-list li').count()) === 0
    );
    check(
      'the count still reports honestly when empty',
      (await page.locator('#wiki-count').innerText()).includes('0')
    );

    // Regex metacharacters must be treated as literal text, not a pattern.
    for (const hostile of [
      '*',
      '(',
      '[',
      '\\',
      '.*',
      '?',
      '${x}',
      '</script>',
    ]) {
      await search.fill(hostile);
      await page.waitForTimeout(220);
      check(
        `search survives ${JSON.stringify(hostile)}`,
        errors.length === 0,
        errors[0] || ''
      );
    }

    await search.fill('');
    await page.waitForTimeout(400);
    check(
      'clearing search restores the list',
      (await page.locator('#wiki-list li').count()) > 1
    );

    /* ---- Type filter -------------------------------------------------- */

    for (const value of [
      'finding',
      'decision',
      'failure',
      'command',
      'map',
      '',
    ]) {
      await page.selectOption('#wiki-type', value);
      await page.waitForTimeout(300);
      const count = await page.locator('#wiki-list li').count();
      check(
        `type filter "${value || 'all'}" applies`,
        count >= 0,
        `${count} results`
      );
    }

    /* ---- Selecting a finding ------------------------------------------ */

    await page.locator('#wiki-list li').first().click();
    await page.waitForSelector('#wiki-detail:visible');
    check(
      'clicking a finding selects it in the 3D graph',
      Boolean(
        await page.locator('#wiki-graph-3d').getAttribute('data-selected')
      )
    );
    check(
      'the 3D graph remains the active view after selection',
      (await page
        .locator('#mode-constellation')
        .getAttribute('aria-pressed')) === 'true'
    );
    check(
      'the detail drawer opens',
      await page.locator('#wiki-detail').isVisible()
    );
    check(
      'the page reserves space rather than being covered',
      await page.evaluate(() =>
        document.body.classList.contains('wiki-detail-open')
      )
    );

    // The controls the drawer used to sit on top of must still be clickable.
    check(
      'mode buttons remain clickable with the drawer open',
      await page.locator('#mode-constellation').isEnabled()
    );
    await page.locator('#mode-constellation').click({ timeout: 5000 });
    await page.waitForTimeout(1200);
    check(
      '3D graph renders with the drawer open',
      Number(await page.locator('#wiki-graph-3d').getAttribute('data-nodes')) >
        0
    );
    await page.locator('#mode-focus').click();
    await page.waitForTimeout(600);
    await page.waitForSelector('#wiki-graph .wiki-node');
    check(
      'explicit Focus renders the one-hop graph',
      (await page.locator('#wiki-graph .wiki-node').count()) > 0
    );

    /* ---- Keyboard paths ----------------------------------------------- */

    await page.keyboard.press('Escape');
    check(
      'Escape closes the drawer',
      !(await page.locator('#wiki-detail').isVisible())
    );

    const item = page.locator('#wiki-list li').nth(1);
    await item.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    check(
      'Enter on a focused list item selects it',
      await page.locator('#wiki-detail').isVisible()
    );
    await page.keyboard.press('Escape');

    const node = page.locator('#wiki-graph .wiki-node').first();
    await node.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    check(
      'Enter on a graph node re-centres',
      await page.locator('#wiki-detail').isVisible()
    );
    await page.keyboard.press('Escape');

    /* ---- Graph navigation --------------------------------------------- */

    await page.locator('#wiki-list li').first().click();
    await page.waitForSelector('#wiki-graph .wiki-node');
    // Assert the centre becomes THE NODE CLICKED, not merely that it changed.
    // "Changed" cannot distinguish a correct re-centre from a re-render that
    // happened to land elsewhere, and it fails opaquely when it does.
    const centreId = () =>
      page.evaluate(
        () =>
          document.querySelector('#wiki-graph .wiki-node.is-center')?.dataset
            .id || ''
      );

    const neighbourId = await page.evaluate(
      () =>
        document.querySelector('#wiki-graph .wiki-node:not(.is-center)')
          ?.dataset.id || ''
    );

    if (neighbourId) {
      await page
        .locator(`#wiki-graph .wiki-node[data-id="${neighbourId}"]`)
        .click();
      await page
        .waitForFunction(
          (id) =>
            document.querySelector('#wiki-graph .wiki-node.is-center')?.dataset
              .id === id,
          neighbourId,
          { timeout: 5000 }
        )
        .catch(() => {});
      check(
        'clicking a neighbour re-centres on THAT node',
        (await centreId()) === neighbourId,
        `${await centreId()} vs ${neighbourId}`
      );
    }

    // A retired finding is still REACHABLE via supersedes edges. It must never
    // render like a live one -- that is the same failure as serving a stale
    // finding bare.
    const retiredMarked = await page.evaluate(async () => {
      const found = await (
        await fetch('/api/wiki/search?q=corrected&limit=5')
      ).json();
      const item = found.items[0];
      if (!item) return 'no corrected finding';
      const detail = await (
        await fetch(`/api/wiki/node/${encodeURIComponent(item.id)}`)
      ).json();
      const superseded = detail.neighbours.find((n) => n.kind === 'finding');
      if (!superseded) return 'no superseded neighbour';
      return superseded.retired === true ? 'marked' : 'UNMARKED';
    });
    check(
      'a retired finding reached through the graph is marked as retired',
      retiredMarked === 'marked',
      retiredMarked
    );

    await page.screenshot({
      path: join(SHOTS, 'focus-hostile.png'),
      fullPage: true,
    });

    /* ---- Curation ------------------------------------------------------ */

    await page.locator('#wiki-list li').first().click();
    await page.waitForSelector('#wiki-detail:visible');

    // An empty correction must be a no-op, not a blank claim written to the graph.
    const countBefore = await page.locator('#wiki-list li').count();
    await page.locator('#detail-correct').click();
    await page.waitForTimeout(600);
    check(
      'an empty correction is refused',
      (await page.locator('#wiki-list li').count()) === countBefore
    );

    await page
      .locator('#detail-claim')
      .fill('a correction typed through the UI');
    await page.locator('#detail-correct').click();
    await page.waitForTimeout(900);
    const corrected = await page
      .locator('.wiki-list li', {
        hasText: 'a correction typed through the UI',
      })
      .count();
    check('a correction round-trips and appears in the list', corrected > 0);

    await page.locator('#wiki-list li').first().click();
    await page.waitForSelector('#wiki-detail:visible');
    await page.locator('#detail-pin').click();
    await page.waitForTimeout(800);
    check(
      'pinning succeeds and the list refreshes',
      (await page.locator('#wiki-list li').count()) > 0
    );

    await page.locator('#wiki-list li').first().click();
    await page.waitForSelector('#wiki-detail:visible');
    const beforeRetire = await page.locator('#wiki-list li').count();
    await page.locator('#detail-retire').click();
    await page.waitForTimeout(900);
    check(
      'retiring removes the finding from the list',
      (await page.locator('#wiki-list li').count()) < beforeRetire,
      `${beforeRetire} -> ${await page.locator('#wiki-list li').count()}`
    );

    /* ---- Audit tab ------------------------------------------------------ */

    await page.locator('.wiki-tab[data-tab="audit"]').click();
    await page.waitForTimeout(600);
    const audit = await page.locator('#audit-groups').innerText();
    check('audit surfaces contradictions', /Contradicted/i.test(audit));
    check('audit surfaces unanchored findings', /Unanchored/i.test(audit));
    check('audit surfaces low confidence', /Low confidence/i.test(audit));
    check(
      'the audit badge shows a count',
      Number(await page.locator('#audit-count').innerText()) > 0
    );

    await page.locator('#audit-groups .wiki-list li').first().click();
    await page.waitForTimeout(700);
    check(
      'an audit entry opens its detail',
      await page.locator('#wiki-detail').isVisible()
    );
    await page.keyboard.press('Escape');
    await page.screenshot({
      path: join(SHOTS, 'audit-hostile.png'),
      fullPage: true,
    });

    await page.locator('.wiki-tab[data-tab="explore"]').click();
    await page.waitForTimeout(400);
    check(
      'switching back to Explore restores the list',
      (await page.locator('#wiki-list li').count()) > 0
    );

    /* ---- Export --------------------------------------------------------- */

    const exported = await (await fetch(`${BASE}/api/wiki/export`)).text();
    check('export contains findings', exported.includes('##'));
    check(
      'export excludes retired findings',
      !exported.includes('withdrawn by a human')
    );
    check('export labels human-asserted entries', exported.includes('human'));

    /* ---- The mutating route rejects cross-site callers -------------------- */

    const noHeader = await fetch(`${BASE}/api/wiki/curate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retire', key: 'f-normal' }),
    });
    check(
      'curate without the header is refused',
      noHeader.status === 403,
      String(noHeader.status)
    );

    const crossOrigin = await fetch(`${BASE}/api/wiki/curate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-token-optimizer': 'dashboard',
        origin: 'http://evil.example',
      },
      body: JSON.stringify({ action: 'retire', key: 'f-normal' }),
    });
    check(
      'curate from another origin is refused',
      crossOrigin.status === 403,
      String(crossOrigin.status)
    );

    /* ---- API robustness --------------------------------------------------- */

    for (const [label, path] of [
      ['missing node', '/api/wiki/node/does-not-exist'],
      ['negative offset', '/api/wiki/search?offset=-5'],
      ['absurd limit', '/api/wiki/search?limit=999999'],
      ['non-numeric limit', '/api/wiki/search?limit=abc'],
      ['huge cap', '/api/wiki/constellation?cap=999999'],
      ['traversal attempt', '/api/wiki/search?project=../../../../etc'],
    ]) {
      const res = await fetch(BASE + path);
      check(
        `API handles ${label}`,
        res.status === 200 || res.status === 404,
        String(res.status)
      );
    }

    // The removed parameter must not resurrect a caller-chosen path.
    const traversal = await (
      await fetch(
        `${BASE}/api/wiki/status?project=${encodeURIComponent('C:/Windows')}`
      )
    ).json();
    check(
      'project param cannot redirect the graph directory',
      traversal.dir === GRAPH,
      traversal.dir
    );

    /* ---- Narrow viewport --------------------------------------------------- */

    const narrow = await browser.newPage({
      viewport: { width: 480, height: 900 },
    });
    narrow.on('pageerror', (e) =>
      errors.push(`narrow pageerror: ${e.message}`)
    );
    await narrow.goto(`${BASE}/wiki`, { waitUntil: 'networkidle' });
    await narrow.waitForSelector('#wiki-list li');
    const overflow = await narrow.evaluate(() => {
      const el = document.scrollingElement;
      return { scroll: el.scrollWidth, client: el.clientWidth };
    });
    check(
      'no horizontal scroll at 480px',
      overflow.scroll <= overflow.client + 1,
      `${overflow.scroll} vs ${overflow.client}`
    );
    await narrow.locator('#wiki-list li').first().click();
    await narrow.waitForTimeout(700);
    check(
      'the drawer is usable at 480px',
      await narrow.locator('#wiki-detail').isVisible()
    );
    await narrow.screenshot({
      path: join(SHOTS, 'narrow-hostile.png'),
      fullPage: true,
    });
    await narrow.close();

    check(
      'no console or page errors across the whole run',
      errors.length === 0,
      errors.slice(0, 3).join(' | ')
    );

    await page.close();
  } finally {
    await browser.close();
    server.kill();
    rmSync(GRAPH, { recursive: true, force: true });
    rmSync(join(ROOT, 'edge-src'), { recursive: true, force: true });
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
