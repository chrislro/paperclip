# Toca Ficha Dr. — Progress Log

> Last updated: 2026-05-13
> Status: v3.7.0 in production. Option B config redesign shipped. 4 universal prescription templates active. Backend on Mac Mini with Cloudflare Tunnel.

---

## What Toca Ficha Dr. Is

A Chrome MV3 extension that injects a floating HUD directly into the G-Hosp EMR page
(`prbentogoncalves.g-hosp.com.br`). The doctor records the consultation by voice, and Toca Ficha Dr.:

1. Transcribes with OpenAI Whisper / gpt-4o-transcribe (diarization-aware)
2. Formats a structured SOAP note with a canonical pediatric physical exam block and standard plan footer
3. Pastes the note directly into the 6 wysihtml5 SOAP fields
4. Suggests a CID-10 code
5. Automates prescription selection, printing, discharge, and return to patient list

Result: 25-35 manual actions per patient reduced to 4-6.

---

## Repository Layout

```
pedbot-extension/          <- Chrome extension (this repo)
  manifest.json            <- MV3, v2.0.0, permissions: storage/activeTab/scripting/clipboardWrite
  content/
    cid.js                 <- 164 hardcoded pediatric CID-10 codes + fuzzy search
    api-client.js          <- window.TOCAFICHADR_api — JWT auth, fetch wrapper, auto-refresh on 401
    audio-capture.js       <- window.TOCAFICHADR_audio — MediaRecorder wrapper, blob to caller
    dom-engine.js          <- window.TOCAFICHADR_dom — all DOM automation, config-driven selectors
    hud.js                 <- window.TOCAFICHADR_hud — floating panel UI, recording state, orchestration
    content.js             <- entry point, MutationObserver SPA nav, autoSetupPatientPage()
    selectors.json         <- bundled fallback selectors (mirrors Pediatrics/data/selectors/ghosp.json)
  background/
    service-worker.js      <- minimal (onInstalled only) — no AI logic here
  popup/
    popup.html / popup.js  <- settings: local/cloud toggle, API URL, auth, customInstructions
  styles/
    hud.css                <- dark OLED theme (#0a0a0a + #10b981 green)
  store/
    description.txt        <- Chrome Web Store listing text (Portuguese)
  PRIVACY_POLICY.md        <- LGPD-compliant privacy policy (Portuguese)

Pediatrics/                <- Python backend (separate repo: ~/Dev/Pediatrics/)
  emr_automation/
    extension_api.py       <- transcribe_audio(), suggest_cid(), format_soap()
    selector_config.py     <- loads selectors from JSON file or PostgreSQL
    dashboard/
      app.py               <- Flask factory, load_dotenv, CORS, blueprint registration
      routes.py            <- /api/transcribe, /api/suggest-cid, /api/format-soap,
                              /api/selectors, /api/dosages, /api/audit, /api/health
      routes_auth.py       <- /auth/register (14-day trial), /auth/login, /auth/refresh
      routes_billing.py    <- /billing/create-checkout, /billing/webhook, /billing/subscription
    auth.py                <- JWT generation/decode, @require_auth, @optional_auth decorators
    billing.py             <- Stripe checkout, webhook handler, check_usage_limit(), log_usage()
    database.py            <- SQLAlchemy engine/session, PostgreSQL + SQLite fallback
    models.py              <- User (trial_ends_at), Subscription, UsageLog, SelectorConfig, AuditTrail
  data/
    selectors/
      ghosp.json           <- 29-key DOM selector config for G-Hosp
  Dockerfile.cloud         <- python:3.11-slim, gunicorn 120s timeout, no Playwright/Tkinter
  docker-compose.cloud.yml <- api + postgres:16-alpine services
  .env.example.cloud       <- DATABASE_URL, JWT_SECRET, OPENAI_API_KEY, STRIPE_* variables
  tests/
    test_extension_api.py  <- 35 tests, all passing (1 pre-existing unrelated failure in test_core.py)
    test_extension_routes.py
    test_selector_config.py
    test_models.py
    test_auth.py
    test_billing.py
```

