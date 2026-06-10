// scripts/test-transcribe-timeout-budget.js — CHRA-2423 Bug 81
//
// Run with: node --test scripts/test-transcribe-timeout-budget.js
//
// Guards the transcription timeout *budget contract* across the three layers
// that must agree on how long a transcription may take:
//
//   1. content/hud.js races the transcribe call against a 90s UI timeout
//      ("Wrap transcription in a 90-second timeout").
//   2. The SW's ACTIVE_OPS_KEEPALIVE (CHRA-1913) exists precisely to keep the
//      MV3 service worker alive for operations documented as "transcription
//      7-90s".
//   3. The SW's actual fetch to /api/transcribe carries AbortSignal.timeout(N).
//
// The bug: layer 3 said N=30000. Any consultation whose backend transcription
// (Whisper + SOAP + CID, synchronous) took 30-90s — exactly the envelope
// layers 1 and 2 were built for — was aborted by the SW at 30s with "Tempo
// esgotado. Tente novamente.", and the retry died the same way. Long
// dictations could NEVER succeed, while the keepalive alarm dutifully kept
// the SW alive for a fetch it had already killed.
//
// Invariants encoded here (WHY, not just WHAT):
//   - SW fetch timeout > 60s: must cover most of the documented 7-90s
//     envelope. 30000 was the bug; anything ≤60s re-breaks long dictations.
//   - SW fetch timeout < HUD UI timeout: the SW must abort BEFORE the HUD's
//     race fires so the doctor sees the SW's structured error (and the SW
//     stops the backend wait) instead of the HUD's generic message racing a
//     fetch that is still burning backend tokens.
//
// Static extraction (this repo's selftest style — see
// test-selector-config-parity.js): the values are constants in source, so we
// parse them rather than execute the SW (which needs chrome.* + Clerk).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'background', 'service-worker.src.js'), 'utf8');
const HUD_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'content', 'hud.js'), 'utf8');

function extractSwTranscribeTimeout(src) {
  // The _post() helper inside _handleTranscribeInner: find the fetch whose URL
  // ends with '/api/transcribe' and pull the AbortSignal.timeout(N) from the
  // same init object. Window is generous (1500 chars) because the init block
  // carries a long WHY-comment explaining the budget.
  const m = src.match(/\/api\/transcribe'[\s\S]{0,1500}?AbortSignal\.timeout\(\s*([\d_]+)\s*\)/);
  return m ? Number(m[1].replace(/_/g, '')) : null;
}

function extractHudUiTimeout(src) {
  // The Promise.race timeout in hud.js: setTimeout(..., N) whose rejection
  // message is "Tempo limite excedido".
  const m = src.match(/Tempo limite excedido[\s\S]{0,200}?\}\s*,\s*([\d_]+)\s*\)/);
  return m ? Number(m[1].replace(/_/g, '')) : null;
}

test('both timeout constants are extractable from source', () => {
  assert.ok(extractSwTranscribeTimeout(SW_SRC),
    'could not find AbortSignal.timeout(...) for /api/transcribe in service-worker.src.js — update the extraction regex alongside the code');
  assert.ok(extractHudUiTimeout(HUD_SRC),
    'could not find the HUD "Tempo limite excedido" race timeout in content/hud.js — update the extraction regex alongside the code');
});

test('SW transcribe fetch budget covers the documented 7-90s envelope (>60s)', () => {
  const swTimeout = extractSwTranscribeTimeout(SW_SRC);
  assert.ok(swTimeout > 60_000,
    `SW /api/transcribe AbortSignal.timeout is ${swTimeout}ms — must be >60000ms. ` +
    'Transcription is documented at 7-90s (CHRA-1913 keepalive comment); a short ' +
    'abort makes every long-consultation dictation fail with "Tempo esgotado" ' +
    'on both the first attempt and the retry.');
});

test('SW aborts before the HUD UI race so the structured error wins', () => {
  const swTimeout = extractSwTranscribeTimeout(SW_SRC);
  const hudTimeout = extractHudUiTimeout(HUD_SRC);
  assert.ok(swTimeout < hudTimeout,
    `SW timeout (${swTimeout}ms) must stay BELOW the HUD UI race timeout ` +
    `(${hudTimeout}ms): if the HUD race fires first the doctor gets a generic ` +
    'message while the SW keeps the backend request burning in the background.');
});
