// popup.src.js — Universal Scribe UI + Settings for Toca Ficha Dr.
// Bundled by esbuild → popup/popup.bundle.js (script src in popup.html).
// v3.0: replaced custom email/password auth with Clerk hosted SignIn.

// Diagnostic banner — proves which bundle is loaded. If you click sign-in
// and see the URL-scheme error, check the side-panel console for this line
// FIRST. If the marker doesn't appear, Chrome is serving a cached older
// bundle and the auth fix never reached you.
console.warn("[Toca Ficha] popup.bundle.js loaded — build marker: AUTH_DIAG_2026_05_10_v5");

import { createClerkClient } from '@clerk/chrome-extension/client';

// ============================================================================
// Constants
// ============================================================================
// Production cloud mode uses the stable first-party API domain. Local mode
// remains available explicitly for development builds.
const CLOUD_URL = "https://api.tocafichadr.com.br";
const LOCAL_URL = "http://127.0.0.1:5051";
const REALTIME_PROXY_LOCAL = "ws://127.0.0.1:5051/realtime";
const FIELDS = ["apiBaseUrl", "backendMode", "autoClearSoap", "autoCid", "autoFillCompanion", "autoPrefillEncaminh", "customInstructions"];

// Validate a backend base URL before it is persisted to chrome.storage.sync.
// api-client.js / the service worker read apiBaseUrl VERBATIM (no URL parse), so
// a malformed value typed into the local-mode field — a typo, a missing scheme —
// silently breaks every API call until the user notices. Require a well-formed
// http(s) URL. Cloud mode uses the fixed CLOUD_URL and never needs this.
function _isValidBackendUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch (_) {
    return false;
  }
}

// v3.4.1 — user-safe Portuguese error messages
function _normalizeApiError(err) {
  const msg = (err && err.message) || String(err || '');
  if (/abort|timeout|timed out/i.test(msg)) return 'Servidor não respondeu. Tente novamente.';
  if (/failed to fetch|network|net::|internet/i.test(msg)) return 'Sem conexão com o servidor. Verifique sua internet.';
  const m = msg.match(/HTTP\s*(\d+)/i);
  if (m) {
    const status = parseInt(m[1], 10);
    if (status === 401) return 'Sessão expirada. Faça login novamente.';
    if (status === 403) return 'Acesso negado.';
    if (status === 429) {
      if (/USAGE_LIMIT/i.test(msg)) return 'Limite diário atingido — assine Pro ou aguarde até amanhã.';
      return 'Muitas requisições. Aguarde um momento.';
    }
    if (status >= 500) return 'Erro no servidor. Tente novamente em instantes.';
  }
  return msg || 'Erro desconhecido.';
}

// Clerk publishable key — encodes the Frontend API URL, safe to embed client-side.
// pk_live_ targets clerk.tocafichadr.com.br (production tier, DNS-verified
// 2026-05-11). Dev pk_test_d29ya2luZy1jaG93LTAuY2xlcmsuYWNjb3VudHMuZGV2JA is
// retired — production Clerk OAuth callbacks land on clerk.tocafichadr.com.br
// instead of clerk.shared.lcl.dev, fixing the invalid_url_scheme blocker.
const CLERK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsudG9jYWZpY2hhZHIuY29tLmJyJA";

// ============================================================================
// Clerk Auth (v3.0)
// ============================================================================
// v3.1 hardening: never let Clerk init throw at module load — would halt the
// whole bundle and break unrelated buttons (templates, save settings, etc.).
let _clerk;
try {
  // syncHost flips the SDK to extension-aware mode (standardBrowser:false).
  // Without it, Clerk's hosted UI receives chrome-extension:// in redirect_url
  // and the API rejects with `invalid_url_scheme`. With it, the SDK uses the
  // syncHost domain to bridge the session — Clerk redirects to HTTPS on
  // sign-in, sets cookies on the syncHost, and the extension reads the
  // resulting session via the SDK's chrome.storage path. CLOUD_URL is our
  // production API and is already in host_permissions + CSP connect-src.
  _clerk = createClerkClient({
    publishableKey: CLERK_PUBLISHABLE_KEY,
    syncHost: CLOUD_URL,
  });
} catch (e) {
  console.error("[Toca Ficha] createClerkClient failed:", e);
  // Stub so the rest of the bundle can call _clerk.addListener / _clerk.user safely.
  _clerk = { user: null, addListener() {}, async load() {}, async signOut() {}, buildSignInUrl() { return null; } };
}
// v3.1.4: expose to window so sidepanel-prontuario.js can use the SDK's
// correct buildSignInUrl() instead of constructing FAPI URLs manually
// (the manual /sign-in path 404s — Clerk's hosted UI lives at a different host).
try { window.TOCAFICHADR_clerk = _clerk; window.TOCAFICHADR_authSuccessUrl = chrome.runtime.getURL("auth-success.html"); } catch (_) {}
async function _exposeClerkOnReady() {
  try { await _ensureClerk(); window.TOCAFICHADR_clerkReady = true; } catch (_) {}
}
// Context-aware "where to land after sign-out". The 2026-05-10 bug here was
// `getURL("popup.html")` resolving to chrome-extension://EXT/popup.html which
// doesn't exist (the actual file is popup/popup.html) — Clerk's signOut
// navigated the side panel to a non-existent path → ERR_FILE_NOT_FOUND.
// Use the correct path for each surface so signout returns the user to the
// gate of the SAME page they were on.
const _IS_IN_SIDE_PANEL_PATH = (typeof location !== "undefined" &&
                                location.pathname.indexOf("/sidepanel/") !== -1);
const _AFTER_SIGNOUT_URL = chrome.runtime.getURL(
  _IS_IN_SIDE_PANEL_PATH ? "sidepanel/sidepanel.html" : "popup/popup.html"
);
// Static success page — listed in manifest web_accessible_resources so Clerk's
// hosted UI can redirect here without ERR_BLOCKED_BY_CLIENT (popup.html cannot
// be navigated to from a web context unless it is web-accessible).
const _AUTH_SUCCESS_URL = chrome.runtime.getURL("auth-success.html");

let _clerkLoaded = false;
let _clerkLoadPromise = null;
async function _ensureClerk() {
  if (_clerkLoaded) return;
  // Singleton in-flight guard. _clerkLoaded is set only AFTER load() resolves,
  // so without this the two init calls at the bottom of this file
  // (_ensureClerk().then(_renderAuthState) immediately followed by
  // _exposeClerkOnReady() → _ensureClerk()) both see _clerkLoaded===false and
  // call _clerk.load() twice — a concurrent double SDK init on every open.
  // Share one in-flight promise (mirrors the service worker's _clerkPromise).
  if (_clerkLoadPromise) { try { await _clerkLoadPromise; } catch (_) {} return; }
  try {
    // Clerk's server-side validator requires `redirect_url` to be http/https
    // (verified 2026-05-10 from user reports: code `invalid_url_scheme`).
    // When NO fallback URL is configured, the SDK falls back to
    // `window.location.origin`, which in a side panel is
    // `chrome-extension://EXT/` — still rejected. So we MUST configure an
    // HTTPS fallback. CLOUD_URL + /api/auth/success is a friendly HTML
    // landing page (replaces the old /api/health raw-JSON cue): it shows
    // "Login concluído", auto-closes the tab in ~1.2s, AND pings the
    // extension via chrome.runtime.sendMessage (gated by the
    // externally_connectable manifest entry for api.tocafichadr.com.br)
    // so the SW re-broadcasts TOCAFICHADR_AUTH_COMPLETED and the side
    // panel reloads immediately — no manual close, no 30s wait.
    // ext_id is required so the page knows which extension to ping.
    const _CLERK_FALLBACK = CLOUD_URL + "/api/auth/success?ext_id=" + chrome.runtime.id;
    // 6th attempt. Confirmed via playwright + mini extension-debug.log
    // (2026-05-10 21:51:39): the SDK generates a URL with our HTTPS
    // redirect_url correctly, but Clerk's hosted-UI SPA then reads our
    // `allowedRedirectProtocols: ["chrome-extension:"]` config and
    // CONSTRUCTS a chrome-extension://EXT/ URL internally to redirect to,
    // which Clerk's own server then rejects with invalid_url_scheme.
    //
    // The fix is to NOT advertise chrome-extension:// as an allowed
    // redirect protocol. We don't actually need it — sign-in lands on the
    // HTTPS fallback URL, the user closes the tab, and the side panel's
    // existing _authPollTimer picks up the session via chrome.storage.
    //
    // allowedRedirectOrigins still names CLOUD_URL so the SDK doesn't
    // discard the explicit redirectUrl we pass to buildSignInUrl
    // (verified via the "is not on one of the allowedRedirectOrigins"
    // warning that appeared at 18:35:00 before this fix).
    _clerkLoadPromise = _clerk.load({
      afterSignOutUrl: _AFTER_SIGNOUT_URL,
      signInFallbackRedirectUrl: _CLERK_FALLBACK,
      signUpFallbackRedirectUrl: _CLERK_FALLBACK,
      allowedRedirectOrigins: [CLOUD_URL],
    });
    await _clerkLoadPromise;
    _clerkLoaded = true;
  } catch (e) {
    console.error("[Toca Ficha] Clerk load failed:", e);
    _clerkLoadPromise = null; // allow a later call to retry after a transient failure
  }
}

function _initialsFromEmail(email) {
  if (!email) return "—";
  const local = String(email).split("@")[0] || "";
  // Try common patterns: "first.last" → FL; otherwise first 2 chars.
  const parts = local.split(/[._-]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

// CSO-009: decode JWT exp claim → Unix ms, for authTokenExpiry storage.
function _jwtExp(jwt) {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return (payload.exp || 0) * 1000;
  } catch (_) { return 0; }
}

async function _renderAuthState() {
  await _ensureClerk();
  const loggedOut       = document.getElementById("loggedOutView");
  const loggedIn        = document.getElementById("loggedInView");
  const userEmailEl     = document.getElementById("userEmail");
  const userPlanEl      = document.getElementById("userPlan");
  const userPlanBadge   = document.getElementById("userPlanBadge");
  const userUsageEl     = document.getElementById("userUsage");
  const userUsageLimit  = document.getElementById("userUsageLimit");
  const userUsageBar    = document.getElementById("userUsageBar");
  const userAvatarLg    = document.getElementById("userAvatarLg");
  const brandAvatar     = document.getElementById("brandAvatar");

  if (_clerk.user) {
    if (loggedOut) loggedOut.style.display = "none";
    if (loggedIn) loggedIn.style.display = "";
    const email = _clerk.user.primaryEmailAddress?.emailAddress ?? "(sem email)";
    const initials = _initialsFromEmail(email);
    if (userEmailEl) userEmailEl.textContent = email;
    if (userAvatarLg) { userAvatarLg.textContent = initials; userAvatarLg.classList.remove("empty"); }
    if (brandAvatar)  { brandAvatar.textContent  = initials; brandAvatar.classList.remove("empty"); brandAvatar.title = email; }
    if (userPlanEl)    userPlanEl.textContent = "Free";
    if (userPlanBadge) { userPlanBadge.textContent = "FREE"; userPlanBadge.classList.remove("pro"); }

    try {
      const token = await _clerk.session?.getToken();
      // CHRA-2133: JWT goes to chrome.storage.session (cleared on browser close,
      // unreadable by content scripts), not chrome.storage.local.
      if (token) await chrome.storage.session.set({ authToken: token, authTokenExpiry: _jwtExp(token) });

      const resp = await fetch(CLOUD_URL + "/billing/subscription", {
        headers: { Authorization: "Bearer " + token },
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const sub = await resp.json();
        const planUpper = sub.plan ? String(sub.plan).toUpperCase() : "FREE";
        if (userPlanEl) userPlanEl.textContent = sub.plan ? planUpper.charAt(0) + planUpper.slice(1).toLowerCase() : "Free";
        if (userPlanBadge) {
          userPlanBadge.textContent = planUpper;
          userPlanBadge.classList.toggle("pro", planUpper === "PRO");
        }
        if (userUsageEl) userUsageEl.textContent = (sub.usage_today || 0) + " hoje";
        if (userUsageLimit) {
          if (sub.daily_limit) userUsageLimit.textContent = "limite " + sub.daily_limit;
          else                 userUsageLimit.textContent = "ilimitado";
        }
        if (userUsageBar) {
          const pct = sub.daily_limit ? Math.min(100, (sub.usage_today / sub.daily_limit) * 100) : 0;
          userUsageBar.style.width = pct + "%";
        }
        // v3.8.0 — Show upgrade nudge for free users near limit
        const upgradeNudge = document.getElementById("upgradeNudge");
        if (upgradeNudge) {
          const isFree = planUpper === "FREE";
          const nearLimit = sub.daily_limit && (sub.usage_today / sub.daily_limit) >= 0.6;
          upgradeNudge.style.display = (isFree && nearLimit) ? "" : "none";
        }
        // v3.8.0 — Update scribe tab usage chip
        const scribeUsageChip = document.getElementById("scribeUsageChip");
        const scribeUsageText = document.getElementById("scribeUsageText");
        if (scribeUsageChip && scribeUsageText) {
          if (sub.daily_limit) {
            scribeUsageChip.style.display = "flex";
            scribeUsageText.textContent = (sub.usage_today || 0) + " / " + sub.daily_limit + " hoje";
            scribeUsageChip.classList.toggle("near", (sub.usage_today / sub.daily_limit) >= 0.6 && (sub.usage_today / sub.daily_limit) < 1);
            scribeUsageChip.classList.toggle("at", (sub.usage_today / sub.daily_limit) >= 1);
          } else {
            scribeUsageChip.style.display = "none";
          }
        }
      }
    } catch (e) {
      // Non-fatal — billing fetch is best-effort.
    }
  } else {
    if (loggedOut) loggedOut.style.display = "";
    if (loggedIn) loggedIn.style.display = "none";
    if (brandAvatar) { brandAvatar.textContent = "—"; brandAvatar.classList.add("empty"); brandAvatar.title = "Não autenticado"; }
    chrome.storage.session.remove(["authToken", "authTokenExpiry", "refreshToken", "authUser"]);
    // v3.8.0 — Hide usage chip when logged out
    const scribeUsageChip = document.getElementById("scribeUsageChip");
    if (scribeUsageChip) scribeUsageChip.style.display = "none";
  }
}

// Branded header status pill — independent of auth, follows backend health.
async function _refreshBrandStatus() {
  const pill = document.getElementById("brandStatus");
  const txt  = document.getElementById("brandStatusText");
  if (!pill) return;
  try {
    const settings = await chrome.storage.sync.get(["apiBaseUrl"]);
    const baseUrl = (settings.apiBaseUrl || LOCAL_URL).replace(/\/+$/, "");
    const r = await fetch(baseUrl + "/api/health", { signal: AbortSignal.timeout(3000) });
    pill.style.display = "";
    pill.classList.toggle("offline", !r.ok);
    if (txt) txt.textContent = r.ok ? "ON" : "OFF";
  } catch (_) {
    pill.style.display = "";
    pill.classList.add("offline");
    if (txt) txt.textContent = "OFF";
  }
}
try { _refreshBrandStatus(); } catch (_) {}
setInterval(() => { try { _refreshBrandStatus(); } catch (_) {} }, 30000);

// Re-render whenever Clerk's auth state changes (sign-in completes, sign-out, etc.)
try { _clerk.addListener(_renderAuthState); } catch (e) { console.error("[TF] clerk.addListener failed:", e); }
_ensureClerk().then(_renderAuthState).catch((e) => console.error("[TF] ensureClerk failed:", e));
_exposeClerkOnReady();

// Background-context auth-token bridge. The service-worker Clerk client
// cannot reliably read the popup's session via cross-context SDK sharing
// (verified 2026-05-11 via SW DIAG telemetry — SW clerk.session stays null
// even after Native API + background:true + syncHost are all configured).
// _renderAuthState() above already writes chrome.storage.session.authToken
// on every render, but only fires on Clerk state changes — not on rotation.
// Clerk JWTs expire ~60s by default, so we explicitly refresh every 30s
// while the popup/sidepanel is open. The SW's _getAuthToken falls back to
// this stored token when its own SDK call returns null.
async function _refreshStoredAuthToken() {
  try {
    if (!_clerk || !_clerk.session) {
      await chrome.storage.session.remove(["authToken", "authTokenExpiry"]);
      return;
    }
    const token = await _clerk.session.getToken();
    if (token) await chrome.storage.session.set({ authToken: token, authTokenExpiry: _jwtExp(token) });
  } catch (_) { /* silent — fallback is best-effort */ }
}
setInterval(_refreshStoredAuthToken, 30000);

// ============================================================================
// Tab Switching
// ============================================================================
const tabBtns = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');

tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    tabBtns.forEach((b) => b.classList.toggle('active', b === btn));
    tabPanels.forEach((p) => p.classList.toggle('active', p.id === target + 'Tab'));
  });
});