---

## What Was Built (Session Log)

### Phase 1 — Local Flask Backend + Extension Rewrite

#### Backend (Pediatrics/)

| File | What changed |
|------|-------------|
| `extension_api.py` | Created from scratch. Transcription pipeline mirrors the `audio-to-note` Whisper scripts: tries `gpt-4o-transcribe` (with diarization/verbose_json) first, falls back to `whisper-1`. SOAP generated as plain text using a full clinical prompt with a canonical OBJETIVO block (hardcoded exact physical exam) and standard PLANO footer. Post-processing normalizes infinitive verbs to 1st person (orientar → oriento) and ensures footer presence. CID suggestion is a separate JSON call. |
| `selector_config.py` | Created. Loads DOM selector config from `data/selectors/ghosp.json` (Phase 1) or PostgreSQL `selector_configs` table (Phase 2). |
| `data/selectors/ghosp.json` | Created. 29-key selector map extracted from the original `workflow.js` covering all G-Hosp DOM targets: SOAP fields, CID input, prescription dialog, discharge link, etc. |
| `dashboard/app.py` | Added `flask_cors` (CORS for `/api/*`), added `load_dotenv` pointing to project root `.env` so `OPENAI_API_KEY` is loaded when running the dashboard standalone. Registered auth and billing blueprints. Wired `on_patient_changed` SSE callback. |
| `dashboard/routes.py` | Added 6 new routes: `/api/transcribe`, `/api/suggest-cid`, `/api/format-soap`, `/api/selectors`, `/api/dosages/full`, `/api/audit/manual`. Added `_get_api_key()` helper that reads from request form or `OPENAI_API_KEY` env var. |
| `dashboard/routes_auth.py` | Created. `/auth/register` creates user with 14-day trial. `/auth/login` returns JWT + refresh token. `/auth/refresh` rotates tokens. |
| `dashboard/routes_billing.py` | Created. `/billing/create-checkout` creates Stripe session. `/billing/webhook` handles `checkout.session.completed` and `customer.subscription.deleted`. `/billing/subscription` returns current plan + daily usage. |
| `auth.py` | Created. `generate_token()`, `decode_token()`, `@require_auth`, `@optional_auth` decorators using PyJWT. |
| `billing.py` | Created. `check_usage_limit()` (free: 5/day, trial/pro: unlimited), `log_usage()`, Stripe session creation, webhook processing. |
| `database.py` | Created. SQLAlchemy engine/session factory, PostgreSQL primary + SQLite fallback. |
| `models.py` | Created. `User` (with `is_trial_active()`), `Subscription`, `UsageLog`, `SelectorConfig`, `AuditTrail`. |
| `Dockerfile.cloud` | Created. python:3.11-slim, no Playwright/Tkinter/pynput, gunicorn with 120s worker timeout. |
| `docker-compose.cloud.yml` | Created. api + postgres:16-alpine. |
| `.env.example.cloud` | Created. Template for cloud deployment secrets. |

#### Extension (pedbot-extension/)

