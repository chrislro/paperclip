/* ============================================================================
 * user-config-client.js (phase 003 plan 03-03)
 *
 * Hydrates and writes the per-user clinical config from the backend
 * (/api/me/config) instead of chrome.storage.sync. Used by both the popup
 * and the side panel — load this script BEFORE popup.bundle.js so the
 * surface code can read window.TOCAFICHADR_userConfig synchronously.
 *
 * Data model:
 *   chrome.storage.local.userConfig = {
 *     rx_templates: [...], voices: [...], custom_instructions: "",
 *     doctor_name: "", auto_cid: bool, auto_clear_soap: bool,
 *     auto_transcribe_on_dictation: bool, updated_at: ISO
 *   }
 *
 * Lifecycle:
 *   - On load (and on chrome.storage.session.authToken appearing):
 *     hydrate() → GET /api/me/config → write cache → fire onChange listeners.
 *   - patch(partial) → optimistic local merge + write-through PATCH.
 *     Debounced 400ms so rapid edits coalesce into one network call.
 *   - On authToken removal (signout): cache key is removed; gate observer
 *     in popup.src.js then hides the gated UI.
 *   - First successful hydrate: legacy chrome.storage.sync.prescriptionTemplates
 *     and _rxV31Migrated are dropped — server is now authoritative.
 *
 * Why a single chrome.storage.local.userConfig key (not keyed by Clerk uid):
 *   - Sign-in flow always rehydrates from server, so a stale key from a
 *     previous user is overwritten before the UI reads it.
 *   - Sign-out removes the key, so the next user on a shared Chrome can't
 *     see the previous user's data.
 *   - Simpler than parsing the JWT for `sub` to build a per-uid key.
 * ========================================================================== */
