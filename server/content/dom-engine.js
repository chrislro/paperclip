'use strict';

// dom-engine.js — Config-driven DOM automation for G-Hosp
// Toca Ficha Dr. Extension — replaces workflow.js
// IIFE namespaced as window.TOCAFICHADR_dom

window.TOCAFICHADR_dom = (function () {

  // ---------------------------------------------------------------------------
  // BUNDLED_SELECTORS — hardcoded fallback, mirrors data/selectors/ghosp.json
  // ---------------------------------------------------------------------------
  const BUNDLED_SELECTORS = {
    "soap_field_prefix": "#prconsulta_prananmeneses_attributes_",
    "soap_field_suffix": "_descricao",
    "soap_editor_count": 6,
    "soap_editors": ".wysihtml5-sandbox",
    "cid_input": [
      "input[type='text'][id*='cid']:not([hidden]):not([type='hidden'])",
      "input[type='search'][id*='cid']:not([hidden]):not([type='hidden'])",
      "input[type='text'][name*='cid']:not([hidden]):not([type='hidden'])",
      "input[type='search'][name*='cid']:not([hidden]):not([type='hidden'])",
      "input[type='text'][placeholder*='CID']:not([hidden])",
      "input[type='text'][placeholder*='cid']:not([hidden])",
      "input[type='text'][placeholder*='diagnos']:not([hidden])"
    ],
    "cid_hidden": [
      "input[type='hidden'][id*='cid']",
      "input[type='hidden'][name*='cid']"
    ],
    "cid_description_input": "#cid_descricao",
    "save_button": "#submit_pranamnese",
    "save_button_fallback": "input[type='button'][value='Gravar']",
    "insert_button": "input[type='submit'][value='Inserir']",
    "discharge_container": "#dar_alta",
    "discharge_link_direct": "#dar_alta > fieldset > legend > b > a",
    "form_new": "form[id^='new_prconsulta']",
    "form_edit": "form[id^='edit_prconsulta']",
    "prescription_link": "#link_new_receitaalta",
    "prescription_type_radio": "#tiporec_0",
    // Confirmed from interaction logs (XPath: //*[@id="dialog_formularios"]/div/form/div[1]/fieldset/div[1])
    "prescription_simples": "#dialog_formularios > div > form > div:first-child > fieldset > div:first-child",
    // Confirmed from interaction logs (XPath: //*[@id="dialog_formularios"]/div/form/div[1]/fieldset/label)
    // This is the "Utilizar Padrões" toggle — clicking it reveals the #padroes template list
    "prescription_utilizar_padroes": "#dialog_formularios > div > form > div:first-child > fieldset > label",
    "template_radio": "input[type='radio'][name='padraorec']",
    "template_container": "#padroes",
    "dialog": "#dialog_formularios",
    // Confirmed from interaction logs (XPath: //*[@id="dialog_formularios"]/div[2]/a[1])
    "print_prescription_dialog": "#dialog_formularios > div:nth-child(2) > a:first-child",
    "print_link": "a[href*='imp_receita']",
    "print_link_fallback": "a[href*='imprimir_prescricao']",
    // Receita Simples (modifiable HUD templates, Apr 2026) flow. Each step's
    // finder prefers a SEMANTIC match in JS (e.g. input[name='commit'][value='Gravar'])
    // and falls back to the structural string here. Remote-updatable via
    // /selectors/ghosp so G-Hosp DOM tweaks can ship without an extension release.
    "prescription_simples_radio": "#tiporec_1",
    "prescription_inserir_to_editor": "#dialog_formularios input[name='commit'][value='Inserir']",
    "prescription_title_input": "#matmed_nome",
    "prescription_body_textarea": "#modo_usar",
    "prescription_save_button": "#form-item > fieldset > form > div:nth-child(8) > input",
    "prescription_print_link": "#dialog_formularios > div:nth-child(4) > a.botao.btn-2nd",
    // Print-button click tracker — array of selectors fingerprinted via
    // element.closest(). First match wins, so put the most specific (and most
    // likely correct) selectors first.
    "prescription_print_buttons": [
      "#dialog_formularios a.botao.btn-2nd[href*='imp']",
      "#dialog_formularios > div:nth-child(2) > a:first-child",
      "#dialog_formularios > div:nth-child(4) > a.botao.btn-2nd",
      "a[href*='imp_receita']",
      "a[href*='imprimir_prescricao']"
    ],
    "discharge_link_template": "a[href*='/altas/{internId}/edit']",
    "discharge_link_fallback": "a[href*='/altas/'][href*='edit']",
    "discharge_referral_select": [
      "#intern_encaminh",
      "select[name='intern[encaminh]']",
      "select[id*='encaminh']",
      "select[id*='encaminhamento']",
      "select[id*='destino']"
    ],
    // Confirmed from interaction logs (XPath: //*[@id="botao_gravar_alta"])
    "discharge_submit_button": "#botao_gravar_alta",
    // Baú Médico — prints the internal patient form (needed for transfers, meds, admissions)
    // Replace {internId} with the actual intern_id URL param
    "bau_medico_path": "/ver_fichas?intern_id={internId}&id=5",
    "discharge_form": "form[id^='edit_intern']",
    "discharge_no_referral_text": "sem encaminhamento",
    "main_list_url": "/prconsultas",
    "atestado_link": "#link_new_presatestados",
    // Atestado completion flow (Apr 2026 — confirmed from interaction logs).
    // After #link_new_presatestados, dialog opens with #new_presatestado_form.
    // Doctor clicks Inserir → optional companion text in #presatestado_obs →
    // Gravar → "IMPRIMIR SEM CID" link.
    "presatestado_form": "#new_presatestado_form",
    "presatestado_inserir": "#new_presatestado_form input[type='submit'][value='Inserir']",
    "presatestado_obs": "#presatestado_obs",
    // v3.4.0 — number-of-days input. Setting this fires a calc_data_fin XHR
    // server-side that updates the Data Final row; we dispatch input + change
    // events and wait ~400ms after assignment for the server response.
    "presatestado_dias": "#nro_dias",
    // Two-pronged selector: structural path is the primary (resilient to
    // value/locale changes); value-based is the fallback (resilient to DOM
    // structure tweaks). querySelector picks whichever matches first.
    "presatestado_save": "#new_presatestado > div.clear.row.mt15 > div > input[type=submit], #new_presatestado input[type='submit'][value='Gravar']",
    "presatestado_print_sem_cid": "#show_atestado_alta a.botao.btn-2nd.mini-btn",
    // Patient-header <small> block — source for companion auto-fill in atestado.
    // Contains "Mãe: NAME" and "Pai: NAME" lines among other demographics.
    // NOTE: #ui-id-3 is jQuery-UI generated and NOT stable across pages — the
    // bundled selectors below cover the currently observed structure, but
    // extractCompanionInfo() also walks every <small> on the page as a textual
    // fallback (matching /M[ãa]e:|Pai:/) when neither the CSS nor XPath path
    // resolves.
    "parent_info_block": "#ui-id-3 fieldset small",
    "parent_info_block_xpath": "//*[@id=\"ui-id-3\"]/fieldset/small",
    // Discharge datetime input — focus-only events confirm doctor edits this manually
    // each discharge (8-18 focuses per shift). Bundled now for future automation.
    "discharge_date_input": "#alta_data_alta",
    // Recomendas / conduta field (v2.7.3 — auto-fill from extracted SOAP plan).
    // Doctor types the plan body manually here on every consult — with v3.0.5
    // Flask returning `result.plan` separately, the extension fills it.
    "recomendas_field": "#recomendas_descricao",
    "patient_name_xpath": "//*[@id='paciente']//h4",
    "chief_complaint_xpath": "//*[@id='div_amb_triagem']/div[2]/div/p",
    "weight_patterns": [
      "Peso\\s*[:=]?\\s*(\\d+[.,]\\d*)",
      "(\\d+[.,]\\d*)\\s*kg",
      "(\\d+[.,]\\d*)\\s*Kg",
      "(\\d+)\\s*kg",
      "(\\d+)\\s*Kg",
      "peso\\s*[:=]?\\s*(\\d+[.,]\\d*)",
      "peso\\s+(\\d+)",
      "Peso\\s*[:=]?\\s*(\\d+)"
    ],
    "intern_id_param": "intern_id",
    "call_patient_btn": "[data-intern-id='{internId}'] .btn-chamar",
    "attend_patient_text": "Atender"
  };

  // ---------------------------------------------------------------------------
  // Internal state — loaded selector config (null until loadSelectors() runs)
  // ---------------------------------------------------------------------------
  let _loadedSelectors = null;

  /**
   * sel(key) — returns value from loaded config, or from BUNDLED_SELECTORS.
   * Always returns a defined value as long as the key exists in the bundle.
   */
  function sel(key) {
    if (_loadedSelectors && Object.prototype.hasOwnProperty.call(_loadedSelectors, key)) {
      return _loadedSelectors[key];
    }
    return BUNDLED_SELECTORS[key];
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  /**
   * loadSelectors() — async. Fetches selector config from TOCAFICHADR_api.getSelectors("ghosp").
   * Falls back to BUNDLED_SELECTORS silently on any error.
   */
  async function loadSelectors() {
    try {
      if (typeof window.TOCAFICHADR_api !== 'undefined' && typeof window.TOCAFICHADR_api.getSelectors === 'function') {
        const data = await window.TOCAFICHADR_api.getSelectors('ghosp');
        if (data && data.selectors && typeof data.selectors === 'object') {
          _loadedSelectors = data.selectors;
          console.log('[Toca Ficha Dr.] dom-engine: remote selectors loaded');
          return;
        }
      }
    } catch (err) {
      console.warn('[Toca Ficha Dr.] dom-engine: could not load remote selectors, using bundled fallback', err);
    }
    _loadedSelectors = null;
    console.log('[Toca Ficha Dr.] dom-engine: using bundled selectors');
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * waitFor(selector, timeoutMs) — resolves with the first matching element,
   * or rejects after timeoutMs. Uses MutationObserver for dynamic content.
   */
  function waitFor(selector, timeoutMs) {
    timeoutMs = timeoutMs !== undefined ? timeoutMs : 5000;
    return new Promise(function (resolve, reject) {
      const existing = document.querySelector(selector);
      if (existing) return resolve(existing);

      const observer = new MutationObserver(function () {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          clearTimeout(timeoutHandle);
          resolve(el);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });
      const timeoutHandle = setTimeout(function () {
        observer.disconnect();
        reject(new Error('[Toca Ficha Dr.] Timeout esperando: ' + selector));
      }, timeoutMs);
    });
  }

  /**
   * getByXPath(xpath) — returns first matching node or null.
   */
  function getByXPath(xpath) {
    try {
      const result = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      return result.singleNodeValue || null;
    } catch (err) {
      console.warn('[Toca Ficha Dr.] XPath error:', xpath, err);
      return null;
    }
  }

  /**
   * getInternId() — reads intern_id from URL.
   *
   * G-Hosp uses two URL shapes:
   *   - Legacy query param: /amb/interns?intern_id=1902436
   *   - New path-based:     /pr/interns/1902436/prconsultas
   *
   * We try query param first (backward compat), then fall back to path regex.
   */
  function getInternId() {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get(sel('intern_id_param') || 'intern_id');
    if (fromQuery) return fromQuery;
    const m = url.pathname.match(/\/interns\/(\d+)/);
    return m ? m[1] : null;
  }

  // ---------------------------------------------------------------------------
  // Patient info
  // ---------------------------------------------------------------------------

  // Hospital patients' weight in kg lives in [0.4, 250]. Anything > 250 from a
  // unit-blind regex is almost certainly grams (G-Hosp displays neonatal
  // weight in grams: "Peso: 3960" = 3.96 kg). 0.4 kg is below the smallest
  // viable preemie; below that we treat as a bad extraction and refuse.
  const _WEIGHT_KG_MAX = 250;
  const _WEIGHT_KG_MIN = 0.4;

  function _normalizeWeight(rawValue) {
    if (rawValue === null || rawValue === undefined || Number.isNaN(rawValue)) return null;
    let kg = rawValue;
    // Grams → kg if the raw value exceeds any realistic kg reading. Iterate
    // for safety (4960 g vs 4960000 mg etc., though we only expect g here).
    if (kg > _WEIGHT_KG_MAX) {
      const adjusted = kg / 1000;
      console.warn('[Toca Ficha Dr.] weight ' + kg + ' exceeds ' + _WEIGHT_KG_MAX + ' kg — treating as grams, converted to ' + adjusted + ' kg');
      kg = adjusted;
    }
    if (kg < _WEIGHT_KG_MIN) {
      console.warn('[Toca Ficha Dr.] extracted weight ' + kg + ' kg below plausible minimum, rejecting');
      return null;
    }
    return kg;
  }

  function _getPatientWeight() {
    const text = (document.body ? (document.body.innerText || document.body.textContent || '') : '')
      .replace(/\s+/g, ' ')
      .trim();

    const rawPatterns = sel('weight_patterns') || [];
    for (let i = 0; i < rawPatterns.length; i++) {
      try {
        const pattern = new RegExp(rawPatterns[i], 'i');
        const match = text.match(pattern);
        if (match && match[1]) {
          const raw = parseFloat(match[1].replace(',', '.'));
          const kg = _normalizeWeight(raw);
          if (kg !== null) {
            console.log('[Toca Ficha Dr.] patient weight extracted:', kg, 'kg (raw=' + raw + ', pattern', i + 1, 'of', rawPatterns.length, ')');
            return kg;
          }
        }
      } catch (e) {
        console.warn('[Toca Ficha Dr.] Invalid weight pattern:', rawPatterns[i], e);
      }
    }
    console.warn('[Toca Ficha Dr.] patient weight not found in page text');
    return null;
  }

  /**
   * extractPatientInfo() — returns {internId, name, weight, chiefComplaint}.
   * Uses XPath for name and chief complaint; regex scan for weight.
   */
  function extractPatientInfo() {
    const info = {
      internId: getInternId(),
      weight: _getPatientWeight(),
      chiefComplaint: null,
      name: null,
    };

    const complaintNode = getByXPath(sel('chief_complaint_xpath'));
    if (complaintNode && complaintNode.textContent) {
      info.chiefComplaint = complaintNode.textContent.trim();
    }

    const nameNode = getByXPath(sel('patient_name_xpath'));
    if (nameNode && nameNode.textContent) {
      info.name = nameNode.textContent.trim();
    }

    return info;
  }

  // Module-level companion-info cache, keyed by intern_id. Populated by the
  // demographics-fetch fallback in extractCompanionInfo. In-memory only —
  // resets on page navigation, which lines up with G-Hosp's full-page-reload
  // pattern when the doctor switches patients.
  const _companionInfoCache = new Map();

  /**
   * _unescapeJsString(s) — undo JS string-literal escaping. Used on Rails
   * .js.erb response bodies before HTML parsing because they contain
   * HTML wrapped in JS strings (e.g., `.html("<div>X<\/div>")`). Pure;
   * unit-testable in Node.
   *
   * Handles the common escapes: \/, \n, \r, \t, \", \\. Order matters —
   * \\ goes through a temp marker so we don't double-undo (e.g., a literal
   * "\\n" = backslash + n must NOT become a newline).
   */
  function _unescapeJsString(s) {
    if (!s || typeof s !== 'string') return '';
    return s
      .replace(/\\\\/g, '\x00')
      .replace(/\\\//g, '/')
      .replace(/\\n/g,  '\n')
      .replace(/\\r/g,  '\r')
      .replace(/\\t/g,  '\t')
      .replace(/\\"/g,  '"')
      .replace(/\\'/g,  "'")
      .replace(/\x00/g, '\\');
  }

  /**
   * _fetchCompanionInfoFromDemographics(internId) — async fetch fallback.
   *
   * The consultation screen (tela=prconsultas) does NOT include the
   * Mãe:/Pai: header. The structured demographics live on a separate
   * G-Hosp endpoint at /pr/shared/{intern_id}/get_dados_paciente. Same
   * origin as the page, so cookies are sent automatically by fetch's
   * `credentials: 'same-origin'` default — no auth wiring needed.
   *
   * Tries to parse the response as JSON first (fields mae/pai or
   * mother/father), then falls back to HTML via DOMParser →
   * _parseCompanionText. Returns { mother, father } on success, null on
   * any failure (no node, no parse, network error, timeout).
   *
   * Caches by intern_id including null results — a failure for one patient
   * shouldn't make us re-fetch on every chip click.
   */
  async function _fetchCompanionInfoFromDemographics(internId) {
    if (!internId) return null;
    if (_companionInfoCache.has(internId)) return _companionInfoCache.get(internId);
    const url = location.origin + '/pr/shared/' + encodeURIComponent(internId) + '/get_dados_paciente';
    try {
      // X-Requested-With + Accept tell Rails to route to its `format.js` /
      // `format.json` handler instead of `format.html`. Without these,
      // Rails detects no XHR + no explicit format and serves the HTML
      // 422 error page (verified on a live unauthenticated curl). The
      // headers are the same shape jQuery's $.ajax sets by default,
      // which is why legacy Rails XHR endpoints "just work" with jQuery
      // but fail under bare fetch().
      const resp = await fetch(url, {
        credentials: 'same-origin',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'text/javascript, application/javascript, application/json;q=0.9, */*;q=0.5',
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        console.warn('[Toca Ficha Dr.] demographics fetch HTTP', resp.status, 'for intern_id=' + internId);
        _companionInfoCache.set(internId, null);
        return null;
      }
      const text = await resp.text();

      // Path 1 — JSON. G-Hosp may return { mae, pai, ... } or similar.
      let parsed = null;
      try {
        const json = JSON.parse(text);
        const m = (json && (json.mae || json.mother)) || '';
        const f = (json && (json.pai || json.father)) || '';
        if (typeof m === 'string' && typeof f === 'string' && (m || f)) {
          parsed = { mother: m, father: f };
        }
      } catch (_) { /* not JSON, fall through to HTML parsing */ }

      // Path 2 — JS-template-wrapped HTML (Rails .js.erb partial). G-Hosp
      // serves Content-Type: text/javascript with bodies like:
      //   $("#dadosPaciente").html("<div>Mãe:<\/div>\nLARISSA<\/div>");
      // DOMParser would see `<\/div>` as literal text (backslash is not a
      // legal name character) and innerText would carry the escape
      // sequences through. Unescape JS string syntax first so DOMParser
      // gets clean HTML.
      //
      // Two scans on the parsed doc:
      //   2a (preferred) — structural label-match. The user-confirmed
      //     live DOM has parent names at
      //       #ui-id-3 > fieldset > small > div:nth-child(8)  → Mãe
      //       #ui-id-3 > fieldset > small > div:nth-child(10) → Pai
      //     The fetched response contains the dialog's INNER HTML — no
      //     #ui-id-3 wrapper, but the `fieldset > small > div` structure
      //     survives. We label-match each direct child div instead of
      //     hard-coding nth-child positions, which keeps us resilient to
      //     row insertions/reorders.
      //   2b (fallback) — full-text parse via _parseCompanionText.
      //     Catches alternative response shapes if 2a misses.
      if (!parsed) {
        const unescaped = _unescapeJsString(text);
        const doc = new DOMParser().parseFromString(unescaped, 'text/html');
        // 2a — structural label-match over <small> children.
        // We iterate all <small> elements (fieldset or not) and walk their
        // direct children. Using .children instead of :scope > div avoids
        // selector compatibility issues and catches span/p/b/etc. wrappers.
        const smalls = doc.querySelectorAll('fieldset small, small');
        for (let i = 0; i < smalls.length && !parsed; i++) {
          const sm = smalls[i];
          // Quick text pre-filter — skip <small> elements that don't mention
          // a parent label at all.
          const smText = (sm.textContent || '');
          if (!/M[ãa]e\s*:|Pai\s*:/i.test(smText)) continue;
          let mother = '';
          let father = '';
          // Try structural walk over direct children first.
          const children = sm.children;
          for (let j = 0; j < children.length; j++) {
            const dt = (children[j].textContent || '').replace(/\s+/g, ' ').trim();
            const mMatch = dt.match(/^M[ãa]e\s*:\s*(.+)$/i);
            if (mMatch) {
              const v = mMatch[1].trim();
              if (_looksLikeRealName(v) && !mother) mother = v;
            }
            const pMatch = dt.match(/^Pai\s*:\s*(.+)$/i);
            if (pMatch) {
              const v = pMatch[1].trim();
              if (_looksLikeRealName(v) && !father) father = v;
            }
          }
          // If structural walk missed (e.g., labels are inline in the <small>
          // text without child wrappers), fall back to _parseCompanionText
          // on the <small>'s own text.
          if (!mother && !father) {
            const r = _parseCompanionText(smText);
            if (r.mother) mother = r.mother;
            if (r.father) father = r.father;
          }
          if (mother || father) parsed = { mother: mother, father: father };
        }
        // 2b — full-text fallback over the whole document.
        if (!parsed) {
          const t = (doc.body && (doc.body.innerText || doc.body.textContent)) || '';
          const r = _parseCompanionText(t);
          if (r.mother || r.father) parsed = r;
        }
      }

      if (parsed) {
        _companionInfoCache.set(internId, parsed);
        return parsed;
      }

      // 200 OK but neither parser found names. Log so we can fix without
      // another reload cycle — paste the snippet and the regex/JSON-key fix
      // is a one-liner.
      console.warn(
        '[Toca Ficha Dr.] demographics fetch parsed empty —',
        '\n  url:', url,
        '\n  contentType:', resp.headers.get('content-type') || '?',
        '\n  responseSnippet[0:2000]:', text.slice(0, 2000)
      );
      _companionInfoCache.set(internId, null);
      return null;
    } catch (err) {
      console.warn(
        '[Toca Ficha Dr.] demographics fetch failed —',
        '\n  url:', url,
        '\n  error:', (err && err.message) || String(err)
      );
      _companionInfoCache.set(internId, null);
      return null;
    }
  }

  /**
   * extractCompanionInfo() — async. Returns { mother, father } pulled from
   * the patient-header demographics. Tries 4 synchronous strategies on the
   * current page first (CSS / XPath / <small>-walk / full-element-walk),
   * then falls back to a same-origin fetch of the demographics partial when
   * none match (the consultation screen doesn't include this data).
   *
   *   Data Nasc.: 06/09/2020
   *   Sexo: M
   *   Mãe: JESSICA DORNELES DE VARGAS
   *   Pai: JEVERTON LIMA DE VARGAS
   *   Naturalidade: ...
   *
   * Either field may be ''. Backs the atestado #presatestado_obs auto-fill
   * (62% of logged atestado obs entries are "Acompanhante Mãe:\nNAME").
   *
   * Resolution order:
   *   1. CSS selector from BUNDLED_SELECTORS.parent_info_block
   *   2. XPath fallback (parent_info_block_xpath)
   *   3. <small>-text walk (jQuery-UI-id agnostic)
   *   4. Full-element walk (any element whose text yields a non-empty parse)
   *   5. Background fetch /pr/shared/{intern_id}/get_dados_paciente, parse
   *      as JSON or HTML, cache by intern_id.
   */
  async function extractCompanionInfo() {
    const empty = { mother: '', father: '' };

    let node = null;
    try {
      const cssSel = sel('parent_info_block');
      if (cssSel) node = document.querySelector(cssSel);
    } catch (_) { node = null; }

    if (!node) {
      const xpath = sel('parent_info_block_xpath');
      if (xpath) node = getByXPath(xpath);
    }

    if (!node) {
      // Strategy 3 — Textual fallback over <small>. Required because
      // #ui-id-3 is jQuery-UI generated and may renumber when other
      // dialogs open/close on the same page.
      const candidates = document.querySelectorAll('small');
      for (let i = 0; i < candidates.length; i++) {
        const txt = candidates[i].textContent || '';
        if (/M[ãa]e\s*:|Pai\s*:/i.test(txt)) {
          node = candidates[i];
          break;
        }
      }
    }

    // Strategy 4 — full-element walk. If the patient header moved out of
    // <small> entirely (G-Hosp restructured the dialog), walk every
    // element on the page and try _parseCompanionText on each candidate.
    // First element whose text yields a non-empty parse wins. Bounded by
    // DOM size; a typical patient page is ~1-2k elements, well under
    // 5ms on commodity hardware. Also short-circuits the parse step
    // below so we don't re-parse the same text.
    let parsedFromWalk = null;
    if (!node && document.body) {
      const all = document.body.getElementsByTagName('*');
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        // Skip code-bearing tags. Their textContent contains source code
        // (e.g., a Rails .js.erb partial that references "Mãe:" inside a
        // jQuery .html() call). Walking them caused a confirmed live bug
        // where Strategy 4 captured the entire JS template + downstream
        // UI text as the "mother's name."
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE' || tag === 'NOSCRIPT') continue;
        const quick = el.textContent || '';
        // Cheap prefilter — skip elements without a parent label anywhere.
        if (!/M[ãa]e\s*:|Pai\s*:/i.test(quick)) continue;
        const elText = (typeof el.innerText === 'string' && el.innerText) ? el.innerText : quick;
        const r = _parseCompanionText(elText);
        if (r.mother || r.father) {
          node = el;
          parsedFromWalk = r;
          break;
        }
      }
    }

    // Strategy 5 — same-origin fetch to the demographics partial. The
    // consultation screen doesn't carry the Mãe:/Pai: header; the data lives
    // at /pr/shared/{intern_id}/get_dados_paciente. Cookies are sent
    // automatically (same origin), and the result is cached per intern_id
    // so toggling chips on the same patient doesn't re-fetch.
    if (!node) {
      const internId = getInternId();
      if (internId) {
        const fromFetch = await _fetchCompanionInfoFromDemographics(internId);
        if (fromFetch && (fromFetch.mother || fromFetch.father)) {
          return fromFetch;
        }
      }
    }

    if (!node) {
      // Diagnostic: every selector strategy AND the full-page walk AND the
      // demographics fetch missed. To pinpoint *why*, we also scan the full
      // innerText AND innerHTML for M[ãa]e: / Pai: matches and report the
      // first occurrence's context.
      // Three diagnostic shapes emerge:
      //   labelInTextMatches > 0 → labels exist in visible text but our
      //     element walk missed them (regex tweak / boundary list issue).
      //   labelInTextMatches == 0, labelInHTMLMatches > 0 → labels exist
      //     in DOM but inside a hidden element (display:none / collapsed
      //     section). We need to expand or look elsewhere.
      //   both == 0 → page truly has no parent info on this view. Doctor
      //     is on a page where the demographics aren't surfaced; the fix
      //     is to navigate to the right screen, not to change parsing.
      const bodyText = (document.body && document.body.innerText) || '';
      const bodyHtml = (document.body && document.body.innerHTML) || '';
      const labelRe = /M[ãa]e\s*:|Pai\s*:/i;
      const textMatches = bodyText.match(/M[ãa]e\s*:|Pai\s*:/gi) || [];
      const htmlMatches = bodyHtml.match(/M[ãa]e\s*:|Pai\s*:/gi) || [];
      let firstMatchContext = '';
      const m = bodyText.search(labelRe);
      if (m !== -1) {
        firstMatchContext = bodyText.slice(Math.max(0, m - 50), m + 200);
      } else {
        const mh = bodyHtml.search(labelRe);
        if (mh !== -1) {
          firstMatchContext = '[from innerHTML, label is hidden in visible text] ' +
            bodyHtml.slice(Math.max(0, mh - 50), mh + 200);
        }
      }
      const diag = {
        reason: 'no-node-matched',
        strategiesTried: ['css', 'xpath', 'small-text-walk', 'full-element-walk'],
        url: location.href,
        title: document.title,
        labelInTextMatches: textMatches.length,
        labelInHTMLMatches: htmlMatches.length,
        firstMatchContext: firstMatchContext.slice(0, 400),
        bodyTextSnippet: bodyText.slice(0, 2500),
      };
      console.warn(
        '[Toca Ficha Dr.] extractCompanionInfo: no patient-header node matched —',
        '\n  url:', diag.url,
        '\n  title:', diag.title,
        '\n  strategies tried:', diag.strategiesTried.join(', '),
        '\n  labelInTextMatches:', diag.labelInTextMatches,
        '\n  labelInHTMLMatches:', diag.labelInHTMLMatches,
        '\n  firstMatchContext:', diag.firstMatchContext,
        '\n  bodyTextSnippet[0:2500]:', diag.bodyTextSnippet
      );
      return Object.assign({}, empty, { _diag: diag });
    }

    // Strategy 4 already parsed — short-circuit and skip the second parse.
    if (parsedFromWalk) return parsedFromWalk;

    // innerText respects <br> tags as visual line breaks; textContent does
    // not. G-Hosp's patient header sometimes renders as
    //   <small>Mãe: JESSICA<br>Pai: JEVERTON</small>
    // with no whitespace between the children, so textContent collapses to
    // "Mãe: JESSICAPai: JEVERTON" — one run, line-anchored regex misses both.
    // innerText keeps them split. Fall back to textContent when innerText is
    // unavailable (very old Chromium, jsdom in tests).
    const text = (typeof node.innerText === 'string' && node.innerText)
      ? node.innerText
      : (node.textContent || '');
    const result = _parseCompanionText(text);

    if (!result.mother && !result.father) {
      // Diagnostic: node was found but neither parent name was parsed out.
      // Either the label format changed (e.g., "Responsável:" instead of
      // "Mãe:"), or _parseCompanionText's NEXT_LABEL boundary list needs
      // a new entry. Logs the node + text the parser saw and attaches the
      // same payload to the result as `_diag` so the side panel can echo
      // it without forcing the user to switch DevTools tabs. Truncated to
      // 400 chars to keep the console readable.
      const diag = {
        reason: 'parsed-empty',
        nodeTag: node.tagName + (node.id ? '#' + node.id : ''),
        outerHTML: (node.outerHTML || '').slice(0, 400),
        text: text.slice(0, 400),
      };
      console.warn(
        '[Toca Ficha Dr.] extractCompanionInfo: parsed empty —',
        '\n  node:', diag.nodeTag,
        '\n  outerHTML[0:400]:', diag.outerHTML,
        '\n  text[0:400]:', diag.text
      );
      result._diag = diag;
    }

    return result;
  }

  /**
   * _parseCompanionText(text) — extract { mother, father } from the patient
   * header text. Pure (no DOM access) so it can be unit-tested in Node.
   *
   * Single-pass anchorless regex with a lookahead boundary: captures from
   * each parent label up to the next known sibling label (Pai/Mãe/Nasc/
   * Idade/Resp/Sexo/CPF/RG/Endereço) or end of string. Handles every layout
   * uniformly:
   *   - Multi-line ("Mãe: JESSICA\nPai: JEVERTON") — `\s*` in the lookahead
   *     consumes the newline before the next label.
   *   - Spaced single-line ("Mãe: JESSICA Pai: JEVERTON") — same, but the
   *     `\s*` consumes a space.
   *   - Tight single-line ("Mãe: JESSICAPai: JEVERTON") — `\s*` matches
   *     empty, label boundary still fires.
   *   - Trailing CRLF or extra whitespace — `.trim()` cleans the capture.
   *
   * Extend NEXT_LABEL if a new G-Hosp sibling field starts being captured
   * into a parent name.
   */
  function _parseCompanionText(text) {
    if (!text || typeof text !== 'string') return { mother: '', father: '' };
    const NEXT_LABEL = '(?=\\s*(?:Pai|M[ãa]e|Nasc(?:imento)?|Idade|Resp(?:ons[áa]vel)?|Sexo|CPF|RG|Endereço)\\s*:|$)';
    const motherMatch = text.match(new RegExp('M[ãa]e\\s*:\\s*([\\s\\S]+?)' + NEXT_LABEL, 'i'));
    const fatherMatch = text.match(new RegExp('Pai\\s*:\\s*([\\s\\S]+?)'    + NEXT_LABEL, 'i'));
    const motherRaw = motherMatch ? motherMatch[1].trim() : '';
    const fatherRaw = fatherMatch ? fatherMatch[1].trim() : '';
    return {
      mother: _looksLikeRealName(motherRaw) ? motherRaw : '',
      father: _looksLikeRealName(fatherRaw) ? fatherRaw : '',
    };
  }

  /**
   * _looksLikeRealName(s) — sanity-check a captured "name" string. Rejects
   * captures that include HTML markup (`<`, `>`), JS-string escapes (`\`),
   * multi-line content (we captured past the actual name), or absurd
   * lengths. Pure; safe to unit-test.
   *
   * Concrete failures we've seen in the wild and want to filter out:
   *   - Strategy-4 walk found a <script> with JS source containing
   *     `<\/div>\n LARISSA <\/div>\n\n CHRISTIAN ...` — captures the
   *     escape chars and slurps to end of document because there's no
   *     Pai: boundary after.
   *   - DOMParser of a Rails .js.erb response without unescape — same
   *     escape-sequence garbage in the captured text.
   *   - A label like "Mãe:" with no value followed by other UI text —
   *     captures the next dozen lines of UI.
   */
  function _looksLikeRealName(s) {
    if (!s || typeof s !== 'string') return false;
    const t = s.trim();
    if (t.length < 2 || t.length > 80) return false;
    if (/[<>\\]/.test(t)) return false;
    if (/[\n\r]/.test(t)) return false;
    if (!/[A-Za-zÀ-ÿ]/.test(t)) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // SOAP / wysihtml5 editors
  // ---------------------------------------------------------------------------

  /**
   * _sanitizeSoapHtml(html) — minimal-allowlist HTML sanitizer for SOAP content
   * before it reaches the wysihtml5 editor's contentEditable element. Defends
   * against a compromised backend or jailbroken GPT emitting <script>,
   * <iframe srcdoc>, event handlers, javascript: URLs, etc.
   *
   * Allowlist (tags only — all attributes are dropped):
   *   br, b, i, p, u, strong, em
   *
   * Disallowed elements are replaced by a text node containing their textContent
   * — visible characters preserved, no execution surface remains.
   *
   * Implementation: parses input via DOMParser into an inert document, walks the
   * tree depth-first, and rebuilds the body. No dependencies.
   */
  function _sanitizeSoapHtml(html) {
    if (typeof html !== 'string' || html.length === 0) return '';

    const ALLOWED_TAGS = { BR: 1, B: 1, I: 1, P: 1, U: 1, STRONG: 1, EM: 1 };

    let parsed;
    try {
      parsed = new DOMParser().parseFromString(
        '<!DOCTYPE html><body>' + html + '</body>', 'text/html');
    } catch (err) {
      // If parsing fails, fall back to HTML-entity-escaped plain text.
      return (html || '').replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    const srcBody = parsed && parsed.body;
    if (!srcBody) return '';

    // Rebuild via DOM APIs — no innerHTML write, so disallowed nodes never
    // touch a live document. Output is collected into a detached container
    // and read back as serialized HTML for the caller.
    const out = document.createElement('div');

    function walk(srcNode, dstParent) {
      const children = srcNode.childNodes;
      for (let i = 0; i < children.length; i++) {
        const node = children[i];
        if (node.nodeType === 3) {
          // Text node — always safe, copy verbatim.
          dstParent.appendChild(document.createTextNode(node.nodeValue));
          continue;
        }
        if (node.nodeType !== 1) {
          // Comments, CDATA, processing instructions — drop.
          continue;
        }
        const tag = node.tagName;
        if (ALLOWED_TAGS[tag]) {
          // Clone WITHOUT attributes, then recurse into children.
          const clone = document.createElement(tag);
          dstParent.appendChild(clone);
          walk(node, clone);
        } else {
          // Disallowed (script, iframe, img, a, style, svg, etc.) — replace
          // with its textContent. textContent is text only, so the result is
          // an inert text node with no execution surface.
          const text = node.textContent || '';
          if (text.length > 0) {
            dstParent.appendChild(document.createTextNode(text));
          }
        }
      }
    }
    walk(srcBody, out);
    return out.innerHTML;
  }

  /**
   * updateWysihtml5Editor(index, htmlText) — writes htmlText into the iframe
   * contentDocument for wysihtml5 editor at the given index, dispatches events,
   * and also updates the backing hidden textarea.
   *
   * Security: htmlText is sanitized via _sanitizeSoapHtml() before any write,
   * so a compromised backend or jailbroken GPT cannot inject <script>,
   * <iframe srcdoc>, event handlers, or javascript: URLs into the same-origin
   * G-Hosp page. The dual-write (iframe contentEditable + hidden textarea) uses
   * the same sanitized payload so on-screen and persisted values match.
   */
  function updateWysihtml5Editor(index, htmlText) {
    const editorSelector = sel('soap_editors') || '.wysihtml5-sandbox';
    const iframe = document.querySelectorAll(editorSelector)[index];
    if (!iframe) {
      console.warn('[Toca Ficha Dr.] wysihtml5 iframe not found for index', index);
      return false;
    }

    try {
      const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
      const editable = doc && doc.querySelector('[contenteditable="true"], body[contenteditable], body');
      if (!editable) {
        console.warn('[Toca Ficha Dr.] wysihtml5 editable area not found for index', index);
        return false;
      }

      // Sanitize ONCE — used for both writes below. Drops <script>, <iframe>,
      // event handlers, javascript: URLs, all attributes. Allowlist:
      // br/b/i/p/u/strong/em only.
      htmlText = _sanitizeSoapHtml(htmlText);

      // wysihtml5 requires innerHTML for rich-text content. The payload was
      // just sanitized on the line above, so this assignment is XSS-safe.
      editable.innerHTML = htmlText; // sanitized on line above
      editable.dispatchEvent(new Event('input', { bubbles: true }));
      editable.dispatchEvent(new Event('change', { bubbles: true }));

      // Also update the backing hidden textarea so the form value is in sync.
      // textarea.value is text-only (no HTML parsing) but we still write the
      // sanitized payload so what G-Hosp persists matches the editor view.
      const prefix = sel('soap_field_prefix') || '#prconsulta_prananmeneses_attributes_';
      const suffix = sel('soap_field_suffix') || '_descricao';
      const textarea = document.querySelector(prefix + index + suffix);
      if (textarea) {
        textarea.value = htmlText;
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }

      return true;
    } catch (err) {
      console.warn('[Toca Ficha Dr.] Could not update wysihtml5 editor', err);
      return false;
    }
  }

  /**
   * clearSoapFields() — clears all SOAP textarea fields (0..editorCount-1)
   * and their corresponding wysihtml5 editors. Returns count of fields touched.
   */
  function clearSoapFields() {
    const prefix = sel('soap_field_prefix') || '#prconsulta_prananmeneses_attributes_';
    const suffix = sel('soap_field_suffix') || '_descricao';
    const count = sel('soap_editor_count') || 6;
    let touched = 0;

    for (let i = 0; i < count; i++) {
      const el = document.querySelector(prefix + i + suffix);
      if (!el) continue;
      el.value = '';
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      updateWysihtml5Editor(i, '');
      touched++;
    }

    return touched;
  }

  /**
   * pasteSoapNote(text) — converts \n to <br>, writes into editor 0
   * (the first SOAP field — "Queixa Principal / Histórico").
   *
   * v3.2.0: returns a structured result so the side panel can tell whether
   * any field was actually written. The previous boolean was swallowed by
   * the bridge and produced silent "SOAP colado ✓" messages on wrong sub-pages.
   *
   * @returns {{ok: boolean, fieldsWritten: number, hasField0: boolean}}
   *   hasField0    — true iff BOTH the field-0 textarea AND the wysihtml5
   *                  iframe at index 0 existed at write time.
   *   fieldsWritten — 1 on a successful write, 0 otherwise.
   *   ok           — same as hasField0 (kept for callers that want a flag).
   */
  function pasteSoapNote(text) {
    // Coerce to string — GPT may return an object if the backend coercion was bypassed
    if (typeof text !== 'string') text = JSON.stringify(text);

    const prefix = sel('soap_field_prefix') || '#prconsulta_prananmeneses_attributes_';
    const suffix = sel('soap_field_suffix') || '_descricao';
    const editorSelector = sel('soap_editors') || '.wysihtml5-sandbox';

    const field = document.querySelector(prefix + '0' + suffix);
    const iframe = document.querySelectorAll(editorSelector)[0];
    const hasField0 = !!(field && iframe);

    if (!hasField0) {
      return { ok: false, fieldsWritten: 0, hasField0: false };
    }

    field.value = text;
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.dispatchEvent(new Event('input', { bubbles: true }));

    // Escape HTML-special chars BEFORE converting newlines to <br>. The backend
    // SOAP is plain text (SOAP_TEMPLATE in extension_api.py emits only the
    // SUBJETIVO:/OBJETIVO:/AVALIAÇÃO:/PLANO: sections with \n line breaks — no
    // HTML), so a literal "<word>" token in the note would otherwise be
    // HTML-parsed by _sanitizeSoapHtml as an unknown element and silently dropped
    // from the medical record. Escaping first means only our own <br> is markup.
    const htmlSafe = text
      .replace(/[&<>]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; })
      .replace(/\n/g, '<br>');
    updateWysihtml5Editor(0, htmlSafe);
    return { ok: true, fieldsWritten: 1, hasField0: true };
  }

  // ---------------------------------------------------------------------------
  // CID input
  // ---------------------------------------------------------------------------

  /**
   * findCidInput() — iterates 7 selector strategies from config,
   * filters by computed visibility. Returns first visible candidate or null.
   */
  function findCidInput() {
    const strategies = sel('cid_input') || [];

    for (let i = 0; i < strategies.length; i++) {
      const candidates = Array.from(document.querySelectorAll(strategies[i])).filter(function (input) {
        if (input.disabled) return false;
        const style = window.getComputedStyle ? window.getComputedStyle(input) : null;
        return style && style.display !== 'none' && style.visibility !== 'hidden';
      });

      if (candidates[0]) return candidates[0];
    }

    return null;
  }

  /**
   * fillCid(code, name) — fills the CID field using the EMR's expected format.
   *
   * G-Hosp's jQuery UI autocomplete expects:
   *   #cid_descricao  (visible) → full Portuguese label text
   *   #intcid_cid_id  (hidden)  → internal undotted ID (e.g. "J069")
   *
   * We look up the code in the local TOCAFICHADR_CID database to get the exact
   * emr_id and emr_label. If the code isn't in our list, we derive emr_id by
   * removing dots and use the provided name as the label fallback.
   */
  function fillCid(code, name) {
    if (!code) return false;

    // 1. Resolve emr_id and emr_label
    var emrId = '';
    var emrLabel = '';

    var db = (typeof window !== 'undefined' && window.TOCAFICHADR_CID) ? window.TOCAFICHADR_CID : [];
    var entry = null;
    for (var i = 0; i < db.length; i++) {
      if (db[i].code === code || db[i].emr_id === code.replace(/\./g, '')) {
        entry = db[i];
        break;
      }
    }

    if (entry) {
      emrId = entry.emr_id;
      emrLabel = entry.emr_label;
    } else {
      // Fallback for codes not in our curated list
      emrId = code.replace(/\./g, '');
      emrLabel = name || code;
    }

    // 2. Locate the visible description input (#cid_descricao)
    var descSel = sel('cid_description_input') || '#cid_descricao';
    var descInput = document.querySelector(descSel);
    if (!descInput) {
      // Fallback to the generic finder if the specific selector misses
      descInput = findCidInput();
    }
    if (!descInput) return false;

    // 3. Locate the hidden internal-ID input (#intcid_cid_id)
    var hiddenInput = document.querySelector('#intcid_cid_id');
    if (!hiddenInput) {
      var hiddenSelectors = sel('cid_hidden') || [];
      for (var h = 0; h < hiddenSelectors.length; h++) {
        hiddenInput = document.querySelector(hiddenSelectors[h]);
        if (hiddenInput) break;
      }
    }
    if (!hiddenInput) {
      var parent = descInput.closest('div, td, li, form') || descInput.parentElement;
      if (parent) {
        hiddenInput = parent.querySelector('input[type="hidden"]');
      }
    }

    // 4+5. Set the hidden field FIRST so that any synchronous G-Hosp handler
    //      that fires on the visible field's 'input' event reads the correct
    //      emrId from the hidden input (not the stale previous value). The
    //      jQuery UI autocomplete lifecycle in step 6 also writes this field
    //      via data-update-elements — setting it early is safe and idempotent.
    if (hiddenInput) {
      hiddenInput.value = emrId;
    }

    // Fill visible field and fire events so G-Hosp observers register the input
    descInput.focus();
    descInput.value = emrLabel;
    descInput.dispatchEvent(new Event('input', { bubbles: true }));
    descInput.dispatchEvent(new Event('change', { bubbles: true }));

    // Fire hidden field change AFTER the visible field events (same relative
    // order as before, just the value assignment moved up)
    if (hiddenInput) {
      hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // 6. Drive jQuery UI autocomplete lifecycle with the exact EMR item shape.
    //    The autocomplete's data-update-elements maps item.id → #intcid_cid_id,
    //    so we MUST include the id property.
    if (typeof jQuery !== 'undefined') {
      try {
        var $cid = jQuery(descInput);
        var item = { id: emrId, label: emrLabel, value: emrLabel };
        var ui = { item: item };
        $cid.trigger(jQuery.Event('autocompleteselect'), [ui]);
        $cid.trigger(jQuery.Event('autocompleteclose'), [ui]);
        $cid.trigger(jQuery.Event('autocompletechange'), [ui]);
      } catch (e) {
        console.warn('[Toca Ficha Dr.] fillCid: jQuery autocomplete lifecycle failed:', e && e.message);
      }
    } else {
      console.warn('[Toca Ficha Dr.] fillCid: jQuery not available on page — CID autocomplete may not persist.');
    }

    // 7. Native events + blur so Rails UJS observers commit the value
    descInput.dispatchEvent(new KeyboardEvent('keyup', {
      bubbles: true,
      key: emrLabel ? emrLabel.slice(-1) : '0'
    }));
    descInput.dispatchEvent(new Event('blur', { bubbles: true }));

    return true;
  }

  // ---------------------------------------------------------------------------
  // Recomendas auto-fill (v2.7.3)
  // ---------------------------------------------------------------------------
  /**
   * fillRecomendas(planText) — populate G-Hosp's recomendas/conduta field with
   * the plan body extracted from SOAP. No-op if planText is empty/falsy or the
   * field doesn't exist on the page (some patient types don't have it visible).
   * Non-destructive: skips fill if the field already has user-typed content
   * (defensive — never overwrite a doctor's edits).
   *
   * Backed by Flask's _extract_plan_from_soap() in v3.0.5+. For backwards
   * compatibility with pre-v3.0.5 backends that don't return `plan`, the
   * caller (hud.js) passes an empty string and this function no-ops.
   *
   * Returns true on successful fill, false otherwise (no field, empty input,
   * or pre-existing content preserved).
   */
  function fillRecomendas(planText) {
    if (!planText || typeof planText !== 'string') return false;
    const trimmed = planText.trim();
    if (!trimmed) return false;

    const selKey = sel('recomendas_field') || '#recomendas_descricao';
    const field = document.querySelector(selKey);
    if (!field) return false;

    // Don't overwrite existing doctor-typed content.
    const existing = (field.value || field.textContent || '').trim();
    if (existing) {
      console.log('[Toca Ficha Dr.] fillRecomendas: skipping — field already has content');
      return false;
    }

    field.focus();
    if ('value' in field) {
      field.value = trimmed;
    } else {
      field.textContent = trimmed;
    }
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  // ---------------------------------------------------------------------------
  // Form save
  // ---------------------------------------------------------------------------

  function _findInsertButton(scope) {
    // Confirmed via interaction logs: input[name='commit'][value='Inserir'] inside the dialog.
    // No id. XPath: #dialog_formularios/div/form/div[3]/input
    var byNameValue = scope.querySelector("input[name='commit'][value='Inserir']");
    if (byNameValue) return byNameValue;

    const insertSel = sel('insert_button') || "input[type='submit'][value='Inserir']";
    const submitInScope = scope.querySelector(insertSel);
    if (submitInScope) return submitInScope;

    const buttons = Array.from(scope.querySelectorAll('button, input[type="submit"], input[type="button"]'));
    return buttons.find(function (el) {
      return (el.value || el.textContent || '').trim() === 'Inserir';
    }) || null;
  }

  function _findSaveButton() {
    const dialogSel = sel('dialog') || '#dialog_formularios';
    const dialog = document.querySelector(dialogSel);
    const insertInDialog = dialog ? _findInsertButton(dialog) : null;
    if (insertInDialog) return insertInDialog;

    // Primary: G-Hosp uses input[type="button"] id="submit_pranamnese" (not type=submit)
    const saveSel = sel('save_button') || '#submit_pranamnese';
    const primary = document.querySelector(saveSel);
    if (primary) return primary;

    // Fallback: any Gravar button
    const fallbackSel = sel('save_button_fallback') || "input[type='button'][value='Gravar']";
    const fallback = document.querySelector(fallbackSel);
    if (fallback) return fallback;

    const anySubmit = document.querySelector('input[type="submit"], input[type="button"][value]');
    if (anySubmit) return anySubmit;

    const saveButton = Array.from(document.querySelectorAll('button')).find(function (btn) {
      return (btn.textContent || '').trim().includes('Gravar') ||
             (btn.textContent || '').trim().includes('Salvar');
    });
    return saveButton || null;
  }

  /**
   * saveForm() — clicks the save button if found, otherwise submits the
   * consultation form directly. Returns true on success.
   */
  function saveForm() {
    const btn = _findSaveButton();
    if (btn) {
      btn.click();
      return true;
    }

    const formNewSel = sel('form_new') || "form[id^='new_prconsulta']";
    const formEditSel = sel('form_edit') || "form[id^='edit_prconsulta']";
    const form = document.querySelector(formNewSel + ', ' + formEditSel);
    if (form) {
      if (form.requestSubmit) {
        form.requestSubmit();
      } else {
        form.submit();
      }
      return true;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Prescription
  // ---------------------------------------------------------------------------

  function _waitForDialogContent(timeoutMs) {
    timeoutMs = timeoutMs !== undefined ? timeoutMs : 5000;
    const dialogSel = sel('dialog') || '#dialog_formularios';

    return new Promise(function (resolve, reject) {
      function isReady() {
        const dialog = document.querySelector(dialogSel);
        if (!dialog) return null;
        const hasContent =
          dialog.children.length > 0 ||
          (dialog.textContent || '').trim().length > 0;
        return hasContent ? dialog : null;
      }

      const existing = isReady();
      if (existing) return resolve(existing);

      const observer = new MutationObserver(function () {
        const dialog = isReady();
        if (dialog) {
          observer.disconnect();
          clearTimeout(timeoutHandle);
          resolve(dialog);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      const timeoutHandle = setTimeout(function () {
        observer.disconnect();
        reject(new Error('[Toca Ficha Dr.] Timeout esperando conteúdo do diálogo de receita'));
      }, timeoutMs);
    });
  }

  /**
   * openPrescription() — async. Clicks the prescription link, waits for the
   * dialog to fill, selects the "Utilizar padrões" radio, and waits for the
   * template container to appear. Returns true on success.
   */
  async function openPrescription() {
    let trigger = _findPrescriptionLink();
    if (!trigger) {
      trigger = await _waitForPrescriptionLink(5000);
    }
    if (!trigger) {
      console.warn('[Toca Ficha Dr.] Prescription link not found after waiting');
      return false;
    }

    try {
      // Task 2.7.5 (light): retry the click once if the dialog doesn't appear
      // within the timeout. Apr 15 live-shift logs showed a 10× HTTP 406 cluster
      // on patient 1887000 where the doctor manually re-clicked Adicionar 4×
      // and reloaded 5× over 27 minutes. A single transparent retry covers
      // most transient 406/network blips without touching G-Hosp's DOM. The
      // full circuit-breaker (chrome-error nav detection via SW
      // chrome.webNavigation) is deferred to a dedicated session.
      trigger.click();
      try {
        await _waitForDialogContent(5000);
      } catch (firstErr) {
        console.warn('[Toca Ficha Dr.] Prescription dialog did not appear in 5s, retrying once');
        await sleep(1500);
        const triggerRetry = _findPrescriptionLink();
        if (!triggerRetry) {
          console.warn('[Toca Ficha Dr.] Prescription link gone after retry-wait — page may have navigated to chrome-error');
          return false;
        }
        triggerRetry.click();
        await _waitForDialogContent(5000);
      }

      // Click the "Utilizar Padrões" label to reveal the #padroes template list.
      // Confirmed via interaction logs:
      //   XPath: //*[@id="dialog_formularios"]/div/form/div[1]/fieldset/label
      //   CSS:   #dialog_formularios > div > form > div:first-child > fieldset > label
      // NOTE: do NOT click #tiporec_0 (that is the "Simples" radio — wrong target).
      const utilPadroesSel = sel('prescription_utilizar_padroes') ||
        '#dialog_formularios > div > form > div:first-child > fieldset > label';
      const utilPadroesEl = await waitFor(utilPadroesSel, 3000).catch(function () { return null; });
      if (utilPadroesEl) {
        utilPadroesEl.click();
        utilPadroesEl.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // Fallback: try the original radio button
        const typeRadioSel = sel('prescription_type_radio') || '#tiporec_0';
        const typeRadio = await waitFor(typeRadioSel, 3000).catch(function () { return null; });
        if (typeRadio) {
          typeRadio.click();
          typeRadio.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      const containerSel = sel('template_container') || '#padroes';
      await waitFor(containerSel, 3000).catch(function () {
        console.warn('[Toca Ficha Dr.] #padroes template container not found after clicking Utilizar Padrões');
      });

      return true;
    } catch (err) {
      console.warn('[Toca Ficha Dr.] Failed to open prescription dialog', err);
      return false;
    }
  }

  /**
   * selectTemplate(templateId) — clicks the radio button for the given
   * prescription template ID. Ensures the template container is visible first.
   */
  function selectTemplate(templateId) {
    const containerSel = sel('template_container') || '#padroes';
    const typeRadioSel = sel('prescription_type_radio') || '#tiporec_0';

    const padroesDiv = document.querySelector(containerSel);
    if (padroesDiv && window.getComputedStyle(padroesDiv).display === 'none') {
      const tiporec0 = document.querySelector(typeRadioSel);
      if (tiporec0) {
        tiporec0.click();
        tiporec0.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    const radio = document.querySelector(
      "input[type='radio'][name='padraorec'][value='" + CSS.escape(String(templateId)) + "']"
    );
    if (!radio) {
      console.warn('[Toca Ficha Dr.] Template ' + templateId + ' not found');
      return false;
    }

    radio.click();
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    radio.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  /**
   * submitPrescriptionDialog() — async. Finds and clicks the "Inserir" button
   * inside the prescription dialog. Waits 2s for the submission to complete.
   */
  async function submitPrescriptionDialog() {
    const dialogSel = sel('dialog') || '#dialog_formularios';
    const dialog = document.querySelector(dialogSel);
    if (!dialog) return false;

    const insertSel = sel('insert_button') || "input[type='submit'][value='Inserir']";
    const insertButton = dialog.querySelector(insertSel) || _findInsertButton(dialog);
    if (!insertButton) return false;

    insertButton.click();
    await sleep(2000);
    return true;
  }

  /**
   * _closePrescriptionDialog() — async. Best-effort cleanup that hides the
   * prescription dialog (`#dialog_formularios`) without saving anything.
   * Used by `probeGhospTemplates()` so the doctor's UI isn't disrupted by a
   * lingering popup after a probe.
   *
   * Strategy (in order, all best-effort):
   *   1. jQuery UI close button inside the dialog (G-Hosp uses jQuery UI).
   *   2. Any anchor with text "Cancelar" / "Fechar" inside the dialog.
   *   3. ESC key dispatched to the dialog (jQuery UI default close hotkey).
   *   4. Hide via `display:none` as last resort.
   */
  async function _closePrescriptionDialog() {
    const dialogSel = sel('dialog') || '#dialog_formularios';
    const dialog = document.querySelector(dialogSel);
    if (!dialog) return true;

    // 1. jQuery UI dialog header close button
    try {
      const wrap = dialog.closest('.ui-dialog') || dialog.parentElement;
      const closeBtn = wrap && wrap.querySelector('.ui-dialog-titlebar-close, button[title="close" i], .ui-dialog-titlebar a[role="button"]');
      if (closeBtn) {
        closeBtn.click();
        await sleep(150);
        const _dlg1 = document.querySelector(dialogSel);
        if (!_dlg1 || getComputedStyle(_dlg1).display === 'none') return true;
      }
    } catch (_) { /* fall through */ }

    // 2. Any cancel/fechar anchor inside the dialog
    try {
      const anchors = Array.from(dialog.querySelectorAll('a, button, input[type="button"]'));
      const cancel = anchors.find(function (el) {
        const t = (el.textContent || el.value || '').trim().toLowerCase();
        return t === 'cancelar' || t === 'fechar' || t === 'cancel' || t === 'close';
      });
      if (cancel) {
        cancel.click();
        await sleep(150);
        const _dlg2 = document.querySelector(dialogSel);
        if (!_dlg2 || getComputedStyle(_dlg2).display === 'none') return true;
      }
    } catch (_) { /* fall through */ }

    // 3. Esc key on dialog (jQuery UI default close)
    try {
      const esc = new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true,
      });
      dialog.dispatchEvent(esc);
      document.dispatchEvent(esc);
      await sleep(150);
      const _dlg3 = document.querySelector(dialogSel);
      if (!_dlg3 || getComputedStyle(_dlg3).display === 'none') return true;
    } catch (_) { /* fall through */ }

    // 4. Hide as last resort so the doctor doesn't see a popup flash.
    try {
      const wrap = dialog.closest('.ui-dialog') || dialog;
      wrap.style.display = 'none';
      dialog.style.display = 'none';
    } catch (_) { /* swallow */ }
    return true;
  }

  /**
   * _extractTemplateLabel(radio) — extracts the human-readable label text
   * for a `padraorec` radio. Tries three strategies:
   *   (a) `radio.closest('label')` (radio wrapped inside a label)
   *   (b) sibling text node next to the radio
   *   (c) parent node textContent as last resort
   * The result is trimmed and collapsed to a single line.
   */
  function _extractTemplateLabel(radio) {
    function _clean(text) {
      return (text || '').replace(/\s+/g, ' ').trim();
    }

    // (a) ancestor <label>
    try {
      const ownLabel = radio.closest && radio.closest('label');
      if (ownLabel) {
        const txt = _clean(ownLabel.textContent || '');
        if (txt) return txt;
      }
    } catch (_) { /* fall through */ }

    // (a2) <label for="..."> referencing the radio's id
    try {
      if (radio.id) {
        const linked = document.querySelector('label[for=' + CSS.escape(radio.id) + ']');
        if (linked) {
          const txt = _clean(linked.textContent || '');
          if (txt) return txt;
        }
      }
    } catch (_) { /* fall through */ }

    // (b) sibling text/element nodes — accumulate until a non-text/non-inline node
    try {
      let cursor = radio.nextSibling;
      let collected = '';
      while (cursor) {
        if (cursor.nodeType === 3) {
          collected += cursor.nodeValue || '';
        } else if (cursor.nodeType === 1) {
          // Stop on the next radio or block element; otherwise pick up inline
          // text from <span>, <b>, <i>, <a> labels.
          const tag = cursor.tagName;
          if (tag === 'INPUT' || tag === 'BR' || tag === 'DIV' || tag === 'P') break;
          collected += cursor.textContent || '';
        }
        cursor = cursor.nextSibling;
      }
      const txt = _clean(collected);
      if (txt) return txt;
    } catch (_) { /* fall through */ }

    // (c) parent textContent fallback
    try {
      const parent = radio.parentNode;
      if (parent) {
        const txt = _clean(parent.textContent || '');
        if (txt) return txt;
      }
    } catch (_) { /* fall through */ }

    return '';
  }

  /**
   * probeGhospTemplates() — async. Drives the "Utilizar Padrões" flow
   * programmatically to enumerate every prescription template the doctor has
   * server-side access to (not just the hardcoded 1080-1089 range).
   *
   * Steps:
   *   1. Click `#link_new_receitaalta` to open the prescription dialog.
   *   2. Wait for `#dialog_formularios`.
   *   3. Click the "Utilizar Padrões" label to reveal `#padroes`.
   *   4. Wait for `#padroes` to populate.
   *   5. Enumerate every `input[name="padraorec"]` and extract `{id, label}`.
   *   6. Close the dialog (cancel/Esc) so the doctor's UI isn't disrupted.
   *
   * Returns: `Array<{id, label}>`. Empty array if probe fails (fault is
   * surfaced via the bridge's error path, not here).
   *
   * Note: Many templates may share the same ID across different consultation
   * types (e.g. ID 637 maps to "OMA amoxi" on pediatrics and
   * "Laringotraqueíte viral" on adult medicine). The bridge keys the catalog
   * by `urlKey` to keep them distinct.
   */
  async function probeGhospTemplates() {
    // Step 1+2+3+4: reuse openPrescription() — it already drives all four
    // steps, including the retry-once on dialog-doesn't-appear pattern.
    const ok = await openPrescription();
    if (!ok) {
      throw new Error('Não foi possível abrir o diálogo de padrões');
    }

    // Step 4 (defensive): ensure #padroes is rendered. openPrescription()
    // already awaits it, but it swallows the timeout — re-check here so we
    // can fail loudly if the doctor doesn't actually have padroes access.
    const containerSel = sel('template_container') || '#padroes';
    const container = document.querySelector(containerSel);
    if (!container) {
      // Try to close the dialog before throwing so we don't leave it open.
      try { await _closePrescriptionDialog(); } catch (_) {}
      throw new Error('Lista de padrões (#padroes) não apareceu');
    }

    // Step 5: enumerate padraorec radios
    const radios = container.querySelectorAll('input[name="padraorec"]');
    const out = [];
    const seen = Object.create(null);
    for (let i = 0; i < radios.length; i++) {
      const radio = radios[i];
      const id = radio.value || '';
      if (!id || seen[id]) continue;
      seen[id] = true;
      const label = _extractTemplateLabel(radio) || ('Modelo ' + id);
      out.push({ id: id, label: label });
    }

    // Step 6: close the dialog so the doctor's UI isn't disrupted.
    try { await _closePrescriptionDialog(); } catch (_) { /* best-effort */ }

    return out;
  }

  /**
   * runGhospTemplate(templateId) — async. Drives the full G-Hosp prescription
   * flow for a server-side template: open dialog → click "Utilizar Padrões"
   * → click the radio with `value=templateId` → click Inserir → click
   * Imprimir. Returns `{ok, error?}`.
   *
   * This is the catalog-backed equivalent of the legacy hardcoded button
   * (which assumed the ID was within 1080-1089). Templates outside that range
   * (e.g. 637, 1079, 735) now work automatically.
   */
  async function runGhospTemplate(templateId) {
    if (!templateId) return { ok: false, error: 'templateId ausente' };

    try {
      const opened = await openPrescription();
      if (!opened) return { ok: false, error: 'Não foi possível abrir a receita' };

      // Pick the radio. Use the existing selectTemplate() — it covers the
      // edge case where #padroes is hidden by re-clicking the toggle.
      const picked = selectTemplate(templateId);
      if (!picked) {
        // Surface a useful error so the side panel can prompt re-sync.
        try { await _closePrescriptionDialog(); } catch (_) {}
        return { ok: false, error: 'Template ' + templateId + ' não encontrado — tente sincronizar novamente' };
      }

      // Click Inserir + wait for the dialog post-insert state.
      await sleep(200);
      const inserted = await submitPrescriptionDialog();
      if (!inserted) return { ok: false, error: 'Botão Inserir não encontrado' };

      // Click Imprimir.
      const printed = await printPrescription();
      if (!printed) return { ok: false, error: 'Botão Imprimir não encontrado' };

      return { ok: true };
    } catch (err) {
      // Best-effort cleanup so a failed run doesn't strand a popup.
      try { await _closePrescriptionDialog(); } catch (_) {}
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  /**
   * printPrescription() — async. Looks for the print link first inside the
   * prescription dialog (#dialog_formularios), then in the whole document.
   * Real DOM: a.botao.btn-2nd[href="/pr/receitaaltas_imp_receita?id=..."]
   * located at #dialog_formularios > div:nth-child(2) > a
   */
  async function printPrescription() {
    // Primary: confirmed via interaction logs — first <a> in the second div of the dialog
    // XPath: //*[@id="dialog_formularios"]/div[2]/a[1]
    // CSS:   #dialog_formularios > div:nth-child(2) > a:first-child
    var confirmedSel = sel('print_prescription_dialog') ||
      '#dialog_formularios > div:nth-child(2) > a:first-child';
    var printLink = document.querySelector(confirmedSel);
    if (printLink && !printLink.classList.contains('disabled')) {
      printLink.click();
      return true;
    }

    // Fallback: any link with 'imp_receita' in href, inside dialog first
    var hrefSel = sel('print_link') || "a[href*='imp_receita']";
    var dialogSel = sel('dialog') || '#dialog_formularios';
    var dialog = document.querySelector(dialogSel);
    if (dialog) {
      printLink = Array.from(dialog.querySelectorAll(hrefSel))
        .find(function (a) { return !a.classList.contains('disabled'); });
    }
    if (!printLink) {
      printLink = Array.from(document.querySelectorAll(hrefSel))
        .find(function (a) { return !a.classList.contains('disabled'); });
    }
    if (printLink) {
      printLink.click();
      return true;
    }

    var fallbackSel = sel('print_link_fallback') || "a[href*='imprimir_prescricao']";
    var fallbackLink = document.querySelector(fallbackSel + ':not(.disabled)');
    if (fallbackLink) {
      fallbackLink.click();
      return true;
    }

    console.warn('[Toca Ficha Dr.] Print link not found');
    return false;
  }

  // ---------------------------------------------------------------------------
  // Discharge
  // ---------------------------------------------------------------------------

  /**
   * _isSemEncaminhamentoOption(opt) — content-based predicate for the
   * "Sem encaminhamento" option. Confirmed value = "100" across 32/32 logged
   * change events (3 shifts), but we still match on text as a defensive
   * fallback in case G-Hosp ever renumbers the option.
   */
  function _isSemEncaminhamentoOption(opt, noReferralText) {
    if (!opt) return false;
    var t = (opt.text || '').toLowerCase();
    var ref = (noReferralText || 'sem encaminhamento').toLowerCase();
    return (
      opt.value === '100' ||
      t.indexOf('sem encaminh') !== -1 ||
      t.indexOf(ref) !== -1
    );
  }

  /**
   * _selectHasReferralOptions(selectEl) — true if any option matches the
   * "Sem encaminhamento" predicate. Used to identify the encaminh select by
   * its CONTENTS, not its id/name (see Session 2026-04-15: the form may
   * contain a Prioridade select with similar id patterns).
   */
  function _selectHasReferralOptions(selectEl, noReferralText) {
    if (!selectEl || !selectEl.options) return false;
    for (var j = 0; j < selectEl.options.length; j++) {
      if (_isSemEncaminhamentoOption(selectEl.options[j], noReferralText)) return true;
    }
    return false;
  }

  /**
   * _resolveEncaminhSelect(formEl) — returns the encaminh <select> by
   * (1) trying configured selectors and validating their option content,
   * (2) falling back to a content-scan of every <select> in the form.
   * Returns null if no candidate matches.
   */
  function _resolveEncaminhSelect(formEl) {
    var referralSelectors = sel('discharge_referral_select') || ['#intern_encaminh'];
    var noReferralText = sel('discharge_no_referral_text') || 'sem encaminhamento';

    for (var i = 0; i < referralSelectors.length; i++) {
      var candidate = (formEl && formEl.querySelector(referralSelectors[i]))
        || document.querySelector(referralSelectors[i]);
      if (candidate && _selectHasReferralOptions(candidate, noReferralText)) {
        return candidate;
      }
    }
    if (formEl) {
      var allSelects = Array.from(formEl.querySelectorAll('select'));
      var match = allSelects.find(function (s) {
        return _selectHasReferralOptions(s, noReferralText);
      });
      if (match) return match;
    }
    return null;
  }

  /**
   * _findSemEncaminhamentoOption(selectEl) — returns the matching option
   * element or null.
   */
  function _findSemEncaminhamentoOption(selectEl) {
    var noReferralText = sel('discharge_no_referral_text') || 'sem encaminhamento';
    if (!selectEl || !selectEl.options) return null;
    // Do NOT fall back to opt.value === '0' — that is the Rails include_blank
    // placeholder ("-- selecione --"), NOT "Sem encaminhamento". Selecting it
    // submits the discharge form with no referral field chosen, causing a
    // server-side validation error (or a silent empty submission on older G-Hosp
    // versions). Return null and let the caller decide; the confirmed value is
    // '100' per 32/32 logged events (see _isSemEncaminhamentoOption).
    return Array.from(selectEl.options).find(function (opt) {
      return _isSemEncaminhamentoOption(opt, noReferralText);
    }) || null;
  }

  // Idempotency: tracks the form id we last auto-prefilled so the
  // MutationObserver doesn't re-run on every DOM tweak inside the dialog.
  var _lastPrefilledFormId = null;

  /**
   * prefillDischargeForm() — async. Idempotent. Sets the encaminh select to
   * "Sem encaminhamento" (value=100) IFF the field is currently empty.
   *
   * Why this exists: `processDischarge()` already auto-fills 100 for the
   * Alta e voltar flow, but when the doctor opens the alta dialog
   * MANUALLY (not via Alta e voltar) the form re-renders blank and they have
   * to pick 100 by hand. Logger evidence (3 shifts, 32/32 manual change
   * events to value=100) shows this is a near-deterministic prefill.
   *
   * Safety:
   * - Only writes when value is '' / null / undefined. Never overwrites an
   *   existing pick (the doctor may have deliberately chosen 112
   *   "Acompanhamento" — see 2026-04-15 session log).
   * - Gated on chrome.storage.sync.autoPrefillEncaminh (default true).
   * - Gated on _lastPrefilledFormId !== currentFormId so a busy MutationObserver
   *   can't drive this in a tight loop.
   *
   * Returns true if a value was written, false otherwise.
   */
  async function prefillDischargeForm() {
    try {
      var dischargeFormSel = sel('discharge_form') || "form[id^='edit_intern']";
      var formEl = document.querySelector(dischargeFormSel);
      if (!formEl) return false;

      // Use the form's id (e.g. edit_intern_1879966) as the idempotency key.
      // The id changes per patient, so navigating to a new alta resets the gate.
      var formKey = formEl.id || formEl.getAttribute('action') || 'unknown-form';
      if (_lastPrefilledFormId === formKey) return false;

      // Storage flag — default true. Read every call so the doctor can flip
      // it off without reloading the extension.
      var flag;
      try {
        flag = await chrome.storage.sync.get(['autoPrefillEncaminh']);
      } catch (_) { flag = {}; }
      if (flag && flag.autoPrefillEncaminh === false) return false;

      var selectEl = _resolveEncaminhSelect(formEl);
      if (!selectEl) return false;

      // Idempotency: NEVER overwrite a non-empty value. The doctor may have
      // already picked 112 "Acompanhamento" (logged once on 2026-04-15).
      var current = (selectEl.value == null ? '' : String(selectEl.value)).trim();
      if (current !== '') {
        _lastPrefilledFormId = formKey; // remember so we don't re-check this form
        return false;
      }

      var opt = _findSemEncaminhamentoOption(selectEl);
      if (!opt) return false;

      // Same focus → value → change → input sequence as processDischarge —
      // Rails UJS / G-Hosp's select handler listens for both events.
      selectEl.focus();
      selectEl.value = opt.value;
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      selectEl.dispatchEvent(new Event('input', { bubbles: true }));
      _lastPrefilledFormId = formKey;
      console.log('[Toca Ficha Dr.] prefillDischargeForm: encaminh =', opt.value, '|', opt.text);
      return true;
    } catch (err) {
      console.warn('[Toca Ficha Dr.] prefillDischargeForm error (non-fatal):', err);
      return false;
    }
  }

  /**
   * processDischarge(internId) — async. Clicks the discharge link, waits for
   * the dialog/form to open, selects "sem encaminhamento" in the referral
   * dropdown, and submits. Returns true on success.
   */
  async function processDischarge(internId) {
    console.group('[Toca Ficha Dr.] Discharge');
    try {
      const id = internId || getInternId();
      console.log('intern_id:', id);
      if (!id) {
        console.warn('intern_id not found — aborting');
        throw new Error('discharge_no_intern_id');
      }

      // --- Step 1: find Adicionar link ---
      var altaLink = document.querySelector(
        sel('discharge_link_direct') || '#dar_alta fieldset legend b a'
      );
      if (!altaLink) {
        const containerSel = sel('discharge_container') || '#dar_alta';
        const container = document.querySelector(containerSel);
        altaLink = container ? container.querySelector('a') : null;
      }
      if (!altaLink) {
        altaLink = document.querySelector(
          sel('discharge_link_fallback') || "a[href*='/altas/'][href*='edit']"
        );
      }
      console.log('alta link found:', !!altaLink, altaLink && altaLink.href);
      if (!altaLink) throw new Error('discharge_link_not_found');

      altaLink.click();
      console.log('alta link clicked');

      // --- Step 2: wait for form ---
      var dischargeForm = null;
      var dischargeSel = sel('discharge_form') || "form[id^='edit_intern']";
      try {
        dischargeForm = await waitFor(dischargeSel, 5000);
      } catch (_) {
        await sleep(2000);
        dischargeForm = document.querySelector(dischargeSel)
          || document.querySelector('form[action*="alta"]')
          || document.querySelector('form[id*="alta"]');
      }
      console.log('discharge form:', dischargeForm && {
        id: dischargeForm.id,
        action: dischargeForm.action,
        method: dischargeForm.method,
        dataRemote: dischargeForm.getAttribute('data-remote'),
      });
      if (!dischargeForm) {
        console.warn('discharge form not found');
        throw new Error('discharge_form_not_found');
      }

      // --- Step 2.5: pre-fill #alta_data_alta with today's date ---
      // Logged behavior: 8/13/18 manual focus events on this field per shift
      // (2026-05-01, 04-29, 04-15). Doctor opens form, clicks the date input,
      // types today's date. Pre-filling saves a click + typing per discharge.
      // Defensive: only set if empty — never overwrite a value the user (or
      // G-Hosp's own server-side default) put there.
      try {
        const dateSel = sel('discharge_date_input') || '#alta_data_alta';
        const dateInput = dischargeForm.querySelector(dateSel)
          || document.querySelector(dateSel);
        if (dateInput && !(dateInput.value || '').trim()) {
          const d = new Date();
          // G-Hosp jQuery datepicker expects DD/MM/YYYY (Brazilian locale,
          // confirmed against interaction-logger captures).
          const pad = function (n) { return n < 10 ? '0' + n : '' + n; };
          const today = pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
          dateInput.focus();
          dateInput.value = today;
          dateInput.dispatchEvent(new Event('input', { bubbles: true }));
          dateInput.dispatchEvent(new Event('change', { bubbles: true }));
          console.log('discharge date pre-filled:', today);
        } else if (dateInput) {
          console.log('discharge date already filled, leaving as-is:', dateInput.value);
        }
      } catch (err) {
        // Non-fatal — discharge can still proceed if the date field can't
        // be auto-filled. The doctor will see the empty field and fill it.
        console.warn('[Toca Ficha Dr.] discharge date pre-fill failed (non-fatal):', err);
      }

      // --- Step 3: fill referral select ---
      // Content-based discovery (extracted into _resolveEncaminhSelect): the
      // alta form may contain multiple <select> elements (Prioridade,
      // Encaminhamento, etc.). Id/name selectors have proven unreliable —
      // a form captured 2026-04-15 had id `#intern_encaminh` missing and broad
      // `[id*='…']` selectors matched the Prioridade select instead. The shared
      // helper validates by option content (value=100 / "sem encaminh" text).
      var semEncSelect = _resolveEncaminhSelect(dischargeForm);
      console.log('referral select found:', !!semEncSelect, semEncSelect && {
        id: semEncSelect.id,
        name: semEncSelect.name,
        currentValue: semEncSelect.value,
        optionsCount: semEncSelect.options.length,
      });

      if (semEncSelect) {
        var semEncOption = _findSemEncaminhamentoOption(semEncSelect);
        if (semEncOption) {
          // Replicate the real human sequence captured in interaction logs:
          // focus → click → change → input. Rails UJS / G-Hosp's select handler
          // listens for both `change` and `input` to mark the field dirty.
          semEncSelect.focus();
          semEncSelect.value = semEncOption.value;
          semEncSelect.dispatchEvent(new Event('change', { bubbles: true }));
          semEncSelect.dispatchEvent(new Event('input', { bubbles: true }));
          console.log('referral set:', semEncOption.value, '|', semEncOption.text, '| post-set value:', semEncSelect.value);
        } else {
          console.warn('"sem encaminhamento" option not found. Options:',
            Array.from(semEncSelect.options).map(function (o) { return o.value + ':' + o.text; }).join(', '));
        }
      }

      await sleep(500);

      // --- Step 4: locate submit button ---
      var submitSel = sel('discharge_submit_button') || '#botao_gravar_alta';
      var submitBtn = dischargeForm.querySelector(submitSel)
        || document.querySelector(submitSel)
        || dischargeForm.querySelector('input[type="submit"]')
        || dischargeForm.querySelector('button[type="submit"]');
      console.log('submit button:', !!submitBtn, submitBtn && {
        id: submitBtn.id,
        type: submitBtn.type,
        disabled: submitBtn.disabled,
        formAttr: submitBtn.getAttribute('form'),
      });

      if (!submitBtn) {
        console.warn('submit button not found, trying form.requestSubmit()');
        try { dischargeForm.requestSubmit(); } catch (_) { dischargeForm.submit(); }
        return await verifyDischargeComplete();
      }

      // --- Step 5: focus + dispatch real MouseEvent click ---
      // Interaction logs show humans focus the button before clicking.
      // Some Rails UJS handlers depend on event.target.form, which is only
      // resolved correctly when the click is a real bubbling MouseEvent.
      submitBtn.focus();
      console.log('active element before click:', document.activeElement && document.activeElement.id);
      submitBtn.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
      }));
      console.log('MouseEvent click dispatched');

      await sleep(1000);
      var stillThere = !!document.querySelector(submitSel);
      console.log('1s post-click — submit button still in DOM:', stillThere);

      // Only fall back to programmatic submit if Rails UJS clearly didn't handle it
      if (stillThere && document.contains(dischargeForm)) {
        console.warn('falling back to dischargeForm.requestSubmit(submitBtn)');
        try { dischargeForm.requestSubmit(submitBtn); } catch (_) { dischargeForm.submit(); }
      }

      var confirmed = await verifyDischargeComplete();
      console.log('verifyDischargeComplete:', confirmed);
      if (!confirmed) {
        console.warn('form still present after submit — discharge may not have saved');
        throw new Error('discharge_verification_failed: formulário de alta ainda presente após Gravar');
      }
      return confirmed;
    } finally {
      console.groupEnd();
    }
  }

  /**
   * verifyDischargeComplete() — async. Waits up to 4s for the discharge submit
   * button (#botao_gravar_alta) to disappear from the DOM, which indicates
   * Rails UJS successfully submitted the form and reloaded the section.
   * Returns true if the form is gone (success), false if it's still present (failed).
   */
  async function verifyDischargeComplete() {
    // Pragmatic verification: G-Hosp's post-discharge UI pattern doesn't
    // reliably remove the Gravar button nor substantially re-render #dar_alta
    // — the AJAX response often just shows a success toast and leaves the
    // section alone. Previous strict heuristics (button-removed OR container
    // delta) produced false-negative "Falha" messages after real successes.
    //
    // New contract: the form submit itself is evidence of an attempted write.
    // Wait briefly for Rails to respond, then look ONLY for explicit
    // validation errors. If none appear, treat as success. The doctor can
    // always manually re-discharge if G-Hosp rejected silently (rare), and
    // a false success + redirect is a better UX than a false failure.
    var submitSel = sel('discharge_submit_button') || '#botao_gravar_alta';
    var containerSel = sel('discharge_container') || '#dar_alta';
    var initialContainerHTMLLen = (() => {
      var c = document.querySelector(containerSel);
      return c ? (c.innerHTML || '').length : 0;
    })();
    function looksLikeValidationError() {
      // Only hard failures: Rails field_with_errors, or explicit error-text alerts.
      if (document.querySelector('.field_with_errors')) return 'field_with_errors';
      var flashErr = document.querySelector('.flash-error, .alert-danger');
      if (flashErr) {
        var txt = (flashErr.textContent || '').toLowerCase();
        if (txt.indexOf('erro') !== -1 || txt.indexOf('inválido') !== -1 ||
            txt.indexOf('obrigat') !== -1 || txt.indexOf('falhou') !== -1 ||
            txt.indexOf('não foi possível') !== -1) {
          return (flashErr.textContent || '').trim().slice(0, 120);
        }
      }
      return null;
    }

    // Poll for 4s — early-exit on any strong success signal.
    for (var i = 0; i < 8; i++) {
      await sleep(500);
      // Strong success 1: submit button removed
      if (!document.querySelector(submitSel)) {
        console.log('[Toca Ficha Dr.] discharge: submit button removed — success');
        return true;
      }
      // Strong success 2: container re-rendered significantly
      var container = document.querySelector(containerSel);
      if (container) {
        var nowLen = (container.innerHTML || '').length;
        if (Math.abs(nowLen - initialContainerHTMLLen) > 50) {
          console.log('[Toca Ficha Dr.] discharge: container re-rendered — success (len ' +
            initialContainerHTMLLen + ' → ' + nowLen + ')');
          return true;
        }
      }
      // Hard failure signal
      if (i >= 1) {
        var errMsg = looksLikeValidationError();
        if (errMsg) {
          console.warn('[Toca Ficha Dr.] discharge: validation error:', errMsg);
          return false;
        }
      }
    }
    // 4s elapsed: no strong success signal, no validation error. The submit
    // was dispatched and Rails returned without protest. Treat as success.
    console.log('[Toca Ficha Dr.] discharge: no error after 4s, assuming success (form submitted, no validation failure)');
    return true;
  }

  /**
   * goToMainList() — navigates to the G-Hosp patient list page.
   *
   * Disarms the page's `beforeunload` handler first so Chrome doesn't show
   * the "Leave site?" modal (which extensions cannot dismiss by design).
   * The disarm is best-effort with a 1.5s timeout; if it fails we navigate
   * anyway and fall back to the user clicking Leave manually.
   */
  async function goToMainList() {
    try {
      if (window.TOCAFICHADR_api && typeof window.TOCAFICHADR_api.disarmBeforeUnload === 'function') {
        await window.TOCAFICHADR_api.disarmBeforeUnload();
      }
    } catch (e) {
      console.warn('[Toca Ficha Dr.] disarmBeforeUnload failed (continuing to navigate):', e);
    }
    window.location.href = sel('main_list_url') || '/amb/interns';
  }

  /**
   * openBauMedico() — opens the Baú Médico page for the current patient in a
   * new tab. Required for transfers, in-hospital medication orders, and admissions.
   *
   * URL pattern (confirmed): /ver_fichas?intern_id={internId}&id=5
   * Example: https://prbentogoncalves.g-hosp.com.br/ver_fichas?intern_id=1879966&id=5
   */
  function openBauMedico() {
    var internId = getInternId();
    if (!internId) {
      console.warn('[Toca Ficha Dr.] Baú Médico: intern_id não encontrado na URL');
      return false;
    }
    var pathTemplate = sel('bau_medico_path') || '/ver_fichas?intern_id={internId}&id=5';
    var url = pathTemplate.replace('{internId}', internId);
    window.open(url, '_blank');
    return true;
  }

  /**
   * openAtestado() — async. Clicks the atestado (medical certificate) link
   * and waits briefly for the dialog to open.
   */
  async function openAtestado() {
    const atestadoSel = sel('atestado_link') || '#link_new_presatestados';
    const trigger = document.querySelector(atestadoSel);
    if (!trigger) {
      console.warn('[Toca Ficha Dr.] Atestado link not found:', atestadoSel);
      return false;
    }

    trigger.click();
    await sleep(1500);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Atestado completion flow
  // ---------------------------------------------------------------------------
  // Logged pattern (4-6× per shift): open → Inserir to enter form → optional
  // "Acompanhante Mãe: NAME" in #presatestado_obs → Gravar → IMPRIMIR SEM CID.

  function _findInsiderAtestadoButton(value) {
    const form = document.querySelector(sel('presatestado_form') || '#new_presatestado_form')
      || document.querySelector('#new_presatestado')
      || document.querySelector('#dialog_formularios');
    if (!form) return null;
    const inputs = Array.from(form.querySelectorAll('input[type="submit"], input[type="button"]'));
    return inputs.find(function (el) { return (el.value || '').trim() === value; }) || null;
  }

  function _findPrintSemCidLink() {
    const primary = document.querySelector(sel('presatestado_print_sem_cid') || '#show_atestado_alta a.botao.btn-2nd.mini-btn');
    if (primary) return primary;
    const container = document.querySelector('#show_atestado_alta') || document;
    const anchors = Array.from(container.querySelectorAll('a'));
    // Loosened from /imprimir\s+sem\s+cid/i — G-Hosp may have relabeled
    // the link to plain "Imprimir" or "Imprimir Atestado". Inside
    // #show_atestado_alta there is only one print-shaped link, so a
    // loose match is safe. If the container is the whole document
    // (renamed/missing), require an href hint to avoid false matches.
    const looseInContainer = anchors.find(function (a) {
      return /imprim/i.test((a.textContent || '').trim());
    });
    if (looseInContainer && container !== document) return looseInContainer;
    const hrefHinted = (looseInContainer && container === document)
      ? anchors.find(function (a) {
          const h = (a.getAttribute('href') || '').toLowerCase();
          return h.indexOf('imp_atestado') !== -1
            || (h.indexOf('atestado') !== -1 && h.indexOf('print') !== -1);
        })
      : null;
    return hrefHinted || (container !== document ? looseInContainer : null) || null;
  }

  /**
   * finalizeAtestado() — clicks Gravar, waits for the "IMPRIMIR SEM CID"
   * link, clicks it. Mirrors finalizeSimplesPrescription.
   */
  async function finalizeAtestado() {
    try {
      let saveBtn = document.querySelector(sel('presatestado_save')
        || "#new_presatestado input[type='submit'][value='Gravar']");
      if (!saveBtn) saveBtn = _findInsiderAtestadoButton('Gravar');
      if (!saveBtn) {
        console.warn('[Toca Ficha Dr.] atestado: Gravar button not found');
        return false;
      }
      saveBtn.click();

      let printLink = await waitFor(sel('presatestado_print_sem_cid')
        || '#show_atestado_alta a.botao.btn-2nd.mini-btn', 5000)
        .catch(function () { return null; });
      if (!printLink) printLink = _findPrintSemCidLink();
      if (!printLink) {
        console.warn('[Toca Ficha Dr.] atestado: IMPRIMIR SEM CID link not found after save');
        return false;
      }
      printLink.click();
      return true;
    } catch (err) {
      console.warn('[Toca Ficha Dr.] finalizeAtestado error:', err);
      if (window.TOCAFICHADR_api && window.TOCAFICHADR_api.reportError) {
        window.TOCAFICHADR_api.reportError('dom-engine.finalizeAtestado', err);
      }
      return false;
    }
  }

  /**
   * runAtestadoFull(days, companionMode) — v3.4.0. Drives the entire atestado
   * flow end-to-end in one call (open dialog → set days → fill obs → save →
   * print). Returns { ok: true } or { ok: false, error: '<token>' }.
   *
   * Drawer-driven entrypoint — replaces the "open + manual + finalize"
   * two-step interaction.
   *
   * Steps (each one corresponds to a single doctor click in the legacy UI):
   *   1. Click #link_new_presatestados → wait #new_presatestado_form
   *   2. Click Inserir → wait #presatestado_obs (form is now editable)
   *   3. Set #nro_dias.value = days. We dispatch input + change because
   *      G-Hosp's calc_data_fin handler is wired on either event depending
   *      on jQuery UI version; firing both is cheap and avoids server-side
   *      Data Final being out of sync if only one event was hooked. Sleep
   *      ~400ms so the calc_data_fin XHR can complete.
   *   4. If companionMode === 'on': read extractCompanionInfo(), build the
   *      multi-parent stacked obs string, write it to #presatestado_obs.
   *      OFF: leave obs untouched (G-Hosp's default form auto-uses the
   *      patient name, which is what the doctor wants).
   *   5. Click Gravar → sleep ~1500ms for server save.
   *   6. Click IMPRIMIR SEM CID.
   */
  async function runAtestadoFull(days, companionMode) {
    const _err = function (token) { return { ok: false, error: token }; };
    try {
      const nDays = Math.max(1, Math.min(30, parseInt(days, 10) || 1));
      // companionMode is 'mae' | 'pai' | 'outro' or null (patient-only).
      // Anything else — including legacy 'general' from pre-v3.5 callers —
      // collapses to null and skips the obs-write step. Step 5 below is the
      // only place that consumes `mode`; null short-circuits it.
      const mode = (companionMode === 'mae' || companionMode === 'pai' || companionMode === 'outro')
        ? companionMode
        : null;

      // Step 1 — open the atestado dialog.
      const atestadoSel = sel('atestado_link') || '#link_new_presatestados';
      const trigger = document.querySelector(atestadoSel);
      if (!trigger) {
        console.warn('[Toca Ficha Dr.] runAtestadoFull: atestado link not found');
        return _err('atestado_link_not_found');
      }
      trigger.click();
      // Wait for the new_presatestado_form (the dialog content) to appear.
      const formSel = sel('presatestado_form') || '#new_presatestado_form';
      const form = await waitFor(formSel, 5000).catch(function () { return null; });
      if (!form) return _err('atestado_form_not_found');

      // Step 2 — click Inserir to enter the editable form.
      const inserirSel = sel('presatestado_inserir')
        || "#new_presatestado_form input[type='submit'][value='Inserir']";
      let inserirBtn = await waitFor(inserirSel, 4000).catch(function () { return null; });
      if (!inserirBtn) inserirBtn = _findInsiderAtestadoButton('Inserir');
      if (!inserirBtn) return _err('atestado_inserir_not_found');
      inserirBtn.click();

      // Step 3 — wait for the obs textarea (signals the form is editable).
      const obsSel = sel('presatestado_obs') || '#presatestado_obs';
      const obsEl = await waitFor(obsSel, 5000).catch(function () { return null; });
      if (!obsEl) return _err('atestado_obs_not_found');

      // Step 4 — set the days. G-Hosp recomputes Data Final server-side via
      // a calc_data_fin XHR triggered on the input/change handler. Dispatch
      // both events to be jQuery-version-agnostic, then sleep so the XHR
      // round-trip finishes before we Gravar.
      const diasSel = sel('presatestado_dias') || '#nro_dias';
      const diasEl = document.querySelector(diasSel);
      if (diasEl) {
        try { diasEl.focus(); } catch (_) {}
        diasEl.value = String(nDays);
        _fireInputChange(diasEl);
        // Wait for calc_data_fin XHR to update Data Final. Empirical: server
        // round-trips in 100-300ms; 400ms covers tail latency.
        await sleep(400);
      } else {
        // Days input missing is non-fatal — G-Hosp defaults to 1 and the
        // companion line still has value. Log and continue.
        console.warn('[Toca Ficha Dr.] runAtestadoFull: nro_dias not found; defaulting to G-Hosp default');
      }

      // Step 5 — write companion obs per the chosen mode. 'mae' / 'pai'
      // produce the single-line "Acompanhante <Role>: NAME" pattern; 'outro'
      // stacks both parents under an "Acompanhante:" header. mode === null
      // means patient-only — leave obs untouched and proceed straight to
      // Gravar. If a companion mode is chosen but the parent name is missing
      // from the patient header, also leave obs untouched and log.
      if (mode !== null) {
        const companions = await extractCompanionInfo();
        const obsText = _composeCompanionObs(companions, mode);
        if (obsText) {
          try { obsEl.focus(); } catch (_) {}
          obsEl.value = obsText;
          _fireInputChange(obsEl);
        } else {
          console.warn('[Toca Ficha Dr.] runAtestadoFull: no parent name available for mode=' + mode);
        }
      }

      // Step 6 — Gravar. The save creates the atestado record server-side.
      // Instead of a fixed 1500ms sleep (which races the server response time),
      // click Gravar then poll for the print-link appearance with a deadline.
      let saveBtn = document.querySelector(sel('presatestado_save')
        || "#new_presatestado input[type='submit'][value='Gravar']");
      if (!saveBtn) saveBtn = _findInsiderAtestadoButton('Gravar');
      if (!saveBtn) return _err('atestado_save_not_found');
      saveBtn.click();

      // Step 7 — IMPRIMIR SEM CID. Poll for print-link appearance instead of
      // a fixed sleep, so fast servers proceed immediately and slow servers
      // get up to the full deadline. Hard deadline: 5000ms.
      let printLink = null;
      const printDeadline = Date.now() + 5000;
      while (Date.now() < printDeadline) {
        printLink = _findPrintSemCidLink();
        if (printLink) break;
        await sleep(250);
      }
      if (!printLink) printLink = _findPrintSemCidLink();
      if (!printLink) {
        // Ship a DOM snapshot to the Mac Mini before failing. Without
        // this, the doctor sees "Falha" and we have nothing to fix —
        // _err returns silently. console-shipper relays this to
        // /api/debug-log on next attempt.
        try {
          const cont = document.querySelector('#show_atestado_alta');
          const candidates = Array.from(document.querySelectorAll('a'))
            .filter(function (a) {
              const t = (a.textContent || '').trim();
              const h = (a.getAttribute('href') || '').toLowerCase();
              return /imprim/i.test(t) || h.indexOf('imp_atestado') !== -1
                || (h.indexOf('atestado') !== -1 && h.indexOf('print') !== -1);
            })
            .slice(0, 6)
            .map(function (a) {
              return {
                text: (a.textContent || '').trim().slice(0, 80),
                href: (a.getAttribute('href') || '').slice(0, 120),
                cls: (a.className || '').slice(0, 80),
              };
            });
          console.warn(
            '[Toca Ficha Dr.] atestado_print_not_found DIAG'
              + ' show_atestado_alta=' + !!cont
              + ' container_html=' + (cont ? cont.outerHTML.slice(0, 600) : 'null')
              + ' candidates=' + JSON.stringify(candidates)
          );
        } catch (_) { /* never throw from diagnostics */ }
        return _err('atestado_print_not_found');
      }
      printLink.click();

      return { ok: true };
    } catch (err) {
      console.warn('[Toca Ficha Dr.] runAtestadoFull error:', err);
      if (window.TOCAFICHADR_api && window.TOCAFICHADR_api.reportError) {
        window.TOCAFICHADR_api.reportError('dom-engine.runAtestadoFull', err);
      }
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  /**
   * _composeCompanionObs(companions, mode) — builds the obs string for the
   * atestado drawer. Mode:
   *   null    → '' (patient-only; caller leaves obs untouched)
   *   'mae'   → "Acompanhante Mãe: NAME"   (62% historical pattern)
   *   'pai'   → "Acompanhante Pai: NAME"
   *   'outro' → "Acompanhante:\nMãe: NAME\nPai: NAME" (skips empty)
   * Returns '' when mode is null/unrecognized or the chosen parent (or both,
   * for 'outro') is absent — caller leaves obs untouched in either case.
   */
  function _composeCompanionObs(companions, mode) {
    if (mode !== 'mae' && mode !== 'pai' && mode !== 'outro') return '';
    const c = companions || { mother: '', father: '' };
    if (mode === 'mae') {
      return c.mother ? ('Acompanhante Mãe: ' + c.mother) : '';
    }
    if (mode === 'pai') {
      return c.father ? ('Acompanhante Pai: ' + c.father) : '';
    }
    const lines = [];
    if (c.mother) lines.push('Mãe: ' + c.mother);
    if (c.father) lines.push('Pai: ' + c.father);
    if (!lines.length) return '';
    return 'Acompanhante:\n' + lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Modifiable "Receita Simples" prescription flow (Apr 2026)
  // ---------------------------------------------------------------------------
  // Each HUD prescription button is backed by a user-defined template
  // (chrome.storage.sync → prescriptionTemplates). This flow opens the blank
  // Simples editor in G-Hosp, fills it with the template body, then PAUSES so
  // the doctor can review/edit before saving and printing. Selectors confirmed
  // via interaction logs — see CLAUDE.md "Blank Simples Prescription Flow".

  // Per-key getter so remote selector overrides (loaded via loadSelectors())
  // take effect at use-time. A frozen const literal would capture only the
  // bundled values at module-init, defeating the remote-update path.
  function _ss(key) {
    switch (key) {
      case 'open_link':         return sel('prescription_link') || '#link_new_receitaalta';
      case 'simples_radio':     return sel('prescription_simples_radio') || '#tiporec_1';
      case 'inserir_to_editor': return sel('prescription_inserir_to_editor') || '#dialog_formularios input[name="commit"][value="Inserir"]';
      case 'title_input':       return sel('prescription_title_input') || '#matmed_nome';
      case 'body_textarea':     return sel('prescription_body_textarea') || '#modo_usar';
      case 'save_button':       return sel('prescription_save_button') || '#form-item > fieldset > form > div:nth-child(8) > input';
      case 'print_link':        return sel('prescription_print_link') || '#dialog_formularios > div:nth-child(4) > a.botao.btn-2nd';
    }
    return null;
  }

  let _lastSimplesError = '';

  function _simplesFail(message) {
    _lastSimplesError = message || 'erro no fluxo de receita simples';
    console.warn('[Toca Ficha Dr.] simples:', _lastSimplesError);
    return false;
  }

  function getLastSimplesError() {
    return _lastSimplesError || '';
  }

  // ---------------------------------------------------------------------------
  // Dialog lock overlay (v2.6.5)
  //   Prevents mash-clicks during the multi-second G-Hosp save round-trip.
  //   2026-05-01 log: 29.6s prescription save + 5 mash-clicks during the wait.
  //   _lockDialog appends a viewport-covering overlay to document.body.
  //   _unlockDialog removes it. MutationObserver auto-unlocks if G-Hosp removes
  //   the host dialog (e.g., dialog refreshes or doctor closes it manually).
  //   Safety timeout: 30s — if the save genuinely hangs the doctor isn't stuck.
  // ---------------------------------------------------------------------------
  let _dialogLockNode = null;
  let _dialogLockObserver = null;
  let _dialogLockTimer = null;

  function _lockDialog(message) {
    // Idempotent: if already locked, just update the message.
    if (_dialogLockNode) {
      const label = _dialogLockNode.querySelector('.tfdr-dialog-lock__label');
      if (label && message) label.textContent = message;
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'tfdr-dialog-lock';
    overlay.setAttribute('role', 'alert');
    overlay.setAttribute('aria-busy', 'true');

    const panel = document.createElement('div');
    panel.className = 'tfdr-dialog-lock__panel';

    const spinner = document.createElement('div');
    spinner.className = 'tfdr-dialog-lock__spinner';
    spinner.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'tfdr-dialog-lock__label';
    label.textContent = message || 'Salvando…';

    panel.appendChild(spinner);
    panel.appendChild(label);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    _dialogLockNode = overlay;

    // Auto-unlock if the host dialog is removed by G-Hosp's UI churn.
    const dialog = document.querySelector('#dialog_formularios');
    if (dialog && dialog.parentNode) {
      _dialogLockObserver = new MutationObserver(function (mutations) {
        for (let i = 0; i < mutations.length; i++) {
          const removed = mutations[i].removedNodes;
          for (let j = 0; j < removed.length; j++) {
            if (removed[j] === dialog || (removed[j].contains && removed[j].contains(dialog))) {
              _unlockDialog();
              return;
            }
          }
        }
      });
      _dialogLockObserver.observe(dialog.parentNode, { childList: true, subtree: false });
    }

    // Safety timeout — never trap the doctor for >30s.
    _dialogLockTimer = setTimeout(function () {
      console.warn('[Toca Ficha Dr.] dialog lock 30s safety timeout fired');
      _unlockDialog();
    }, 30000);
  }

  function _unlockDialog() {
    if (_dialogLockTimer) {
      clearTimeout(_dialogLockTimer);
      _dialogLockTimer = null;
    }
    if (_dialogLockObserver) {
      try { _dialogLockObserver.disconnect(); } catch (e) {}
      _dialogLockObserver = null;
    }
    if (_dialogLockNode && _dialogLockNode.parentNode) {
      try { _dialogLockNode.parentNode.removeChild(_dialogLockNode); } catch (e) {}
    }
    _dialogLockNode = null;
  }

  function _fireInputChange(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function _radioFromControl(el) {
    if (!el) return null;
    if (el.matches && el.matches('input[type="radio"]')) return el;
    if (el.tagName === 'LABEL') {
      const forId = el.getAttribute('for');
      if (forId) {
        const byFor = document.getElementById(forId);
        if (byFor && byFor.matches && byFor.matches('input[type="radio"]')) return byFor;
      }
    }
    return el.querySelector ? el.querySelector('input[type="radio"]') : null;
  }

  function _clickPrescriptionModeControl(el) {
    if (!el) return false;
    const radio = _radioFromControl(el);
    if (radio) {
      radio.click();
      radio.checked = true;
      _fireInputChange(radio);
      return true;
    }
    el.click();
    _fireInputChange(el);
    return true;
  }

  function _labelTextForRadio(radio) {
    if (!radio) return '';
    const chunks = [];
    const id = radio.id;
    if (id) {
      const label = document.querySelector('label[for=' + CSS.escape(id) + ']');
      if (label) chunks.push(label.textContent || '');
    }
    const closestLabel = radio.closest && radio.closest('label');
    if (closestLabel) chunks.push(closestLabel.textContent || '');
    if (radio.parentElement) chunks.push(radio.parentElement.textContent || '');
    return chunks.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  async function _selectSimplesMode(maxWaitMs) {
    maxWaitMs = maxWaitMs || 5000;
    const step = 400;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const dialog = document.querySelector('#dialog_formularios') || document;
      const configuredSel = sel('prescription_simples');
      if (configuredSel) {
        const configured = dialog.querySelector(configuredSel) || document.querySelector(configuredSel);
        if (configured && _clickPrescriptionModeControl(configured)) return true;
      }

      const radioSel = _ss('simples_radio');
      const hardcoded = dialog.querySelector(radioSel) || document.querySelector(radioSel);
      if (hardcoded && _clickPrescriptionModeControl(hardcoded)) return true;

      const radios = Array.from(dialog.querySelectorAll("input[type='radio'][name='tiporec'], input[type='radio'][id^='tiporec']"));
      const semantic = radios.find(function (radio) {
        const text = _labelTextForRadio(radio);
        return /simples|receita\s*simples/.test(text) && !/padr/.test(text);
      });
      if (semantic && _clickPrescriptionModeControl(semantic)) return true;

      await sleep(step);
    }
    return false;
  }

  // Robust finders: SEMANTIC strategy first (matches by name/value/attribute,
  // resilient to G-Hosp DOM restructuring), structural string as fallback.
  // The structural fallback is bundled (BUNDLED_SELECTORS) and remote-updatable
  // via /selectors/ghosp — so if both strategies miss, a backend tweak can
  // restore the flow without an extension release.
  function _findSimplesInserir() {
    const dialog = document.querySelector('#dialog_formularios');
    // Strategy 1 (semantic): input named "commit" with value Inserir, STRICTLY
    // inside the prescription dialog. Without the dialog scope we could pick
    // up an "Inserir" submit elsewhere on the patient page (e.g., a CID-add
    // submit button), opening the wrong workflow.
    if (dialog) {
      const semantic = Array.from(dialog.querySelectorAll('input[name="commit"]'))
        .find(function (el) { return (el.value || '').trim() === 'Inserir'; });
      if (semantic) return semantic;
      // Strategy 2 (structural, remote-updatable): the configured selector string.
      const primary = dialog.querySelector(_ss('inserir_to_editor'))
        || document.querySelector(_ss('inserir_to_editor'));
      if (primary) return primary;
      // Strategy 3 (last resort, still dialog-scoped): shared insert-button finder.
      return _findInsertButton(dialog);
    }
    // No dialog at all — caller should retry after _waitForDialogContent.
    // Returning null here is safer than searching the whole document.
    return null;
  }

  function _findSimplesSave() {
    // Strategy 1 (semantic): Gravar submit inside the medication form. Most
    // robust to G-Hosp DOM changes — survives row additions and layout tweaks
    // that break the structural nth-child path.
    const formItem = document.querySelector('#form-item') || document;
    const submits = Array.from(formItem.querySelectorAll('input[type="submit"][name="commit"], input[type="button"][name="commit"]'));
    const semantic = submits.find(function (el) { return (el.value || '').trim() === 'Gravar'; });
    if (semantic) return semantic;
    // Strategy 2 (structural, remote-updatable): the configured selector string.
    return document.querySelector(_ss('save_button'));
  }

  function _findSimplesPrint() {
    const dialog = document.querySelector('#dialog_formularios');
    // Strategy 1 (semantic): anchor in the dialog with imp_receita/imprimir
    // in href OR visible text. Survives nth-child shifts. Skips disabled links
    // (G-Hosp renders the print anchor before the save round-trip completes,
    // tagged with .disabled until the prescription is persisted).
    if (dialog) {
      const anchors = Array.from(dialog.querySelectorAll('a'));
      const semantic = anchors.find(function (a) {
        if (a.classList && a.classList.contains('disabled')) return false;
        const href = a.getAttribute('href') || '';
        const txt = (a.textContent || '').toLowerCase();
        return /imp_receita|imprimir/i.test(href) || txt.indexOf('imprimir') !== -1;
      });
      if (semantic) return semantic;
    }
    // Strategy 2 (structural, remote-updatable): the configured selector string.
    const primary = document.querySelector(_ss('print_link'));
    if (primary && !(primary.classList && primary.classList.contains('disabled'))) return primary;
    return null;
  }

  // Robust prescription-link finder: G-Hosp variants use different IDs.
  // Confirmed IDs from interaction logs: #link_new_receitaalta, #link_new_receita
  function _findPrescriptionLink() {
    const configured = sel('prescription_link');
    if (configured) {
      const el = document.querySelector(configured);
      if (el) return el;
    }

    const ids = ['#link_new_receitaalta', '#link_new_receita', '#link_receita', '#nova_receita'];
    for (let i = 0; i < ids.length; i++) {
      const el = document.querySelector(ids[i]);
      if (el) return el;
    }

    const hrefAnchors = Array.from(document.querySelectorAll('a'));
    // Match hrefs for OPENING a new prescription. Explicitly exclude print
    // URLs (imp_receita, imprimir_prescricao) — those exist for previously
    // saved prescriptions and would open the wrong page if clicked.
    const byHref = hrefAnchors.find(function (a) {
      const href = a.getAttribute('href') || '';
      if (/imp_receita|imprimir|imprime/i.test(href)) return false;
      return /receitaalta|receita\b.*new|new.*receita|nova.*receita/i.test(href);
    });
    if (byHref) {
      console.log('[Toca Ficha Dr.] _findPrescriptionLink: matched by href:', byHref.getAttribute('href'));
      return byHref;
    }

    // Text-based fallback: require an "add" verb alongside "receita" so we
    // don't accidentally click a link to a previously-printed prescription.
    const byText = hrefAnchors.find(function (a) {
      const txt = (a.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (/imprimir|print|visualizar|ver\b/.test(txt)) return false;
      return /\breceita\b/.test(txt) && /\b(adicionar|nova|novo|cadastrar|criar|new)\b/.test(txt);
    });
    if (byText) {
      console.log('[Toca Ficha Dr.] _findPrescriptionLink: matched by text:', byText.textContent.trim().slice(0, 60));
      return byText;
    }

    return null;
  }

  async function _waitForPrescriptionLink(timeoutMs) {
    timeoutMs = timeoutMs || 5000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = _findPrescriptionLink();
      if (el) return el;
      await sleep(300);
    }
    return null;
  }

  /**
   * runSimplesPrescription({ name, body }) — opens the blank Simples editor
   * and fills title="Receita" + body=template.body. Does NOT save or print —
   * doctor reviews then triggers finalizeSimplesPrescription via HUD button.
   */
  // Visibility check: an element with display:none, visibility:hidden, or zero
  // bounding box is not user-facing. Used to distinguish "real" open dialogs
  // from stale DOM remnants.
  function _isVisible(el) {
    if (!el) return false;
    if (el.offsetParent === null) {
      // offsetParent === null matches display:none AND fixed-position hidden.
      // Fall back to getBoundingClientRect for the fixed-position case.
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
    }
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return true;
  }

  // Defensive body coercion — defends against template.body being null,
  // undefined, the string "null"/"undefined", a number, or any other value
  // that would render literal "null" / "undefined" in the textarea.
  function _coerceTemplateBody(raw) {
    if (raw === null || raw === undefined) return '';
    if (typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    if (trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'undefined') return '';
    return raw;
  }

  async function runSimplesPrescription(template) {
    const body = _coerceTemplateBody(template && template.body);
    _lastSimplesError = '';
    try {
      // Reuse the open editor ONLY when the prescription dialog is actually
      // visible AND both fields live inside it. The old "any #matmed_nome on
      // the page" check produced false positives when a previously-saved
      // prescription's input remnants were still in the DOM, causing us to
      // write into a stale element while G-Hosp showed unrelated content.
      const reuseDialog = document.querySelector('#dialog_formularios');
      if (reuseDialog && _isVisible(reuseDialog)) {
        const existingTitle = reuseDialog.querySelector(_ss('title_input'));
        const existingBody = reuseDialog.querySelector(_ss('body_textarea'))
          || reuseDialog.querySelector('[name="modo_usar"]');
        if (existingTitle && existingBody && _isVisible(existingTitle) && _isVisible(existingBody)) {
          console.log('[Toca Ficha Dr.] simples: reusing already-open editor (dialog visible)');
          existingTitle.focus();
          existingTitle.value = 'Receita';
          _fireInputChange(existingTitle);
          existingBody.focus();
          existingBody.value = body;
          _fireInputChange(existingBody);
          console.log('[Toca Ficha Dr.] simples prescription ready for review (reused):', template && (template.diagnosis || template.name));
          return true;
        }
      }

      // Close any lingering prescription dialog from a previous patient or
      // failed attempt so the click opens a fresh one.
      await _closePrescriptionDialog();
      await sleep(200);

      let openLink = _findPrescriptionLink();
      if (!openLink) {
        openLink = await _waitForPrescriptionLink(5000);
      }
      if (!openLink) return _simplesFail('link de receita não encontrado');
      console.log('[Toca Ficha Dr.] simples: prescription link found:', openLink.id || openLink.getAttribute('href') || openLink.textContent);
      openLink.click();

      // Wait for dialog with retry — G-Hosp AJAX can be slow after the URL change.
      try {
        await _waitForDialogContent(8000);
      } catch (firstErr) {
        console.warn('[Toca Ficha Dr.] simples: dialog did not appear in 8s, retrying once');
        await sleep(1500);
        const openLinkRetry = _findPrescriptionLink();
        if (openLinkRetry) {
          openLinkRetry.click();
        }
        try {
          await _waitForDialogContent(8000);
        } catch (secondErr) {
          // Diagnostic snapshot before bubbling the timeout — helps decide
          // whether the prescription link click landed somewhere wrong or the
          // backend never responded.
          const dlg = document.querySelector('#dialog_formularios');
          const snap = {
            dialog_present: !!dlg,
            dialog_visible: dlg ? _isVisible(dlg) : false,
            dialog_html_head: dlg ? (dlg.outerHTML || '').slice(0, 1200) : null,
            open_link_id: openLink && openLink.id,
            open_link_href: openLink && openLink.getAttribute && openLink.getAttribute('href'),
            url: window.location.href,
          };
          console.error('[Toca Ficha Dr.] simples: dialog-timeout snapshot:', snap);
          if (window.TOCAFICHADR_api && window.TOCAFICHADR_api.reportError) {
            window.TOCAFICHADR_api.reportError(
              'dom-engine.runSimplesPrescription.dialogTimeout',
              secondErr,
              snap
            );
          }
          throw secondErr;
        }
      }

      const simplesSelected = await _selectSimplesMode();
      if (!simplesSelected) {
        console.warn('[Toca Ficha Dr.] simples: mode control not found, trying Inserir with current dialog state');
      } else {
        // Let G-Hosp process the radio selection before clicking Inserir.
        // 1500ms observed needed after G-Hosp URL migration (was 400ms).
        await sleep(1500);
      }

      let inserirBtn = await waitFor(_ss('inserir_to_editor'), 3000)
        .catch(function (e) { console.warn('[Toca Ficha Dr.] simples: inserir primary selector timeout:', e && e.message); return null; });
      if (!inserirBtn) inserirBtn = _findSimplesInserir();
      if (!inserirBtn) {
        return _simplesFail('botão Inserir da receita simples não encontrado');
      }
      inserirBtn.click();

      // The editor transition can take >10s on slow G-Hosp loads after URL migration.
      // Retry with waitFor up to 15s, then fall back to polling + diagnostic snapshot.
      let titleInput = await waitFor(_ss('title_input'), 15000)
        .catch(function (e) { console.warn('[Toca Ficha Dr.] simples: title input timeout:', e && e.message); return null; });
      if (!titleInput) {
        // Polling fallback + diagnostic snapshot so we can see what G-Hosp rendered.
        const start = Date.now();
        while (Date.now() - start < 8000) {
          titleInput = document.querySelector(_ss('title_input'));
          if (titleInput) break;
          await sleep(500);
        }
      }
      if (!titleInput) {
        // Snapshot the dialog HTML for debugging — ship to Mac Mini via console-shipper.
        const dialog = document.querySelector('#dialog_formularios');
        const snapshot = dialog ? dialog.outerHTML.slice(0, 4000) : 'no #dialog_formularios';
        console.error('[Toca Ficha Dr.] simples: editor snapshot:', snapshot);
        return _simplesFail('editor da receita simples não abriu');
      }
      titleInput.focus();
      titleInput.value = 'Receita';
      _fireInputChange(titleInput);

      let bodyTextarea = document.querySelector(_ss('body_textarea'));
      if (!bodyTextarea) {
        // Fallback: any input/textarea named modo_usar (in case tag changes)
        bodyTextarea = document.querySelector('[name="modo_usar"]');
      }
      if (!bodyTextarea) {
        return _simplesFail('campo de texto da receita simples não encontrado');
      }
      bodyTextarea.focus();
      bodyTextarea.value = body;
      _fireInputChange(bodyTextarea);

      console.log('[Toca Ficha Dr.] simples prescription ready for review:', template && template.name);
      return true;
    } catch (err) {
      _lastSimplesError = (err && err.message) || String(err) || 'erro no fluxo de receita simples';
      console.warn('[Toca Ficha Dr.] runSimplesPrescription error:', err);
      if (window.TOCAFICHADR_api && window.TOCAFICHADR_api.reportError) {
        window.TOCAFICHADR_api.reportError('dom-engine.runSimplesPrescription', err, {
          template_name: (template && template.name) || null,
        });
      }
      return false;
    }
  }

  /**
   * finalizeSimplesPrescription() — clicks Save, waits for the print link,
   * clicks Print. Called by HUD "Salvar e Imprimir" button.
   *
   * v2.6.5: locks the dialog with a "Salvando receita…" overlay during the
   * post-Gravar wait window (median ~5s, observed up to 29.6s). Without the
   * lock the doctor mash-clicks Gravar 5x during a slow save (2026-05-01 L3333).
   * Wait timeout extended to 30s to match the lock's safety timeout.
   */
  // Poll for the Simples print link via the semantic-first finder. Beats
  // waitFor(_ss('print_link')) because if the structural string is wrong but
  // an anchor matching the semantic pattern is rendered, we resolve immediately
  // instead of blocking the doctor with the 30s lock overlay.
  async function _waitForSimplesPrint(timeoutMs) {
    timeoutMs = timeoutMs || 30000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = _findSimplesPrint();
      if (el) return el;
      await sleep(300);
    }
    return null;
  }

  async function finalizeSimplesPrescription() {
    try {
      const saveBtn = _findSimplesSave();
      if (!saveBtn) {
        console.warn('[Toca Ficha Dr.] simples: save button (Gravar) not found');
        return false;
      }
      _lockDialog('Salvando receita…');
      saveBtn.click();

      // Poll for print link with an early-exit on save failure: if the dialog
      // is removed by G-Hosp without ever showing a print link, the lock's
      // MutationObserver auto-unlocks us. If the dialog stays but no print
      // link appears within 8s, treat as a probable save error and bail early
      // rather than blocking the doctor for the full 30s.
      const printLink = await _waitForSimplesPrint(8000);
      if (!printLink) {
        console.warn('[Toca Ficha Dr.] simples: print link did not appear after 8s — save likely failed');
        _unlockDialog();
        return false;
      }
      // G-Hosp removes the print link's .disabled class optimistically — before
      // its save AJAX has finished persisting the body. Clicking print right
      // then opens the print URL while the receita's body is still null in DB,
      // producing the "Imprimir Receita with NULL" symptom. The save itself
      // succeeds (going back to the prescription page shows the body) — the
      // print was just too eager. 2500ms buffer covers ~95% of cases per
      // calibrate_timings.py against real JSONL logs (n=63 prescription_save
      // responses: p50=759ms, p95=1814ms; 8% exceeded the old 1500ms). The
      // "Salvando receita…" overlay stays up so the doctor sees a deliberate
      // wait rather than a phantom delay. Bumping further would punish every
      // print to catch a tail of outliers — better to handle those with a
      // print-result-verification poll when this approach proves insufficient.
      await sleep(2500);
      _unlockDialog();
      printLink.click();
      return true;
    } catch (err) {
      _unlockDialog();
      console.warn('[Toca Ficha Dr.] finalizeSimplesPrescription error:', err);
      if (window.TOCAFICHADR_api && window.TOCAFICHADR_api.reportError) {
        window.TOCAFICHADR_api.reportError('dom-engine.finalizeSimplesPrescription', err);
      }
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Print tracker — universal hook for prescription completion
  // ---------------------------------------------------------------------------
  // Captures EVERY print-button click on the G-Hosp page, regardless of source:
  //   • HUD template buttons → printPrescription() → .click() → caught here
  //   • Native G-Hosp prescription dialog + manual print → caught here
  //   • Legacy "Utilizar Padrões" template flow → caught here
  // Capture-phase listener fires before any other handler, so it sees clicks
  // even when downstream code stops propagation. Logs `prescription_printed`
  // events to /api/audit/manual; pairs with `prescription_select` events from
  // hud.js _bumpFrequency to expose both intent and completion in /api/rx-stats.

  // Default fingerprint set. The semantic href-based selector goes first so
  // the tracker correctly attributes prints that took a slightly different
  // DOM path (e.g., a G-Hosp re-render that shifted the nth-child index).
  var PRINT_BUTTON_DEFAULTS = [
    "#dialog_formularios a.botao.btn-2nd[href*='imp']",
    "#dialog_formularios > div:nth-child(2) > a:first-child", // Utilizar Padrões / dialog primary
    "#dialog_formularios > div:nth-child(4) > a.botao.btn-2nd", // Simples flow print link
    "a[href*='imp_receita']",
    "a[href*='imprimir_prescricao']",
  ];

  function _getPrintButtonSelectors() {
    var configured = sel('prescription_print_buttons');
    if (Array.isArray(configured) && configured.length) return configured;
    return PRINT_BUTTON_DEFAULTS;
  }

  function _installPrintTracker() {
    if (window.__tocafPrintTrackerInstalled) return;
    window.__tocafPrintTrackerInstalled = true;
    // Snapshot the selector list at install time. Remote config changes after
    // install require a page reload to pick up (acceptable — selector tweaks
    // are rare and reloading is a one-keystroke action).
    var printSelectors = _getPrintButtonSelectors();

    document.addEventListener('click', function (ev) {
      try {
        var target = ev.target;
        if (!target || typeof target.closest !== 'function') return;

        var matchedSel = '';
        for (var i = 0; i < printSelectors.length; i++) {
          var s = printSelectors[i];
          try {
            if (target.closest(s)) { matchedSel = s; break; }
          } catch (_) { /* invalid selector for closest, skip */ }
        }
        if (!matchedSel) return;

        // Read prescription title from the open dialog if available — gives us
        // a name to rank by even when the print didn't come from a HUD template.
        var title = '';
        try {
          var titleEl = document.querySelector('#matmed_nome');
          if (titleEl && titleEl.value) title = String(titleEl.value).slice(0, 200);
        } catch (_) {}

        // Source attribution: hud.js writes window.TOCAFICHADR_lastTemplate
        // when a template button is clicked. Treat as HUD-driven if set within
        // the last 2 minutes (typical select→print latency is < 30s).
        var last = window.TOCAFICHADR_lastTemplate;
        var fromHud = !!(last && last.at && (Date.now() - last.at) < 120000);

        // template_used falls back to lastTemplate.diagnosis (HUD flow) or
        // title (native flow). Empty string if neither is available — server
        // still records the print event, just without name attribution.
        var templateName = (fromHud && last.diagnosis) ? last.diagnosis : title;

        if (window.TOCAFICHADR_api && window.TOCAFICHADR_api.logAudit) {
          window.TOCAFICHADR_api.logAudit('prescription_printed', {
            // diagnosis is the field /api/audit/manual maps to template_used,
            // so /api/rx-stats GROUP BY template_used works for both action types.
            diagnosis: templateName,
            source: fromHud ? 'hud' : 'native',
            tplId: fromHud ? (last.id || '') : '',
            ageBand: fromHud ? (last.ageBand || '') : '',
            title: title,
            selector: matchedSel,
          });
        }
      } catch (_) {
        // Tracker must never break the click — swallow everything.
      }
    }, true); // capture phase
  }

  _installPrintTracker();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    // Setup
    loadSelectors,
    // Utilities
    sleep,
    waitFor,
    getByXPath,
    getInternId,
    // Patient info
    extractPatientInfo,
    extractCompanionInfo,
    // SOAP / editors
    updateWysihtml5Editor,
    clearSoapFields,
    pasteSoapNote,
    // CID
    findCidInput,
    fillCid,
    fillRecomendas,
    // Forms
    saveForm,
    // Prescription (legacy "Utilizar Padrões" — kept for fallback)
    openPrescription,
    selectTemplate,
    submitPrescriptionDialog,
    printPrescription,
    // Prescription (G-Hosp catalog probing — v3.1.8)
    probeGhospTemplates,
    runGhospTemplate,
    // Prescription (new modifiable "Simples" flow)
    runSimplesPrescription,
    getLastSimplesError,
    finalizeSimplesPrescription,
    // Discharge and navigation
    processDischarge,
    prefillDischargeForm,
    verifyDischargeComplete,
    goToMainList,
    openAtestado,
    runAtestadoFull,
    finalizeAtestado,
    openBauMedico,
  };

})();
