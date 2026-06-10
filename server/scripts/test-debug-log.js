// scripts/test-debug-log.js — Tripwires for the console-shipper debug-log
// pipeline. Verifies that:
//   - shared/console-shipper.js exists and intercepts console.warn/error
//   - manifest.json loads it FIRST in content_scripts (so wraps before any
//     other content script can warn)
//   - sidepanel.html loads it BEFORE sidepanel-prontuario.js
//   - background/service-worker.src.js declares a TOCAFICHADR_DEBUG_LOG
//     handler and a _handleDebugLog function that POSTs to /api/debug-log
//   - backend/emr_automation/dashboard/routes.py exposes /api/debug-log
//
// Run with: node --test scripts/test-debug-log.js
// No deps — Node's built-in test runner. All assertions are static-source
// invariants; this is a tripwire suite, not behavioral coverage.

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');

const ROOT = path.join(__dirname, '..');

// =====================================================================
// shared/console-shipper.js — file presence + interception shape
// =====================================================================

test('shared/console-shipper.js exists', () => {
  const p = path.join(ROOT, 'shared/console-shipper.js');
  assert.ok(fs.existsSync(p), 'shared/console-shipper.js must exist');
});

test('console-shipper wraps console.warn and console.error', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared/console-shipper.js'), 'utf8');
  // The wrapper must reassign both console.warn and console.error to a new
  // function. We assert each by substring.
  assert.ok(/console\.warn\s*=\s*function/.test(src),
    'shipper must replace console.warn with a wrapped function');
  assert.ok(/console\.error\s*=\s*function/.test(src),
    'shipper must replace console.error with a wrapped function');
});

test('console-shipper sends TOCAFICHADR_DEBUG_LOG via runtime messaging', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared/console-shipper.js'), 'utf8');
  assert.ok(/TOCAFICHADR_DEBUG_LOG/.test(src),
    'shipper must dispatch the TOCAFICHADR_DEBUG_LOG message type');
  assert.ok(/chrome\.runtime\.sendMessage/.test(src),
    'shipper must use chrome.runtime.sendMessage to forward to the SW');
});

test('console-shipper is idempotent (re-injection no-ops)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared/console-shipper.js'), 'utf8');
  // Idempotency guard prevents re-wrapping when the script gets re-injected
  // by Chrome (which can happen on extension update or page navigation).
  assert.ok(/__tfdrConsoleShipperInstalled/.test(src),
    'shipper must guard with __tfdrConsoleShipperInstalled to be idempotent');
});

// =====================================================================
// CSO-002 — OAuth URL redaction in console-shipper.js + clerk-tap.js
// =====================================================================
//
// The shipper's `payload.url` field is the second leak path identified by
// PR #35 review: redacting the message body in clerk-tap.js still leaves
// `payload.url = location.href.slice(0, 400)` carrying raw code/state
// tokens to /api/debug-log. These tripwires assert (a) the regex literal
// in console-shipper.js matches the one in clerk-tap.js, (b) payload.url
// is wrapped in the redactor before sendMessage, and (c) the regex
// itself behaves correctly across the URL shapes Clerk produces.

// Single source of truth for the regex literal. Both source files must
// contain this exact pattern — drift means one path is unprotected.
const REDACT_REGEX_LITERAL = '/([?#&])(code|state|session_token|__clerk_token)=[^&#]*/gi';

test('console-shipper.js contains the CSO-002 redact regex', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared/console-shipper.js'), 'utf8');
  assert.ok(src.includes(REDACT_REGEX_LITERAL),
    'console-shipper.js must contain the same redact regex as clerk-tap.js');
});

test('clerk-tap.js contains the CSO-002 redact regex (parity)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared/clerk-tap.js'), 'utf8');
  assert.ok(src.includes(REDACT_REGEX_LITERAL),
    'clerk-tap.js must contain the same redact regex as console-shipper.js');
});

