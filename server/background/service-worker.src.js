// service-worker.src.js — Toca Ficha Dr. background service worker (v3.0)
// Bundled by esbuild → background/service-worker.bundle.js (manifest references).
// v3.0.3: dropped v2.6.1 _refreshInFlight + _refreshAccessToken — Clerk SDK
// (createClerkClient with background: true) handles JWT rotation natively.

import { createClerkClient } from '@clerk/chrome-extension/background';
import '../shared/error-helpers.js'; // inlines _normalizeApiError into the IIFE bundle scope

const API_DISCOVERY_PRIMARY_URL = 'https://api.tocafichadr.com.br/config/api-url.json';
const API_DISCOVERY_FALLBACK_URL = 'https://gist.githubusercontent.com/chrislro/3abd7bec1b371681c4ab346bd642b8e6/raw/tocafichadr-api-url.json';
const API_DISCOVERY_TTL_MS = 10 * 60 * 1000;
const API_HOSTS_ALLOWLIST = /^(?:api\.tocafichadr\.com\.br|[a-z0-9-]+\.trycloudflare\.com)$/i;
const DEFAULT_API_BASE_URL = 'https://api.tocafichadr.com.br';
const CLERK_PUBLISHABLE_KEY = 'pk_live_Y2xlcmsudG9jYWZpY2hhZHIuY29tLmJyJA';

// Module-scope resolver for offscreen document readiness (fixes implicit global).
let offscreenReadyResolver = null;

// ---------------------------------------------------------------------------
// API Discovery — first-party primary with Gist fallback
// ---------------------------------------------------------------------------
async function _maybeDiscoverApiUrl(force) {
  if (!force) {
    const { _apiDiscoveryAt } = await chrome.storage.local.get(['_apiDiscoveryAt']);
    if (_apiDiscoveryAt && Date.now() - _apiDiscoveryAt < API_DISCOVERY_TTL_MS) return;
  }
  // Try first-party primary, then Gist fallback
  const urls = [API_DISCOVERY_PRIMARY_URL, API_DISCOVERY_FALLBACK_URL];
  for (const url of urls) {
    try {
      const resp = await fetch(url + '?cb=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!resp.ok) continue;
      const data = await resp.json();
      const discovered = data && data.apiBaseUrl;
      if (typeof discovered !== 'string') continue;
      let parsed;
      try { parsed = new URL(discovered); } catch (_) { continue; }
      if (parsed.protocol !== 'https:') continue;
      if (!API_HOSTS_ALLOWLIST.test(parsed.hostname)) continue;
      const current = (await chrome.storage.sync.get(['apiBaseUrl'])).apiBaseUrl;
      if (_isFirstPartyApiUrl(current) && parsed.hostname !== 'api.tocafichadr.com.br') return;
      if (current !== discovered) {
        await chrome.storage.sync.set({ apiBaseUrl: discovered });
      }
      await chrome.storage.local.set({ _apiDiscoveryAt: Date.now() });
      console.info('[sw] API discovery via', url);
      return; // Success — stop trying
    } catch (_) { /* try next URL */ }
  }
}

function _isFirstPartyApiUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).hostname === 'api.tocafichadr.com.br';
  } catch (_) {
    return false;
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const existing = await chrome.storage.sync.get(['apiBaseUrl']);
  if (details.reason === 'install') {
    await chrome.storage.sync.set({
      apiBaseUrl: DEFAULT_API_BASE_URL,
      autoClearSoap: true,
      autoCid: true,
    });
  } else if (
    existing.apiBaseUrl === 'http://localhost:5050' ||
    existing.apiBaseUrl === 'http://localhost:5051' ||
    existing.apiBaseUrl === 'http://127.0.0.1:5050'
  ) {
    // Migrate stale local dev URLs: normalize hostname and port (correct port is 5051).
    await chrome.storage.sync.set({ apiBaseUrl: 'http://127.0.0.1:5051' });
  }
  _maybeDiscoverApiUrl(true);
});

chrome.runtime.onStartup.addListener(() => {
  _maybeDiscoverApiUrl(true);
});

// v3.1 idea #4: Open the side panel when the toolbar icon is clicked.
// `setPanelBehavior({ openPanelOnActionClick: true })` makes Chrome route
// the action click to the side panel instead of the popup. The popup file
// remains in manifest as a fallback, but the side panel takes precedence
// on Chrome 114+ where the API exists.
try {
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((e) => console.warn('[SW] sidePanel.setPanelBehavior failed:', e?.message || e));
  }
} catch (e) {
  // Older Chrome — sidePanel API not present; popup will be used as fallback.
}

// ---------------------------------------------------------------------------
// Auth: Clerk-managed JWT (v3.0.3)
// ---------------------------------------------------------------------------
// Replaces v2.6.10's custom _refreshInFlight + _refreshAccessToken pair.
// Clerk's SDK (with background: true) handles JWT issuance, rotation, and
// session persistence inside the SW context. We just call session.getToken()
// per request — the SDK returns a fresh token if the cached one is near
// expiry, refreshes silently in the background if rotation is needed.
//
// The popup-side Clerk instance shares session state via chrome.storage, so
// signing out from the popup terminates SW-side session too.

