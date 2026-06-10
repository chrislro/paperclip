// scripts/test-sidepanel-prontuario-guards.js — CHRA-2423 Bugs 63–64
//
// Run with: node --test scripts/test-sidepanel-prontuario-guards.js
//
// Source-level regression guards for two sidepanel-prontuario.js fixes:
//
//  Bug 63 — applyBtn async click handler lacked try/finally, so
//  `applyBtn.disabled = false` was never reached when send() threw.
//  The button stayed permanently disabled for the rest of the session.
//
//  Bug 64 — chrome.tabs.onUpdated.addListener fired refreshPatient()
//  for every tab completion in the browser (Gmail, MDN, etc.), not just
//  the G-Hosp tab.  Added `tabId === state.activeTabId` guard.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(ROOT, 'sidepanel/sidepanel-prontuario.js'), 'utf8');

// ---------------------------------------------------------------------------
// Bug 63 — applyBtn handler must use try/finally to re-enable button
// ---------------------------------------------------------------------------
test('Bug 63: applyBtn handler uses try/finally to guarantee re-enable', () => {
  // The critical pattern: applyBtn.disabled = false must be inside a finally
  // block so it runs even when send() rejects.
  const hasTryFinally = /applyBtn\.disabled\s*=\s*true[\s\S]{1,600}try\s*\{[\s\S]{1,600}finally\s*\{[\s\S]{1,200}applyBtn\.disabled\s*=\s*false/.test(SRC);
  assert.ok(hasTryFinally,
    'applyBtn handler must have try/finally with applyBtn.disabled=false in finally block');
});

test('Bug 63: applyBtn handler has no top-level awaited send before try', () => {
  // The old bug pattern was: applyBtn.disabled = true; const r = await send(...);
  // applyBtn.disabled = false  — the last line only ran if send() resolved.
  // Verify there is NO `await send(` between `applyBtn.disabled = true` and a
  // try block (i.e., the await is now INSIDE the try).
  const badPattern = /applyBtn\.disabled\s*=\s*true\s*;[\s\S]{0,50}const r\s*=\s*await send\([^)]*\)\s*;[\s\S]{0,50}applyBtn\.disabled\s*=\s*false\s*;(?![\s\S]*finally)/.test(SRC);
  assert.ok(!badPattern,
    'applyBtn handler must NOT have top-level await send() outside a try block');
});

// ---------------------------------------------------------------------------
// Bug 64 — chrome.tabs.onUpdated must guard on state.activeTabId
// ---------------------------------------------------------------------------
test('Bug 64: chrome.tabs.onUpdated.addListener guards on state.activeTabId', () => {
  // The fixed pattern requires both conditions in the if-guard.
  const hasGuard = /chrome\.tabs\.onUpdated\.addListener\(\s*\(tabId,\s*info\)\s*=>\s*\{[^}]*state\.activeTabId/.test(SRC);
  assert.ok(hasGuard,
    'chrome.tabs.onUpdated listener must check state.activeTabId');
});

test('Bug 64: onUpdated listener has status===complete AND tabId===state.activeTabId', () => {
  // Verify both conditions are present in the same listener callback.
  const idx = SRC.indexOf('chrome.tabs.onUpdated.addListener');
  assert.ok(idx !== -1, 'chrome.tabs.onUpdated.addListener must exist');
  // Extract a window of ~200 chars after the listener declaration.
  const snippet = SRC.slice(idx, idx + 500);
  assert.ok(/info\.status\s*===\s*['"]complete['"]/.test(snippet),
    'onUpdated listener must check info.status === "complete"');
  assert.ok(/tabId\s*===\s*state\.activeTabId/.test(snippet),
    'onUpdated listener must check tabId === state.activeTabId');
});
