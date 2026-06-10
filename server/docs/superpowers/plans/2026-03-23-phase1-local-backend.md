# Phase 1: Chrome Extension + Local Flask Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a thin Chrome extension (HUD + DOM automation + audio capture) that talks to the existing Pediatrics/ Flask backend for AI processing, replacing the broken service-worker-based approach.

**Architecture:** Chrome MV3 extension injects content scripts into G-Hosp pages. Content scripts render a floating HUD, capture audio via MediaRecorder, and send blobs to the local Flask server (localhost:5050) for Whisper/GPT processing. Flask returns SOAP notes and CID suggestions; the extension fills the EMR forms. The service worker is minimal (~30 lines, CORS proxy only).

**Tech Stack:** Vanilla JS (Chrome Extension MV3), Python 3.11 (Flask), OpenAI API (Whisper + GPT-4o-mini), existing Pediatrics/ modules

**Spec:** `docs/superpowers/specs/2026-03-23-tocafichadr-automation-platform-design.md` (Sections 4.1-4.6)

---

## File Structure

### Chrome Extension (pedbot-extension/)

| File | Responsibility | Status |
|------|---------------|--------|
| `manifest.json` | MV3 config, permissions, content script registration | Modify |
| `content/api-client.js` | Fetch wrapper for Flask endpoints, health check, connection status | Create |
| `content/audio-capture.js` | MediaRecorder to blob to POST FormData to Flask | Create |
| `content/dom-engine.js` | All DOM manipulation (SOAP, CID, prescription, discharge, navigation) | Create (rewrite of workflow.js) |
| `content/hud.js` | Floating panel UI, recording state, CID display, template grid, finalization | Create (rewrite) |
| `content/content.js` | Entry point, page observer, auto-setup | Modify |
| `background/service-worker.js` | Minimal — extension lifecycle defaults only | Create (rewrite) |
| `popup/popup.html` | Settings UI with API URL field + connection test | Modify |
| `popup/popup.js` | Settings load/save + connection test | Modify |
| `styles/hud.css` | HUD styling (reuse existing) | Keep |
| `content/selectors.json` | Bundled default DOM selector config (fallback) | Create |

### Flask Backend (Pediatrics/emr_automation/)

| File | Responsibility | Status |
|------|---------------|--------|
| `dashboard/routes.py` | Add /api/transcribe, /api/suggest-cid, /api/format-soap, /api/selectors endpoints | Modify |
| `dashboard/app.py` | Add flask-cors setup | Modify |
| `selector_config.py` | Load and serve DOM selector JSON configs | Create |
| `extension_api.py` | Whisper transcription + GPT SOAP/CID logic for extension endpoints | Create |
| `tests/test_extension_api.py` | Tests for new extension API endpoints | Create |
| `tests/test_selector_config.py` | Tests for selector config loading | Create |
| `tests/test_extension_routes.py` | Tests for new Flask routes | Create |
| `data/selectors/ghosp.json` | G-Hosp DOM selector config | Create |

### Files Removed (from pedbot-extension/)

| File | Reason |
|------|--------|
| `content/workflow.js` | Replaced by dom-engine.js |

---

## Task 1: Flask Backend — Extension API Module

**Files:**
- Create: `Pediatrics/emr_automation/extension_api.py`
- Create: `Pediatrics/tests/test_extension_api.py`

This module wraps Whisper + GPT calls for the extension endpoints, independent of the Playwright-based EMRAutomation class.

- [ ] **Step 1: Write failing test for transcribe_audio()**

Create `Pediatrics/tests/test_extension_api.py` with tests for `transcribe_audio`, `suggest_cid`, and `format_soap`. Each function should be tested with mocked OpenAI responses:

