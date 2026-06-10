# Toca Ficha Dr. — Architecture

## Overview

Chrome Extension (Manifest V3) for automating G-Hosp EMR workflows for general practitioners and pediatricians in Brazil.

**Mission:** Reduce 25-35 actions per patient to 4-6 actions, saving ~60 seconds per patient.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     CHROME BROWSER                               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              G-Hosp Web Application                        │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐        │   │
│  │  │Patient  │ │  SOAP   │ │Receipt  │ │Discharge│        │   │
│  │  │  List   │ │  Form   │ │  Form   │ │  Form   │        │   │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                            ▲                                     │
│                            │ Content Scripts (DOM manipulation)  │
│  ┌─────────────────────────┴────────────────────────────────┐   │
│  │              Chrome Extension (MV3)                        │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐        │   │
│  │  │SidePanel│ │  Popup  │ │ Service │ │Offscreen│        │   │
│  │  │  (UI)   │ │(Config) │ │ Worker  │ │Document │        │   │
│  │  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘        │   │
│  │       └───────────┴───────────┴───────────┘              │   │
│  │              Content Scripts (injected)                    │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐        │   │
│  │  │dom-engine│ │audio-capture│ │  cid.js  │ │api-client│   │   │
│  │  │         │ │           │ │         │ │         │        │   │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘        │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
          │
          │ HTTPS
          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    BACKEND (Mac Mini)                            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Flask API (Python 3.11+)                     │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐        │   │
│  │  │Transcribe│ │Selectors│ │  Audit  │ │ Billing │        │   │
│  │  │  Route  │ │  Route  │ │  Route  │ │  Route  │        │   │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘        │   │
│  │  ┌─────────┐ ┌─────────┐                                 │   │
│  │  │  Clerk  │ │  Stripe │                                 │   │
│  │  │ Webhook │ │ Webhook │                                 │   │
│  │  └─────────┘ └─────────┘                                 │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Extension | Manifest V3 | Chrome extension format |
| Side Panel | HTML + CSS + JS | Main UI |
| Popup | HTML + CSS + JS | Configuration UI |
| Service Worker | JavaScript | API proxy, auth |
| Content Scripts | JavaScript | DOM manipulation |
| Offscreen Document | HTML + JS | Audio capture when popup closes |
| Backend | Python 3.11+ | API server |
| Backend Framework | Flask | Web framework |
| Database | SQLite | Local data storage |
| Auth | Clerk | JWT authentication |
| Transcription | OpenAI Whisper / Groq | Speech-to-text |
| SOAP Generation | OpenAI GPT-4o-mini | Clinical note generation |
| Billing | Stripe | Subscription management |
| Public Access | Cloudflare Tunnel | Secure tunnel to Mac Mini |

## Extension Components

### Side Panel (sidepanel/)

**Primary UI for physicians during consultations.**

**Features:**
- Voice recording controls (start/stop)
- SOAP note display
- CID-10 suggestion
- Template selection
- Usage statistics

**Files:**
- `sidepanel.html` — Main HTML structure
- `sidepanel.js` — Logic and event handlers
- `sidepanel.css` — Styling

### Popup (popup/)

**Configuration and authentication UI.**

**Features:**
- User login/logout (Clerk)
- Settings (doctor name, auto-clear SOAP, CID suggestion)
- Template editor
- Subscription status

**Files:**
- `popup.html` — Login and settings form
- `popup.js` — Auth flow and settings management
- `popup.css` — Styling

### Content Scripts (content/)

**Injected into G-Hosp pages to manipulate DOM.**

**Scripts:**
- `dom-engine.js` — Form automation, field filling
- `audio-capture.js` — Audio recording via WebRTC
- `cid.js` — CID-10 database and fuzzy search
- `api-client.js` — HTTP client with SW proxy
- `vad-helpers.js` — Voice Activity Detection utilities
- `bridge.js` — Communication bridge between components

**Key Capabilities:**
- Auto-clear SOAP fields on page load
- Fill SOAP fields with generated content
- Select and fill CID-10 codes
- Click buttons (save, print, discharge)
- Extract patient data from triage

### Service Worker (background/)

**Extension's background process (replaces background pages in MV3).**

**Responsibilities:**
- API request proxy (bypass CORS)
- Auth token management (Clerk JWT)
- URL discovery and health checks
- Message routing between components

**Files:**
- `service-worker.bundle.js` — Bundled SW code

### Offscreen Document (offscreen/)

**Hidden document for audio capture when popup is closed.**

**Purpose:** MV3 service workers cannot access WebRTC; offscreen document handles audio recording.

## Backend API (backend/)

### Routes

**Transcription:**
- `POST /api/transcribe` — Audio file → Whisper → SOAP + CID
- Supports OpenAI Whisper and Groq Whisper
- Returns: {transcription, soap_note, suggested_cid}

**Selectors:**
- `GET /api/selectors` — Get DOM selector configuration
- `POST /api/selectors` — Update selector config
- Used for adapting to G-Hosp UI changes

**Audit:**
- `POST /api/audit` — Log usage telemetry
- Tracks: action type, duration, success/failure
- No patient data stored (metadata only)

**Billing:**
- `POST /billing/subscription` — Create Stripe subscription
- `POST /billing/webhook` — Stripe webhook handler

