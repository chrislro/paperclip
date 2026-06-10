// scripts/test-audio-capture-lifecycle.js — CHRA-2423 Bug 80
//
// Run with: node --test scripts/test-audio-capture-lifecycle.js
//
// Guards content/audio-capture.js mediaStream lifecycle on the start() error
// path — the first executable test of that module.
//
// The bug: start() does
//     _stream = await getUserMedia({audio:true});   // mic opens, tracks LIVE
//     ... attach dead-track listeners ...
//     _recorder = new MediaRecorder(_stream, opts);  // <- can throw
//     _recording = true;
// MediaRecorder's constructor can throw (NotSupportedError per MDN) AFTER
// getUserMedia has already opened the microphone. When it threw, nothing
// stopped the stream: the mic stayed hot (privacy concern in a medical app),
// _recording stayed false, and the next start() call overwrote _stream —
// orphaning the previous stream's tracks, which were never .stop()'d.
// stop() couldn't rescue it either: `if (!_recording || !_recorder) return`
// early-returns because the failed start() left both falsy.
//
// audio-capture.js is a bare `window.TOCAFICHADR_audio = (function(){…})()`
// IIFE (no UMD wrapper), so we eval the source against mocked browser globals
// and re-eval fresh per test to reset module-scope state.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../content/audio-capture.js'), 'utf8');

// Build a fresh mic track + stream whose .stop() calls are counted.
function makeStream() {
  const track = {
    stopCalls: 0,
    stop() { this.stopCalls++; },
    addEventListener() {},
    removeEventListener() {},
    getSettings() { return {}; },
  };
  const stream = {
    getTracks() { return [track]; },
    getAudioTracks() { return [track]; },
    _track: track,
  };
  return stream;
}

// Load a fresh audio module instance against the given globals. Each call
// re-runs the IIFE, so module-scope state (_stream, _recording…) is reset.
function defineGlobal(name, value) {
  // Plain `global.x = …` is a no-op for read-only built-in globals (modern Node
  // ships a `navigator` accessor with no setter), so the mock would never apply
  // and audio-capture.js would bail at its `getUserMedia nao disponivel` guard.
  // defineProperty forces the override.
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function loadAudioModule({ getUserMedia, MediaRecorderImpl }) {
  const win = { addEventListener() {} }; // no AudioContext → VAD path skipped
  defineGlobal('window', win);
  defineGlobal('navigator', { mediaDevices: { getUserMedia } });
  defineGlobal('MediaRecorder', MediaRecorderImpl);
  // eslint-disable-next-line no-eval
  eval(SRC); // assigns window.TOCAFICHADR_audio
  return win.TOCAFICHADR_audio;
}

test('Bug 80 — MediaRecorder ctor throwing releases the mic stream (no hot-mic leak)', async () => {
  const stream = makeStream();
  const ThrowingMediaRecorder = function () { throw new DOMExceptionLike('NotSupportedError'); };
  ThrowingMediaRecorder.isTypeSupported = () => false; // → no mimeType passed

  const audio = loadAudioModule({
    getUserMedia: async () => stream,
    MediaRecorderImpl: ThrowingMediaRecorder,
  });

  await assert.rejects(
    () => audio.start(() => {}),
    'start() must reject when MediaRecorder construction fails');

  assert.equal(stream._track.stopCalls, 1,
    'the live mic track MUST be stopped when start() fails after getUserMedia '
    + '— otherwise the microphone stays hot and the stream leaks');
  assert.equal(audio.isRecording(), false,
    'isRecording() must be false after a failed start()');
});

test('Bug 80 — state stays clean so a subsequent start() is not blocked', async () => {
  const stream1 = makeStream();
  const ThrowingMediaRecorder = function () { throw new DOMExceptionLike('NotSupportedError'); };
  ThrowingMediaRecorder.isTypeSupported = () => false;

  const audio = loadAudioModule({
    getUserMedia: async () => stream1,
    MediaRecorderImpl: ThrowingMediaRecorder,
  });

  await assert.rejects(() => audio.start(() => {}));

  // The "Gravacao ja em andamento" guard keys off _recording; a failed start
  // must leave it false so the doctor can retry. (We don't drive a full
  // successful recording here — that needs a stateful MediaRecorder mock — but
  // the guard state is the regression-critical bit.)
  assert.equal(audio.isRecording(), false);
});

// Minimal DOMException-like error (Node has DOMException, but keep the test
// self-contained and name-stable regardless of runtime).
function DOMExceptionLike(name) {
  const e = new Error(name);
  e.name = name;
  return e;
}