- `test_transcribe_returns_soap_and_cid` — mock Whisper + GPT, assert `ok=True`, `soap` present, `cid_code` matches
- `test_transcribe_returns_raw_transcript_on_gpt_failure` — mock Whisper success + GPT exception, assert raw transcript returned
- `test_suggest_cid_returns_code` — mock GPT, assert `cid_code` and `confidence` present
- `test_format_soap_returns_formatted` — mock GPT, assert `formatted_soap` key present

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/admin/Dev/Pediatrics
source "venv 2/bin/activate"
python -m pytest tests/test_extension_api.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'emr_automation.extension_api'`

- [ ] **Step 3: Implement extension_api.py**

Create `Pediatrics/emr_automation/extension_api.py` with three functions:

**`transcribe_audio(audio_bytes, mime_type, chief_complaint, api_key, custom_instructions) -> dict`**
- Creates OpenAI client with `api_key`
- Step 1: Sends audio to Whisper (`whisper-1`, language `pt`, response_format `text`)
- Step 2: Sends transcript to GPT-4o-mini with SOAP system prompt (temperature 0.3, max_tokens 800, JSON response format)
- Returns: `{ok, transcript, soap, cid_code, cid_name, confidence}`
- Fallback: if GPT fails, returns raw transcript as `soap` with `cid_code=None`

**`suggest_cid(soap_text, chief_complaint, api_key) -> dict`**
- Sends SOAP text to GPT-4o-mini with CID system prompt
- Returns: `{cid_code, cid_name, confidence}`

**`format_soap(raw_text, chief_complaint, api_key, custom_instructions) -> dict`**
- Sends raw text to GPT-4o-mini with formatting prompt
- Returns: `{formatted_soap}`

System prompts should be in Portuguese, requesting JSON-only responses.

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest tests/test_extension_api.py -v
```
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/Dev/Pediatrics
git add emr_automation/extension_api.py tests/test_extension_api.py
git commit -m "feat: add extension_api module for Chrome extension endpoints"
```

---

## Task 2: Flask Backend — Selector Config Module

**Files:**
- Create: `Pediatrics/emr_automation/selector_config.py`
- Create: `Pediatrics/data/selectors/ghosp.json`
- Create: `Pediatrics/tests/test_selector_config.py`

- [ ] **Step 1: Create the G-Hosp selector config JSON**

Create `Pediatrics/data/selectors/ghosp.json` with all DOM selectors extracted from the current workflow.js. Structure:

```json
{
  "emr": "ghosp",
  "version": "2024",
  "selectors": {
    "soap_field_prefix": "#prconsulta_prananmeneses_attributes_",
    "soap_field_suffix": "_descricao",
    "soap_editor_count": 6,
    "soap_editors": ".wysihtml5-sandbox",
    "cid_input": ["...7 fallback selectors..."],
    "cid_hidden": ["input[type='hidden'][id*='cid']", "input[type='hidden'][name*='cid']"],
    "save_button": "input[type='submit'][value='Salvar']",
    "insert_button": "input[type='submit'][value='Inserir']",
    "form_new": "form[id^='new_prconsulta']",
    "form_edit": "form[id^='edit_prconsulta']",
    "prescription_link": "#link_new_receitaalta",
    "prescription_type_radio": "#tiporec_0",
    "template_radio": "input[type='radio'][name='padraorec']",
    "template_container": "#padroes",
    "dialog": "#dialog_formularios",
    "print_link": "a[href*='imp_receita']",
    "discharge_link_template": "a[href*='/altas/{internId}/edit']",
    "discharge_referral_select": ["select[id*='encaminhamento']", "select[id*='destino']"],
    "main_list_url": "/amb/interns",
    "patient_name_xpath": "//*[@id='paciente']/div[2]/div/div[2]/p[1]",
    "chief_complaint_xpath": "//*[@id='div_amb_triagem']/div[2]/div/p",
    "weight_patterns": ["(\\d+[.,]\\d*)\\s*kg", "Peso\\s*:?\\s*(\\d+[.,]\\d*)", "peso\\s+(\\d+)"]
  }
}
```

- [ ] **Step 2: Write failing test for selector_config**

Tests: `test_load_ghosp_selectors`, `test_load_unknown_emr_returns_none`, `test_get_selector_returns_value`, `test_get_selector_returns_default_for_missing_key`

- [ ] **Step 3: Run test to verify it fails**

```bash
python -m pytest tests/test_selector_config.py -v
```
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 4: Implement selector_config.py**

Module with:
- `SELECTORS_DIR` pointing to `data/selectors/`
- `_cache` dict for in-memory caching
- `load_selectors(emr_name) -> Optional[dict]` — loads JSON from file, caches
- `get_selector(emr_name, key, default) -> Any` — returns specific selector value
- `clear_cache()` — for testing

- [ ] **Step 5: Run tests to verify they pass**

```bash
python -m pytest tests/test_selector_config.py -v
```
Expected: All 4 tests PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/admin/Dev/Pediatrics
git add emr_automation/selector_config.py data/selectors/ghosp.json tests/test_selector_config.py
git commit -m "feat: add selector config module with G-Hosp default config"
```