// ============================================================================
// Scribe Tab Logic
// ============================================================================
let recording = false;
let timerInterval = null;
let timerSeconds = 0;
let mediaRecorder = null;
let audioChunks = [];

const recordBtn = document.getElementById('recordBtn');
const soapOutput = document.getElementById('soapOutput');
const realtimeToggle = document.getElementById('realtimeMode');
const ghospToggle = document.getElementById('ghospMode');
const copyBtn = document.getElementById('copyBtn');

// v3.1.3: side panel removed the popup's record button and SOAP textarea.
// Guard each listener so a missing element doesn't halt the rest of the bundle
// (this was the root cause of the dead Sign In/Out + Adicionar/Restaurar buttons —
// recordBtn was null in the side panel, the throw aborted every listener below).
if (recordBtn) recordBtn.addEventListener('click', async () => {
  if (!recording) {
    await startRecording();
  } else {
    await stopRecording();
  }
});

if (copyBtn) copyBtn.addEventListener('click', () => {
  const text = soapOutput ? soapOutput.value : '';
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const original = copyBtn.textContent;
    copyBtn.textContent = 'Copiado!';
    setTimeout(() => { copyBtn.textContent = original; }, 1500);
  }).catch(() => {
    showScribeStatus('Não foi possível copiar — use Ctrl+C', 'err');
  });
});

// Record button state machine — drives the 4-state visual via CSS class.
// idle → recording (red pulse + timer) → processing (amber spinner) → done (green check) → idle
function _setRecState(s) {
  if (!recordBtn) return; // v3.1.3: side panel doesn't render the popup record button
  recordBtn.classList.remove('recording', 'processing', 'done');
  if (s === 'recording')  recordBtn.classList.add('recording');
  if (s === 'processing') recordBtn.classList.add('processing');
  if (s === 'done')       recordBtn.classList.add('done');
  recordBtn.setAttribute('aria-label', s === 'recording' ? 'Parar gravação' : 'Iniciar gravação');
}

async function startRecording() {
  recording = true;
  _setRecState('recording');
  soapOutput.value = '';
  startTimer();
  showScribeStatus('Gravando...', '');

  if (realtimeToggle.checked) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
    } catch (err) {
      showScribeStatus('Permissão de microfone negada — clique no cadeado e permita o microfone', 'err');
      recording = false;
      _setRecState('idle');
      stopTimer();
      return;
    }
    const settings = await chrome.storage.sync.get(['apiBaseUrl', 'backendMode']);
    const isLocal = (!settings.backendMode) || settings.backendMode === 'local';
    const proxyUrl = isLocal ? REALTIME_PROXY_LOCAL : (settings.apiBaseUrl?.replace(/^http/, 'ws') + '/realtime');
    chrome.runtime.sendMessage({
      type: 'START_REALTIME',
      config: { proxyUrl }
    }, (resp) => {
      if (chrome.runtime.lastError) {
        showScribeStatus('Erro ao iniciar realtime: ' + _normalizeApiError(chrome.runtime.lastError), 'err');
        recording = false;
        _setRecState('idle');
        stopTimer();
      }
    });
  } else {
    await startBatchRecording();
  }
}

async function stopRecording() {
  recording = false;
  _setRecState('processing');
  stopTimer();

  if (realtimeToggle.checked) {
    chrome.runtime.sendMessage({ type: 'STOP_REALTIME' });
    showScribeStatus('Processando...', '');
  } else {
    stopBatchRecording();
    showScribeStatus('Enviando...', '');
  }
}

// Listen for results from SW / offscreen doc.
// soapOutput may be null when this bundle loads in the side panel (which
// doesn't render the popup's textarea). Guard all assignments so an
// unrelated REALTIME_DELTA/BATCH_RESULT broadcast never throws here.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'REALTIME_DELTA') {
    if (soapOutput) soapOutput.value += msg.text;
    showScribeStatus('Digitando...', '');
    return false;
  }
  if (msg.type === 'REALTIME_STATUS') {
    if (msg.status === 'recording') showScribeStatus(msg.text || 'Ouvindo...', '');
    // 'done' and 'error' are TERMINAL — the session is over, so clear the
    // recording flag to keep it consistent with the idle UI _setRecState paints.
    // Without this, an async realtime error (WS drop / proxy down) that arrives
    // WITHOUT the user clicking stop left recording=true, so the next
    // record-button click was swallowed as a "stop" (toggle at line ~325)
    // instead of starting a new recording.
    if (msg.status === 'done')      { recording = false; showScribeStatus('Concluído', 'ok'); _flashDoneThenIdle(); }
    if (msg.status === 'error')     { recording = false; showScribeStatus(msg.text || 'Erro', 'err'); _setRecState('idle'); }
    return false;
  }
  if (msg.type === 'BATCH_RESULT') {
    recording = false; // terminal — keep the flag consistent with the idle UI
    if (soapOutput) soapOutput.value = msg.soap || msg.transcript || JSON.stringify(msg);
    showScribeStatus('Concluído', 'ok');
    _flashDoneThenIdle();
    return false;
  }
});

function _flashDoneThenIdle() {
  _setRecState('done');
  setTimeout(function () { _setRecState('idle'); }, 1200);
}

// --- Batch recording (in popup) ---
async function startBatchRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    // PermissionDeniedError, NotFoundError, etc. Reset the UI state that
    // startRecording() already set (recording=true, timer running, pulse animation)
    // — the caller doesn't have its own try-catch for this branch.
    recording = false;
    _setRecState('idle');
    stopTimer();
    showScribeStatus('Microfone não encontrado ou permissão negada — verifique as configurações do Chrome.', 'err');
    return;
  }
  mediaRecorder = new MediaRecorder(stream, { audioBitsPerSecond: 32000 });
  audioChunks = [];
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  };
  mediaRecorder.onstop = async () => {
    // Release the microphone immediately — the recorder already has the audio.
    // Without this, getUserMedia's tracks stay live (mic indicator on) until the
    // popup closes; every other recording path (offscreen.js, audio-capture.js)
    // stops its tracks on teardown. `stream` is captured by this closure.
    try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    if (blob.size < 500) {
      showScribeStatus('Gravação muito curta — fale por pelo menos 2 segundos', 'err');
      _setRecState('idle');
      return;
    }
    try {
      const base64 = await blobToBase64(blob);
      chrome.runtime.sendMessage({
        type: 'TOCAFICHADR_TRANSCRIBE',
        audioBase64: base64,
        mimeType: blob.type || 'audio/webm',
        chiefComplaint: '',
        customInstructions: document.getElementById('customInstructions')?.value?.trim() || ''
      }, (response) => {
        if (chrome.runtime.lastError) {
          showScribeStatus(_normalizeApiError(chrome.runtime.lastError), 'err');
          _setRecState('idle');
          return;
        }
        if (response && response.__error) {
          showScribeStatus(_normalizeApiError(response.__error), 'err');
          _setRecState('idle');
        } else {
          soapOutput.value = response.soap || response.transcript || JSON.stringify(response);
          showScribeStatus('Concluído', 'ok');
          _flashDoneThenIdle();
        }
      });
    } catch (err) {
      // FileReader failure or other unexpected error — unblock the UI so the
      // doctor can retry rather than seeing a permanent "processing" spinner.
      showScribeStatus('Erro ao processar áudio — tente novamente', 'err');
      _setRecState('idle');
    }
  };
  mediaRecorder.start(1000);
}

function stopBatchRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const comma = reader.result.indexOf(',');
      resolve(comma >= 0 ? reader.result.slice(comma + 1) : reader.result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function startTimer() {
  timerSeconds = 0;
  updateTimerDisplay();
  timerInterval = setInterval(() => { timerSeconds++; updateTimerDisplay(); }, 1000);
}
function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}
function updateTimerDisplay() {
  const m = String(Math.floor(timerSeconds / 60)).padStart(2, '0');
  const s = String(timerSeconds % 60).padStart(2, '0');
  const out = `${m}:${s}`;
  const el = document.getElementById('timer');
  if (el) el.textContent = out;
  const recTimerEl = document.getElementById('recTimer');
  if (recTimerEl) recTimerEl.textContent = out;
}
function showScribeStatus(text, cls) {
  const el = document.getElementById('scribeStatus');
  if (!el) return;
  el.textContent = text;
  el.className = 'scribe-status' + (cls ? ' ' + cls : '');
}

// --- G-Hosp automation toggle ---
if (ghospToggle) ghospToggle.addEventListener('change', async (e) => {
  if (e.target.checked) {
    const granted = await chrome.permissions.request({ origins: ['https://*.g-hosp.com.br/*'] });
    if (granted) {
      try {
        await chrome.scripting.registerContentScripts([{
          id: 'tocafichadr-ghosp',
          matches: ['https://*.g-hosp.com.br/*'],
          // Order + deps must mirror the static manifest content_scripts list.
          // error-helpers.js defines _normalizeApiError (a script-scope global
          // api-client.js calls UNGUARDED) and vad-helpers.js defines
          // TOCAFICHADR_vad (audio-capture.js). On prbentogoncalves the static
          // scripts already provide these, but this toggle registers for the
          // *.g-hosp.com.br wildcard — on any OTHER G-Hosp subdomain the static
          // list doesn't run, so omitting them made api-client.js throw
          // "ReferenceError: _normalizeApiError is not defined" on every error
          // path. Keep error-helpers BEFORE api-client and vad-helpers BEFORE
          // audio-capture.
          js: ['shared/error-helpers.js', 'content/cid.js', 'content/api-client.js', 'content/vad-helpers.js', 'content/audio-capture.js', 'content/dom-engine.js', 'content/hud.js', 'content/content.js'],
          css: ['styles/tokens.css', 'styles/hud.css'],
          runAt: 'document_idle'
        }]);
        showScribeStatus('Automação G-Hosp ativada', 'ok');
      } catch (err) {
        console.error(err);
        showScribeStatus('Erro ao injetar scripts na página', 'err');
        e.target.checked = false;
      }
    } else {
      e.target.checked = false;
    }
  } else {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: ['tocafichadr-ghosp'] });
    } catch (_) {}
  }
});

// Check existing permission on load
chrome.permissions.contains({ origins: ['https://*.g-hosp.com.br/*'] }).then((granted) => {
  if (ghospToggle) ghospToggle.checked = granted;
});

// ============================================================================
// Config Tab Logic (preserved from v2.5)
// ============================================================================

// --- Load settings ---
// v3.4: production cloud mode is first-party by default. Older quick-tunnel
// settings are upgraded to CLOUD_URL; local mode remains available explicitly.
//
// Phase 03-03b: personal fields (autoClearSoap, autoCid, autoFillCompanion,
// autoPrefillEncaminh, customInstructions) come from window.TOCAFICHADR_userConfig
// (server-backed), NOT chrome.storage.sync. Infra fields (apiBaseUrl,
// backendMode) stay in storage.sync — they're per-Chrome, not per-user.
chrome.storage.sync.get(["apiBaseUrl", "backendMode", "testMode"], (data) => {
  const stored = data.apiBaseUrl;
  const storedIsFirstParty = stored === CLOUD_URL;
  const patch = {};
  if (data.backendMode !== "cloud") patch.backendMode = "cloud";
  if (!storedIsFirstParty) patch.apiBaseUrl = CLOUD_URL;
  if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
  const elLocal = document.getElementById("modeLocal");
  const elCloud = document.getElementById("modeCloud");
  if (elLocal) elLocal.checked = false;
  if (elCloud) elCloud.checked = true;
  const elUrl = document.getElementById("apiBaseUrl");
  if (elUrl) elUrl.value = CLOUD_URL;
  updateModeUI("cloud");
  const elTestMode = document.getElementById("testMode");
  if (elTestMode) elTestMode.checked = !!data.testMode;
});

// Personal fields hydrate from userConfig (server-backed). Subscribe to
// onChange so the form reflects sign-in hydrate + cross-context edits.
function _applyUserConfigToSettingsForm(cfg) {
  const c = cfg || {};
  const elAutoClear = document.getElementById("autoClearSoap");
  if (elAutoClear) elAutoClear.checked = c.auto_clear_soap !== false;
  const elAutoCid = document.getElementById("autoCid");
  if (elAutoCid) elAutoCid.checked = c.auto_cid !== false;
  const elAutoFillCompanion = document.getElementById("autoFillCompanion");
  if (elAutoFillCompanion) elAutoFillCompanion.checked = c.auto_fill_companion !== false;
  const elAutoPrefillEncaminh = document.getElementById("autoPrefillEncaminh");
  if (elAutoPrefillEncaminh) elAutoPrefillEncaminh.checked = c.auto_prefill_encaminh !== false;
  const elCustom = document.getElementById("customInstructions");
  if (elCustom) elCustom.value = c.custom_instructions || "";
}
if (window.TOCAFICHADR_userConfig) {
  window.TOCAFICHADR_userConfig.getCached().then(_applyUserConfigToSettingsForm);
  window.TOCAFICHADR_userConfig.onChange(_applyUserConfigToSettingsForm);
}

// (auth bootstrapping is handled by Clerk in the auth section above —
// _ensureClerk().then(_renderAuthState) takes care of the initial render)

// --- Backend mode toggle ---
document.querySelectorAll("input[name='backendMode']").forEach((radio) => {
  radio.addEventListener("change", (e) => {
    const mode = e.target.value;
    const urlField = document.getElementById("apiBaseUrl");
    if (mode === "cloud") {
      if (urlField) urlField.value = CLOUD_URL;
    } else {
      if (urlField) urlField.value = LOCAL_URL;
    }
    updateModeUI(mode);
  });
});

