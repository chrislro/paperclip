"use strict";

window.TOCAFICHADR_api = (() => {
  // Use 127.0.0.1 explicitly — "localhost" on macOS resolves to ::1 (IPv6) first,
  // but Flask only listens on IPv4. Chrome's fetch() does not fall back to IPv4
  // when the IPv6 connection fails, resulting in "Failed to fetch".
  let apiBaseUrl = "https://api.tocafichadr.com.br";

  // _normalizeApiError is provided by shared/error-helpers.js (injected first via manifest content_scripts).
  let _authenticated = false;

  // Load saved settings
  if (chrome?.storage?.sync) {
    chrome.storage.sync.get(["apiBaseUrl"], (result) => {
      if (result.apiBaseUrl) apiBaseUrl = result.apiBaseUrl;
    });
  }
  // Presence-only check — we read whether a token exists, not the token itself.
  if (chrome?.storage?.local) {
    chrome.storage.local.get(["authToken"], (result) => {
      _authenticated = !!(result && result.authToken);
    });
  }

  function setBaseUrl(url) {
    apiBaseUrl = url.replace(/\/+$/, "");
  }

  function getBaseUrl() {
    return apiBaseUrl;
  }

  // CSO-009: decode JWT exp claim → Unix ms, for authTokenExpiry storage.
  function _jwtExp(jwt) {
    try {
      const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return (payload.exp || 0) * 1000;
    } catch (_) { return 0; }
  }

  function setToken(token) {
    _authenticated = !!token;
    if (chrome?.storage?.local) {
      chrome.storage.local.set({ authToken: token, authTokenExpiry: _jwtExp(token) });
    }
  }

  function clearToken() {
    _authenticated = false;
    if (chrome?.storage?.local) {
      chrome.storage.local.remove(["authToken", "authTokenExpiry", "refreshToken"]);
    }
  }

  function isAuthenticated() {
    return _authenticated;
  }

  async function request(path, options = {}) {
    const url = apiBaseUrl + path;
    const method = (options.method || "GET").toUpperCase();
    const headers = { ...(options.headers || {}) };

    let body = options.body;
    if (body && typeof body === "object" && !(body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }

    // Route through service worker. Content scripts on the HTTPS G-Hosp page
    // can't fetch() the HTTP backend directly — blocked by Mixed Content and
    // Private Network Access. The service worker's chrome-extension:// origin
    // is exempt from both. Transcribe, health, and audit already use dedicated
    // SW handlers; everything else goes through this generic proxy.
    if (!chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
      throw new Error("Extensão recarregada — recarregue esta página do G-Hosp (F5)");
    }
    const resp = await new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
          { type: "TOCAFICHADR_FETCH", url, method, headers, body },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message || "SW unreachable"));
              return;
            }
            if (!response) { reject(new Error("Empty SW response")); return; }
            resolve(response);
          }
        );
      } catch (err) {
        reject(err);
      }
    });

    if (!resp.ok) {
      throw new Error(_normalizeApiError("HTTP " + resp.status + ": " + (resp.text || "")));
    }
    // SW returns { ok, status, text }; parse JSON here
    try { return JSON.parse(resp.text); } catch { return resp.text; }
  }

  async function checkHealth() {
    // Route through service worker. Content script on HTTPS G-Hosp page is
    // blocked by Mixed Content + Private Network Access when fetching
    // http://100.116.133.83:5050 directly. Service worker (chrome-extension://
    // origin) is exempt from both.
    if (!chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
      return false;
    }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "TOCAFICHADR_HEALTH" }, (response) => {
          if (chrome.runtime.lastError) { resolve(false); return; }
          resolve(!!(response && response.ok));
        });
      } catch (_) {
        resolve(false);
      }
    });
  }

  async function transcribe(audioBlob, chiefComplaint, customInstructions, soapVoice) {
    // Route through the service worker instead of fetching directly.
    // Content scripts on an HTTPS page are a "public" origin — Chrome's Private
    // Network Access (PNA) policy blocks their POST requests to http://localhost
    // even when host_permissions covers the URL. The service worker has a
    // chrome-extension:// origin which Chrome classifies as "local", so it is
    // exempt from PNA checks and can reach the backend without interference.

    // chrome.runtime.sendMessage uses JSON serialisation, so convert Blob → base64.
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const comma = reader.result.indexOf(",");
        resolve(comma >= 0 ? reader.result.slice(comma + 1) : reader.result);
      };
      reader.onerror = () => reject(new Error("Falha ao ler audio"));
      reader.readAsDataURL(audioBlob);
    });

    // Guard against invalidated extension context. When the user reloads the
    // extension in chrome://extensions while this G-Hosp tab is open, the old
    // content script's `chrome.runtime` becomes undefined — next sendMessage
    // throws "Cannot read properties of undefined". Detect and surface a clear
    // action instead of a cryptic stack trace.
    if (!chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
      throw new Error("Extensão recarregada — recarregue esta página do G-Hosp (F5) para continuar");
    }

    var audioConfig = null;
    try {
      if (window.TOCAFICHADR_audio && typeof window.TOCAFICHADR_audio.getEffectiveAudioConfig === "function") {
        audioConfig = window.TOCAFICHADR_audio.getEffectiveAudioConfig();
      }
    } catch (_) {}

    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
          {
            type: "TOCAFICHADR_TRANSCRIBE",
            audioBase64: base64,
            mimeType: audioBlob.type || "audio/webm",
            audioConfig: audioConfig,
            chiefComplaint: chiefComplaint || "",
            customInstructions: customInstructions || "",
            // v3.1 idea #8: SOAP voice (verbosity / perspective / emphases / customRules / fewShots)
            soapVoice: soapVoice || null,
          },
          (response) => {
            // chrome.runtime may have become undefined between the call and the
            // callback if the extension was reloaded mid-flight.
            if (!chrome || !chrome.runtime) {
              reject(new Error("Extensão recarregada — recarregue esta página do G-Hosp (F5)"));
              return;
            }
            if (chrome.runtime.lastError) {
              const msg = chrome.runtime.lastError.message || "";
              if (msg.indexOf("context invalidated") !== -1 ||
                  msg.indexOf("Extension context") !== -1) {
                reject(new Error("Extensão recarregada — recarregue esta página do G-Hosp (F5)"));
              } else {
                reject(new Error(msg));
              }
              return;
            }
            if (response && response.__error) {
              reject(new Error(_normalizeApiError(response.__error)));
              return;
            }
            resolve(response);
          }
        );
      } catch (err) {
        // Synchronous throw (e.g. "Extension context invalidated")
        const msg = (err && err.message) || String(err);
        if (msg.indexOf("context invalidated") !== -1 ||
            msg.indexOf("Extension context") !== -1 ||
            msg.indexOf("undefined") !== -1) {
          reject(new Error("Extensão recarregada — recarregue esta página do G-Hosp (F5)"));
        } else {
          reject(err);
        }
      }
    });
  }

  async function suggestCid(soapText, complaint) {
    return request("/api/suggest-cid", {
      method: "POST",
      body: { soap_text: soapText, chief_complaint: complaint },
    });
  }

  async function formatSoap(rawText, complaint, customInstructions) {
    return request("/api/format-soap", {
      method: "POST",
      body: { raw_text: rawText, chief_complaint: complaint, custom_instructions: customInstructions },
    });
  }

  // v3.1 idea #3: streaming SOAP via SSE.
  // Opens a chrome.runtime.connect port to the SW, which proxies the SSE
  // request to /api/soap-stream and forwards each token as { type:"SOAP_TOKEN", t }.
  // The caller (HUD) renders tokens as they arrive — perceived latency drops
  // from "1.5-3s blank" to "~300ms to first token".
  //
  // Backend contract: POST /api/soap-stream with JSON body
  //   { raw_text, chief_complaint, custom_instructions, soap_voice }
  // returns text/event-stream with frames:
  //   data: {"t":"..."}\n\n
  //   data: [DONE]\n\n
  function streamSoap(rawText, complaint, customInstructions, soapVoice, onToken, onDone, onError) {
    if (!chrome || !chrome.runtime || typeof chrome.runtime.connect !== "function") {
      onError && onError(new Error("Extensão recarregada — recarregue a página (F5)"));
      return { close: function () {} };
    }
    var port;
    try {
      port = chrome.runtime.connect({ name: "TOCAFICHADR_SOAP_STREAM" });
    } catch (err) {
      onError && onError(err);
      return { close: function () {} };
    }
    var closed = false;
    port.onMessage.addListener(function (msg) {
      if (!msg) return;
      if (msg.type === "SOAP_TOKEN" && typeof msg.t === "string") onToken && onToken(msg.t);
      else if (msg.type === "SOAP_DONE") { closed = true; onDone && onDone(msg.full || "", msg); try { port.disconnect(); } catch (_) {} }
      else if (msg.type === "SOAP_ERROR") {
        closed = true;
        var streamError = new Error(msg.error || "stream failed");
        streamError.providers = msg.providers || null;
        streamError.timing = msg.timing || null;
        onError && onError(streamError);
        try { port.disconnect(); } catch (_) {}
      }
    });
    port.onDisconnect.addListener(function () {
      if (!closed) onError && onError(new Error("Conexão de streaming encerrada"));
    });
    try {
      port.postMessage({
        type: "SOAP_STREAM_START",
        raw_text: rawText || "",
        chief_complaint: complaint || "",
        custom_instructions: customInstructions || "",
        soap_voice: soapVoice || null,
      });
    } catch (err) {
      onError && onError(err);
    }
    return { close: function () { closed = true; try { port.disconnect(); } catch (_) {} } };
  }

  async function getSelectors(emr) {
    return request(`/api/selectors?emr=${encodeURIComponent(emr)}`);
  }

  async function getDosages(weight) {
    return request(`/api/dosages/full?weight=${encodeURIComponent(weight)}`);
  }

  async function logAudit(actionType, details) {
    // Route through service worker. Content script POST from HTTPS G-Hosp
    // page to HTTP backend is blocked by Mixed Content + PNA — silently.
    // Fire-and-forget: never throw, audit logging must not break UX.
    if (!chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
      return { ok: false };
    }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "TOCAFICHADR_AUDIT", actionType, details },
          (response) => {
            if (chrome.runtime.lastError) { resolve({ ok: false }); return; }
            resolve(response || { ok: false });
          }
        );
      } catch (_) {
        resolve({ ok: false });
      }
    });
  }

  // Report an error to the backend. Fire-and-forget, never throws.
  // Content scripts wrap important try/catch blocks with this so failures
  // surface in Flask's error log without crashing the UX.
  // NEVER include patient data (names, CPF, SOAP content) in `context`.
  function reportError(where, err, context) {
    if (!chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
      return;
    }
    try {
      chrome.runtime.sendMessage({
        type: "TOCAFICHADR_ERROR",
        where: String(where || "unknown").slice(0, 120),
        errorMessage: (err && err.message) || String(err || ""),
        stack: (err && err.stack) || "",
        context: context || {},
      }, () => { /* ignore response */ });
    } catch (_) {
      // Silent — error reporting must never cascade
    }
  }

  async function login(email, password) {
    const data = await request("/auth/login", {
      method: "POST",
      body: { email, password },
    });
    if (data.token) setToken(data.token);
    return data;
  }

  async function register(email, password, name) {
    const data = await request("/auth/register", {
      method: "POST",
      body: { email, password, name },
    });
    if (data.token) setToken(data.token);
    return data;
  }

  function logout() {
    clearToken();
  }

  async function getSubscription() {
    return request("/billing/subscription");
  }

  // Disarm the page-context `beforeunload` handler before we navigate. Chrome
  // forbids extensions from dismissing the resulting "Leave site?" modal once
  // it appears — the only way around it is to neutralize the handler BEFORE
  // navigation triggers. Content scripts can't reach the page's main world
  // directly, so this hops through the SW which calls
  // `chrome.scripting.executeScript({ world: 'MAIN' })`. Best-effort: a 1.5s
  // timeout + try/catch ensures a failed disarm never blocks the surrounding
  // flow (we just fall back to the legacy "user clicks Leave manually" UX).
  async function disarmBeforeUnload() {
    if (!chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
      return { ok: false, __error: "no chrome.runtime" };
    }
    return new Promise((resolve) => {
      let settled = false;
      const t = setTimeout(() => {
        if (!settled) { settled = true; resolve({ ok: false, __error: "timeout" }); }
      }, 1500);
      try {
        chrome.runtime.sendMessage({ type: "TOCAFICHADR_DISARM_BEFOREUNLOAD" }, (r) => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          resolve(r || { ok: false, __error: "no response" });
        });
      } catch (e) {
        if (!settled) { settled = true; clearTimeout(t); resolve({ ok: false, __error: String(e) }); }
      }
    });
  }

  return {
    setBaseUrl, getBaseUrl, setToken, clearToken, isAuthenticated,
    checkHealth, transcribe, suggestCid, formatSoap, streamSoap, getSelectors, getDosages, logAudit,
    login, register, logout, getSubscription,
    disarmBeforeUnload,
    reportError,
  };
})();
