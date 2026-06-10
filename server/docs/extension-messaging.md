# Extension Messaging & Entry-Point Reference — Toca Ficha Dr.

> **Issue:** CHRA-2081 — `[Rule 8]` deep-link / entry-point verification (Toca Ficha Dr. half)
> **Author:** Paperclip Engineer (agent `3f7973ee`)
> **Date:** 2026-05-29
> **Manifest version audited:** `3.8.0` (MV3)
> **Scope:** content-script ⇄ service-worker ⇄ side-panel message passing, the long-lived SOAP stream port, backend entry URLs, the action/side-panel/keyboard entry point, and the Clerk auth-confirmation landing.

Toca Ficha Dr. is an **MV3 side-panel extension** (not a popup extension). It has no `plantonistapro://`-style custom URL scheme — its "deep linking" surface is (a) the internal message-passing protocol between its components, (b) the backend HTTP entry points, and (c) the Clerk auth-success landing. This document is the authoritative schema for all three.

---

## 1. Component topology

```
G-Hosp page (https://prbentogoncalves.g-hosp.com.br/*)
  └─ content scripts (manifest.json:33-48, run_at: document_idle)
       console-shipper → error-helpers → cid → api-client → vad-helpers
       → audio-capture → dom-engine → bridge   (load order matters)
            │  chrome.runtime.sendMessage / .connect
            ▼
  Service worker (background/service-worker.bundle.js ← service-worker.src.js)
       Clerk JWT, fetch proxy, ASR, SOAP stream, side-panel behavior
            ▲
            │  chrome.runtime.sendMessage / chrome.tabs.sendMessage
            ▼
  Side panel (sidepanel/sidepanel.html) — drives the workflow UI
```

Content scripts are injected **only** on `https://prbentogoncalves.g-hosp.com.br/*` (`manifest.json:35`). `bridge.js` is the content-side glue; `dom-engine.js` / `audio-capture.js` do the real work; the side panel is the user-facing controller.

---

## 2. Message channels

There are **three** distinct channels. Keep them separate — mixing them is the usual source of "Receiving end does not exist" bugs.

### 2a. Content → Service Worker — one-shot request/response
`chrome.runtime.sendMessage({ type, … })`, handled in `service-worker.src.js:436` (`chrome.runtime.onMessage.addListener`). Handlers return `true` to keep `sendResponse` alive for async work.

| `type` | Payload | SW handler (line) | Purpose |
|---|---|---|---|
| `TOCAFICHADR_FETCH` | `{ url, method, headers, body }` | `:484` | CORS-bypass fetch proxy. URL gated by host allowlist. Sent from `content/api-client.js:81`. |
| `TOCAFICHADR_HEALTH` | `{}` | `:458` | Backend health probe. `content/api-client.js:114`. |
| `TOCAFICHADR_TRANSCRIBE` | `{ audio(base64), … }` | `:452` | Send captured audio for ASR. `content/api-client.js:161`. |
| `TOCAFICHADR_AUDIT` | `{ … }` | `:464` | Ship an audit record. |
| `TOCAFICHADR_ERROR` | `{ … }` | `:470` | Report a content-side error. |
| `TOCAFICHADR_DEBUG_LOG` | `{ … }` | `:475` | Ship a debug log line. |
| `TOCAFICHADR_DISARM_BEFOREUNLOAD` | `{}` | `:490` | Disarm the unsaved-work `beforeunload` guard. |
| `START_REALTIME` | `{ … }` | `:498` | Begin a realtime ASR session (offscreen). |
| `STOP_REALTIME` | `{}` | `:504` | End the realtime ASR session. |
| `OFFSCREEN_READY` | `{}` | `:509` | Offscreen document signals it is ready (resolves `offscreenReadyResolver`). |

**Response shape:** handlers reply with their own payloads; error paths normalize via `_normalizeApiError` (`shared/error-helpers.js`).

### 2b. Content → Side Panel — fire-and-forget broadcasts
`chrome.runtime.sendMessage({ type, … })` with **no SW handler** — the side panel listens on its own `chrome.runtime.onMessage`. Senders ignore delivery failures (`.catch(() => {})`).

