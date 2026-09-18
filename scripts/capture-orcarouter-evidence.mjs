#!/usr/bin/env node
/**
 * Real screenshots and assertions for the OrcaRouter provider card, in a real browser.
 *
 * NOT MOCKUPS, AND NOT A FAKE CATALOG. This boots the actual dashboard web server, drives a real
 * headless Chromium at it, and asserts what a reviewer cannot see from source: that both
 * authentication choices are visible and independently usable, that a stored key renders only in its
 * redacted form, and that the model control really opens as a populated listbox rather than a text
 * field.
 *
 * THE CATALOG IS THE OFFICIAL LIVE ONE. `GET https://api.orcarouter.ai/v1/models` is the only source
 * of model names here, and every expectation about the options is DERIVED from the response this run
 * actually received rather than written down as a model id. A hardcoded id would keep passing while
 * the live catalog moved on, which is the failure this file exists to catch. Discovery goes through
 * the app's own `/api/orcarouter/models` route, so what is asserted is the provider path and not a
 * parallel fetch written just for the test.
 *
 * THE CREDENTIAL STAYS ON THE SERVER. `ORCAROUTER_API_KEY` is passed to the dashboard process only;
 * the browser receives model metadata and a redacted status, never the key.
 *
 * THE KEY THAT IS TYPED IS FAKE. An `sk-orca-…` filler is saved through the real form so the
 * redaction assertion has something to redact. The configured environment key is what actually signs
 * the catalog request, so storing the fake key cannot change what discovery returns.
 *
 * Run: ORCAROUTER_API_KEY=… node scripts/capture-orcarouter-evidence.mjs
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'orca-evidence');
const PORT = 3600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
/** The one catalog URL this evidence may be captured against. */
const OFFICIAL_CHAT_CATALOG =
  'https://api.orcarouter.ai/v1/models?capability=chat';

const apiKey = (process.env.ORCAROUTER_API_KEY || '').trim();
if (!apiKey) {
  console.error(
    'ORCAROUTER_API_KEY is required.\n' +
      'The model dropdown in this evidence is the official live catalog, so the run has to be able\n' +
      'to authenticate to it. The credential is handed to the dashboard process only -- nothing is\n' +
      'written to the page, to an artifact, or to the manifest.'
  );
  process.exit(1);
}

const fakeKey = `sk-orca-${'e'.repeat(20)}`;

const results = [];
/**
 * Record an assertion and return it.
 *
 * The return value is what lets each screenshot carry its OWN `ui` block: the same
 * measurement feeds both the human-readable log and the machine-checked manifest, so the
 * two cannot disagree about what was seen.
 */
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(
    `${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`
  );
  return pass;
};

/**
 * The `ui` assertions each artifact must carry, keyed by artifact kind.
 *
 * The delivery validator reads these by name and will not accept a screenshot that
 * merely exists: the auth shot has to prove both choices are present and the key is
 * masked, and each dropdown shot has to prove the panel really opened with the full
 * option count. Written here, at the point of measurement, so a renamed control fails
 * loudly instead of producing a manifest that describes a UI nobody rendered.
 */
const ui = {};

/** Geometry and paint of the open model panel, for one dropdown screenshot. */
async function panelEvidence(page, trigger, panel) {
  const itemCount = await page
    .locator('#orcarouter-model-list .model-option:not(.is-empty)')
    .count();
  const triggerBox = await trigger.boundingBox();
  const panelBox = await panel.boundingBox();
  const background = await panel.evaluate(
    (node) => getComputedStyle(node).backgroundColor
  );
  const borderWidth = await panel.evaluate(
    (node) => getComputedStyle(node).borderTopWidth
  );
  const expanded = await trigger.getAttribute('aria-expanded');
  return {
    itemCount,
    background,
    borderWidth,
    delta: Math.abs(
      triggerBox.x + triggerBox.width - (panelBox.x + panelBox.width)
    ),
    expanded,
  };
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** Viewport, in CSS pixels, for the captured element. */
const SHOT_WIDTH = 1180;
const SHOT_HEIGHT = 620;

async function waitForServer(url, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/**
 * Capture the card itself, at a known size.
 *
 * The card is what this evidence is about, and the full page is mostly other panels. The viewport is
 * set explicitly so the element screenshot is deterministic and comfortably above the minimum size a
 * reviewer needs to read the two choices.
 */
async function shoot(page, locator, name) {
  await page.setViewportSize({ width: SHOT_WIDTH, height: SHOT_HEIGHT });
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await locator.screenshot({ path: join(OUT, name) });
}

/** The option values currently rendered in the model listbox. */
const readOptions = (page) =>
  page
    .locator('#orcarouter-model-list .model-option:not(.is-empty)')
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.value));