test('console-shipper.js wraps payload.url with _redactUrl before sendMessage', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shared/console-shipper.js'), 'utf8');
  // The payload.url assignment must call the redactor — a bare
  // location.href.slice(...) is the original leak.
  assert.ok(/url:\s*[^,]*_redactUrl\(\s*location\.href/.test(src),
    'payload.url must be built via _redactUrl(location.href, ...) to redact before slice');
  assert.ok(!/url:\s*[^,]*location\.href\.slice/.test(src),
    'payload.url must NOT call location.href.slice directly (would leak unredacted tokens)');
});

// Behavioral tests — eval the redactor inline using the same regex literal
// the source uses. If REDACT_REGEX_LITERAL drifts from source, the tripwires
// above fail; if these behavioral tests fail, the regex itself is wrong.
function redactUrl(url, maxLen) {
  return String(url)
    .replace(/([?#&])(code|state|session_token|__clerk_token)=[^&#]*/gi, '$1$2=[redacted]')
    .slice(0, maxLen);
}

test('redactUrl: ?code only', () => {
  assert.equal(
    redactUrl('https://accounts.dev/cb?code=abc123', 200),
    'https://accounts.dev/cb?code=[redacted]');
});

test('redactUrl: #code only (fragment anchor)', () => {
  assert.equal(
    redactUrl('https://accounts.dev/cb#code=abc123', 200),
    'https://accounts.dev/cb#code=[redacted]');
});

test('redactUrl: mixed ?...# with token in both', () => {
  assert.equal(
    redactUrl('https://accounts.dev/cb?state=xyz#code=abc', 200),
    'https://accounts.dev/cb?state=[redacted]#code=[redacted]');
});

test('redactUrl: multiple targets in one URL', () => {
  assert.equal(
    redactUrl('https://x.dev/cb?code=a&state=b&session_token=c&__clerk_token=d', 300),
    'https://x.dev/cb?code=[redacted]&state=[redacted]&session_token=[redacted]&__clerk_token=[redacted]');
});

test('redactUrl: mixed case param names', () => {
  assert.equal(
    redactUrl('https://x.dev/cb?Code=abc&STATE=xyz', 200),
    'https://x.dev/cb?Code=[redacted]&STATE=[redacted]');
});

test('redactUrl: no-target params pass through untouched', () => {
  assert.equal(
    redactUrl('https://x.dev/cb?utm_source=clerk&lang=pt-br', 200),
    'https://x.dev/cb?utm_source=clerk&lang=pt-br');
});

test('redactUrl: no params at all', () => {
  assert.equal(
    redactUrl('https://x.dev/sign-in', 200),
    'https://x.dev/sign-in');
});

test('redactUrl: redacts before slice so truncation cannot leak partial token', () => {
  // If slice ran before redact, the trailing token characters would survive.
  // Run a long URL through a tight maxLen and confirm [redacted] is intact.
  const long = 'https://accounts.dev/cb?code=' + 'A'.repeat(500) + '&state=Z';
  const out = redactUrl(long, 200);
  assert.ok(out.includes('code=[redacted]'),
    'tight maxLen must not truncate the redaction marker');
  assert.ok(!/code=A{5,}/.test(out),
    'tight maxLen must not leak raw token characters');
});

// =====================================================================
// manifest.json — content_scripts ordering
// =====================================================================

test('manifest.json loads console-shipper FIRST in content_scripts.js', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const scripts = manifest.content_scripts && manifest.content_scripts[0] && manifest.content_scripts[0].js;
  assert.ok(Array.isArray(scripts) && scripts.length > 0,
    'manifest.content_scripts[0].js must be a non-empty array');
  assert.equal(scripts[0], 'shared/console-shipper.js',
    'shared/console-shipper.js must be the FIRST content script so it wraps console before any other script can warn');
});

// =====================================================================
// sidepanel.html — load order
// =====================================================================

test('sidepanel.html loads console-shipper BEFORE sidepanel-prontuario.js', () => {
  // Match actual <script src="..."> tags, not bare filename mentions —
  // sidepanel-prontuario.js is referenced in HTML comments earlier in the
  // file and a substring search would falsely "find" it before the shipper.
  const html = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel.html'), 'utf8');
  const idxShipper    = html.indexOf('<script src="../shared/console-shipper.js"');
  const idxProntuario = html.indexOf('<script src="sidepanel-prontuario.js"');
  assert.ok(idxShipper > -1,    'sidepanel.html must include <script src="../shared/console-shipper.js">');
  assert.ok(idxProntuario > -1, 'sidepanel.html must still include <script src="sidepanel-prontuario.js">');
  assert.ok(idxShipper < idxProntuario,
    'console-shipper must load before sidepanel-prontuario so warns from the latter are wrapped');
});

// =====================================================================
// service-worker.src.js — handler + ship function
// =====================================================================

test('service-worker.src.js routes TOCAFICHADR_DEBUG_LOG to _handleDebugLog', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'background/service-worker.src.js'), 'utf8');
  assert.ok(/message\.type === 'TOCAFICHADR_DEBUG_LOG'/.test(sw),
    'SW must dispatch on TOCAFICHADR_DEBUG_LOG inside the onMessage listener');
  assert.ok(/_handleDebugLog\s*\(/.test(sw),
    'SW must call _handleDebugLog from the dispatcher');
});