| `type` | Payload | Emitted at | Purpose |
|---|---|---|---|
| `TOCAFICHADR_PATIENT_CHANGED` | `{ info, urlKey }` | `content/bridge.js:114` | Patient/consultation-type changed (SPA nav). `urlKey` scopes the template catalog by page type, not patient identity. |
| `TOCAFICHADR_RECORDING_BLOB` | `{ blob(base64), … }` | `content/bridge.js:259` | Finished recording payload. |
| `TOCAFICHADR_RECORDING_ERROR` | `{ error }` | `content/bridge.js:233,268` | Recording failed. |
| `TOCAFICHADR_WAVEFORM_BINS` | `{ bins:Uint8[24] }` | `content/audio-capture.js:510` | Live waveform viz (24-bin amplitude array). |

### 2c. Side Panel → Content — `SIDEPANEL_*` commands
`chrome.tabs.sendMessage(tabId, { type: 'SIDEPANEL_…' })`, handled in `content/bridge.js:35`. The listener is registered **synchronously before any `await`** so commands fired during `loadSelectors()` don't hit a dead listener; a TDZ guard returns `{ ok:false, error:'bridge ainda inicializando…' }` for the rare early race.

- Dispatch: `HANDLERS[msg.type]` → `TOCAFICHADR_dom` / `TOCAFICHADR_audio`.
- Response contract: **always** `{ ok: true, … }` or `{ ok: false, error }`. Unknown command → `{ ok:false, error:'unknown command: <type>' }`.
- The concrete `SIDEPANEL_*` verbs live in the `HANDLERS` map further down `bridge.js` (e.g. start/stop recording, run discharge, fill SOAP) — they are the side panel's RPC surface into the page.

### 2d. Long-lived port — SOAP token stream
`chrome.runtime.connect({ name: 'TOCAFICHADR_SOAP_STREAM' })`. Opened in `content/api-client.js:242`; accepted in `service-worker.src.js:533` (`onConnect`, name-checked at `:534`).

| Direction | Message | Payload |
|---|---|---|
| client → SW | `SOAP_STREAM_START` | `{ raw_text, chief_complaint, custom_instructions, soap_voice }` |
| SW → client | `SOAP_TOKEN` | `{ t }` (raw GPT delta) |
| SW → client | `SOAP_DONE` | `{ full, … }` (prefers server `final` frame over buffered tokens) |
| SW → client | `SOAP_ERROR` | `{ error: 'HTTP <status> [<code>]' }` |

The SW POSTs to `{baseUrl}/api/soap-stream` (`Accept: text/event-stream`, `Authorization: Bearer <Clerk JWT>`), holds an active-ops keepalive during the stream (`CHRA-1913`), and enforces a hard 60s timeout (`service-worker.src.js:553`).

---

## 3. Backend entry points (the "external URLs" check)

`baseUrl` resolution (every network handler): `chrome.storage.sync.apiBaseUrl || DEFAULT_API_BASE_URL`, trailing slashes stripped.

| Constant | Value | Source |
|---|---|---|
| `DEFAULT_API_BASE_URL` | `https://api.tocafichadr.com.br` | `service-worker.src.js:13` |
| Discovery (primary) | `https://api.tocafichadr.com.br/config/api-url.json` | `service-worker.src.js:9` |
| Discovery (fallback) | a `gist.githubusercontent.com` raw JSON | `service-worker.src.js:10` |
| Discovery allowlist | `api.tocafichadr.com.br` or `*.trycloudflare.com`, HTTPS only | `service-worker.src.js:12,38-39` |
| Discovery TTL | 10 min | `service-worker.src.js:11` |

**Routes referenced in code** (all relative to `baseUrl`):
- `/config/api-url.json` — API discovery (public).
- `/api/me/config` — per-user runtime config. `content/hud.js:58` (`base + '/api/me/config'`).
- `/api/soap-stream` — SSE SOAP generation. `service-worker.src.js:563`.
- `/api/transcribe`, `/api/health` (and friends) — via the typed messages in §2a.

### ⚠️ Port `5050` vs `5051` — CONFLICT, do **not** silently change

The issue states the backend "must be `5051`, NOT `5050`". **The committed code uses `5050`**, in two places:
- `content/api-client.js:107` — comment references `http://100.116.133.83:5050`.
- `service-worker.src.js:69-70` — migration: `http://localhost:5050` → `http://127.0.0.1:5050`.

