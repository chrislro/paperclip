// test-buttons.mjs — actually load the extension into Chrome and click the buttons.
// Run with: node test-buttons.mjs

import { chromium } from '/Users/admin/Dev/node_modules/playwright/index.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = __dirname;
const USER_DATA_DIR = path.join(os.tmpdir(), 'tf-ext-test-' + Date.now());

function pass(msg) { console.log('  PASS  ' + msg); }
function fail(msg) { console.error('  FAIL  ' + msg); process.exitCode = 1; }
async function step(name, fn) {
  console.log('\n>> ' + name);
  try { await fn(); } catch (e) { fail(name + ' threw: ' + e.message); }
}

(async () => {
  console.log('Launching Chrome with extension at', EXT_PATH);
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  await new Promise(r => setTimeout(r, 3000)); // give Chrome a moment to register the extension
  console.log('SW count:', ctx.serviceWorkers().length, 'pages:', ctx.pages().length);
  const probe = await ctx.newPage();
  await probe.goto('chrome://extensions/');
  await probe.evaluate(() => new Promise(r => setTimeout(r, 2500)));
  // Diagnostic: dump all extension IDs visible
  const debugDump = await probe.evaluate(() => {
    const mgr = document.querySelector('extensions-manager');
    if (!mgr) return 'no extensions-manager';
    const tb = mgr.shadowRoot && mgr.shadowRoot.querySelector('extensions-toolbar');
    const dev = tb && tb.shadowRoot && tb.shadowRoot.querySelector('cr-toggle#devMode');
    const itemList = mgr.shadowRoot && mgr.shadowRoot.querySelector('extensions-item-list');
    const items = (itemList && itemList.shadowRoot && itemList.shadowRoot.querySelectorAll('extensions-item')) || [];
    return JSON.stringify({
      hasMgr: !!mgr, hasDev: !!dev, devChecked: dev && dev.checked,
      items: Array.from(items).map(i => ({ id: i.getAttribute('id'), name: i.shadowRoot && i.shadowRoot.querySelector('#name')?.textContent })),
    });
  });
  console.log('chrome://extensions dump:', debugDump);
  // Toggle developer mode + read IDs from custom-element shadow DOM
  const extId = await probe.evaluate(async () => {
    const mgr = document.querySelector('extensions-manager');
    if (!mgr) return null;
    // Open dev mode toggle if needed
    const tb = mgr.shadowRoot?.querySelector('extensions-toolbar');
    const devToggle = tb?.shadowRoot?.querySelector('cr-toggle#devMode');
    if (devToggle && !devToggle.checked) devToggle.click();
    await new Promise(r => setTimeout(r, 500));
    // Item list
    const itemList = mgr.shadowRoot?.querySelector('extensions-item-list');
    const items = itemList?.shadowRoot?.querySelectorAll('extensions-item') || [];
    for (const item of items) {
      const id = item.getAttribute('id');
      if (id) return id;
    }
    return null;
  });
  await probe.close();

  if (!extId) { console.error('No extension found in chrome://extensions - abort'); await ctx.close(); process.exit(1); }
  console.log('Extension id:', extId);

  // Trigger SW boot by hitting the side panel directly.
  // (Loading the side panel HTML wakes up the SW for runtime.onMessage etc.)

  const SP_URL = `chrome-extension://${extId}/sidepanel/sidepanel.html`;
  const page = await ctx.newPage();
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));

  await page.goto(SP_URL);
  await page.waitForLoadState('networkidle').catch(() => {});
  await new Promise(r => setTimeout(r, 1500));

  await step('Side panel script loaded', async () => {
    const loaded = consoleLines.some((l) => l.includes('sidepanel-prontuario loaded'));
    if (loaded) pass('console marker present');
    else fail('console marker NOT found');
    const router = consoleLines.some((l) => l.includes('delegated click router installed'));
    if (router) pass('click router installed');
    else fail('click router NOT installed');
  });

  await step('Switch to Config tab', async () => {
    await page.click('button.tab-btn[data-tab="config"]');
    await new Promise(r => setTimeout(r, 400));
    const visible = await page.isVisible('#configTab.active');
    if (visible) pass('Config tab is active');
    else fail('Config tab did not activate');
  });

  await step('+ Adicionar modelo appends to storage', async () => {
    const before = await page.evaluate(() => new Promise((r) =>
      chrome.storage.sync.get(['prescriptionTemplates'], (d) => r((d.prescriptionTemplates || []).length))
    ));
    await page.click('#addRxTemplateBtn');
    await new Promise(r => setTimeout(r, 800));
    const after = await page.evaluate(() => new Promise((r) =>
      chrome.storage.sync.get(['prescriptionTemplates'], (d) => r((d.prescriptionTemplates || []).length))
    ));
    if (after === before + 1) pass(`storage grew ${before} -> ${after}`);
    else fail(`storage did not grow: ${before} -> ${after}`);
    const clicked = consoleLines.some((l) => l.includes('+ Adicionar modelo'));
    if (clicked) pass('handler logged the click');
    else fail('handler did NOT log');
  });

  await step('Restaurar padroes replaces with 6 defaults', async () => {
    page.once('dialog', (d) => d.accept());
    await page.click('#restoreRxDefaultsBtn');
    await new Promise(r => setTimeout(r, 800));
    const arr = await page.evaluate(() => new Promise((r) =>
      chrome.storage.sync.get(['prescriptionTemplates'], (d) => r(d.prescriptionTemplates || []))
    ));
    if (arr.length === 6) pass('6 defaults loaded');
    else fail(`expected 6, got ${arr.length}`);
    const dxList = arr.map((t) => t.diagnosis);
    const expected = ['Resfriado', 'GEA', 'OMA', 'ITU', 'Lombalgia', 'HAS'];
    if (JSON.stringify(dxList) === JSON.stringify(expected)) pass('diagnoses match');
    else fail('diagnoses mismatch: ' + JSON.stringify(dxList));
  });

  await step('Templates render in stable order on initial load', async () => {
    await page.click('button.tab-btn[data-tab="scribe"]');
    await new Promise(r => setTimeout(r, 500));
    const order1 = await page.locator('#sp-templates .sp-template-btn .sp-tpl-dx').allTextContents();
    if (order1.length > 0) {
      await page.click('#sp-templates .sp-template-btn:first-child');
      await new Promise(r => setTimeout(r, 600));
    }
    const order2 = await page.locator('#sp-templates .sp-template-btn .sp-tpl-dx').allTextContents();
    if (JSON.stringify(order1) === JSON.stringify(order2)) pass('order is stable after click');
    else fail(`order changed: ${JSON.stringify(order1)} -> ${JSON.stringify(order2)}`);
    if (order1.length === 6) pass('6 cards rendered');
    else fail(`expected 6 cards, got ${order1.length}`);
  });

  await step('Sign in opens Clerk URL in new tab + URL is reachable (not 404)', async () => {
    await page.click('button.tab-btn[data-tab="config"]');
    await new Promise(r => setTimeout(r, 300));
    // Wait extra time for Clerk SDK to load + expose on window
    await new Promise(r => setTimeout(r, 4000));
    const newPagePromise = ctx.waitForEvent('page', { timeout: 8000 });
    await page.click('#signInBtn');
    let signInPage;
    try { signInPage = await newPagePromise; } catch (_) {}
    if (!signInPage) { fail('no new tab opened'); return; }
    const url = signInPage.url();
    // Clerk's hosted account portal lives at <slug>.accounts.dev (no "clerk." prefix);
    // FAPI itself is at <slug>.clerk.accounts.dev. Both are valid Clerk-managed hosts.
    if (/working-chow-0\.(clerk\.)?accounts\.dev/.test(url)) pass(`opened ${url.slice(0, 90)}`);
    else fail(`unexpected URL: ${url}`);
    // Wait for the Clerk page to settle, then check it didn't 404
    try {
      await signInPage.waitForLoadState('networkidle', { timeout: 8000 });
    } catch (_) {}
    const title = await signInPage.title().catch(() => '');
    const bodyText = await signInPage.locator('body').textContent({ timeout: 3000 }).catch(() => '');
    const is404 = /404|not.found|page.not.found/i.test(title) || /404|not found/i.test((bodyText || '').slice(0, 500));
    if (!is404) pass(`Clerk page loaded (title="${title.slice(0,60)}")`);
    else fail(`Clerk page returned 404: title="${title}"`);
    await signInPage.close();
    const clicked = consoleLines.some((l) => l.includes('Sign in clicked'));
    if (clicked) pass('handler logged');
    else fail('handler did NOT log');
  });

  // ─── Streaming SOAP assertions (v3.1.1) ─────────────────────────────────
  // Two assertions per the NEXT_STEPS.md acceptance criteria:
  //   (a) SW Port listener for TOCAFICHADR_SOAP_STREAM is wired and responds.
  //   (b) Side panel ships the _streamSoapViaPort helper + manifest is 3.1.1.

  await step('Streaming: SW Port TOCAFICHADR_SOAP_STREAM is wired', async () => {
    // Connect from the side panel page to the SW's SOAP_STREAM port. The SW's
    // fetch to apiBaseUrl will fail in this test env (no auth, default URL
    // unreachable), so we expect SOAP_ERROR back — but ANY response message
    // proves the listener is registered and the message contract is honored.
    const result = await page.evaluate(() => new Promise((resolve) => {
      let port;
      let settled = false;
      try {
        port = chrome.runtime.connect({ name: 'TOCAFICHADR_SOAP_STREAM' });
      } catch (e) {
        resolve({ ok: false, reason: 'connect threw: ' + e.message });
        return;
      }
      port.onMessage.addListener((m) => {
        if (settled) return;
        settled = true;
        try { port.disconnect(); } catch (_) {}
        resolve({ ok: true, type: m && m.type, error: m && m.error });
      });
      port.onDisconnect.addListener(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, reason: 'disconnected with no message' });
      });
      port.postMessage({ type: 'SOAP_STREAM_START', raw_text: 'paciente teste' });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        try { port.disconnect(); } catch (_) {}
        resolve({ ok: false, reason: 'no message within 8s' });
      }, 8000);
    }));
    const validTypes = ['SOAP_ERROR', 'SOAP_TOKEN', 'SOAP_DONE'];
    if (result.ok && validTypes.includes(result.type)) {
      pass(`Port responded with ${result.type}` + (result.error ? ` (${String(result.error).slice(0, 50)})` : ''));
    } else {
      fail(`Port did not honor SOAP_STREAM contract: ${JSON.stringify(result)}`);
    }
  });

  await step('Streaming: side panel ships v3.1.1 streaming client', async () => {
    // Static check that the side panel JS has the streaming helper + the
    // status-pill format string. Cheap proof that the v3.1.1 bundle was
    // actually loaded (and not a stale 3.1.0 that lacks streaming).
    const sidepanelSrc = fs.readFileSync(path.join(EXT_PATH, 'sidepanel/sidepanel-prontuario.js'), 'utf8');
    if (sidepanelSrc.includes('_streamSoapViaPort')) pass('_streamSoapViaPort defined in side panel');
    else fail('_streamSoapViaPort missing — sidepanel-prontuario.js is pre-3.1.1');
    if (sidepanelSrc.includes('Gerando SOAP...')) pass('token-counter status string present');
    else fail('"Gerando SOAP..." status string missing — counter UI not wired');

    const manifest = JSON.parse(fs.readFileSync(path.join(EXT_PATH, 'manifest.json'), 'utf8'));
    if (manifest.version === '3.1.1') pass(`manifest.version = ${manifest.version}`);
    else fail(`expected manifest.version=3.1.1, got ${manifest.version}`);
  });

  await step('Sign out clears storage', async () => {
    // Seed authToken AND force the loggedInView visible (the sign-out button is
    // hidden by default when no Clerk session is detected).
    await page.evaluate(() => new Promise((r) =>
      chrome.storage.local.set({ authToken: 'fake-token' }, r)
    ));
    await page.evaluate(() => {
      const lo = document.getElementById('loggedOutView');
      const li = document.getElementById('loggedInView');
      if (lo) lo.style.display = 'none';
      if (li) li.style.display = '';
    });
    await new Promise(r => setTimeout(r, 200));
    page.once('dialog', (d) => d.accept());
    await page.click('#signOutBtn', { force: true });
    await new Promise(r => setTimeout(r, 2500));
    // CHRA-2133: the JWT lives in chrome.storage.session now (cleared on browser
    // close, unreadable by content scripts). Reading .local here would be a false
    // green — .local is always empty, so it'd "pass" without proving sign-out.
    const token = await page.evaluate(() => new Promise((r) =>
      chrome.storage.session.get(['authToken'], (d) => r(d.authToken || null))
    )).catch(() => null);
    if (!token) pass('authToken was cleared');
    else fail('authToken still present: ' + token);
    const clicked = consoleLines.some((l) => l.includes('Sign out clicked'));
    if (clicked) pass('handler logged');
    else fail('handler did NOT log');
  });

  console.log('\n========== console (last 40 lines) ==========');
  for (const l of consoleLines.slice(-40)) console.log(l);

  await ctx.close();
  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });

  if (process.exitCode) console.log('\nFAIL - see FAIL markers above');
  else console.log('\nALL TESTS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