function updateModeUI(mode) {
  // v3.0: Clerk auth applies regardless of backend mode — local Flask still
  // accepts the JWT (or falls through with AUTH_REQUIRED=false). Only the
  // manual URL field is mode-dependent now.
  const urlField = document.getElementById("urlField");
  if (urlField) urlField.style.display = mode === "cloud" ? "none" : "";
}

// --- Connection test ---
const testBtn = document.getElementById("testBtn");
if (testBtn) {
  testBtn.addEventListener("click", async () => {
    const baseUrl = (document.getElementById("apiBaseUrl")?.value || LOCAL_URL).trim();
    const statusEl = document.getElementById("connStatus");
    if (!statusEl) return;
    statusEl.textContent = "Testando...";
    statusEl.className = "conn-status";
    try {
      const res = await fetch(baseUrl + "/api/health", { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        statusEl.textContent = "Conectado";
        statusEl.className = "conn-status ok";
      } else {
        statusEl.textContent = "Erro HTTP " + res.status;
        statusEl.className = "conn-status err";
      }
    } catch (err) {
      statusEl.textContent = "Sem conexao";
      statusEl.className = "conn-status err";
    }
  });
}

// --- Auth: Sign in / Sign out via Clerk hosted modal (replaces the
//     pre-v3.0 custom email/password + register flow) ---
// v3.1: detect if we're inside the side panel — window.close() would close
// the whole panel (terrible UX), and the ~340px popup constraint is gone.
const _IS_SIDE_PANEL = location.pathname.includes("sidepanel");

const signInBtn = document.getElementById("signInBtn");
if (signInBtn) {
  signInBtn.addEventListener("click", async () => {
    const statusEl = document.getElementById("authStatus");
    if (statusEl) { statusEl.textContent = "Abrindo página de login..."; statusEl.className = "conn-status"; }
    try {
      await _ensureClerk();
      // DIAGNOSTIC build (2026-05-10 attempt #5): log the actual URL the
      // SDK generates so we can see what `redirect_url=` contains. Four
      // prior attempts all hit Clerk's invalid_url_scheme rejection; need
      // ground truth on what the SDK is sending.
      const signInUrl = _clerk.buildSignInUrl({ redirectUrl: CLOUD_URL + "/api/auth/success?ext_id=" + chrome.runtime.id });
      console.warn("[Toca Ficha DIAG signin#1] bundle=AUTH_DIAG_2026_05_10_v5 generated URL:", signInUrl);
      try { console.warn("[Toca Ficha DIAG signin#1] redirect_url param:", new URL(signInUrl).searchParams.get("redirect_url")); } catch (_) {}
      if (!signInUrl) throw new Error("buildSignInUrl returned empty");
      await chrome.tabs.create({ url: signInUrl, active: true });
      if (statusEl) {
        statusEl.textContent = _IS_SIDE_PANEL
          ? "Login aberto em nova aba. Volte aqui após autenticar."
          : "Login aberto em nova aba.";
        statusEl.className = "conn-status ok";
      }
      // In the popup, close so the redirect can re-open it. In the side panel,
      // stay open — the Clerk listener will re-render once the session lands.
      if (!_IS_SIDE_PANEL) window.close();
    } catch (e) {
      console.error("[Toca Ficha] openSignIn failed:", e);
      if (statusEl) { statusEl.textContent = "Erro: " + (e && e.message || e); statusEl.className = "conn-status err"; }
    }
  });
}

const signOutBtn = document.getElementById("signOutBtn");
if (signOutBtn) {
  signOutBtn.addEventListener("click", async () => {
    const statusEl = document.getElementById("authStatus");
    try {
      await _ensureClerk();
      if (statusEl) { statusEl.textContent = "Saindo..."; statusEl.className = "conn-status"; }
      await _clerk.signOut();
      // Force a re-render in case the Clerk listener doesn't fire promptly in the SP.
      try { await _renderAuthState(); } catch (_) {}
      if (statusEl) { statusEl.textContent = ""; }
    } catch (e) {
      console.error("[Toca Ficha] signOut failed:", e);
      if (statusEl) { statusEl.textContent = "Erro ao sair: " + (e && e.message || e); statusEl.className = "conn-status err"; }
    }
  });
}

// v3.1: side panel doesn't auto-close on auth, but Clerk's session change in
// chrome.storage may not fire the in-context listener until after a manual
// poll. Re-render every 5s while logged out, stop once logged in.
if (_IS_SIDE_PANEL) {
  let _authPollTimer = setInterval(async () => {
    try {
      await _renderAuthState();
      if (_clerk && _clerk.user) {
        clearInterval(_authPollTimer);
        _authPollTimer = null;
      }
    } catch (_) {}
  }, 5000);
}

// ---------------------------------------------------------------------------
// Phase 03-02 — Auth gate observer
// ---------------------------------------------------------------------------
// Toggles `body[data-authed="true"]` based on chrome.storage.session.authToken
// presence. Both popup and side panel load this bundle, so one implementation
// gates both surfaces. The CSS in sidepanel.html / popup.html hides the
// tabs / panels / perfCard whenever the attribute is absent and shows
// #auth-gate instead.
function _setAuthGate(isAuthed) {
  if (typeof document === "undefined" || !document.body) return;
  if (isAuthed) {
    document.body.dataset.authed = "true";
  } else {
    delete document.body.dataset.authed;
  }
}

(function _initAuthGate() {
  // Initial read (async, runs after the IIFE settles).
  try {
    chrome.storage.session.get(["authToken"], (data) => {
      _setAuthGate(!!(data && data.authToken));
    });
  } catch (_) { /* storage unavailable in some test contexts */ }

  // Re-render on changes (sign-in / sign-out / token refresh).
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "session" || !changes.authToken) return;
      _setAuthGate(!!changes.authToken.newValue);
    });
  } catch (_) { /* storage unavailable */ }
})();

// Wire the gate's sign-in button to the same Clerk URL flow as #signInBtn.
// Duplicates the click handler intentionally — the existing #signInBtn lives
// inside the Config tab which is hidden by the gate, so we need a parallel
// CTA on the gate itself.
const authGateSignInBtn = document.getElementById("auth-gate-signin-btn");
if (authGateSignInBtn) {
  authGateSignInBtn.addEventListener("click", async () => {
    const statusEl = document.getElementById("auth-gate-status");
    if (statusEl) { statusEl.textContent = "Abrindo página de login..."; statusEl.className = "auth-gate-status"; }
    try {
      await _ensureClerk();
      // DIAGNOSTIC build — see matching block on #signInBtn handler above.
      const signInUrl = _clerk.buildSignInUrl({ redirectUrl: CLOUD_URL + "/api/auth/success?ext_id=" + chrome.runtime.id });
      console.warn("[Toca Ficha DIAG signin#2 gate] bundle=AUTH_DIAG_2026_05_10_v5 generated URL:", signInUrl);
      try { console.warn("[Toca Ficha DIAG signin#2 gate] redirect_url param:", new URL(signInUrl).searchParams.get("redirect_url")); } catch (_) {}
      if (!signInUrl) throw new Error("buildSignInUrl returned empty");
      await chrome.tabs.create({ url: signInUrl, active: true });
      if (statusEl) {
        statusEl.textContent = _IS_SIDE_PANEL
          ? "Login aberto em nova aba. Volte aqui após autenticar."
          : "Login aberto em nova aba.";
      }
      if (!_IS_SIDE_PANEL) window.close();
    } catch (e) {
      console.error("[Toca Ficha] auth-gate signIn failed:", e);
      if (statusEl) { statusEl.textContent = "Erro: " + (e && e.message || e); statusEl.className = "auth-gate-status err"; }
    }
  });
}

// ---------------------------------------------------------------------------
// Prescription templates
// ---------------------------------------------------------------------------
// v3.5: medication shortcuts. Each card can contain one or more med refs plus
// optional frequency/duration/condition overrides. The Prontuario panel lets
// doctors select several cards and print them as one mixed Receita.
// Legacy { id, name, body } or diagnosis templates still auto-migrate and keep
// their free-text body so older saved configs continue to work.
const DEFAULT_RX_TEMPLATES = [
  { id: "tpl_default_0", diagnosis: "Paracetamol",             ageBand: "", body: "", frequency: 0, meds: [{ medId: "paracetamol", dose: "", freq: "", duration: "", when: "se dor ou febre", notes: "" }, { medId: "paracetamol_adult", dose: "", freq: "", duration: "", when: "se dor ou febre", notes: "" }], extraText: "" },
  { id: "tpl_default_1", diagnosis: "Ibuprofeno",              ageBand: "", body: "", frequency: 0, meds: [{ medId: "ibuprofen", dose: "", freq: "", duration: "", when: "se dor ou febre", notes: "" }, { medId: "ibuprofen_adult", dose: "", freq: "", duration: "", when: "se dor ou febre", notes: "" }], extraText: "" },
  { id: "tpl_default_2", diagnosis: "Amoxicilina",             ageBand: "", body: "", frequency: 0, meds: [{ medId: "amox_pneum", dose: "", freq: "", duration: "", when: "", notes: "" }, { medId: "amox_adult", dose: "", freq: "", duration: "", when: "", notes: "" }], extraText: "" },
  { id: "tpl_default_3", diagnosis: "Dor de Garganta",         ageBand: "", body: "", frequency: 0, meds: [{ medId: "amox_pneum", dose: "", freq: "", duration: "7 dias", when: "", notes: "" }, { medId: "paracetamol", dose: "", freq: "", duration: "", when: "se dor ou febre", notes: "" }, { medId: "desloratadine_adult", dose: "", freq: "", duration: "", when: "", notes: "" }, { medId: "ibuprofen", dose: "", freq: "", duration: "", when: "se dor ou febre", notes: "" }], extraText: "Retornar em 7 dias se não houver melhora." },
];

function _cloneDefaultRxTemplates() {
  return JSON.parse(JSON.stringify(DEFAULT_RX_TEMPLATES));
}

/**
 * Migrate a legacy { id, name, body } template into the new schema.
 * Tries to parse `name` as "Diagnosis <ageBand>" or "Diagnosis ageBand";
 * falls back to using the whole name as `diagnosis`.
 *
 * v3.4.0: smart-template fields (`meds`, `extraText`) are preserved when
 * present on already-migrated templates. Legacy templates (no `diagnosis`)
 * still pass through the old name-parsing path; smart fields are introduced
 * later via the editor, never auto-generated here.
 */
function _migrateLegacyTemplate(t) {
  if (!t) return t;
  if (t.diagnosis !== undefined) {
    // Already v2+. Preserve meds + extraText if present (v3.4.0+); otherwise
    // omit the keys entirely so legacy-only templates round-trip cleanly.
    const out = {
      id: t.id,
      diagnosis: t.diagnosis,
      ageBand: t.ageBand,
      body: t.body || "",
      frequency: t.frequency || 0,
    };
    if (Array.isArray(t.meds)) out.meds = t.meds;
    if (t.extraText !== undefined) out.extraText = t.extraText;
    return out;
  }
  const name = String(t.name || "").trim();
  // Try patterns like "Resfriado >6m e <2a" or "GEA <1a"
  const m = name.match(/^(.+?)\s+([<>≥≤]\s*\d+\s*[mad]?(?:\s+e\s+[<>≥≤]\s*\d+\s*[mad]?)?|qualquer|adulto)\s*$/i);
  if (m) {
    return { id: t.id, diagnosis: m[1].trim(), ageBand: m[2].trim(), body: t.body || "", frequency: t.frequency || 0 };
  }
  return { id: t.id, diagnosis: name || "Modelo", ageBand: "", body: t.body || "", frequency: t.frequency || 0 };
}

/**
 * v3.4.0 — A template is "smart" (structured) iff it has at least one med ref.
 * Legacy templates with only `body` keep the old flow (free text → Simples).
 */
function _isSmartTemplate(t) {
  return !!(t && Array.isArray(t.meds) && t.meds.length > 0);
}

// ──────────────────────────────────────────────────────────────────────────
// v3.4.0 — Med catalog fetch & cache
// ──────────────────────────────────────────────────────────────────────────
// The popup editor needs the same dosages catalog the side panel fetches at
// apply-time, but with a placeholder weight (70 kg) so the doctor can preview
// the med list without a real patient context. The full per-patient render
// happens in sidepanel-prontuario.js with the actual patient weight.
//
// 24-hour TTL — the catalog is mostly stable and we don't want to hammer the
// backend on every popup open. If the fetch fails, the modal falls back to
// a static name-only list so the doctor can still pick meds; the side panel
// will compute doses with the real weight at apply time.
const _MED_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const _MED_CATALOG_PREVIEW_WEIGHT = 70;
let _medCatalogPromise = null; // dedupe concurrent fetches

