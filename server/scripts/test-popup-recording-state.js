// scripts/test-popup-recording-state.js — tripwire for the popup recording
// state machine (CHRA-2423 Bug 32).
//
// Run with: node --test scripts/test-popup-recording-state.js
//
// WHY THIS EXISTS:
//   The popup record button toggles on the `recording` flag:
//       if (!recording) startRecording(); else stopRecording();
//   `recording` is set true on start and cleared in the start/stop paths, BUT the
//   terminal realtime/batch results arrive asynchronously via chrome.runtime
//   .onMessage and only repainted the button UI (_setRecState / _flashDoneThenIdle)
//   — they did NOT clear `recording`. So a REALTIME_STATUS 'error' (WS drop /
//   proxy down) that arrives WITHOUT the user clicking stop left recording=true
//   while the UI showed idle: the next record-button click was swallowed as a
//   "stop" instead of starting a new recording. Invariant: every TERMINAL status
//   (realtime 'done'/'error', BATCH_RESULT) must clear `recording`.
//
// popup.src.js is the esbuild ESM source and touches document at load, so it is
// not requireable — this is a static source tripwire (matching the directory's
// other non-requireable-file tripwires). It fails against the pre-fix source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'popup/popup.src.js'), 'utf8');

function block(typeLiteral) {
  // Grab `if (msg.type === '<TYPE>') { ... return false; }`
  const re = new RegExp("if \\(msg\\.type === '" + typeLiteral + "'\\)\\s*\\{[\\s\\S]*?return false;\\s*\\}");
  const m = SRC.match(re);
  assert.ok(m, typeLiteral + ' handler block not found in popup.src.js');
  return m[0];
}

test('REALTIME_STATUS terminal branches clear the recording flag', () => {
  const b = block('REALTIME_STATUS');
  // 'done' branch must set recording = false.
  assert.match(
    b,
    /status === 'done'\)\s*\{\s*recording = false/,
    "REALTIME_STATUS 'done' must clear recording (terminal state)"
  );
  // 'error' branch must set recording = false — the actual bug: an async realtime
  // error left recording=true and swallowed the next record click.
  assert.match(
    b,
    /status === 'error'\)\s*\{\s*recording = false/,
    "REALTIME_STATUS 'error' must clear recording (terminal state)"
  );
  // The in-progress 'recording' substatus must NOT clear it.
  assert.doesNotMatch(
    b,
    /status === 'recording'\)\s*\{[^}]*recording = false/,
    "the in-progress 'recording' status must NOT clear the recording flag"
  );
});

test('BATCH_RESULT clears the recording flag (terminal state)', () => {
  const b = block('BATCH_RESULT');
  assert.match(b, /recording = false/, 'BATCH_RESULT must clear recording (terminal state)');
});

// Bug 34: the popup's batch recording must release the microphone on stop —
// getUserMedia tracks left running keep the mic indicator on (privacy) and leak
// the stream (it is a local never stored elsewhere). The recorder's onstop is
// the reliable teardown point (it captures `stream`).
test('startBatchRecording releases the mic (stops getUserMedia tracks) on stop', () => {
  const m = SRC.match(/function startBatchRecording\(\)[\s\S]*?\n  mediaRecorder\.start\(/);
  assert.ok(m, 'startBatchRecording not found');
  const body = m[0];
  // It acquires the mic...
  assert.match(body, /getUserMedia\(/, 'startBatchRecording should acquire the mic via getUserMedia');
  // ...and the onstop handler must stop the stream tracks to release it.
  assert.match(
    body,
    /onstop[\s\S]*?stream\.getTracks\(\)\.forEach\(\s*\(?t\)?\s*=>\s*t\.stop\(\)\s*\)/,
    'startBatchRecording.onstop must stop the getUserMedia tracks (release the mic)'
  );
});
