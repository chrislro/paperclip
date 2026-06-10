// audio-capture.js — MediaRecorder wrapper for Toca Ficha Dr.
// Captures microphone audio and delivers a Blob to the caller.
// No base64 conversion, no service worker messaging.

'use strict';

window.TOCAFICHADR_audio = (function () {

  const MIME_CANDIDATES = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ];

  const MIN_BLOB_BYTES = 500;

  // === Silence trim (Web Audio VAD) — added 2026-04-29 ===
  // Tunables for the analyser-driven pause/resume loop. Values chosen for
  // single-speaker medical dictation in a typical consult-room ambient profile.
  // Pure math (rmsDb, clampThreshold, vadStep) lives in `content/vad-helpers.js`
  // so it can be unit-tested under Node; this file owns the Web Audio side
  // effects (AudioContext, analyser, MediaRecorder pause/resume).
  const VAD_FFT_SIZE             = 1024;   // 1024 samples ≈ 23 ms frame at 44.1 kHz
  const VAD_SMOOTHING            = 0.2;    // light smoothing — we want responsive transitions
  const VAD_POLL_MS              = 50;     // 20 Hz poll loop
  // === End silence trim ===

  let _stream        = null;
  let _recorder      = null;
  let _chunks        = [];
  let _mimeType      = null;
  let _onStop        = null;
  let _recording     = false;
  let _effectiveBitsPerSecond = null;
  let _trackSettings = null;
  let _lastAudioConfig = null;
  // CHRA-1102: client-side latency timestamps
  let _timestamps    = null;
  // Module-scope handles for the track dead-detector listeners added in start()
  // so _release() can removeEventListener before the next recording starts.
  // Without this, a stale _onTrackDead from session N can fire on the 'ended'
  // event queued during t.stop() in _release(), find _recording===true for
  // session N+1, and call stop() into the live session, silently aborting it.
  let _deadTrack           = null;
  let _deadTrackListener   = null;

  // === Silence trim (Web Audio VAD) — added 2026-04-29 ===
  let _audioCtx      = null;
  let _vadSource     = null;
  let _vadAnalyser   = null;
  let _vadBuf        = null;
  let _vadInterval   = null;
  // Pure-math state owned by vad-helpers.js. Mirrors the previous _vadStartedAt /
  // _vadFloorDb / _vadFloorMin / _vadVoiceActive / _vadLastVoiceTs locals.
  let _vadState      = null;
  // === End silence trim ===

  /**
   * Detect the best supported MIME type for MediaRecorder.
   * Returns the first supported candidate, or null if none match
   * (the browser will use its own default in that case).
   */
  function _detectMimeType() {
    if (typeof MediaRecorder === 'undefined') return null;
    for (const type of MIME_CANDIDATES) {
      try {
        if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) {
          return type;
        }
      } catch (_) {
        // isTypeSupported may throw in some environments — skip
      }
    }
    return null;
  }

  /**
   * Release all mic tracks and reset internal state.
   */
  function _release() {
    // === Silence trim (Web Audio VAD) — added 2026-04-29 ===
    // Tear down VAD before stopping the stream so we don't poll a dead source.
    _vadTeardown();
    // === End silence trim ===

    // === v3.3.0 — waveform broadcast teardown ===
    // Stop the side-panel broadcast interval + close the visualizer
    // AudioContext before the stream ends so we don't poll a dead source.
    _vizFullTeardown();
    // === End waveform broadcast ===

    // Remove track dead-detector before stopping the track. t.stop() queues
    // an 'ended' event; without this removeEventListener the stale listener
    // fires after _release() clears _recording=false, but if a new session has
    // already started (possible because the guard checks _recording), the
    // listener sees _recording=true for the NEW session and calls stop() into it.
    if (_deadTrack && _deadTrackListener) {
      try { _deadTrack.removeEventListener('ended', _deadTrackListener); } catch (_) {}
      try { _deadTrack.removeEventListener('mute',  _deadTrackListener); } catch (_) {}
    }
    _deadTrack = null;
    _deadTrackListener = null;

    if (_stream) {
      _stream.getTracks().forEach(function (t) { t.stop(); });
      _stream = null;
    }
    _recorder  = null;
    _chunks    = [];
    _mimeType  = null;
    _recording = false;
    _trackSettings = null;
  }

  function _sanitizeTrackSettings(settings) {
    if (!settings || typeof settings !== 'object') return null;
    var allowed = [
      'sampleRate',
      'sampleSize',
      'channelCount',
      'latency',
      'echoCancellation',
      'noiseSuppression',
      'autoGainControl',
    ];
    var out = {};
    allowed.forEach(function (key) {
      if (settings[key] !== undefined && settings[key] !== null) out[key] = settings[key];
    });
    return Object.keys(out).length ? out : null;
  }

  function _currentAudioConfig() {
    var config = {
      mimeType: _mimeType || null,
      audioBitsPerSecond: _effectiveBitsPerSecond,
      requestedBitsPerSecond: 32000,
    };
    if (_trackSettings) config.trackSettings = _trackSettings;
    return config;
  }

  // === Silence trim (Web Audio VAD) — added 2026-04-29 ===
  // Pure math (RMS dB, threshold clamp, state-machine step) lives in
  // `content/vad-helpers.js` and is loaded by manifest.json before this file.
  function _vadHelpers() {
    return (typeof window !== 'undefined' && window.TOCAFICHADR_vad) || null;
  }

  // Build the AudioContext graph and start the polling loop.
  // Failures here are non-fatal — recording proceeds without trimming if VAD
  // can't initialise (e.g. AudioContext blocked, getFloatTimeDomainData
  // unsupported). We never want to break a doctor's recording over a perf opt.
  function _vadStart() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      var helpers = _vadHelpers();
      if (!Ctx || !_stream || !helpers) return;

      _audioCtx     = new Ctx();
      _vadSource    = _audioCtx.createMediaStreamSource(_stream);
      _vadAnalyser  = _audioCtx.createAnalyser();
      _vadAnalyser.fftSize = VAD_FFT_SIZE;
      _vadAnalyser.smoothingTimeConstant = VAD_SMOOTHING;
      _vadSource.connect(_vadAnalyser);
      // NOTE: we deliberately do NOT connect the analyser to the destination —
      // that would route mic audio to the speakers, causing feedback.

      _vadBuf = new Float32Array(_vadAnalyser.fftSize);
      var now = Date.now();

      // Read VAD mode from global config (set by popup/settings)
      // Defaults to 'current' for backward compatibility.
      var vadMode = (window.TOCAFICHADR_vadMode || 'current');
      _vadState = helpers.createState(vadMode, now);

      _vadInterval = setInterval(_vadTick, VAD_POLL_MS);
    } catch (err) {
      // VAD setup failed — clean up partial state and let MediaRecorder run unmodified.
      _vadTeardown();
    }
  }

  // One iteration of the analyser poll loop.
  function _vadTick() {
    if (!_vadAnalyser || !_recorder || !_recording) return;

    var helpers = _vadHelpers();
    if (!helpers || !_vadState) return;

    try {
      _vadAnalyser.getFloatTimeDomainData(_vadBuf);
    } catch (_) {
      return;
    }

    var nowDb  = helpers.rmsDb(_vadBuf);
    var now    = Date.now();
    var result = helpers.vadStep(_vadState, nowDb, now);

    _vadState = result.state;

    // Post-trim mode: never pause/resume recorder, just collect segments
    if (_vadState.preset && _vadState.preset.postTrim) {
      // Post-trim mode records everything; segments are analyzed after stop()
      return;
    }

    if (result.decision === 'resume') {
      try {
        if (_recorder && _recorder.state === 'paused') {
          _recorder.resume();
        }
      } catch (_) { /* recorder may have been stopped between checks */ }
    } else if (result.decision === 'pause') {
      try {
        if (_recorder && _recorder.state === 'recording') {
          _recorder.pause();
        }
      } catch (_) { /* recorder may have been stopped between checks */ }
    }
    // 'calibrate' and 'noop' produce no recorder action.
  }

  // Tear down all VAD state. Idempotent — safe to call multiple times and from
  // either _release() (normal stop) or _vadStart() error path (init failure).
  function _vadTeardown() {
    if (_vadInterval) {
      clearInterval(_vadInterval);
      _vadInterval = null;
    }
    try { if (_vadSource) _vadSource.disconnect(); } catch (_) {}
    _vadSource    = null;
    _vadAnalyser  = null;
    _vadBuf       = null;
    if (_audioCtx) {
      try {
        // close() is async; we don't need to await — the promise rejection on
        // double-close is harmless and we discard the reference either way.
        if (typeof _audioCtx.close === 'function' && _audioCtx.state !== 'closed') {
          _audioCtx.close().catch(function () {});
        }
      } catch (_) {}
      _audioCtx = null;
    }
    _vadState = null;
  }
  // === End silence trim ===

  /**
   * start(onStop) — Request mic access, begin recording.
   *
   * @param {function(Blob|null, string|null): void} onStop
   *   Called when recording finishes. Receives (blob, null) on success
   *   or (null, errorMessage) on failure.
   * @returns {Promise<void>} Resolves when recording starts, rejects on mic error.
   */
  async function start(onStop) {
    if (_recording) {
      throw new Error('Gravacao ja em andamento');
    }

    if (typeof onStop !== 'function') {
      throw new TypeError('onStop deve ser uma funcao');
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('getUserMedia nao disponivel neste contexto');
    }

    _onStop = onStop;
    _chunks = [];
    // CHRA-1102: initialize client-side latency timestamps
    _timestamps = { record_start: Date.now() };

    _stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Observe track.ended AND track.mute so we fail fast if the mic stream dies
    // mid-recording. 'ended' fires on device unplug / tab suspend; 'mute' fires
    // when the user revokes mic permission via chrome://settings (Chrome does
    // NOT fire 'ended' in that path — confirmed by phase-001 UAT test 3).
    // Without this, MediaRecorder keeps "recording" from its own perspective but
    // no audio arrives, and the HUD timer keeps ticking — the doctor only finds
    // out when they stop and receive a silent/truncated blob.
    var _endedTrack = _stream.getAudioTracks()[0];
    if (_endedTrack) {
      try {
        if (typeof _endedTrack.getSettings === 'function') {
          _trackSettings = _sanitizeTrackSettings(_endedTrack.getSettings());
        }
      } catch (_) {
        _trackSettings = null;
      }
      // Store at module scope so _release() can removeEventListener before the
      // next recording session starts. Without this, the 'ended' event queued by
      // t.stop() in _release() can fire AFTER a new session sets _recording=true,
      // causing the stale listener to call stop() into the live new session.
      _deadTrack = _endedTrack;
      _deadTrackListener = function () {
        if (_recording) {
          // Route through stop() so the normal onStop pipeline fires and the
          // HUD can surface an error via the MIN_BLOB_BYTES guard or the
          // caller's own handling of a short blob.
          try { stop(); } catch (_) { /* already stopped */ }
        }
      };
      _endedTrack.addEventListener('ended', _deadTrackListener);
      _endedTrack.addEventListener('mute', _deadTrackListener);
    }

    _mimeType = _detectMimeType();

    // 32kbps is optimal for speech-only medical dictation with Opus codec.
    // Default (~128kbps) produces ~480KB for 30s; 32kbps produces ~120KB.
    // 4x smaller file → faster upload to Whisper → faster transcription.
    // Whisper quality is unaffected at 32kbps for clear single-speaker speech.
    var recorderOpts = { audioBitsPerSecond: 32000 };
    if (_mimeType) recorderOpts.mimeType = _mimeType;
    // MediaRecorder's constructor can throw (NotSupportedError) AFTER
    // getUserMedia already opened the mic. Without this guard the live stream
    // is never released: the mic stays hot (privacy concern) and the next
    // start() overwrites _stream, orphaning these tracks (never .stop()'d).
    // _release() stops the tracks + removes the dead-track listeners we just
    // attached, then we rethrow so the caller still sees the failure.
    try {
      _recorder = new MediaRecorder(_stream, recorderOpts);
    } catch (err) {
      _release();
      throw err;
    }

    // Keep the effective MIME type (browser may differ from what we passed)
    _mimeType = _recorder.mimeType || _mimeType || 'audio/webm';
    // Capture the bitrate Chrome actually negotiated. Chrome may downshift
    // from our requested 32 kbps on weak hardware (Bluetooth headsets at
    // low battery, USB hubs sharing bandwidth, etc). Useful for diagnosing
    // rare quality complaints without asking the doctor for repro. Reported
    // via getEffectiveAudioConfig() — read by HUD on transcribe path.
    _effectiveBitsPerSecond = _recorder.audioBitsPerSecond || null;
    _lastAudioConfig = _currentAudioConfig();

    _recorder.ondataavailable = function (e) {
      if (e.data && e.data.size > 0) {
        _chunks.push(e.data);
      }
    };

    _recorder.onstop = function () {
      var blob    = new Blob(_chunks, { type: _mimeType });
      var cb      = _onStop;
      _lastAudioConfig = _currentAudioConfig();
      // CHRA-1102: record when the blob is ready (MediaRecorder finished)
      if (_timestamps) {
        _timestamps.blob_ready = Date.now();
      }
      _release();

      if (blob.size < MIN_BLOB_BYTES) {
        cb(null, 'Gravacao muito curta — fale por pelo menos 2 segundos');
        return;
      }

      // CHRA-1102: pass timestamps alongside the blob so the bridge can forward them
      cb(blob, null, _timestamps);
    };

    // Emit chunks every 1 s so we always have data even if stop() is called early
    _recorder.start(1000);
    _recording = true;

    // === Silence trim (Web Audio VAD) — added 2026-04-29 ===
    // Spin up the analyser-driven pause/resume loop. _vadStart() swallows its
    // own errors so a VAD init failure never blocks the recording itself —
    // the doctor still gets full untrimmed audio if Web Audio is misbehaving.
    _vadStart();
    // === End silence trim ===
  }

  /**
   * stop() — Stop recording, release mic tracks, and trigger the onStop callback.
   * Safe to call even when not recording (no-op).
   */
  function stop() {
    if (!_recording || !_recorder) return;

    // CHRA-1102: record when the user clicked stop
    if (_timestamps) {
      _timestamps.record_stop_clicked = Date.now();
    }

    _recording = false; // Mark early so isRecording() returns false immediately
    try {
      _recorder.stop(); // onstop fires asynchronously, which calls _release + _onStop
    } catch (err) {
      // If stop() itself throws, still clean up and notify caller
      var cb = _onStop;
      _release();
      if (cb) cb(null, 'Erro ao parar gravacao: ' + err.message);
    }
  }

  /**
   * isRecording() — Returns true while MediaRecorder is active.
   * @returns {boolean}
   */
  function isRecording() {
    return _recording;
  }

  /**
   * getEffectiveAudioConfig() — returns the audio config Chrome actually
   * negotiated for the most recent MediaRecorder instance, or null if no
   * recorder has been constructed in this content-script lifetime.
   * Used by audit telemetry to diagnose hardware-driven bitrate downshifts.
   */
  function getEffectiveAudioConfig() {
    if (!_recorder) return _lastAudioConfig;
    return _currentAudioConfig();
  }

  // === v3.1 idea #3: live waveform visualizer ===
  // Builds a separate AudioContext + AnalyserNode tap on the active stream,
  // renders a frequency-bin bar viz to a canvas. Independent of the VAD
  // analyser (which we don't want to share — different fftSize, different
  // poll cadence).
  // Returns a `stop()` function the caller invokes when recording ends.
  // Returns null (no-op stop) if no stream is active.
  var _vizCtx = null;
  var _vizSrc = null;
  var _vizAnalyser = null;
  var _vizRaf = 0;

  // === v3.3.0 — waveform broadcast for the side panel ===
  // The side panel runs in a separate chrome-extension:// page and can't share
  // an AnalyserNode with the content script. We sample the analyser bins on a
  // setInterval here and forward them via chrome.runtime.sendMessage so the
  // side panel can render its own canvas. Reuses the visualizer AudioContext
  // graph (so we don't spin up a third AudioContext on every recording).
  var _broadcastInterval = null;
  var _broadcastBins = null;
  var _BROADCAST_BAR_COUNT = 24;

  // Lazily ensure the visualizer analyser exists, even if attachVisualizer()
  // was never called from a HUD canvas. Returns true on success, false if the
  // current stream / Web Audio support can't accommodate a tap.
  function _ensureVizAnalyser() {
    if (_vizAnalyser) return true;
    if (!_stream) return false;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    try {
      _vizCtx = new Ctx();
      _vizSrc = _vizCtx.createMediaStreamSource(_stream);
      _vizAnalyser = _vizCtx.createAnalyser();
      _vizAnalyser.fftSize = 256;
      _vizAnalyser.smoothingTimeConstant = 0.65;
      _vizSrc.connect(_vizAnalyser);
      return true;
    } catch (_) {
      // Cleanup partial state — fall back to no-op (recording continues without viz)
      try { _vizSrc && _vizSrc.disconnect(); } catch (__) {}
      try { _vizCtx && _vizCtx.close && _vizCtx.close(); } catch (__) {}
      _vizSrc = null; _vizAnalyser = null; _vizCtx = null;
      return false;
    }
  }

  function attachVisualizer(canvas) {
    if (!_stream || !canvas || !canvas.getContext) return { stop: function () {} };
    if (!_ensureVizAnalyser()) return { stop: function () {} };
    var bins = new Uint8Array(_vizAnalyser.frequencyBinCount);
    var g = canvas.getContext('2d');
    var BAR_COUNT = 24;
    function draw() {
      _vizRaf = requestAnimationFrame(draw);
      _vizAnalyser.getByteFrequencyData(bins);
      var W = canvas.width;
      var H = canvas.height;
      g.clearRect(0, 0, W, H);
      g.fillStyle = '#10b981';
      var bw = W / BAR_COUNT;
      for (var i = 0; i < BAR_COUNT; i++) {
        // Sample a low-frequency bin (speech energy is mostly in 100-400 Hz first bins)
        var v = bins[i * 2] / 255;
        var barH = Math.max(2, v * H * 0.95);
        g.fillRect(i * bw + 1, (H - barH) / 2, bw - 2, barH);
      }
    }
    draw();

    return {
      stop: function () {
        if (_vizRaf) cancelAnimationFrame(_vizRaf);
        _vizRaf = 0;
        // NOTE: we deliberately do NOT close _vizCtx / disconnect _vizSrc here
        // because startVisualizerBroadcast() may still be running off the same
        // analyser. _release() owns the final teardown.
      },
    };
  }

  /**
   * startVisualizerBroadcast(intervalMs)
   *
   * Sample the visualizer analyser at the given cadence (default ~30Hz) and
   * broadcast a 24-element Uint8 array via chrome.runtime.sendMessage so the
   * side panel can render a live waveform without sharing the AnalyserNode.
   *
   * Reuses the AudioContext graph that `attachVisualizer` builds — falls back
   * to lazy-init if the HUD never called it (which is the v3.1+ side-panel
   * case). Failures here are non-fatal: recording continues without viz.
   *
   * Idempotent — safe to call twice (later call wins, prior interval cleared).
   */
  function startVisualizerBroadcast(intervalMs) {
    var ms = Math.max(16, intervalMs || 33);
    stopVisualizerBroadcast();
    if (!_recording) return;
    if (!_ensureVizAnalyser()) return;
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;

    var binCount = _vizAnalyser.frequencyBinCount;
    _broadcastBins = new Uint8Array(binCount);
    // Stride samples the lower-frequency end where speech energy lives
    // (bins[i*2]) when fftSize=256. Mirrors attachVisualizer()'s i*2 pattern.
    var stride = 2;

    _broadcastInterval = setInterval(function () {
      if (!_recording || !_vizAnalyser) {
        stopVisualizerBroadcast();
        return;
      }
      try {
        _vizAnalyser.getByteFrequencyData(_broadcastBins);
      } catch (_) {
        return;
      }
      // Downsample to 24 bins so the message is a fixed-shape, ~24-byte payload.
      var out = new Array(_BROADCAST_BAR_COUNT);
      for (var i = 0; i < _BROADCAST_BAR_COUNT; i++) {
        var idx = Math.min(i * stride, binCount - 1);
        out[i] = _broadcastBins[idx];
      }
      try {
        chrome.runtime.sendMessage({
          type: 'TOCAFICHADR_WAVEFORM_BINS',
          bins: out,
        }).catch(function () {
          // Side panel may be closed — broadcasts are fire-and-forget
        });
      } catch (_) { /* extension context invalidated — interval clears next tick via _recording flip */ }
    }, ms);
  }

  /**
   * stopVisualizerBroadcast() — clear the broadcast interval. Idempotent.
   * Called from stop() / _release() and also on track ended/mute.
   */
  function stopVisualizerBroadcast() {
    if (_broadcastInterval) {
      clearInterval(_broadcastInterval);
      _broadcastInterval = null;
    }
    _broadcastBins = null;
  }

  // Full visualizer teardown — stops the broadcast interval, cancels any
  // outstanding rAF from attachVisualizer's draw loop, and closes the shared
  // AudioContext. Idempotent. Called from _release() so a recording stop
  // always cleans up regardless of whether attachVisualizer's own stop() ran.
  function _vizFullTeardown() {
    stopVisualizerBroadcast();
    if (_vizRaf) cancelAnimationFrame(_vizRaf);
    _vizRaf = 0;
    try { _vizSrc && _vizSrc.disconnect(); } catch (_) {}
    try { _vizAnalyser && _vizAnalyser.disconnect(); } catch (_) {}
    try { _vizCtx && _vizCtx.close && _vizCtx.close(); } catch (_) {}
    _vizSrc = null; _vizAnalyser = null; _vizCtx = null;
  }

  // Guard: if the content script is unloaded during active recording, clear
  // the VAD interval before it fires on a dead AudioContext/stream.
  window.addEventListener('beforeunload', _vadTeardown);

  return {
    start,
    stop,
    isRecording,
    getEffectiveAudioConfig,
    attachVisualizer,
    startVisualizerBroadcast,
    stopVisualizerBroadcast,
  };

})();