// Static fallback used when the backend is offline. Names + categories only;
// no doses (we surface a hint in the modal saying "doses calculadas no
// momento da aplicação"). Subset of the documented catalog.
const _MED_CATALOG_FALLBACK = {
  pediatric: [
    { id: "amox_pneum", name: "Amoxicilina (Pneumonia/OMA)", category: "antibiotics", frequency: "12/12h", duration: "7-10 dias", presentation: "Susp. 250mg/5mL", practical: "(dose calc. no apply)", is_adult: false, notes: "50mg/kg/dia ÷ 12/12h (pneumonia/OMA); 25-50mg/kg/dia em outras (RENAME 2024)" },
    { id: "amoxclav_ped", name: "Amoxicilina + Clavulanato", category: "antibiotics", frequency: "12/12h", duration: "7-10 dias", presentation: "Susp. 250+62,5mg/5mL", practical: "(dose calc. no apply)", is_adult: false, notes: "25-50mg/kg/dia (amox) ÷ 12/12h (RENAME 2024)" },
    { id: "cephalexin", name: "Cefalexina", category: "antibiotics", frequency: "8/8h", duration: "7 dias", presentation: "Susp. 250mg/5mL", practical: "(dose calc. no apply)", is_adult: false, notes: "25-50mg/kg/dia ÷ 6-8/8h; máx 500mg/dose (RENAME 2024)" },
    { id: "azithromycin", name: "Azitromicina", category: "antibiotics", frequency: "1x/dia", duration: "5 dias", presentation: "Susp. 200mg/5mL", practical: "(dose calc. no apply)", is_adult: false, notes: "10mg/kg/dia 1x/dia 3-5 dias; máx 500mg (RENAME 2024)" },
    { id: "claritro_ped", name: "Claritromicina", category: "antibiotics", frequency: "12/12h", duration: "7-10 dias", presentation: "Susp. 250mg/5mL", practical: "(dose calc. no apply)", is_adult: false, notes: "7,5mg/kg/dose 12/12h; máx 500mg/dose (RENAME 2024)" },
    { id: "eritro_ped", name: "Eritromicina", category: "antibiotics", frequency: "6/6h", duration: "7-10 dias", presentation: "Susp. 250mg/5mL", practical: "(dose calc. no apply)", is_adult: false, notes: "10mg/kg/dose 6/6h; máx 500mg/dose (RENAME 2024)" },
    { id: "smxtmp_ped", name: "Sulfametoxazol + Trimetoprima", category: "antibiotics", frequency: "12/12h", duration: "7-10 dias", presentation: "Susp. 200+40mg/5mL", practical: "(dose calc. no apply)", is_adult: false, notes: "~6-10mg/kg/dia (TMP) ÷ 12/12h; máx 800mg(SMX)/dose (RENAME 2024)" },
    { id: "metronidazol_ped", name: "Metronidazol", category: "antibiotics", frequency: "8/8h", duration: "7 dias", presentation: "Susp. 200mg/5mL (40mg/mL)", practical: "(dose calc. no apply)", is_adult: false, notes: "7,5mg/kg/dose 8/8h; máx 500mg/dose (RENAME 2024)" },
    { id: "ceftriaxona_ped", name: "Ceftriaxona (IM/IV)", category: "antibiotics", frequency: "1x/dia", duration: "a critério", presentation: "Frasco-ampola 1g", practical: "(dose calc. no apply)", is_adult: false, notes: "50-75mg/kg/dia 1x/dia; meningite 100mg/kg/dia 12/12h; máx 2g/dose (RENAME 2024)" },
    { id: "benzatina_ped", name: "Penicilina Benzatina (IM)", category: "antibiotics", frequency: "dose única", duration: "dose única", presentation: "Frasco 600.000 UI", practical: "(dose calc. no apply)", is_adult: false, notes: "50.000 UI/kg dose única IM; máx 1.200.000 UI (RENAME 2024)" },
    { id: "albendazol_ped", name: "Albendazol", category: "antiparasitics", frequency: "1x/dia", duration: "1-3 dias", presentation: "Susp. 40mg/mL", practical: "(dose calc. no apply)", is_adult: false, notes: ">2a: 400mg/dia 1-3 dias (RENAME 2024)" },
    { id: "mebendazol_ped", name: "Mebendazol", category: "antiparasitics", frequency: "12/12h", duration: "3 dias", presentation: "Susp. 20mg/mL", practical: "(dose calc. no apply)", is_adult: false, notes: "100mg 12/12h por 3 dias (RENAME 2024)" },
    { id: "ivermectina_ped", name: "Ivermectina", category: "antiparasitics", frequency: "dose única", duration: "dose única", presentation: "Comprimido 6mg", practical: "(dose calc. no apply)", is_adult: false, notes: ">15kg: 200mcg/kg dose única; repetir 7-14 dias se escabiose (RENAME 2024)" },
    { id: "nistatina_ped", name: "Nistatina (oral)", category: "antifungals", frequency: "6/6h", duration: "7-14 dias", presentation: "Susp. 100.000 UI/mL", practical: "(dose calc. no apply)", is_adult: false, notes: "100.000 UI (1mL) 4-6/6h, bochechar/deglutir (RENAME 2024)" },
    { id: "dipyrone", name: "Dipirona", category: "analgesics", frequency: "6/6h", duration: "SN", presentation: "Gotas 500mg/mL", practical: "(dose calc. no apply)", is_adult: false, notes: "10-25mg/kg/dose 6/6h; contraindicado <3 meses ou <5kg (RENAME 2024)" },
    { id: "ibuprofen", name: "Ibuprofeno", category: "analgesics", frequency: "8/8h", duration: "SN", presentation: "Gotas 50mg/mL", practical: "(dose calc. no apply)", is_adult: false, notes: "5-10mg/kg/dose 6-8/8h; >6 meses (RENAME 2024)" },
    { id: "paracetamol", name: "Paracetamol", category: "analgesics", frequency: "6/6h", duration: "SN", presentation: "Gotas 200mg/mL", practical: "(dose calc. no apply)", is_adult: false, notes: "10-15mg/kg/dose 6/6h; máx 75mg/kg/dia (RENAME 2024)" },
    { id: "prednisolone", name: "Prednisolona", category: "corticoids", frequency: "1x/dia", duration: "3-5 dias", presentation: "Sol. oral 3mg/mL", practical: "(dose calc. no apply)", is_adult: false, notes: "1-2mg/kg/dia 1x/dia (manhã); máx 60mg (RENAME 2024)" },
    { id: "dexa_ped", name: "Dexametasona", category: "corticoids", frequency: "dose única", duration: "1-4 dias", presentation: "Elixir 0,1mg/mL", practical: "(dose calc. no apply)", is_adult: false, notes: "crupe 0,15-0,6mg/kg dose única; máx 16mg (drugs.ts/RENAME 2024)" },
    { id: "loratadina_ped", name: "Loratadina", category: "antihistamines", frequency: "1x/dia", duration: "a critério", presentation: "Xarope 1mg/mL", practical: "(dose calc. no apply)", is_adult: false, notes: "2-12a: 5mg/dia (>30kg: 10mg/dia) (RENAME/Anvisa bula)" },
    { id: "desloratadine_ped", name: "Desloratadina", category: "antihistamines", frequency: "1x/dia", duration: "a critério", presentation: "Xarope 0,5mg/mL", practical: "(dose calc. no apply)", is_adult: false, notes: "1-5a: 1,25mg; 6-11a: 2,5mg; >12a: 5mg/dia (Anvisa bula)" },
    { id: "hidroxizina_ped", name: "Hidroxizina", category: "antihistamines", frequency: "8/8h", duration: "a critério", presentation: "Xarope 2mg/mL", practical: "(dose calc. no apply)", is_adult: false, notes: "0,5-1mg/kg/dose 6-8/8h; máx 25mg/dose (drugs.ts/RENAME 2024)" },
    { id: "salbutamol_neb", name: "Salbutamol (Nebulização)", category: "respiratory", frequency: "20/20min", duration: "crise", presentation: "Sol. 5mg/mL + 3mL SF", practical: "(dose calc. no apply)", is_adult: false, notes: "0,07-0,15mg/kg/dose (mín 2,5mg) 20/20min na crise (drugs.ts/RENAME 2024)" },
    { id: "ipratropio_ped", name: "Ipratrópio (Nebulização)", category: "respiratory", frequency: "20/20min", duration: "crise", presentation: "Sol. 0,25mg/mL", practical: "(dose calc. no apply)", is_adult: false, notes: "250mcg/dose 20/20min por 3 doses, associado ao salbutamol (drugs.ts/RENAME 2024)" },
    { id: "budesonida_neb_ped", name: "Budesonida (Nebulização)", category: "respiratory", frequency: "1-2x/dia", duration: "a critério", presentation: "Susp. 0,25-0,5mg/2mL", practical: "(dose calc. no apply)", is_adult: false, notes: "crupe: 2mg dose única; asma: 0,25-0,5mg 12/12h (drugs.ts)" },
    { id: "adren_neb_ped", name: "Adrenalina (Nebulização-Crupe)", category: "respiratory", frequency: "SN", duration: "crise", presentation: "Sol. 1mg/mL (1:1000)", practical: "(dose calc. no apply)", is_adult: false, notes: "0,5mL/kg (máx 5mL) diluído; repetir após 20min se necessário (drugs.ts)" },
    { id: "sf_nasal", name: "Soro fisiológico nasal", category: "respiratory", frequency: "6/6h", duration: "—", presentation: "0.9%", practical: "instilar", is_adult: false, notes: "Lavagem nasal; instilar conforme necessidade" },
    { id: "metoclopramida_ped", name: "Metoclopramida", category: "gastro", frequency: "8/8h", duration: "SN", presentation: "Gotas 4mg/mL", practical: "(dose calc. no apply)", is_adult: false, notes: "0,1mg/kg/dose 8/8h; cautela <1a (risco extrapiramidal) (drugs.ts/RENAME 2024)" },
    { id: "bromoprida_ped", name: "Bromoprida", category: "gastro", frequency: "8/8h", duration: "SN", presentation: "Gotas 4mg/mL", practical: "(dose calc. no apply)", is_adult: false, notes: "0,5-1 gota/kg/dose 8/8h (drugs.ts/Anvisa bula)" },
    { id: "ondansetrona_ped", name: "Ondansetrona", category: "gastro", frequency: "8/8h", duration: "SN", presentation: "Comp. 4mg / Sol. 4mg/5mL", practical: "(dose calc. no apply)", is_adult: false, notes: "0,15mg/kg/dose; gastroenterite: dose única VO; máx 8mg (drugs.ts/RENAME 2024)" },
    { id: "lactulose_ped", name: "Lactulose", category: "gastro", frequency: "1-2x/dia", duration: "a critério", presentation: "Xarope 667mg/mL", practical: "(dose calc. no apply)", is_adult: false, notes: "0,4mL/kg/dia ÷ 1-2x; ajustar pela resposta (drugs.ts/RENAME 2024)" },
    { id: "simeticona_ped", name: "Simeticona", category: "gastro", frequency: "6/6h", duration: "SN", presentation: "Gotas 75mg/mL", practical: "(dose calc. no apply)", is_adult: false, notes: "~1 gota/kg/dose 6/6h após mamadas (drugs.ts/Anvisa bula)" },
    { id: "sulfato_ferroso_ped", name: "Sulfato Ferroso", category: "supplements", frequency: "1x/dia", duration: "a critério", presentation: "Gotas 25mg Fe/mL", practical: "(dose calc. no apply)", is_adult: false, notes: "3-5mg/kg/dia (Fe elementar) terapêutico; profilaxia 1-2mg/kg/dia (RENAME 2024/SBP)" },
    { id: "acido_folico_ped", name: "Ácido Fólico", category: "supplements", frequency: "1x/dia", duration: "a critério", presentation: "Sol. oral 0,2mg/mL", practical: "(dose calc. no apply)", is_adult: false, notes: "profilaxia 0,4mg/dia; terapêutico conforme idade (RENAME 2024)" },
    { id: "sulfato_zinco_ped", name: "Sulfato de Zinco (Diarreia)", category: "supplements", frequency: "1x/dia", duration: "10-14 dias", presentation: "Sol. oral 4mg/mL", practical: "(dose calc. no apply)", is_adult: false, notes: "diarreia aguda: <6m 10mg/dia, >6m 20mg/dia por 10-14 dias (MS/SBP)" },
    { id: "adren_im_ped", name: "Adrenalina IM (Anafilaxia)", category: "others", frequency: "SN", duration: "crise", presentation: "Amp. 1mg/mL (1:1000)", practical: "(dose calc. no apply)", is_adult: false, notes: "0,01mg/kg IM (máx 0,3mg); repetir 5-15min se necessário (drugs.ts/RENAME 2024)" },
  ],
  adult: [
    { id: "amox_adult", name: "Amoxicilina 500mg", category: "antibiotics", frequency: "8/8h", duration: "7 dias", presentation: "Cápsula 500mg", practical: "500mg", is_adult: true, notes: "500-875mg 8/8h; máx 3g/dia (RENAME 2024)" },
    { id: "amoxclav_adult", name: "Amoxicilina + Clavulanato 875mg", category: "antibiotics", frequency: "12/12h", duration: "7 dias", presentation: "Comprimido 875+125mg", practical: "1 cp", is_adult: true, notes: "875mg(amox) 12/12h; máx 4g/dia (RENAME 2024)" },
    { id: "cefalex_adult", name: "Cefalexina 500mg", category: "antibiotics", frequency: "6/6h", duration: "7 dias", presentation: "Cápsula 500mg", practical: "500mg", is_adult: true, notes: "500mg 6/6h (RENAME 2024)" },
    { id: "azitro_adult", name: "Azitromicina 500mg", category: "antibiotics", frequency: "1x/dia", duration: "5 dias", presentation: "Comprimido 500mg", practical: "500mg", is_adult: true, notes: "D1 500mg, D2-5 250mg/dia (ou 500mg/dia 3 dias) (RENAME 2024)" },
    { id: "cipro_adult", name: "Ciprofloxacino 500mg", category: "antibiotics", frequency: "12/12h", duration: "7 dias", presentation: "Comprimido 500mg", practical: "1 cp", is_adult: true, notes: "500mg 12/12h VO; máx 1,5g/dia (RENAME 2024)" },
    { id: "levoflox_adult", name: "Levofloxacino 500mg", category: "antibiotics", frequency: "1x/dia", duration: "7 dias", presentation: "Comprimido 500mg", practical: "1 cp", is_adult: true, notes: "500-750mg 1x/dia (RENAME 2024)" },
    { id: "metronidazol_adult", name: "Metronidazol 250mg", category: "antibiotics", frequency: "8/8h", duration: "7 dias", presentation: "Comprimido 250mg", practical: "2 cp (500mg)", is_adult: true, notes: "500mg 8/8h; máx 1,5g/dia; evitar álcool (RENAME 2024)" },
    { id: "doxiciclina_adult", name: "Doxiciclina 100mg", category: "antibiotics", frequency: "12/12h", duration: "7 dias", presentation: "Comprimido 100mg", practical: "100mg", is_adult: true, notes: "100mg 12/12h (RENAME 2024)" },
    { id: "smxtmp_adult", name: "Sulfametoxazol+Trimetoprima 800+160mg", category: "antibiotics", frequency: "12/12h", duration: "7-10 dias", presentation: "Comprimido 800+160mg", practical: "1 cp", is_adult: true, notes: "800/160mg 12/12h (RENAME 2024)" },
    { id: "claritro_adult", name: "Claritromicina 500mg", category: "antibiotics", frequency: "12/12h", duration: "7-14 dias", presentation: "Comprimido 500mg", practical: "1 cp", is_adult: true, notes: "500mg 12/12h; máx 1g/dia (RENAME 2024)" },
    { id: "clinda_adult", name: "Clindamicina 300mg", category: "antibiotics", frequency: "6/6h", duration: "7-10 dias", presentation: "Cápsula 300mg", practical: "1 cp", is_adult: true, notes: "300mg 6/6h VO (RENAME 2024)" },
    { id: "ceftriaxona_adult", name: "Ceftriaxona 1g (IM/IV)", category: "antibiotics", frequency: "1x/dia", duration: "a critério", presentation: "Frasco-ampola 1g", practical: "1g IM/IV", is_adult: true, notes: "1-2g 1x/dia; meningite 2g 12/12h; máx 4g/dia (RENAME 2024)" },
    { id: "benzatina_adult", name: "Penicilina Benzatina 1.200.000 UI (IM)", category: "antibiotics", frequency: "dose única", duration: "dose única", presentation: "Frasco 1.200.000 UI", practical: "1.200.000-2.400.000 UI IM", is_adult: true, notes: "sífilis recente 2,4M UI dose única; tardia 2,4M/semana 3 doses (RENAME 2024)" },
    { id: "albendazol_adult", name: "Albendazol 400mg", category: "antiparasitics", frequency: "1x/dia", duration: "1-3 dias", presentation: "Comprimido 400mg", practical: "400mg", is_adult: true, notes: "400mg dose única (helmintos); 3 dias p/ alguns; repetir 7-14d (RENAME 2024)" },
    { id: "mebendazol_adult", name: "Mebendazol 100mg", category: "antiparasitics", frequency: "12/12h", duration: "3 dias", presentation: "Comprimido 100mg", practical: "100mg", is_adult: true, notes: "100mg 12/12h por 3 dias (RENAME 2024)" },
    { id: "ivermectina_adult", name: "Ivermectina 6mg", category: "antiparasitics", frequency: "dose única", duration: "dose única", presentation: "Comprimido 6mg", practical: "200 mcg/kg", is_adult: true, notes: "200mcg/kg dose única; repetir 7-14 dias em escabiose (RENAME 2024)" },
    { id: "nistatina_adult", name: "Nistatina 100.000 UI/mL", category: "antifungals", frequency: "6/6h", duration: "7-14 dias", presentation: "Susp. oral 100.000 UI/mL", practical: "5 mL (bochechar/deglutir)", is_adult: true, notes: "500.000 UI (5mL) 4-6/6h (RENAME 2024)" },
    { id: "fluconazol_adult", name: "Fluconazol 150mg", category: "antifungals", frequency: "1x/dia", duration: "1-7 dias", presentation: "Cápsula 150mg", practical: "150mg", is_adult: true, notes: "candidíase vaginal 150mg dose única; sistêmica 1x/dia (RENAME 2024)" },
    { id: "dipyrone_adult", name: "Dipirona 1g", category: "analgesics", frequency: "6/6h", duration: "SN", presentation: "Comprimido 1g", practical: "1 cp", is_adult: true, notes: "500-1000mg 6/6h; máx 4g/dia (RENAME 2024)" },
    { id: "paracetamol_adult", name: "Paracetamol 750mg", category: "analgesics", frequency: "6/6h", duration: "SN", presentation: "Comprimido 750mg", practical: "1 cp", is_adult: true, notes: "500-750mg 6/6h; máx 4g/dia (RENAME 2024)" },
    { id: "ibu_adult", name: "Ibuprofeno 600mg", category: "analgesics", frequency: "8/8h", duration: "5 dias", presentation: "Comprimido 600mg", practical: "1 cp", is_adult: true, notes: "600mg 8/8h; máx 3,2g/dia (RENAME 2024)" },
    { id: "aas_adult", name: "Ácido Acetilsalicílico (AAS)", category: "analgesics", frequency: "4-6/6h", duration: "SN", presentation: "Comprimido 500mg", practical: "1 cp", is_adult: true, notes: "analgésico 500mg 4-6/6h; antiplaquetário 100mg/dia (RENAME 2024)" },
    { id: "diclofenaco_adult", name: "Diclofenaco 50mg", category: "analgesics", frequency: "8/8h", duration: "5 dias", presentation: "Comprimido 50mg", practical: "1 cp", is_adult: true, notes: "50mg 8/8h; máx 150mg/dia (RENAME 2024)" },
    { id: "cetoprofeno_adult", name: "Cetoprofeno 100mg", category: "analgesics", frequency: "12/12h", duration: "5 dias", presentation: "Comprimido 100mg", practical: "1 cp", is_adult: true, notes: "100mg 8-12/12h; máx 300mg/dia (RENAME 2024)" },
    { id: "tramadol_adult", name: "Tramadol 50mg", category: "analgesics", frequency: "6/6h", duration: "SN", presentation: "Cápsula 50mg", practical: "50-100mg", is_adult: true, notes: "50-100mg 6/6h; máx 400mg/dia (RENAME 2024)" },
    { id: "predniso_adult", name: "Prednisona 20mg", category: "corticoids", frequency: "1x/dia", duration: "5 dias", presentation: "Comprimido 20mg", practical: "1 cp", is_adult: true, notes: "5-60mg/dia (manhã); desmame se uso prolongado (RENAME 2024)" },
    { id: "dexa_adult", name: "Dexametasona 4mg", category: "corticoids", frequency: "12/12h", duration: "a critério", presentation: "Comprimido 4mg", practical: "1 cp", is_adult: true, notes: "4mg 12-24/24h conforme indicação; máx 24mg/dia (RENAME 2024)" },
    { id: "betametasona_adult", name: "Betametasona 0,5mg", category: "corticoids", frequency: "12/12h", duration: "a critério", presentation: "Comprimido 0,5mg", practical: "1 cp", is_adult: true, notes: "0,5mg 12-24/24h; ação longa (RENAME 2024)" },
    { id: "hidrocortisona_adult", name: "Hidrocortisona (IV/IM)", category: "corticoids", frequency: "6/6h", duration: "a critério", presentation: "Frasco-ampola 100/500mg", practical: "100-200mg IV", is_adult: true, notes: "anafilaxia/asma grave 100-200mg IV; máx 500mg/dose (drugs.ts/RENAME 2024)" },
    { id: "loratadina_adult", name: "Loratadina 10mg", category: "antihistamines", frequency: "1x/dia", duration: "a critério", presentation: "Comprimido 10mg", practical: "1 cp", is_adult: true, notes: "10mg 1x/dia (RENAME 2024)" },
    { id: "desloratadine_adult", name: "Desloratadina 5mg", category: "antihistamines", frequency: "1x/dia", duration: "a critério", presentation: "Comprimido 5mg", practical: "1 cp", is_adult: true, notes: "5mg 1x/dia (Anvisa bula)" },
    { id: "hidroxizina_adult", name: "Hidroxizina 25mg", category: "antihistamines", frequency: "8/8h", duration: "a critério", presentation: "Comprimido 25mg", practical: "1 cp", is_adult: true, notes: "25mg 6-8/8h; sedativo (RENAME 2024)" },
    { id: "prometazina_adult", name: "Prometazina 25mg", category: "antihistamines", frequency: "8/8h", duration: "SN", presentation: "Comprimido 25mg", practical: "1 cp", is_adult: true, notes: "25mg 8-12/12h; contraindicada <2 anos (RENAME 2024)" },
    { id: "salbutamol_neb_adult", name: "Salbutamol (Nebulização)", category: "respiratory", frequency: "20/20min", duration: "crise", presentation: "Sol. 5mg/mL", practical: "10 gotas (2,5-5mg) + 3mL SF", is_adult: true, notes: "2,5-5mg 20/20min por 3 doses na crise (RENAME 2024)" },
    { id: "ipratropio_adult", name: "Ipratrópio (Nebulização)", category: "respiratory", frequency: "20/20min", duration: "crise", presentation: "Sol. 0,25mg/mL", practical: "40 gotas (0,5mg) + SF", is_adult: true, notes: "0,5mg 20/20min por 3 doses, associado ao salbutamol (RENAME 2024)" },
    { id: "omeprazol_adult", name: "Omeprazol 20mg", category: "gastro", frequency: "1x/dia", duration: "a critério", presentation: "Cápsula 20mg", practical: "1 cp", is_adult: true, notes: "20mg/dia (jejum); até 40mg 12/12h em alto risco/H.pylori (RENAME 2024)" },
    { id: "pantoprazol_adult", name: "Pantoprazol 40mg", category: "gastro", frequency: "1x/dia", duration: "a critério", presentation: "Comprimido 40mg", practical: "1 cp", is_adult: true, notes: "40mg/dia (manhã, jejum) (RENAME 2024)" },
    { id: "metoclopramida_adult", name: "Metoclopramida 10mg", category: "gastro", frequency: "8/8h", duration: "SN", presentation: "Comprimido 10mg / Gotas 4mg/mL", practical: "10mg", is_adult: true, notes: "10mg 8/8h; máx 30mg/dia (RENAME 2024)" },
    { id: "bromoprida_adult", name: "Bromoprida 10mg", category: "gastro", frequency: "8/8h", duration: "SN", presentation: "Cápsula 10mg", practical: "1 cp", is_adult: true, notes: "10mg 8/8h (RENAME 2024)" },
    { id: "ondansetrona_adult", name: "Ondansetrona 8mg", category: "gastro", frequency: "8/8h", duration: "SN", presentation: "Comprimido 4-8mg", practical: "8mg", is_adult: true, notes: "4-8mg 8/8h; máx 32mg/dia (RENAME 2024)" },
    { id: "dimenidrinato_adult", name: "Dimenidrinato + B6", category: "gastro", frequency: "6/6h", duration: "SN", presentation: "Comprimido 50mg", practical: "1 cp", is_adult: true, notes: "50mg 6/6h (cinetose/náusea) (RENAME/Anvisa bula)" },
    { id: "lactulose_adult", name: "Lactulose", category: "gastro", frequency: "1-3x/dia", duration: "a critério", presentation: "Xarope 667mg/mL", practical: "15 mL", is_adult: true, notes: "15-30mL 1-3x/dia; ajustar pela resposta (RENAME 2024)" },
    { id: "loperamida_adult", name: "Loperamida 2mg", category: "gastro", frequency: "SN", duration: "SN", presentation: "Comprimido 2mg", practical: "2mg após evacuação", is_adult: true, notes: "4mg inicial, 2mg após cada evacuação líquida; máx 16mg/dia (RENAME 2024)" },
    { id: "hidroxido_aluminio_adult", name: "Hidróxido de Alumínio", category: "gastro", frequency: "4-6/6h", duration: "SN", presentation: "Susp. oral", practical: "15 mL", is_adult: true, notes: "antiácido; afastar de outros fármacos (RENAME 2024)" },
    { id: "simeticona_adult", name: "Simeticona 40mg", category: "gastro", frequency: "6/6h", duration: "SN", presentation: "Comprimido 40mg / Gotas 75mg/mL", practical: "40-125mg", is_adult: true, notes: "40-125mg 6/6h após refeições (Anvisa bula)" },
    { id: "losartana", name: "Losartana 50mg", category: "cardio", frequency: "1x/dia", duration: "—", presentation: "Comprimido 50mg", practical: "1 cp", is_adult: true, notes: "50mg 1x/dia; máx 100mg/dia (RENAME 2024)" },
    { id: "enalapril_adult", name: "Enalapril 10mg", category: "cardio", frequency: "12/12h", duration: "—", presentation: "Comprimido 10mg", practical: "1 cp", is_adult: true, notes: "10-20mg 12/12h; máx 40mg/dia (RENAME 2024)" },
    { id: "captopril_adult", name: "Captopril 25mg", category: "cardio", frequency: "8/8h", duration: "—", presentation: "Comprimido 25mg", practical: "1 cp", is_adult: true, notes: "25mg 8/8h; emergência: 25mg SL dose única (RENAME 2024)" },
    { id: "anlodipino_adult", name: "Anlodipino 5mg", category: "cardio", frequency: "1x/dia", duration: "—", presentation: "Comprimido 5mg", practical: "1 cp", is_adult: true, notes: "5mg 1x/dia; máx 10mg/dia (RENAME 2024)" },
    { id: "hidroclorotiazida_adult", name: "Hidroclorotiazida 25mg", category: "cardio", frequency: "1x/dia", duration: "—", presentation: "Comprimido 25mg", practical: "1 cp", is_adult: true, notes: "25mg 1x/dia (manhã); máx 50mg/dia (RENAME 2024)" },
    { id: "furosemida_adult", name: "Furosemida 40mg", category: "cardio", frequency: "1x/dia", duration: "a critério", presentation: "Comprimido 40mg", practical: "1 cp", is_adult: true, notes: "40mg 1-2x/dia conforme resposta (RENAME 2024)" },
    { id: "espironolactona_adult", name: "Espironolactona 25mg", category: "cardio", frequency: "1x/dia", duration: "—", presentation: "Comprimido 25mg", practical: "1 cp", is_adult: true, notes: "25-100mg/dia (RENAME 2024)" },
    { id: "propranolol_adult", name: "Propranolol 40mg", category: "cardio", frequency: "8/8h", duration: "—", presentation: "Comprimido 40mg", practical: "1 cp", is_adult: true, notes: "40mg 8-12/12h; titular (RENAME 2024)" },
    { id: "carvedilol_adult", name: "Carvedilol 6,25mg", category: "cardio", frequency: "12/12h", duration: "—", presentation: "Comprimido 6,25mg", practical: "1 cp", is_adult: true, notes: "6,25mg 12/12h; titular até 25mg 12/12h (RENAME 2024)" },
    { id: "metildopa_adult", name: "Metildopa 250mg", category: "cardio", frequency: "8/8h", duration: "—", presentation: "Comprimido 250mg", practical: "1 cp", is_adult: true, notes: "250mg 8-12/12h; opção na gestação (RENAME 2024)" },
    { id: "nifedipino_adult", name: "Nifedipino Retard 20mg", category: "cardio", frequency: "12/12h", duration: "—", presentation: "Comprimido 20mg", practical: "1 cp", is_adult: true, notes: "20mg 12/12h (liberação prolongada) (RENAME 2024)" },
    { id: "sinvastatina_adult", name: "Sinvastatina 20mg", category: "cardio", frequency: "1x/dia", duration: "—", presentation: "Comprimido 20mg", practical: "1 cp", is_adult: true, notes: "20-40mg 1x/dia (à noite) (RENAME 2024)" },
    { id: "clopidogrel_adult", name: "Clopidogrel 75mg", category: "cardio", frequency: "1x/dia", duration: "—", presentation: "Comprimido 75mg", practical: "1 cp", is_adult: true, notes: "75mg 1x/dia (RENAME 2024)" },
    { id: "digoxina_adult", name: "Digoxina 0,25mg", category: "cardio", frequency: "1x/dia", duration: "—", presentation: "Comprimido 0,25mg", practical: "1 cp", is_adult: true, notes: "0,125-0,25mg/dia (manutenção) (RENAME 2024)" },
    { id: "metformina_adult", name: "Metformina 850mg", category: "endocrine", frequency: "12/12h", duration: "—", presentation: "Comprimido 850mg", practical: "1 cp", is_adult: true, notes: "iniciar 1x/dia, titular; máx 2.550mg/dia (RENAME 2024)" },
    { id: "glibenclamida_adult", name: "Glibenclamida 5mg", category: "endocrine", frequency: "1x/dia", duration: "—", presentation: "Comprimido 5mg", practical: "1 cp", is_adult: true, notes: "5mg/dia (antes do café); máx 20mg/dia (RENAME 2024)" },
    { id: "insulina_nph_adult", name: "Insulina NPH (SC)", category: "endocrine", frequency: "1-2x/dia", duration: "—", presentation: "Frasco 100 UI/mL", practical: "0,3 UI/kg/dia inicial", is_adult: true, notes: "dose total diária ~0,3 UI/kg, ajustar pela glicemia (RENAME 2024)" },
    { id: "sulfato_ferroso_adult", name: "Sulfato Ferroso 40mg Fe", category: "supplements", frequency: "1x/dia", duration: "a critério", presentation: "Drágea 40mg Fe (200mg)", practical: "1 drágea", is_adult: true, notes: "40-120mg Fe/dia; profilaxia gestante 40mg/dia (RENAME 2024)" },
    { id: "acido_folico_adult", name: "Ácido Fólico 5mg", category: "supplements", frequency: "1x/dia", duration: "a critério", presentation: "Comprimido 5mg", practical: "1 cp", is_adult: true, notes: "5mg/dia; gestação/profilaxia 0,4mg/dia (RENAME 2024)" },
    { id: "calcio_vitd_adult", name: "Carbonato de Cálcio + Vit. D", category: "supplements", frequency: "1x/dia", duration: "a critério", presentation: "Comprimido 600mg Ca + 400UI D", practical: "1 cp", is_adult: true, notes: "600mg cálcio elementar/dia ÷ 1-2x (RENAME 2024)" },
    { id: "ciclo_adult", name: "Ciclobenzaprina 5mg", category: "others", frequency: "à noite", duration: "5 dias", presentation: "Comprimido 5mg", practical: "1 cp", is_adult: true, notes: "5-10mg à noite; relaxante muscular (RENAME/Anvisa bula)" },
    { id: "sertralina_adult", name: "Sertralina 50mg", category: "others", frequency: "1x/dia", duration: "—", presentation: "Comprimido 50mg", practical: "1 cp", is_adult: true, notes: "50mg/dia (manhã); titular até 200mg/dia (RENAME 2024)" },
    { id: "clorexidina_adult", name: "Clorexidina 0,12% (Bucal)", category: "others", frequency: "12/12h", duration: "a critério", presentation: "Sol. bucal 0,12%", practical: "bochechar 15mL", is_adult: true, notes: "antisséptico bucal 2x/dia (RENAME 2024)" },
    { id: "adren_im_adult", name: "Adrenalina IM (Anafilaxia)", category: "others", frequency: "SN", duration: "crise", presentation: "Amp. 1mg/mL (1:1000)", practical: "0,5mg IM (0,5mL)", is_adult: true, notes: "0,3-0,5mg IM coxa; repetir 5-15min se necessário (RENAME 2024)" },
  ],
};