---

## Task 3: Flask Backend — New Routes + CORS

**Files:**
- Modify: `Pediatrics/emr_automation/dashboard/routes.py`
- Modify: `Pediatrics/emr_automation/dashboard/app.py`
- Create: `Pediatrics/tests/test_extension_routes.py`

- [ ] **Step 1: Install flask-cors**

```bash
cd /Users/admin/Dev/Pediatrics
source "venv 2/bin/activate"
pip install flask-cors
pip freeze | grep -i cors >> requirements.txt
```

- [ ] **Step 2: Write failing tests for new routes**

Create `Pediatrics/tests/test_extension_routes.py` with Flask test client fixture. Tests:
- `test_health_returns_ok` — GET /api/health returns 200 + `{status: ok}`
- `test_selectors_returns_ghosp_config` — GET /api/selectors?emr=ghosp returns JSON with `emr` and `selectors` keys
- `test_selectors_returns_404_for_unknown_emr` — GET /api/selectors?emr=unknown returns 404
- `test_transcribe_returns_soap` — POST /api/transcribe with mocked `transcribe_audio` returns SOAP + CID
- `test_transcribe_rejects_missing_audio` — POST /api/transcribe with no file returns 400
- `test_suggest_cid_returns_code` — POST /api/suggest-cid with mocked `suggest_cid`
- `test_format_soap_returns_formatted` — POST /api/format-soap with mocked `format_soap`

- [ ] **Step 3: Run tests to verify they fail**

```bash
python -m pytest tests/test_extension_routes.py -v
```
Expected: FAIL — routes not defined

- [ ] **Step 4: Add CORS to app.py**

In `Pediatrics/emr_automation/dashboard/app.py`, add after Flask app creation:

```python
from flask_cors import CORS
CORS(app, resources={r"/api/*": {"origins": "*"}})
```

- [ ] **Step 5: Add new routes to routes.py**

Add to `Pediatrics/emr_automation/dashboard/routes.py`:

- `GET /api/selectors` — calls `load_selectors(emr)`, returns JSON or 404
- `POST /api/transcribe` — reads `request.files["audio"]`, resolves API key from config/env, calls `transcribe_audio()`, returns JSON
- `POST /api/suggest-cid` — reads JSON body, calls `suggest_cid()`, returns JSON
- `POST /api/format-soap` — reads JSON body, calls `format_soap()`, returns JSON

Helper: `_get_api_key()` — resolves OpenAI key from config.ini or `OPENAI_API_KEY` env var.

The `/api/health` endpoint already exists in routes.py — verify it returns `{"status": "ok"}`.

- [ ] **Step 6: Run tests to verify they pass**

```bash
python -m pytest tests/test_extension_routes.py -v
```
Expected: All 7 tests PASS

- [ ] **Step 7: Run full test suite for regression check**

```bash
python -m pytest tests/ -v
```
Expected: All 55+ existing tests still PASS

- [ ] **Step 8: Commit**

```bash
cd /Users/admin/Dev/Pediatrics
git add emr_automation/dashboard/app.py emr_automation/dashboard/routes.py tests/test_extension_routes.py requirements.txt
git commit -m "feat: add extension API routes (transcribe, suggest-cid, format-soap, selectors)"
```

---

## Task 4: Chrome Extension — API Client

**Files:**
- Create: `pedbot-extension/content/api-client.js`

Foundation module — all other extension code depends on this.

- [ ] **Step 1: Create api-client.js**