let _clerkPromise = null;
function _getClerk() {
  if (!_clerkPromise) {
    // syncHost is critical for the SW Clerk client to share session state
    // with the popup/sidepanel Clerk client. Without it the SW's Clerk
    // instance is isolated, clerk.session is null, getToken() returns null,
    // and every authedFetch goes out without Authorization. Symmetric to
    // popup.src.js where the same syncHost is set on sign-in. Must match
    // exactly — Clerk binds the session cookie to this origin.
    _clerkPromise = createClerkClient({
      publishableKey: CLERK_PUBLISHABLE_KEY,
      syncHost: DEFAULT_API_BASE_URL,
      // background: true is REQUIRED per Clerk docs for SW contexts —
      // optimizes the client for environments without a DOM and is what
      // makes session.getToken() work without a window object. Without it,
      // clerk.session is null even when the popup-side client has the
      // session, because the SW client tries DOM-bound bootstrap and
      // silently fails. The import path @clerk/chrome-extension/background
      // alone is NOT sufficient — the flag is consumed by the constructor.
      background: true,
    })
      .catch((e) => {
        // Reset so a transient init failure doesn't permanently brick auth.
        _clerkPromise = null;
        throw e;
      });
  }
  return _clerkPromise;
}

// _swDebugLog — direct fetch to /api/debug-log because the SW context is
// NOT wrapped by shared/console-shipper.js (per its own design notes).
// Used only for SW-side diagnostics that the dev needs to see remotely.
async function _swDebugLog(msg, extra) {
  try {
    const settings = await chrome.storage.sync.get(['apiBaseUrl']);
    const baseUrl = (settings.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
    const manifest = chrome.runtime.getManifest();
    // CHRA-2136: attach Bearer so this diagnostic survives once the backend
    // enforces auth on /api/debug-log (TOCAFICHADR_AUTH_REQUIRED=true). Read
    // the token DIRECTLY from storage — NOT via _getAuthToken(), which itself
    // calls _swDebugLog() and would recurse infinitely. Mirrors the
    // storage-read pattern already used by _handleDebugLog/_handleError.
    const headers = { 'Content-Type': 'application/json' };
    try {
      // CHRA-2133: JWT lives in chrome.storage.session (not .local) so it is
      // cleared on browser close and unreadable by content scripts.
      const authData = await chrome.storage.session.get(['authToken']);
      if (authData.authToken) headers['Authorization'] = 'Bearer ' + authData.authToken;
    } catch (_) { /* no token available — best-effort, send unauthenticated */ }
    await fetch(baseUrl + '/api/debug-log', {
      method: 'POST',
      headers,
      // Endpoint reads fields at top level (NOT nested under payload).
      // payload-wrapping was a mistake in v1 of this diagnostic — backend
      // logged [INFO] [?] [v=?] [] | url= because Flask's data.get('message')
      // returned "" when message lived under data['payload']['message'].
      body: JSON.stringify({
        level: 'warn',
        message: '[SW DIAG] ' + msg + (extra ? ' ' + JSON.stringify(extra).slice(0, 400) : ''),
        source: 'service-worker',
        ts: new Date().toISOString(),
        ext_version: manifest.version || '?',
        url: 'sw',
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (_) { /* never throw from diagnostics */ }
}

async function _getAuthToken() {
  // 2026-05-25: storage is authoritative; SDK path is a fallback.
  //
  // Why storage-first: the popup actively refreshes
  // chrome.storage.session.authToken every 30s via _refreshStoredAuthToken,
  // writing both the latest token AND its `exp` claim as authTokenExpiry.
  // The SW's Clerk SDK session can survive across SW restarts in MV3 but
  // its in-memory token can lag behind what the popup just minted —
  // observed live (cloud-api.log 2026-05-25 13:14:21/42/57): the sidepanel's
  // storage Bearer returns 200 on /api/transcribe while the SW's SDK Bearer
  // returns 401 on /api/soap-stream in the same second. Same user, same
  // minute, different tokens. Storage is the freshly-refreshed copy; SDK is
  // a cached session-token that's already been rejected by Clerk's verify
  // path. Inverting the preference closes the divergence with no behavior
  // change for the empty-storage case (SDK still tried).
  try {
    const stored = await chrome.storage.session.get(['authToken', 'authTokenExpiry']);
    if (stored.authToken) {
      // CSO-009 (revised 2026-05-25): the original 60s pre-expiry buffer
      // was sized for the FALLBACK case. When storage became primary AND
      // Clerk's default session-token lifetime is 60s, a 60s buffer rejects
      // every freshly-stored token — the popup writes a token, expiry is
      // ~now+60s, the buffer says "within 60s of expiry → skip", and we
      // immediately fall through to SDK (which has no session in MV3 SW
      // context) → return null → 401 floor on every authed request.
      // The popup refreshes via _refreshStoredAuthToken every 30s, so
      // storage is always within 30s of mint. 5s margin covers wire RTT +
      // local clock skew vs Clerk's server clock without consuming the
      // token's useful lifetime.
      const expiry = stored.authTokenExpiry || 0;
      if (expiry && Date.now() > expiry - 5_000) {
        _swDebugLog('getToken: storage token within 5s of expiry — trying SDK', {
          expiry,
          now: Date.now(),
          remainingMs: expiry - Date.now(),
        });
      } else {
        _swDebugLog('getToken: ok via storage (primary)', {
          tokenLen: stored.authToken.length,
          remainingMs: expiry ? expiry - Date.now() : null,
        });
        return stored.authToken;
      }
    }
  } catch (e) {
    _swDebugLog('storage path threw, trying SDK fallback', {
      err: String(e && e.message || e).slice(0, 200),
    });
  }
  // Fallback: ask the SDK directly. Reached when storage is empty (no
  // popup has run in this profile yet) or when storage holds a near-expired
  // token (popup refresh may have missed a cycle).
  try {
    const clerk = await _getClerk();
    if (clerk && clerk.session) {
      const token = await clerk.session.getToken();
      if (token) {
        _swDebugLog('getToken: ok via SDK (fallback)', {
          tokenLen: token.length,
          sessionId: (clerk.session.id || '').slice(0, 20),
        });
        return token;
      }
    }
    _swDebugLog('getToken: no token (storage + SDK both empty)', {});
  } catch (e) {
    _swDebugLog('SDK fallback threw', {
      err: String(e && e.message || e).slice(0, 200),
    });
  }
  return null;
}

// _authedFetch — wraps fetch() with Bearer header. Token comes from Clerk SDK,
// which manages rotation internally — no 401-retry dance needed.
// The trailing `_skipRefresh` arg from v2.6.x is accepted but ignored
// (kept so existing call sites don't need to change).
async function _authedFetch(url, init, _skipRefresh) {
  const token = await _getAuthToken();
  const headers = Object.assign({}, (init && init.headers) || {});
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return fetch(url, Object.assign({}, init || {}, { headers }));
}

// ---------------------------------------------------------------------------
// Periodic token refresh via chrome.alarms (2026-05-25)
// ---------------------------------------------------------------------------
// The popup's setInterval-based refresh (popup.src.js:264) only runs while
// the popup window is open. With Clerk's default 60s session-token lifetime,
// closing the popup means storage goes stale within a minute — every authed
// fetch from the sidepanel then 401s with TOKEN_EXPIRED.
//
// This alarm runs the same refresh logic from the SW context, which keeps
// running even when no extension UI is open. SW Clerk session sync is the
// known-flaky piece (production tier has been observed not propagating
// session into the SW); when clerk.session is null this is a no-op and we
// rely on the popup as the canonical refresh point. When the SDK DOES sync,
// this keeps storage fresh in the background and the sidepanel never sees
// a stale token.
//
// Side effect: the SW does not stay alive for the alarm — Chrome resumes
// the SW briefly to fire `onAlarm`, runs our handler, then suspends again.
// Cost is negligible (one Clerk SDK call per minute, no UI work).
const TOKEN_REFRESH_ALARM = 'tocafichadr-token-refresh';

async function _swRefreshStoredAuthToken() {
  try {
    const clerk = await _getClerk();
    if (!clerk || !clerk.session) {
      _swDebugLog('refresh-alarm: no Clerk session in SW — popup is the canonical refresh', {});
      return;
    }
    const token = await clerk.session.getToken();
    if (!token) {
      _swDebugLog('refresh-alarm: clerk.session.getToken() returned empty', {});
      return;
    }
    // Decode the JWT exp claim to mirror popup.src.js _jwtExp.
    let expiryMs = 0;
    try {
      const parts = token.split('.');
      if (parts.length >= 2) {
        const pad = '='.repeat((4 - (parts[1].length % 4)) % 4);
        const decoded = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/') + pad);
        const claims = JSON.parse(decoded);
        if (typeof claims.exp === 'number') {
          expiryMs = claims.exp * 1000;
        }
      }
    } catch (_) { /* malformed JWT — write token without expiry; storage-path check tolerates this */ }
    await chrome.storage.session.set({ authToken: token, authTokenExpiry: expiryMs });
    _swDebugLog('refresh-alarm: storage updated via SW SDK', {
      tokenLen: token.length,
      remainingMs: expiryMs ? expiryMs - Date.now() : null,
    });
  } catch (e) {
    _swDebugLog('refresh-alarm: refresh threw', {
      err: String(e && e.message || e).slice(0, 200),
    });
  }
}

if (chrome.alarms && chrome.alarms.create) {
  // Create-if-absent: Chrome persists alarms across SW restarts, but
  // creating an alarm with the same name resets it. Use get + create-if-missing
  // so a freshly-installed extension and a long-lived install both end up
  // with one running alarm.
  chrome.alarms.get(TOKEN_REFRESH_ALARM, (existing) => {
    if (!existing) {
      // periodInMinutes minimum is 0.5 (30s) — exactly the cadence the
      // popup uses (setInterval 30000ms). Matches user expectations.
      chrome.alarms.create(TOKEN_REFRESH_ALARM, { periodInMinutes: 0.5 });
    }
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === TOKEN_REFRESH_ALARM) {
      _swRefreshStoredAuthToken();
    }
  });
  // Also fire once at SW startup so a freshly-resumed SW gets a token
  // immediately rather than waiting up to 30s for the first alarm tick.
  _swRefreshStoredAuthToken();
}

// ---------------------------------------------------------------------------
// Active-operation keepalive (CHRA-1913)
// ---------------------------------------------------------------------------
// MV3 service workers can be killed after 30s of inactivity. Long-running
// operations (transcription 7-90s, SOAP streaming) need the SW to stay alive.
// We create a temporary alarm that fires every 20s while an operation is
// active. Chrome wakes the SW for each alarm tick, keeping it alive.
// The alarm is cleared when the operation finishes.
const ACTIVE_OPS_KEEPALIVE_ALARM = 'tocafichadr-active-ops-keepalive';

async function _acquireActiveOpsKeepalive() {
  if (!chrome.alarms || !chrome.alarms.create) return;
  try {
    const existing = await chrome.alarms.get(ACTIVE_OPS_KEEPALIVE_ALARM);
    if (!existing) {
      // 20s period = 0.333... minutes; minimum allowed is 0.5 (30s).
      chrome.alarms.create(ACTIVE_OPS_KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
      _swDebugLog('keepalive: acquired', {});
    }
  } catch (_) { /* never throw from keepalive */ }
}

async function _releaseActiveOpsKeepalive() {
  if (!chrome.alarms || !chrome.alarms.clear) return;
  try {
    await chrome.alarms.clear(ACTIVE_OPS_KEEPALIVE_ALARM);
    _swDebugLog('keepalive: released', {});
  } catch (_) { /* never throw from keepalive */ }
}

// ---------------------------------------------------------------------------
// Sender allowlist (preserved)
// ---------------------------------------------------------------------------
const TRUSTED_SENDER_URL_PREFIXES = [
  chrome.runtime.getURL(''),
  'https://prbentogoncalves.g-hosp.com.br/',
];

// Telemetry-only origins. Senders matching this pattern may emit
// TOCAFICHADR_DEBUG_LOG (console-shipper relay) AND NOTHING ELSE.
// Used for the Clerk hosted-UI tab where we inject clerk-tap.js to
// observe the sign-in flow — the SPA is a different origin from our
// extension, so any error there is otherwise invisible.
// Covers both dev-tier (*.accounts.dev — legacy) and production
// (clerk.tocafichadr.com.br + accounts.tocafichadr.com.br — current).
const TELEMETRY_SENDER_URL_PATTERN = /^https:\/\/([a-z0-9-]+\.accounts\.dev|clerk\.tocafichadr\.com\.br|accounts\.tocafichadr\.com\.br)\//;

function _isTrustedSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const url = sender.url || '';
  for (let i = 0; i < TRUSTED_SENDER_URL_PREFIXES.length; i++) {
    if (url.startsWith(TRUSTED_SENDER_URL_PREFIXES[i])) return true;
  }
  return false;
}

function _isTelemetrySender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  return TELEMETRY_SENDER_URL_PATTERN.test(sender.url || '');
}

// ---------------------------------------------------------------------------
// External message handler — auth-success page on api.tocafichadr.com.br
// ---------------------------------------------------------------------------
// The /api/auth/success backend page (served at https://api.tocafichadr.com.br)
// pings the extension via chrome.runtime.sendMessage(EXT_ID, ...) after Clerk
// completes sign-in. The externally_connectable manifest entry gates this to
// that one origin; we still validate strictly here as defense in depth:
//   - sender.url must start with https://api.tocafichadr.com.br/
//   - message.type must be TOCAFICHADR_AUTH_COMPLETED (only AUTH for now)
// Anything else is dropped silently with ok:false. The accepted message is
// re-broadcast intra-extension so the side panel's existing
// TOCAFICHADR_AUTH_COMPLETED listener fires location.reload() immediately —
// no 30s storage-poll wait.
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  const senderUrl = (sender && sender.url) || '';
  if (!senderUrl.startsWith('https://api.tocafichadr.com.br/')) {
    sendResponse({ ok: false, __error: 'untrusted origin' });
    return false;
  }
  if (!message || message.type !== 'TOCAFICHADR_AUTH_COMPLETED') {
    sendResponse({ ok: false, __error: 'untrusted message type' });
    return false;
  }
  // Re-broadcast intra-extension. .catch() because there may be no open
  // UI listener when this fires — the warning "Could not establish
  // connection. Receiving end does not exist." is expected then.
  try {
    chrome.runtime.sendMessage({ type: 'TOCAFICHADR_AUTH_COMPLETED' })
      .catch(() => {});
  } catch (_) {}
  // Chrome blocks window.close() on tabs not opened by JS — chrome.tabs.create
  // (the path Clerk's redirect lands through) counts as "system-opened" so the
  // page's setTimeout(window.close, 1200) silently no-ops. Closing from the SW
  // via sender.tab.id works because the extension has tab-management rights.
  if (sender && sender.tab && typeof sender.tab.id === 'number') {
    setTimeout(() => {
      try { chrome.tabs.remove(sender.tab.id); } catch (_) {}
    }, 800);
  }
  sendResponse({ ok: true });
  return false;
});


// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const fullTrust = _isTrustedSender(sender);
  const telemetryOnly = !fullTrust && _isTelemetrySender(sender);
  if (!fullTrust && !telemetryOnly) {
    sendResponse({ ok: false, __error: 'Untrusted sender' });
    return false;
  }
  // Telemetry-only senders (Clerk hosted UI) may relay debug logs ONLY.
  // Any state-mutating or data-fetching message from that origin is a
  // confused-deputy attempt and gets rejected with the same shape as an
  // untrusted sender.
  if (telemetryOnly && message.type !== 'TOCAFICHADR_DEBUG_LOG') {
    sendResponse({ ok: false, __error: 'Untrusted message type' });
    return false;
  }

  if (message.type === 'TOCAFICHADR_TRANSCRIBE') {
    _handleTranscribe(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ __error: _normalizeApiError(err) }));
    return true;
  }
  if (message.type === 'TOCAFICHADR_HEALTH') {
    _handleHealth()
      .then(sendResponse)
      .catch((err) => sendResponse({ __error: _normalizeApiError(err) }));
    return true;
  }
  if (message.type === 'TOCAFICHADR_AUDIT') {
    _handleAudit(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, __error: _normalizeApiError(err) }));
    return true;
  }
  if (message.type === 'TOCAFICHADR_ERROR') {
    _handleError(message).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'TOCAFICHADR_DEBUG_LOG') {
    // Best-effort fire-and-forget. The console-shipper wraps every
    // console.warn / console.error in non-SW contexts and routes them here;
    // we POST to the backend so the dev can tail the log remotely on the
    // Mac Mini. Never block on this — debug logging must not slow the UI.
    _handleDebugLog(message).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'TOCAFICHADR_FETCH') {
    _handleFetch(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, status: 0, text: err.message || 'fetch failed' }));
    return true;
  }
  if (message.type === 'TOCAFICHADR_DISARM_BEFOREUNLOAD') {
    _handleDisarmBeforeUnload(sender)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, __error: _normalizeApiError(err) }));
    return true;
  }
  if (message.type === 'TOCAFICHADR_AUTHED') {
    // CHRA-2133: content scripts must NOT read the JWT directly. The token now
    // lives in chrome.storage.session, which is inaccessible to untrusted
    // contexts (content scripts). They request a presence-only boolean so the
    // HUD can drive auth-gated affordances without ever touching the token.
    chrome.storage.session.get(['authToken'])
      .then((d) => sendResponse({ authenticated: !!(d && d.authToken) }))
      .catch(() => sendResponse({ authenticated: false }));
    return true;
  }

  // --- NEW: Realtime offscreen lifecycle ---
  if (message.type === 'START_REALTIME') {
    _startRealtime(message.config)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, __error: err.message }));
    return true;
  }
  if (message.type === 'STOP_REALTIME') {
    _forwardToOffscreen({ type: 'OFFSCREEN_STOP' });
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'OFFSCREEN_READY') {
    if (offscreenReadyResolver) {
      offscreenReadyResolver();
      offscreenReadyResolver = null;
    }
    sendResponse({ ok: true });
    return true;
  }

  // Default: explicit unknown-message response so callers don't hang indefinitely
  sendResponse({ ok: false, error: 'unknown_message_type' });
  return true;
});