async function _fetchMedCatalog() {
  // Cache hit (chrome.storage.local — popup does not write to sync to avoid
  // burning the 100KB/8KB-per-key sync quota with the catalog).
  try {
    const cached = await new Promise((res) =>
      chrome.storage.local.get(['medCatalogCache'], (d) => res(d.medCatalogCache))
    );
    if (cached && cached.ts && (Date.now() - cached.ts < _MED_CATALOG_TTL_MS) && cached.payload) {
      return cached.payload;
    }
  } catch (_) { /* fall through to fetch */ }

  const settings = await new Promise((res) =>
    chrome.storage.sync.get(['apiBaseUrl'], (d) => res(d || {}))
  );
  const baseUrl = (settings.apiBaseUrl || LOCAL_URL).replace(/\/+$/, "");

  const auth = await new Promise((res) =>
    chrome.storage.session.get(['authToken'], (d) => res(d || {}))
  );
  const headers = {};
  if (auth.authToken) headers['Authorization'] = 'Bearer ' + auth.authToken;

  const url = baseUrl + '/api/dosages/full?weight=' + _MED_CATALOG_PREVIEW_WEIGHT + '&type=both';
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const payload = await r.json();
    if (!payload || (!Array.isArray(payload.pediatric) && !Array.isArray(payload.adult))) {
      throw new Error('payload sem listas pediatric/adult');
    }
    await chrome.storage.local.set({ medCatalogCache: { ts: Date.now(), payload } });
    return payload;
  } catch (e) {
    console.warn('[Toca Ficha Dr.] med catalog fetch failed, using fallback:', e && e.message);
    // Fallback: return the static list, but mark it so the modal can render
    // a warning banner. We do NOT persist the fallback to cache — next open
    // retries the backend.
    return Object.assign({}, _MED_CATALOG_FALLBACK, { _fallback: true });
  }
}

