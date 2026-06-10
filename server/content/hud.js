'use strict';

// hud.js — Floating HUD panel for Toca Ficha Dr. (thin client rewrite)
// Orchestrates: TOCAFICHADR_api (api-client.js), TOCAFICHADR_audio (audio-capture.js),
//               TOCAFICHADR_dom (dom-engine.js)
// IIFE namespaced as window.TOCAFICHADR_hud

window.TOCAFICHADR_hud = (function () {

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  // Prescription templates are loaded from chrome.storage.local.userConfig.rx_templates.
  // v3.1: schema v2 — { id, diagnosis, ageBand, body, frequency }.
  // Doctor edits via the popup or sidepanel. HUD uses `diagnosis + ageBand`
  // as the visible label and increments `frequency` per click so the popup
  // can sort by usage. Legacy { id, name, body } templates are migrated by
  // _migrateLegacyTemplate() on every read.
  const DEFAULT_RX_TEMPLATES = [
    { id: 'tpl_1', diagnosis: 'Modelo 1', ageBand: '', body: '', frequency: 0 },
    { id: 'tpl_2', diagnosis: 'Modelo 2', ageBand: '', body: '', frequency: 0 },
    { id: 'tpl_3', diagnosis: 'Modelo 3', ageBand: '', body: '', frequency: 0 },
    { id: 'tpl_4', diagnosis: 'Modelo 4', ageBand: '', body: '', frequency: 0 },
    { id: 'tpl_5', diagnosis: 'Modelo 5', ageBand: '', body: '', frequency: 0 },
    { id: 'tpl_6', diagnosis: 'Modelo 6', ageBand: '', body: '', frequency: 0 },
  ];
  let RX_TEMPLATES = DEFAULT_RX_TEMPLATES.slice();

  function _migrateLegacyTemplate(t) {
    if (!t) return t;
    if (t.diagnosis !== undefined) return t;
    var name = String(t.name || '').trim();
    var m = name.match(/^(.+?)\s+([<>≥≤]\s*\d+\s*[mad]?(?:\s+e\s+[<>≥≤]\s*\d+\s*[mad]?)?|qualquer|adulto)\s*$/i);
    if (m) return { id: t.id, diagnosis: m[1].trim(), ageBand: m[2].trim(), body: t.body || '', frequency: t.frequency || 0 };
    return { id: t.id, diagnosis: name || 'Modelo', ageBand: '', body: t.body || '', frequency: t.frequency || 0 };
  }

  function _tplLabel(t) {
    if (!t) return '';
    var dx = (t.diagnosis || t.name || 'Modelo').trim();
    var age = (t.ageBand || '').trim();
    return age ? dx + ' · ' + age : dx;
  }

  function _bumpFrequency(tplId) {
    chrome.storage.local.get(['userConfig', 'apiBaseUrl'], function (data) {
      var cfg = data && data.userConfig;
      var arr = Array.isArray(cfg && cfg.rx_templates) ? cfg.rx_templates.slice().map(_migrateLegacyTemplate) : [];
      var t = arr.find(function (x) { return x.id === tplId; });
      if (!t) return;
      t.frequency = (t.frequency || 0) + 1;
      // Optimistic local write; server PATCH follows for cross-device persistence.
      chrome.storage.local.set({ userConfig: Object.assign({}, cfg, { rx_templates: arr }) });
      var base = (data && data.apiBaseUrl) || 'https://api.tocafichadr.com.br';
      chrome.runtime.sendMessage({
        type: 'TOCAFICHADR_FETCH', method: 'PATCH',
        url: base + '/api/me/config',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rx_templates: arr }),
      }, function () {});
      // Publish for dom-engine's print tracker — lets it attribute a subsequent
      // print to this template (within a 2-min window) for source='hud' tagging.
      window.TOCAFICHADR_lastTemplate = {
        id: t.id,
        diagnosis: t.diagnosis || '',
        ageBand: t.ageBand || '',
        at: Date.now(),
      };
      // Mirror to server so Flask can rank prescriptions across sessions.
      if (window.TOCAFICHADR_api && window.TOCAFICHADR_api.logAudit) {
        window.TOCAFICHADR_api.logAudit('prescription_select', {
          tplId: t.id,
          diagnosis: t.diagnosis || '',
          ageBand: t.ageBand || '',
        });
      }
    });
  }

  // v3.1 idea #6: per-day usage stats stored locally.
  // Schema: chrome.storage.local.usageStats = {
  //   '2026-05-04': { transcribe: 5, rxClick: 4, finalize: 5 },
  //   '2026-05-03': { ... }
  // }
  // We approximate "minutos poupados" as: transcribe * 4 (4 min per dictation
  // vs typing) + rxClick * 1.5 (1.5 min per prescription click vs manual flow)
  // + finalize * 1.5 (discharge automation). Keeps last 30 days only.
  var SAVED_PER_TRANSCRIBE = 4.0;
  var SAVED_PER_RX = 1.5;
  var SAVED_PER_FINALIZE = 1.5;

  function _todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function _bumpUsageStats(actionType) {
    if (!chrome || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get(['usageStats'], function (data) {
      var stats = data.usageStats || {};
      var key = _todayKey();
      if (!stats[key]) stats[key] = {};
      stats[key][actionType] = (stats[key][actionType] || 0) + 1;
      // Trim to last 30 days
      var keys = Object.keys(stats).sort();
      while (keys.length > 30) { delete stats[keys.shift()]; }
      chrome.storage.local.set({ usageStats: stats });
    });
  }
  // Expose so other modules (or future side panel) can read.
  if (typeof window !== 'undefined') {
    window.TOCAFICHADR_stats = {
      bump: _bumpUsageStats,
      todayKey: _todayKey,
      SAVED_PER_TRANSCRIBE: SAVED_PER_TRANSCRIBE,
      SAVED_PER_RX: SAVED_PER_RX,
      SAVED_PER_FINALIZE: SAVED_PER_FINALIZE,
    };
  }

  // How long (ms) to keep an "ok" status visible before hiding
  const STATUS_OK_DURATION = 4000;

  // Connection check interval in ms
  const CONNECTION_CHECK_INTERVAL = 30000;

  // ---------------------------------------------------------------------------
  // Internal state
  // ---------------------------------------------------------------------------

  const FREE_DAILY_LIMIT = 5;

  const state = {
    minimized:        false,
    wideMode:         false,
    recording:        false,
    processing:       false,
    finalizing:       false,
    // v3.1 idea #3: waveform visualizer handle — set in startRecording, torn down in stopRecording.
    waveformHandle:   null,
    timerInterval:    null,
    timerSeconds:     0,
    patientInfo:      {},
    selectedTemplate: null,
    soapReady:        false,
    connected:        false,
    // Suggested CID kept for apply-on-click
    suggestedCid:     null,
    // Usage tracking
    usageCount:       0,
    usageDate:        null,
    isPro:            false,
    // Finalization retry tracking
    finalizeStep:      0,
    finalizeInternId:  null,
    // Track whether prescription was already inserted via template button
    prescriptionDone:  false,
    // Confirm-pending timer (in-HUD double-click confirmation)
    finalizeConfirmTimer:  null,
    // Mutex flags for prescription flows (P1-5): prevent double-click duplicates
    rxFinalizing:     false,
    rxRunning:        false,
    // Atestado finalize mutex (mirrors rxFinalizing)
    atestadoFinalizing: false,
  };

  // P1-7: track the chrome.storage.onChanged listener so cleanup() can remove
  // it on page unload. Without this, SPA re-navigations that re-run the
  // content-script IIFE stack additional listeners — older detached HUDs then
  // also fire when the doctor edits templates in the popup.
  let storageListener = null;
  // Stored so cleanup() can clearInterval on SPA re-navigation; without this,
  // each page transition added a new 30s connection-check interval that was
  // never cancelled, resulting in N parallel checkConnection() calls per shift.
  let connectionCheckTimer = null;

  // ---------------------------------------------------------------------------
  // Helper: sleep
  // ---------------------------------------------------------------------------

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // ---------------------------------------------------------------------------
  // SVG icon system — stroke-based, 14px, currentColor.
  // Built via createElementNS (no innerHTML) for CSP safety.
  // ---------------------------------------------------------------------------

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }
  function svgRoot(viewBox, children) {
    const root = svgEl('svg', {
      viewBox: viewBox,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.6',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    });
    for (let i = 0; i < children.length; i++) {
      root.appendChild(svgEl(children[i][0], children[i][1]));
    }
    return root;
  }

  const ICONS = {
    wide:     function () { return svgRoot('0 0 24 24', [['polyline', {points:'9 18 3 12 9 6'}], ['polyline', {points:'15 6 21 12 15 18'}]]); },
    refresh:  function () { return svgRoot('0 0 24 24', [['polyline', {points:'23 4 23 10 17 10'}], ['path', {d:'M20.49 15a9 9 0 1 1-2.12-9.36L23 10'}]]); },
    minimize: function () { var s = svgRoot('0 0 24 24', [['line', {x1:'5', y1:'12', x2:'19', y2:'12'}]]); s.setAttribute('stroke-width', '1.8'); return s; },
    save:     function () { return svgRoot('0 0 24 24', [['path', {d:'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z'}], ['polyline', {points:'17 21 17 13 7 13 7 21'}], ['polyline', {points:'7 3 7 8 15 8'}]]); },
    pill:     function () { return svgRoot('0 0 24 24', [['path', {d:'M10.5 6.5l7 7M14 4l6 6-9 9-6-6 9-9z'}]]); },
    file:     function () { return svgRoot('0 0 24 24', [['path', {d:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'}], ['polyline', {points:'14 2 14 8 20 8'}], ['line', {x1:'9', y1:'13', x2:'15', y2:'13'}], ['line', {x1:'9', y1:'17', x2:'15', y2:'17'}]]); },
    bag:      function () { return svgRoot('0 0 24 24', [['rect', {x:'2', y:'7', width:'20', height:'14', rx:'2', ry:'2'}], ['path', {d:'M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16'}]]); },
    mic:      function () { var s = svgRoot('0 0 24 24', [['rect', {x:'9', y:'2', width:'6', height:'13', rx:'3'}], ['path', {d:'M19 10v2a7 7 0 0 1-14 0v-2'}], ['line', {x1:'12', y1:'19', x2:'12', y2:'23'}], ['line', {x1:'8', y1:'23', x2:'16', y2:'23'}]]); s.setAttribute('stroke-width', '1.8'); return s; },
    alert:    function () { return svgRoot('0 0 24 24', [['path', {d:'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z'}], ['line', {x1:'12', y1:'9', x2:'12', y2:'13'}], ['line', {x1:'12', y1:'17', x2:'12.01', y2:'17'}]]); },
    check:    function () { var s = svgRoot('0 0 24 24', [['polyline', {points:'20 6 9 17 4 12'}]]); s.setAttribute('stroke-width', '2.4'); return s; },
  };

  function iconNode(name) {
    const span = document.createElement('span');
    span.className = 'pb-icon';
    if (ICONS[name]) span.appendChild(ICONS[name]());
    return span;
  }

  // ---------------------------------------------------------------------------
  // DOM construction helpers (no innerHTML on dynamic data)
  // ---------------------------------------------------------------------------

  /** Create an element, optionally set className and/or id */
  function el(tag, opts) {
    const node = document.createElement(tag);
    if (opts && opts.id)        node.id        = opts.id;
    if (opts && opts.cls)       node.className = opts.cls;
    if (opts && opts.text)      node.textContent = opts.text;
    if (opts && opts.title)     node.title     = opts.title;
    if (opts && opts.type)      node.type      = opts.type;
    if (opts && opts.placeholder) node.placeholder = opts.placeholder;
    if (opts && opts.autocomplete) node.autocomplete = opts.autocomplete;
    return node;
  }

  function buildHudDOM() {
    // Root
    const panel = el('div', { cls: 'pb-panel' });

    // ---- Header ----
    const header = el('div', { cls: 'pb-header', id: 'pb-drag-handle' });

    const title = el('div', { cls: 'pb-title' });
    const label = el('span', { cls: 'pb-label', text: 'Toca Ficha Dr.' });
    title.appendChild(label);

    // Status pill \u2014 combines connection state + daily usage in one element.
    // Hidden dot kept for back-compat with checkConnection() existing logic.
    const statusPill = el('span', { cls: 'pb-status-pill', id: 'pb-status-pill' });
    const pillDot    = el('span', { cls: 'pb-pill-dot', id: 'pb-connection' });
    const pillState  = el('span', { cls: 'pb-pill-state', id: 'pb-conn-label', text: 'OFF' });
    const pillSep    = el('span', { cls: 'pb-pill-sep', text: '\u00b7' });
    const pillUsage  = el('span', { cls: 'pb-pill-usage', id: 'pb-pill-usage', text: '0/' + FREE_DAILY_LIMIT });
    statusPill.appendChild(pillDot);
    statusPill.appendChild(pillState);
    statusPill.appendChild(pillSep);
    statusPill.appendChild(pillUsage);

    const headerActions  = el('div', { cls: 'pb-header-actions' });
    const wideBtn        = el('button', { cls: 'pb-icon-btn', id: 'pb-wide-toggle', title: 'Modo largo' });
    wideBtn.setAttribute('aria-label', 'Alternar modo largo');
    wideBtn.appendChild(iconNode('wide'));
    const refreshBtn     = el('button', { cls: 'pb-icon-btn', id: 'pb-refresh', title: 'Atualizar paciente' });
    refreshBtn.setAttribute('aria-label', 'Atualizar paciente');
    refreshBtn.appendChild(iconNode('refresh'));
    const minimizeBtn    = el('button', { cls: 'pb-icon-btn', id: 'pb-minimize', title: 'Minimizar' });
    minimizeBtn.setAttribute('aria-label', 'Minimizar');
    minimizeBtn.appendChild(iconNode('minimize'));
    headerActions.appendChild(statusPill);
    headerActions.appendChild(wideBtn);
    headerActions.appendChild(refreshBtn);
    headerActions.appendChild(minimizeBtn);

    header.appendChild(title);
    header.appendChild(headerActions);

    // ---- Body ----
    const body = el('div', { cls: 'pb-body' });

    // Patient card
    const patientCard = el('div', { cls: 'pb-patient-card', id: 'pb-patient-card' });
    const patientId   = el('div', { cls: 'pb-patient-id' });
    patientId.textContent = 'ID: ';
    const patientIdSpan = el('span', { id: 'pb-intern-id', text: '\u2014' });
    patientId.appendChild(patientIdSpan);
    const patientWeight    = el('div', { cls: 'pb-patient-weight', id: 'pb-weight', text: '\u2014 kg' });
    const patientComplaint = el('div', { cls: 'pb-patient-complaint', id: 'pb-complaint', text: 'Sem queixa detectada' });
    patientCard.appendChild(patientId);
    patientCard.appendChild(patientWeight);
    patientCard.appendChild(patientComplaint);
    body.appendChild(patientCard);

    // Record section
    const recordSection = el('div', { cls: 'pb-record-section' });
    const recordBtn     = el('button', { cls: 'pb-record-btn idle', id: 'pb-record-btn' });
    recordBtn.setAttribute('aria-label', 'Iniciar gravação');
    const recordIcon    = el('span', { id: 'pb-record-icon', cls: 'pb-record-mic' });
    recordIcon.appendChild(iconNode('mic'));
    const recordLabelEl = el('span', { id: 'pb-record-label', cls: 'pb-record-label', text: 'Gravar Consulta' });
    // Pulse ring + check mark elements (toggled via state class on .pb-record-btn)
    const recordRing    = el('span', { cls: 'pb-record-ring' });
    const recordCheck   = el('span', { cls: 'pb-record-check' });
    recordCheck.appendChild(iconNode('check'));
    recordBtn.appendChild(recordRing);
    recordBtn.appendChild(recordIcon);
    recordBtn.appendChild(recordLabelEl);
    recordBtn.appendChild(recordCheck);
    const timer = el('div', { cls: 'pb-timer', id: 'pb-timer', text: '00:00' });
    // v3.1 idea #3: live waveform canvas — visible only during recording.
    const waveCanvas = el('canvas', { cls: 'pb-waveform', id: 'pb-waveform' });
    waveCanvas.width = 220; waveCanvas.height = 36;
    waveCanvas.style.display = 'none';
    recordSection.appendChild(recordBtn);
    recordSection.appendChild(waveCanvas);
    recordSection.appendChild(timer);
    body.appendChild(recordSection);

    // Usage counter
    const usageRow = el('div', { cls: 'pb-usage-row', id: 'pb-usage-row' });
    const usageCounter = el('span', { cls: 'pb-usage-counter', id: 'pb-usage-counter', text: '0/' + FREE_DAILY_LIMIT + ' notas hoje' });
    const usageUpgrade = el('button', { cls: 'pb-usage-upgrade', id: 'pb-usage-upgrade', text: 'Assinar Pro \u2014 R$49/m\u00eas' });
    usageUpgrade.setAttribute('aria-label', 'Assinar plano Pro');
    usageUpgrade.style.display = 'none';
    usageRow.appendChild(usageCounter);
    usageRow.appendChild(usageUpgrade);
    body.appendChild(usageRow);

    // SOAP status
    const soapStatusEl = el('div', { cls: 'pb-soap-status', id: 'pb-soap-status' });
    soapStatusEl.setAttribute('role', 'status');
    soapStatusEl.setAttribute('aria-live', 'polite');
    body.appendChild(soapStatusEl);

    // SOAP preview (visible only in wide mode when soap is ready)
    const soapPreview = el('div', { cls: 'pb-soap-preview', id: 'pb-soap-preview' });
    soapPreview.style.display = 'none';
    body.appendChild(soapPreview);

    body.appendChild(el('div', { cls: 'pb-divider' }));

    // CID section
    const cidSection    = el('div', { cls: 'pb-cid-section' });
    const cidSectionLbl = el('div', { cls: 'pb-section-label', text: 'CID-10' });
    const cidSuggestion = el('div', { cls: 'pb-cid-suggestion', id: 'pb-cid-suggestion', title: 'Clique para aplicar' });
    cidSuggestion.setAttribute('tabindex', '0');
    cidSuggestion.setAttribute('role', 'button');
    cidSuggestion.setAttribute('aria-label', 'Aplicar CID sugerido');
    const cidCode       = el('span', { cls: 'pb-cid-code', id: 'pb-cid-code', text: '\u2014' });
    const cidName       = el('span', { cls: 'pb-cid-name', id: 'pb-cid-name', text: '\u2014' });
    const cidApply      = el('span', { cls: 'pb-cid-apply', text: '\u2713' });
    cidSuggestion.appendChild(cidCode);
    cidSuggestion.appendChild(cidName);
    cidSuggestion.appendChild(cidApply);
    const cidInput = el('input', {
      cls:          'pb-cid-input',
      id:           'pb-cid-input',
      placeholder:  'Buscar CID (ex: J06.9, febre...)',
      autocomplete: 'off',
    });
    const cidResults = el('div', { cls: 'pb-cid-results', id: 'pb-cid-results' });
    cidSection.appendChild(cidSectionLbl);
    cidSection.appendChild(cidSuggestion);
    cidSection.appendChild(cidInput);
    cidSection.appendChild(cidResults);
    body.appendChild(cidSection);
    body.appendChild(el('div', { cls: 'pb-divider' }));

    // Template section — buttons rendered dynamically from storage.
    // Filled by renderTemplateButtons() after the HUD mounts and on storage changes.
    const templateSectionLbl = el('div', { cls: 'pb-section-label', text: 'Receita \u2014 Modelos' });
    const templatesGrid      = el('div', { cls: 'pb-templates', id: 'pb-templates' });
    body.appendChild(templateSectionLbl);
    body.appendChild(templatesGrid);

    // Finalize-prescription bar (hidden until a template is loaded into the editor)
    // Uses shared .pb-finalize-bar / .pb-finalize-action classes, mirrored by
    // the atestado finalize bar below.
    const rxFinalizeBar = el('div', { cls: 'pb-finalize-bar', id: 'pb-rx-finalize-bar' });
    const rxFinalizeBtn = el('button', { cls: 'pb-finalize-action', id: 'pb-rx-finalize-btn' });
    rxFinalizeBtn.textContent = '\u2705 Salvar e Imprimir Receita';
    rxFinalizeBar.appendChild(rxFinalizeBtn);
    body.appendChild(rxFinalizeBar);

    // Finalize-atestado bar (hidden until the atestado dialog is opened)
    const atestadoFinalizeBar = el('div', { cls: 'pb-finalize-bar', id: 'pb-atestado-finalize-bar' });
    const atestadoFinalizeBtn = el('button', { cls: 'pb-finalize-action', id: 'pb-atestado-finalize-btn' });
    atestadoFinalizeBtn.textContent = '\u2705 Salvar e Imprimir Atestado';
    atestadoFinalizeBar.appendChild(atestadoFinalizeBtn);
    body.appendChild(atestadoFinalizeBar);

    body.appendChild(el('div', { cls: 'pb-divider' }));

    // Action buttons — 2x2 grid, icon stacked above label (v2.5.11 layout)
    const actionsLbl = el('div', { cls: 'pb-section-label', text: 'Ações' });
    body.appendChild(actionsLbl);
    const actions = el('div', { cls: 'pb-actions' });
    const actionDefs = [
      { id: 'pb-btn-save',          icon: 'save', label: 'Salvar',   ariaLabel: 'Salvar prontuário' },
      { id: 'pb-btn-prescription',  icon: 'pill', label: 'Receita',  ariaLabel: 'Abrir receita' },
      { id: 'pb-btn-atestado',      icon: 'file', label: 'Atestado', ariaLabel: 'Atestado' },
      { id: 'pb-btn-bau',           icon: 'bag',  label: 'Baú',      ariaLabel: 'Baú Médico' },
    ];
    actionDefs.forEach(function (def) {
      const btn = el('button', { cls: 'pb-action-btn', id: def.id });
      btn.setAttribute('aria-label', def.ariaLabel);
      const iconWrap = el('span', { cls: 'pb-action-icon' });
      iconWrap.appendChild(iconNode(def.icon));
      const label = el('span', { cls: 'pb-action-label', text: def.label });
      btn.appendChild(iconWrap);
      btn.appendChild(label);
      actions.appendChild(btn);
    });
    body.appendChild(actions);

    // Discharge + return button
    const finalizeBtn = el('button', { cls: 'pb-finalize-btn', id: 'pb-finalize' });
    finalizeBtn.textContent = '\u2705 Alta e voltar';
    finalizeBtn.setAttribute('aria-label', 'Alta e voltar');
    body.appendChild(finalizeBtn);

    panel.appendChild(header);
    panel.appendChild(body);
    return panel;
  }

  // ---------------------------------------------------------------------------
  // createHUD()
  // ---------------------------------------------------------------------------

  function createHUD() {
    if (document.getElementById('tocafichadr-hud')) return;

    const hud = el('div');
    hud.id = 'tocafichadr-hud';
    hud.setAttribute('role', 'region');
    hud.setAttribute('aria-label', 'Toca Ficha Dr. - Assistente Médico');
    hud.appendChild(buildHudDOM());
    document.body.appendChild(hud);

    setupDrag(hud);
    setupEvents(hud);
    checkConnection();
    refreshPatient();
    loadUsage();

    // Restore wide mode preference
    try {
      chrome.storage.local.get(['pedbotWideMode'], function (data) {
        if (data.pedbotWideMode) {
          state.wideMode = true;
          hud.classList.add('wide');
          updateSoapPreview();
        }
      });
    } catch (_) {}

    // Periodic connection re-check — handle stored for clearInterval in cleanup()
    connectionCheckTimer = setInterval(checkConnection, CONNECTION_CHECK_INTERVAL);

    window.addEventListener('beforeunload', cleanup);
  }

  // ---------------------------------------------------------------------------
  // Drag
  // ---------------------------------------------------------------------------

  function setupDrag(hud) {
    const handle = hud.querySelector('#pb-drag-handle');
    let isDragging = false;
    let startX, startY, startRight, startTop;

    function onPointerDown(clientX, clientY) {
      isDragging = true;
      startX = clientX;
      startY = clientY;
      const rect = hud.getBoundingClientRect();
      startRight = window.innerWidth - rect.right;
      startTop   = rect.top;
    }

    function onPointerMove(clientX, clientY) {
      if (!isDragging) return;
      const dx = startX - clientX;
      const dy = clientY - startY;
      hud.style.right = Math.max(0, startRight + dx) + 'px';
      hud.style.top   = Math.max(0, startTop  + dy) + 'px';
    }

    function onPointerUp() {
      isDragging = false;
    }

    // Mouse events
    handle.addEventListener('mousedown', function (e) {
      if (e.target.closest('.pb-icon-btn')) return;
      onPointerDown(e.clientX, e.clientY);
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      onPointerMove(e.clientX, e.clientY);
    });

    document.addEventListener('mouseup', onPointerUp);

    // Touch events
    handle.addEventListener('touchstart', function (e) {
      if (e.target.closest('.pb-icon-btn')) return;
      var touch = e.touches[0];
      onPointerDown(touch.clientX, touch.clientY);
      e.preventDefault();
    }, { passive: false });

    document.addEventListener('touchmove', function (e) {
      if (!isDragging) return;
      var touch = e.touches[0];
      onPointerMove(touch.clientX, touch.clientY);
      e.preventDefault();
    }, { passive: false });

    document.addEventListener('touchend', onPointerUp);
  }

  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------

  function setupEvents(hud) {
    // Minimize toggle
    hud.querySelector('#pb-minimize').addEventListener('click', function (e) {
      e.stopPropagation();
      state.minimized = !state.minimized;
      hud.classList.toggle('minimized', state.minimized);
    });

    // Click anywhere on the minimized HUD to restore. Required because the
    // minimize button itself is display:none in minimized state, so the user
    // would otherwise be stuck with a 44px ball and no way back.
    hud.addEventListener('click', function () {
      if (state.minimized) {
        state.minimized = false;
        hud.classList.remove('minimized');
      }
    });

    // Wide mode toggle
    hud.querySelector('#pb-wide-toggle').addEventListener('click', function () {
      state.wideMode = !state.wideMode;
      hud.classList.toggle('wide', state.wideMode);
      // Show/hide SOAP preview in wide mode
      updateSoapPreview();
      // Persist preference
      try {
        chrome.storage.local.set({ pedbotWideMode: state.wideMode });
      } catch (_) {}
    });

    // Manual patient refresh
    hud.querySelector('#pb-refresh').addEventListener('click', refreshPatient);

    // Record button
    hud.querySelector('#pb-record-btn').addEventListener('click', toggleRecording);

    // CID suggestion — apply on click or Enter/Space
    hud.querySelector('#pb-cid-suggestion').addEventListener('click', function () {
      if (state.suggestedCid) {
        applyCid(state.suggestedCid.code, state.suggestedCid.name);
      }
    });
    hud.querySelector('#pb-cid-suggestion').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (state.suggestedCid) {
          applyCid(state.suggestedCid.code, state.suggestedCid.name);
        }
      }
    });

    // CID manual search input
    const cidInputEl  = hud.querySelector('#pb-cid-input');
    const cidResultsEl = hud.querySelector('#pb-cid-results');

    cidInputEl.addEventListener('input', function () {
      const q = cidInputEl.value.trim();
      if (q.length < 2) {
        cidResultsEl.classList.remove('visible');
        return;
      }
      if (typeof window.TOCAFICHADR_cidSearch === 'function') {
        renderCidResults(window.TOCAFICHADR_cidSearch(q), cidResultsEl, cidInputEl);
      }
    });

    cidInputEl.addEventListener('blur', function () {
      setTimeout(function () { cidResultsEl.classList.remove('visible'); }, 200);
    });

    // Upgrade button — open billing portal
    hud.querySelector('#pb-usage-upgrade').addEventListener('click', function () {
      var baseUrl = window.TOCAFICHADR_api.getBaseUrl();
      window.open(baseUrl + '/billing/portal', '_blank');
    });

    // ------------------------------------------------------------------------
    // Modifiable prescription templates (Apr 2026)
    // ------------------------------------------------------------------------
    // Buttons are rendered from chrome.storage.local.userConfig.rx_templates.
    // Click → runSimplesPrescription opens the blank Simples editor and fills
    // it with the template body. The "Salvar e Imprimir" bar then becomes
    // visible so the doctor can finalize after reviewing/editing.

    function renderTemplateButtons() {
      const grid = hud.querySelector('#pb-templates');
      if (!grid) return;
      while (grid.firstChild) grid.removeChild(grid.firstChild);

      // Sort by frequency desc so most-used surface first; ties keep insertion order.
      var sorted = RX_TEMPLATES.slice().sort(function (a, b) {
        return (b.frequency || 0) - (a.frequency || 0);
      });

      sorted.forEach(function (tpl) {
        const btn = document.createElement('button');
        btn.className = 'pb-template-btn';
        btn.dataset.tplId = tpl.id;
        var label = _tplLabel(tpl);
        btn.textContent = label;
        btn.setAttribute('aria-label', 'Modelo: ' + label);
        btn.addEventListener('click', async function () {
          if (state.finalizing) {
            showStatus('Alta em andamento, aguarde', 'error');
            return;
          }
          // P1-5: mutex on template-button flow — prevents double-click from
          // opening/filling the Simples editor twice in parallel.
          if (state.rxRunning) return;
          state.rxRunning = true;
          btn.disabled = true;
          try {
            hud.querySelectorAll('.pb-template-btn').forEach(function (b) {
              b.classList.remove('active');
            });
            btn.classList.add('active');

            // v3.1: track usage so the popup can sort cards by frequency.
            _bumpFrequency(tpl.id);
            // v3.1: also bump the day's "tempo poupado" counter (idea #6).
            _bumpUsageStats('rxClick');

            showStatus('Abrindo receita...', 'loading');
            const ok = await window.TOCAFICHADR_dom.runSimplesPrescription(tpl);
            if (!ok) {
              showStatus('Falha ao abrir receita simples', 'error');
              return;
            }
            // Reveal the "Salvar e Imprimir" bar so the doctor can finalize
            const bar = hud.querySelector('#pb-rx-finalize-bar');
            if (bar) bar.style.display = '';
            showStatus('Revise e edite a receita, depois clique em "Salvar e Imprimir"', 'ok');
          } finally {
            state.rxRunning = false;
            btn.disabled = false;
          }
        });
        grid.appendChild(btn);
      });
    }

    function loadAndRenderTemplates() {
      chrome.storage.local.get(['userConfig'], function (data) {
        var cfg = data && data.userConfig;
        var raw = (Array.isArray(cfg && cfg.rx_templates) && cfg.rx_templates.length)
          ? cfg.rx_templates
          : DEFAULT_RX_TEMPLATES.slice();
        RX_TEMPLATES = raw.map(_migrateLegacyTemplate);
        renderTemplateButtons();
      });
    }

    loadAndRenderTemplates();

    // Re-render when popup/sidepanel edits templates (written to local userConfig).
    // P1-7: reference stored on the module-scoped `storageListener` so
    // cleanup() (registered via beforeunload) can remove it — otherwise
    // SPA re-navigations accumulate listeners from detached HUD instances.
    storageListener = function (changes, area) {
      if (area === 'local' && changes.userConfig && changes.userConfig.newValue) {
        var newCfg = changes.userConfig.newValue;
        var newRaw = (Array.isArray(newCfg.rx_templates) && newCfg.rx_templates.length)
          ? newCfg.rx_templates
          : DEFAULT_RX_TEMPLATES.slice();
        RX_TEMPLATES = newRaw.map(_migrateLegacyTemplate);
        renderTemplateButtons();
      }
    };
    chrome.storage.onChanged.addListener(storageListener);

    // "Salvar e Imprimir Receita" — finalizes the in-editor prescription
    const rxFinalizeBtn = hud.querySelector('#pb-rx-finalize-btn');
    rxFinalizeBtn.addEventListener('click', async function () {
      // P1-5: mutex on finalize flow — prevents double-click from saving and
      // printing the same prescription twice on slow Cloudflare connections.
      if (state.rxFinalizing) return;
      state.rxFinalizing = true;
      rxFinalizeBtn.disabled = true;
      try {
        showStatus('Salvando e imprimindo receita...', 'loading');
        const ok = await window.TOCAFICHADR_dom.finalizeSimplesPrescription();
        if (ok) {
          showStatus('Receita salva e enviada para impressão \u2713', 'ok');
          const bar = hud.querySelector('#pb-rx-finalize-bar');
          if (bar) bar.style.display = 'none';
          hud.querySelectorAll('.pb-template-btn').forEach(function (b) {
            b.classList.remove('active');
          });
        } else {
          showStatus('Falha ao salvar/imprimir receita', 'error');
        }
      } finally {
        state.rxFinalizing = false;
        rxFinalizeBtn.disabled = false;
      }
    });

    // Action: save form
    hud.querySelector('#pb-btn-save').addEventListener('click', function () {
      const ok = window.TOCAFICHADR_dom.saveForm();
      showStatus(
        ok ? 'Prontu\u00e1rio salvo \u2713' : 'N\u00e3o encontrei o formul\u00e1rio',
        ok ? 'ok' : 'error'
      );
    });

    // Action: open prescription
    hud.querySelector('#pb-btn-prescription').addEventListener('click', async function () {
      showStatus('Abrindo receita...', 'loading');
      try {
        const opened = await window.TOCAFICHADR_dom.openPrescription();
        showStatus(
          opened ? 'Receita aberta \u2713' : 'Bot\u00e3o de receita n\u00e3o encontrado',
          opened ? 'ok' : 'error'
        );
      } catch (err) {
        // Without this catch, any throw from openPrescription() becomes an
        // unhandled rejection and leaves the HUD frozen on 'Abrindo receita...'
        showStatus('Erro ao abrir receita: ' + ((err && err.message) || String(err)), 'error');
      }
    });

    // Action: open atestado \u2014 runs the dialog open + Inserir step, then reveals
    // the "Salvar e Imprimir Atestado" bar so the doctor can optionally fill
    // #presatestado_obs (companion text) before finalizing. Mirrors the
    // existing Receita Simples two-button pattern.
    hud.querySelector('#pb-btn-atestado').addEventListener('click', async function () {
      showStatus('Abrindo atestado...', 'loading');
      try {
        const opened = await window.TOCAFICHADR_dom.runAtestadoFlow();
        if (opened) {
          showStatus('Atestado aberto \u2014 preencha e finalize \u2713', 'ok');
          const bar = hud.querySelector('#pb-atestado-finalize-bar');
          if (bar) bar.style.display = '';
        } else {
          showStatus('Bot\u00e3o de atestado n\u00e3o encontrado', 'error');
        }
      } catch (err) {
        // Without this catch, any throw from runAtestadoFlow() becomes an
        // unhandled rejection and leaves the HUD frozen on 'Abrindo atestado...'
        showStatus('Erro ao abrir atestado: ' + ((err && err.message) || String(err)), 'error');
      }
    });

    // "Salvar e Imprimir Atestado" \u2014 clicks Gravar then IMPRIMIR SEM CID.
    const atestadoFinalizeBtn = hud.querySelector('#pb-atestado-finalize-btn');
    atestadoFinalizeBtn.addEventListener('click', async function () {
      if (state.atestadoFinalizing) return;
      state.atestadoFinalizing = true;
      atestadoFinalizeBtn.disabled = true;
      try {
        showStatus('Salvando e imprimindo atestado...', 'loading');
        const ok = await window.TOCAFICHADR_dom.finalizeAtestado();
        if (ok) {
          showStatus('Atestado salvo e enviado para impress\u00e3o \u2713', 'ok');
          const bar = hud.querySelector('#pb-atestado-finalize-bar');
          if (bar) bar.style.display = 'none';
        } else {
          showStatus('Falha ao salvar/imprimir atestado', 'error');
        }
      } finally {
        state.atestadoFinalizing = false;
        atestadoFinalizeBtn.disabled = false;
      }
    });

    // Action: open Baú Médico in new tab
    // URL: /ver_fichas?intern_id={internId}&id=5
    // Needed for patient transfers, in-hospital medication orders, and admissions
    hud.querySelector('#pb-btn-bau').addEventListener('click', function () {
      const ok = window.TOCAFICHADR_dom.openBauMedico();
      showStatus(
        ok ? 'Ba\u00fa M\u00e9dico aberto \u2713' : 'intern_id n\u00e3o encontrado nesta p\u00e1gina',
        ok ? 'ok' : 'error'
      );
    });

    // Finalize patient
    hud.querySelector('#pb-finalize').addEventListener('click', finalizePatient);
  }

  // ---------------------------------------------------------------------------
  // Connection check
  // ---------------------------------------------------------------------------

  async function checkConnection() {
    const dot = document.getElementById('pb-connection');
    const connLabel = document.getElementById('pb-conn-label');
    const pill = document.getElementById('pb-status-pill');

    // Show "..." while checking
    if (connLabel) connLabel.textContent = '...';
    if (pill) pill.classList.remove('offline');

    try {
      const ok = await window.TOCAFICHADR_api.checkHealth();
      state.connected = ok;
      if (pill) pill.classList.toggle('offline', !ok);
      if (connLabel) connLabel.textContent = ok ? 'ON' : 'OFF';
    } catch (_) {
      state.connected = false;
      if (pill) pill.classList.add('offline');
      if (connLabel) connLabel.textContent = 'OFF';
    }

    // Show auth status if authenticated (Phase 2)
    updateAuthBadge();
  }

  function updateAuthBadge() {
    var badge = document.getElementById('pb-auth-badge');
    if (!badge) {
      // Create badge next to connection dot if it doesn't exist
      var header = document.querySelector('.pb-header');
      if (!header) return;
      badge = document.createElement('span');
      badge.id = 'pb-auth-badge';
      badge.style.cssText = 'font-size:9px;color:#666;margin-left:4px;';
      var dot = document.getElementById('pb-connection');
      // insertBefore only works if the reference node is an actual child of
      // header. If dot lives inside a nested wrapper (or header was rebuilt),
      // fall back to appendChild to avoid NotFoundError.
      if (dot && dot.parentNode === header && dot.nextSibling && dot.nextSibling.parentNode === header) {
        header.insertBefore(badge, dot.nextSibling);
      } else {
        header.appendChild(badge);
      }
    }

    // CHRA-2133: a content script must never read auth data from storage. The
    // JWT now lives in chrome.storage.session (trusted contexts only) and the
    // user identity (authUser) is not exposed to this context. The badge is
    // gated by the presence-only flag (TOCAFICHADR_api.isAuthenticated(), sourced
    // from the service worker via the TOCAFICHADR_AUTHED message) — no storage
    // read, no PII. Note: authUser was never actually written to storage, so the
    // prior name/email read was already dead code and the badge always rendered
    // blank; this preserves that behavior while removing the storage access.
    badge.textContent = '';
    badge.style.color = '#666';
  }

  // ---------------------------------------------------------------------------
  // Patient info refresh
  // ---------------------------------------------------------------------------

  function refreshPatient() {
    state.patientInfo = window.TOCAFICHADR_dom.extractPatientInfo();
    const { internId, weight, chiefComplaint } = state.patientInfo;

    const idEl = document.getElementById('pb-intern-id');
    if (idEl) idEl.textContent = internId || '\u2014';

    const wEl = document.getElementById('pb-weight');
    if (wEl) wEl.textContent = weight ? (weight + ' kg') : '\u2014 kg';

    const cEl = document.getElementById('pb-complaint');
    if (cEl) cEl.textContent = chiefComplaint || 'Sem queixa detectada';
  }

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  function toggleRecording() {
    if (state.recording) {
      stopRecording();
    } else {
      startRecording();
    }
  }

  async function startRecording() {
    if (isUsageLimitReached()) {
      showStatus('Limite di\u00e1rio atingido (' + FREE_DAILY_LIMIT + '/' + FREE_DAILY_LIMIT + '). Assine o Pro para uso ilimitado.', 'error');
      return;
    }
    if (state.finalizing) {
      showStatus('Aguarde: alta em andamento', 'error');
      return;
    }
    if (state.processing) {
      showStatus('Aguarde: transcri\u00e7\u00e3o em andamento', 'error');
      return;
    }

    try {
      await window.TOCAFICHADR_audio.start(onRecordingStop);
      state.recording = true;
      state.soapReady = false;
      startTimer();
      updateRecordBtn('recording', '\u23f9\ufe0f', 'Parar Grava\u00e7\u00e3o');
      showStatus('Gravando...', 'loading');

      // v3.1 idea #3: attach live waveform once mic is open and stream is flowing.
      try {
        var waveCanvas = document.getElementById('pb-waveform');
        if (waveCanvas && window.TOCAFICHADR_audio.attachVisualizer) {
          waveCanvas.style.display = 'block';
          state.waveformHandle = window.TOCAFICHADR_audio.attachVisualizer(waveCanvas);
        }
      } catch (_) { /* viz is optional; never break recording */ }
    } catch (err) {
      showStatus('Microfone: ' + err.message, 'error');
      updateRecordBtn('idle', '\ud83c\udfa4', 'Gravar Consulta');
    }
  }

  function stopRecording() {
    if (!state.recording) return;
    state.recording = false;
    stopTimer();
    updateRecordBtn('processing', '\u23f3', 'Transcrevendo...');
    // v3.1 idea #3: tear down waveform \u2014 stream will be released by audio.stop().
    if (state.waveformHandle) {
      try { state.waveformHandle.stop(); } catch (_) {}
      state.waveformHandle = null;
    }
    var waveCanvas = document.getElementById('pb-waveform');
    if (waveCanvas) waveCanvas.style.display = 'none';
    window.TOCAFICHADR_audio.stop();
  }

  // ---------------------------------------------------------------------------
  // onRecordingStop — called by TOCAFICHADR_audio when recording finishes
  // ---------------------------------------------------------------------------

  async function onRecordingStop(blob, error) {
    if (error) {
      showStatus(error, 'error');
      updateRecordBtn('idle', '\ud83c\udfa4', 'Gravar Consulta');
      return;
    }

    state.processing = true;
    showStatus('Transcrevendo com Whisper...', 'loading');
    updateRecordBtn('processing', '\u23f3', 'Aguarde...');

    try {
      const complaint          = (state.patientInfo && state.patientInfo.chiefComplaint) || '';
      let   customInstructions = '';
      try {
        const stored = await new Promise(function (resolve) {
          chrome.storage.sync.get(['customInstructions'], resolve);
        });
        customInstructions = stored.customInstructions || '';
      } catch (_) {}

      // v3.1 idea #8: load active SOAP voice (verbosity / perspective / customRules / fewShots).
      var soapVoice = null;
      try {
        var voiceData = await new Promise(function (resolve) {
          chrome.storage.sync.get(['soapVoices', 'activeSoapVoiceId'], resolve);
        });
        var voices = Array.isArray(voiceData.soapVoices) ? voiceData.soapVoices : [];
        soapVoice = voices.find(function (v) { return v.id === voiceData.activeSoapVoiceId; }) || null;
      } catch (_) {}

      // Wrap transcription in a 90-second timeout to prevent UI hanging
      var transcribePromise = window.TOCAFICHADR_api.transcribe(blob, complaint, customInstructions, soapVoice);
      var timeoutPromise = new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error('Tempo limite excedido (90s). Verifique a conexao com o backend.'));
        }, 90000);
      });
      const result = await Promise.race([transcribePromise, timeoutPromise]);

      if (!result || !result.ok) {
        const errMsg = (result && result.error) ? result.error : 'falha desconhecida';
        showStatus('Erro: ' + errMsg, 'error');
        updateRecordBtn('idle', '\ud83c\udfa4', 'Gravar Consulta');
        return;
      }

      window.TOCAFICHADR_dom.clearSoapFields();
      const soapText = result.soap || result.transcript || '';
      window.TOCAFICHADR_dom.pasteSoapNote(soapText);
      state.soapReady = true;
      updateSoapPreview();

      // v2.7.3: auto-fill #recomendas_descricao from the extracted plan body
      // (separate field on the v3.0.5+ Flask response). Non-destructive — skips
      // if doctor already typed content. Pre-v3.0.5 backends omit the field;
      // empty string here is a safe no-op.
      try {
        if (window.TOCAFICHADR_dom.fillRecomendas) {
          window.TOCAFICHADR_dom.fillRecomendas(result.plan || '');
        }
      } catch (e) {
        console.warn('[Toca Ficha Dr.] fillRecomendas failed:', e && e.message);
      }

      // Audit telemetry: capture the audio config Chrome actually negotiated.
      // Useful for diagnosing rare quality complaints — Chrome may downshift
      // from the requested 32 kbps on weak hardware (Bluetooth at low battery,
      // saturated USB hub, etc) without throwing. Fire-and-forget.
      try {
        const audioCfg = window.TOCAFICHADR_audio.getEffectiveAudioConfig &&
                         window.TOCAFICHADR_audio.getEffectiveAudioConfig();
        if (audioCfg) {
          window.TOCAFICHADR_api.logAudit('transcribe_success', {
            blobBytes: blob && blob.size,
            mimeType: audioCfg.mimeType,
            audioBitsPerSecond: audioCfg.audioBitsPerSecond,
            requestedBitsPerSecond: audioCfg.requestedBitsPerSecond,
          }).catch(function () {});
        }
      } catch (_) { /* telemetry failure is never load-bearing */ }

      // v3.1 idea #6: bump local "tempo poupado" counter on each successful transcription.
      _bumpUsageStats('transcribe');

      // Copy SOAP to clipboard automatically
      try {
        await navigator.clipboard.writeText(soapText);
      } catch (_) {
        // Clipboard not available — not critical
      }

      if (result.cid_code) {
        // Only show CID suggestion if autoCid is enabled in settings
        var autoCidEnabled = true; // default to enabled
        try {
          var cidSettings = await new Promise(function (resolve) {
            chrome.storage.sync.get({ autoCid: true }, resolve);
          });
          autoCidEnabled = cidSettings.autoCid;
        } catch (_) {}

        if (autoCidEnabled) {
          state.suggestedCid = { code: result.cid_code, name: result.cid_name || '' };
          showCidSuggestion(result.cid_code, result.cid_name || '', result.confidence);
        }
      }

      await incrementUsage();
      showStatus('SOAP colado no prontu\u00e1rio \u2713', 'ok');
      updateRecordBtn('idle', '\ud83c\udfa4', 'Gravar Novamente');

    } catch (err) {
      console.error('[Toca Ficha Dr.] onRecordingStop erro:', err);
      if (window.TOCAFICHADR_api && window.TOCAFICHADR_api.reportError) {
        window.TOCAFICHADR_api.reportError('hud.onRecordingStop', err);
      }
      showStatus('Erro: ' + err.message, 'error');
      updateRecordBtn('idle', '\ud83c\udfa4', 'Gravar Consulta');
    } finally {
      state.processing = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Timer
  // ---------------------------------------------------------------------------

  function startTimer() {
    stopTimer();
    state.timerSeconds = 0;
    const timerEl = document.getElementById('pb-timer');
    if (timerEl) {
      timerEl.textContent = '00:00';
      timerEl.classList.add('active');
    }
    state.timerInterval = setInterval(function () {
      state.timerSeconds++;
      const el = document.getElementById('pb-timer');
      if (!el) { stopTimer(); return; }
      const m = String(Math.floor(state.timerSeconds / 60)).padStart(2, '0');
      const s = String(state.timerSeconds % 60).padStart(2, '0');
      el.textContent = m + ':' + s;
    }, 1000);
  }

  function stopTimer() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
    const timerEl = document.getElementById('pb-timer');
    if (timerEl) timerEl.classList.remove('active');
  }

  // ---------------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------------

  // Mode controls the visual state via CSS class. The legacy 2nd argument (unicode
  // icon glyph) is ignored — SVG mic / spinner / check are now rendered by CSS based
  // on the mode class on .pb-record-btn (idle/recording/processing/done).
  function updateRecordBtn(mode, _legacyIcon, labelText) {
    const btn     = document.getElementById('pb-record-btn');
    if (!btn) return;
    btn.className = 'pb-record-btn ' + mode;
    btn.setAttribute('aria-label', mode === 'recording' ? 'Parar gravação' : 'Iniciar gravação');
    const lblEl   = document.getElementById('pb-record-label');
    if (lblEl)  lblEl.textContent  = labelText;
  }

  function showStatus(msg, type) {
    const statusEl = document.getElementById('pb-soap-status');
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className   = 'pb-soap-status visible ' + type;
    if (type === 'error') {
      statusEl.setAttribute('role', 'alert');
      statusEl.setAttribute('aria-live', 'assertive');
    } else {
      statusEl.setAttribute('role', 'status');
      statusEl.setAttribute('aria-live', 'polite');
    }
    if (type === 'ok') {
      setTimeout(function () { statusEl.classList.remove('visible'); }, STATUS_OK_DURATION);
    }
  }

  function updateSoapPreview() {
    var previewEl = document.getElementById('pb-soap-preview');
    if (!previewEl) return;
    if (state.wideMode && state.soapReady) {
      // Try to read the current SOAP content from the DOM engine
      var soapText = '';
      try {
        soapText = window.TOCAFICHADR_dom.readSoapFields ? window.TOCAFICHADR_dom.readSoapFields() : '';
      } catch (_) {}
      if (soapText) {
        previewEl.textContent = soapText;
        previewEl.style.display = 'block';
      } else {
        previewEl.style.display = 'none';
      }
    } else {
      previewEl.style.display = 'none';
    }
  }

  function showCidSuggestion(code, name) {
    const codeEl = document.getElementById('pb-cid-code');
    const nameEl = document.getElementById('pb-cid-name');
    const boxEl  = document.getElementById('pb-cid-suggestion');
    if (codeEl) codeEl.textContent = code;
    if (nameEl) nameEl.textContent = name;
    if (boxEl)  boxEl.classList.add('visible');
  }

  function applyCid(code, name) {
    const applied = window.TOCAFICHADR_dom.fillCid(code, name);
    showStatus(
      applied
        ? ('CID aplicado: ' + code + ' \u2014 ' + name)
        : 'Campo de CID n\u00e3o encontrado',
      applied ? 'ok' : 'error'
    );
    if (applied) {
      const boxEl   = document.getElementById('pb-cid-suggestion');
      const inputEl = document.getElementById('pb-cid-input');
      if (boxEl)   boxEl.classList.remove('visible');
      if (inputEl) inputEl.value = code + ' \u2014 ' + name;
    }
  }

  /**
   * renderCidResults — builds result rows using safe DOM methods (no innerHTML).
   * CID codes and names come from the local TOCAFICHADR_cidSearch function, which
   * returns data from the hardcoded cid.js list — not from user input.
   * textContent is used exclusively, so no XSS risk.
   */
  function renderCidResults(results, container, inputEl) {
    // Remove any previous result rows
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    if (!results || results.length === 0) {
      container.classList.remove('visible');
      return;
    }

    results.forEach(function (c) {
      const item = el('div', { cls: 'pb-cid-item' });
      item.dataset.code = c.code;
      item.dataset.name = c.name;
      item.setAttribute('tabindex', '0');
      item.setAttribute('role', 'option');

      const codeSpan = el('span', { cls: 'pb-cid-item-code', text: c.code });
      const nameSpan = el('span', { text: c.name });
      item.appendChild(codeSpan);
      item.appendChild(nameSpan);

      function selectItem() {
        applyCid(item.dataset.code, item.dataset.name);
        if (inputEl) inputEl.value = item.dataset.code + ' \u2014 ' + item.dataset.name;
        container.classList.remove('visible');
      }

      item.addEventListener('mousedown', selectItem);
      item.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectItem();
        }
      });

      container.appendChild(item);
    });

    container.classList.add('visible');
  }

  // ---------------------------------------------------------------------------
  // Alta e voltar — discharge + return to list
  // ---------------------------------------------------------------------------

  async function finalizePatient() {
    var btn = document.getElementById('pb-finalize');
    // Guard at the top — getElementById returns null when the HUD has not been
    // injected yet or after a G-Hosp SPA navigation unmounts the DOM. The original
    // guard (!btn || state.finalizing) was 22 lines below, past two unconditional
    // btn property writes that throw TypeError and leave finalizeConfirmTimer set,
    // permanently blocking every subsequent discharge attempt for the session.
    if (!btn) return;
    var isRetry = state.finalizeStep > 0;

    // First click (non-retry): show in-HUD confirmation — no browser confirm() dialog
    if (!isRetry && !state.finalizeConfirmTimer) {
      btn.textContent = '\u26a0\ufe0f Confirmar? Clique novamente';
      btn.classList.add('pb-finalize-btn--danger');
      state.finalizeConfirmTimer = setTimeout(function () {
        btn.textContent = '\u2705 Alta e voltar';
        btn.classList.remove('pb-finalize-btn--danger');
        state.finalizeConfirmTimer = null;
      }, 4000);
      return;
    }

    // Second click or retry: clear confirmation timer and proceed
    if (state.finalizeConfirmTimer) {
      clearTimeout(state.finalizeConfirmTimer);
      state.finalizeConfirmTimer = null;
      btn.textContent = '\u2705 Alta e voltar';
      btn.classList.remove('pb-finalize-btn--danger');
    }
    if (state.finalizing) return;

    if (state.recording || state.processing) {
      showStatus('Pare a gravação e aguarde a transcrição antes da alta', 'error');
      return;
    }

    var internId = state.finalizeInternId || window.TOCAFICHADR_dom.getInternId();
    if (!internId) {
      showStatus('Não foi possível dar alta: intern_id não encontrado', 'error');
      return;
    }

    state.finalizing      = true;
    state.finalizeInternId = internId;
    btn.textContent       = '\u23f3 Registrando alta...';
    btn.disabled          = true;

    // Simplified MVP flow: discharge + return to main list. Assumes SOAP,
    // CID, prescriptions already handled by the doctor before clicking.
    // Global timeout protects against a hung discharge step — if processDischarge
    // hangs (e.g. Rails UJS never responds), reject so the catch block resets UI.
    var FINALIZE_TIMEOUT_MS = 30000;
    var finalizeTimer = null;
    var finalizeTimedOut = false;
    var timeoutPromise = new Promise(function (_, reject) {
      finalizeTimer = setTimeout(function () {
        finalizeTimedOut = true;
        reject(new Error('Tempo limite ao registrar alta (' + FINALIZE_TIMEOUT_MS / 1000 + 's). Verifique a conexão.'));
      }, FINALIZE_TIMEOUT_MS);
    });

    try {
      showStatus('Processando alta...', 'loading');
      var discharged = await Promise.race([
        window.TOCAFICHADR_dom.processDischarge(internId),
        timeoutPromise
      ]);
      if (!discharged) throw new Error('Falha ao processar alta');

      await sleep(1500);
      showStatus('Voltando para lista...', 'loading');
      await window.TOCAFICHADR_dom.goToMainList();
      showStatus('Alta registrada e lista aberta', 'ok');

      // Audit log — fire-and-forget
      try {
        await window.TOCAFICHADR_api.logAudit('finalize_patient', { internId: internId });
      } catch (_) {}

      // v3.1 idea #6: bump local efficiency counter for finalize.
      _bumpUsageStats('finalize');

      // Success — reset state
      state.finalizeStep     = 0;
      state.finalizeInternId = null;

    } catch (err) {
      showStatus('Erro: ' + err.message + ' — clique Alta e voltar para tentar novamente', 'error');
      // Keep finalizeStep so next click resumes from the failed step
      return;
    } finally {
      clearTimeout(finalizeTimer);
      state.finalizing = false;
      if (state.finalizeStep === 0) {
        btn.textContent = '\u2705 Alta e voltar';
        // Reset template selection and prescription flag on full success
        state.selectedTemplate = null;
        state.prescriptionDone = false;
        document.querySelectorAll('.pb-template-btn').forEach(function (b) {
          b.classList.remove('active');
        });
      } else {
        btn.textContent = '\u21bb Retomar alta';
      }
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Usage tracking
  // ---------------------------------------------------------------------------

  function getTodayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  async function loadUsage() {
    var today = getTodayStr();
    try {
      var data = await new Promise(function (resolve) {
        chrome.storage.local.get(['usageDate', 'usageCount'], resolve);
      });
      if (data.usageDate === today) {
        state.usageCount = data.usageCount || 0;
      } else {
        // New day — reset counter
        state.usageCount = 0;
        chrome.storage.local.set({ usageDate: today, usageCount: 0 });
      }
      state.usageDate = today;
    } catch (_) {
      state.usageCount = 0;
      state.usageDate = today;
    }

    // Check subscription
    try {
      if (window.TOCAFICHADR_api.isAuthenticated()) {
        var sub = await window.TOCAFICHADR_api.getSubscription();
        state.isPro = sub && sub.active;
      }
    } catch (_) {
      state.isPro = false;
    }

    updateUsageUI();
  }

  async function incrementUsage() {
    state.usageCount++;
    state.usageDate = getTodayStr();
    try {
      chrome.storage.local.set({ usageDate: state.usageDate, usageCount: state.usageCount });
    } catch (_) {}
    updateUsageUI();
  }

  function updateUsageUI() {
    var counterEl  = document.getElementById('pb-usage-counter');
    var upgradeEl  = document.getElementById('pb-usage-upgrade');
    var usageRowEl = document.getElementById('pb-usage-row');
    if (!counterEl) return;

    // Pro users: hide usage row entirely
    if (state.isPro) {
      if (usageRowEl) usageRowEl.style.display = 'none';
      return;
    }
    if (usageRowEl) usageRowEl.style.display = '';

    counterEl.textContent = state.usageCount + '/' + FREE_DAILY_LIMIT + ' notas hoje';

    // Mirror usage into the header status pill
    var pillUsageEl = document.getElementById('pb-pill-usage');
    if (pillUsageEl) pillUsageEl.textContent = state.usageCount + '/' + FREE_DAILY_LIMIT;

    // Color coding
    var remaining = FREE_DAILY_LIMIT - state.usageCount;
    if (remaining <= 0) {
      counterEl.className = 'pb-usage-counter limit-reached';
      if (upgradeEl) upgradeEl.style.display = '';
    } else if (remaining <= 2) {
      counterEl.className = 'pb-usage-counter limit-warning';
      if (upgradeEl) upgradeEl.style.display = 'none';
    } else {
      counterEl.className = 'pb-usage-counter';
      if (upgradeEl) upgradeEl.style.display = 'none';
    }
  }

  function isUsageLimitReached() {
    // TODO: enforce limits server-side once real backend is implemented
    return false;
  }

  // ---------------------------------------------------------------------------
  // Test-mode banner (read-only invariant reinforcement)
  // ---------------------------------------------------------------------------

  function injectTestBanner() {
    if (document.getElementById('tfdr-test-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'tfdr-test-banner';
    banner.className = 'tfdr-test-banner';
    banner.setAttribute('role', 'alert');
    banner.textContent = 'MODO DE TESTE — Nenhum dado real será salvo';
    document.body.appendChild(banner);
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  function cleanup() {
    stopTimer();
    try { window.TOCAFICHADR_audio.stop(); } catch (_) {}
    // P1-7: release the storage listener captured in setupEvents so that
    // detached HUD instances from previous SPA navigations do not keep
    // reacting to template edits in the popup.
    if (storageListener) {
      try { chrome.storage.onChanged.removeListener(storageListener); } catch (_) {}
      storageListener = null;
    }
    if (connectionCheckTimer) {
      clearInterval(connectionCheckTimer);
      connectionCheckTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return { createHUD, refreshPatient, injectTestBanner };

})();