(function () {
  if (typeof window === "undefined") return;
  if (window.TOCAFICHADR_userConfig) return;

  var CACHE_KEY = "userConfig";
  var PATCH_DEBOUNCE_MS = 400;

  var _patchTimer = null;
  var _pendingPatch = {};
  var _changeListeners = [];
  var _hydrateInFlight = null;
  // Track when this context last wrote userConfig itself, so the
  // chrome.storage.onChanged callback can distinguish its own write
  // (writer's local state is already correct → skip _emit, which would
  // re-render in-progress edit inputs and lose focus) from a cross-context
  // write (other surface → propagate via _emit so this surface refreshes).
  var _lastSelfWriteAt = 0;
  var _SELF_WRITE_GRACE_MS = 250;

  // -- Cache helpers ---------------------------------------------------------
  function getCached() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([CACHE_KEY], function (data) {
          resolve((data && data[CACHE_KEY]) || null);
        });
      } catch (_) { resolve(null); }
    });
  }
  function _setCache(config) {
    return new Promise(function (resolve) {
      try {
        var payload = {};
        payload[CACHE_KEY] = config;
        chrome.storage.local.set(payload, function () { resolve(config); });
      } catch (_) { resolve(config); }
    });
  }
  function _clearCache() {
    try { chrome.storage.local.remove(CACHE_KEY); } catch (_) {}
  }

  // -- API URL resolution ----------------------------------------------------
  // Fallback must match DEFAULT_API_BASE_URL in background/service-worker.src.js.
  // Update both together if the production hostname ever changes.
  function _resolveApiBase() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.get(["apiBaseUrl"], function (data) {
          resolve((data && data.apiBaseUrl) || "https://api.tocafichadr.com.br");
        });
      } catch (_) { resolve("https://api.tocafichadr.com.br"); }
    });
  }

  // -- Service-worker fetch proxy --------------------------------------------
  // The SW handles Bearer token attachment + URL allowlist (phase 001). The SW
  // forwards every inbound header except Authorization, so extraHeaders (e.g.
  // an Idempotency-Key on offline-queue replay) reach the backend unchanged.
  function _swFetch(method, url, body, extraHeaders) {
    var headers = { "Content-Type": "application/json" };
    if (extraHeaders && typeof extraHeaders === "object") {
      Object.keys(extraHeaders).forEach(function (k) { headers[k] = extraHeaders[k]; });
    }
    var message = {
      type: "TOCAFICHADR_FETCH",
      url: url,
      method: method,
      headers: headers
    };
    if (body !== undefined) message.body = JSON.stringify(body);
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (resp) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, status: 0, text: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, status: 0, text: "no response" });
        });
      } catch (e) {
        resolve({ ok: false, status: 0, text: String(e) });
      }
    });
  }

  // -- Offline write queue (CHRA-2166) --------------------------------------
  // Config writes that fail because the backend is unreachable are parked in
  // shared/offline-queue.js (IndexedDB) and replayed on reconnect, so an edit
  // made offline is never lost — and never overwritten by the next hydrate.
  function _queue() {
    try { return window.TOCAFICHADR_offlineQueue || null; } catch (_) { return null; }
  }
  function _connectivity() {
    try { return window.TOCAFICHADR_connectivity || null; } catch (_) { return null; }
  }
  // A connectivity failure (vs a server rejection) is the SW proxy's status 0
  // — chrome.runtime.lastError, fetch throw, or timeout. An HTTP 4xx/5xx has
  // status > 0 and must NOT be queued (it would loop forever).
  function _isConnectivityFailure(resp) {
    if (resp && resp.status === 0) return true;
    var conn = _connectivity();
    return !!(conn && !conn.isOnline());
  }

  // Park the FULL current local config (allowlisted) as a single coalescing
  // record. Because the body is the complete state, re-queuing simply
  // overwrites it (last-write-wins) — no merge bookkeeping, naturally idempotent.
  async function _enqueueConfigWrite(base) {
    var q = _queue();
    if (!q) return false;
    try {
      var current = (await getCached()) || {};
      var safe = q.pickAllowedConfig(current);
      if (!Object.keys(safe).length) return false;
      await q.enqueue({
        kind: q.KIND_CONFIG,
        method: "PATCH",
        path: "/api/me/config",
        body: safe,
        dedupeKey: "config",
      });
      return true;
    } catch (e) {
      console.warn("[Toca Ficha] failed to queue offline config write:", (e && e.message) || e);
      return false;
    }
  }

  // Replay queued writes. Each record carries its own Idempotency-Key so a
  // half-applied write can be retried without a duplicate server effect.
  var _flushInFlight = false;
  async function _flushQueue() {
    var q = _queue();
    if (!q || _flushInFlight) return;
    var conn = _connectivity();
    if (conn && !conn.isOnline()) return; // pointless while offline
    _flushInFlight = true;
    try {
      var base = await _resolveApiBase();
      var res = await q.flush(function (record) {
        return _swFetch(record.method, base + record.path, record.body, {
          "Idempotency-Key": record.idempotencyKey,
        }).then(function (r) {
          // On a successful replay, adopt the server's canonical config so the
          // local cache matches what other surfaces will hydrate.
          if (r && r.ok) {
            try {
              var serverConfig = JSON.parse(r.text);
              _lastSelfWriteAt = Date.now();
              _setCache(serverConfig);
            } catch (_) {}
          }
          return { ok: !!(r && r.ok) };
        });
      });
      if (res && res.sent > 0) {
        console.log("[Toca Ficha] flushed", res.sent, "queued config write(s); remaining:", res.remaining);
      }
    } catch (e) {
      console.warn("[Toca Ficha] offline queue flush error:", (e && e.message) || e);
    } finally {
      _flushInFlight = false;
    }
  }

  // -- Migration guard -------------------------------------------------------
  // If the user had personal templates in the legacy chrome.storage.sync key
  // and the server only has blank defaults, upload sync templates to the server
  // BEFORE wiping the key. Mutates `config` in-place with the PATCH response so
  // the caller avoids a redundant GET round-trip.
  async function _migrateLocalTemplatesIfNeeded(config, base) {
    var serverTpls = Array.isArray(config && config.rx_templates) ? config.rx_templates : [];
    var serverHasCustom = serverTpls.some(function (t) { return t && (t.body || '').trim().length > 0; });
    if (serverHasCustom) return; // server already holds the doctor's templates

    var syncData = await new Promise(function (resolve) {
      try {
        chrome.storage.sync.get(['prescriptionTemplates'], function (d) {
          resolve((d && Array.isArray(d.prescriptionTemplates)) ? d.prescriptionTemplates : null);
        });
      } catch (_) { resolve(null); }
    });
    if (!Array.isArray(syncData) || !syncData.length) return;
    var syncHasCustom = syncData.some(function (t) { return t && (t.body || '').trim().length > 0; });
    if (!syncHasCustom) return;

    console.log('[Toca Ficha] migrating', syncData.length, 'personal templates from sync storage → server');
    var pr = await _swFetch("PATCH", base + "/api/me/config", { rx_templates: syncData });
    if (pr.ok) {
      try { Object.assign(config, JSON.parse(pr.text)); } catch (_) {}
    } else {
      console.warn('[Toca Ficha] template migration PATCH failed:', pr.status, (pr.text || '').slice(0, 120));
    }
  }

  // -- Hydrate ---------------------------------------------------------------
  function hydrate() {
    if (_hydrateInFlight) return _hydrateInFlight;
    _hydrateInFlight = (async function () {
      try {
        // CHRA-2166: drain any offline edits BEFORE pulling, so the GET can't
        // overwrite a queued local change with stale server state.
        await _flushQueue();
        var base = await _resolveApiBase();
        var r = await _swFetch("GET", base + "/api/me/config");
        if (!r.ok) {
          console.warn("[Toca Ficha] userConfig hydrate failed:", r.status, (r.text || "").slice(0, 120));
          return null;
        }
        var config;
        try { config = JSON.parse(r.text); }
        catch (_) { console.warn("[Toca Ficha] userConfig hydrate: bad JSON"); return null; }
        // Upload legacy sync templates if the server only has blank defaults.
        // Must run BEFORE the legacy-key cleanup below.
        await _migrateLocalTemplatesIfNeeded(config, base);
        // Mark as self-write so the storage.onChanged listener below
        // suppresses its own _emit; we emit directly once instead.
        _lastSelfWriteAt = Date.now();
        await _setCache(config);
        _emit(config);
        // Migration: drop all legacy personal-config keys after the first
        // successful hydrate. Server is authoritative now; legacy keys would
        // only confuse future readers and leak across users on a shared
        // Chrome profile. apiBaseUrl + backendMode stay (infra, not personal).
        try {
          chrome.storage.sync.remove([
            "prescriptionTemplates", "_rxV31Migrated",
            "soapVoices", "activeSoapVoiceId",
            "customInstructions", "doctorName",
            "autoCid", "autoClearSoap",
            "autoFillCompanion", "autoPrefillEncaminh",
          ]);
        } catch (_) {}
        return config;
      } finally {
        _hydrateInFlight = null;
      }
    })();
    return _hydrateInFlight;
  }

  // -- Patch (debounced write-through) --------------------------------------
  function patch(partial) {
    if (!partial || typeof partial !== "object") return;
    Object.keys(partial).forEach(function (k) { _pendingPatch[k] = partial[k]; });
    if (_patchTimer) clearTimeout(_patchTimer);
    _patchTimer = setTimeout(_flushPatch, PATCH_DEBOUNCE_MS);
  }

  async function _flushPatch() {
    var body = _pendingPatch;
    _pendingPatch = {};
    _patchTimer = null;
    if (!Object.keys(body).length) return;

    // Optimistic local update. Mark this as a self-write so the
    // storage.onChanged callback below skips the redundant _emit (which
    // would re-render in-progress edit inputs in the writer's context).
    var current = (await getCached()) || {};
    var merged = Object.assign({}, current, body);
    _lastSelfWriteAt = Date.now();
    await _setCache(merged);
    // No _emit here — writer's local state already reflects the change.

    var base = await _resolveApiBase();
    var r = await _swFetch("PATCH", base + "/api/me/config", body);
    if (r.ok) {
      try {
        var serverConfig = JSON.parse(r.text);
        _lastSelfWriteAt = Date.now();
        await _setCache(serverConfig); // server response wins (e.g. length-capped strings)
        // No _emit either — server response is functionally the same as the
        // optimistic merge from the writer's perspective. Other contexts get
        // it via chrome.storage.onChanged. If we ever need to emit on
        // server-side rejection or transformation, do it conditionally on
        // whether `serverConfig` differs from `merged` (deep compare).
      } catch (_) { /* keep optimistic merged */ }
      // A successful write means the link is up — drain anything that was
      // queued while offline (idempotent; no-op when the queue is empty).
      _flushQueue();
    } else if (_isConnectivityFailure(r)) {
      // CHRA-2166: backend unreachable. Park the full local config so the edit
      // survives until reconnect, instead of silently losing it on next hydrate.
      console.warn("[Toca Ficha] userConfig patch offline — queued for replay (status", r.status + ")");
      await _enqueueConfigWrite(base);
    } else {
      console.warn("[Toca Ficha] userConfig patch failed:", r.status, (r.text || "").slice(0, 120));
      // Server rejection (4xx/5xx) — don't queue (would loop). Next hydrate syncs.
    }
  }

  // -- Subscribers -----------------------------------------------------------
  function onChange(fn) {
    if (typeof fn === "function") _changeListeners.push(fn);
  }
  function _emit(config) {
    for (var i = 0; i < _changeListeners.length; i++) {
      try { _changeListeners[i](config); }
      catch (e) { console.warn("[Toca Ficha] userConfig listener error:", e); }
    }
  }

  // -- Auto sign-in / sign-out reactions ------------------------------------
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      // CHRA-2133: the auth token now lives in chrome.storage.session (cleared
      // on browser close, inaccessible to content scripts). React to its
      // sign-in / sign-out transitions there. The sign-out branch is what
      // prevents a previous user's config leaking to the next user on a shared
      // Chrome — it MUST stay wired to wherever the token actually changes.
      if (area === "session" && changes.authToken) {
        var had = !!changes.authToken.oldValue;
        var has = !!changes.authToken.newValue;
        if (!had && has) {
          // Sign-in → hydrate.
          hydrate().catch(function (e) { console.warn("[Toca Ficha] hydrate on signin:", e); });
        } else if (had && !has) {
          // Sign-out → clear local cache. Other tabs/contexts that subscribed
          // via onChange will receive the next config when the next user
          // signs in and re-hydrates.
          _clearCache();
        }
      }
      // The userConfig cache itself stays in chrome.storage.local. Cross-context
      // propagation: if another context (e.g. side panel) wrote userConfig,
      // fire local listeners so this context re-renders. Suppress within
      // _SELF_WRITE_GRACE_MS of our own write — that's our own optimistic
      // update echoing back, and re-rendering would steal focus from any input
      // the user is typing into.
      if (area === "local" && changes[CACHE_KEY] && changes[CACHE_KEY].newValue) {
        if (Date.now() - _lastSelfWriteAt > _SELF_WRITE_GRACE_MS) {
          _emit(changes[CACHE_KEY].newValue);
        }
      }
    });
  } catch (_) {}

  // -- Reconnect → flush queued writes (CHRA-2166) --------------------------
  // When connectivity returns, replay anything parked while offline. Guarded
  // so the module still works if connectivity.js is absent (e.g. unit tests).
  try {
    var _conn = _connectivity();
    if (_conn && typeof _conn.onChange === "function") {
      _conn.onChange(function (online) { if (online) _flushQueue(); });
    }
  } catch (_) {}

  // -- Initial hydrate if already authed when this script loads. -----------
  // CHRA-2133: the JWT lives in chrome.storage.session now. After a browser
  // restart this is empty until the popup/side panel re-mints from Clerk; the
  // onChanged(session) listener above then fires hydrate() on first appearance.
  try {
    chrome.storage.session.get(["authToken"], function (data) {
      if (data && data.authToken) {
        hydrate().catch(function () {});
      } else {
        // Not authed yet, but a previous session may have queued writes that
        // never flushed — try once we're online (no-op if the queue is empty).
        _flushQueue();
      }
    });
  } catch (_) {}

  window.TOCAFICHADR_userConfig = {
    getCached: getCached,
    hydrate: hydrate,
    patch: patch,
    onChange: onChange,
    // CHRA-2166: lets the side panel's "Tentar novamente" button force a drain.
    flushQueue: _flushQueue
  };
})();