function _getMedCatalog() {
  // Dedupe concurrent fetches (e.g. doctor mashes "+ Adicionar medicação"
  // on multiple cards before the first promise settles).
  if (!_medCatalogPromise) _medCatalogPromise = _fetchMedCatalog();
  return _medCatalogPromise;
}

// v3.6 (CHRA-2044) — expanded catalog taxonomy. Clinical sort order; unknown
// categories fall back to 99 (sorted last). Keep keys in sync with the
// category strings used in _MED_CATALOG_FALLBACK above.
const _CATEGORY_ORDER = {
  antibiotics: 0, antiparasitics: 1, antifungals: 2, analgesics: 3,
  corticoids: 4, antihistamines: 5, respiratory: 6, gastro: 7,
  cardio: 8, endocrine: 9, supplements: 10, others: 11,
};
// pt-BR labels for the category chip in the med-catalog modal. Falls back to
// the raw key for any unmapped category so nothing renders blank.
const _CATEGORY_LABEL = {
  antibiotics: 'Antibiótico', antiparasitics: 'Antiparasitário',
  antifungals: 'Antifúngico', analgesics: 'Analgésico/Antitérmico',
  corticoids: 'Corticoide', antihistamines: 'Anti-histamínico',
  respiratory: 'Respiratório', gastro: 'Gastro', cardio: 'Cardiovascular',
  endocrine: 'Endócrino', supplements: 'Suplemento', others: 'Outros',
};
function _flattenCatalog(payload) {
  const out = [];
  (payload.pediatric || []).forEach((m) => out.push(Object.assign({ _kind: 'PED' }, m)));
  (payload.adult || []).forEach((m) => out.push(Object.assign({ _kind: 'ADULTO' }, m)));
  out.sort((a, b) => {
    const ca = _CATEGORY_ORDER[a.category] !== undefined ? _CATEGORY_ORDER[a.category] : 99;
    const cb = _CATEGORY_ORDER[b.category] !== undefined ? _CATEGORY_ORDER[b.category] : 99;
    if (ca !== cb) return ca - cb;
    return String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR');
  });
  return out;
}

function _findMedInFlat(medId, flat) {
  return flat.find((m) => m.id === medId) || null;
}

// ──────────────────────────────────────────────────────────────────────────
// v3.4.0 — Med catalog modal
// ──────────────────────────────────────────────────────────────────────────
// Single shared modal (one in the DOM) parameterised by a target template id.
// Opens on "+ Adicionar medicação" click, search filters by name+category,
// row click pushes the med ref onto the template's `meds` array.
let _medModalActiveTemplateId = null;

function _openMedModal(templateId) {
  _medModalActiveTemplateId = templateId;
  const modal = document.getElementById('medCatalogModal');
  const search = document.getElementById('medCatalogSearch');
  if (!modal) return;
  modal.style.display = '';
  if (search) { search.value = ''; setTimeout(() => search.focus(), 30); }
  _renderMedModalList('');
}

function _closeMedModal() {
  _medModalActiveTemplateId = null;
  const modal = document.getElementById('medCatalogModal');
  if (modal) modal.style.display = 'none';
}

async function _renderMedModalList(query) {
  const list = document.getElementById('medCatalogList');
  if (!list) return;
  while (list.firstChild) list.removeChild(list.firstChild);

  const loading = document.createElement('div');
  loading.className = 'med-catalog-empty';
  loading.textContent = 'Carregando catálogo...';
  list.appendChild(loading);

  const payload = await _getMedCatalog();
  const flat = _flattenCatalog(payload);
  const q = String(query || '').trim().toLowerCase();
  const matches = q
    ? flat.filter((m) => {
        const hay = ((m.name || '') + ' ' + (m.category || '')).toLowerCase();
        return hay.indexOf(q) !== -1;
      })
    : flat;

  while (list.firstChild) list.removeChild(list.firstChild);

  if (payload._fallback) {
    const banner = document.createElement('div');
    banner.className = 'med-catalog-fallback';
    banner.textContent = '⚠ Catálogo offline — nomes apenas. As doses serão calculadas ao aplicar o modelo no paciente.';
    list.appendChild(banner);
  }

  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'med-catalog-empty';
    empty.textContent = q ? 'Nenhum resultado para "' + q + '"' : 'Catálogo vazio';
    list.appendChild(empty);
    return;
  }

  matches.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'med-catalog-item';
    row.dataset.medId = m.id;

    const nameRow = document.createElement('div');
    nameRow.className = 'med-catalog-name';
    const nm = document.createElement('span');
    nm.textContent = m.name || m.id;
    const cat = document.createElement('span');
    cat.className = 'med-catalog-cat';
    cat.textContent = (m._kind || (m.is_adult ? 'ADULTO' : 'PED')) + ' · ' + (_CATEGORY_LABEL[m.category] || m.category || '—');
    nameRow.appendChild(nm);
    nameRow.appendChild(cat);

    const detail = document.createElement('div');
    detail.className = 'med-catalog-detail';
    const parts = [];
    if (m.practical) parts.push(m.practical);
    if (m.frequency) parts.push(m.frequency);
    if (m.duration) parts.push(m.duration);
    detail.textContent = parts.join(' · ') || '—';

    row.appendChild(nameRow);
    row.appendChild(detail);
    row.addEventListener('click', () => _addMedToTemplate(_medModalActiveTemplateId, m.id));
    list.appendChild(row);
  });
}

function _addMedToTemplate(templateId, medId) {
  if (!templateId || !medId) return;
  const target = rxTemplates.find((t) => t.id === templateId);
  if (!target) return;
  if (!Array.isArray(target.meds)) target.meds = [];
  // Empty defaults — doctor fills in per-template overrides if needed; otherwise
  // catalog defaults (frequency/duration) apply at render time.
  target.meds.push({ medId: medId, dose: '', freq: '', duration: '', when: '', notes: '' });
  saveRxTemplatesDebounced();
  _closeMedModal();
  renderRxTemplates();
}

function _removeMedFromTemplate(templateId, medIdx) {
  const target = rxTemplates.find((t) => t.id === templateId);
  if (!target || !Array.isArray(target.meds)) return;
  if (medIdx < 0 || medIdx >= target.meds.length) return;
  target.meds.splice(medIdx, 1);
  saveRxTemplatesDebounced();
  renderRxTemplates();
}

function _wireMedModal() {
  const close = document.getElementById('medCatalogClose');
  const search = document.getElementById('medCatalogSearch');
  const modal = document.getElementById('medCatalogModal');
  if (close) close.addEventListener('click', _closeMedModal);
  if (modal) modal.addEventListener('click', (e) => {
    // Click on backdrop (the modal element itself) closes; clicks inside
    // .med-catalog-content bubble up but stop here (we check target).
    if (e.target === modal) _closeMedModal();
  });
  if (search) {
    let t = null;
    search.addEventListener('input', () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => _renderMedModalList(search.value), 120);
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && modal.style.display !== 'none') _closeMedModal();
  });
}

let rxTemplates = [];
let rxSaveTimer = null;
// Tracks all document.click listeners added by renderRxTemplates() for the
// inline-search outside-click dismissal. Aborted and recreated on every
// render so stale handlers from prior renders do not accumulate.
let _rxOutsideClickAC = null;

function loadRxTemplates() {
  // Phase 03-03: templates live in the per-user userConfig fetched from the
  // backend, not chrome.storage.sync. The legacy v3.1 hard-migration logic
  // (_rxV31Migrated) is unnecessary now: the user-config-client wipes the
  // legacy chrome.storage.sync.prescriptionTemplates after the first authed
  // hydrate, and the server lazy-seeds DEFAULT_RX_TEMPLATES on the user's
  // first GET /api/me/config. So legacy data can't survive the migration.
  const uc = window.TOCAFICHADR_userConfig;
  if (!uc) {
    rxTemplates = [];
    renderRxTemplates();
    return;
  }
  // Subscribe to live updates (sign-in hydrate, side-panel edits, server
  // PATCH responses). Listener idempotency-guarded by uc itself.
  uc.onChange((cfg) => {
    if (cfg && Array.isArray(cfg.rx_templates)) {
      rxTemplates = cfg.rx_templates.slice();
      renderRxTemplates();
    }
  });
  uc.getCached().then((cfg) => {
    const raw = Array.isArray(cfg && cfg.rx_templates) ? cfg.rx_templates : [];
    let mutated = false;
    rxTemplates = raw.map((t) => {
      if (!t.id) { t.id = _genId(); mutated = true; }
      if (t.diagnosis === undefined) { mutated = true; return _migrateLegacyTemplate(t); }
      return t;
    });
    if (mutated) saveRxTemplatesDebounced();
    renderRxTemplates();
  }).catch(() => {
    // getCached() failed (IndexedDB unavailable, auth error, etc.) — render
    // the empty grid with defaults so the UI doesn't stay silently blank.
    renderRxTemplates();
  });
}

function _genId() {
  return "tpl-" + Math.random().toString(36).slice(2, 10);
}

function _showTemplateSaveError(msg) {
  const el = document.getElementById("rx-save-error");
  if (!el) return;
  el.textContent = "Erro ao salvar: " + msg + " — reduza o tamanho dos modelos ou remova alguns.";
}

function _clearTemplateSaveError() {
  const el = document.getElementById("rx-save-error");
  if (!el) return;
  el.textContent = "";
}

function saveRxTemplatesDebounced() {
  // Phase 03-03: write through to /api/me/config via the user-config client.
  // The client itself debounces by 400ms, so we just call patch() — duplicate
  // saves coalesce. Local debouncing is removed (rxSaveTimer kept as null
  // for backwards-compat with any external code that checks it).
  if (rxSaveTimer) { clearTimeout(rxSaveTimer); rxSaveTimer = null; }
  const uc = window.TOCAFICHADR_userConfig;
  if (!uc) {
    _showTemplateSaveError("config offline — recarregue a extensão");
    return;
  }
  uc.patch({ rx_templates: rxTemplates });
  _clearTemplateSaveError();
}