IIFE namespaced as `window.TOCAFICHADR_api`. Exports:
- `setBaseUrl(url)` / `getBaseUrl()` — manages base URL (default: `http://localhost:5050`)
- `checkHealth() -> Promise<boolean>` — GET /api/health
- `transcribe(audioBlob, chiefComplaint, customInstructions) -> Promise<object>` — POST /api/transcribe with FormData
- `suggestCid(soapText, complaint) -> Promise<object>` — POST /api/suggest-cid with JSON
- `formatSoap(rawText, complaint, customInstructions) -> Promise<object>` — POST /api/format-soap with JSON
- `getSelectors(emr) -> Promise<object>` — GET /api/selectors?emr=X
- `getDosages(weight) -> Promise<object>` — GET /api/dosages/full?weight=X
- `logAudit(actionType, details) -> Promise<object>` — POST /api/audit/manual with JSON

Internal `request(path, options)` function handles:
- JSON Content-Type for object bodies
- No Content-Type for FormData bodies
- Error handling (throws on non-2xx)
- Loads `apiBaseUrl` from `chrome.storage.sync` on init

- [ ] **Step 2: Verify syntax by pasting into Chrome DevTools console**

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/Dev/pedbot-extension
git add content/api-client.js
git commit -m "feat: add api-client.js — fetch wrapper for Flask backend"
```

---

## Task 5: Chrome Extension — Audio Capture Module

**Files:**
- Create: `pedbot-extension/content/audio-capture.js`

- [ ] **Step 1: Create audio-capture.js**

IIFE namespaced as `window.TOCAFICHADR_audio`. Exports:
- `start(onStop: (blob, error) => void) -> Promise<void>` — requests mic, creates MediaRecorder, collects chunks every 1s
- `stop()` — stops recorder, releases mic tracks, triggers `onStop` callback with blob or error
- `isRecording() -> boolean`

MIME type detection: tries `audio/webm;codecs=opus`, `audio/webm`, `audio/mp4` in order.
Minimum blob size: 500 bytes (rejects "too short" recordings).

Key difference from old hud.js: **no base64 conversion, no service worker messaging**. The blob goes directly to `TOCAFICHADR_api.transcribe()` via FormData.

- [ ] **Step 2: Commit**

```bash
cd /Users/admin/Dev/pedbot-extension
git add content/audio-capture.js
git commit -m "feat: add audio-capture.js — MediaRecorder wrapper, no service worker"
```

---

## Task 6: Chrome Extension — DOM Engine

**Files:**
- Create: `pedbot-extension/content/dom-engine.js`
- Create: `pedbot-extension/content/selectors.json` (bundled fallback copy)

Most complex content script. Replaces workflow.js with config-driven selectors.

- [ ] **Step 1: Copy ghosp.json as bundled fallback**

```bash
cp /Users/admin/Dev/Pediatrics/data/selectors/ghosp.json /Users/admin/Dev/pedbot-extension/content/selectors.json
```

- [ ] **Step 2: Create dom-engine.js**

IIFE namespaced as `window.TOCAFICHADR_dom`. Has BUNDLED_SELECTORS constant as fallback. Exports:

**Setup:**
- `loadSelectors()` — fetches from `TOCAFICHADR_api.getSelectors("ghosp")`, falls back to BUNDLED_SELECTORS

**Utilities:**
- `sleep(ms)`, `waitFor(selector, timeoutMs=5000)` (MutationObserver), `getInternId()`

**Patient info:**
- `extractPatientInfo() -> {internId, name, weight, chiefComplaint}` — uses XPath for name/complaint, regex for weight

**SOAP fields:**
- `updateWysihtml5Editor(index, htmlText)` — targets `.wysihtml5-sandbox[index]` iframe contentDocument, dispatches input+change events, also updates hidden textarea
- `clearSoapFields()` — loops 0-5, returns count cleared
- `pasteSoapNote(text)` — converts `\n` to `<br>`, writes to editor 0

**CID:**
- `findCidInput()` — iterates 7 selector strategies, filters by computed visibility
- `fillCid(code, name)` — sets visible input, triggers jQuery autocompleteselect + native events, fills hidden inputs, fallback to parent container hidden input

**Forms:**
- `saveForm()` — clicks save button or submits form

**Prescription:**
- `openPrescription()` — clicks link, selects radio, waits for template container
- `selectTemplate(templateId)` — clicks matching radio
- `submitPrescriptionDialog()` — clicks insert button in dialog
- `printPrescription()` — clicks print link with fallback to `window.print()`

**Discharge:**
- `processDischarge(internId)` — clicks discharge link (template with internId), selects "sem encaminhamento", submits
- `goToMainList()` — navigates to `/amb/interns`
- `openAtestado()` — clicks atestado link

All selectors come from `sel()` helper which returns loaded config or bundled defaults.

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/Dev/pedbot-extension
git add content/dom-engine.js content/selectors.json
git commit -m "feat: add dom-engine.js — config-driven DOM automation, replaces workflow.js"
```