| File | What changed |
|------|-------------|
| `manifest.json` | v2.0.0. Removed microphone/openai.com permissions. Added `clipboardWrite`. Host permissions: localhost:5050 + api.tocafichadr.com.br. Load order: cid → api-client → audio-capture → dom-engine → hud → content. |
| `content/api-client.js` | Complete rewrite as `window.TOCAFICHADR_api` IIFE. JWT token management (stored in `chrome.storage.local`), auto-refresh on 401, all API methods: checkHealth, transcribe (FormData), suggestCid, formatSoap, getSelectors, getDosages, logAudit, login, register, logout, getSubscription. |
| `content/audio-capture.js` | Created. `window.TOCAFICHADR_audio` IIFE. MediaRecorder wrapper. Blob goes directly to caller (no service worker). start/stop/isRecording. |
| `content/dom-engine.js` | Complete rewrite as `window.TOCAFICHADR_dom` IIFE. Config-driven (all selectors via `sel()` helper from loaded or bundled JSON). Functions: loadSelectors, extractPatientInfo, clearSoapFields, pasteSoapNote (with `typeof text !== 'string'` safety guard), fillCid (7 strategies + jQuery UI autocomplete simulation + hidden field fallback), saveForm, openPrescription, selectTemplate, submitPrescriptionDialog, printPrescription, processDischarge, goToMainList, openAtestado. |
| `content/hud.js` | Complete rewrite as `window.TOCAFICHADR_hud` IIFE. Thin client orchestrating api/audio/dom. State object, drag, recording timer, CID search dropdown, template buttons, connection dot, auth badge. After transcription: clears SOAP, pastes note, copies to clipboard, shows CID suggestion. `finalizePatient()` orchestrates full workflow (save → prescription → print → discharge → patient list). |
| `content/content.js` | Rewritten. Async IIFE loads selectors, creates HUD, MutationObserver for SPA nav, `autoSetupPatientPage()`. |
| `background/service-worker.js` | Stripped to minimal (onInstalled only). All AI logic moved to Flask backend. |
| `content/selectors.json` | Created. Copy of ghosp.json as bundled fallback. |
| `popup/popup.html` | Rewritten. Local/Cloud radio toggle, API URL field + test button, auth section (login/register/logout/usage), autoClearSoap toggle, autoCid toggle, custom instructions textarea. |
| `popup/popup.js` | Rewritten. Mode toggle updates URL field visibility and authSection visibility. Login/register/logout flow. Shows subscription usage after login. Saves to `chrome.storage.sync`. |
| `PRIVACY_POLICY.md` | Created. LGPD-compliant, Portuguese, no patient data stored on server. |
| `store/description.txt` | Created. Chrome Web Store listing in Portuguese. |
| `content/workflow.js` | Deleted (replaced by dom-engine.js). |

### Session 2 — 2026-03-24 (DOM Validation + Landing Page)

#### DOM Selector Fixes (live G-Hosp inspection via Playwright)

| Selector | Was | Now | Why |
|----------|-----|-----|-----|
| `save_button` | `input[type='submit'][value='Salvar']` | `#submit_pranamnese` | G-Hosp uses `type='button'`, not `type='submit'` |
| `main_list_url` | `/amb/interns` | `/prconsultas` | Confirmed actual patient list URL |
| `discharge_container` | link selectors | `#dar_alta` | Links load dynamically after save; container is always present |
| `patient_name_xpath` | pointing to age/weight paragraph | `//*[@id='paciente']//h4` | Was selecting wrong element |
| `cid_description_input` | (missing) | `#cid_descricao` | Added to fill description field separately |

Fixed in all three sources: `content/selectors.json`, `data/selectors/ghosp.json`, `dom-engine.js` BUNDLED_SELECTORS.

#### dom-engine.js Function Fixes

- `_findSaveButton()` — now looks for `#submit_pranamnese` first, fallback to `input[type='button'][value='Gravar']`
- `fillCid()` — now fills `#intcid_cid_id` with code only, `#cid_descricao` with name separately (was combining both into one field)
- `processDischarge()` — now uses `#dar_alta a` container approach (links absent on page load)

#### Other

- Chrome developer mode reinstall issue documented — caused by "Disable developer mode extensions" banner; fix: click ✕ not "Disable"
- SOAP canonical blocks reviewed and approved as system defaults (2026-03-24)
- Roadmap updated: P2.11 added (per-user customizable SOAP blocks)
- `landing/index.html` — full dark editorial landing page created (Cormorant Garamond + Outfit + JetBrains Mono, animated HUD mockup, LGPD compliance strip)
- `docs/DEPLOY.md` — step-by-step Railway deployment guide (11 steps, troubleshooting table)
- Landing page broadened: removed pediatrics-specific copy; now targets all G-Hosp physicians
- All OpenAI brand mentions removed from public-facing landing page

