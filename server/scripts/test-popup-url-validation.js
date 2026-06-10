// scripts/test-popup-url-validation.js — CHRA-2423 Bug 50
//
// Run with: node --test scripts/test-popup-url-validation.js
//
// WHY THIS EXISTS:
//   The settings "Salvar" handler persisted the local-mode apiBaseUrl to
//   chrome.storage.sync with NO validation:
//       apiBaseUrl: mode === "cloud" ? CLOUD_URL
//                                     : (document.getElementById("apiBaseUrl")?.value?.trim() || LOCAL_URL)
//   api-client.js and the service worker read apiBaseUrl VERBATIM (no URL parse),
//   so a malformed value typed into the local-mode field — a typo, a missing
//   scheme like "127.0.0.1:5051" — landed in storage and silently broke every
//   API call until the user noticed and fixed it. The fix adds _isValidBackendUrl()
//   and rejects an invalid local URL (with a status message) before persisting.
//
// popup.src.js has DOM/chrome top-level deps and isn't requireable under node, but
// _isValidBackendUrl is pure (new URL only) — so we extract its source and eval it
// for a real behavioural test, plus a source guard that the save handler calls it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'popup/popup.src.js'), 'utf8');

function loadValidator() {
  const m = SRC.match(/function _isValidBackendUrl\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, '_isValidBackendUrl not found in popup.src.js');
  // Turn the named declaration into an expression and eval it (pure fn: new URL only).
  // eslint-disable-next-line no-eval
  return eval('(' + m[0].replace('function _isValidBackendUrl', 'function') + ')');
}

test('_isValidBackendUrl accepts well-formed http(s) URLs', () => {
  const v = loadValidator();
  assert.equal(v('http://127.0.0.1:5051'), true);
  assert.equal(v('https://api.tocafichadr.com.br'), true);
  assert.equal(v('http://localhost:5051/'), true);
});

test('_isValidBackendUrl rejects malformed / non-http URLs', () => {
  const v = loadValidator();
  assert.equal(v(''), false);
  assert.equal(v('   '), false);
  assert.equal(v('127.0.0.1:5051'), false);          // missing scheme (digit-led, not a valid scheme)
  assert.equal(v('htttp://127.0.0.1:5051'), false);  // typo'd scheme -> not http(s)
  assert.equal(v('not a url'), false);
  assert.equal(v('ftp://example.com'), false);        // wrong protocol
  assert.equal(v(null), false);
  assert.equal(v(undefined), false);
});

test('save handler validates the local URL before persisting (no bricked base URL)', () => {
  // Source guard: the save click handler must run the local URL through
  // _isValidBackendUrl and bail before storage.sync.set when it is invalid.
  assert.match(
    SRC,
    /_isValidBackendUrl\(localUrl\)/,
    'save handler must validate localUrl via _isValidBackendUrl before persisting'
  );
});
