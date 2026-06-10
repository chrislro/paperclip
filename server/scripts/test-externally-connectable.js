// scripts/test-externally-connectable.js — CHRA-2423 Bug 76
//
// Run with: node --test scripts/test-externally-connectable.js
//
// The SW's chrome.runtime.onMessageExternal handler accepts the auth-success ping
// (`chrome.runtime.sendMessage(EXT_ID, {type:"TOCAFICHADR_AUTH_COMPLETED"})`) that
// the backend /api/auth/success page fires from https://api.tocafichadr.com.br after
// Clerk sign-in, then re-broadcasts so the side panel reloads immediately.
//
// In MV3, a WEB PAGE can only call chrome.runtime.sendMessage(EXT_ID, ...) if the
// extension declares that origin in `externally_connectable.matches`. Bug 76: the
// manifest had NO externally_connectable, so chrome.runtime was never injected into
// the auth-success page → the ping silently failed → sign-in degraded to the 5s
// storage poll. Declaring it also tightens security: with `matches` set (and `ids`
// omitted), OTHER extensions can no longer reach onMessageExternal (the implicit
// `ids:["*"]` default only applies when externally_connectable is entirely absent).
//
// This test enforces the manifest ⇄ SW-handler invariant: every origin the
// onMessageExternal handler trusts must be reachable per externally_connectable.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// Both manifests must carry the block: manifest.json serves unpacked dev, but
// build-package.sh --prod ships manifest.prod.json — a gap there silently
// reverts sign-in to the degraded 5s storage poll in the Web Store build.
const MANIFEST_FILES = ['manifest.json', 'manifest.prod.json'];
const manifests = MANIFEST_FILES.map((file) => ({
  file,
  manifest: JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')),
}));
const swSrc = fs.readFileSync(path.join(ROOT, 'background/service-worker.src.js'), 'utf8');

for (const { file, manifest } of manifests) {
  test(`${file} declares externally_connectable.matches (else onMessageExternal is unreachable from web)`, () => {
    const ec = manifest.externally_connectable;
    assert.ok(ec && Array.isArray(ec.matches) && ec.matches.length > 0,
      `${file} externally_connectable.matches must be a non-empty array so the `
        + 'auth-success page can reach onMessageExternal (Bug 76)');
  });

  test(`${file} externally_connectable allows the auth-success origin the SW handler trusts`, () => {
    const matches = manifest.externally_connectable.matches;
    assert.ok(
      matches.some((m) => m.startsWith('https://api.tocafichadr.com.br')),
      `${file} externally_connectable.matches must include https://api.tocafichadr.com.br/* — `
        + 'the origin /api/auth/success pings from: ' + JSON.stringify(matches));
  });
}

test('SW onMessageExternal origin check is consistent with the manifest', () => {
  // Only assert consistency if the handler exists (it does today).
  if (!swSrc.includes('onMessageExternal')) return;
  assert.ok(
    swSrc.includes("startsWith('https://api.tocafichadr.com.br/')")
      || swSrc.includes('startsWith("https://api.tocafichadr.com.br/")'),
    'the onMessageExternal handler must validate the api.tocafichadr.com.br origin '
      + 'that externally_connectable grants — keep the two in lockstep');
});