---

## Task 7: Chrome Extension — HUD Panel

**Files:**
- Create: `pedbot-extension/content/hud.js` (rewrite)

Main UI. Orchestrates audio-capture, api-client, and dom-engine.

- [ ] **Step 1: Create the new hud.js**

IIFE namespaced as `window.TOCAFICHADR_hud`. Internal state object:

```javascript
{ minimized, recording, processing, finalizing, timerInterval, timerSeconds,
  patientInfo, selectedTemplate, soapReady, connected }
```

TEMPLATES array: `[{id:"1080",label:"Gastro 1"}, {id:"1081",label:"Gastro 2"}, {id:"1083",label:"Resfr. 1"}, {id:"1082",label:"Resfr. 2"}]`

**Exports:** `createHUD()`, `refreshPatient()`

**createHUD():**
- Injects `#tocafichadr-hud` div with: header (title, connection dot, minimize), patient card, record button + timer, SOAP status, CID suggestion + search input, template grid, action buttons (clear/save/rx/atestado/discharge), finalize button
- Calls `setupDrag()`, `setupEvents()`, `checkConnection()`, `refreshPatient()`

**Key functions:**
- `checkConnection()` — calls `TOCAFICHADR_api.checkHealth()`, updates green/red dot
- `refreshPatient()` — calls `TOCAFICHADR_dom.extractPatientInfo()`, updates display
- `toggleRecording()` / `startRecording()` / `stopRecording()` — uses `TOCAFICHADR_audio`
- `onRecordingStop(blob, error)` — calls `TOCAFICHADR_api.transcribe()`, then `TOCAFICHADR_dom.pasteSoapNote()` + `showCidSuggestion()`
- `finalizePatient()` — orchestrates: saveForm -> sleep -> openPrescription -> sleep -> selectTemplate -> sleep -> submitDialog -> sleep -> printPrescription -> sleep -> processDischarge -> sleep -> goToMainList -> logAudit. Each step shows progressive status. Disables button during execution.

**Event handlers:**
- Minimize toggle, record button, CID apply, CID search (uses `TOCAFICHADR_cidSearch` if available), template selection (sets `selectedTemplate`), action buttons (clear/save/rx/atestado/discharge), finalize button
- Drag: mousedown on header, mousemove/mouseup on document

**Note on CID search:** Keep `cid.js` in manifest for local fuzzy search in the HUD dropdown. The AI-suggested CID comes from the backend; manual search uses the local list.

- [ ] **Step 2: Commit**

```bash
cd /Users/admin/Dev/pedbot-extension
git add content/hud.js
git commit -m "feat: rewrite hud.js — thin client, talks to Flask backend"
```

---

## Task 8: Chrome Extension — Service Worker, Manifest, Content Entry, Popup

**Files:**
- Modify: `pedbot-extension/manifest.json`
- Create: `pedbot-extension/background/service-worker.js` (rewrite)
- Modify: `pedbot-extension/content/content.js`
- Modify: `pedbot-extension/popup/popup.html`
- Modify: `pedbot-extension/popup/popup.js`
- Delete: `pedbot-extension/content/workflow.js`

- [ ] **Step 1: Rewrite manifest.json**

Version bump to 2.0.0. Changes:
- Remove `microphone` permission (getUserMedia works on HTTPS without it)
- Add `http://localhost:5050/*` to host_permissions
- Remove `https://api.openai.com/*` from host_permissions (backend handles API calls now)
- Content script load order: `cid.js, api-client.js, audio-capture.js, dom-engine.js, hud.js, content.js`
- Keep `cid.js` for local CID search in HUD

- [ ] **Step 2: Rewrite service-worker.js (minimal)**

Only `chrome.runtime.onInstalled` listener that sets default `apiBaseUrl`, `autoClearSoap`, `autoCid` in chrome.storage.sync. No message handlers, no AI logic, no keep-alive.

