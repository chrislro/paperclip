// shared/clerk-tap.js — Telemetry beacon for the Clerk hosted-UI tab.
//
// Why this exists
//   Sign-in routes through https://*.accounts.dev (Clerk's hosted UI),
//   which is a different origin from our extension pages. Without a
//   content script there, any error inside Clerk's SPA — including
//   `invalid_url_scheme` rejections and `chrome-extension://invalid/`
//   redirect attempts — is invisible to us. This script + the global
//   console-shipper produce three log lines per visit:
//     1. page-load URL (full, with hash + search params)
//     2. any window-level error or unhandledrejection while the SPA
//        is mounted
//     3. URL transitions caused by the SPA (push/replace/hashchange)
//        — including the moment Clerk decides to redirect to a
//        chrome-extension:// URL it shouldn't.
//
// Loaded as a content script on https://*.accounts.dev/* at
// document_start (alongside shared/console-shipper.js). console.warn
// here gets wrapped by console-shipper which ships to
// /api/debug-log via the service worker.
//
// Designed to never break Clerk's UI:
//   - All hooks wrapped in try/catch and never throw.
//   - No DOM mutations.
//   - URL-change observer is a 500ms interval (no MutationObserver
//     on Clerk's heavy SPA tree).
//   - Idempotent: self.__tfdrClerkTapInstalled guards re-injection.

(function () {
  if (typeof self === 'undefined' || self.__tfdrClerkTapInstalled) return;
  if (typeof location === 'undefined') return;
  self.__tfdrClerkTapInstalled = true;

  // CSO-002: strip one-time OAuth/session tokens from URLs before they hit
  // /api/debug-log via the console shipper. Clerk delivers `code` and `state`
  // through both query (?) and fragment (#) anchors, so the leading character
  // class and the negated character class must include both.
  function redactUrl(url, maxLen) {
    return String(url)
      .replace(/([?#&])(code|state|session_token|__clerk_token)=[^&#]*/gi, '$1$2=[redacted]')
      .slice(0, maxLen);
  }

  try {
    console.warn('[Toca Ficha CLERKTAP] page-load url=' + redactUrl(location.href, 800));
  } catch (_) { /* never throw */ }

  try {
    window.addEventListener('error', function (e) {
      try {
        var msg = (e && e.message) || String(e);
        console.warn('[Toca Ficha CLERKTAP] window.error: ' + String(msg).slice(0, 400));
      } catch (_) {}
    });
    window.addEventListener('unhandledrejection', function (e) {
      try {
        var reason = e && (e.reason && (e.reason.message || e.reason)) || e;
        console.warn('[Toca Ficha CLERKTAP] unhandled rejection: ' + String(reason).slice(0, 400));
      } catch (_) {}
    });
  } catch (_) {}

  // Watch SPA-driven URL changes. Clerk's hosted UI uses both fragment
  // navigation and history.pushState, so we sample location.href.
  try {
    var lastUrl = String(location.href);
    setInterval(function () {
      try {
        var cur = String(location.href);
        if (cur !== lastUrl) {
          var oldUrl = lastUrl;
          lastUrl = cur;
          console.warn(
            '[Toca Ficha CLERKTAP] nav from=' + redactUrl(oldUrl, 200)
              + ' to=' + redactUrl(cur, 800)
          );
        }
      } catch (_) {}
    }, 500);
  } catch (_) {}
})();