// ---------------------------------------------------------------------------
// v3.1 idea #3: SOAP streaming via chrome.runtime.Port + SSE
// ---------------------------------------------------------------------------
// Content script opens a long-lived Port; SW proxies a POST /api/soap-stream
// request to Flask and forwards each `data: {"t":"..."}` SSE frame as a
// SOAP_TOKEN message. Closes the port on [DONE] or error.
//
// Backend contract (to add to extension_api.py — see docs at end of session):
//   POST /api/soap-stream  → text/event-stream
//   Frames:  data: {"t":"<token>"}\n\n   ... data: [DONE]\n\n
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'TOCAFICHADR_SOAP_STREAM') return;
  // Sender is implicitly the same extension; the URL allowlist on _handleFetch
  // gates the actual fetch destination, so no additional sender check needed here.
  let aborter = new AbortController();
  let done = false;
  let fullSoap = '';
  // v3.1.2: server emits a `final` frame just before [DONE] carrying the
  // post-processed SOAP (placeholder substitution, voice normalization, PLANO
  // footer). When present, prefer it over the buffered tokens — those still
  // contain `[OBJETIVO_PLACEHOLDER]` literal because they're the raw GPT deltas.
  let finalSoap = null;
  let finalProviders = null;
  let finalTiming = null;

  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== 'SOAP_STREAM_START') return;
    // CHRA-1913: keep SW alive during the stream (can take 10-60s).
    await _acquireActiveOpsKeepalive();
    // v3.4.1 — hard 60s timeout so a hung backend can't leave the stream open forever.
    const streamTimeout = setTimeout(() => {
      try { aborter.abort(); } catch (_) {}
    }, 60000);
    try {
      const settings = await chrome.storage.sync.get(['apiBaseUrl']);
      const baseUrl = (settings.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
      const token = await _getAuthToken();
      const headers = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
      if (token) headers['Authorization'] = 'Bearer ' + token;

      const resp = await fetch(baseUrl + '/api/soap-stream', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          raw_text: msg.raw_text || '',
          chief_complaint: msg.chief_complaint || '',
          custom_instructions: msg.custom_instructions || '',
          soap_voice: msg.soap_voice || null,
        }),
        signal: aborter.signal,
      });
      if (!resp.ok || !resp.body) {
        // Pull the body's `code` token through to the client so
        // _normalizeApiError can distinguish RATE_LIMIT vs USAGE_LIMIT 429s.
        let codeSuffix = '';
        if (resp.status === 429) {
          try {
            const body = await resp.clone().json();
            if (body && body.code) codeSuffix = ' ' + body.code;
          } catch (_) { /* not JSON */ }
        }
        // Guard: port may have been disconnected (user cancelled) between the
        // fetch response arriving and this postMessage — swallow the throw.
        try { port.postMessage({ type: 'SOAP_ERROR', error: 'HTTP ' + resp.status + codeSuffix }); } catch (_) {}
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (!done) {
        const { value, done: rDone } = await reader.read();
        if (rDone) break;
        buf += decoder.decode(value, { stream: true });
        // Parse SSE frames: each frame ends with \n\n
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              done = true;
              // Prefer the post-processed final SOAP (v3.1.2 server) over the
              // buffered raw deltas, which contain [OBJETIVO_PLACEHOLDER] literal.
              // Guard: client may have disconnected the port (user cancelled)
              // between the [DONE] frame arriving and this postMessage.
              try {
                port.postMessage({
                  type: 'SOAP_DONE',
                  full: finalSoap !== null ? finalSoap : fullSoap,
                  providers: finalProviders,
                  timing: finalTiming,
                });
              } catch (_) {}
              try { port.disconnect(); } catch (_) {}
              return;
            }
            try {
              const parsed = JSON.parse(data);
              if (typeof parsed.t === 'string') {
                fullSoap += parsed.t;
                port.postMessage({ type: 'SOAP_TOKEN', t: parsed.t });
              } else if (typeof parsed.final === 'string') {
                finalSoap = parsed.final;
                finalProviders = parsed.providers || null;
                finalTiming = parsed.timing || null;
              } else if (typeof parsed.error === 'string') {
                port.postMessage({
                  type: 'SOAP_ERROR',
                  error: parsed.error,
                  providers: parsed.providers || null,
                  timing: parsed.timing || null,
                });
              }
            } catch (_) { /* malformed frame — skip */ }
          }
        }
      }
      if (!done) {
        try {
          port.postMessage({
            type: 'SOAP_DONE',
            full: finalSoap !== null ? finalSoap : fullSoap,
            providers: finalProviders,
            timing: finalTiming,
          });
        } catch (_) {}
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      try { port.postMessage({ type: 'SOAP_ERROR', error: _normalizeApiError(err) }); } catch (_) {}
    } finally {
      clearTimeout(streamTimeout);
      try { port.disconnect(); } catch (_) {}
      _releaseActiveOpsKeepalive();
    }
  });

  port.onDisconnect.addListener(() => {
    done = true;
    try { aborter.abort(); } catch (_) {}
    _releaseActiveOpsKeepalive();
  });
});