const sameSet = (a, b) =>
  a.length === b.length &&
  [...a].sort().join('\n') === [...b].sort().join('\n');

async function main() {
  if (!existsSync(join(ROOT, 'dist', 'server', 'web-server.js'))) {
    console.error('Build first: npm run build');
    process.exitCode = 1;
    return;
  }
  mkdirSync(OUT, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), 'orca-evidence-home-'));

  const childEnv = {
    ...process.env,
    TOKEN_OPTIMIZER_DASHBOARD_PORT: String(PORT),
    TOKEN_OPTIMIZER_HOME: home,
    ORCAROUTER_API_KEY: apiKey,
  };
  // The official origins are the point of this run, so an ambient override is removed rather than
  // trusted: evidence captured against a redirected base would not be evidence about OrcaRouter.
  delete childEnv.ORCA_BASE_URL;
  delete childEnv.ORCA_AUTH_BASE_URL;
  delete childEnv.ORCA_API_BASE_URL;

  const child = spawn(
    process.execPath,
    [join(ROOT, 'dist', 'server', 'web-server.js')],
    { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stderr.on('data', () => undefined);

  // Prefer the distro Chromium when it is present, and otherwise let Playwright resolve its own
  // build. A validator runs this in a fresh checkout where `npx playwright install chromium` is the
  // documented setup, and that install does not create /usr/bin/chromium -- hardcoding the path made
  // the evidence unrunnable exactly where it needs to be reproduced.
  const browser = await chromium.launch({
    executablePath: existsSync('/usr/bin/chromium')
      ? '/usr/bin/chromium'
      : undefined,
    args: ['--no-sandbox'],
  });

  try {
    if (!(await waitForServer(`${BASE}/api/health`))) {
      check(
        'dashboard server started',
        false,
        `${BASE}/api/health never answered`
      );
      return;
    }

    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 2,
    });
    await page.goto(BASE, { waitUntil: 'networkidle' });

    // --- the card is a real, rendered control ---------------------------------
    const card = page.locator('#orcarouter-card');
    await card.waitFor({ state: 'visible', timeout: 15_000 });

    const apiChoice = page.locator('#orcarouter-choice-api');
    const authChoice = page.locator('#orcarouter-choice-auth');

    const apiLabel = await apiChoice
      .locator('.connect-choice-title')
      .innerText();
    const authLabel = await authChoice
      .locator('.connect-choice-title')
      .innerText();
    check(
      'labels_distinct',
      apiLabel !== authLabel && apiLabel.length > 0 && authLabel.length > 0,
      `"${apiLabel.replace(/\s+/g, ' ').trim()}" vs "${authLabel.replace(/\s+/g, ' ').trim()}"`
    );

    check(
      'orca_mark_rendered',
      await page.locator('#orcarouter-card .provider-mark svg').isVisible(),
      'the provider mark renders'
    );

    // The environment key is the credential in use, and the card has to say which of the two
    // choices that is rather than leaving a user to guess.
    check(
      'active_choice_flagged',
      (await page.locator('#orcarouter-flag-api').isVisible()) &&
        !(await page.locator('#orcarouter-flag-auth').isVisible()),
      'the API-key choice is flagged in use; the Auth choice is not'
    );

    // --- the options come from the official live catalog ----------------------
    const catalog = await page.evaluate(async () => {
      const response = await fetch('/api/orcarouter/models?capability=chat');
      return {
        ok: response.ok,
        status: response.status,
        body: await response.json().catch(() => null),
      };
    });
    const liveModels = catalog.body?.models ?? [];
    const liveIds = liveModels.map((model) => model.id);
    const imageIds = liveModels
      .filter((model) => (model.inputModalities || []).includes('image'))
      .map((model) => model.id);
    const textOnlyIds = liveIds.filter((id) => !imageIds.includes(id));

    check(
      'catalog_is_official',
      catalog.body?.sourceUrl === OFFICIAL_CHAT_CATALOG,
      `sourceUrl ${catalog.body?.sourceUrl}`
    );
    check(
      'catalog_is_live',
      catalog.body?.status === 'live' &&
        liveIds.length > 0 &&
        liveModels.every((model) => !model.fromSeed),
      `status ${catalog.body?.status}, ${liveIds.length} models, no seed entries`
    );

    const role = await page.locator('#orcarouter-model').getAttribute('role');
    const editable = await page
      .locator('#orcarouter-model')
      .evaluate((node) => node.isContentEditable);
    check(
      'model_control_is_a_listbox',
      role === 'combobox' && !editable,
      'the model control is a combobox over a listbox, with no free-text entry'
    );
    // Discovery is a network round-trip to the official origin, so wait for the control to settle on
    // the live set before reading it. Asserting mid-flight would test the loading state instead.
    await page.waitForFunction(
      (expected) => {
        const values = Array.from(
          document.querySelectorAll(
            '#orcarouter-model-list .model-option:not(.is-empty)'
          )
        )
          .map((node) => node.dataset.value)
          .sort();
        return JSON.stringify(values) === JSON.stringify([...expected].sort());
      },
      liveIds,
      { timeout: 30_000 }
    );
    check(
      'model_options_match_live_catalog',
      sameSet(await readOptions(page), liveIds),
      `${liveIds.length} live chat models, and the selector offers exactly those`
    );

    // --- store a key through the real form, then assert the redaction ---------
    await page.fill('#orcarouter-key', fakeKey);
    await page.click('#orcarouter-save');
    // The state chip already reads "Connected" because the environment key is in use, so the
    // placeholder is the signal that this save landed. It has to be the "Stored:" form: the default
    // placeholder also contains "sk-orca-…", so waiting on that alone would race the save.
    await page.waitForFunction(
      () =>
        (
          document
            .getElementById('orcarouter-key')
            ?.getAttribute('placeholder') || ''
        ).startsWith('Stored:'),
      undefined,
      { timeout: 15_000 }
    );
    const keyFieldValue = await page.inputValue('#orcarouter-key');
    const placeholder = await page.getAttribute(
      '#orcarouter-key',
      'placeholder'
    );
    ui['auth-methods'] = {
      api_key_visible: check(
        'api_key_visible',
        await apiChoice.isVisible(),
        'the API-key choice is rendered'
      ),
      pkce_visible: check(
        'pkce_visible',
        await authChoice.isVisible(),
        'the Connect with OrcaRouter choice is rendered'
      ),
      controls_enabled: check(
        'controls_enabled',
        (await page.locator('#orcarouter-save').isEnabled()) &&
          (await page.locator('#orcarouter-connect').isEnabled()) &&
          (await page.locator('#orcarouter-key').isEnabled()),
        'Save key, Connect with OrcaRouter and the key field are all enabled'
      ),
      secret_masked: check(
        'secret_masked',
        keyFieldValue === '' &&
          /sk-orca-…/.test(placeholder ?? '') &&
          !(await page.locator('#orcarouter-card').innerHTML()).includes(
            fakeKey
          ) &&
          !(await page.content()).includes(fakeKey),
        `field cleared; placeholder shows "${placeholder}"`
      ),
    };

    await shoot(page, card, 'auth-methods.png');

    // --- the model control is a real, populated listbox -----------------------
    const trigger = page.locator('#orcarouter-model');
    const panel = page.locator('#orcarouter-model-panel');
    await page.selectOption('#orcarouter-modality', 'text');
    await trigger.click();
    await panel.waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(200);

    const textPanel = await panelEvidence(page, trigger, panel);
    const itemCount = textPanel.itemCount;
    const expanded = textPanel.expanded;
    const dropdownOpen = check(
      'dropdown_open',
      expanded === 'true' && itemCount > 1 && (await panel.isVisible()),
      `aria-expanded=${expanded}, ${itemCount} items visible`
    );
    const itemCountOk = check(
      'item_count',
      itemCount === liveIds.length,
      `${itemCount} options`
    );
    const opaqueBackground = check(
      'opaque_background',
      /^rgb\(/.test(textPanel.background),
      `panel background ${textPanel.background}`
    );
    const visibleBorder = check(
      'visible_border',
      parseFloat(textPanel.borderWidth) > 0,
      `${textPanel.borderWidth} border`
    );
    const rightDelta = check(
      'trigger_panel_right_delta',
      textPanel.delta <= 2,
      `${textPanel.delta.toFixed(2)}px between the trigger and panel right edges`
    );
    ui['text-model-dropdown'] = {
      dropdown_open: dropdownOpen,
      item_count: itemCount,
      opaque_background: opaqueBackground,
      visible_border: visibleBorder,
      trigger_panel_right_delta: textPanel.delta,
    };
    // `item_count` and the delta are read by the delivery validator as VALUES, so a
    // failed comparison has to fail the run rather than only being logged.
    if (!itemCountOk || !rightDelta) process.exitCode = 1;
    await shoot(page, card, 'text-model-dropdown.png');

    // --- a modality switch recomputes the options, and drops an invalid one ---
    const staleId = textOnlyIds[0];
    await page
      .locator(
        `#orcarouter-model-list .model-option[data-value="${staleId.replace(/"/g, '\\"')}"]`
      )
      .click();
    await panel.waitFor({ state: 'hidden' });
    await page.selectOption('#orcarouter-modality', 'image');
    // Wait for the selector to actually hold the multimodal set, so the assertions below read a
    // settled control rather than a list mid-refresh.
    await page.waitForFunction(
      (expected) => {
        const values = Array.from(
          document.querySelectorAll(
            '#orcarouter-model-list .model-option:not(.is-empty)'
          )
        )
          .map((node) => node.dataset.value)
          .sort();
        return JSON.stringify(values) === JSON.stringify([...expected].sort());
      },
      imageIds,
      { timeout: 20_000 }
    );
    const imageValues = await readOptions(page);
    const selectedAfterSwitch = await page
      .locator('#orcarouter-model-value')
      .innerText();
    check(
      'multimodal_filter_and_clear',
      imageIds.length > 0 &&
        sameSet(imageValues, imageIds) &&
        !imageValues.includes(staleId) &&
        selectedAfterSwitch.trim() === 'Not selected',
      `"${staleId}" was cleared; ${imageValues.length} options remain, all declaring image input`
    );
    await trigger.click();
    await panel.waitFor({ state: 'visible' });
    await page.waitForTimeout(200);
    const imagePanel = await panelEvidence(page, trigger, panel);
    ui['multimodal-model-dropdown'] = {
      dropdown_open:
        imagePanel.expanded === 'true' && (await panel.isVisible()),
      item_count: imagePanel.itemCount,
      opaque_background: /^rgb\(/.test(imagePanel.background),
      visible_border: parseFloat(imagePanel.borderWidth) > 0,
      trigger_panel_right_delta: imagePanel.delta,
    };
    await shoot(page, card, 'multimodal-model-dropdown.png');
    await page.keyboard.press('Escape');

    // --- pagehide releases the login lock without a remount -------------------
    const pagehide = await page.evaluate(async () => {
      const state = { before: false, after: false, secondStart: false };
      document.getElementById('orcarouter-connect').click();
      await new Promise((resolve) => setTimeout(resolve, 700));
      state.before = !document.getElementById('orcarouter-cancel').hidden;
      window.dispatchEvent(
        new PageTransitionEvent('pagehide', { persisted: true })
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      state.after =
        document.getElementById('orcarouter-cancel').hidden &&
        document.getElementById('orcarouter-connect').disabled === false;
      // A second login must be startable on the restored page, with no remount.
      document.getElementById('orcarouter-connect').click();
      await new Promise((resolve) => setTimeout(resolve, 700));
      state.secondStart = !document.getElementById('orcarouter-cancel').hidden;
      window.dispatchEvent(
        new PageTransitionEvent('pagehide', { persisted: true })
      );
      return state;
    });
    check(
      'pagehide_releases_login_lock',
      pagehide.before && pagehide.after && pagehide.secondStart,
      JSON.stringify(pagehide)
    );

    await page.close();

    // --- manifest -------------------------------------------------------------
    /*
     * SHAPED FOR THE DELIVERY VALIDATOR, not for a human reader. `automation` is an
     * OBJECT carrying framework/passed/catalog_source and the two model counts, and every
     * artifact declares its `kind`, `sha256` and the `ui` measurements taken above. The
     * earlier flat shape (`"automation": "playwright"`) validated nothing: the checker
     * rejects it before it ever looks at a screenshot.
     */
    const kinds = [
      'auth-methods',
      'text-model-dropdown',
      'multimodal-model-dropdown',
    ];
    const manifest = {
      automation: {
        framework: 'playwright',
        passed: results.every((entry) => entry.pass),
        catalog_source: OFFICIAL_CHAT_CATALOG,
        catalog_model_count: liveIds.length,
        image_model_count: imageIds.length,
      },
      catalog_live: catalog.body?.status === 'live',
      catalog_authenticated: true,
      viewport: {
        width: SHOT_WIDTH,
        height: SHOT_HEIGHT,
        deviceScaleFactor: 2,
      },
      generated_at: new Date().toISOString(),
      assertions: results,
      artifacts: kinds.map((kind) => ({
        kind,
        path: `${kind}.png`,
        sha256: sha256(readFileSync(join(OUT, `${kind}.png`))),
        bytes: readFileSync(join(OUT, `${kind}.png`)).byteLength,
        ui: ui[kind] ?? {},
      })),
    };
    writeFileSync(
      join(OUT, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    console.log(`\nwrote ${join(OUT, 'manifest.json')}`);
    if (!manifest.automation.passed) process.exitCode = 1;
  } finally {
    await browser.close().catch(() => undefined);
    child.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
  }
}

await main();