test('service-worker.src.js _handleDebugLog POSTs to /api/debug-log', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'background/service-worker.src.js'), 'utf8');
  // Tripwire: the function must POST to /api/debug-log specifically.
  // Loose match — allow surrounding code to evolve.
  assert.ok(/_handleDebugLog[\s\S]*?\/api\/debug-log/.test(sw),
    '_handleDebugLog must hit the /api/debug-log endpoint');
});

// CHRA-2136 — once the backend enforces @require_extension_or_user on
// /api/debug-log, every SW caller must attach a Bearer token or it 401s.
// _handleError and _handleDebugLog already do; _swDebugLog (SW-internal
// diagnostics) was the gap. Guard it so the auth header cannot regress.
test('service-worker.src.js _swDebugLog attaches Authorization Bearer from storage', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'background/service-worker.src.js'), 'utf8');
  // Isolate the _swDebugLog body: from its declaration up to the next
  // top-level `async function` (which is _getAuthToken).
  const start = sw.indexOf('async function _swDebugLog(');
  assert.ok(start > -1, 'service-worker.src.js must define _swDebugLog');
  const rest = sw.slice(start + 'async function _swDebugLog('.length);
  const body = rest.slice(0, rest.indexOf('async function '));
  assert.ok(/authToken/.test(body),
    '_swDebugLog must read authToken to authenticate the diagnostic POST');
  assert.ok(/Authorization['"]\]\s*=\s*['"]Bearer /.test(body) || /Authorization['"]:\s*['"]?Bearer/.test(body),
    "_swDebugLog must set an 'Authorization: Bearer <token>' header");
  // Recursion guard: _swDebugLog must NOT obtain the token via _getAuthToken,
  // which itself calls _swDebugLog (infinite mutual recursion). Strip line
  // comments first so the function's own documentation of this hazard does
  // not count as a call.
  const bodyCode = body.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/_getAuthToken\s*\(/.test(bodyCode),
    '_swDebugLog must read storage directly, NOT call _getAuthToken (would recurse)');
});

// =====================================================================
// backend/routes.py — endpoint
// =====================================================================

test('routes.py exposes POST /api/debug-log via @bp.route', () => {
  const routesPath = path.join(ROOT, 'backend/emr_automation/dashboard/routes.py');
  if (!fs.existsSync(routesPath)) {
    // Backend may not always be present in the working tree; soft-skip.
    assert.ok(true, 'backend routes.py not present in working tree');
    return;
  }
  const py = fs.readFileSync(routesPath, 'utf8');
  assert.ok(/@bp\.route\(\s*["']\/api\/debug-log["'][\s\S]*methods=\[["']POST["']\]/.test(py),
    "routes.py must expose @bp.route('/api/debug-log', methods=['POST'])");
  assert.ok(/def api_debug_log\(/.test(py),
    'routes.py must define api_debug_log handler');
});