// ---------------------------------------------------------------------------
// MAIN-world helpers (chrome.scripting.executeScript with world: 'MAIN')
// ---------------------------------------------------------------------------
// Why this lives in the service worker, not in dom-engine.js:
// `chrome.scripting.executeScript` is only callable from extension contexts
// (SW / popup / options), NOT from content scripts. Content scripts run in
// an isolated world and CANNOT directly clear the page's `window.onbeforeunload`
// — anything they assign there only affects their own isolated `window`, not
// the page's. So when we need to neutralize G-Hosp's beforeunload handler
// before navigating away (otherwise Chrome shows a "Leave site?" modal that
// extensions cannot dismiss by design), the SW is the only path.
async function _handleDisarmBeforeUnload(sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (typeof tabId !== 'number') {
    return { ok: false, __error: 'no tab id' };
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      try { window.onbeforeunload = null; } catch (e) {}
      try {
        if (window.jQuery && typeof window.jQuery === 'function') {
          window.jQuery(window).off('beforeunload');
        }
      } catch (e) {}
    },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Offscreen Document Management
// ---------------------------------------------------------------------------
async function _startRealtime(config) {
  await _setupOffscreenDocument('offscreen/offscreen.html');
  _forwardToOffscreen({ type: 'OFFSCREEN_START', config });
}

async function _setupOffscreenDocument(path) {
  if (await chrome.offscreen.hasDocument()) return;
  // Wire the ready-resolver BEFORE createDocument so we never miss the
  // OFFSCREEN_READY signal that fires synchronously on offscreen.js load.
  // Race with a 3s safety net: a hung document load should not block forever.
  const readyPromise = new Promise((resolve) => { offscreenReadyResolver = resolve; });
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL(path),
    reasons: ['USER_MEDIA'],
    justification: 'Medical audio dictation and real-time transcription via WebSocket',
  });
  await Promise.race([readyPromise, new Promise((r) => setTimeout(r, 3000))]);
}

