// scripts/test-injection-deps.js — tripwires for the popup's dynamic G-Hosp
// content-script registration (chrome.scripting.registerContentScripts).
//
// Run with: node --test scripts/test-injection-deps.js
//
// WHY THIS EXISTS (CHRA-2423 Bug 28):
//   The popup's "Automação G-Hosp" toggle registers content scripts for the
//   *.g-hosp.com.br WILDCARD. The static manifest content_scripts only match
//   the single prbentogoncalves subdomain, so on ANY other G-Hosp subdomain the
//   dynamic list is the ONLY thing that runs. Content scripts share one isolated
//   world per frame and leak top-level `function`/`var`/`window.*` globals to
//   the scripts injected AFTER them — so a consumer script that references a
//   global defined by another file will throw ReferenceError (or read undefined)
//   unless its provider is present AND injected earlier in the array.
//
//   The original list injected api-client.js (calls _normalizeApiError unguarded)
//   without error-helpers.js (the sole definer) → ReferenceError on every API
//   error path on non-prbentogoncalves subdomains. This test fails against that
//   regression and passes once the provider is present and correctly ordered.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const POPUP_SRC = fs.readFileSync(path.join(ROOT, 'popup/popup.src.js'), 'utf8');

// Extract the js: [...] array from the tocafichadr-ghosp registerContentScripts call.
function getDynamicInjectionList() {
  const block = POPUP_SRC.match(/registerContentScripts\(\[\{[\s\S]*?id:\s*'tocafichadr-ghosp'[\s\S]*?\}\]\)/);
  assert.ok(block, 'tocafichadr-ghosp registerContentScripts block not found');
  const jsArr = block[0].match(/js:\s*\[([^\]]+)\]/);
  assert.ok(jsArr, 'js: [...] array not found in dynamic registration');
  return jsArr[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

// Assert `provider` is present in the list AND appears before EVERY `consumer`.
function assertProviderPrecedesConsumers(list, provider, consumers, why) {
  const pIdx = list.indexOf(provider);
  assert.notEqual(pIdx, -1, `${provider} missing from dynamic injection list (${why})`);
  for (const consumer of consumers) {
    const cIdx = list.indexOf(consumer);
    if (cIdx === -1) continue; // consumer not injected here → nothing to satisfy
    assert.ok(
      pIdx < cIdx,
      `${provider} must be injected before ${consumer} (${why}) — got indices ${pIdx} vs ${cIdx}`
    );
  }
}

test('dynamic G-Hosp injection: error-helpers.js precedes api-client.js (defines _normalizeApiError)', () => {
  const list = getDynamicInjectionList();
  // Sanity: error-helpers.js is the SOLE definer of _normalizeApiError and
  // api-client.js calls it unguarded — encode that causal link, not just presence.
  const apiClient = fs.readFileSync(path.join(ROOT, 'content/api-client.js'), 'utf8');
  assert.match(apiClient, /_normalizeApiError\(/, 'api-client.js no longer calls _normalizeApiError — update this tripwire');
  const errHelpers = fs.readFileSync(path.join(ROOT, 'shared/error-helpers.js'), 'utf8');
  assert.match(errHelpers, /function _normalizeApiError\b/, 'error-helpers.js no longer defines _normalizeApiError — update this tripwire');

  assertProviderPrecedesConsumers(
    list,
    'shared/error-helpers.js',
    ['content/api-client.js'],
    '_normalizeApiError is a script-scope global'
  );
});

test('dynamic G-Hosp injection: vad-helpers.js precedes audio-capture.js (defines TOCAFICHADR_vad)', () => {
  const list = getDynamicInjectionList();
  assertProviderPrecedesConsumers(
    list,
    'content/vad-helpers.js',
    ['content/audio-capture.js'],
    'window.TOCAFICHADR_vad'
  );
});

test('dynamic G-Hosp injection: dom-engine.js + hud.js precede content.js (TOCAFICHADR_dom/_hud guard)', () => {
  const list = getDynamicInjectionList();
  // content.js aborts early unless window.TOCAFICHADR_dom AND window.TOCAFICHADR_hud
  // are already defined, so both providers must be injected before it.
  assertProviderPrecedesConsumers(list, 'content/dom-engine.js', ['content/content.js'], 'window.TOCAFICHADR_dom');
  assertProviderPrecedesConsumers(list, 'content/hud.js', ['content/content.js'], 'window.TOCAFICHADR_hud');
});

// ── Bug 33: side-panel self-heal reinjection list must mirror the manifest ──
// sidepanel-prontuario.js._CONTENT_SCRIPT_FILES is injected via
// chrome.scripting.executeScript to self-heal a stale G-Hosp tab after an
// extension reload — when the old isolated-world globals are gone. If it drifts
// from manifest.json content_scripts[].js, a dependency (e.g. error-helpers.js,
// the sole definer of _normalizeApiError) goes missing and the reinjected
// api-client.js throws ReferenceError on every API error path.
function getManifestContentScripts() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const cs = (manifest.content_scripts || []).find((s) =>
    Array.isArray(s.matches) && s.matches.some((m) => m.includes('g-hosp.com.br')));
  assert.ok(cs && Array.isArray(cs.js), 'G-Hosp content_scripts[].js not found in manifest');
  return cs.js;
}
function getReinjectionList() {
  const src = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel-prontuario.js'), 'utf8');
  const m = src.match(/_CONTENT_SCRIPT_FILES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m, '_CONTENT_SCRIPT_FILES array not found in sidepanel-prontuario.js');
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

test('reinjection list contains every manifest G-Hosp content script (no missing dep)', () => {
  const manifest = getManifestContentScripts();
  const reinject = getReinjectionList();
  const missing = manifest.filter((f) => !reinject.includes(f));
  assert.deepEqual(missing, [], 'files in manifest but missing from _CONTENT_SCRIPT_FILES: ' + missing.join(', '));
});

test('reinjection list preserves manifest dependency order (relative order match)', () => {
  const manifest = getManifestContentScripts();
  const reinject = getReinjectionList();
  // The reinjection list, filtered to manifest entries, must appear in the same
  // relative order as the manifest — so providers (error-helpers, vad-helpers)
  // still precede their consumers (api-client, audio-capture) after reinjection.
  const filtered = reinject.filter((f) => manifest.includes(f));
  assert.deepEqual(filtered, manifest,
    'reinjection list order diverges from manifest content_scripts order');
});