**Auth:**
- `POST /clerk/webhook` — Clerk user provisioning
- Validates Clerk JWT tokens

### Data Models

**Users (SQLite):**
```sql
CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    clerk_user_id TEXT UNIQUE,
    email TEXT,
    subscription_status TEXT,
    created_at TIMESTAMP
);
```

**Usage Logs (SQLite):**
```sql
CREATE TABLE usage_logs (
    id INTEGER PRIMARY KEY,
    user_id TEXT,
    action_type TEXT,
    duration_ms INTEGER,
    success BOOLEAN,
    created_at TIMESTAMP
);
```

## G-Hosp Automation Patterns

### SOAP Note Injection

```javascript
// 1. Clear existing fields
document.querySelector('#subjetivo').value = '';
document.querySelector('#objetivo').value = '';

// 2. Fill with generated content
document.querySelector('#subjetivo').value = soapData.subjetivo;
document.querySelector('#objetivo').value = soapData.objetivo;

// 3. Trigger input events for React/Vue binding
document.querySelector('#subjetivo').dispatchEvent(new Event('input'));
```

### CID-10 Selection

```javascript
// 1. Focus CID field
document.querySelector('#cid_field').focus();

// 2. Type CID code
document.querySelector('#cid_field').value = cidCode;

// 3. Trigger jQuery UI autocomplete
$(document.querySelector('#cid_field')).autocomplete('search');

// 4. Select first suggestion
setTimeout(() => {
    document.querySelector('.ui-autocomplete li:first').click();
}, 500);
```

### Prescription Template

```javascript
// 1. Click "Nova Receita" button
document.querySelector('#btn_nova_receita').click();

// 2. Wait for modal
setTimeout(() => {
    // 3. Fill medication
    document.querySelector('#medicamento').value = template.medication;
    // 4. Fill dosage
    document.querySelector('#posologia').value = template.dosage;
    // 5. Save
    document.querySelector('#btn_salvar').click();
}, 1000);
```

### Discharge Workflow

```javascript
// 1. Click "Alta" button
document.querySelector('#btn_alta').click();

// 2. Wait for modal
setTimeout(() => {
    // 3. Set discharge date
    document.querySelector('#data_alta').value = today;
    // 4. Select "Sem encaminhamento"
    document.querySelector('#encaminhamento').value = 'sem';
    // 5. Confirm
    document.querySelector('#btn_confirmar').click();
}, 500);
```

## Security Architecture

### Content Security Policy (CSP)

```json
{
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; base-uri 'none'; connect-src 'self' https://*.clerk.accounts.dev https://*.clerk.com wss://*.clerk.accounts.dev https://challenges.cloudflare.com https://api.tocafichadr.com.br https://*.trycloudflare.com https://gist.githubusercontent.com http://127.0.0.1:5050 http://localhost:5050 http://100.97.14.32:5050; frame-src 'self' https://challenges.cloudflare.com https://*.clerk.accounts.dev; img-src 'self' https://img.clerk.com data: blob:; style-src 'self' 'unsafe-inline'"
}
```

### Data Privacy

- **No patient data stored:** Audio, transcript, SOAP processed in memory and discarded
- **Metadata only:** Action type, timing, user ID logged (no clinical content)
- **Minimal permissions:** Only prbentogoncalves.g-hosp.com.br scope
- **JWT auth:** Clerk handles authentication, no passwords stored

## Infrastructure

### Mac Mini Backend
- **Host:** 100.97.14.32
- **Local URL:** http://localhost:5050
- **Public:** https://*.trycloudflare.com (dynamic)
- **Process Manager:** launchd
- **Auto-start:** Yes

### Chrome Web Store
- **Extension ID:** (pending publication)
- **Version:** 3.5.0
- **Permissions:** activeTab, storage, cookies, scripting, clipboardWrite, sidePanel, offscreen

### Landing Page
- **URL:** https://tocafichadr.com.br
- **Hosted:** Vercel
- **Framework:** Static HTML

## Performance Characteristics

| Metric | Target | Actual |
|--------|--------|--------|
| Extension load | < 1s | ~200ms |
| Side panel open | < 500ms | ~150ms |
| Transcription (5 min) | < 15s | ~10s (Groq) |
| SOAP generation | < 5s | ~3s |
| DOM injection | < 1s | ~500ms |
| Total per patient | < 30s | ~20s |

## Known Limitations

1. **G-Hosp UI fragility:** Selectors break when G-Hosp updates
2. **Single backend instance:** No redundancy
3. **Dynamic tunnel URL:** Changes on restart
4. **Chrome-only:** No Firefox/Safari support
5. **Internet dependency:** Requires connection for transcription
6. **Clerk dependency:** Auth tied to Clerk service

## Extension Lifecycle

```
1. User installs from Chrome Web Store
2. Extension registers service worker
3. User clicks icon → Popup opens → Login with Clerk
4. User navigates to G-Hosp → Content scripts inject
5. User opens Side Panel → Records audio
6. Audio sent to backend → Whisper → GPT → SOAP
7. SOAP injected into G-Hosp form
8. User confirms CID, selects template
9. User clicks "Alta e voltar" → Discharge + return to list
```