---

### Bugs Fixed During Integration Testing

| Bug | Fix |
|-----|-----|
| `text.replace is not a function` | GPT returned `soap` as a dict `{S:..., O:..., A:..., P:...}` instead of a string. Fixed in `extension_api.py`: coerce dict to `"\n".join(f"{k}: {v}")`. Added safety guard in `dom-engine.js pasteSoapNote`: `if (typeof text !== 'string') text = JSON.stringify(text)`. |
| SOAP quality poor (no canonical exam, no footer, infinitive verbs) | Upgraded entire pipeline to match the `audio-to-note` Whisper scripts: rich SOAP_TEMPLATE with canonical OBJETIVO block, PLAN_FOOTER_TEXT, post-processing (verb normalization, footer enforcement). |
| Flask not loading `.env` / API key missing | Added `load_dotenv(dotenv_path=...)` to `dashboard/app.py`. |
| Clipboard not copying after transcription | Added `clipboardWrite` permission to manifest. Added `await navigator.clipboard.writeText(soapText)` in `hud.js` after pasteSoapNote. |
| `gpt-4o-transcribe` chunking parameter | Added `chunking_strategy: "auto"` only when using that model; removed from `whisper-1` fallback call. |

---

## Current Status

### Works Today
- Extension installs and loads on `prbentogoncalves.g-hosp.com.br`
- HUD appears (floating panel, draggable, minimizable)
- Voice recording via MediaRecorder
- Transcription via `gpt-4o-transcribe` (with speaker diarization) or `whisper-1` fallback
- SOAP note generated with canonical OBJETIVO block, standard plan footer, correct verb voice
- SOAP pasted into the G-Hosp wysihtml5 rich-text editor (field 0)
- SOAP copied to clipboard automatically
- CID-10 suggestion shown in HUD (click to fill the CID input field)
- Connection dot shows green/red based on Flask health check
- Local/Cloud mode toggle in popup
- JWT auth flow (register/login/logout) built and wired — used when Cloud mode is on

### Known Remaining Issues (Phase 1)
- CID input filling (`fillCid`) is the most fragile part — jQuery UI autocomplete simulation may need tuning on live G-Hosp
- Prescription dialog selectors not yet validated on live G-Hosp (template IDs 1080–1083 are hardcoded)
- `window.print()` opens the browser print dialog — user must press Enter to confirm
- Discharge form selectors not yet validated on live G-Hosp
- Only SOAP field 0 (Queixa/Histórico) is filled — fields 1-5 left blank by design; may need revisiting

### Tests
- 35 backend tests passing (`pytest tests/`)
- 1 pre-existing unrelated failure in `test_core.py::test_validate_config_missing_credentials` (not our code)
- No automated frontend tests (manual testing on live G-Hosp)

---

## Running Locally

### Backend

```bash
cd ~/Dev/Pediatrics
source "venv 2/bin/activate"
python -m emr_automation --dashboard
# Runs on http://localhost:5050
```

Requires `~/Dev/Pediatrics/.env`:
```
OPENAI_API_KEY=sk-...
```

### Extension

1. `chrome://extensions` → Enable Developer Mode
2. Load unpacked → select `~/Dev/pedbot-extension`
3. Popup → Backend: Local → URL: `http://localhost:5050` → Save
4. Open `prbentogoncalves.g-hosp.com.br` → HUD appears

### Running Tests

```bash
cd ~/Dev/Pediatrics
source "venv 2/bin/activate"
pytest tests/test_extension_api.py tests/test_extension_routes.py tests/test_models.py tests/test_auth.py tests/test_billing.py -v
```
