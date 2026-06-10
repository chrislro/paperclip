// scripts/test-clerk-init-singleton.js — tripwire for popup Clerk init race
// (CHRA-2423 Bug 35).
//
// Run with: node --test scripts/test-clerk-init-singleton.js
//
// WHY THIS EXISTS:
//   _ensureClerk() gates on a boolean `_clerkLoaded` that is set only AFTER
//   `await _clerk.load()` resolves. Two callers that fire before the first load
//   resolves both see _clerkLoaded===false and call _clerk.load() again. The
//   module-init pair at the bottom of popup.src.js does exactly that:
//       _ensureClerk().then(_renderAuthState)
//       _exposeClerkOnReady()  // → _ensureClerk()
//   → a concurrent double SDK init (duplicate FAPI bootstrap) on every open.
//   The service worker already guards this with a shared `_clerkPromise`; the
//   popup must too. Fix: share one in-flight load promise so concurrent callers
//   join it instead of starting a second load.
//
// popup.src.js is the esbuild ESM source (touches document/imports at load), so
// this is a static source tripwire — matching the directory's convention. It
// fails against the pre-fix boolean-only guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'popup/popup.src.js'), 'utf8');

function ensureClerkBody() {
  const m = SRC.match(/async function _ensureClerk\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, '_ensureClerk() not found in popup.src.js');
  return m[0];
}

test('_ensureClerk shares one in-flight load promise (no concurrent double init)', () => {
  const body = ensureClerkBody();
  // An in-flight promise must exist and short-circuit concurrent callers.
  assert.match(body, /_clerkLoadPromise/, '_ensureClerk must track an in-flight load promise');
  assert.match(
    body,
    /if \(_clerkLoadPromise\)/,
    'a concurrent caller must join the in-flight promise instead of calling load() again'
  );
  // load() must be assigned to the shared promise, not bare-awaited.
  assert.match(
    body,
    /_clerkLoadPromise\s*=\s*_clerk\.load\(/,
    '_clerk.load() must be stored in _clerkLoadPromise so callers can share it'
  );
  // The "loaded" flag must be set only after awaiting that shared promise.
  // (Note: an `await _clerkLoadPromise` also appears in the concurrent-caller
  // guard line ABOVE the assignment, so search for the await AFTER the assign.)
  const pIdx = body.search(/_clerkLoadPromise\s*=\s*_clerk\.load\(/);
  const lIdx = body.search(/_clerkLoaded = true/);
  assert.ok(pIdx !== -1 && lIdx !== -1, 'expected the load assignment and the set-loaded line');
  assert.ok(pIdx < lIdx, '_clerkLoaded must be set after the shared load promise is created');
  const aIdx = body.indexOf('await _clerkLoadPromise', pIdx);
  assert.ok(aIdx !== -1 && aIdx < lIdx, '_clerkLoaded = true must come only after awaiting the shared load promise');
});
