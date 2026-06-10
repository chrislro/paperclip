// sidepanel-prontuario.js — v3.1.2 — event delegation + stable template order
console.log('[Toca Ficha] sidepanel-prontuario loaded @ ' + new Date().toISOString());
//
// Replaces the floating HUD with side-panel-driven control. Talks to the
// content-script bridge (content/bridge.js) via chrome.tabs.sendMessage.
//
// Surface owned here:
//   - Patient card (auto-updates on G-Hosp navigation)
//   - Record button + timer
//   - SOAP textarea (transcribe → suggest CID → optionally paste into G-Hosp)
//   - CID-10 search (queries the content script's CID DB)
//   - Prescription template grid (Dx + age band, sorted by frequency)
//   - Action buttons: Save, Receita, Atestado, Baú Médico
//   - Alta e voltar
//
// All G-Hosp DOM mutation happens in the content script. Audio capture also
// runs in the content script (HTTPS origin needed for getUserMedia on G-Hosp).

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────────────────
  const state = {
    patientInfo: { internId: null, weight: null, chiefComplaint: null },
    recording: false,
    // In-flight guard for toggleRecording START path. state.recording is only
    // set to true AFTER the await completes, leaving a window where a second
    // click passes the `if (state.recording)` guard and sends a duplicate
    // SIDEPANEL_START_RECORDING. Checked together with state.recording.
    startingRecording: false,
    processing: false,
    timerStart: 0,
    timerInterval: null,
    rxRunning: false,
    rxFinalizing: false,
    atestadoRunning: false,
    finalizing: false,
    activeTabId: null,
    // The G-Hosp tab where the current recording was initiated. Set when
    // SIDEPANEL_START_RECORDING succeeds; cleared when BLOB or ERROR arrives.
    // Used by the runtime.onMessage listener to drop BLOB/ERROR/WAVEFORM
    // broadcasts that came from a different tab — covers the multi-window
    // case where a second side panel (different Chrome window) would
    // otherwise pick up audio from the recording panel and start processing
    // a recording it never initiated.
    recordingTabId: null,
    cidSearchTimer: null,
    soapText: '',
    suggestedCid: null,
    // v3.1.8 — G-Hosp server-side template catalog state.
    urlKey: null,
    ghospProbing: false,
    ghospRunning: false,
    // Atestado drawer state.
    //   atestadoOpen: bool — controls the drawer collapse/expand. Closed by
    //     default; toggles on Atestado action button click; closes on outer
    //     click and after a successful CTA run.
    //   atestadoDays: 1-30 — selected number of days. Persists across drawer
    //     open/close (chrome.storage.sync.atestadoLastDays).
    //   atestadoCompanionMode: null | 'mae' | 'pai' | 'outro' — which companion
    //     line the obs textarea gets. null means patient-only (no companion
    //     line written; default state, no chip selected). 'mae' / 'pai' write
    //     the single-line "Acompanhante <Role>: NAME" pattern; 'outro' stacks
    //     both parents. Session-only — NOT persisted across side-panel reloads.
    //     The drawer always opens with no chip selected so patient-only mode
    //     is reachable on first open; persisting would resurrect the prior
    //     pick and re-introduce the auto-pick that pre-v3.5 storage caused.
    //   atestadoFullRunning: bool — re-entrancy guard for the CTA.
    atestadoOpen: false,
    atestadoDays: 1,
    atestadoCompanionMode: null,
    atestadoFullRunning: false,
    // v3.3.0 — live waveform during recording. The latest 24-bin frame is
    // dropped here by the TOCAFICHADR_WAVEFORM_BINS listener; _drawWaveform()
    // is a 60fps rAF loop that paints the canvas off this reference.
    // Decoupling the broadcast rate (~30Hz) from the render rate (60Hz) gives
    // smoother visual decay than painting on every message.
    waveformLastBins: null,
    waveformRunning: false,
    // v3.4.0 — per-patient dosages catalog cache. The backend computes doses
    // server-side based on weight, so we re-fetch whenever the patient's
    // weight changes. Keeping the catalog here (in-memory) instead of
    // chrome.storage avoids serializing on every patient switch.
    //   { weight: number, data: {pediatric, adult}, ts: number, fetching: boolean }
    dosagesCache: null,
    // Pending preview drawer state — populated when a smart template is
    // clicked, drained when the doctor confirms or cancels.
    pendingPreview: null,
    // Medication shortcuts selected in the Receita — Modelos grid. Kept as
    // IDs so re-renders from userConfig updates preserve the current mix.
    selectedRxTemplateIds: new Set(),
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Error normalization — user-safe Portuguese messages
  // ─────────────────────────────────────────────────────────────────────────
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
        // Backend returns two distinct 429s — distinguish by the `code` token
        // appended to the message at the throw site. RATE_LIMIT clears in 60s;
        // USAGE_LIMIT is the free-tier daily cap and lasts until midnight.
        if (/USAGE_LIMIT/i.test(msg)) return 'Limite diário atingido — assine Pro ou aguarde até amanhã.';
        return 'Muitas requisições. Aguarde um momento.';
      }
      if (status >= 500) return 'Erro no servidor. Tente novamente em instantes.';
    }
    return msg || 'Erro desconhecido.';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Strip leading/trailing ```json … ``` fences from model output.
  //
  // 2026-04-15: the OpenAI format-soap path occasionally returns the SOAP
  // wrapped in a markdown code fence (```json …\n```). The streaming path
  // can leak the same pattern when the first token is the literal ``` and
  // the last is the literal ```. Both eventually land in state.soapText and
  // get pasted into G-Hosp + written to the clipboard. The fences would
  // show up verbatim inside the wysihtml5 SOAP editor and on Cmd+V into
  // a chart — embarrassing in front of a patient and forces manual cleanup.
  //
  // Strip is best-effort: only trims the outermost fence pair (no recursive
  // stripping, no language-tag stripping inside the body). Preserves any
  // backtick groups that aren't whole-message fences (clinical names like
  // `M65.4` rarely contain them but we don't want to break the unlikely
  // exception).
  // ─────────────────────────────────────────────────────────────────────────
  function _stripJsonFences(text) {
    if (typeof text !== 'string') return text;
    let out = text.trim();
    // Leading fence: ```json\n | ```\n | ```json | ``` (consume only the
    // optional inline space + ONE newline that closes the opener line —
    // any leading whitespace on the next line is content the model meant
    // to preserve, e.g. indented JSON).
    out = out.replace(/^```(?:json|JSON)?[ \t]*\r?\n?/, '');
    // Trailing fence on its own line at end of string. Consume one
    // preceding newline + only inline space on the closer line, never
    // body whitespace from the previous content line.
    out = out.replace(/\r?\n[ \t]*```\s*$|```\s*$/, '');
    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utility — find the active G-Hosp tab and route messages to it
  // ─────────────────────────────────────────────────────────────────────────
  async function _findGhospTab() {
    if (state.activeTabId) {
      try {
        const tab = await chrome.tabs.get(state.activeTabId);
        if (tab && tab.url && tab.url.includes('prbentogoncalves.g-hosp.com.br')) return tab.id;
      } catch (_) { state.activeTabId = null; }
    }
    const tabs = await chrome.tabs.query({ url: 'https://prbentogoncalves.g-hosp.com.br/*' });
    if (tabs && tabs.length) {
      // Prefer the active tab if multiple
      const active = tabs.find((t) => t.active) || tabs[0];
      state.activeTabId = active.id;
      return active.id;
    }
    return null;
  }

  // Mirror of API_DISCOVERY_URL + API_HOSTS_ALLOWLIST in service-worker.src.js.
  // Used when the side panel's configured apiBaseUrl returns "Failed to fetch"
  // (the tunnel rotated) — we fetch the first-party endpoint first, then gist
  // fallback, validate, and update storage so the next call hits the live tunnel.
  const _API_DISCOVERY_PRIMARY_URL = 'https://api.tocafichadr.com.br/config/api-url.json';
  const _API_DISCOVERY_FALLBACK_URL = 'https://gist.githubusercontent.com/chrislro/3abd7bec1b371681c4ab346bd642b8e6/raw/tocafichadr-api-url.json';
  const _API_HOSTS_ALLOWLIST = /^(?:api\.tocafichadr\.com\.br|[a-z0-9-]+\.trycloudflare\.com)$/i;
  const _DEFAULT_API_BASE_URL = 'https://api.tocafichadr.com.br';

  async function _refreshApiBaseUrlFromGist() {
    const urls = [_API_DISCOVERY_PRIMARY_URL, _API_DISCOVERY_FALLBACK_URL];
    for (const url of urls) {
      try {
        const r = await fetch(url + '?cb=' + Date.now(), {
          cache: 'no-store',
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) continue;
        const data = await r.json();
        const discovered = data && data.apiBaseUrl;
        if (typeof discovered !== 'string') continue;
        let parsed;
        try { parsed = new URL(discovered); } catch (_) { continue; }
        if (parsed.protocol !== 'https:') continue;
        if (!_API_HOSTS_ALLOWLIST.test(parsed.hostname)) continue;
        const current = (await chrome.storage.sync.get(['apiBaseUrl'])).apiBaseUrl;
        if (_isFirstPartyApiUrl(current) && parsed.hostname !== 'api.tocafichadr.com.br') return null;
        const clean = discovered.replace(/\/+$/, '');
        await chrome.storage.sync.set({ apiBaseUrl: clean });
        return clean; // Success — stop trying
      } catch (_) { /* try next URL */ }
    }
    return null;
  }

  function _isFirstPartyApiUrl(value) {
    if (typeof value !== 'string') return false;
    try {
      return new URL(value).hostname === 'api.tocafichadr.com.br';
    } catch (_) {
      return false;
    }
  }

  // Content scripts in manifest order — used for self-heal reinjection when a
  // stale G-Hosp tab (extension reloaded mid-session, user did not refresh)
  // returns "Receiving end does not exist". MUST mirror manifest.json
  // content_scripts[].js exactly: reinjection runs after an extension reload,
  // when the old isolated-world globals are gone, so every dependency must be
  // present. error-helpers.js defines _normalizeApiError (a script-scope global
  // api-client.js calls UNGUARDED) — omitting it made the reinjected api-client
  // throw "ReferenceError: _normalizeApiError is not defined" on every API error
  // path. (Same class as the Bug 28 popup-injection fix.) See
  // scripts/test-injection-deps.js for the cross-file consistency tripwire.
  const _CONTENT_SCRIPT_FILES = [
    'shared/console-shipper.js',
    'shared/error-helpers.js',
    'content/cid.js',
    'content/api-client.js',
    'content/vad-helpers.js',
    'content/audio-capture.js',
    'content/dom-engine.js',
    'content/bridge.js',
  ];

  async function _reinjectContentScripts(tabId) {
    if (!chrome.scripting || !chrome.scripting.executeScript) return false;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: _CONTENT_SCRIPT_FILES,
      });
      // Bridge runs an async IIFE (loadSelectors fetch). Give it time to
      // register chrome.runtime.onMessage before we retry.
      await new Promise((r) => setTimeout(r, 1200));
      return true;
    } catch (e) {
      console.warn('[Toca Ficha] reinject failed:', e && e.message);
      return false;
    }
  }

  async function send(type, payload = {}) {
    const tabId = await _findGhospTab();
    if (!tabId) {
      _setStatus('Abra a aba do G-Hosp', 'err');
      return { ok: false, error: 'no g-hosp tab' };
    }
    const message = Object.assign({ type }, payload);
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      const errMsg = (e && e.message) || String(e);

      // v3.1.5: BFCache eviction path. When the G-Hosp tab was navigated
      // (back/forward) Chrome may park the page in the back/forward cache
      // and freeze all its content-script ports. Reinjection doesn't help —
      // the script is intact, just suspended. Focusing the tab nudges Chrome
      // to evict the page from BFCache; we then retry the message once.
      if (/back\/forward cache|message channel is closed|page keeping the extension port/i.test(errMsg)) {
        _setStatus('Reativando aba do G-Hosp...', 'loading');
        try {
          await chrome.tabs.update(tabId, { active: true });
          const tab = await chrome.tabs.get(tabId);
          if (tab && typeof tab.windowId === 'number') {
            await chrome.windows.update(tab.windowId, { focused: true });
          }
        } catch (_) { /* focus is best-effort */ }
        // Chrome usually evicts within a few hundred ms of focus.
        await new Promise((r) => setTimeout(r, 500));
        try {
          const result = await chrome.tabs.sendMessage(tabId, message);
          _setStatus('', '');
          return result;
        } catch (e2) {
          _setStatus('Clique na aba do G-Hosp e tente de novo', 'err');
          return { ok: false, error: e2.message || String(e2) };
        }
      }

      // "Receiving end does not exist" = the tab has no live content script
      // (extension was reloaded since the page loaded). Self-heal by
      // reinjecting the scripts and retrying once.
      if (/Receiving end does not exist|Could not establish connection/i.test(errMsg)) {
        _setStatus('Reconectando ao G-Hosp...', 'loading');
        console.log('[Toca Ficha] content script missing on tab', tabId, '- attempting reinject');
        const reinjected = await _reinjectContentScripts(tabId);
        if (reinjected) {
          try {
            const result = await chrome.tabs.sendMessage(tabId, message);
            _setStatus('', '');
            return result;
          } catch (e2) {
            console.warn('[Toca Ficha] send after reinject failed:', e2 && e2.message);
            _setStatus('Recarregue a aba do G-Hosp (F5)', 'err');
            return { ok: false, error: e2.message || String(e2) };
          }
        }
        console.warn('[Toca Ficha] reinject failed - asking user to reload');
      }
      _setStatus('Recarregue a aba do G-Hosp (F5)', 'err');
      return { ok: false, error: errMsg };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UI helpers
  // ─────────────────────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  function _setStatus(text, kind) {
    const el = $('sp-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'scribe-status' + (kind ? ' ' + kind : '');
  }

  // Template save error helpers — mirrored from popup.src.js so the
  // delegated click router in this file can surface errors even when
  // the popup bundle's globals are not yet loaded.
  function _showTemplateSaveError(msg) {
    const el = $('rx-save-error');
    if (!el) return;
    el.textContent = msg || '';
  }
  function _clearTemplateSaveError() {
    const el = $('rx-save-error');
    if (!el) return;
    el.textContent = '';
  }

  // v3.3.0 — Streaming SOAP status row. During Phase B we want a tight
  // two-column layout (label on the left, muted word-count on the right)
  // instead of overwriting the whole line every token. Builds the row via
  // DOM nodes (no innerHTML) so it stays CSP-friendly.
  function _setStreamingStatus(count) {
    const el = $('sp-status');
    if (!el) return;
    el.className = 'scribe-status loading';
    el.style.display = 'flex';
    el.style.justifyContent = 'space-between';
    el.style.gap = '8px';
    el.textContent = '';
    const left = document.createElement('span');
    left.textContent = 'Gerando SOAP…';
    const right = document.createElement('span');
    right.className = 'muted';
    const n = count || 0;
    right.textContent = n + ' palavra' + (n === 1 ? '' : 's');
    el.appendChild(left);
    el.appendChild(right);
  }

  // Reset the inline flex styles applied by _setStreamingStatus so plain
  // _setStatus() calls render normally afterwards.
  function _clearStreamingStatusLayout() {
    const el = $('sp-status');
    if (!el) return;
    el.style.display = '';
    el.style.justifyContent = '';
    el.style.gap = '';
  }

  function _showProgress() {
    const el = $('sp-progress');
    if (el) el.classList.add('active');
  }

  function _hideProgress() {
    const el = $('sp-progress');
    if (el) el.classList.remove('active');
    _clearStreamingStatusLayout();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CHRA-2166 — connectivity awareness + "Backend indisponível" banner
  // ─────────────────────────────────────────────────────────────────────────
  // Drives a non-blocking offline bar from window.TOCAFICHADR_connectivity
  // (navigator.onLine + online/offline events). Backend ops short-circuit when
  // offline so the doctor sees this state instead of an endless spinner.
  function _connectivity() {
    try { return window.TOCAFICHADR_connectivity || null; } catch (_) { return null; }
  }
  function _isBackendOnline() {
    const c = _connectivity();
    return c ? c.isOnline() : true; // assume online if the module is missing
  }
  // Backend health probe via the SW (GET /api/health). Resolves true/false; never throws.
  function _healthProbe() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'TOCAFICHADR_HEALTH' }, (resp) => {
          resolve(!chrome.runtime.lastError && !!(resp && resp.ok));
        });
      } catch (_) { resolve(false); }
    });
  }
  // CHRA-2423 Bug 77 — auto-recovery while the offline banner is visible. Before,
  // a transient BACKEND outage (tunnel blip / Flask restart) that recovered while
  // the OS stayed online left `backendReachable=false` set, so _guardOnline() kept
  // blocking recording until the doctor manually clicked "Tentar novamente" — a
  // lost-recording risk mid-consultation. This poller runs ONLY while the banner is
  // shown and stops the instant the backend answers (notifyReachable(true) →
  // onChange → _hideOfflineBanner → clears the timer). It does NOT touch
  // _guardOnline / the recording-start path.
  let _offlineProbeTimer = null;
  const _OFFLINE_REPROBE_MS = 20000;
  async function _autoReprobeBackend() {
    const ok = await _healthProbe();
    if (!ok) return; // still down — keep polling on the next tick
    const c = _connectivity();
    if (c) c.notifyReachable(true); // → onChange → _hideOfflineBanner() stops this poller
    try {
      if (window.TOCAFICHADR_userConfig && window.TOCAFICHADR_userConfig.flushQueue) {
        window.TOCAFICHADR_userConfig.flushQueue();
      }
    } catch (_) {}
    try { _refreshUsage(); } catch (_) {}
  }
  function _showOfflineBanner() {
    const el = $('sp-offline-banner');
    if (el) el.hidden = false;
    // Start the bounded auto-re-probe (guard against double-start — this is called
    // on every onChange(false) and from _guardOnline).
    if (_offlineProbeTimer === null && typeof setInterval === 'function') {
      _offlineProbeTimer = setInterval(() => { _autoReprobeBackend(); }, _OFFLINE_REPROBE_MS);
    }
  }
  function _hideOfflineBanner() {
    const el = $('sp-offline-banner');
    if (el) el.hidden = true;
    if (_offlineProbeTimer !== null) {
      clearInterval(_offlineProbeTimer);
      _offlineProbeTimer = null;
    }
  }
  // Re-probe the backend (GET /api/health via the SW), update connectivity, and
  // flush any queued config writes. Wired to the "Tentar novamente" button.
  async function _retryConnection() {
    const btn = $('sp-offline-retry');
    if (btn) { btn.disabled = true; btn.textContent = 'Verificando...'; }
    const ok = await _healthProbe();
    const c = _connectivity();
    if (c) c.notifyReachable(ok);
    if (ok) {
      _hideOfflineBanner();
      _setStatus('Reconectado ✓', 'ok');
      try {
        if (window.TOCAFICHADR_userConfig && window.TOCAFICHADR_userConfig.flushQueue) {
          window.TOCAFICHADR_userConfig.flushQueue();
        }
      } catch (_) {}
      try { _refreshUsage(); } catch (_) {}
    } else {
      _setStatus('Ainda sem conexão com o servidor', 'err');
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Tentar novamente'; }
  }
  // Guard for backend-dependent actions. Returns false (and surfaces the
  // banner) when offline so the caller can bail before starting a spinner.
  function _guardOnline() {
    if (_isBackendOnline()) return true;
    _showOfflineBanner();
    _setStatus('Backend indisponível — reconecte para continuar', 'err');
    return false;
  }
  // CHRA-2166: true ONLY for "couldn't reach the server" errors — a thrown
  // fetch (TypeError "Failed to fetch") or an explicit no-connection message.
  // An "HTTP <status>" error means the server RESPONDED (reachable), so a
  // 429/500 must return false and never false-flag the backend as offline.
  // Timeouts are deliberately excluded too — a slow-but-reachable backend
  // should not strand the doctor behind the offline banner.
  function _isNetworkDownError(err) {
    const msg = (err && err.message) || String(err || '');
    if (/^HTTP\s+\d/.test(msg)) return false;       // server responded → reachable
    const name = (err && err.name) || '';
    return name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(msg);
  }
  function _wireConnectivity() {
    const retry = $('sp-offline-retry');
    if (retry) retry.addEventListener('click', _retryConnection);
    const c = _connectivity();
    if (c && typeof c.onChange === 'function') {
      c.onChange((online) => { if (online) _hideOfflineBanner(); else _showOfflineBanner(); });
    }
    // Reflect the initial state on load.
    if (!_isBackendOnline()) _showOfflineBanner();
  }

  // Rule 11 (PHI): wipe in-memory patient data on session end. Patient fields
  // live only in `state` (never written to durable storage), so nulling them
  // here guarantees nothing patient-identifying survives the panel closing.
  function _clearSessionPHI() {
    try {
      state.soapText = '';
      state.suggestedCid = null;
      state.patientInfo = { internId: null, weight: null, chiefComplaint: null };
      state.dosagesCache = null;
    } catch (_) {}
  }

  function _setRecordBtn(mode, label) {
    const btn = $('sp-record-btn');
    if (!btn) return;
    btn.className = 'sp-record-btn ' + mode;
    const lbl = btn.querySelector('.sp-rec-label');
    if (lbl && label) lbl.textContent = label;
    // v3.3.0 — any record-button transition (including idle on new
    // recordings, done on success, processing at Phase A start) hides the
    // streaming progress bar. Phase B re-shows it explicitly when streaming
    // actually starts, so this can't shadow the streaming run.
    _hideProgress();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // v3.3.0 — Live waveform visualizer (Idea #5)
  //
  // content/audio-capture.js broadcasts TOCAFICHADR_WAVEFORM_BINS at ~30Hz
  // while recording. We buffer each frame into state.waveformLastBins and
  // render at 60fps via requestAnimationFrame for smooth decay between
  // broadcasts. Canvas visibility is toggled by the start/stop pair below.
  function _showWaveform() {
    const c = $('sp-waveform');
    if (c) c.classList.add('active');
  }

  function _hideWaveform() {
    const c = $('sp-waveform');
    if (!c) return;
    c.classList.remove('active');
    try {
      const ctx = c.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, c.width, c.height);
    } catch (_) {}
    state.waveformLastBins = null;
  }

  function _startWaveformRender() {
    if (state.waveformRunning) return;
    state.waveformRunning = true;
    requestAnimationFrame(_drawWaveform);
  }

  function _drawWaveform() {
    if (!state.recording) {
      state.waveformRunning = false;
      return;
    }
    const c = $('sp-waveform');
    if (!c) { requestAnimationFrame(_drawWaveform); return; }
    const ctx = c.getContext('2d');
    const w = c.width;
    const h = c.height;
    ctx.clearRect(0, 0, w, h);
    const bins = state.waveformLastBins;
    if (bins && bins.length) {
      const barW = (w - 23) / 24;
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#10b981');
      grad.addColorStop(1, '#047857');
      ctx.fillStyle = grad;
      for (let i = 0; i < 24; i++) {
        const v = bins[i] / 255;
        const barH = Math.max(2, v * h);
        ctx.fillRect(i * (barW + 1), h - barH, barW, barH);
      }
    }
    requestAnimationFrame(_drawWaveform);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // v3.3.0: SOAP clipboard inline-icon helpers (Idea #3)
  //
  // Chrome MV3 side panels require the document to have focus for
  // navigator.clipboard.writeText() to succeed. SOAP_DONE often arrives 5-15s
  // after the doctor stopped recording — by which time they have clicked
  // back into the G-Hosp tab, so the side panel is unfocused and writeText
  // rejects with NotAllowedError.
  //
  // The inline 📋 icon is a permanent, always-visible affordance after a SOAP
  // is generated. It pulses amber when the auto-copy failed, and is the user
  // gesture that lets writeText succeed regardless of focus state.
  // ─────────────────────────────────────────────────────────────────────────
  function _showSoapCopyIcon(opts) {
    const btn = $('sp-soap-copy-icon');
    if (!btn) return;
    if (!state.soapText) return; // nothing to copy → keep hidden
    btn.classList.add('visible');
    if (opts && opts.warn) {
      btn.classList.add('warn');
    } else {
      btn.classList.remove('warn');
    }
  }

  function _hideSoapCopyIcon() {
    const btn = $('sp-soap-copy-icon');
    if (!btn) return;
    btn.classList.remove('visible');
    btn.classList.remove('warn');
  }

  function _wireSoapCopyIcon() {
    const btn = $('sp-soap-copy-icon');
    if (!btn) return;
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      // CRITICAL: writeText must run synchronously inside the user-gesture
      // handler — no awaits before the call, or the gesture token is lost.
      const text = state.soapText || '';
      if (!text) return;
      try {
        const p = navigator.clipboard.writeText(text);
        Promise.resolve(p).then(
          () => {
            btn.classList.remove('warn');
            _setStatus('SOAP copiado ✓', 'ok');
          },
          (err) => {
            console.warn('[Toca Ficha] manual clipboard copy failed:', err && err.message);
            _setStatus('Falha ao copiar — selecione e Cmd+C manualmente', 'err');
          }
        );
      } catch (err) {
        console.warn('[Toca Ficha] manual clipboard copy threw:', err && err.message);
        _setStatus('Falha ao copiar — selecione e Cmd+C manualmente', 'err');
      }
    });
  }

  function _renderPatient(info) {
    const prevWeight = state.patientInfo && state.patientInfo.weight;
    state.patientInfo = info || { internId: null, weight: null, chiefComplaint: null };
    const idEl = $('sp-patient-id');
    const wEl  = $('sp-patient-weight');
    const cEl  = $('sp-patient-complaint');
    if (idEl) idEl.textContent = state.patientInfo.internId || '—';
    if (wEl)  wEl.textContent  = (state.patientInfo.weight || '—') + ' kg';
    if (cEl)  cEl.textContent  = state.patientInfo.chiefComplaint || 'Abra um prontuário no G-Hosp';
    // v3.4.0 — bust the dosages cache when the patient weight changed. The
    // backend's `practical` strings (e.g. "12 gotas (1mL)") are weight-bound,
    // so reusing a 12kg cache for a 25kg child would mis-dose.
    if (prevWeight !== state.patientInfo.weight) {
      state.dosagesCache = null;
    }
    // v3.8.2 — update action button states based on patient presence
    _updateActionButtonsForPatientState();
  }

  function _startTimer() {
    state.timerStart = Date.now();
    if (state.timerInterval) clearInterval(state.timerInterval);
    state.timerInterval = setInterval(() => {
      const t = $('sp-timer');
      if (!t) return;
      const sec = Math.floor((Date.now() - state.timerStart) / 1000);
      const m = String(Math.floor(sec / 60)).padStart(2, '0');
      const s = String(sec % 60).padStart(2, '0');
      t.textContent = `${m}:${s}`;
    }, 250);
  }
  function _stopTimer() {
    if (state.timerInterval) clearInterval(state.timerInterval);
    state.timerInterval = null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Patient sync
  // ─────────────────────────────────────────────────────────────────────────
  async function refreshPatient() {
    const r = await send('SIDEPANEL_GET_PATIENT');
    if (r && r.ok) {
      _renderPatient(r.info);
      _setUrlKey(r.urlKey || null);
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'TOCAFICHADR_PATIENT_CHANGED') {
      // Drop broadcasts from non-active G-Hosp tabs. Doctors routinely have
      // two G-Hosp tabs open (chart + /prconsultas list); without this filter
      // the list tab's null-patient broadcast clobbers the active chart's
      // sidebar state and the patient ID appears to "disappear".
      if (sender && sender.tab && sender.tab.active === false) return;
      _renderPatient(msg.info);
      _setUrlKey(msg.urlKey || null);
    } else if (msg.type === 'TOCAFICHADR_RECORDING_BLOB') {
      // Only the panel that started this recording should process its blob.
      // chrome.runtime.sendMessage fans out to every extension context, so
      // without this filter a second Chrome window's side panel would
      // process audio it never recorded.
      if (state.recordingTabId === null) return;
      if (sender && sender.tab && sender.tab.id !== state.recordingTabId) return;
      state.recordingTabId = null;
      _onRecordingBlob(msg);
    } else if (msg.type === 'TOCAFICHADR_RECORDING_ERROR') {
      if (state.recordingTabId === null) return;
      if (sender && sender.tab && sender.tab.id !== state.recordingTabId) return;
      state.recordingTabId = null;
      _setStatus('Mic: ' + msg.error, 'err');
      _setRecordBtn('idle', 'Gravar Consulta');
      state.recording = false; _stopTimer();
      _hideWaveform();
    } else if (msg.type === 'TOCAFICHADR_WAVEFORM_BINS') {
      // v3.3.0 — keep the latest analyser frame; the rAF loop reads it.
      // Broadcasts arrive whether or not the side panel currently has the
      // canvas visible (e.g. the doctor switched to the Config tab) — we
      // accept them silently so the moment they switch back, decay is fresh.
      // Multi-window guard: drop frames from any tab other than the one
      // we're recording in, and drop everything when we're not recording.
      if (state.recordingTabId === null) return;
      if (sender && sender.tab && sender.tab.id !== state.recordingTabId) return;
      if (Array.isArray(msg.bins) || (msg.bins && typeof msg.bins.length === 'number')) {
        state.waveformLastBins = msg.bins;
      }
    } else if (msg.type === 'TOCAFICHADR_AUTH_COMPLETED') {
      // Sign-in completed in another tab — reload the side panel so Clerk
      // SDK picks up the fresh session from chrome.storage.
      setTimeout(() => location.reload(), 400);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Recording flow
  // ─────────────────────────────────────────────────────────────────────────
  async function toggleRecording() {
    if (state.processing) {
      _setStatus('Aguarde: transcrição em andamento', 'err');
      return;
    }
    if (state.startingRecording) {
      // START is in flight — a second click arrives while the first await is
      // still pending (send can take 200-800ms through the content bridge).
      // state.recording is still false at this point, so the guard below would
      // not catch the duplicate. Drop the second click silently.
      return;
    }
    if (state.recording) {
      // STOP
      const r = await send('SIDEPANEL_STOP_RECORDING');
      if (!r || !r.ok) {
        // send() already showed a tab-related status if relevant. Only override
        // for genuinely-recording-specific failures so we don't clobber the
        // "Recarregue a aba do G-Hosp" hint with a generic "Falha ao parar".
        const err = r && r.error || '';
        if (!/g-hosp|inicializando/i.test(err)) {
          _setStatus('Falha ao parar: ' + (err || 'erro'), 'err');
        }
        return;
      }
      state.recording = false;
      _stopTimer();
      _hideWaveform();
      _setRecordBtn('processing', 'Transcrevendo...');
      _setStatus('Processando áudio...', 'loading');
      // The bridge will send back TOCAFICHADR_RECORDING_BLOB asynchronously
    } else {
      // START
      // CHRA-2166: don't start a recording we can't transcribe — surface the
      // "Backend indisponível" state now instead of letting the post-stop
      // transcription hang on a doomed network call.
      if (!_guardOnline()) return;
      state.startingRecording = true;
      const r = await send('SIDEPANEL_START_RECORDING');
      state.startingRecording = false;
      if (!r || !r.ok) {
        // Only label as a microphone error when it actually IS one — tab/bridge
        // problems already have clearer status text from send().
        const err = r && r.error || '';
        if (!/g-hosp|inicializando|tab/i.test(err)) {
          _setStatus('Microfone: ' + (err || 'erro'), 'err');
        }
        return;
      }
      // v3.3.0: previous SOAP is stale once a new recording starts — hide
      // the copy icon AND clear state.soapText so a stray click doesn't paste
      // old text into the wrong patient.
      state.soapText = '';
      _hideSoapCopyIcon();
      // Pin the recording to a specific G-Hosp tab. send() routes
      // SIDEPANEL_START_RECORDING via state.activeTabId (set inside
      // _findGhospTab), so by the time we're here that tab id is the
      // recording tab. The runtime.onMessage listener uses this to drop
      // BLOB/ERROR/WAVEFORM broadcasts from any other tab.
      state.recordingTabId = state.activeTabId;
      state.recording = true;
      _startTimer();
      // v3.3.0 — show the canvas + start the rAF render loop. The bridge
      // simultaneously kicks off the analyser-tap broadcaster on the content
      // side, so bins start flowing into state.waveformLastBins within ~33ms.
      _showWaveform();
      _startWaveformRender();
      _setRecordBtn('recording', 'Parar Gravação');
      _setStatus('Gravando...', 'loading');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Streaming SOAP via chrome.runtime.Port (v3.1.1+)
  // ─────────────────────────────────────────────────────────────────────────
  // Side-panel parallel of api-client.js streamSoap() (which lives in the
  // content-script context). Resolves with the complete SOAP string when the
  // backend sends [DONE]; rejects on SOAP_ERROR or unexpected disconnect.
  // onProgress is called with a running word count so the UI can animate.
  function _streamSoapViaPort(rawText, complaint, customInstr, activeVoice, onProgress) {
    return new Promise((resolve, reject) => {
      if (!chrome || !chrome.runtime || typeof chrome.runtime.connect !== 'function') {
        reject(new Error('Extensão recarregada — recarregue a página (F5)'));
        return;
      }
      let port;
      try {
        port = chrome.runtime.connect({ name: 'TOCAFICHADR_SOAP_STREAM' });
      } catch (err) {
        reject(err);
        return;
      }
      let buf = '';
      let settled = false;
      port.onMessage.addListener((m) => {
        if (!m) return;
        if (m.type === 'SOAP_TOKEN' && typeof m.t === 'string') {
          buf += m.t;
          // Whitespace-split for the counter — close enough for a status pill.
          // Avoids regex re-allocation on every token by checking length first.
          if (buf.length) {
            const trimmed = buf.trim();
            const count = trimmed ? trimmed.split(/\s+/).length : 0;
            try { onProgress && onProgress(count); } catch (_) {}
          }
        } else if (m.type === 'SOAP_DONE') {
          settled = true;
          try { port.disconnect(); } catch (_) {}
          resolve({
            soap: m.full || buf,
            providers: m.providers || null,
            timing: m.timing || null,
          });
        } else if (m.type === 'SOAP_ERROR') {
          settled = true;
          try { port.disconnect(); } catch (_) {}
          const err = new Error(m.error || 'stream failed');
          err.providers = m.providers || null;
          err.timing = m.timing || null;
          reject(err);
        }
      });
      port.onDisconnect.addListener(() => {
        if (!settled) reject(new Error('Conexão de streaming encerrada'));
      });
      try {
        port.postMessage({
          type: 'SOAP_STREAM_START',
          raw_text: rawText || '',
          chief_complaint: complaint || '',
          custom_instructions: customInstr || '',
          soap_voice: activeVoice || null,
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  // Triggered when the bridge forwards a recorded blob from G-Hosp.
  // Two-phase flow (v3.1.1):
  //   Phase A — POST /api/transcribe?skip_soap=1 → transcript + CID. Fill CID
  //             immediately so the chip populates before SOAP completes.
  //   Phase B — Open Port to TOCAFICHADR_SOAP_STREAM. Render token counter.
  //             Paste full SOAP into G-Hosp on SOAP_DONE.
  // Fallback: if streaming fails, POST /api/format-soap with the transcript
  // we already have, then paste. Never paste a half-written SOAP.
  async function _onRecordingBlob(msg) {
    state.processing = true;
    _setRecordBtn('processing', 'Transcrevendo...');
    _setStatus('', '');

    // Capture the intern ID at recording time. If the doctor switches patients
    // during the 5-30s transcription window, we must NOT paste the SOAP into
    // the new patient's form. Checked before SIDEPANEL_PASTE_SOAP below.
    const _capturedInternId = state.patientInfo && state.patientInfo.internId;

    // CHRA-1102: merge client timestamps from bridge into a single metadata object
    const clientTimestamps = msg.timestamps || {};

    try {
      // Reconstruct blob from base64 in the side panel.
      const bin = atob(msg.audioBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: msg.mimeType || 'audio/webm' });

      // Phase 03-03b: load active voice + custom instructions from userConfig
      // (server-backed) rather than chrome.storage.sync.
      const uc = window.TOCAFICHADR_userConfig;
      const ucfg = uc ? (await uc.getCached()) || {} : {};
      const voices = Array.isArray(ucfg.voices) ? ucfg.voices : [];
      const activeVoice = voices.find((v) => v.id === ucfg.active_voice_id) || null;
      const customInstr = ucfg.custom_instructions || '';
      const complaint   = (state.patientInfo && state.patientInfo.chiefComplaint) || '';

      // Side panel POSTs directly — chrome-extension:// origin is exempt from PNA.
      const auth = await chrome.storage.session.get(['authToken']);
      const headers = {};
      if (auth.authToken) headers['Authorization'] = 'Bearer ' + auth.authToken;

      // Fresh FormData per attempt — blobs in FormData can't always survive a
      // failed fetch + retry depending on Chrome version.
      const _buildFd = () => {
        const fd = new FormData();
        fd.append('audio', blob, 'recording.webm');
        if (complaint) fd.append('chief_complaint', complaint);
        if (customInstr) fd.append('custom_instructions', customInstr);
        if (activeVoice) fd.append('soap_voice', JSON.stringify(activeVoice));
        // CHRA-1102: build audio_metadata with client timestamps + audio config
        const audioMeta = {
          ...(msg.audioConfig || {}),
          client_timestamps: clientTimestamps,
        };
        try { fd.append('audio_metadata', JSON.stringify(audioMeta)); } catch (_) {}
        return fd;
      };

      const settings = await chrome.storage.sync.get(['apiBaseUrl']);
      let baseUrl = (settings.apiBaseUrl || _DEFAULT_API_BASE_URL).replace(/\/+$/, '');

      // ─── Phase A: transcript + CID (skip_soap) ──────────────────────────
      const _doTranscribe = async (skipSoap) => {
        const path = '/api/transcribe' + (skipSoap ? '?skip_soap=1' : '');
        // CHRA-1102: record upload start
        clientTimestamps.upload_start = Date.now();
        try {
          const resp = await fetch(baseUrl + path, {
            method: 'POST',
            body: _buildFd(),
            headers,
            signal: AbortSignal.timeout(30000),
          });
          // CHRA-1102: record upload done (headers received)
          clientTimestamps.upload_done = Date.now();
          return resp;
        } catch (netErr) {
          // Tunnel URL rotated — refresh from gist and retry once.
          _setStatus('Atualizando URL do servidor...', 'loading');
          const fresh = await _refreshApiBaseUrlFromGist();
          if (fresh && fresh !== baseUrl) {
            baseUrl = fresh;
            const resp = await fetch(baseUrl + path, {
              method: 'POST',
              body: _buildFd(),
              headers,
              signal: AbortSignal.timeout(30000),
            });
            clientTimestamps.upload_done = Date.now();
            return resp;
          }
          throw netErr;
        }
      };

      const resp = await _doTranscribe(true);
      if (!resp.ok) {
        let codeSuffix = '';
        if (resp.status === 429) {
          // Read the response body's `code` so _normalizeApiError can
          // distinguish RATE_LIMIT (transient) from USAGE_LIMIT (daily cap).
          try {
            const body = await resp.clone().json();
            if (body && body.code) codeSuffix = ' ' + body.code;
          } catch (_) { /* body not JSON — fall through */ }
          // Server-side caps are the authoritative source for the chip —
          // refresh on every 429 so the doctor's display matches reality
          // even if no successful transcribe followed.
          _refreshUsage();
        }
        throw new Error('HTTP ' + resp.status + codeSuffix);
      }
      const data = await resp.json();
      if (data && data.ok === false) {
        throw new Error(data.error || 'Transcrição falhou');
      }
      const transcript = (data && data.transcript) || '';
      if (!transcript.trim()) throw new Error('Transcrição vazia');

      // CID — fill immediately, before SOAP streaming completes (timing fix).
      const flatCid = data && data.cid_code
        ? { code: data.cid_code, name: data.cid_name || '' }
        : null;
      const nestedCid = data && data.cid && data.cid.code ? data.cid : null;
      state.suggestedCid = flatCid || nestedCid;

      // Phase 03-03b: autoCid lives in userConfig. Default true so the AI
      // suggestion still surfaces if the cache is empty (pre-hydrate).
      const _ucForAutoCid = window.TOCAFICHADR_userConfig;
      const _autoCidCfg = _ucForAutoCid ? (await _ucForAutoCid.getCached()) || {} : {};
      const autoCid = _autoCidCfg.auto_cid !== false;
      if (autoCid && state.suggestedCid && state.suggestedCid.code) {
        // v3.1.4: render the AI suggestion as a clickable card in the
        // suggestions list (with an "IA" badge so doctors can tell it apart
        // from search results). One click → pushed to the G-Hosp chart.
        // Don't auto-fill the search input or auto-push.
        _renderCidSuggestions([{
          code: state.suggestedCid.code,
          name: state.suggestedCid.name || '',
          isAi: true,
        }]);
      }

      // ─── Phase B: stream SOAP ──────────────────────────────────────────
      // v3.3.0 — show animated progress bar + tight word-count caption
      // instead of overwriting the status line on every token.
      _showProgress();
      _setStreamingStatus(0);
      let soap = '';
      try {
        const streamResult = await _streamSoapViaPort(transcript, complaint, customInstr, activeVoice, (count) => {
          _setStreamingStatus(count);
        });
        soap = (streamResult && streamResult.soap) || '';
      } catch (streamErr) {
        // Streaming failed mid-flight or upfront. Don't paste a half-written
        // SOAP into G-Hosp — fall back to the full /api/format-soap call with
        // the transcript we already have. One retry only; no nesting.
        console.warn('[Toca Ficha] streaming SOAP failed, falling back:', streamErr && streamErr.message);
        _hideProgress();
        _setStatus('Streaming indisponível, gerando SOAP completo...', 'loading');
        const fbResp = await fetch(baseUrl + '/api/format-soap', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
          body: JSON.stringify({
            raw_text: transcript,
            chief_complaint: complaint,
            custom_instructions: customInstr,
            soap_voice: activeVoice,
          }),
          signal: AbortSignal.timeout(30000),
        });
        if (!fbResp.ok) throw new Error('SOAP fallback HTTP ' + fbResp.status);
        const fbData = await fbResp.json();
        soap = (fbData && (fbData.formatted_soap || fbData.soap || fbData.text)) || '';
      }

      // v3.3.0 — Streaming finished (SOAP_DONE) or fallback resolved. Hide
      // the bar before painting the final status line so the layout shifts
      // cleanly back to the single-line status.
      _hideProgress();

      // Strip ```json ... ``` fences before pasting + clipboard write.
      // Both the streaming path and the format-soap fallback occasionally
      // produce fence-wrapped output — see _stripJsonFences for context.
      soap = _stripJsonFences(soap);
      state.soapText = soap;

      if (soap && soap.trim()) {
        // Guard: if the patient changed during transcription, skip the auto-paste.
        // The SOAP is still in state.soapText and the 📋 icon lets the doctor
        // copy it manually to the correct patient. A stale SOAP pasted into the
        // wrong patient chart is a clinical safety issue.
        const _currentInternId = state.patientInfo && state.patientInfo.internId;
        if (_capturedInternId && _currentInternId && _capturedInternId !== _currentInternId) {
          _showSoapCopyIcon({ warn: true });
          _setStatus('Paciente mudou durante gravação — SOAP gerado, use 📋 para colar', 'err');
          _setRecordBtn('done', 'Gravar Novamente');
          try { _bumpUsage('transcribe'); } catch (_) {}
          _refreshUsage();
          return;
        }

        // v3.2.0 — Bug A: bridge now propagates {ok, fieldsWritten, hasField0}
        // so we can detect "wrong sub-page / dialog open" cases. Don't trust
        // pasted.ok alone; require fieldsWritten > 0.
        const pasted = await send('SIDEPANEL_PASTE_SOAP', { soapText: soap });
        const chartOk = !!(pasted && pasted.ok && pasted.fieldsWritten > 0);

        // Auto-copy the SOAP. The side panel itself is usually unfocused when
        // SOAP_DONE arrives (doctor clicked back into G-Hosp 5-15s ago) and
        // its writeText would reject with NotAllowedError. Route through the
        // bridge first — the G-Hosp content-script context shares the focused
        // page document and can write to the clipboard. Fall back to the side
        // panel's own writeText (covers the rare case the doctor stayed on
        // the side panel). Last resort is the manual 📋 icon below.
        let clipboardOk = false;
        try {
          const r = await send('SIDEPANEL_COPY_CLIPBOARD', { text: soap });
          if (r && r.ok) clipboardOk = true;
        } catch (_) { /* fall through */ }
        if (!clipboardOk) {
          try { window.focus(); } catch (_) {}
          try {
            await navigator.clipboard.writeText(soap);
            clipboardOk = true;
          } catch (clipErr) {
            console.warn('[Toca Ficha] clipboard.writeText failed:', clipErr && clipErr.message);
            clipboardOk = false;
          }
        }

        // v3.3.0: the icon is a permanent, always-visible affordance after a
        // SOAP is generated. Default = green (subtle); auto-copy failure =
        // amber + pulse. Status text is short; the icon is the recovery path.
        if (chartOk && clipboardOk) {
          _showSoapCopyIcon({ warn: false });
          _setStatus('SOAP colado no G-Hosp ✓', 'ok');
        } else if (chartOk && !clipboardOk) {
          _showSoapCopyIcon({ warn: true });
          _setStatus('SOAP colado no G-Hosp ✓', 'ok');
        } else if (!chartOk && clipboardOk) {
          _showSoapCopyIcon({ warn: false });
          _setStatus('G-Hosp não recebeu — use o ícone 📋 ou Cmd+V', 'err');
        } else {
          _showSoapCopyIcon({ warn: true });
          _setStatus('SOAP gerado — clique 📋 para copiar', 'err');
        }
      } else {
        _hideSoapCopyIcon();
        _setStatus('SOAP vazio', 'err');
      }

      _setRecordBtn('done', 'Gravar Novamente');
      try { _bumpUsage('transcribe'); } catch (_) {}
      // Re-poll the server-side billable count so the chip reflects the
      // transcribe we just committed (free users approach the 5/day cap).
      _refreshUsage();
    } catch (err) {
      // v3.3.0 — hide bar + reset the streaming-flex layout before painting
      // the error so the status line renders as a normal one-liner.
      _hideProgress();
      // CHRA-2166: a network-unreachable failure (backend/tunnel down while the
      // OS is still online) must feed connectivity so the offline banner
      // self-activates and _guardOnline() blocks the NEXT doomed recording.
      // Without this, notifyReachable(false) was only ever called by the manual
      // "Tentar novamente" button — which lives inside a banner that only shows
      // when already offline (a dead feedback loop). Gated on _isNetworkDownError
      // so an HTTP 429/500 (server reachable) never false-flags offline.
      if (_isNetworkDownError(err)) {
        const c = _connectivity();
        if (c) c.notifyReachable(false);
      }
      _setStatus('Erro: ' + _normalizeApiError(err), 'err');
      _setRecordBtn('idle', 'Gravar Consulta');
    } finally {
      state.processing = false;
      setTimeout(() => {
        if (!state.recording && !state.processing) _setRecordBtn('idle', 'Gravar Consulta');
      }, 6000);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Time-saved analytics — mirror HUD's _bumpUsageStats
  // ─────────────────────────────────────────────────────────────────────────
  function _todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  async function _bumpUsage(actionType) {
    try {
      const data = await chrome.storage.local.get(['usageStats']);
      const stats = data.usageStats || {};
      const k = _todayKey();
      if (!stats[k]) stats[k] = {};
      stats[k][actionType] = (stats[k][actionType] || 0) + 1;
      const keys = Object.keys(stats).sort();
      while (keys.length > 30) delete stats[keys.shift()];
      await chrome.storage.local.set({ usageStats: stats });
    } catch (_) { /* analytics are best-effort */ }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Daily-usage chip — server-backed billable count, distinct from
  // _bumpUsage above which is local time-saved analytics. Calls the existing
  // /billing/subscription endpoint (already auth'd, already returns
  // {usage_today, daily_limit, plan, trial_active}) and renders the result
  // in #sp-usage-chip. Pro/hospital/trial users see no chip — daily_limit
  // is null in their payload. Failures (signed out, network) silently hide.
  // ─────────────────────────────────────────────────────────────────────────
  async function _refreshUsage() {
    const el = $('sp-usage-chip');
    if (!el) return;
    try {
      const auth = await chrome.storage.session.get(['authToken']);
      if (!auth.authToken) {
        _renderUsageChip(null);
        return;
      }
      const settings = await chrome.storage.sync.get(['apiBaseUrl']);
      const baseUrl = (settings.apiBaseUrl || _DEFAULT_API_BASE_URL).replace(/\/+$/, '');
      const resp = await fetch(baseUrl + '/billing/subscription', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + auth.authToken },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) { _renderUsageChip(null); return; }
      const data = await resp.json();
      _renderUsageChip(data);
    } catch (_) {
      _renderUsageChip(null);
    }
  }

  function _renderUsageChip(data) {
    const el = $('sp-usage-chip');
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
    el.classList.remove('sp-usage-near', 'sp-usage-at');
    // No data, no plan, or non-free plan / active trial → hide chip.
    if (!data || data.daily_limit == null) { el.hidden = true; return; }
    const used = Number(data.usage_today) || 0;
    const limit = Number(data.daily_limit) || 0;
    if (!limit) { el.hidden = true; return; }
    const remaining = Math.max(0, limit - used);
    const atLimit = used >= limit;
    const nearLimit = !atLimit && remaining <= 1;
    if (atLimit) el.classList.add('sp-usage-at');
    else if (nearLimit) el.classList.add('sp-usage-near');
    const count = document.createElement('span');
    count.className = 'sp-usage-count';
    count.textContent = used + '/' + limit;
    const label = document.createElement('span');
    label.textContent = atLimit ? 'limite diário atingido' : 'transcrições hoje';
    el.appendChild(count);
    el.appendChild(label);
    // Surface upgrade affordance at and near the cap. Opens the billing
    // landing page in a new tab — keeps the consultation in flight.
    if (atLimit || nearLimit) {
      const link = document.createElement('a');
      link.className = 'sp-usage-upgrade';
      link.textContent = atLimit ? 'Assinar Pro' : 'Upgrade';
      link.href = 'https://tocafichadr.com.br/';
      link.target = '_blank';
      link.rel = 'noopener';
      el.appendChild(link);
    }
    el.hidden = false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CID search
  // ─────────────────────────────────────────────────────────────────────────
  function _renderCidSuggestions(results) {
    const list = $('sp-cid-suggestions');
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    (results || []).forEach((r) => {
      const row = document.createElement('div');
      row.className = 'sp-cid-suggestion' + (r.isAi ? ' sp-cid-suggestion-ai' : '');
      if (r.isAi) {
        const badge = document.createElement('span');
        badge.className = 'sp-cid-ai-badge';
        badge.textContent = 'IA';
        row.appendChild(badge);
      }
      const code = document.createElement('span');
      code.className = 'sp-cid-code';
      code.textContent = r.code;
      const name = document.createElement('span');
      name.className = 'sp-cid-name';
      name.textContent = r.name;
      row.appendChild(code);
      row.appendChild(name);
      row.addEventListener('click', async () => {
        $('sp-cid-input').value = r.code + ' — ' + r.name;
        list.style.display = 'none';
        const resp = await send('SIDEPANEL_FILL_CID', { code: r.code, name: r.name });
        _setStatus(resp && resp.ok ? 'CID preenchido no G-Hosp ✓' : 'Falha ao preencher CID', resp && resp.ok ? 'ok' : 'err');
      });
      list.appendChild(row);
    });
    list.style.display = results && results.length ? '' : 'none';
  }

  function _wireCidSearch() {
    const input = $('sp-cid-input');
    if (!input) return;
    input.addEventListener('input', () => {
      clearTimeout(state.cidSearchTimer);
      const q = input.value.trim();
      if (q.length < 2) { _renderCidSuggestions([]); return; }
      state.cidSearchTimer = setTimeout(async () => {
        const r = await send('SIDEPANEL_SEARCH_CID', { query: q });
        _renderCidSuggestions(r && r.ok ? r.results : []);
      }, 200);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Prescription shortcuts — medication tiles, selected into a printable mix
  // ─────────────────────────────────────────────────────────────────────────
  function _migrateLegacyTemplate(t) {
    if (!t) return t;
    if (t.diagnosis !== undefined) {
      // v3.4.0 — preserve smart-template fields when present so the side
      // panel sees the same shape the popup wrote. Legacy { body } templates
      // don't carry meds/extraText, so we omit those keys to avoid bloating
      // chrome.storage.sync with `undefined` values.
      const out = {
        id: t.id,
        diagnosis: t.diagnosis,
        ageBand: t.ageBand,
        body: t.body || '',
        frequency: t.frequency || 0,
      };
      if (Array.isArray(t.meds)) out.meds = t.meds;
      if (t.extraText !== undefined) out.extraText = t.extraText;
      return out;
    }
    const name = String(t.name || '').trim();
    const m = name.match(/^(.+?)\s+([<>≥≤]\s*\d+\s*[mad]?(?:\s+e\s+[<>≥≤]\s*\d+\s*[mad]?)?|qualquer|adulto)\s*$/i);
    if (m) return { id: t.id, diagnosis: m[1].trim(), ageBand: m[2].trim(), body: t.body || '', frequency: t.frequency || 0 };
    return { id: t.id, diagnosis: name || 'Modelo', ageBand: '', body: t.body || '', frequency: t.frequency || 0 };
  }

  // v3.4.0 — A template is "smart" iff it has at least one med ref. Smart
  // templates render via the dosages catalog (per-patient computed doses).
  // Legacy templates (body only) keep the original Simples flow unchanged.
  function _isSmartTemplate(t) {
    return !!(t && Array.isArray(t.meds) && t.meds.length > 0);
  }

  function _templateNeedsDosages(t) {
    return !!(t && Array.isArray(t.meds) && t.meds.some((m) => m && m.medId));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // v3.4.0 — Smart-template dosages catalog + render
  // ─────────────────────────────────────────────────────────────────────────
  // Backend contract:
  //   GET /api/dosages/full?weight=W&type=both
  //     → { pediatric: [...], adult: [...] }
  // Each entry: { id, name, category, frequency, duration, presentation,
  //               notes, daily_dose_mg, per_dose_mg, per_dose_ml,
  //               per_dose_drops, practical, is_adult }
  //
  // We cache by exact weight — a 12kg child and a 12.5kg child get separate
  // calls (the server returns slightly different practical strings). For the
  // typical doctor flow (open patient → click template), this is one fetch
  // per patient session; subsequent template clicks reuse the cache.
  async function _fetchDosagesCatalog(weight) {
    const w = Number(weight);
    if (!Number.isFinite(w) || w <= 0) return null;

    // Hot cache: same weight + we already have data → reuse.
    if (state.dosagesCache && state.dosagesCache.weight === w && state.dosagesCache.data) {
      return state.dosagesCache.data;
    }
    // Concurrent in-flight call for the same weight → join its promise.
    if (state.dosagesCache && state.dosagesCache.weight === w && state.dosagesCache.fetchPromise) {
      return state.dosagesCache.fetchPromise;
    }

    const fetchPromise = (async () => {
      console.log('[Toca Ficha] fetching dosages catalog for weight:', w);
      const settings = await chrome.storage.sync.get(['apiBaseUrl']);
      let baseUrl = (settings.apiBaseUrl || _DEFAULT_API_BASE_URL).replace(/\/+$/, '');

      const auth = await chrome.storage.session.get(['authToken']);
      const headers = {};
      if (auth.authToken) headers['Authorization'] = 'Bearer ' + auth.authToken;

      const url = baseUrl + '/api/dosages/full?weight=' + encodeURIComponent(w) + '&type=both';
      try {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        if (!data || (!Array.isArray(data.pediatric) && !Array.isArray(data.adult))) {
          throw new Error('payload sem listas pediatric/adult');
        }
        state.dosagesCache = { weight: w, data, ts: Date.now() };
        return data;
      } catch (netErr) {
        // Tunnel rotated — refresh from gist and retry once.
        const fresh = await _refreshApiBaseUrlFromGist();
        if (fresh && fresh !== baseUrl) {
          baseUrl = fresh;
          try {
            const r2 = await fetch(baseUrl + '/api/dosages/full?weight=' + encodeURIComponent(w) + '&type=both', {
              headers, signal: AbortSignal.timeout(8000),
            });
            if (r2.ok) {
              const data2 = await r2.json();
              if (data2 && (Array.isArray(data2.pediatric) || Array.isArray(data2.adult))) {
                state.dosagesCache = { weight: w, data: data2, ts: Date.now() };
                return data2;
              }
            }
          } catch (_) { /* retry failed silently */ }
        }
        console.warn('[Toca Ficha] dosages catalog fetch failed:', netErr && netErr.message);
        // Drop the in-flight marker so a future click can retry. We don't
        // store data:null in the cache on failure — keep the door open.
        state.dosagesCache = null;
        return null;
      }
    })();

    // Park the in-flight promise so concurrent callers for the same weight
    // join it instead of racing.
    state.dosagesCache = { weight: w, fetchPromise };
    return fetchPromise;
  }

  function _findMedInCatalog(medId, dosages) {
    if (!dosages) return null;
    if (Array.isArray(dosages.pediatric)) {
      const p = dosages.pediatric.find((m) => m && m.id === medId);
      if (p) return p;
    }
    if (Array.isArray(dosages.adult)) {
      const a = dosages.adult.find((m) => m && m.id === medId);
      if (a) return a;
    }
    return null;
  }

  /**
   * _renderSmartTemplate — produces the prescription text for a smart template
   * given the patient context and the per-weight dosages catalog.
   *
   * Per-med block (2 lines + blank):
   *   {name} {presentation}
   *   {practical} VO {freq}{when} por {duration}
   *
   * - `when` is prefixed with a leading space when present (e.g. " se febre")
   * - `duration` is prefixed with " por " when present
   * - Template-level overrides (m.freq / m.duration) win over catalog defaults
   *   so the doctor can adapt one med per template without touching others.
   *
   * Variable substitution on extraText:
   *   ${weight}        → "{N} kg" or "[peso?]" if weight unknown
   *   ${age}           → patient.age or "[idade?]" (age is not yet extracted
   *                      from G-Hosp; placeholder keeps the doctor honest)
   *   ${patient_name}  → patient.name or "[paciente?]"
   *
   * The "[?]" placeholders are deliberately ugly so the doctor sees them in
   * the preview and either fills them in or removes the variable from the
   * extraText. Empty-string substitution would silently produce wrong text.
   */
  function _renderSmartTemplate(template, patient, dosages) {
    const lines = [];
    const meds = Array.isArray(template.meds) ? template.meds : [];
    for (const m of meds) {
      const medId = m.medId && String(m.medId).trim();
      const med = medId ? _findMedInCatalog(medId, dosages) : null;
      const manualName = String(m.name || m.manualName || '').trim();
      if (!med && !manualName) {
        lines.push('[Medicação ' + (medId || '?') + ' não encontrada — atualize o catálogo]');
        lines.push('');
        continue;
      }
      const freq = (m.freq && m.freq.trim()) || (med && med.frequency) || '';
      const dur = (m.duration && m.duration.trim()) || (med && med.duration) || '';
      const when = (m.when && m.when.trim()) ? ' ' + m.when.trim() : '';
      const presentationRaw = (m.presentation && m.presentation.trim()) || (med && med.presentation) || '';
      const presentation = presentationRaw ? ' ' + presentationRaw : '';
      const practical = (m.dose && m.dose.trim()) || (med && med.practical) || '';
      lines.push(((med && med.name) || manualName || medId) + presentation);
      let line2 = practical;
      if (line2) line2 += ' VO';
      else line2 = 'VO';
      if (freq) line2 += ' ' + freq;
      if (when) line2 += when;
      // Duration formatting:
      //   - Numeric durations ("5 dias", "7-10 dias") → "por 5 dias"
      //   - "SN" (Se Necessário) → never read as "por SN". If a when-clause
      //     exists ("se febre ou dor"), the SN is redundant — skip it. With
      //     no when-clause, expand to "se necessário" so the parent reading
      //     the prescription understands the as-needed semantics.
      //   - "—" sentinel → skipped (legacy "no duration" marker)
      if (dur && dur !== '—') {
        const trimmed = dur.trim();
        if (/^sn$/i.test(trimmed)) {
          if (!when) line2 += ' se necessário';
        } else {
          line2 += ' por ' + trimmed;
        }
      }
      lines.push(line2.trim());
      // Inline notes (e.g. "tomar com alimento") rendered as a 3rd line.
      if (m.notes && m.notes.trim()) lines.push(m.notes.trim());
      lines.push('');
    }

    // Variable substitution — see docblock above for placeholder rationale.
    let extra = template.extraText || '';
    const weightStr = (patient && patient.weight) ? (patient.weight + ' kg') : '[peso?]';
    const ageStr = (patient && patient.age) ? String(patient.age) : '[idade?]';
    const nameStr = (patient && patient.name) ? String(patient.name) : '[paciente?]';
    extra = extra.replace(/\$\{weight\}/g, weightStr);
    extra = extra.replace(/\$\{age\}/g, ageStr);
    extra = extra.replace(/\$\{patient_name\}/g, nameStr);
    if (extra.trim()) {
      lines.push(extra.trim());
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function _bumpFrequency(tplId) {
    // Phase 03-03: templates live server-side via userConfig. Bump frequency
    // in the cached config and write-through via userConfig.patch (debounced).
    const uc = window.TOCAFICHADR_userConfig;
    if (!uc) return;
    uc.getCached().then((cfg) => {
      const arr = Array.isArray(cfg && cfg.rx_templates)
        ? cfg.rx_templates.slice().map(_migrateLegacyTemplate)
        : [];
      const t = arr.find((x) => x.id === tplId);
      if (!t) return;
      t.frequency = (t.frequency || 0) + 1;
      uc.patch({ rx_templates: arr });
    });
  }

  function _rxTemplateLabel(tpl) {
    return String((tpl && (tpl.diagnosis || tpl.name || tpl.label)) || 'Medicamento').trim() || 'Medicamento';
  }

  function _rxTemplateSubtitle(tpl) {
    if (!tpl) return '—';
    if (_isSmartTemplate(tpl)) {
      const meds = Array.isArray(tpl.meds) ? tpl.meds : [];
      if (meds.length > 1) return meds.length + ' medicações';
      const m = meds[0] || {};
      const parts = [];
      if (m.dose && String(m.dose).trim()) parts.push(String(m.dose).trim());
      if (m.freq && String(m.freq).trim()) parts.push(String(m.freq).trim());
      if (m.duration && String(m.duration).trim()) parts.push(String(m.duration).trim());
      if (m.when && String(m.when).trim()) parts.push(String(m.when).trim());
      if (parts.length) return parts.join(' · ');
      return String(tpl.ageBand || 'dose padrão').trim();
    }
    const bodyFirstLine = String(tpl.body || '').split('\n').find((line) => line.trim());
    return String(tpl.ageBand || bodyFirstLine || 'texto livre').trim();
  }

  function _updateRxMixButton() {
    const btn = $('sp-rx-print-btn');
    if (!btn) return;
    const count = state.selectedRxTemplateIds ? state.selectedRxTemplateIds.size : 0;
    btn.disabled = count === 0 || state.rxRunning || state.rxFinalizing || state.finalizing;
    btn.title = count ? count + ' medicamento(s) selecionado(s)' : 'Selecione pelo menos um medicamento';
  }

  function _toggleRxTemplateSelection(tplId) {
    if (!tplId || state.rxRunning || state.rxFinalizing) return;
    if (state.pendingPreview) _hideRxPreview();
    if (state.selectedRxTemplateIds.has(tplId)) state.selectedRxTemplateIds.delete(tplId);
    else state.selectedRxTemplateIds.add(tplId);
    _renderTemplates();
    _updateRxMixButton();
  }

  function _getConfiguredRxTemplates(cfg) {
    const raw = Array.isArray(cfg && cfg.rx_templates) ? cfg.rx_templates : [];
    return raw.map(_migrateLegacyTemplate).filter((tpl) => {
      if (!tpl) return false;
      if (_isSmartTemplate(tpl)) return true;
      return !!(tpl.body && String(tpl.body).trim());
    });
  }

  function _renderTemplates() {
    const grid = $('sp-templates');
    const empty = $('sp-rx-empty');
    if (!grid) return;
    while (grid.firstChild) grid.removeChild(grid.firstChild);
    const uc = window.TOCAFICHADR_userConfig;
    if (!uc) {
      if (empty) empty.style.display = '';
      _updateRxMixButton();
      return;
    }
    uc.getCached().then((cfg) => {
      const tpls = _getConfiguredRxTemplates(cfg);
      const liveIds = new Set(tpls.map((tpl) => tpl.id));
      Array.from(state.selectedRxTemplateIds).forEach((id) => {
        if (!liveIds.has(id)) state.selectedRxTemplateIds.delete(id);
      });
      if (empty) empty.style.display = tpls.length ? 'none' : '';
      // v3.1.2: stable insertion order — no frequency sort. Cards stay in the
      // same position every render so muscle memory works. Frequency is still
      // tracked silently for future analytics but doesn't reorder the grid.
      tpls.forEach((tpl) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sp-act-btn sp-rx-med-btn';
        if (state.selectedRxTemplateIds.has(tpl.id)) btn.classList.add('active');
        btn.dataset.tplId = tpl.id;
        const name = document.createElement('span');
        name.className = 'sp-rx-med-name';
        name.textContent = _rxTemplateLabel(tpl);
        const dose = document.createElement('span');
        dose.className = 'sp-rx-med-dose';
        dose.textContent = _rxTemplateSubtitle(tpl) || '—';
        btn.appendChild(name);
        btn.appendChild(dose);
        btn.addEventListener('click', () => _toggleRxTemplateSelection(tpl.id));
        grid.appendChild(btn);
      });
      _updateRxMixButton();
    }).catch(() => {
      // getCached() failure — grid was already cleared (line above). Show the
      // empty state so the doctor sees a clear "no templates" message rather
      // than a silently blank grid with no affordance.
      if (empty) empty.style.display = '';
      _updateRxMixButton();
    });
  }

  async function _composeSelectedRxText() {
    const uc = window.TOCAFICHADR_userConfig;
    if (!uc) throw new Error('config indisponível');
    const cfg = await uc.getCached();
    const tpls = _getConfiguredRxTemplates(cfg)
      .filter((tpl) => tpl && state.selectedRxTemplateIds.has(tpl.id));
    if (!tpls.length) return '';

    const patient = state.patientInfo || {};
    const needsDosages = tpls.some(_templateNeedsDosages);
    let dosages = null;
    if (needsDosages) {
      const weightForFetch = patient.weight && patient.weight > 0 ? patient.weight : 70;
      console.log('[Toca Ficha] composing rx for weight:', weightForFetch, 'kg (patientInfo.weight=', patient.weight, ')');
      dosages = await _fetchDosagesCatalog(weightForFetch);
      if (!dosages) throw new Error('não foi possível buscar doses');
    }

    const blocks = [];
    for (const tpl of tpls) {
      if (_isSmartTemplate(tpl)) {
        const rendered = _renderSmartTemplate(tpl, patient, dosages);
        if (rendered && rendered.trim()) blocks.push(rendered.trim());
      } else if (tpl.body && String(tpl.body).trim()) {
        blocks.push(String(tpl.body).trim());
      }
    }
    return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  async function _runSelectedRxMix() {
    if (state.finalizing) { _setStatus('Aguarde alta', 'err'); return; }
    if (state.rxRunning) return;
    if (!state.selectedRxTemplateIds || state.selectedRxTemplateIds.size === 0) {
      _setStatus('Selecione pelo menos um medicamento', 'err');
      return;
    }

    const btn = $('sp-rx-print-btn');
    state.rxRunning = true;
    if (btn) btn.disabled = true;
    try {
      _setStatus('Montando receita...', 'loading');
      const body = await _composeSelectedRxText();
      if (!body) {
        _setStatus('Nenhum texto de receita gerado', 'err');
        return;
      }

      _setStatus('Abrindo receita...', 'loading');
      const r = await send('SIDEPANEL_RUN_SIMPLES_WITH_BODY', { body });
      if (r && r.ok) {
        // v3.5.1 — single-button flow: auto-save + print after pasting.
        // The doctor already reviewed the medication selection; G-Hosp's
        // Simples editor is a pass-through before the print page.
        _setStatus('Salvando e imprimindo...', 'loading');
        state.rxFinalizing = true;
        _updateRxMixButton();
        const fr = await send('SIDEPANEL_FINALIZE_PRESCRIPTION');
        state.rxFinalizing = false;
        if (fr && fr.ok) {
          document.querySelectorAll('.sp-template-btn, .sp-rx-med-btn').forEach((b) => b.classList.remove('active'));
          if (state.selectedRxTemplateIds) state.selectedRxTemplateIds.clear();
          _updateRxMixButton();
          _setStatus('Receita salva e impressa ✓', 'ok');
          try { _bumpUsage('rxClick'); } catch (_) {}
        } else {
          _setStatus('Falha ao salvar/imprimir: ' + (fr && fr.error || 'erro'), 'err');
        }
      } else {
        _setStatus('Falha: ' + (r && r.error || 'erro'), 'err');
      }
    } catch (err) {
      console.warn('[Toca Ficha] medication mix failed:', err && err.message);
      _setStatus('Falha: ' + ((err && err.message) || 'erro'), 'err');
    } finally {
      state.rxRunning = false;
      state.rxFinalizing = false;
      _updateRxMixButton();
    }
  }

  function _wireRxMix() {
    const btn = $('sp-rx-print-btn');
    if (!btn || btn.dataset.rxMixWired === '1') return;
    btn.dataset.rxMixWired = '1';
    btn.addEventListener('click', _runSelectedRxMix);
    _updateRxMixButton();
  }

  async function _runTemplate(tpl, btn) {
    if (state.finalizing) { _setStatus('Aguarde alta', 'err'); return; }
    if (state.rxRunning) return;
    state.rxRunning = true;
    btn.disabled = true;
    document.querySelectorAll('.sp-template-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');

    try {
      // v3.1.2: still track frequency for analytics, but render order is now
      // stable — no re-sort. Skip the storage write entirely; the render won't
      // reorder, and bumping frequency in storage triggers a re-render via the
      // onChanged listener which loses the active highlight. Use local-only
      // bump for the time-saved counter.
      _bumpUsage('rxClick');

      // v3.4.0 — branch on smart vs legacy. Smart templates render via the
      // dosages catalog and surface a preview drawer; the doctor confirms the
      // (possibly edited) text, then we drive the existing Simples flow with
      // the rendered body. Legacy templates run the unchanged direct path.
      //
      // Smart-template path manages its own rxRunning lifetime: the drawer
      // stays open and the template button stays "active" until the doctor
      // clicks Cancel or Apply. We re-enable the button immediately so the
      // doctor can pick a different template (which closes the drawer + resets).
      if (_isSmartTemplate(tpl)) {
        _runSmartTemplate(tpl, btn).catch((err) => {
          console.warn('[Toca Ficha] smart template failed:', err && err.message);
          _setStatus('Falha: ' + (err && err.message || 'erro inesperado'), 'err');
        });
        return;
      }

      _setStatus('Abrindo receita...', 'loading');
      const r = await send('SIDEPANEL_RUN_TEMPLATE', { template: tpl });
      if (r && r.ok) {
        const bar = $('sp-rx-finalize-bar');
        if (bar) bar.style.display = '';
        _setStatus('Revise no G-Hosp e clique em Salvar e Imprimir', 'ok');
      } else {
        _setStatus('Falha: ' + (r && r.error || 'erro'), 'err');
      }
    } finally {
      state.rxRunning = false;
      btn.disabled = false;
    }
  }

  /**
   * v3.4.0 — Smart template apply path.
   * 1. Fetch (or reuse cached) dosages catalog for the patient's weight.
   * 2. Render the meds + extraText with variable substitution.
   * 3. Show the preview drawer; the doctor edits and confirms.
   * 4. On Apply → drive the existing Simples flow with the rendered body.
   *
   * If weight is missing we still try to render (the backend may compute
   * sensible defaults); the catalog fetch falls back to a 70kg call so the
   * doctor at least sees the med structure rather than getting blocked.
   */
  async function _runSmartTemplate(tpl, btn) {
    const patient = state.patientInfo || {};
    // Use a generic 70kg fallback when patient weight is unknown so the
    // catalog still returns something — the rendered text will surface the
    // [peso?] placeholder via extraText so the doctor sees the gap.
    const weightForFetch = patient.weight && patient.weight > 0 ? patient.weight : 70;
    _setStatus('Calculando doses...', 'loading');
    const dosages = await _fetchDosagesCatalog(weightForFetch);
    if (!dosages) {
      _setStatus('Falha ao buscar catálogo de doses (offline?)', 'err');
      return;
    }
    const rendered = _renderSmartTemplate(tpl, patient, dosages);
    state.pendingPreview = { templateId: tpl.id, originalText: rendered };
    _showRxPreview(rendered, weightForFetch);
    _setStatus('Revise a receita gerada e clique em Aplicar', '');
  }

  /**
   * Show the preview drawer with the rendered prescription text, prefilled
   * into an editable textarea so the doctor can tweak before applying.
   */
  function _showRxPreview(text, weight) {
    const drawer = $('sp-rx-preview-drawer');
    const textarea = $('sp-rx-preview-text');
    const label = $('sp-rx-preview-label');
    if (!drawer || !textarea) return;
    textarea.value = text || '';
    if (label) {
      const wTxt = state.patientInfo && state.patientInfo.weight
        ? state.patientInfo.weight + ' kg'
        : weight + ' kg (estimado)';
      label.textContent = 'Receita gerada (peso ' + wTxt + ')';
    }
    drawer.style.display = '';
    // Auto-focus so doctor can immediately edit / Tab away.
    setTimeout(() => textarea.focus(), 30);
  }

  function _hideRxPreview() {
    const drawer = $('sp-rx-preview-drawer');
    if (drawer) drawer.style.display = 'none';
    state.pendingPreview = null;
  }

  function _wireRxPreview() {
    const cancelBtn = $('sp-rx-preview-cancel');
    const applyBtn = $('sp-rx-preview-apply');
    const textarea = $('sp-rx-preview-text');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        _hideRxPreview();
        document.querySelectorAll('.sp-template-btn').forEach((b) => b.classList.remove('active'));
        _setStatus('', '');
      });
    }
    if (applyBtn) {
      applyBtn.addEventListener('click', async () => {
        if (!state.pendingPreview) return;
        const body = textarea ? textarea.value : state.pendingPreview.originalText;
        applyBtn.disabled = true;
        _setStatus('Abrindo receita...', 'loading');
        try {
          const r = await send('SIDEPANEL_RUN_SIMPLES_WITH_BODY', { body });
          if (r && r.ok) {
            _hideRxPreview();
            const bar = $('sp-rx-finalize-bar');
            if (bar) bar.style.display = '';
            _setStatus('Revise no G-Hosp e clique em Salvar e Imprimir', 'ok');
          } else {
            _setStatus('Falha: ' + (r && r.error || 'erro'), 'err');
          }
        } finally {
          // Guarantee the button re-enables even if send() throws — without
          // this, an uncaught rejection leaves applyBtn permanently disabled.
          applyBtn.disabled = false;
        }
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // v3.1.8 — G-Hosp server-side template catalog
  // ─────────────────────────────────────────────────────────────────────────
  //
  // Storage shape (chrome.storage.sync.ghospTemplateCatalog):
  //   {
  //     "/prconsultas/12345/edit": [
  //       { id: "637", label: "OMA amoxi" },
  //       { id: "1079", label: "Resfriado >6m" },
  //       { id: "1084", label: "Amoxicilina 50mg/kg/dia 8/8h 7d" }
  //     ],
  //     "/altas/12345/edit?tipo_consulta=adulto": [
  //       { id: "637", label: "Laringotraqueíte viral" }
  //     ]
  //   }
  //
  // The same numeric id (e.g. 637) intentionally maps to different labels
  // across urlKeys — G-Hosp scopes templates by consultation type. Doctors
  // populate one urlKey at a time by clicking "🔄 Sincronizar" while on that
  // page; afterwards, button rendering is keyed by `state.urlKey`.

  function _setUrlKey(urlKey) {
    if (urlKey === state.urlKey) return;
    state.urlKey = urlKey;
    _renderGhospTemplates();
  }

  function _ghospStatus(text, kind) {
    const el = $('sp-ghosp-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'scribe-status' + (kind ? ' ' + kind : '');
    el.style.minHeight = text ? '14px' : '0';
  }

  function _renderGhospTemplates() {
    const grid = $('sp-ghosp-templates');
    const empty = $('sp-ghosp-empty');
    if (!grid) return;
    while (grid.firstChild) grid.removeChild(grid.firstChild);

    chrome.storage.sync.get(['ghospTemplateCatalog'], (data) => {
      const catalog = (data && data.ghospTemplateCatalog) || {};
      const key = state.urlKey;
      const list = (key && Array.isArray(catalog[key])) ? catalog[key] : [];

      if (!list.length) {
        if (empty) empty.style.display = '';
        return;
      }
      if (empty) empty.style.display = 'none';

      list.forEach((tpl) => {
        if (!tpl || !tpl.id) return;
        const btn = document.createElement('button');
        btn.className = 'sp-template-btn';
        btn.dataset.tplId = tpl.id;
        btn.title = (tpl.label || '') + ' (G-Hosp #' + tpl.id + ')';
        const dx = document.createElement('div');
        dx.className = 'sp-tpl-dx';
        dx.textContent = (tpl.label || ('Modelo ' + tpl.id)).trim();
        const ag = document.createElement('div');
        ag.className = 'sp-tpl-age';
        ag.textContent = '#' + tpl.id;
        btn.appendChild(dx); btn.appendChild(ag);
        btn.addEventListener('click', () => _runGhospTemplate(tpl, btn));
        grid.appendChild(btn);
      });
    });
  }

  async function _runGhospTemplate(tpl, btn) {
    if (state.finalizing) { _ghospStatus('Aguarde alta', 'err'); return; }
    if (state.ghospRunning) return;
    state.ghospRunning = true;
    btn.disabled = true;
    document.querySelectorAll('#sp-ghosp-templates .sp-template-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');

    try {
      _ghospStatus('Executando modelo G-Hosp…', 'loading');
      const r = await send('SIDEPANEL_RUN_GHOSP_TEMPLATE', { templateId: tpl.id });
      if (r && r.ok) {
        _ghospStatus('Modelo executado e impresso ✓', 'ok');
        try { _bumpUsage('ghospTemplate'); } catch (_) {}
      } else {
        _ghospStatus('Falha: ' + ((r && r.error) || 'erro'), 'err');
      }
    } finally {
      state.ghospRunning = false;
      btn.disabled = false;
      btn.classList.remove('active');
    }
  }

  async function _syncGhospTemplates() {
    if (state.ghospProbing) return;
    const btn = $('sp-ghosp-sync-btn');
    state.ghospProbing = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Sincronizando…';
    }
    _ghospStatus('Abrindo diálogo de padrões…', 'loading');

    try {
      const r = await send('SIDEPANEL_PROBE_GHOSP_TEMPLATES');
      if (!r || !r.ok) {
        _ghospStatus('Falha: ' + ((r && r.error) || 'erro'), 'err');
        return;
      }
      const templates = Array.isArray(r.templates) ? r.templates : [];
      const urlKey = r.urlKey || state.urlKey;
      if (!urlKey) {
        _ghospStatus('Sem URL de consulta — abra um prontuário', 'err');
        return;
      }
      if (!templates.length) {
        _ghospStatus('Nenhum padrão encontrado nesta página', 'err');
        return;
      }

      // Persist into chrome.storage.sync.ghospTemplateCatalog[urlKey].
      // Promisified (inner try/catch) so the outer finally — which resets
      // ghospProbing and re-enables the button — only fires AFTER the full
      // storage write completes. Without this, a rapid double-tap after the
      // await above would pass the guard, dispatch two concurrent probes, and
      // produce a storage-write race.
      try {
        await new Promise((resolve, reject) => {
          chrome.storage.sync.get(['ghospTemplateCatalog'], (data) => {
            const catalog = (data && data.ghospTemplateCatalog) || {};
            catalog[urlKey] = templates.map((t) => ({ id: String(t.id), label: String(t.label || '') }));
            chrome.storage.sync.set({ ghospTemplateCatalog: catalog }, () => {
              if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
              }
              // Adopt the freshly-probed urlKey so the render reflects the catalog
              // for *this* consultation context (in case the bridge hadn't broadcast
              // a patient_changed event for it yet).
              state.urlKey = urlKey;
              _ghospStatus(templates.length + ' modelos sincronizados ✓', 'ok');
              _renderGhospTemplates();
              resolve();
            });
          });
        });
      } catch (storageErr) {
        _ghospStatus('Erro ao salvar: ' + (storageErr.message || storageErr), 'err');
      }
    } finally {
      state.ghospProbing = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🔄 Sincronizar templates do G-Hosp';
      }
    }
  }

  function _wireGhospSync() {
    const btn = $('sp-ghosp-sync-btn');
    if (btn) btn.addEventListener('click', _syncGhospTemplates);
  }

  function _wireRxFinalize() {
    const btn = $('sp-rx-finalize-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (state.rxFinalizing) return;
      state.rxFinalizing = true;
      btn.disabled = true;
      _updateRxMixButton();
      _setStatus('Salvando e imprimindo receita...', 'loading');
      try {
        const r = await send('SIDEPANEL_FINALIZE_PRESCRIPTION');
        if (r && r.ok) {
          $('sp-rx-finalize-bar').style.display = 'none';
          document.querySelectorAll('.sp-template-btn, .sp-rx-med-btn').forEach((b) => b.classList.remove('active'));
          if (state.selectedRxTemplateIds) state.selectedRxTemplateIds.clear();
          _updateRxMixButton();
          _setStatus('Receita salva e impressa ✓', 'ok');
        } else {
          _setStatus('Falha ao salvar/imprimir', 'err');
        }
      } finally {
        state.rxFinalizing = false;
        btn.disabled = false;
        _updateRxMixButton();
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Action buttons
  // ─────────────────────────────────────────────────────────────────────────
  function _wireActions() {
    const saveBtn = $('sp-act-save');
    const rxBtn = $('sp-act-rx');
    const atestadoBtn = $('sp-act-atestado');
    const bauBtn = $('sp-act-bau');

    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        if (saveBtn.disabled) return;
        _clearRetryState('sp-act-save');
        _setStatus('Salvando...', 'loading');
        try {
          const r = await _runActionWithRetry('sp-act-save', () => send('SIDEPANEL_SAVE_FORM'), 'Salvar Prontuário');
          _setStatus(r && r.ok ? 'Prontuário salvo ✓' : 'Não encontrei o formulário', r && r.ok ? 'ok' : 'err');
        } catch (err) {
          _setStatus('Falha ao salvar — clique para tentar novamente', 'err');
        }
      });
    }

    if (rxBtn) {
      rxBtn.addEventListener('click', async () => {
        if (rxBtn.disabled) return;
        _clearRetryState('sp-act-rx');
        _setStatus('Abrindo receita...', 'loading');
        try {
          const r = await _runActionWithRetry('sp-act-rx', () => send('SIDEPANEL_OPEN_PRESCRIPTION'), 'Abrir Receita');
          _setStatus(r && r.ok ? 'Receita aberta ✓' : 'Botão de receita não encontrado', r && r.ok ? 'ok' : 'err');
        } catch (err) {
          _setStatus('Falha ao abrir receita — clique para tentar novamente', 'err');
        }
      });
    }

    // v3.4.0 — the Atestado action button now toggles a drawer (days +
    // companion picker) instead of running openAtestado directly. The CTA
    // inside the drawer drives the full end-to-end run.
    if (atestadoBtn) {
      atestadoBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (atestadoBtn.disabled) return;
        _toggleAtestadoDrawer();
      });
    }

    if (bauBtn) {
      bauBtn.addEventListener('click', async () => {
        if (bauBtn.disabled) return;
        _clearRetryState('sp-act-bau');
        try {
          const r = await _runActionWithRetry('sp-act-bau', () => send('SIDEPANEL_OPEN_BAU_MEDICO'), 'Baú Médico');
          _setStatus(r && r.ok ? 'Baú Médico aberto ✓' : 'Falha (intern_id?)', r && r.ok ? 'ok' : 'err');
        } catch (err) {
          _setStatus('Falha ao abrir baú — clique para tentar novamente', 'err');
        }
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // v3.4.0 — Atestado drawer (days + companion + full-flow CTA)
  //
  // The drawer replaces the old single-click Atestado button. State machine:
  //   - Drawer opens on Atestado action button click. Loads persisted days
  //     + companion toggle from chrome.storage.sync.
  //   - User picks days (chips 1-6 or Outro→numeric input) and toggles
  //     companion mode.
  //   - CTA "Gerar e imprimir N dia(s)" fires SIDEPANEL_RUN_ATESTADO_FULL
  //     which drives the full G-Hosp atestado flow end-to-end. Drawer shows
  //     "Gerando atestado…" status during the run.
  //   - On success the drawer closes; on failure it stays open with an error
  //     message so the doctor can retry.
  //   - Outer-click closes the drawer (preserving choices).
  // ─────────────────────────────────────────────────────────────────────────
  function _setAtestadoStatus(text, kind) {
    const el = $('sp-atestado-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'sp-atestado-status' + (kind ? ' ' + kind : '');
  }

  function _updateAtestadoCta() {
    const cta = $('sp-atestado-cta');
    if (!cta) return;
    const n = state.atestadoDays || 1;
    cta.textContent = 'Gerar e imprimir ' + n + ' dia' + (n === 1 ? '' : 's');
  }

  function _renderCompanionInfo() {
    // Populate the parent name lines under the companion chips. Filters by
    // the active mode so 'mae' shows only Mãe, 'pai' shows only Pai, and
    // 'outro' shows both — matching what gets written to #presatestado_obs.
    // Mode null (patient-only) renders nothing.
    const box = $('sp-atestado-companion-info');
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    if (state.atestadoCompanionMode === null) return;

    send('SIDEPANEL_GET_COMPANION_INFO').then((r) => {
      if (!r || !r.ok || !r.companions) return;
      const c = r.companions;
      // If the content script attached a diagnostic, surface it here so the
      // doctor doesn't have to open the G-Hosp tab's DevTools to see why
      // extraction came back empty. Fields logged as separate args (not as
      // a single object) so Chrome DevTools prints them inline instead of
      // collapsing to "Object" — copy-paste-able without expanding.
      if (c._diag) {
        if (c._diag.reason === 'no-node-matched') {
          console.warn(
            '[Toca Ficha] companion extraction failed: no patient-header node matched.',
            '\n  url:', c._diag.url,
            '\n  title:', c._diag.title,
            '\n  strategies tried:', (c._diag.strategiesTried || []).join(', '),
            '\n  labelInTextMatches:', c._diag.labelInTextMatches,
            '\n  labelInHTMLMatches:', c._diag.labelInHTMLMatches,
            '\n  firstMatchContext:', c._diag.firstMatchContext,
            '\n  bodyTextSnippet[0:2500]:', c._diag.bodyTextSnippet
          );
        } else {
          console.warn(
            '[Toca Ficha] companion extraction failed: parser returned empty.',
            '\n  node:', c._diag.nodeTag,
            '\n  outerHTML[0:400]:', c._diag.outerHTML,
            '\n  text[0:400]:', c._diag.text
          );
        }
      }
      const mode = state.atestadoCompanionMode;
      const buildLine = (label, name) => {
        if (!name) return null;
        const line = document.createElement('div');
        line.className = 'sp-atestado-companion-line';
        const lbl = document.createElement('span');
        lbl.className = 'sp-atestado-companion-label';
        lbl.textContent = label + ' —';
        const nm = document.createElement('span');
        nm.className = 'sp-atestado-companion-name';
        nm.textContent = ' ' + name;
        line.appendChild(lbl);
        line.appendChild(nm);
        return line;
      };
      if (mode === 'mae') {
        const ml = buildLine('Mãe', c.mother);
        if (ml) box.appendChild(ml);
      } else if (mode === 'pai') {
        const pl = buildLine('Pai', c.father);
        if (pl) box.appendChild(pl);
      } else {
        const motherLine = buildLine('Mãe', c.mother);
        const fatherLine = buildLine('Pai',  c.father);
        if (motherLine) box.appendChild(motherLine);
        if (fatherLine) box.appendChild(fatherLine);
      }
    }).catch(() => { /* non-fatal — info area just stays empty */ });
  }

  function _toggleAtestadoDrawer(open) {
    const drawer = $('sp-atestado-drawer');
    const trigger = $('sp-act-atestado');
    if (!drawer || !trigger) return;
    const willOpen = open === undefined ? !state.atestadoOpen : !!open;
    state.atestadoOpen = willOpen;
    drawer.style.display = willOpen ? '' : 'none';
    trigger.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) {
      _setAtestadoStatus('', '');
      _renderCompanionInfo();
    }
  }

  function _setCompanionMode(mode) {
    // Accepts 'mae' | 'pai' | 'outro' or null (patient-only). Anything else
    // collapses to null, matching the "no auto-pick" rule.
    //
    // Intentionally does NOT persist to chrome.storage.sync — see the state
    // block comment. Persisting reintroduces the bug where pre-v3.5 storage
    // ('mae' or 'general' auto-saved on every drawer open) resurrects as an
    // auto-pick on the next side-panel load, even after the default-null
    // change. Session-only state is what guarantees the drawer always opens
    // unselected.
    const valid = (mode === 'mae' || mode === 'pai' || mode === 'outro') ? mode : null;
    state.atestadoCompanionMode = valid;
    document.querySelectorAll('#sp-atestado-companion-chips .sp-atestado-chip').forEach((c) => {
      // valid === null deselects every chip — patient-only state.
      c.classList.toggle('selected', valid !== null && c.getAttribute('data-companion') === valid);
    });
    _renderCompanionInfo();
  }

  function _setAtestadoDays(days) {
    // Accept 1-30; clamp to safe range. Updates state, chip highlight, CTA
    // text, and persists via chrome.storage.sync.atestadoLastDays.
    const n = Math.max(1, Math.min(30, parseInt(days, 10) || 1));
    state.atestadoDays = n;
    document.querySelectorAll('#sp-atestado-chips .sp-atestado-chip').forEach((c) => {
      const d = c.getAttribute('data-days');
      if (d === 'outro') {
        // "Outro" stays selected when current value is not in 1-6 range.
        const isOutro = n < 1 || n > 6;
        c.classList.toggle('selected', isOutro);
      } else {
        c.classList.toggle('selected', parseInt(d, 10) === n);
      }
    });
    _updateAtestadoCta();
    try { chrome.storage.sync.set({ atestadoLastDays: n }); } catch (_) {}
  }

  function _wireAtestadoDrawer() {
    const drawer = $('sp-atestado-drawer');
    if (!drawer) return;

    // Restore persisted state. Only `atestadoLastDays` is read — companion
    // mode is intentionally session-only (see _setCompanionMode). Each fresh
    // side-panel load starts with no chip selected so patient-only is the
    // default for every drawer open.
    chrome.storage.sync.get(['atestadoLastDays'], (data) => {
      const days = data && data.atestadoLastDays;
      state.atestadoDays = (typeof days === 'number' && days >= 1 && days <= 30) ? days : 1;
      _setAtestadoDays(state.atestadoDays);
      // If the persisted days isn't in the chip set (1-6), reveal the
      // numeric "Outro" input pre-filled with the saved value.
      const outroInput = $('sp-atestado-outro-input');
      if (outroInput) {
        if (state.atestadoDays > 6) {
          outroInput.style.display = '';
          outroInput.value = String(state.atestadoDays);
        } else {
          outroInput.value = '';
          outroInput.style.display = 'none';
        }
      }
    });

    // Companion-mode chips — mutually exclusive segmented control with a
    // toggle-off behavior: clicking the currently-selected chip returns to
    // the patient-only (null) state, so the doctor can always reach all four
    // states (none / mae / pai / outro) using just the three buttons.
    const compChips = $('sp-atestado-companion-chips');
    if (compChips) {
      compChips.addEventListener('click', (ev) => {
        let target = ev.target;
        while (target && target !== compChips && !target.classList.contains('sp-atestado-chip')) {
          target = target.parentElement;
        }
        if (!target || target === compChips) return;
        const m = target.getAttribute('data-companion');
        if (!m) return;
        // Toggle off if the clicked chip is already active.
        _setCompanionMode(m === state.atestadoCompanionMode ? null : m);
      });
    }

    // Chip clicks — delegated for tidy add/remove. data-days is "1"-"6" or
    // the literal string "outro" for the numeric-input toggle.
    const chips = $('sp-atestado-chips');
    if (chips) {
      chips.addEventListener('click', (ev) => {
        let target = ev.target;
        while (target && target !== chips && !target.classList.contains('sp-atestado-chip')) {
          target = target.parentElement;
        }
        if (!target || target === chips) return;
        const d = target.getAttribute('data-days');
        const outroInput = $('sp-atestado-outro-input');
        if (d === 'outro') {
          if (outroInput) {
            outroInput.style.display = '';
            outroInput.focus();
            const n = parseInt(outroInput.value, 10);
            if (n >= 1 && n <= 30) _setAtestadoDays(n);
            else _setAtestadoDays(7); // sensible default for "Outro"
          }
        } else {
          if (outroInput) {
            outroInput.value = '';
            outroInput.style.display = 'none';
          }
          _setAtestadoDays(d);
        }
      });
    }

    // Outro numeric input — wire on input so the CTA label updates as the
    // doctor types, and clamp to 1-30.
    const outroInput = $('sp-atestado-outro-input');
    if (outroInput) {
      outroInput.addEventListener('input', () => {
        const n = parseInt(outroInput.value, 10);
        if (!isNaN(n) && n >= 1 && n <= 30) _setAtestadoDays(n);
      });
    }

    // CTA — runs the full flow.
    const cta = $('sp-atestado-cta');
    if (cta) {
      cta.addEventListener('click', async () => {
        if (state.atestadoFullRunning) return;
        state.atestadoFullRunning = true;
        cta.disabled = true;
        _setAtestadoStatus('Gerando atestado…', 'loading');
        try {
          const r = await send('SIDEPANEL_RUN_ATESTADO_FULL', {
            days: state.atestadoDays,
            companionMode: state.atestadoCompanionMode,
          });
          if (r && r.ok) {
            _setAtestadoStatus('Atestado gerado e impresso ✓', 'ok');
            try { _bumpUsage('atestadoFull'); } catch (_) {}
            // Close the drawer after success — the surface is reusable for the
            // next patient. Status pulse stays visible briefly on the main
            // status row so the doctor sees the confirmation outside the drawer.
            _setStatus('Atestado gerado ✓', 'ok');
            setTimeout(() => _toggleAtestadoDrawer(false), 800);
          } else {
            const err = (r && r.error) || 'erro';
            _setAtestadoStatus(_translateAtestadoError(err), 'err');
          }
        } finally {
          state.atestadoFullRunning = false;
          cta.disabled = false;
        }
      });
    }

    // Outer-click closes the drawer. We register on document with capture so
    // we see the click before any per-button handler stops propagation.
    document.addEventListener('click', (ev) => {
      if (!state.atestadoOpen) return;
      const within = ev.target.closest && (
        ev.target.closest('#sp-atestado-drawer') ||
        ev.target.closest('#sp-act-atestado')
      );
      if (!within) _toggleAtestadoDrawer(false);
    }, true);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Alta e voltar
  // ─────────────────────────────────────────────────────────────────────────
  // v3.2.0: bridge.js / dom-engine.js now throw structured tokens from each
  // known failure point in processDischarge(). Translate them to actionable
  // Portuguese hints here — single source of truth so we don't scatter UI
  // copy across multiple files.
  const _DISCHARGE_ERROR_HINTS = {
    'discharge_no_intern_id': 'Paciente não selecionado — abra um prontuário primeiro',
    'discharge_link_not_found': 'Aba do G-Hosp não está na página do paciente — navegue para o prontuário',
    'discharge_form_not_found': 'G-Hosp não respondeu ao Adicionar — recarregue a página (F5)',
  };

  // v3.7.0: structured error tokens from runAtestadoFull() translated to
  // actionable Portuguese hints — keeps UI copy in one place.
  const _ATESTADO_ERROR_HINTS = {
    'atestado_link_not_found': 'Atestado não disponível nesta página — navegue para o prontuário do paciente',
    'atestado_form_not_found': 'Formulário do atestado não encontrado — recarregue a página (F5)',
    'atestado_inserir_not_found': 'Botão Inserir do atestado não encontrado — recarregue a página (F5)',
    'atestado_obs_not_found': 'Campo de observação do atestado não encontrado — recarregue a página (F5)',
    'atestado_save_not_found': 'Botão Salvar do atestado não encontrado — recarregue a página (F5)',
    'atestado_print_not_found': 'Botão Imprimir do atestado não encontrado — recarregue a página (F5)',
  };

  function _translateAtestadoError(rawError) {
    const msg = (rawError || 'erro').toString();
    if (_ATESTADO_ERROR_HINTS[msg]) return _ATESTADO_ERROR_HINTS[msg];
    return 'Falha: ' + msg;
  }

  function _translateFinalizeError(rawError) {
    const msg = (rawError || 'erro').toString();
    if (_DISCHARGE_ERROR_HINTS[msg]) return _DISCHARGE_ERROR_HINTS[msg];
    if (msg.indexOf('discharge_verification_failed') === 0) {
      const colon = msg.indexOf(':');
      const detail = colon >= 0 ? msg.slice(colon + 1).trim() : '';
      return 'Erro ao validar a alta: ' + (detail || 'verifique o G-Hosp');
    }
    return 'Falha: ' + msg;
  }

  function _wireFinalizePatient() {
    const btn = $('sp-finalize-patient');
    if (!btn) return;

    // In-button two-click confirmation. First click arms the button (label →
    // "Confirmar alta?", 5s timeout); second click within the window commits.
    // Replaces window.confirm() — same safety, one fewer modal in the discharge
    // workflow. Reason for 5s: long enough for an interruption, short enough
    // that an abandoned arm doesn't linger across patients.
    const DEFAULT_LABEL = btn.textContent || '✓ Alta e voltar';
    const CONFIRM_LABEL = 'Confirmar alta?';
    const ARM_WINDOW_MS = 5000;
    let armTimer = null;

    function disarm() {
      if (armTimer) { clearTimeout(armTimer); armTimer = null; }
      btn.dataset.armed = '';
      btn.classList.remove('arming');
      btn.textContent = DEFAULT_LABEL;
    }

    btn.addEventListener('click', async () => {
      if (state.finalizing) return;
      let internId = state.patientInfo && state.patientInfo.internId;
      if (!internId) {
        // Self-heal: the side panel's cached state can lag the G-Hosp tab if
        // the TOCAFICHADR_PATIENT_CHANGED broadcast was dropped (extension
        // reload during a session, BFCache eviction, etc.). Force a fresh
        // round-trip to the bridge before giving up.
        console.log('[Toca Ficha] finalize: state has no internId, triggering refreshPatient()', { cached: state.patientInfo });
        _setStatus('Verificando paciente...', 'loading');
        try { await refreshPatient(); } catch (_) {}
        internId = state.patientInfo && state.patientInfo.internId;
      }
      if (!internId) {
        console.warn('[Toca Ficha] finalize blocked: no internId even after refresh', { cached: state.patientInfo });
        _setStatus('Sem paciente ativo — abra um prontuário no G-Hosp', 'err');
        disarm();
        return;
      }

      if (btn.dataset.armed !== '1') {
        btn.dataset.armed = '1';
        btn.classList.add('arming');
        btn.textContent = CONFIRM_LABEL;
        _setStatus('Clique de novo em ' + (ARM_WINDOW_MS / 1000) + 's para confirmar', '');
        armTimer = setTimeout(() => {
          disarm();
          _setStatus('', '');
        }, ARM_WINDOW_MS);
        return;
      }

      // Second click within window — commit.
      disarm();
      state.finalizing = true;
      btn.disabled = true;
      _updateActionButtonsForPatientState(); // Disable other buttons while finalizing
      _setStatus('Registrando alta...', 'loading');
      try {
        const r = await send('SIDEPANEL_FINALIZE_PATIENT', { internId });
        if (r && r.ok) {
          _bumpUsage('finalize');
          _setStatus('Alta registrada e lista aberta ✓', 'ok');
          _clearRetryState('sp-finalize-patient');
        } else {
          _setStatus(_translateFinalizeError(r && r.error), 'err');
          // Enable retry by resetting the button
          btn.textContent = DEFAULT_LABEL;
        }
      } catch (err) {
        _setStatus('Falha na alta — clique para tentar novamente', 'err');
        btn.textContent = '↻ Tentar alta novamente';
      } finally {
        state.finalizing = false;
        btn.disabled = false;
        _updateActionButtonsForPatientState(); // Re-enable buttons
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // v3.1: defensive Config-tab wiring — popup.bundle.js sometimes fails to
  // attach these handlers in the side panel context (Clerk init has
  // popup-specific assumptions). Wire them here too as a safety net. Idempotent.
  // ─────────────────────────────────────────────────────────────────────────
  // v3.5.0: medication-shortcut defaults. User can replace these in Config.
  // Six fits the side panel's 2-column grid as 3 rows.
  const DEFAULT_TEMPLATES_V31 = [
    { diagnosis: "Paracetamol gotas",            ageBand: "gotas",     medId: "paracetamol",       dose: "",       freq: "6/6h",   duration: "",       when: "se dor ou febre" },
    { diagnosis: "Paracetamol comprimidos (cp)", ageBand: "cp",        medId: "paracetamol_adult", dose: "",       freq: "6/6h",   duration: "",       when: "se dor ou febre" },
    { diagnosis: "Amoxicilina liquida 250mg/5mL",ageBand: "suspensao", medId: "amox_pneum",        dose: "",       freq: "12/12h", duration: "7 dias", when: "" },
    { diagnosis: "Amoxicilina 500mg comprimido", ageBand: "cp",        medId: "amox_adult",        dose: "",       freq: "8/8h",   duration: "7 dias", when: "" },
    { diagnosis: "Desloratadina xarope",         ageBand: "xarope",    name: "Desloratadina xarope", dose: "[dose]", freq: "1x/dia", duration: "",       when: "" },
    { diagnosis: "Loratadina xarope",            ageBand: "xarope",    name: "Loratadina xarope",    dose: "[dose]", freq: "1x/dia", duration: "",       when: "" },
  ].map((t, i) => {
    const med = { dose: t.dose, freq: t.freq, duration: t.duration, when: t.when, notes: "" };
    if (t.medId) med.medId = t.medId;
    if (t.name) med.name = t.name;
    return {
      id: "tpl_default_" + i,
      diagnosis: t.diagnosis,
      ageBand: t.ageBand,
      body: "",
      frequency: 0,
      meds: [med],
      extraText: "",
    };
  });

  // v3.1.2 — bulletproof event delegation. A single click listener on
  // document.body catches all clicks; we route by id. This survives:
  //   • popup.bundle.js failing to attach its own listeners
  //   • elements being re-rendered (listener stays on document, not on element)
  //   • timing races between popup.bundle.js and this script
  async function _onAddTemplate() {
    console.log('[Toca Ficha] + Adicionar modelo');
    const uc = window.TOCAFICHADR_userConfig;
    if (!uc) {
      _showTemplateSaveError('Autenticação pendente — faça login para editar modelos.');
      return;
    }
    try {
      const cfg = await uc.getCached();
      const arr = Array.isArray(cfg && cfg.rx_templates) ? cfg.rx_templates.slice() : [];
      arr.push({
        id: 'tpl_' + Date.now(),
        diagnosis: '', ageBand: '', body: '', frequency: 0, meds: [], extraText: '',
      });
      uc.patch({ rx_templates: arr });
      // patch() is debounced + storage.onChanged self-write suppression means
      // our own onChange listener won't fire — write the optimistic merge to
      // local storage directly so the immediate _renderTemplates() reads it.
      const merged = Object.assign({}, cfg || {}, { rx_templates: arr });
      await new Promise((resolve) => {
        try { chrome.storage.local.set({ userConfig: merged }, resolve); }
        catch (_) { resolve(); }
      });
      _renderTemplates();
      _clearTemplateSaveError();
    } catch (e) {
      console.error('[Toca Ficha] _onAddTemplate failed:', e);
      _showTemplateSaveError('Erro ao adicionar modelo — tente recarregar o painel.');
    }
  }

  async function _onRestoreDefaults() {
    console.log('[Toca Ficha] ↺ Restaurar padrões');
    if (!confirm('Substituir todos os modelos pelos padrões? Modelos editados serão perdidos.')) return;
    const uc = window.TOCAFICHADR_userConfig;
    if (!uc) {
      _showTemplateSaveError('Autenticação pendente — faça login para restaurar padrões.');
      return;
    }
    try {
      const defaults = JSON.parse(JSON.stringify(DEFAULT_TEMPLATES_V31));
      uc.patch({ rx_templates: defaults });
      // Same writer-doesn't-self-emit bug as _onAddTemplate — force optimistic
      // cache update + re-render so the user sees the defaults immediately.
      const cfg = await uc.getCached();
      const merged = Object.assign({}, cfg || {}, { rx_templates: defaults });
      await new Promise((resolve) => {
        try { chrome.storage.local.set({ userConfig: merged }, resolve); }
        catch (_) { resolve(); }
      });
      _renderTemplates();
      _clearTemplateSaveError();
    } catch (e) {
      console.error('[Toca Ficha] _onRestoreDefaults failed:', e);
      _showTemplateSaveError('Erro ao restaurar padrões — tente recarregar o painel.');
    }
  }

  async function _onSignIn() {
    console.log('[Toca Ficha] Sign in clicked');
    const status = $('authStatus');
    if (status) { status.textContent = 'Abrindo página de login...'; status.className = 'conn-status'; }
    try {
      // v3.1.4: use the Clerk SDK's buildSignInUrl() — the manual FAPI /sign-in
      // pattern returned 404. Clerk's hosted account portal lives at a
      // different host pattern that the SDK knows how to construct.
      // Wait briefly for popup.bundle.js to expose the SDK on window.
      let url = null;
      const successUrl = (window.TOCAFICHADR_authSuccessUrl) || chrome.runtime.getURL('auth-success.html');
      for (let i = 0; i < 20 && !url; i++) {
        const c = window.TOCAFICHADR_clerk;
        if (c && typeof c.buildSignInUrl === 'function') {
          // The SDK requires Clerk to be loaded before buildSignInUrl works.
          if (!window.TOCAFICHADR_clerkReady) {
            await new Promise((r) => setTimeout(r, 250));
            continue;
          }
          try { url = c.buildSignInUrl({ redirectUrl: successUrl }); }
          catch (e) { console.warn('[TF] buildSignInUrl threw, will retry:', e); }
        }
        if (!url) await new Promise((r) => setTimeout(r, 200));
      }
      if (!url) {
        // Last-resort fallback: production Clerk accounts portal.
        // Must match the FAPI encoded in CLERK_PUBLISHABLE_KEY (pk_live_ → clerk.tocafichadr.com.br).
        // The old dev fallback (working-chow-0.clerk.accounts.dev) was wrong and
        // would send users to the wrong Clerk instance if the SDK was slow to load.
        url = 'https://accounts.tocafichadr.com.br/?redirect_url=' + encodeURIComponent(successUrl);
        console.warn('[TF] using fallback Clerk URL:', url);
      }
      await chrome.tabs.create({ url, active: true });
      if (status) {
        status.textContent = 'Login aberto em nova aba. Volte aqui após autenticar.';
        status.className = 'conn-status ok';
      }
    } catch (e) {
      console.error('[TF] signIn failed:', e);
      if (status) { status.textContent = 'Erro: ' + (e.message || e); status.className = 'conn-status err'; }
    }
  }

  async function _onSignOut() {
    console.log('[Toca Ficha] Sign out clicked');
    const status = $('authStatus');
    if (status) { status.textContent = 'Saindo...'; status.className = 'conn-status'; }
    try {
      // v3.1.4: prefer the Clerk SDK's signOut() — it talks to FAPI to
      // invalidate the session server-side AND clears its own client state.
      // Falls back to manual storage/cookie wipe if the SDK isn't available.
      const c = window.TOCAFICHADR_clerk;
      if (c && typeof c.signOut === 'function') {
        try { await c.signOut(); } catch (e) { console.warn('[TF] clerk.signOut threw:', e); }
      }
      // Always also clear our own storage in case Clerk's signOut left something behind.
      // CHRA-2133: the JWT lives in chrome.storage.session now.
      await chrome.storage.session.remove(['authToken', 'authUser']);
      try { localStorage.clear(); } catch (_) {}
      try { sessionStorage.clear(); } catch (_) {}
      // Clear Clerk session cookies from production domains.
      // The old code targeted 'working-chow-0.clerk.accounts.dev' (dev instance) so
      // production cookies on clerk.tocafichadr.com.br / accounts.tocafichadr.com.br
      // were never removed, leaving orphaned sessions after sign-out.
      for (const clerkDomain of ['clerk.tocafichadr.com.br', 'accounts.tocafichadr.com.br']) {
        try {
          const cookies = await chrome.cookies.getAll({ domain: clerkDomain });
          for (const ck of cookies) {
            const proto = ck.secure ? 'https://' : 'http://';
            const host = ck.domain.replace(/^\./, '');
            await chrome.cookies.remove({ url: proto + host + ck.path, name: ck.name });
          }
        } catch (e) { console.warn('[TF] cookie clear failed for', clerkDomain, ':', e); }
      }
      // Flip UI immediately
      const loIn  = $('loggedInView');
      const loOut = $('loggedOutView');
      if (loIn)  loIn.style.display = 'none';
      if (loOut) loOut.style.display = '';
      const avatar = $('brandAvatar');
      if (avatar) { avatar.textContent = '—'; avatar.classList.add('empty'); }
      if (status) { status.textContent = 'Sessão encerrada. Recarregando...'; status.className = 'conn-status ok'; }
      // Reload so Clerk SDK re-initializes from a clean slate.
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      console.error('[TF] signOut failed:', e);
      if (status) { status.textContent = 'Erro: ' + (e.message || e); status.className = 'conn-status err'; }
    }
  }

  function _installDelegatedClickRouter() {
    if (document.body.dataset.spClickRouter) return;
    document.body.dataset.spClickRouter = '1';
    document.body.addEventListener('click', (ev) => {
      // Walk up to find an element with id matching one of our targets.
      let el = ev.target;
      while (el && el !== document.body) {
        const id = el.id;
        if (id === 'addRxTemplateBtn')      { ev.preventDefault(); ev.stopImmediatePropagation(); _onAddTemplate(); return; }
        if (id === 'restoreRxDefaultsBtn')  { ev.preventDefault(); ev.stopImmediatePropagation(); _onRestoreDefaults(); return; }
        if (id === 'signInBtn')             { ev.preventDefault(); ev.stopImmediatePropagation(); _onSignIn(); return; }
        if (id === 'signOutBtn')            { ev.preventDefault(); ev.stopImmediatePropagation(); _onSignOut(); return; }
        el = el.parentElement;
      }
    }, true); // capture phase — fires before any other listener
    console.log('[Toca Ficha] delegated click router installed');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // v3.8.2 — Keyboard Navigation
  // Critical for medical workflow speed — doctors shouldn't need a mouse.
  // Arrow keys navigate tabs and template grids; Enter/Space activate.
  // ─────────────────────────────────────────────────────────────────────────
  function _initKeyboardNavigation() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const actionBtns = document.querySelectorAll('.sp-act-btn');
    const rxBtns = document.getElementById('sp-templates');

    document.addEventListener('keydown', (e) => {
      // Never intercept keys while the user is typing in an input or textarea.
      // This guard must come first — arrow keys below would otherwise swallow
      // cursor-movement keystrokes inside the CID search input or obs textarea.
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      // Tab navigation with arrow keys
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const activeTab = document.querySelector('.tab-btn.active');
        if (!activeTab) return;
        const tabs = Array.from(tabBtns);
        const idx = tabs.indexOf(activeTab);
        if (idx === -1) return;
        let nextIdx;
        if (e.key === 'ArrowRight') {
          nextIdx = (idx + 1) % tabs.length;
        } else {
          nextIdx = (idx - 1 + tabs.length) % tabs.length;
        }
        tabs[nextIdx].focus();
        tabs[nextIdx].click();
        e.preventDefault();
      }

      if (e.key === 'r' || e.key === 'R') {
        const recBtn = $('sp-record-btn');
        if (recBtn && !recBtn.disabled) {
          recBtn.click();
          e.preventDefault();
        }
      }
      if (e.key === 's' || e.key === 'S') {
        const saveBtn = $('sp-act-save');
        if (saveBtn && !saveBtn.disabled) {
          saveBtn.click();
          e.preventDefault();
        }
      }
      if (e.key === 'f' || e.key === 'F') {
        const finalizeBtn = $('sp-finalize-patient');
        if (finalizeBtn && !finalizeBtn.disabled) {
          finalizeBtn.focus();
          e.preventDefault();
        }
      }
    });

    // Make tab buttons focusable and keyboard-activated
    tabBtns.forEach((btn) => {
      btn.setAttribute('tabindex', '0');
      btn.setAttribute('role', 'tab');
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          btn.click();
        }
      });
    });

    // Make action buttons keyboard accessible
    actionBtns.forEach((btn) => {
      btn.setAttribute('tabindex', '0');
    });

    // Template grid keyboard navigation
    if (rxBtns) {
      rxBtns.addEventListener('keydown', (e) => {
        if (e.target.classList.contains('sp-rx-med-btn')) {
          const buttons = Array.from(rxBtns.querySelectorAll('.sp-rx-med-btn:not([disabled])'));
          const idx = buttons.indexOf(e.target);
          if (idx === -1) return;

          let nextIdx = -1;
          if (e.key === 'ArrowRight') nextIdx = Math.min(buttons.length - 1, idx + 1);
          else if (e.key === 'ArrowLeft') nextIdx = Math.max(0, idx - 1);
          else if (e.key === 'ArrowDown') nextIdx = Math.min(buttons.length - 1, idx + 2);
          else if (e.key === 'ArrowUp') nextIdx = Math.max(0, idx - 2);
          else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.target.click();
            return;
          }

          if (nextIdx !== -1 && nextIdx !== idx) {
            e.preventDefault();
            buttons[nextIdx].focus();
          }
        }
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // v3.8.2 — Patient-aware action button state
  // When no patient is active, disable actions that require a patient.
  // Prevents confusing error messages and guides the doctor.
  // ─────────────────────────────────────────────────────────────────────────
  function _updateActionButtonsForPatientState() {
    const hasPatient = !!(state.patientInfo && state.patientInfo.internId);
    const patientDependentIds = ['sp-act-save', 'sp-act-rx', 'sp-act-atestado', 'sp-act-bau', 'sp-finalize-patient'];

    patientDependentIds.forEach((id) => {
      const btn = $(id);
      if (!btn) return;
      btn.disabled = !hasPatient || state.finalizing;
      // Visual feedback: dim the button and show a tooltip hint
      if (!hasPatient) {
        btn.title = 'Abra um prontuário no G-Hosp para usar esta ação';
      } else {
        btn.title = '';
      }
    });

    // Update patient card visual state
    const card = $('sp-patient-card');
    if (card) {
      if (!hasPatient) {
        card.classList.add('no-patient');
      } else {
        card.classList.remove('no-patient');
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // v3.8.2 — Error recovery: retry on action failure
  // When an action fails, change the button to "Tentar novamente" so the
  // doctor can retry without hunting for the right button.
  // ─────────────────────────────────────────────────────────────────────────
  const _ACTION_RETRY_STATE = new Map();

  function _runActionWithRetry(btnId, actionFn, originalLabel) {
    const btn = $(btnId);
    if (!btn) return actionFn();

    const retryState = _ACTION_RETRY_STATE.get(btnId);
    if (retryState && retryState.isRetry) {
      // This click is a retry — restore label and run
      btn.textContent = originalLabel;
      _ACTION_RETRY_STATE.delete(btnId);
    }

    return actionFn().then((result) => {
      // Success — clear any retry state and always restore the label.
      // _clearRetryState() in the click handler deletes the entry before we
      // get here, so the retryState guard above never fires on a retry click.
      // Restoring unconditionally fixes the permanent "↻ Tentar novamente"
      // label left after a successful retry.
      _ACTION_RETRY_STATE.delete(btnId);
      btn.textContent = originalLabel;
      btn.classList.remove('retry-mode');
      return result;
    }).catch((err) => {
      // Failure — set retry mode
      console.warn('[Toca Ficha] Action failed, enabling retry:', btnId, err);
      _ACTION_RETRY_STATE.set(btnId, { isRetry: true, error: err });
      btn.textContent = '↻ Tentar novamente';
      btn.classList.add('retry-mode');
      throw err;
    });
  }

  function _clearRetryState(btnId) {
    _ACTION_RETRY_STATE.delete(btnId);
    const btn = $(btnId);
    if (btn) btn.classList.remove('retry-mode');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Init
  // ─────────────────────────────────────────────────────────────────────────
  function init() {
    const _recordBtn = $('sp-record-btn');
    if (_recordBtn) _recordBtn.addEventListener('click', toggleRecording);
    _wireCidSearch();
    _wireRxMix();
    _wireRxFinalize();
    _wireRxPreview();
    _wireActions();
    _wireFinalizePatient();
    // v3.4.0: disabled — Modelos G-Hosp removed from UI; bridge/dom-engine code retained.
    // _wireGhospSync();
    _wireAtestadoDrawer();
    _wireSoapCopyIcon();
    _renderTemplates();
    // v3.4.0: disabled — Modelos G-Hosp removed from UI; bridge/dom-engine code retained.
    // _renderGhospTemplates();
    refreshPatient();
    _installDelegatedClickRouter();
    // CHRA-2166 — connectivity-aware "Backend indisponível" banner + retry.
    _wireConnectivity();
    // Rule 11 (PHI) — drop any in-memory patient data when this side-panel
    // session ends. Durable PHI never persists (the offline queue allowlist
    // refuses anything but doctor-config keys), so this is the only at-rest
    // surface and it dies with the page.
    try { window.addEventListener('pagehide', _clearSessionPHI); } catch (_) {}
    // v3.8.2: Initialize keyboard navigation
    _initKeyboardNavigation();
    // Initial chip render — fires before sign-in too so signed-out path
    // just hides the chip (no spinner, no error noise). Re-runs on sign-in
    // via the TOCAFICHADR_AUTH_COMPLETED reload.
    _refreshUsage();

    // Re-render templates when popup edits storage. Phase 03-03 moved
    // prescriptionTemplates from chrome.storage.sync into the per-user
    // userConfig (chrome.storage.local). Subscribe via the user-config
    // client so cross-context updates and hydrate refreshes both fire here.
    if (window.TOCAFICHADR_userConfig && typeof window.TOCAFICHADR_userConfig.onChange === 'function') {
      window.TOCAFICHADR_userConfig.onChange(() => _renderTemplates());
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.ghospTemplateCatalog) _renderGhospTemplates();
      // Sign-in completed (in another tab or via popup.bundle.js's 30s token
      // refresh). authToken just appeared in storage — reload so the gate
      // hides and the authed UI renders. Matches the existing
      // TOCAFICHADR_AUTH_COMPLETED reload pattern; this catches the case
      // where the user signs in on Clerk's hosted UI and closes the tab
      // without auth-success.html ever firing the broadcast.
      // CHRA-2133: authToken signal moved from chrome.storage.local to .session.
      if (area === 'session' && changes.authToken
          && changes.authToken.newValue && !changes.authToken.oldValue) {
        setTimeout(() => location.reload(), 400);
      }
    });

    // Refresh patient when user switches tabs (e.g. opened a different patient)
    chrome.tabs.onActivated.addListener(refreshPatient);
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      // Guard: only refresh when the G-Hosp tab itself finishes loading.
      // Without this, every tab completion in the browser (e.g. opening Gmail)
      // triggers a patient refresh and an unnecessary G-Hosp DOM round-trip.
      if (info.status === 'complete' && tabId === state.activeTabId) refreshPatient();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
