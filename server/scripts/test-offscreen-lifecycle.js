// scripts/test-offscreen-lifecycle.js — tripwires for the realtime offscreen
// audio lifecycle (offscreen/offscreen.js).
//
// Run with: node --test scripts/test-offscreen-lifecycle.js
//
// WHY THIS EXISTS (CHRA-2423 Bug 29):
//   The offscreen document persists across popup open/close (that is its whole
//   reason to exist under MV3). So OFFSCREEN_START can arrive a second time
//   without an intervening stop — e.g. the doctor starts realtime, closes the
//   popup mid-session (the popup's `recording` guard resets on reload), reopens,
//   and starts again. Without a re-entrancy guard, startRealtime() overwrote
//   _ws / _audioCtx / _micStream / _processor and ORPHANED the previous set:
//   a leaked live microphone capture + open WebSocket + AudioContext.
//
//   The fix tears down any live session at the top of startRealtime(). For that
//   teardown to be correct, cleanup() must DETACH the old socket's handlers
//   before close() — otherwise the async onclose re-enters cleanup() and, after
//   a re-entrant start, kills the freshly-started session via the reassigned
//   module globals. cleanup() must also cancel the pending response.done timer.
//
// offscreen.js has top-level chrome.* side effects and is not requireable under
// node, so these are static source tripwires (same approach as the other
// selector/injection tripwires in this directory).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'offscreen/offscreen.js'), 'utf8');

function fnBody(name) {
  // Grab from `function <name>(` to the next top-level `\n}` (functions in this
  // file are all left-aligned, so a newline + closing brace at col 0 ends them).
  const re = new RegExp('function ' + name + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}');
  const m = SRC.match(re);
  assert.ok(m, name + '() not found in offscreen.js');
  return m[0];
}

test('startRealtime() tears down any live session before starting (re-entrancy guard)', () => {
  const body = fnBody('startRealtime');
  const cleanupIdx = body.indexOf('cleanup()');
  const getUserMediaIdx = body.indexOf('getUserMedia');
  assert.notEqual(cleanupIdx, -1, 'startRealtime must call cleanup() to guard re-entry');
  assert.notEqual(getUserMediaIdx, -1, 'startRealtime should still request the mic via getUserMedia');
  assert.ok(
    cleanupIdx < getUserMediaIdx,
    'cleanup() must run BEFORE getUserMedia() so a re-entrant start cannot orphan the prior mic/ws/audioctx'
  );
});

test('cleanup() detaches WS handlers before close() (no re-entrant onclose)', () => {
  const body = fnBody('cleanup');
  // v3.4.2: _ws is nulled before close() to prevent races; handlers are detached
  // on a local `ws` reference. Accept either pattern.
  const detachIdx = body.search(/\.onclose\s*=\s*null/);
  // Be specific: the WS close call itself (ws.close()), not _audioCtx.close().
  const closeIdx = body.search(/ws\.close\(\)/);
  assert.notEqual(detachIdx, -1, 'cleanup() must null out onclose before closing the socket');
  assert.notEqual(closeIdx, -1, 'cleanup() must close the socket');
  assert.ok(
    detachIdx < closeIdx,
    'handler detach must precede close() so the async onclose cannot re-enter cleanup()'
  );
});

test('cleanup() cancels the pending response.done timer (idempotent teardown)', () => {
  const body = fnBody('cleanup');
  assert.match(body, /clearTimeout\(_doneTimer\)/, 'cleanup() must clear the tracked _doneTimer');
  // The done handler must store the timer (not an anonymous setTimeout) so it is cancellable.
  assert.match(SRC, /_doneTimer\s*=\s*setTimeout/, 'response.done must assign the timer to _doneTimer');
});

// WHY (CHRA-2423 Bug 49): stopRealtime() closes the AudioContext and THEN stops
// the mic tracks. A bare `await _audioCtx.close();` rejects with InvalidStateError
// if the browser already closed the context (e.g. audio-hardware change), throwing
// out of the function and SKIPPING the mic-track stop below — leaking a live
// microphone on a clinical recorder. cleanup() already guards close() with
// `.catch()`; stopRealtime must too so the mic stop always runs.
test('stopRealtime() guards _audioCtx.close() so the mic stop always runs (no leaked mic)', () => {
  const body = fnBody('stopRealtime');
  assert.match(
    body,
    /_micStream\.getTracks\(\)\.forEach/,
    'stopRealtime must stop the mic tracks on the stop path'
  );
  assert.doesNotMatch(
    body,
    /await\s+_audioCtx\.close\(\)\s*;/,
    'stopRealtime must NOT `await _audioCtx.close();` unguarded — a rejection skips the mic stop (Bug 49)'
  );
  assert.match(
    body,
    /_audioCtx\.close\(\)\s*\.catch\(/,
    'stopRealtime must swallow a close() rejection (like cleanup) so the mic stop always runs'
  );
});
