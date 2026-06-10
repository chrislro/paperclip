// content/bridge.js — v3.1 — replaces hud.js + content.js
//
// Old architecture: floating HUD injected on G-Hosp, called dom-engine in-process.
// New architecture: side panel drives the workflow; this bridge:
//   1. Loads selectors on page enter (was content.js's job).
//   2. Auto-clears SOAP on patient page (was content.js's job).
//   3. Watches the URL for SPA navigation and broadcasts patient-info changes
//      to the side panel.
//   4. Listens for SIDEPANEL_* messages and dispatches to TOCAFICHADR_dom and
//      TOCAFICHADR_audio. Returns results so the side panel can update its UI.
//
// All G-Hosp-specific automation (DOM clicks, prescription flow, discharge,
// audio capture) still lives in dom-engine.js / audio-capture.js — this file
// is just glue.

(async function () {
  'use strict';

  if (!window.TOCAFICHADR_dom) {
    console.error('[Toca Ficha Dr.] dom-engine missing — bridge cannot start');
    return;
  }

  // Hoisted so the synchronous listener (registered immediately below) can
  // typeof-check before the const-style assignment further down in this IIFE.
  var HANDLERS;

  // Register the SIDEPANEL_* message listener SYNCHRONOUSLY before any await.
  // Otherwise the side panel can fire START_RECORDING during the loadSelectors
  // network round-trip and hit "Receiving end does not exist". HANDLERS is
  // defined later in the file but lives in the same lexical scope; by the
  // time a real message arrives, the IIFE body has finished executing and
  // HANDLERS is initialised. The TDZ guard below covers the rare race where
  // a message fires before HANDLERS exists.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type || !msg.type.startsWith('SIDEPANEL_')) return false;
    if (!HANDLERS) {
      sendResponse({ ok: false, error: 'bridge ainda inicializando — tente novamente' });
      return false;
    }
    const handler = HANDLERS[msg.type];
    if (!handler) {
      sendResponse({ ok: false, error: 'unknown command: ' + msg.type });
      return false;
    }
    Promise.resolve(handler(msg, sender))
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  });

  try {
    await window.TOCAFICHADR_dom.loadSelectors();
  } catch (err) {
    console.warn('[Toca Ficha Dr.] Falha ao carregar seletores do backend; usando bundled.', err);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Redirect new G-Hosp path-based URLs back to legacy query-param view.
  // ANY /pr/interns/{id}/... view is missing UI elements (#dar_alta,
  // prescriptions, SOAP fields) the doctor relies on.
  // /amb/interns?intern_id={id} is the old, complete view.
  // ─────────────────────────────────────────────────────────────────────────
  (function _redirectPrInternsToAmb() {
    const url = new URL(window.location.href);
    const pathMatch = url.pathname.match(/^\/pr\/interns\/(\d+)/);
    if (pathMatch) {
      const internId = pathMatch[1];
      const target = url.origin + '/amb/interns?intern_id=' + encodeURIComponent(internId);
      console.log('[Toca Ficha Dr.] redirecting from /pr/interns to legacy view:', url.pathname, '->', target);
      window.location.replace(target);
    }
  })();

  // ─────────────────────────────────────────────────────────────────────────
  // Patient watcher — broadcasts to side panel on URL change
  // ─────────────────────────────────────────────────────────────────────────
  let lastUrl = window.location.href;
  let lastPatientKey = '';

  // v3.1.8 — derive a stable "consultation type" key from the current URL so
  // the side panel can store one template catalog per page type. G-Hosp serves
  // the same template ID with different labels across consultation types
  // (pediatrics vs adult, ambulatorial vs internação), so the catalog must be
  // scoped by URL context — but NOT by patient identity. We strip volatile
  // params (intern_id, page tokens) and keep only well-known type
  // discriminators when present.
  function _computeTemplateUrlKey() {
    try {
      const url = new URL(window.location.href);
      const path = url.pathname || '/';
      // Keep stable consultation-type query params if G-Hosp uses any of these.
      // intern_id and page params are excluded — they change per patient and
      // would split the catalog into thousands of entries.
      const KEEP = ['tipo', 'tipo_consulta', 'tipo_atendimento', 'consulta_tipo', 'modo'];
      const params = [];
      for (let i = 0; i < KEEP.length; i++) {
        const v = url.searchParams.get(KEEP[i]);
        if (v) params.push(KEEP[i] + '=' + v);
      }
      return params.length ? path + '?' + params.join('&') : path;
    } catch (_) {
      return window.location.pathname || '/';
    }
  }

  function _broadcastPatientInfo() {
    try {
      const info = window.TOCAFICHADR_dom.extractPatientInfo();
      const urlKey = _computeTemplateUrlKey();
      // Cache key includes urlKey so a navigation that changes consultation
      // type but not patient still triggers a re-broadcast (catalog UI updates).
      const key = JSON.stringify({ info: info, urlKey: urlKey });
      if (key === lastPatientKey) return;
      lastPatientKey = key;
      // The side panel listens for this on chrome.runtime.onMessage.
      // Fire-and-forget — broadcast errors are non-critical.
      chrome.runtime.sendMessage({
        type: 'TOCAFICHADR_PATIENT_CHANGED',
        info: info,
        urlKey: urlKey,
      }).catch(() => {});
    } catch (_) { /* swallow extraction errors */ }
  }

  // Initial broadcast on page load.
  setTimeout(_broadcastPatientInfo, 800);

  // SPA navigation watcher (G-Hosp uses jQuery UI tabs/turbolinks).
  const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      setTimeout(() => {
        _autoSetupPatientPage();
        _broadcastPatientInfo();
      }, 800);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  window.addEventListener('beforeunload', () => {
    observer.disconnect();
    // _altaObserver is declared further down (const). If _redirectPrInternsToAmb()
    // calls window.location.replace() before that declaration is reached, the browser
    // fires beforeunload during the IIFE's own execution — _altaObserver is still in
    // the temporal dead zone and accessing it throws ReferenceError. Guard with try/catch
    // so observer.disconnect() (above) always runs and the TDZ case is silent.
    try { _altaObserver.disconnect(); } catch (_) {}
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Auto-prefill encaminh=100 on manual alta dialog (v3.1.6)
  //
  // Logger evidence (3 shifts, 32/32 manual #intern_encaminh changes set
  // value=100 "sem encaminhamento") shows the doctor picks 100 by hand every
  // time they open the alta dialog manually. Watch for the form to appear
  // and prefill it. processDischarge() ("Alta e voltar" flow) already
  // does this — the gap is the manual-open path.
  //
  // Idempotency lives inside prefillDischargeForm (form-id gate +
  // chrome.storage.sync.autoPrefillEncaminh + never-overwrite-non-empty).
  // The observer just nudges the helper; debounce keeps it cheap.
  // ─────────────────────────────────────────────────────────────────────────
  let _altaDebounceTimer = null;
  const _altaObserver = new MutationObserver(() => {
    // Cheap pre-check: avoid scheduling work unless the form is actually
    // present in the DOM. The full helper does its own form lookup, but
    // this prevents debounce churn on every unrelated body mutation.
    if (!document.querySelector("form[id^='edit_intern']")) return;
    if (_altaDebounceTimer) return;
    _altaDebounceTimer = setTimeout(() => {
      _altaDebounceTimer = null;
      try {
        if (window.TOCAFICHADR_dom && window.TOCAFICHADR_dom.prefillDischargeForm) {
          window.TOCAFICHADR_dom.prefillDischargeForm();
        }
      } catch (_) { /* swallow — helper is already defensive */ }
    }, 250);
  });
  _altaObserver.observe(document.body, { childList: true, subtree: true });
  // Run once on load in case the form is already present (e.g. extension
  // reload while the dialog was open).
  try { window.TOCAFICHADR_dom.prefillDischargeForm(); } catch (_) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Auto-setup on patient page (was content.js)
  // ─────────────────────────────────────────────────────────────────────────
  async function _autoSetupPatientPage() {
    const href = window.location.href;
    const isPatientPage = href.includes('intern_id=') || /\/interns\/\d+/.test(href);
    if (!isPatientPage) return;
    // hydrate() removes autoClearSoap from chrome.storage.sync after migration
    // (user-config-client.js). Read auto_clear_soap from the userConfig cache
    // (server-backed) first; fall back to the legacy sync key for users who
    // have not authenticated yet and thus have no userConfig cache.
    let autoClearSoap = true;
    try {
      const local = await new Promise((r) => chrome.storage.local.get(['userConfig'], r));
      const cfg = local && local.userConfig;
      if (cfg && typeof cfg.auto_clear_soap !== 'undefined') {
        autoClearSoap = cfg.auto_clear_soap !== false;
      } else {
        const sync = await new Promise((r) => chrome.storage.sync.get(['autoClearSoap'], r));
        autoClearSoap = sync.autoClearSoap !== false;
      }
    } catch (_) {}
    if (!autoClearSoap) return;
    setTimeout(() => {
      try {
        const cleared = window.TOCAFICHADR_dom.clearSoapFields();
        if (cleared > 0) console.log(`[Toca Ficha Dr.] ${cleared} campos SOAP limpos`);
      } catch (_) {}
    }, 1200);
  }
  _autoSetupPatientPage();

  // ─────────────────────────────────────────────────────────────────────────
  // Audio recording — capture happens here (content script has G-Hosp's
  // HTTPS origin, so getUserMedia prompts work). Side panel sends commands.
  // ─────────────────────────────────────────────────────────────────────────

  // v3.3.0 — kick the audio module's analyser-tap broadcaster after recording
  // starts. The actual sampling + chrome.runtime.sendMessage loop lives in
  // audio-capture.js so we don't double up the AudioContext work; this is
  // just glue that fires the side-panel waveform once mic capture is live.
  function _startWaveformBroadcast() {
    try {
      if (window.TOCAFICHADR_audio && typeof window.TOCAFICHADR_audio.startVisualizerBroadcast === 'function') {
        // ~30 Hz — smooth enough that it looks alive, low enough that the
        // ~24-byte payload × 30 = ~720 B/s is invisible to Chrome's IPC layer.
        window.TOCAFICHADR_audio.startVisualizerBroadcast(33);
      }
    } catch (_) { /* viz is non-critical, never break recording */ }
  }

  function _stopWaveformBroadcast() {
    try {
      if (window.TOCAFICHADR_audio && typeof window.TOCAFICHADR_audio.stopVisualizerBroadcast === 'function') {
        window.TOCAFICHADR_audio.stopVisualizerBroadcast();
      }
    } catch (_) {}
  }

  async function _handleStartRecording(_msg, sender) {
    if (!window.TOCAFICHADR_audio) {
      return { ok: false, error: 'audio module missing' };
    }
    try {
      await window.TOCAFICHADR_audio.start(async (blob, error, audioTimestamps) => {
        // The recorder.onstop path runs after mic teardown; the audio module
        // already calls stopVisualizerBroadcast() inside _release(). This is
        // a defensive no-op in case the start() callback fires from an error
        // path before _release() runs.
        _stopWaveformBroadcast();
        if (error) {
          chrome.runtime.sendMessage({ type: 'TOCAFICHADR_RECORDING_ERROR', error }).catch(() => {});
          return;
        }
        // Convert blob → base64 and forward to side panel for transcription.
        try {
          var audioConfig = null;
          try {
            if (window.TOCAFICHADR_audio && typeof window.TOCAFICHADR_audio.getEffectiveAudioConfig === 'function') {
              audioConfig = window.TOCAFICHADR_audio.getEffectiveAudioConfig();
            }
          } catch (_) {}
          // CHRA-1102: record base64 conversion start
          var ts = audioTimestamps || {};
          ts.base64_start = Date.now();
          const b64 = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => {
              const s = r.result;
              const i = s.indexOf(',');
              resolve(i >= 0 ? s.slice(i + 1) : s);
            };
            r.onerror = () => reject(new Error('blob read failed'));
            r.readAsDataURL(blob);
          });
          // CHRA-1102: record base64 conversion done
          ts.base64_done = Date.now();
          chrome.runtime.sendMessage({
            type: 'TOCAFICHADR_RECORDING_BLOB',
            audioBase64: b64,
            mimeType: blob.type || 'audio/webm',
            size: blob.size,
            audioConfig: audioConfig,
            timestamps: ts,
          }).catch(() => {});
        } catch (e) {
          chrome.runtime.sendMessage({ type: 'TOCAFICHADR_RECORDING_ERROR', error: e.message }).catch(() => {});
        }
      });
      // Now that the recorder is live, fire the waveform broadcaster. It will
      // run until stop() / _release() / track-end clears the interval.
      _startWaveformBroadcast();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  function _handleStopRecording() {
    try {
      _stopWaveformBroadcast();
      window.TOCAFICHADR_audio.stop();
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Command router — side panel → content script
  // var (hoisted) instead of const so the synchronous listener at the top of
  // this IIFE can safely typeof-check before assignment without hitting TDZ.
  // ─────────────────────────────────────────────────────────────────────────
  HANDLERS = {
    'SIDEPANEL_GET_PATIENT': () => {
      try {
        return {
          ok: true,
          info: window.TOCAFICHADR_dom.extractPatientInfo(),
          urlKey: _computeTemplateUrlKey(),
        };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    'SIDEPANEL_CLEAR_SOAP': () => {
      try {
        const n = window.TOCAFICHADR_dom.clearSoapFields();
        return { ok: true, cleared: n };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    'SIDEPANEL_PASTE_SOAP': (msg) => {
      try {
        // v3.2.0: pasteSoapNote returns {ok, fieldsWritten, hasField0} so the
        // side panel can detect "wrong sub-page / dialog open" cases instead
        // of falsely reporting success on no-throw.
        const result = window.TOCAFICHADR_dom.pasteSoapNote(msg.soapText || '');
        return {
          ok: !!(result && result.ok),
          fieldsWritten: (result && result.fieldsWritten) || 0,
          hasField0: !!(result && result.hasField0),
        };
      } catch (e) { return { ok: false, fieldsWritten: 0, hasField0: false, error: e.message }; }
    },
    'SIDEPANEL_SEARCH_CID': (msg) => {
      try {
        const results = (window.TOCAFICHADR_cidSearch || (() => []))(msg.query || '');
        return { ok: true, results: (results || []).slice(0, 20) };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    'SIDEPANEL_FILL_CID': async (msg) => {
      try {
        const ok = await window.TOCAFICHADR_dom.fillCid(msg.code, msg.name);
        return { ok };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    'SIDEPANEL_SAVE_FORM': () => {
      try { return { ok: window.TOCAFICHADR_dom.saveForm() }; }
      catch (e) { return { ok: false, error: e.message }; }
    },
    'SIDEPANEL_OPEN_PRESCRIPTION': async () => {
      try { return { ok: await window.TOCAFICHADR_dom.openPrescription() }; }
      catch (e) { return { ok: false, error: e.message }; }
    },
    'SIDEPANEL_OPEN_ATESTADO': async () => {
      try { return { ok: await window.TOCAFICHADR_dom.openAtestado() }; }
      catch (e) { return { ok: false, error: e.message }; }
    },
    // Drawer-driven full atestado flow: open dialog → set days → fill obs
    // (single-line per companion mode) → save → print. The drawer is the
    // single source of truth for both `days` and the companion mode chips;
    // runAtestadoFull doesn't read storage.
    'SIDEPANEL_RUN_ATESTADO_FULL': async (msg) => {
      try {
        const days = (msg && msg.days) || 1;
        const raw = msg && msg.companionMode;
        // Accepts 'mae' | 'pai' | 'outro' or null (patient-only). Legacy
        // 'general' or any unknown value collapses to null — runAtestadoFull
        // skips the obs-writing step when the mode is null.
        const companionMode = (raw === 'mae' || raw === 'pai' || raw === 'outro') ? raw : null;
        return await window.TOCAFICHADR_dom.runAtestadoFull(days, companionMode);
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    },
    // v3.4.0 — drawer needs to display the parent name lines under the
    // companion toggle. Surfaces extractCompanionInfo() so the side panel can
    // render them when the drawer opens.
    'SIDEPANEL_GET_COMPANION_INFO': async () => {
      try {
        return { ok: true, companions: await window.TOCAFICHADR_dom.extractCompanionInfo() };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    },
    // Side panel proxies clipboard writes through the bridge because MV3
    // side panels lose focus when the doctor clicks back into G-Hosp, which
    // is when SOAP_DONE arrives. The G-Hosp tab IS focused at that moment,
    // and its content-script context shares the document's focus state — so
    // navigator.clipboard.writeText() succeeds here even though it would
    // reject from the side panel. Falls back gracefully if the page is also
    // unfocused; the side panel keeps a manual 📋 icon as last resort.
    'SIDEPANEL_COPY_CLIPBOARD': async (msg) => {
      const text = (msg && typeof msg.text === 'string') ? msg.text : '';
      if (!text) return { ok: false, error: 'empty text' };
      try {
        await navigator.clipboard.writeText(text);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    },
    'SIDEPANEL_OPEN_BAU_MEDICO': () => {
      try { window.TOCAFICHADR_dom.openBauMedico(); return { ok: true }; }
      catch (e) { return { ok: false, error: e.message }; }
    },
    'SIDEPANEL_RUN_TEMPLATE': async (msg) => {
      try {
        const tpl = msg.template;
        const ok = await window.TOCAFICHADR_dom.runSimplesPrescription(tpl);
        return {
          ok,
          error: ok ? undefined : (
            window.TOCAFICHADR_dom.getLastSimplesError
              ? window.TOCAFICHADR_dom.getLastSimplesError()
              : 'não foi possível abrir a receita simples'
          ),
        };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    // v3.4.0 — Smart-template apply path: side panel rendered the meds +
    // extraText against the dosages catalog and the doctor confirmed the
    // (possibly edited) text in the preview drawer. We drive the Simples
    // flow with that pre-rendered string instead of the template's `body`.
    'SIDEPANEL_RUN_SIMPLES_WITH_BODY': async (msg) => {
      try {
        const body = (msg && typeof msg.body === 'string') ? msg.body : '';
        if (!body.trim()) return { ok: false, error: 'corpo vazio' };
        // runSimplesPrescription reads template.body; we synthesize a
        // minimal template object so existing instrumentation (template.name
        // logging, error reporting) keeps working.
        const ok = await window.TOCAFICHADR_dom.runSimplesPrescription({
          name: 'smart-template',
          body,
        });
        return {
          ok,
          error: ok ? undefined : (
            window.TOCAFICHADR_dom.getLastSimplesError
              ? window.TOCAFICHADR_dom.getLastSimplesError()
              : 'não foi possível abrir a receita simples'
          ),
        };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    // v3.1.8 — server-side G-Hosp template catalog
    //
    // urlKey is the consultation-context discriminator: same template ID
    // (e.g. 637) maps to different labels depending on where it's clicked
    // ("OMA amoxi" on pediatric URLs vs "Laringotraqueíte viral" on adult).
    // We key the catalog by `(pathname + consultation-type query)` so each
    // patient context gets its own label list. Only safe known params are
    // included to keep the key stable across patients of the same type.
    'SIDEPANEL_PROBE_GHOSP_TEMPLATES': async () => {
      try {
        const templates = await window.TOCAFICHADR_dom.probeGhospTemplates();
        const urlKey = _computeTemplateUrlKey();
        return { ok: true, templates: templates || [], urlKey: urlKey };
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    },
    'SIDEPANEL_RUN_GHOSP_TEMPLATE': async (msg) => {
      try {
        const id = msg && msg.templateId;
        if (!id) return { ok: false, error: 'templateId ausente' };
        return await window.TOCAFICHADR_dom.runGhospTemplate(id);
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    },
    'SIDEPANEL_FINALIZE_PRESCRIPTION': async () => {
      try { return { ok: await window.TOCAFICHADR_dom.finalizeSimplesPrescription() }; }
      catch (e) { return { ok: false, error: e.message }; }
    },
    'SIDEPANEL_FINALIZE_ATESTADO': async () => {
      try { return { ok: await window.TOCAFICHADR_dom.finalizeAtestado() }; }
      catch (e) { return { ok: false, error: e.message }; }
    },
    'SIDEPANEL_FINALIZE_PATIENT': async (msg) => {
      // Mirrors the HUD's "Alta e voltar" flow: discharge → goToMainList.
      // processDischarge() now throws Error('<token>') on each known failure
      // point (no_intern_id, link_not_found, form_not_found, verification_failed) —
      // we bubble e.message up so the side panel can translate to a Portuguese hint.
      try {
        const internId = msg.internId || window.TOCAFICHADR_dom.getInternId();
        if (!internId) return { ok: false, error: 'discharge_no_intern_id' };
        await window.TOCAFICHADR_dom.processDischarge(internId);
        await new Promise((r) => setTimeout(r, 1500));
        await window.TOCAFICHADR_dom.goToMainList();
        try { window.TOCAFICHADR_api.logAudit('finalize_patient', { internId }); } catch (_) {}
        return { ok: true };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    'SIDEPANEL_START_RECORDING': _handleStartRecording,
    'SIDEPANEL_STOP_RECORDING':  _handleStopRecording,
  };

  console.log('[Toca Ficha Dr.] bridge ready (v3.1 side-panel mode)');
})();
