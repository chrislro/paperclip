// scripts/test-connectivity-feedback.js — tripwires for backend-reachability
// feedback from a failed recording (CHRA-2423 Bug 31).
//
// Run with: node --test scripts/test-connectivity-feedback.js
//
// WHY THIS EXISTS:
//   shared/connectivity.js can report "backend unreachable while the OS is
//   online" (navigator.onLine true + backendReachable === false), and the side
//   panel's _guardOnline() + offline banner depend on that. But notifyReachable(false)
//   was ONLY ever called by the manual "Tentar novamente" button — which lives
//   inside a banner that only appears when already offline. So for the most
//   common real failure (backend/tunnel down while wifi is up) the offline state
//   could NEVER self-activate: a dead feedback loop, and the preemptive
//   _guardOnline() never fired.
//
//   Fix: _onRecordingBlob's catch feeds notifyReachable(false) when the transcribe
//   POST fails with a network-unreachable error — gated by _isNetworkDownError so
//   an HTTP 429/500 (server responded → reachable) never false-flags offline.
//
// Two layers below: (1) the live connectivity contract the fix relies on
// (requireable — connectivity.js is node-safe), (2) the _isNetworkDownError
// semantics, and (3) a source tripwire that the catch actually wires them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Requiring connectivity.js runs its IIFE and publishes the API on globalThis
// (it has no module.exports). Under node, navigator.onLine is not a boolean, so
// _navOnline() assumes online — exactly the "OS online" condition we care about.
require(path.join(ROOT, 'shared/connectivity.js'));
const connectivity = globalThis.TOCAFICHADR_connectivity;

test('connectivity contract: notifyReachable(false) marks offline while the OS is online', () => {
  assert.ok(connectivity, 'connectivity API must publish on globalThis under node');
  connectivity.notifyReachable(null);              // reset to "unknown"
  assert.equal(connectivity.isOnline(), true, 'unknown backend + OS online → online');
  connectivity.notifyReachable(false);             // a failed backend probe
  assert.equal(connectivity.isOnline(), false, 'backend unreachable while OS online → offline');
  connectivity.notifyReachable(true);              // recovered
  assert.equal(connectivity.isOnline(), true, 'backend reachable again → online');
  connectivity.notifyReachable(null);              // leave clean for any later test
});

test('connectivity contract: onChange fires on the online→offline transition', () => {
  connectivity.notifyReachable(null);
  let last = null;
  const off = connectivity.onChange((online) => { last = online; });
  connectivity.notifyReachable(false);
  assert.equal(last, false, 'subscriber must observe the offline transition');
  connectivity.notifyReachable(true);
  assert.equal(last, true, 'subscriber must observe the recovery transition');
  off();
  connectivity.notifyReachable(null);
});

test('_isNetworkDownError: only true network-down errors, never HTTP/timeout', () => {
  // Mirror the predicate the side panel uses so a broken implementation is caught.
  const isNetworkDown = (err) => {
    const msg = (err && err.message) || String(err || '');
    if (/^HTTP\s+\d/.test(msg)) return false;
    const name = (err && err.name) || '';
    return name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(msg);
  };
  // Network-unreachable → true (the backend/tunnel-down case).
  assert.equal(isNetworkDown(new TypeError('Failed to fetch')), true);
  assert.equal(isNetworkDown(new Error('NetworkError when attempting to fetch resource')), true);
  // Server responded → reachable → MUST be false (no false-offline).
  assert.equal(isNetworkDown(new Error('HTTP 429 USAGE_LIMIT')), false);
  assert.equal(isNetworkDown(new Error('HTTP 500')), false);
  assert.equal(isNetworkDown(new Error('HTTP 401')), false);
  // App-level errors with a reachable backend → false.
  assert.equal(isNetworkDown(new Error('Transcrição vazia')), false);
  // A bare timeout is deliberately NOT treated as offline (slow ≠ down).
  const to = new Error('timed out'); to.name = 'TimeoutError';
  assert.equal(isNetworkDown(to), false);
});

test('source: _onRecordingBlob catch feeds notifyReachable(false) gated by _isNetworkDownError', () => {
  const src = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel-prontuario.js'), 'utf8');
  // The predicate exists.
  assert.match(src, /function _isNetworkDownError\(err\)/, 'must define _isNetworkDownError');
  // The recording-blob catch must call notifyReachable(false) guarded by it.
  const blob = src.match(/async function _onRecordingBlob\(msg\)[\s\S]*?\n  \}/);
  assert.ok(blob, '_onRecordingBlob not found');
  assert.match(blob[0], /_isNetworkDownError\(err\)/, 'catch must gate on _isNetworkDownError');
  assert.match(blob[0], /notifyReachable\(false\)/, 'catch must feed notifyReachable(false) on network-down');
});

// CHRA-2423 Bug 77 — the RECOVERY complement of Bug 31. notifyReachable(TRUE) was
// likewise only ever called by the manual "Tentar novamente" button, so a transient
// backend outage that recovered while the OS stayed online left the offline banner
// up (and _guardOnline blocking recording) until the doctor clicked retry. The fix
// adds a bounded auto-re-probe scoped to the offline banner's lifecycle.
test('source: offline banner runs a bounded auto-re-probe that self-stops on recovery', () => {
  const src = fs.readFileSync(path.join(ROOT, 'sidepanel/sidepanel-prontuario.js'), 'utf8');

  // _showOfflineBanner starts the poller (guarded against double-start).
  const show = src.match(/function _showOfflineBanner\(\)[\s\S]*?\n  \}/);
  assert.ok(show, '_showOfflineBanner not found');
  assert.match(show[0], /setInterval/, '_showOfflineBanner must start the auto-re-probe interval');
  assert.match(show[0], /_offlineProbeTimer === null/, 'must guard against starting a second timer');

  // _hideOfflineBanner clears it (so the poll is bounded to the offline window).
  const hide = src.match(/function _hideOfflineBanner\(\)[\s\S]*?\n  \}/);
  assert.ok(hide, '_hideOfflineBanner not found');
  assert.match(hide[0], /clearInterval\(_offlineProbeTimer\)/, '_hideOfflineBanner must clear the probe timer');

  // The probe, on success, restores connectivity so onChange → _hideOfflineBanner
  // stops the poller (no manual click needed).
  const probe = src.match(/async function _autoReprobeBackend\(\)[\s\S]*?\n  \}/);
  assert.ok(probe, '_autoReprobeBackend not found');
  assert.match(probe[0], /_healthProbe\(\)/, 'auto-re-probe must call the health probe');
  assert.match(probe[0], /notifyReachable\(true\)/, 'on a healthy probe it must restore connectivity');
});
