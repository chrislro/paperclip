# Toca Ficha Dr. Automation Platform — Design Specification

**Date:** 2026-03-23
**Status:** Draft
**Scope:** Phase 1 (Personal Tool) + Phase 2 (Cloud Product)

---

## 1. Problem Statement

Toca Ficha Dr. automates pediatric EMR (G-Hosp/G-UPA) workflows, reducing 25-35 manual actions per patient to 4-6. Two previous implementations exist:

- **Pediatrics/** — Python + Playwright backend (8K LOC, 55 tests, Flask dashboard, working). Problem: requires a second browser window (Playwright), creating a clunky two-browser workflow during real shifts.
- **pedbot-extension/** — Chrome MV3 extension (1.7K LOC, vanilla JS). Problem: audio pipeline broken (MV3 service worker dies during API calls), DOM selectors don't match current G-Hosp HTML.

**Core need:** Work inside the existing G-Hosp tab (no second browser), with a floating HUD for visual feedback, voice-driven SOAP note generation, and one-click finalization.

**Monetization goal:** Eventually sell to other G-Hosp doctors as a Chrome Web Store extension with a cloud backend.

---

## 2. Solution: 2-Phase Strategy

### Phase 1 — Personal Tool (weeks)
Chrome Extension (thin client: HUD + DOM + audio capture) + Local Flask Backend (reuses existing Python code for AI, dosage, audit).

### Phase 2 — Cloud Product (months)
Same Chrome Extension + Cloud API Backend (adds auth, billing, multi-tenant, selector configs per EMR). Published to Chrome Web Store.

**Key principle:** The extension is a thin client. It does 3 things: render HUD, capture audio, automate DOM. Everything else (AI, dosage, audit, billing) lives in the backend. The extension barely changes between phases — only the API URL and auth headers change.

---

## 3. Architecture

### Phase 1: Local

```
┌─────────────────────────────┐          ┌──────────────────────────────┐
│       CHROME BROWSER        │          │    LOCAL PYTHON BACKEND      │
│                             │          │    Flask @ localhost:5050    │
│  ┌───────────────────────┐  │  REST    │                              │
│  │ G-Hosp Tab            │  │  API     │  POST /api/transcribe        │
│  │                       │  │ ◄──────► │  POST /api/suggest-cid       │
│  │  ┌─────────────────┐  │  │          │  POST /api/format-soap       │
│  │  │ Chrome Extension │  │  │          │  GET  /api/dosages           │
│  │  │                  │  │  │          │  GET  /api/selectors         │
│  │  │ • HUD Panel      │  │  │          │  GET  /api/health            │
│  │  │ • DOM Engine     │  │  │          │  POST /api/audit             │
│  │  │ • Audio Capture  │  │  │          │                              │
│  │  └─────────────────┘  │  │          │  Reuses: audio.py,           │
│  └───────────────────────┘  │          │  openai_integration.py,      │
└─────────────────────────────┘          │  audit_log.py, metrics.py    │
                                         └──────────────────────────────┘
```

### Phase 2: Cloud

Same diagram, but:
- Flask backend deployed to cloud (Railway/Fly.io/VPS)
- Extension calls `api.tocafichadr.com.br` instead of `localhost:5050`
- Auth layer (JWT) added to all `/api/*` routes
- PostgreSQL replaces SQLite
- Stripe billing added
- Selector configs stored in DB (per-EMR, per-version)

---

## 4. Phase 1: Detailed Design

### 4.1 Chrome Extension — New Architecture

**Content Scripts** (injected into G-Hosp):

| File | Responsibility |
|------|---------------|
| `hud.js` | Floating panel UI: patient card, record button + timer, CID suggestion + confirm, template grid (4 buttons), "Finalizar" orchestrator, status indicators |
| `dom-engine.js` | All DOM manipulation: extractPatientInfo(), clearSoapFields(), pasteSoapNote(), fillCid(), saveForm(), openPrescription(), selectTemplate(), printPrescription(), processDischarge(), goToMainList(), waitFor() |
| `audio-capture.js` | MediaRecorder API → blob collection → POST to Flask via FormData (no base64, no service worker) |
| `api-client.js` | Fetch wrapper for Flask endpoints. BASE_URL from chrome.storage (default: localhost:5050). Health check, connection status indicator. |

**Service Worker** (minimal, ~30 lines):
- Only needed if CORS prevents content scripts from reaching localhost directly
- Proxies requests from content scripts to Flask
- No AI logic, no timeouts

**Popup** (settings):
- API URL field (default: localhost:5050)
- Auto-clear SOAP toggle
- Auto-suggest CID toggle
- Connection test button

### 4.2 Audio Pipeline — Fixed

**Current (broken):**
```
MediaRecorder → Blob → base64 → chrome.runtime.sendMessage → Service Worker
→ (SW may die after 30s) → base64 decode → FormData → fetch OpenAI → (SW may die)
→ GPT → (SW may die) → sendResponse
```

**New:**
```
MediaRecorder → Blob → FormData → fetch('localhost:5050/api/transcribe')
→ Flask → Python calls Whisper (no timeout) → Python calls GPT (no timeout)
→ Returns JSON {soap, cid} → Extension fills DOM
```

Zero service worker involvement. Python process never times out.

### 4.3 Flask Backend — New Endpoints

Added to `Pediatrics/emr_automation/dashboard/routes.py`:

| Endpoint | Method | Input | Output | Python Module |
|----------|--------|-------|--------|--------------|
| `/api/transcribe` | POST | audio blob (multipart) | `{soap: string, cid: {code, name, confidence}}` | audio.py + openai_integration.py |
| `/api/suggest-cid` | POST | `{soap_text, complaint}` | `{code, name, confidence}` | openai_integration.py |
| `/api/format-soap` | POST | `{raw_text, complaint}` | `{formatted_soap}` | openai_integration.py |
| `/api/dosages` | GET | `?weight=X` | `{medications: [...]}` | (existing) |
| `/api/selectors` | GET | `?emr=ghosp` | `{selectors: {...}}` | selector_config.py (new) |
| `/api/health` | GET | — | `{status: "ok"}` | — |

CORS: `flask-cors` with origin `chrome-extension://{extension_id}`, or service worker proxy.

### 4.4 DOM Selector Strategy

Selectors move from hardcoded JS to a JSON config served by the backend:

```json
{
  "emr": "ghosp",
  "version": "2024",
  "selectors": {
    "soap_editors": ".wysihtml5-sandbox",
    "soap_editor_count": 6,
    "cid_input": [
      "#autocomplete_cid",
      "input[name*='cid']",
      "input[placeholder*='CID']"
    ],
    "save_button": "#btn_salvar",
    "prescription_link": "#link_new_receitaalta",
    "template_radio": "input[name='padraorec']",
    "discharge_link": "a[href*='discharge']",
    "patient_name_xpath": "//div[@class='patient-info']//h3",
    "patient_weight_regex": "(\\d+[,.]?\\d*)\\s*kg"
  }
}
```

Extension fetches on load, caches locally, refreshes daily. Fallback: bundled default config.

### 4.5 Patient Workflow (End-to-End)

1. **Open patient chart** → HUD auto-detects patient (extractPatientInfo from DOM), shows name/weight/complaint
2. **SOAP auto-cleared** (if setting enabled) → dom-engine.clearSoapFields() on 6 wysihtml5 editors
3. **Tap mic** → MediaRecorder starts, timer visible on HUD
4. **Stop recording** → audio blob POSTed to Flask /api/transcribe
5. **Flask processes** → Whisper transcription → GPT SOAP formatting → CID suggestion
6. **HUD shows results** → SOAP preview pasted into wysihtml5 editors, CID chip displayed
7. **Confirm CID** (1 click) → dom-engine.fillCid() with multi-strategy selector fallback
8. **Select template** (1 click) → HUD grid: Gastro 1/2, Resfr. 1/2
9. **Click "Finalizar"** → Orchestrates: saveForm → openPrescription → selectTemplate → submitDialog → printPrescription → processDischarge → goToMainList
10. **Done** → Action logged to Flask /api/audit. Next patient.

### 4.6 What to Reuse from Existing Code

**From Pediatrics/ (Python):**
- `audio.py` — Whisper transcription (reuse as-is)
- `openai_integration.py` — GPT SOAP/CID processing (reuse as-is)
- `audit_log.py` — SQLite logging (reuse as-is)
- `metrics.py` — Operation timing (reuse as-is)
- `credential_manager.py` — Keychain/env credentials (reuse as-is)
- `dashboard/` — Flask app factory + routes (extend with new endpoints)
- `Dockerfile` — Container definition (adapt for API-only mode)
- `work_launcher.py` — Script manager (add extension note to startup)

**From pedbot-extension/ (JS):**
- `hud.css` — Dark OLED styling (keep, minor updates)
- `workflow.js` — DOM automation logic (rewrite as dom-engine.js, same strategies)
- `cid.js` — CID database moves to Python backend

**Not used (replaced by extension):**
- `core.py` — Playwright/Selenium browser automation
- `prescription.py` — Browser-based prescription filling
- `discharge.py` — Browser-based discharge processing
- `hotkeys.py` — macOS global hotkeys
- `overlay.py` — macOS visual overlay
- `check_emr.py` — Patient monitoring (separate concern)

---

## 5. Phase 2: Detailed Design

### 5.1 Cloud Backend — New Components

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Auth | JWT (PyJWT) | User registration, login, token refresh |
| Billing | Stripe API | Subscriptions, usage metering, webhooks |
| Database | PostgreSQL (Neon or self-hosted) | Users, subscriptions, usage logs, selector configs |
| Deployment | Railway / Fly.io / VPS | Cloud hosting with São Paulo region |
| Admin | Flask admin routes | User management, selector editor, analytics |

### 5.2 Authentication

**Endpoints:**
- `POST /auth/register` — email, password, name → create user → return JWT
- `POST /auth/login` — email, password → verify → return JWT + refresh token
- `POST /auth/refresh` — refresh token → new JWT
- `POST /auth/forgot-password` — send reset email
- `POST /auth/reset-password` — token + new password

**JWT middleware** on all `/api/*` routes. Phase 1 routes work unchanged — auth is additive middleware.

**Extension changes:**
- Popup: login/register form (email + password)
- Store JWT in chrome.storage.local
- api-client.js: add `Authorization: Bearer <token>` header
- HUD: show user name + plan badge

### 5.3 Billing (Stripe)

**Plans:**

| Plan | Price | Limits | OpenAI Key |
|------|-------|--------|------------|
| Free | R$0 | 5 patients/day | User provides own key |
| Pro | R$49/mês | Unlimited | Pooled (included) |
| Hospital | R$39/médico/mês (min 5) | Unlimited + admin | Pooled (included) |

**Endpoints:**
- `POST /billing/create-checkout` — Stripe Checkout session
- `POST /billing/webhook` — Handle Stripe events (subscription.created, payment_succeeded, subscription.deleted)
- `GET /billing/subscription` — Current plan, usage, renewal date

**Usage metering:**
- Count /api/transcribe calls per user per day
- Free plan: reject after 5 (return 429 + upgrade prompt)
- Pro/Hospital: unlimited, but logged for analytics

**Trial:** 14 days of Pro features on registration.

### 5.4 Selector Config Engine

**Database table:**
```sql
CREATE TABLE selector_configs (
  id SERIAL PRIMARY KEY,
  emr_name VARCHAR(50) NOT NULL,        -- 'ghosp', 'tasy', 'mv'
  emr_version VARCHAR(20),               -- '2024.1'
  selectors JSONB NOT NULL,              -- full selector map
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true
);
```

**How it works:**
1. Extension calls `GET /api/selectors?emr=ghosp`
2. Backend returns latest active config for that EMR
3. Extension caches in chrome.storage.local (TTL: 24h)
4. Admin dashboard has a selector editor UI
5. Future: community can submit selector configs for new EMRs

### 5.5 Database Schema

```sql
-- Users
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  plan VARCHAR(20) DEFAULT 'free',
  stripe_customer_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Subscriptions
CREATE TABLE subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  stripe_subscription_id VARCHAR(255),
  plan VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL,
  current_period_end TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Usage Logs (for metering + analytics)
CREATE TABLE usage_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action VARCHAR(50) NOT NULL,
  emr_name VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Selector Configs (described above)

-- Audit Trail (anonymized, for product analytics)
CREATE TABLE audit_trail (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action_type VARCHAR(50),
  duration_seconds FLOAT,
  success BOOLEAN,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**LGPD compliance:** No patient names, no SOAP content, no audio stored. Only user accounts, usage counts, and anonymized action metrics.

### 5.6 Chrome Web Store Publishing

**Requirements:**
- PNG icons (16, 48, 128px) — currently placeholders
- Privacy policy page (hosted on tocafichadr.com.br)
- Description in Portuguese
- Screenshots of HUD in action
- Manifest permissions justification

**Update flow:** Chrome Web Store auto-updates extensions. Push new version → users get it within hours.

### 5.7 Privacy & LGPD

**Data flow (Phase 2):**
```
Patient data (name, weight, complaint) → NEVER leaves the browser
Audio blob → sent to cloud → Whisper API → transcript returned → blob discarded
SOAP text → sent to cloud → GPT API → formatted SOAP returned → text discarded
CID suggestion → returned to browser → displayed in HUD
```

**What's stored on your server:** User accounts, subscription status, usage counts, selector configs, anonymized audit trail. **Never:** patient names, audio files, SOAP notes, CID codes linked to patients.

**OpenAI data processing:** OpenAI's API does not train on API inputs. Their data processing agreement covers LGPD requirements for processor role.

---

## 6. Migration Path: Phase 1 → Phase 2

### 6.1 Transition Steps

Before writing Phase 2 code, 4 preparation steps:

1. **Extract API layer** — Move Flask routes to a standalone module that runs without Playwright/Selenium dependencies. The Phase 1 server already does this (Flask dashboard has no browser dependency).

2. **Add config toggle** — Extension popup: "Backend: Local / Cloud" selector. Switches BASE_URL. Allows you to keep using local mode while developing cloud features.

3. **Externalize selectors** — Move hardcoded DOM selectors to JSON config. Extension fetches from GET /api/selectors. This is a Phase 1 feature that directly enables Phase 2's multi-EMR support.

4. **Dockerize for cloud** — Pediatrics/ already has a Dockerfile. Ensure it runs the API-only Flask server (no Playwright, no Tkinter, no pynput).

### 6.2 Code Changes: Phase 1 → Phase 2

**Extension (pedbot-extension/):**

| File | Change |
|------|--------|
| `api-client.js` | Add `Authorization: Bearer <token>` header. ~10 lines. |
| `hud.js` | Add login status indicator, usage badge. ~30 lines. |
| `popup/` | Add login/register form, plan display. ~70 lines. |
| `manifest.json` | Add cloud API domain to host_permissions. 1 line. |
| `service-worker.js` | Add auth token to proxied requests. ~5 lines. |

**Backend (Pediatrics/emr_automation/):**

| File | Change |
|------|--------|
| `auth.py` | NEW — JWT registration, login, middleware |
| `billing.py` | NEW — Stripe integration |
| `models.py` | NEW — SQLAlchemy models for PostgreSQL |
| `dashboard/routes.py` | Add auth middleware decorator to existing routes |
| `audit_log.py` | Swap SQLite adapter for PostgreSQL adapter |
| `selector_config.py` | Swap JSON file backend for PostgreSQL backend |

### 6.3 Design Decisions That Enable Smooth Migration

1. **API-first from Day 1** — Extension always calls REST endpoints. Same contract locally and in cloud.
2. **Config-driven selectors** — Selectors are data, not code. Phase 1: local JSON. Phase 2: PostgreSQL.
3. **Auth as optional middleware** — Phase 1: no auth. Phase 2: add JWT decorator to routes. Zero logic changes.
4. **Storage abstraction** — audit_log.py uses a simple interface. Phase 1: SQLite. Phase 2: PostgreSQL adapter.
5. **No patient data in transit or at rest** — Same backend code is LGPD-compliant in both phases.

---

## 7. Go-to-Market Strategy

### Phase 2a: Validate (months 1-2)
1. Deploy cloud backend (Railway or Fly.io, São Paulo region)
2. Publish extension to Chrome Web Store
3. Onboard 5-10 colleagues at your UPA (free tier)
4. Gather feedback, iterate on selectors and workflow
5. Track: completion rate, errors, time-per-patient

### Phase 2b: Monetize (months 3+)
1. Enable Pro plan (R$49/mês) via Stripe
2. Share in medical WhatsApp groups (pediatricians, UPA doctors)
3. Create demo video showing before/after workflow
4. Approach other UPAs in Rio Grande do Sul
5. Hospital plan for institutional sales

### Market Sizing
- G-Hosp is used across multiple UPAs in RS
- 50 paying doctors × R$49/mo = R$2,450/mo (~$490 USD/mo)
- 5 UPAs × Hospital plan (10 seats each) = R$1,950/mo
- Multi-EMR expansion (Tasy, MV, etc.) = multiplied market
- Long-term: every pediatrician in Brazil using slow EMRs is a potential customer

---

## 8. Success Criteria

### Phase 1
- [ ] Extension HUD renders correctly in G-Hosp page
- [ ] Audio recording → Flask → Whisper → SOAP works end-to-end
- [ ] SOAP auto-pasted into wysihtml5 editors
- [ ] CID suggestion displayed and fillable with one click
- [ ] Template selection triggers correct prescription flow
- [ ] "Finalizar" orchestrates full: save → prescription → print → discharge → list
- [ ] Used successfully on a real shift (20+ patients)

### Phase 2
- [ ] Cloud backend deployed and accessible
- [ ] User registration and JWT auth working
- [ ] Stripe billing with Free/Pro/Hospital plans
- [ ] Chrome Web Store listing published
- [ ] 5+ external doctors using the tool
- [ ] Selector config updatable without redeploying
- [ ] LGPD compliance (no patient data stored)