function renderRxTemplates() {
  const list = document.getElementById("rxTemplatesList");
  if (!list) return;
  // Cancel all outside-click handlers from the previous render so they
  // don't pile up unboundedly (one per template per render cycle).
  if (_rxOutsideClickAC) _rxOutsideClickAC.abort();
  _rxOutsideClickAC = new AbortController();
  while (list.firstChild) list.removeChild(list.firstChild);

  // v3.4.0 — populate med-id → name lookup once per render (cheap if cached).
  let _flatCatalog = [];
  _getMedCatalog().then((payload) => {
    _flatCatalog = _flattenCatalog(payload);
    // Re-paint just the med pill names in case the catalog landed late.
    list.querySelectorAll('.rx-b-med-pill').forEach((pill) => {
      const id = pill.dataset.medId;
      const m = _findMedInFlat(id, _flatCatalog);
      const nameEl = pill.querySelector('.rx-b-med-name');
      if (nameEl && m) nameEl.textContent = '💊 ' + (m.name || id);
    });
  }).catch(() => {});

  function _previewSubtitle(tpl) {
    const meds = Array.isArray(tpl.meds) ? tpl.meds : [];
    if (!meds.length) return 'Adicione uma medicação';
    const hasOverride = meds.some((m) => m && (m.dose || m.freq || m.duration));
    if (meds.length > 1) {
      const maxDur = meds.map((m) => m.duration).filter(Boolean).sort((a, b) => b.length - a.length)[0];
      return meds.length + ' medicações' + (maxDur ? ' · ' + maxDur : '');
    }
    return hasOverride ? '1 medicação · override' : 'dose auto pelo peso';
  }

  rxTemplates.forEach((tpl) => {
    const card = document.createElement("div");
    card.className = "rx-card-b";
    card.dataset.tplId = tpl.id;
    const isSmart = _isSmartTemplate(tpl);

    // ══ Left column: live preview ══
    const previewCol = document.createElement("div");
    previewCol.className = "rx-b-preview-col";

    const previewLabel = document.createElement("div");
    previewLabel.className = "rx-b-preview-label";
    previewLabel.textContent = "Como aparece no grid";

    const previewPill = document.createElement("div");
    previewPill.className = "rx-b-preview-pill";

    const previewName = document.createElement("span");
    previewName.className = "rx-b-preview-name";
    previewName.textContent = (tpl.diagnosis || 'Nova receita').trim();

    const previewSub = document.createElement("span");
    previewSub.className = "rx-b-preview-sub";
    previewSub.textContent = _previewSubtitle(tpl);

    previewPill.appendChild(previewName);
    previewPill.appendChild(previewSub);

    const previewHint = document.createElement("div");
    previewHint.className = "rx-b-preview-hint";
    if (!isSmart) {
      previewHint.textContent = "💡 Adicione uma medicação para ativar o cálculo automático.";
    } else {
      const hasOverride = tpl.meds && tpl.meds.some((m) => m && (m.dose || m.freq || m.duration));
      previewHint.textContent = hasOverride
        ? "⚠ Override ativo — catálogo será ignorado."
        : "💡 Dose será calculada pelo peso no momento de clicar.";
    }

    previewCol.appendChild(previewLabel);
    previewCol.appendChild(previewPill);
    previewCol.appendChild(previewHint);

    // ══ Right column: editor ══
    const editorCol = document.createElement("div");
    editorCol.className = "rx-b-editor-col";

    // Name row
    const nameRow = document.createElement("div");
    nameRow.className = "rx-b-name-row";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "input";
    nameInput.placeholder = "Nome da receita";
    nameInput.value = tpl.diagnosis || "";
    nameInput.addEventListener("input", () => {
      const target = rxTemplates.find((t) => t.id === tpl.id);
      if (target) {
        target.diagnosis = nameInput.value;
        saveRxTemplatesDebounced();
        previewName.textContent = (nameInput.value || 'Nova receita').trim();
        previewSub.textContent = _previewSubtitle(target);
      }
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "test-btn";
    removeBtn.textContent = "×";
    removeBtn.title = "Remover modelo";
    removeBtn.style.cssText = "padding:4px 10px;font-size:14px;";
    removeBtn.addEventListener("click", () => {
      const i = rxTemplates.findIndex((t) => t.id === tpl.id);
      if (i !== -1) { rxTemplates.splice(i, 1); saveRxTemplatesDebounced(); renderRxTemplates(); }
    });

    nameRow.appendChild(nameInput);
    nameRow.appendChild(removeBtn);
    editorCol.appendChild(nameRow);

    // Medication pills
    if (Array.isArray(tpl.meds) && tpl.meds.length) {
      const pillsWrap = document.createElement("div");
      pillsWrap.className = "rx-b-pills-wrap";
      tpl.meds.forEach((m, idx) => {
        const cached = m.medId ? _findMedInFlat(m.medId, _flatCatalog) : null;
        const medLabel = (cached && cached.name) || m.name || m.manualName || m.medId || 'Medicação';
        const hasOverride = !!(m.dose || m.freq || m.duration);

        const pill = document.createElement("div");
        pill.className = "rx-b-med-pill";
        pill.dataset.medId = m.medId || '';

        const nameSpan = document.createElement("span");
        nameSpan.className = "rx-b-med-name";
        nameSpan.textContent = '💊 ' + medLabel;

        const badge = document.createElement("span");
        badge.className = "rx-b-med-badge" + (hasOverride ? " rx-b-med-badge-override" : "");
        badge.textContent = hasOverride ? "override" : "dose auto";

        const xBtn = document.createElement("button");
        xBtn.type = "button";
        xBtn.className = "rx-b-med-x";
        xBtn.textContent = '×';
        xBtn.title = 'Remover medicação';
        xBtn.addEventListener('click', () => _removeMedFromTemplate(tpl.id, idx));

        pill.appendChild(nameSpan);
        pill.appendChild(badge);
        pill.appendChild(xBtn);
        pillsWrap.appendChild(pill);
      });
      editorCol.appendChild(pillsWrap);
    }

    // Inline search
    const searchWrap = document.createElement("div");
    searchWrap.className = "rx-b-search-wrap";
    searchWrap.style.position = "relative";

    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.className = "rx-b-search-input input";
    searchInput.placeholder = isSmart ? "Buscar medicação no catálogo…" : "Buscar medicação para ativar…";

    const dropdown = document.createElement("div");
    dropdown.className = "rx-b-search-dropdown";
    dropdown.style.display = "none";

    let searchTimer = null;
    searchInput.addEventListener("input", () => {
      const q = searchInput.value.trim().toLowerCase();
      if (!q) { dropdown.style.display = "none"; return; }
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        const payload = await _getMedCatalog();
        const flat = _flattenCatalog(payload);
        const matches = flat.filter((m) => {
          const hay = ((m.name || '') + ' ' + (m.category || '')).toLowerCase();
          return hay.indexOf(q) !== -1;
        }).slice(0, 6);

        while (dropdown.firstChild) dropdown.removeChild(dropdown.firstChild);

        if (!matches.length) {
          const empty = document.createElement("div");
          empty.className = "rx-b-search-empty";
          empty.textContent = "Nenhum resultado";
          dropdown.appendChild(empty);
        } else {
          matches.forEach((m) => {
            const item = document.createElement("div");
            item.className = "rx-b-search-item";
            item.dataset.medId = m.id;

            const nameRowEl = document.createElement("div");
            nameRowEl.className = "rx-b-search-item-name";
            nameRowEl.textContent = m.name || m.id;

            const detailRow = document.createElement("div");
            detailRow.className = "rx-b-search-item-detail";
            const parts = [];
            if (m.practical) parts.push(m.practical);
            if (m.frequency) parts.push(m.frequency);
            const kindLabel = m.is_adult ? "ADULTO" : "PED";
            detailRow.textContent = kindLabel + " · " + (m.category || "—") + (parts.length ? " · " + parts.join(" · ") : "");

            item.appendChild(nameRowEl);
            item.appendChild(detailRow);
            item.addEventListener("click", () => {
              _addMedToTemplate(tpl.id, m.id);
              dropdown.style.display = "none";
              searchInput.value = "";
            });
            dropdown.appendChild(item);
          });
        }
        dropdown.style.display = "block";
      }, 120);
    });

    // Close dropdown on outside click. Use the render-cycle AbortController
    // signal so this handler is automatically removed when renderRxTemplates()
    // is next called (prevents unbounded listener accumulation).
    document.addEventListener("click", (e) => {
      if (!searchWrap.contains(e.target)) dropdown.style.display = "none";
    }, { signal: _rxOutsideClickAC.signal });

    searchWrap.appendChild(searchInput);
    searchWrap.appendChild(dropdown);
    editorCol.appendChild(searchWrap);

    // Collapsible: override
    if (isSmart && tpl.meds && tpl.meds.length) {
      const overrideDetails = document.createElement("details");
      overrideDetails.className = "rx-b-override";

      const overrideSummary = document.createElement("summary");
      overrideSummary.textContent = "Ajustes manuais (override do catálogo)";
      overrideDetails.appendChild(overrideSummary);

      const overrideGrid = document.createElement("div");
      overrideGrid.className = "rx-b-override-grid";

      tpl.meds.forEach((m, idx) => {
        const cached = m.medId ? _findMedInFlat(m.medId, _flatCatalog) : null;
        const medLabel = (cached && cached.name) || m.name || m.manualName || m.medId || 'Med';

        const medLabelEl = document.createElement("div");
        medLabelEl.style.cssText = "font-size:11px;color:#888;margin-top:8px;";
        medLabelEl.textContent = medLabel;
        overrideGrid.appendChild(medLabelEl);

        const medOverrideRow = document.createElement("div");
        medOverrideRow.style.cssText = "display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;";

        const doseIn = document.createElement("input");
        doseIn.className = "input";
        doseIn.style.cssText = "font-size:12px;padding:6px;";
        doseIn.placeholder = "Dose";
        doseIn.value = m.dose || "";
        doseIn.addEventListener("input", () => {
          const t = rxTemplates.find((x) => x.id === tpl.id);
          if (t && t.meds && t.meds[idx]) { t.meds[idx].dose = doseIn.value; saveRxTemplatesDebounced(); }
        });

        const freqIn = document.createElement("input");
        freqIn.className = "input";
        freqIn.style.cssText = "font-size:12px;padding:6px;";
        freqIn.placeholder = "Frequência";
        freqIn.value = m.freq || "";
        freqIn.addEventListener("input", () => {
          const t = rxTemplates.find((x) => x.id === tpl.id);
          if (t && t.meds && t.meds[idx]) { t.meds[idx].freq = freqIn.value; saveRxTemplatesDebounced(); }
        });

        const durIn = document.createElement("input");
        durIn.className = "input";
        durIn.style.cssText = "font-size:12px;padding:6px;";
        durIn.placeholder = "Duração";
        durIn.value = m.duration || "";
        durIn.addEventListener("input", () => {
          const t = rxTemplates.find((x) => x.id === tpl.id);
          if (t && t.meds && t.meds[idx]) { t.meds[idx].duration = durIn.value; saveRxTemplatesDebounced(); }
        });

        medOverrideRow.appendChild(doseIn);
        medOverrideRow.appendChild(freqIn);
        medOverrideRow.appendChild(durIn);
        overrideGrid.appendChild(medOverrideRow);
      });

      const overrideWarn = document.createElement("div");
      overrideWarn.style.cssText = "margin-top:8px;font-size:11px;color:#f59e0b;";
      overrideWarn.textContent = "⚠ Só preencha se quiser ignorar a dose calculada automaticamente pelo peso.";
      overrideGrid.appendChild(overrideWarn);

      overrideDetails.appendChild(overrideGrid);
      editorCol.appendChild(overrideDetails);
    }

    // Collapsible: extra text
    if (isSmart) {
      const extraDetails = document.createElement("details");
      extraDetails.className = "rx-b-extra";

      const extraSummary = document.createElement("summary");
      extraSummary.textContent = "Texto extra & variáveis";
      extraDetails.appendChild(extraSummary);

      const extraArea = document.createElement("textarea");
      extraArea.className = "textarea rx-tpl-extra";
      extraArea.placeholder = "Texto adicional (use ${weight}, ${age}, ${patient_name})";
      extraArea.rows = 2;
      extraArea.value = tpl.extraText || "";
      extraArea.style.minHeight = "54px";
      extraArea.addEventListener("input", () => {
        const target = rxTemplates.find((t) => t.id === tpl.id);
        if (target) { target.extraText = extraArea.value; saveRxTemplatesDebounced(); }
      });

      const hint = document.createElement("small");
      hint.className = "rx-tpl-vars-hint";
      hint.textContent = "Variáveis: ${weight} · ${age} · ${patient_name}";

      extraDetails.appendChild(extraArea);
      extraDetails.appendChild(hint);
      editorCol.appendChild(extraDetails);
    }

    card.appendChild(previewCol);
    card.appendChild(editorCol);
    list.appendChild(card);
  });
}
// "Restaurar padrões" — replace current shortcuts with the seeded medication
// defaults. Confirm before clobbering existing user edits.
const restoreRxDefaultsBtn = document.getElementById("restoreRxDefaultsBtn");
if (restoreRxDefaultsBtn) {
  restoreRxDefaultsBtn.addEventListener("click", () => {
    const hasCustom = JSON.stringify(rxTemplates || []) !== JSON.stringify(DEFAULT_RX_TEMPLATES);
    if (hasCustom && !window.confirm("Substituir os modelos atuais pelos padrões? Modelos editados serão perdidos.")) {
      return;
    }
    rxTemplates = _cloneDefaultRxTemplates();
    saveRxTemplatesDebounced();
    renderRxTemplates();
  });
}

const addRxTemplateBtn = document.getElementById("addRxTemplateBtn");
if (addRxTemplateBtn) {
  addRxTemplateBtn.addEventListener("click", () => {
    const newId = "tpl_" + Date.now();
    rxTemplates.push({ id: newId, diagnosis: "", ageBand: "", body: "", frequency: 0, meds: [], extraText: "" });
    saveRxTemplatesDebounced();
    renderRxTemplates();
  });
}

loadRxTemplates();
_wireMedModal();
// Warm the catalog cache in the background so the first "+ Adicionar
// medicação" click renders instantly. Failure is silent — modal falls back
// to the static list on demand.
_getMedCatalog().catch(() => {});

// ---------------------------------------------------------------------------
// v3.1 idea #6: Time-saved analytics tile
// ---------------------------------------------------------------------------
// Reads chrome.storage.local.usageStats — schema:
//   { '2026-05-04': { transcribe: 5, rxClick: 4, finalize: 5 }, ... }
// Computes "minutos poupados" = transcribe*4 + rxClick*1.5 + finalize*1.5.
// Renders today's number, a 7-day sparkline, and a trend vs last week's avg.
const SAVED_PER_TRANSCRIBE = 4.0;
const SAVED_PER_RX = 1.5;
const SAVED_PER_FINALIZE = 1.5;

function _todayDateKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function _dayMinutes(day) {
  if (!day) return 0;
  return (day.transcribe || 0) * SAVED_PER_TRANSCRIBE
       + (day.rxClick    || 0) * SAVED_PER_RX
       + (day.finalize   || 0) * SAVED_PER_FINALIZE;
}
function _last7Keys() {
  const keys = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    keys.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
  }
  return keys;
}

function renderPerfCard() {
  const valueEl   = document.getElementById('perfValue');
  const sparkEl   = document.getElementById('perfSpark');
  const trendEl   = document.getElementById('perfTrend');
  const footLeft  = document.getElementById('perfFootLeft');
  if (!valueEl || !sparkEl) return;

  chrome.storage.local.get(['usageStats'], (data) => {
    const stats = data.usageStats || {};
    const todayKey = _todayDateKey();
    const today = stats[todayKey] || {};
    const todayMins = _dayMinutes(today);
    const todayActions = (today.transcribe || 0) + (today.rxClick || 0) + (today.finalize || 0);

    valueEl.textContent = Math.round(todayMins);
    if (footLeft) footLeft.textContent = todayActions + (todayActions === 1 ? ' ação' : ' ações');

    // 7-day sparkline
    while (sparkEl.firstChild) sparkEl.removeChild(sparkEl.firstChild);
    const series = _last7Keys().map((k) => _dayMinutes(stats[k]));
    const max = Math.max(1, ...series);
    series.forEach((v, idx) => {
      const bar = document.createElement('div');
      bar.style.height = Math.max(3, Math.round((v / max) * 24)) + 'px';
      if (idx === series.length - 1) bar.classList.add('today');
      bar.title = _last7Keys()[idx] + ': ' + Math.round(v) + ' min';
      sparkEl.appendChild(bar);
    });

    // Trend vs week average (excluding today)
    if (trendEl) {
      const past = series.slice(0, -1);
      const past6 = past.length ? past.reduce((a, b) => a + b, 0) / past.length : 0;
      if (past6 < 1 && todayMins < 1) {
        trendEl.textContent = '';
      } else if (past6 < 1) {
        trendEl.textContent = '↗ novo';
      } else {
        const pct = Math.round(((todayMins - past6) / past6) * 100);
        if (pct >= 0) {
          trendEl.textContent = '↗ +' + pct + '%';
          trendEl.classList.remove('down');
        } else {
          trendEl.textContent = '↘ ' + pct + '%';
          trendEl.classList.add('down');
        }
      }
    }
  });
}