function _forwardToOffscreen(message) {
  // Broadcast to all extension contexts; offscreen doc will pick it up by type
  chrome.runtime.sendMessage(message).catch(() => {});
}

// ---------------------------------------------------------------------------
// Generic HTTP proxy (preserved)
// ---------------------------------------------------------------------------
async function _handleFetch(message) {
  const settings = await chrome.storage.sync.get(['apiBaseUrl']);
  const baseUrl = (settings.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '');

  let parsedTarget;
  let parsedBase;
  try {
    parsedTarget = new URL(message.url);
    parsedBase = new URL(baseUrl);
  } catch (_) {
    return { ok: false, status: 0, text: 'invalid url' };
  }
  if (parsedTarget.origin !== parsedBase.origin || !parsedTarget.pathname.startsWith('/api/')) {
    return { ok: false, status: 0, text: 'url not allowed' };
  }

  const headers = {};
  const inbound = message.headers || {};
  for (const k of Object.keys(inbound)) {
    if (k.toLowerCase() !== 'authorization') headers[k] = inbound[k];
  }

  const init = {
    method: message.method || 'GET',
    headers,
    signal: AbortSignal.timeout(30000),
  };
  if (message.body !== undefined && message.body !== null) init.body = message.body;
  try {
    // v3.0.3: skipRefresh recursion guard is obsolete (Clerk SDK manages rotation
    // internally; no /auth/refresh round-trip anymore), but kept for call-site
    // compatibility — _authedFetch ignores the third argument.
    const resp = await _authedFetch(message.url, init);
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: (err && err.message) || 'fetch failed' };
  }
}