`5050`/`5051` is **only the local-dev default**. Production never uses a port — it's `https://api.tocafichadr.com.br`. So either the "5051" memo describes a newer local setup the code hasn't caught up to, or the memo is stale. **This is infra/config and was not changed** (per the agent anti-pattern rule against modifying config without confirmation). **Action required:** the backend owner must confirm the canonical local-dev port; if it is genuinely `5051`, update the migration in `service-worker.src.js:69-70` and the comment in `api-client.js:107` in a dedicated change.

### `/api/me/config` 404 check
The endpoint exists in code and resolves to `https://api.tocafichadr.com.br/api/me/config` in production (or the configured `apiBaseUrl`). A live probe was **not** runnable from the agent sandbox (external HTTPS egress is blocked here). **To verify:** from the MacBook or a browser, `curl -i https://api.tocafichadr.com.br/api/me/config` — expect `401` (auth required), **not** `404`. A `404` means the route regressed.

---

## 4. Action / side-panel / keyboard entry point

| Aspect | State | Source |
|---|---|---|
| Toolbar `action` | Present, **no `default_popup`** | `manifest.json:55-62` |
| Opens | **Side panel** (`sidepanel/sidepanel.html`) on action click | `service-worker.src.js:84-89` via `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` |
| `side_panel.default_path` | `sidepanel/sidepanel.html` | `manifest.json:17-19` |
| **Keyboard shortcut (`commands`)** | **ABSENT** — no `commands` key in the manifest | `manifest.json` (no `commands`) |

**Finding (issue: "popup can be opened via keyboard shortcut"):**
- There is no bundled keyboard shortcut. Chrome still exposes a built-in **`_execute_action`** slot for any extension with an `action`; a user can bind it at `chrome://extensions/shortcuts`. Because `openPanelOnActionClick` is enabled, triggering `_execute_action` opens the **side panel**, which is the correct view.
- ✅ Action click → side panel: works (code path present).
- ❌ Out-of-the-box keyboard shortcut: not configured. If a default chord is desired, add a `commands` entry (e.g. `_execute_action` with a `suggested_key`) — but note Chrome reserves many chords and pre-assigned defaults often silently fail to bind.

---

## 5. Auth "confirm account" landing (the email-link check)

Auth is **Clerk**, not Firebase:
- `createClerkClient` from `@clerk/chrome-extension/background` (`service-worker.src.js:6`).
- `CLERK_PUBLISHABLE_KEY = 'pk_live_…'` (`service-worker.src.js:14`).
- `host_permissions` include `clerk.tocafichadr.com.br` and `accounts.tocafichadr.com.br` (`manifest.json:23-24`).
- `auth-success.html` + `auth-success.js` are `web_accessible_resources` matched to `https://*.clerk.accounts.dev/*` (`manifest.json:49-53`).

So an email **"confirm account"** link opens the Clerk-hosted accounts page; on success the flow lands on `auth-success.html` (the extension's success page), which signals the extension. There is **no dead-end Safari/“Confirmed!” page** issue here because the landing is an extension-owned resource that re-establishes the session. ✅ (Manual confirmation of the live email→landing hop should still be done once during release QA — see the release skill `chrome-extension-release`.)

---

## 6. CHRA-2081 extension checklist — disposition

| Checklist item | Status | Notes |
|---|---|---|
| content↔background messaging schema documented | ✅ DONE | §2 of this doc. |
| backend `/api/me/config` not 404 | 🔶 VERIFY OFF-SANDBOX | Route exists in code (§3); live probe blocked by agent egress — run the `curl` from MacBook/browser, expect 401 not 404. |
| port must be 5051 not 5050 | ⚠️ CONFLICT — NOT CHANGED | Code uses 5050 (local-dev only). Needs backend-owner confirmation before any change (§3). |
| popup opens via keyboard shortcut + correct view | 🔶 PARTIAL | Side-panel (not popup); action→panel works; **no bundled shortcut** — user-bindable `_execute_action` only (§4). |
| email confirm links land on landing page | ✅ (code) | Clerk `auth-success.html`, not Firebase (§5). Live email hop = release-QA item. |