renderPerfCard();
// Re-render when stats change live (e.g. doctor records on the page → popup is open in another window)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.usageStats) renderPerfCard();
});

// ---------------------------------------------------------------------------
// v3.1 idea #8: SOAP voices — built-in + personal
// ---------------------------------------------------------------------------
// Schema:
//   chrome.storage.sync.soapVoices = [
//     { id, name, builtin?, verbosity, perspective, emphases[], customRules, fewShots[] }
//   ]
//   chrome.storage.sync.activeSoapVoiceId = id
//
// Built-in voices ship with verbosity=curto/medio/longo. Personal voices
// can override every field including few-shot examples (highest leverage).
const BUILTIN_VOICES = [
  {
    id: "voice_conciso", name: "Conciso", builtin: true,
    verbosity: "curto", perspective: "impessoal", emphases: [],
    customRules: "1-2 frases por seção. Sem repetir dados óbvios.", fewShots: [],
  },
  {
    id: "voice_padrao", name: "Padrão", builtin: true,
    verbosity: "medio", perspective: "impessoal", emphases: [],
    customRules: "Cobertura clínica completa, sem prolixidade.", fewShots: [],
  },
  {
    id: "voice_detalhado", name: "Detalhado", builtin: true,
    verbosity: "longo", perspective: "impessoal", emphases: ["sinais-vitais", "contexto-social"],
    customRules: "Inclua contexto familiar/social e detalhamento de sinais vitais.", fewShots: [],
  },
];

let soapVoices = [];
let activeSoapVoiceId = "voice_padrao";
let voiceSaveTimer = null;

// Phase 03-03b: voices live in the per-user userConfig (server-backed).
// Personal voices are persisted; built-ins are reconstructed client-side.
function loadVoices() {
  const uc = window.TOCAFICHADR_userConfig;
  if (!uc) {
    soapVoices = BUILTIN_VOICES.slice();
    activeSoapVoiceId = "voice_padrao";
    renderVoices();
    return;
  }
  // Subscribe so sign-in hydrate + cross-context edits reflect here.
  uc.onChange((cfg) => _applyVoicesFromConfig(cfg));
  uc.getCached().then(_applyVoicesFromConfig).catch(() => {
    // getCached() failed — fall back to built-in voices so the list isn't blank.
    soapVoices = BUILTIN_VOICES.slice();
    renderVoices();
  });
}

function _applyVoicesFromConfig(cfg) {
  const stored = (cfg && Array.isArray(cfg.voices)) ? cfg.voices : [];
  const personalVoices = stored.filter((v) => !v.builtin);
  soapVoices = [...BUILTIN_VOICES, ...personalVoices];
  activeSoapVoiceId = (cfg && cfg.active_voice_id) || "voice_padrao";
  if (!soapVoices.find((v) => v.id === activeSoapVoiceId)) {
    activeSoapVoiceId = "voice_padrao";
  }
  renderVoices();
}

function saveVoicesDebounced() {
  // The user-config-client debounces by 400ms internally; voiceSaveTimer is
  // kept null for backwards-compat with any external code that might check it.
  if (voiceSaveTimer) { clearTimeout(voiceSaveTimer); voiceSaveTimer = null; }
  const uc = window.TOCAFICHADR_userConfig;
  if (!uc) return;
  // Persist personal voices only — builtins are reconstructed on load.
  const personal = soapVoices.filter((v) => !v.builtin);
  uc.patch({ voices: personal, active_voice_id: activeSoapVoiceId });
}

function renderVoices() {
  const list = document.getElementById("voicesList");
  if (!list) return;
  while (list.firstChild) list.removeChild(list.firstChild);

  soapVoices.forEach((voice) => {
    const card = document.createElement("div");
    const isActive = voice.id === activeSoapVoiceId;
    card.style.cssText = "background:" + (isActive ? "rgba(16,185,129,0.06)" : "#111")
      + ";border:1px solid " + (isActive ? "#10b981" : "#1f1f1f")
      + ";border-radius:7px;padding:9px 11px;cursor:pointer;display:flex;flex-direction:column;gap:2px;position:relative;";

    const name = document.createElement("div");
    name.style.cssText = "font-size:12px;font-weight:700;color:#ddd;";
    name.textContent = voice.name + (isActive ? " ✓" : "");
    card.appendChild(name);

    const sub = document.createElement("div");
    sub.style.cssText = "font-size:10px;color:#666;";
    sub.textContent = (voice.builtin ? "Padrão · " : "Pessoal · ")
      + voice.verbosity + (voice.fewShots && voice.fewShots.length ? " · " + voice.fewShots.length + " ex" : "");
    card.appendChild(sub);

    card.addEventListener("click", (ev) => {
      if (ev.target.tagName === "BUTTON") return;
      activeSoapVoiceId = voice.id;
      saveVoicesDebounced();
      renderVoices();
    });

    if (!voice.builtin) {
      const btnRow = document.createElement("div");
      btnRow.style.cssText = "position:absolute;top:7px;right:7px;display:flex;gap:4px;";

      const editBtn = document.createElement("button");
      editBtn.className = "test-btn";
      editBtn.style.cssText = "padding:2px 8px;font-size:10px;";
      editBtn.textContent = "Editar";
      editBtn.addEventListener("click", (e) => { e.stopPropagation(); openVoiceEditor(voice.id); });
      btnRow.appendChild(editBtn);

      const delBtn = document.createElement("button");
      delBtn.className = "test-btn";
      delBtn.style.cssText = "padding:2px 8px;font-size:10px;";
      delBtn.textContent = "×";
      delBtn.title = "Remover voz";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!confirm("Remover esta voz?")) return;
        const i = soapVoices.findIndex((v) => v.id === voice.id);
        if (i !== -1) {
          soapVoices.splice(i, 1);
          if (activeSoapVoiceId === voice.id) activeSoapVoiceId = "voice_padrao";
          saveVoicesDebounced();
          renderVoices();
        }
      });
      btnRow.appendChild(delBtn);
      card.appendChild(btnRow);
    }

    list.appendChild(card);
  });
}

function openVoiceEditor(voiceId) {
  const voice = soapVoices.find((v) => v.id === voiceId);
  if (!voice) return;

  // Modal-style inline editor — replaces the voice card with form rows.
  const list = document.getElementById("voicesList");
  if (!list) return;

  // Find and replace this voice's card.
  const editor = document.createElement("div");
  editor.style.cssText = "background:#0d0d0d;border:1px solid #10b981;border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px;";

  const titleRow = document.createElement("div");
  titleRow.style.cssText = "display:flex;justify-content:space-between;align-items:center;";
  const title = document.createElement("div");
  title.style.cssText = "font-size:12px;font-weight:700;color:#10b981;";
  title.textContent = "Editar voz";
  const closeBtn = document.createElement("button");
  closeBtn.className = "test-btn";
  closeBtn.style.cssText = "padding:3px 10px;font-size:10px;";
  closeBtn.textContent = "Concluir";
  closeBtn.addEventListener("click", () => { saveVoicesDebounced(); renderVoices(); });
  titleRow.appendChild(title); titleRow.appendChild(closeBtn);
  editor.appendChild(titleRow);

  // Name
  const nameLbl = document.createElement("div");
  nameLbl.className = "label"; nameLbl.textContent = "Nome";
  editor.appendChild(nameLbl);
  const nameIn = document.createElement("input");
  nameIn.className = "input"; nameIn.value = voice.name;
  nameIn.addEventListener("input", () => { voice.name = nameIn.value; saveVoicesDebounced(); });
  editor.appendChild(nameIn);

  // Verbosity radio
  const verbLbl = document.createElement("div");
  verbLbl.className = "label"; verbLbl.textContent = "Verbosidade";
  editor.appendChild(verbLbl);
  const verbRow = document.createElement("div");
  verbRow.style.cssText = "display:flex;gap:6px;";
  ["curto", "medio", "longo"].forEach((v) => {
    const lbl = document.createElement("label");
    lbl.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;font-size:11px;color:#888;";
    const r = document.createElement("input");
    r.type = "radio"; r.name = "verb_" + voice.id; r.value = v;
    r.checked = voice.verbosity === v; r.style.accentColor = "#10b981";
    r.addEventListener("change", () => { voice.verbosity = v; saveVoicesDebounced(); });
    lbl.appendChild(r); lbl.appendChild(document.createTextNode(v));
    verbRow.appendChild(lbl);
  });
  editor.appendChild(verbRow);

  // Perspective radio
  const persLbl = document.createElement("div");
  persLbl.className = "label"; persLbl.textContent = "Perspectiva";
  editor.appendChild(persLbl);
  const persRow = document.createElement("div");
  persRow.style.cssText = "display:flex;gap:6px;";
  [["1a", "1ª pessoa"], ["3a", "3ª pessoa"], ["impessoal", "Impessoal"]].forEach(([val, txt]) => {
    const lbl = document.createElement("label");
    lbl.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;font-size:11px;color:#888;";
    const r = document.createElement("input");
    r.type = "radio"; r.name = "pers_" + voice.id; r.value = val;
    r.checked = voice.perspective === val; r.style.accentColor = "#10b981";
    r.addEventListener("change", () => { voice.perspective = val; saveVoicesDebounced(); });
    lbl.appendChild(r); lbl.appendChild(document.createTextNode(txt));
    persRow.appendChild(lbl);
  });
  editor.appendChild(persRow);

  // Custom rules textarea
  const rulesLbl = document.createElement("div");
  rulesLbl.className = "label"; rulesLbl.textContent = "Regras pessoais";
  editor.appendChild(rulesLbl);
  const rules = document.createElement("textarea");
  rules.className = "textarea"; rules.value = voice.customRules || "";
  rules.placeholder = "Ex: Sempre incluir escala de dor 0-10. Em casos crônicos, mencionar adesão.";
  rules.addEventListener("input", () => { voice.customRules = rules.value; saveVoicesDebounced(); });
  editor.appendChild(rules);

  // Few-shots — most powerful personalization
  const fsLbl = document.createElement("div");
  fsLbl.className = "label"; fsLbl.textContent = "Exemplos (poderoso — o GPT mimetiza seu estilo)";
  editor.appendChild(fsLbl);
  const fsHint = document.createElement("div");
  fsHint.className = "hint";
  fsHint.textContent = "Cole 1-3 SOAPs reais que você gostou — o modelo aprende seu padrão de escrita.";
  editor.appendChild(fsHint);
  const fsList = document.createElement("div");
  fsList.style.cssText = "display:flex;flex-direction:column;gap:8px;";
  voice.fewShots = voice.fewShots || [];

  function renderFewShots() {
    while (fsList.firstChild) fsList.removeChild(fsList.firstChild);
    voice.fewShots.forEach((ex, idx) => {
      const card = document.createElement("div");
      card.style.cssText = "background:#161616;border:1px solid #1f1f1f;border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:5px;";
      const cIn = document.createElement("input");
      cIn.className = "input";
      cIn.placeholder = "Queixa principal (ex: 'tosse há 3 dias')";
      cIn.value = ex.complaint || "";
      cIn.addEventListener("input", () => { ex.complaint = cIn.value; saveVoicesDebounced(); });
      const oIn = document.createElement("textarea");
      oIn.className = "textarea";
      oIn.placeholder = "SOAP no SEU estilo (S/O/A/P)...";
      oIn.value = ex.output || "";
      oIn.style.minHeight = "60px";
      oIn.addEventListener("input", () => { ex.output = oIn.value; saveVoicesDebounced(); });
      const rmBtn = document.createElement("button");
      rmBtn.className = "test-btn";
      rmBtn.style.cssText = "align-self:flex-end;padding:2px 8px;font-size:10px;";
      rmBtn.textContent = "Remover exemplo";
      rmBtn.addEventListener("click", () => {
        voice.fewShots.splice(idx, 1); saveVoicesDebounced(); renderFewShots();
      });
      card.appendChild(cIn); card.appendChild(oIn); card.appendChild(rmBtn);
      fsList.appendChild(card);
    });
    if (voice.fewShots.length < 3) {
      const addBtn = document.createElement("button");
      addBtn.className = "test-btn"; addBtn.textContent = "+ Adicionar exemplo";
      addBtn.style.cssText = "width:100%;";
      addBtn.addEventListener("click", () => {
        voice.fewShots.push({ complaint: "", output: "" });
        saveVoicesDebounced(); renderFewShots();
      });
      fsList.appendChild(addBtn);
    }
  }
  renderFewShots();
  editor.appendChild(fsList);

  // Replace list with editor temporarily
  while (list.firstChild) list.removeChild(list.firstChild);
  list.appendChild(editor);
}

const addVoiceBtn = document.getElementById("addVoiceBtn");
if (addVoiceBtn) {
  addVoiceBtn.addEventListener("click", () => {
    const id = "voice_" + Date.now();
    const v = {
      id, name: "Minha voz", verbosity: "medio", perspective: "impessoal",
      emphases: [], customRules: "", fewShots: [],
    };
    soapVoices.push(v);
    activeSoapVoiceId = id;
    saveVoicesDebounced();
    openVoiceEditor(id);
  });
}
loadVoices();

// --- Save settings ---
const saveBtn = document.getElementById("saveBtn");
if (saveBtn) {
  saveBtn.addEventListener("click", () => {
    // Phase 03-03b: split infra vs personal. Infra (apiBaseUrl, backendMode)
    // stays in chrome.storage.sync. Personal fields go through userConfig.
    const mode = document.getElementById("modeCloud")?.checked ? "cloud" : "local";
    const localUrl = document.getElementById("apiBaseUrl")?.value?.trim() || LOCAL_URL;
    // Reject a malformed local backend URL BEFORE persisting it — otherwise it
    // lands in storage.sync and bricks every API call until the user notices.
    if (mode !== "cloud" && !_isValidBackendUrl(localUrl)) {
      const status = document.getElementById("status");
      if (status) {
        status.textContent = "URL do backend invalida — verifique o endereco";
        setTimeout(() => { status.textContent = ""; }, 3000);
      }
      return; // do not persist a broken base URL
    }
    const infra = {
      backendMode: mode,
      apiBaseUrl: mode === "cloud" ? CLOUD_URL : localUrl,
    };
    const personal = {
      auto_clear_soap: document.getElementById("autoClearSoap")?.checked ?? true,
      auto_cid: document.getElementById("autoCid")?.checked ?? true,
      auto_fill_companion: document.getElementById("autoFillCompanion")?.checked ?? true,
      auto_prefill_encaminh: document.getElementById("autoPrefillEncaminh")?.checked ?? true,
      custom_instructions: document.getElementById("customInstructions")?.value?.trim() || "",
    };
    await chrome.storage.sync.set({ ...infra, testMode: document.getElementById("testMode")?.checked ?? false });
    if (window.TOCAFICHADR_userConfig) {
      window.TOCAFICHADR_userConfig.patch(personal);
    }
    const status = document.getElementById("status");
    if (status) { status.textContent = "Configuracoes salvas"; setTimeout(() => { status.textContent = ""; }, 2500); }
  });
}