async function _handleAudit(message) {
  const settings = await chrome.storage.sync.get(['apiBaseUrl']);
  const baseUrl = (settings.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
  try {
    const resp = await _authedFetch(baseUrl + '/api/audit/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action_type: message.actionType, details: message.details }),
      signal: AbortSignal.timeout(5000),
    });
    return { ok: resp.ok };
  } catch (err) {
    return { ok: false, __error: err.message };
  }
}

async function _handleError(message) {
  const settings = await chrome.storage.sync.get(['apiBaseUrl']);
  const baseUrl = (settings.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
  const authData = await chrome.storage.session.get(['authToken', 'authUser']);
  const headers = { 'Content-Type': 'application/json' };
  if (authData.authToken) headers['Authorization'] = 'Bearer ' + authData.authToken;
  const manifest = chrome.runtime.getManifest();
  const payload = {
    where: message.where || 'unknown',
    error_message: (message.errorMessage || '').slice(0, 500),
    stack: (message.stack || '').slice(0, 2000),
    context: message.context || {},
    user_id: (authData.authUser && authData.authUser.id) || null,
    ext_version: manifest.version,
    user_agent: (navigator && navigator.userAgent) || '',
    ts: new Date().toISOString(),
  };
  try {
    await fetch(baseUrl + '/api/error-log', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch (_) {}
}

// Console-shipper sink. The shared/console-shipper.js IIFE wraps console.warn
// and console.error in every non-SW context (content scripts, side panel,
// popup) and posts a TOCAFICHADR_DEBUG_LOG message here. We forward it to
// /api/debug-log so the dev can tail the resulting log file on the Mac Mini.
//
// Best-effort and silent — never throws, never blocks. Mirrors _handleError's
// auth pattern (Bearer if available) but is intentionally generous on error
// recovery: a 401, 5xx, or network blip is just dropped. The doctor's UX
// must never depend on this endpoint being reachable.
async function _handleDebugLog(message) {
  try {
    const settings = await chrome.storage.sync.get(['apiBaseUrl']);
    const baseUrl = (settings.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
    const authData = await chrome.storage.session.get(['authToken']);
    const headers = { 'Content-Type': 'application/json' };
    if (authData.authToken) headers['Authorization'] = 'Bearer ' + authData.authToken;
    await fetch(baseUrl + '/api/debug-log', {
      method: 'POST',
      headers,
      body: JSON.stringify(message.payload || {}),
      signal: AbortSignal.timeout(3000),
    });
  } catch (_) { /* swallow — debug logging must never cascade */ }
}

self.addEventListener('error', (e) => {
  _handleError({
    where: 'service-worker.uncaught',
    errorMessage: (e.error && e.error.message) || e.message || 'unknown',
    stack: (e.error && e.error.stack) || '',
  }).catch(() => {});
});
self.addEventListener('unhandledrejection', (e) => {
  _handleError({
    where: 'service-worker.unhandledrejection',
    errorMessage: (e.reason && e.reason.message) || String(e.reason),
    stack: (e.reason && e.reason.stack) || '',
  }).catch(() => {});
});

async function _handleHealth() {
  const settings = await chrome.storage.sync.get(['apiBaseUrl']);
  const baseUrl = (settings.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
  try {
    const resp = await fetch(baseUrl + '/api/health', { method: 'GET', signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return { ok: false };
    const data = await resp.json().catch(() => null);
    return { ok: !!(data && data.status === 'ok') };
  } catch (_) {
    return { ok: false };
  }
}

// v3.4.1 — single-flight guard for transcription.
// CHRA-1913: persisted in chrome.storage.session so the guard survives
// service-worker restarts (MV3). A stale entry older than 5 min is ignored.
const TRANSCRIBE_IN_FLIGHT_KEY = '_transcribeInFlight';
const TRANSCRIBE_IN_FLIGHT_TTL_MS = 5 * 60 * 1000;

async function _isTranscribeInFlight() {
  try {
    const stored = await chrome.storage.session.get([TRANSCRIBE_IN_FLIGHT_KEY]);
    const entry = stored[TRANSCRIBE_IN_FLIGHT_KEY];
    if (!entry || !entry.startedAt) return false;
    if (Date.now() - entry.startedAt > TRANSCRIBE_IN_FLIGHT_TTL_MS) {
      // Stale — clean it up
      await chrome.storage.session.remove(TRANSCRIBE_IN_FLIGHT_KEY);
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

async function _setTranscribeInFlight(active) {
  try {
    if (active) {
      await chrome.storage.session.set({
        [TRANSCRIBE_IN_FLIGHT_KEY]: { startedAt: Date.now() },
      });
    } else {
      await chrome.storage.session.remove(TRANSCRIBE_IN_FLIGHT_KEY);
    }
  } catch (_) { /* never throw from guard bookkeeping */ }
}

async function _handleTranscribe(message) {
  if (await _isTranscribeInFlight()) {
    return { __error: 'Transcrição já em andamento. Aguarde a conclusão.' };
  }
  await _setTranscribeInFlight(true);
  await _acquireActiveOpsKeepalive();
  // async finally: await both cleanups so _isTranscribeInFlight can't return
  // true for a completed transcription if a second request arrives before the
  // storage write completes (the window is sub-millisecond but the fix is free).
  return _handleTranscribeInner(message).finally(async () => {
    await _setTranscribeInFlight(false);
    await _releaseActiveOpsKeepalive();
  });
}

async function _handleTranscribeInner(message) {
  await _maybeDiscoverApiUrl(false);
  const binary = atob(message.audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const audioBlob = new Blob([bytes], { type: message.mimeType || 'audio/webm' });

  const formData = new FormData();
  formData.append('audio', audioBlob, 'recording.webm');
  if (message.chiefComplaint) formData.append('chief_complaint', message.chiefComplaint);
  if (message.customInstructions) formData.append('custom_instructions', message.customInstructions);
  if (message.audioConfig) {
    try { formData.append('audio_metadata', JSON.stringify(message.audioConfig)); } catch (_) {}
  }
  // v3.1 idea #8: per-doctor SOAP voice — verbosity, perspective, emphases,
  // customRules, fewShots. Backend reads it as JSON in the multipart field
  // `soap_voice`. Falls back to default Padrão if absent.
  if (message.soapVoice) {
    try { formData.append('soap_voice', JSON.stringify(message.soapVoice)); } catch (_) {}
  }

  // _authedFetch (task 2.6.10) injects the Bearer header, catches 401, refreshes,
  // and retries once. Don't pre-set Content-Type — the browser sets the multipart
  // boundary on FormData bodies automatically.
  async function _post() {
    const settings = await chrome.storage.sync.get(['apiBaseUrl']);
    const baseUrl = (settings.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
    return _authedFetch(baseUrl + '/api/transcribe', {
      method: 'POST',
      body: formData,
      // CHRA-2423 Bug 81: 85s, NOT 30s. Transcription is documented at 7-90s
      // (ACTIVE_OPS_KEEPALIVE comment above — the keepalive exists precisely
      // to hold the SW alive that long) and content/hud.js races this call
      // against its own 90s UI timeout. A 30s abort here killed every
      // long-consultation dictation — first attempt AND retry — while the
      // keepalive kept the SW alive for a fetch already aborted. 85s covers
      // the envelope and stays under the HUD's 90s so the SW's structured
      // error reaches the doctor first. Guarded by
      // scripts/test-transcribe-timeout-budget.js.
      signal: AbortSignal.timeout(85000),
    });
  }

  let resp;
  try {
    resp = await _post();
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { ok: false, status: 0, text: 'Tempo esgotado. Tente novamente.' };
    }
    await _maybeDiscoverApiUrl(true);
    try {
      resp = await _post();
    } catch (err2) {
      if (err2 && (err2.name === 'TimeoutError' || err2.name === 'AbortError')) {
        return { ok: false, status: 0, text: 'Tempo esgotado. Tente novamente.' };
      }
      throw err2;
    }
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('HTTP ' + resp.status + ': ' + text);
  }
  const json = await resp.json();
  return { ...json, ok: resp.ok };
}
