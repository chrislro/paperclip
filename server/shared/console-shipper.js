// shared/console-shipper.js — Ships intercepted console.warn / console.error
// calls to the backend /api/debug-log endpoint via the service worker. Loaded
// in every non-SW extension context (content scripts, side panel, popup).
//
// Why this exists
//   The doctor never sees the diagnostic console output — the dev (Claude)
//   tails the resulting log file remotely on the Mac Mini. This decouples
//   "user finds a bug" from "dev sees what the code saw at the moment of
//   failure" without asking the doctor to copy-paste from DevTools every
//   time. Invisible to the user — there is no UI surface.
//
// Activation is automatic on script load. The IIFE:
//   1. No-ops if already installed (idempotent across re-injection).
//   2. Saves references to the original console.warn / console.error.
//   3. Replaces them with wrappers that call the original AND fire
//      chrome.runtime.sendMessage({type: TOCAFICHADR_DEBUG_LOG, payload: ...}).
//
// Designed to never break the host context:
//   - Original console call runs FIRST, so DevTools always sees the message
//     even if the ship step throws.
//   - Stringification falls back through (string → Error → JSON.stringify →
//     String()) so unrenderable args become "[object …]" instead of throwing.
//   - chrome.runtime errors (SW asleep, extension reloaded mid-call) are
//     swallowed — debug logging must never cascade into another failure.
//
// Service-worker context is intentionally NOT wrapped here because (a) the
// SW is the recipient of TOCAFICHADR_DEBUG_LOG itself and (b) chrome.runtime
// .sendMessage from the SW does not fire its own onMessage listener, so it
// would silently fail. SW interception, if needed, must POST directly via
// fetch — added separately if the need arises.

(function () {
  if (typeof self === 'undefined' || self.__tfdrConsoleShipperInstalled) return;
  if (typeof console === 'undefined' || typeof chrome === 'undefined' || !chrome.runtime) return;
  self.__tfdrConsoleShipperInstalled = true;

  var origWarn  = console.warn.bind(console);
  var origError = console.error.bind(console);

  // CSO-003: scrub clinical PII from message text before shipping.
  // Removes ICD-10/CID codes and URL query params; truncates to 200 chars.
  //
  // IMPORTANT — patient names are NOT redacted here. They have no fixed
  // pattern to match. Call-site discipline is the only defense: never
  // console.warn/error a patient name. If a diagnostic must reference
  // the active patient, use an opaque internId instead. The /api/debug-log
  // docstring warns about historical outerHTML snapshots that may have
  // leaked names — those snapshots should be removed at the source.
  function _scrubMessage(msg) {
    if (typeof msg !== 'string') return msg;
    return msg
      .replace(/\b[A-Z]\d{2}(\.\d{1,2})?\b/g, '[CID-redacted]')
      .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/g, '$1[?redacted]')
      .slice(0, 200);
  }

  // CSO-002: strip one-time OAuth/session tokens from URLs before they hit
  // /api/debug-log. Mirrors shared/clerk-tap.js redactUrl() — inlined here to
  // keep console-shipper.js self-contained (no extra load-order dependency).
  // Keep both copies in sync; tests/test-debug-log.js asserts regex parity.
  function _redactUrl(url, maxLen) {
    return String(url)
      .replace(/([?#&])(code|state|session_token|__clerk_token)=[^&#]*/gi, '$1$2=[redacted]')
      .slice(0, maxLen);
  }

  function _stringifyArg(a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return (a.message || '') + (a.stack ? '\n' + a.stack : '');
    if (a === null || a === undefined) return String(a);
    if (typeof a !== 'object') return String(a);
    try { return JSON.stringify(a); } catch (_) { return String(a); }
  }

  function _detectSource() {
    try {
      var url = (typeof location !== 'undefined' && location.href) || '';
      if (url.indexOf('sidepanel') !== -1) return 'sidepanel';
      if (url.indexOf('popup') !== -1) return 'popup';
      if (url.indexOf('chrome-extension://') === 0) return 'extension-page';
      return 'content-script';
    } catch (_) { return 'unknown'; }
  }

  // CSO-002: strip one-time OAuth/session tokens from URLs before they hit
  // /api/debug-log. Must match the regex in shared/clerk-tap.js exactly.
  function _redactUrl(url, maxLen) {
    if (typeof url !== 'string') return '';
    return url
      .replace(/([?#&])(code|state|session_token|__clerk_token)=[^&#]*/gi, '$1$2=[redacted]')
      .slice(0, maxLen || 800);
  }

  function _ship(level, args) {
    try {
      var manifest = (chrome.runtime.getManifest && chrome.runtime.getManifest()) || {};
      var msg = Array.prototype.map.call(args, _stringifyArg).join(' ');
      // Cap message size so a wild outerHTML dump can't blow the wire.
      if (msg.length > 4000) msg = msg.slice(0, 4000) + ' …(truncated)';
      var payload = {
        level: level,
        message: _scrubMessage(msg),
        source: _detectSource(),
        ts: new Date().toISOString(),
        ext_version: manifest.version || '?',
        url: (typeof location !== 'undefined' && location.href) ? _redactUrl(location.href, 400) : '',
      };
      chrome.runtime.sendMessage({ type: 'TOCAFICHADR_DEBUG_LOG', payload: payload }, function () {
        // Touch lastError so Chrome doesn't log "Unchecked runtime.lastError"
        // when the SW is asleep / the extension was reloaded mid-call.
        if (chrome.runtime.lastError) { /* swallow */ }
      });
    } catch (_) { /* never throw from console */ }
  }

  console.warn = function () {
    origWarn.apply(null, arguments);
    _ship('warn', arguments);
  };
  console.error = function () {
    origError.apply(null, arguments);
    _ship('error', arguments);
  };
})();