- [ ] **Step 3: Rewrite content.js**

Async IIFE that:
1. Checks `TOCAFICHADR_dom` and `TOCAFICHADR_hud` exist
2. Calls `await TOCAFICHADR_dom.loadSelectors()`
3. Calls `TOCAFICHADR_hud.createHUD()`
4. Sets up MutationObserver for SPA URL changes (refreshPatient + autoSetup on navigation, 800ms debounce)
5. `autoSetupPatientPage()` — if URL contains `intern_id=`, auto-clears SOAP if `autoClearSoap` setting is true

- [ ] **Step 4: Update popup/popup.html**

Dark theme settings panel with:
- API URL text input (default: http://localhost:5050)
- "Testar conexao" button with connection status indicator
- Auto-clear SOAP checkbox
- Auto-suggest CID checkbox
- Custom instructions textarea
- Save button with status message

- [ ] **Step 5: Update popup/popup.js**

Loads/saves: `apiBaseUrl`, `autoClearSoap`, `autoCid`, `customInstructions` from/to chrome.storage.sync.
Connection test: fetches `{baseUrl}/api/health`, shows green "Conectado" or red error.

- [ ] **Step 6: Remove old workflow.js**

```bash
cd /Users/admin/Dev/pedbot-extension
rm content/workflow.js
```

- [ ] **Step 7: Commit**

```bash
cd /Users/admin/Dev/pedbot-extension
git add manifest.json background/service-worker.js content/content.js popup/popup.html popup/popup.js
git rm content/workflow.js
git commit -m "feat: complete extension rewrite — thin client, Flask backend, config-driven selectors"
```

---

## Task 9: Integration Test — End-to-End Verification

No new files. Manual testing against live systems.

- [ ] **Step 1: Start Flask backend**

```bash
cd /Users/admin/Dev/Pediatrics
source "venv 2/bin/activate"
python -m emr_automation --dashboard
```
Verify: `curl http://localhost:5050/api/health` returns `{"status": "ok"}`

- [ ] **Step 2: Verify new API endpoints**

```bash
curl http://localhost:5050/api/health
curl http://localhost:5050/api/selectors?emr=ghosp
curl -X POST http://localhost:5050/api/transcribe -F "audio=@/dev/null"
```
Expected: health=200, selectors=JSON, transcribe=400 (empty file)

- [ ] **Step 3: Load extension in Chrome**

1. `chrome://extensions` -> Remove old Toca Ficha Dr. if loaded
2. Load unpacked -> select `pedbot-extension/`
3. Verify no errors on extension card

- [ ] **Step 4: Test extension settings**

1. Click Toca Ficha Dr. icon -> popup opens
2. API URL shows `http://localhost:5050`
3. "Testar conexao" -> shows green "Conectado"
4. Save settings

- [ ] **Step 5: Test on G-Hosp (live)**

1. Navigate to prbentogoncalves.g-hosp.com.br
2. HUD appears with green connection dot
3. Open patient chart -> name/weight/complaint extracted
4. "Limpar SOAP" -> fields clear
5. Record -> speak -> stop -> SOAP appears + CID suggestion
6. Apply CID -> CID filled in form
7. Select template -> "Finalizar" -> full workflow executes

- [ ] **Step 6: Commit any fixes**

```bash
cd /Users/admin/Dev/pedbot-extension
git add -A
git commit -m "fix: integration test adjustments"
```

---

## Dependency Graph

```
Task 1 (extension_api.py)  ──┐
                              ├── Task 3 (Flask routes) ──┐
Task 2 (selector_config.py) ─┘                           │
                                                          │
Task 4 (api-client.js) ──────────────────────────────┐    │
Task 5 (audio-capture.js) ──────────────────────────┐│    │
Task 2 output -> Task 6 (dom-engine.js) ───────────┐││    │
                                                    │││    │
                                        Task 7 (hud.js) ──┤
                                                    │      │
                                        Task 8 (manifest+) │
                                                    │      │
                                        Task 9 (integration test)
```

**Tasks 1, 2, 4, 5 can run in parallel.** Task 3 depends on 1+2. Task 6 depends on 2 (selectors.json). Tasks 7, 8 are sequential after 4-6. Task 9 is last.
