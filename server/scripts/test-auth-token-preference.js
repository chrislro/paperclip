// scripts/test-auth-token-preference.js — Tripwires for _getAuthToken in
// background/service-worker.src.js.
//
// The bug this prevents (observed live 2026-05-25 13:14:21/42/57):
//   /api/soap-stream returned 401 in the same second /api/transcribe and
//   /api/format-soap returned 200. Same user, same Chrome profile, same
//   Clerk session. Cause: SW called clerk.session.getToken() FIRST and got
//   back a stale token from the SDK's cached MV3-session, while the
//   sidepanel read the freshly-refreshed chrome.storage.local.authToken
//   that popup-side _refreshStoredAuthToken writes every 30s.
//
// Invariant: storage MUST be tried first. SDK is the fallback for empty
// storage (e.g. first-run profile that hasn't loaded the popup yet).
//
// Run: node --test scripts/test-auth-token-preference.js

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const SW_SRC = path.join(__dirname, '..', 'background', 'service-worker.src.js');

function _extractGetAuthTokenBody() {
  const src = fs.readFileSync(SW_SRC, 'utf8');
  const fnStart = src.indexOf('async function _getAuthToken()');
  assert.ok(fnStart !== -1, '_getAuthToken must exist in service-worker.src.js');
  // First `\n}\n` after the start — the function's closing brace on its own
  // line. The source style puts closing braces on their own line for every
  // top-level async function.
  const fnEnd = src.indexOf('\n}\n', fnStart);
  assert.ok(fnEnd !== -1, 'expected closing brace for _getAuthToken');
  return src.slice(fnStart, fnEnd);
}

test('storage path appears before SDK path inside _getAuthToken', () => {
  const body = _extractGetAuthTokenBody();
  // CHRA-2133: the JWT moved from chrome.storage.local to chrome.storage.session
  // (cleared on browser close, unreadable by content scripts). Storage-first
  // preference over the SDK is unchanged — only the area changed.
  const storageIdx = body.indexOf("chrome.storage.session.get(['authToken'");
  const sdkIdx     = body.indexOf('_getClerk()');
  assert.ok(storageIdx !== -1, '_getAuthToken must read chrome.storage.session.authToken');
  assert.ok(sdkIdx !== -1, '_getAuthToken must also try the Clerk SDK as fallback');
  assert.ok(
    storageIdx < sdkIdx,
    'storage path MUST be tried before SDK path — see 2026-05-25 401 regression'
  );
});

test('storage path enforces a pre-expiry rejection (CSO-009)', () => {
  const body = _extractGetAuthTokenBody();
  // The exact threshold has changed (was 60_000ms, now 5_000ms — see the
  // 2026-05-25 revision: 60s was sized for the FALLBACK case and rejected
  // every token in the new storage-first design because Clerk's default
  // session token lifetime is 60s). The invariant kept here is "some
  // non-zero pre-expiry buffer must exist" so we don't ship a token that
  // expires mid-flight.
  assert.ok(
    /Date\.now\(\)\s*>\s*expiry\s*-\s*\d{1,3}_?000/.test(body),
    'storage path must reject tokens within ~5s-60s of authTokenExpiry'
  );
});

test('storage path returns the stored token (not a transformed copy)', () => {
  const body = _extractGetAuthTokenBody();
  assert.ok(
    /return\s+stored\.authToken;/.test(body),
    'storage path must `return stored.authToken;` — token in/out must be the literal stored value'
  );
});

test('SDK fallback still calls clerk.session.getToken()', () => {
  const body = _extractGetAuthTokenBody();
  assert.ok(
    /clerk\.session\.getToken\(\)/.test(body),
    'SDK fallback must still call clerk.session.getToken() for empty-storage profiles'
  );
});

test('_getAuthToken returns null when both paths fail', () => {
  const body = _extractGetAuthTokenBody();
  // Final return null is the contract: _authedFetch omits the Authorization
  // header when this returns null.
  assert.ok(
    /\n\s*return null;\s*$/m.test(body),
    '_getAuthToken must `return null` on dual-empty so _authedFetch sends an unauthed request'
  );
});

test('both code paths are inside try/catch (don\'t propagate throws)', () => {
  const body = _extractGetAuthTokenBody();
  // Two `try {` blocks expected: one for storage, one for SDK.
  const tryCount = (body.match(/\btry\s*{/g) || []).length;
  assert.ok(
    tryCount >= 2,
    '_getAuthToken must wrap storage + SDK calls in separate try/catch blocks'
  );
});

test('SDK fallback comment explicitly marks itself as a fallback', () => {
  const body = _extractGetAuthTokenBody();
  // Why: makes intent visible to the next reader. If someone reorders the
  // paths, the comment will be the loudest signal they're regressing the fix.
  assert.ok(
    /fallback/i.test(body),
    'SDK path must be labelled as a fallback in source comments'
  );
});

// _authedFetch and the soap-stream Port handler are the two consumers that
// hit /api/soap-stream's 401 path. Both must route through _getAuthToken
// (not a parallel implementation), so the storage-first preference applies
// to every authed call from the SW.
test('every Bearer header in the SW comes from _getAuthToken (no parallel impl)', () => {
  const src = fs.readFileSync(SW_SRC, 'utf8');
  // Find every line that adds an Authorization Bearer header. Each one
  // should be preceded (within ~6 lines) by an await of _getAuthToken or
  // _authedFetch.
  const lines = src.split('\n');
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/headers\[['"]Authorization['"]\]\s*=\s*['"]Bearer\s/.test(lines[i])) continue;
    // Look back up to 10 lines for either:
    //   (a) _getAuthToken() / _authedFetch invocation — the central path
    //   (b) chrome.storage.session.get(['authToken' …]) — intentionally inline
    //       in _handleError and _handleDebugLog (best-effort logging
    //       endpoints; unauthed-on-failure is documented and OK).
    let sourced = false;
    for (let j = Math.max(0, i - 10); j < i; j++) {
      if (/_getAuthToken\(\)|_authedFetch\(/.test(lines[j])) { sourced = true; break; }
      if (/chrome\.storage\.session\.get\(\[['"]authToken/.test(lines[j])) { sourced = true; break; }
    }
    if (!sourced) offenders.push(`L${i + 1}: ${lines[i].trim()}`);
  }
  assert.equal(
    offenders.length, 0,
    'all SW Bearer-header writes must source the token from _getAuthToken (or the _handleError fast path):\n' +
      offenders.join('\n')
  );
});
