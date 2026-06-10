# 006-REVIEW — Code-Quality Sweep: tocafichadr-extension
**Phase:** 006-code-quality-sweep-2026-05-16  
**Date:** 2026-05-17  
**Reviewer:** Paperclip Researcher (CHRA-885)  
**Depth:** deep  
**Version:** 3.7.0 (manifest.json)

---

## Executive Summary

The codebase is in good overall shape for a Chrome MV3 extension at this stage of development. The architecture is clean, the security posture is well-considered (sender allowlisting, API URL validation, no PII in logs, Clerk JWT auth), and the test suite is unusually thorough for the domain.

**Finding counts:**
| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 4 |
| Low | 6 |
| Nitpick/Info | 5 |

---

## Architecture Overview

The codebase is a **Chrome MV3 extension** with a companion **Python Flask backend**:

- `background/service-worker.src.js` — SW; handles auth (Clerk SDK), API proxying, SSE streaming, audio transcription routing
- `content/` — Content scripts injected into G-Hosp pages; api-client, dom-engine, HUD, audio capture, CID lookup, VAD
- `popup/`, `sidepanel/` — Extension UI
- `shared/` — Console-shipper, Clerk tap, user-config-client
- `backend/emr_automation/` — Flask API: auth, billing, SOAP generation (OpenAI/Groq), audit, user config, dashboard

The architecture correctly isolates sensitive operations in the service worker (Clerk JWT fetch, authed API calls) and uses the extension message bus to bridge the content-script context. The `TOCAFICHADR_FETCH` generic proxy correctly validates URL origin and path prefix before forwarding.

---

## HIGH Findings

### HIGH-1: Dual auth-token storage creates stale-token race

**Files:** `content/api-client.js:27-41`, `background/service-worker.src.js:196-217`

`api-client.js` loads `authToken` from `chrome.storage.local` on script init (async, fire-and-forget). The SW also reads `authToken` from storage as a fallback when the Clerk SDK session is null. This dual-source pattern means:

1. A content script that initialises before the storage read completes will send requests without a token.
2. The storage fallback in the SW (`authToken`) is written by the popup via `_clerk.session.getToken()` but the SW's Clerk client maintains a _separate_ session state. When the popup's JWT rotates (Clerk SDK auto-rotates), the storage key is updated by `setToken()` in `api-client.js` — but only if the popup calls `setToken()`. If the popup's Clerk session silently rotates without a `setToken()` call, the SW falls back to a stale token.

**Impact:** Intermittent 401s when the popup rotates tokens but doesn't explicitly flush to storage. User sees "Sessão expirada" even when actually authenticated.

**Recommendation for Phase 2:** Audit every `clerk.session.getToken()` call in popup code and ensure it always calls `setToken(freshToken)`. Alternatively, adopt a single source of truth: only the SW reads from Clerk and writes to storage; content scripts and popup always go through the SW.

---

## MEDIUM Findings

### MED-1: `_normalizeApiError` duplicated in SW and api-client

**Files:** `background/service-worker.src.js:17-33`, `content/api-client.js:10-26`

The two copies are syntactically identical. If one is updated (e.g., to add a new HTTP status mapping), the other drifts silently.

**Recommendation:** Move to `shared/` and import in both contexts. Requires esbuild bundling `api-client.js` (currently not bundled) or a `self.TOCAFICHADR_normalizeError` window global from a shared content script.

---

### MED-2: `content/hud.js` has no explicit size budget for HUD DOM

**Files:** `content/hud.js`

The HUD is injected into every G-Hosp patient page. No maximum size or memory budget is enforced for the Shadow DOM. If the HUD's template list or SOAP history grows unbounded, it can slow the EMR page.

**Recommendation:** Add a `MAX_HUD_HISTORY_ENTRIES` cap and a periodic cleanup of rendered SOAP tokens from the streaming buffer after completion.

---

### MED-3: API discovery `_maybeDiscoverApiUrl` silently overwrites user-configured URL

**Files:** `background/service-worker.src.js:38-60`

When the gist returns a non-first-party URL (e.g., a `.trycloudflare.com` tunnel during dev), the discovery function will write it to `chrome.storage.sync.apiBaseUrl`, overwriting whatever the user set in the popup — IF the current stored URL is not first-party (`api.tocafichadr.com.br`). The guard `_isFirstPartyApiUrl(current) && parsed.hostname !== 'api.tocafichadr.com.br'` is correct for the first-party case, but if a user explicitly set a trycloudflare URL in settings, a new gist push can silently override it.

**Recommendation:** Add a user-override flag (e.g., `apiBaseUrl_userSet: true`) so that discovery never overwrites a user-explicit value.

---

### MED-4: `canvas` native dependency adds friction with no clear use-case in the extension runtime

**Files:** `package.json:dependencies`

`canvas@3.2.3` is listed as a runtime dependency but appears only in `scripts/generate-icons.mjs` (a one-off dev script). Native addons have a significant install and rebuild overhead (requires `node-gyp`, OS-level `cairo`, `pango`) and can block `npm ci` on machines without proper tooling.

**Recommendation:** Move `canvas` to `devDependencies`. The extension itself does not render to a `<canvas>` node via node-canvas.

---

## LOW Findings

### LOW-1: `TRUSTED_SENDER_URL_PREFIXES` hardcodes a single G-Hosp hostname

**Files:** `background/service-worker.src.js:234-237`

```js
const TRUSTED_SENDER_URL_PREFIXES = [
  chrome.runtime.getURL(''),
  'https://prbentogoncalves.g-hosp.com.br/',
];
```

If G-Hosp ever adds subdomains or the hospital changes URLs (common in Brazilian hospital SaaS), users at the new URL will be blocked. The selector files already treat the G-Hosp URL as configurable; this allowlist is hardcoded.

**Recommendation:** Make the trusted origin configurable (stored in `apiBaseUrl` or a separate `emrBaseUrl` setting) or derive it from `manifest.json`'s `host_permissions` list at runtime.

---

### LOW-2: `offscreen.js` uses `setTimeout(150ms)` to wait for offscreen doc to load

**Files:** `background/service-worker.src.js:521-523`

```js
await _setupOffscreenDocument('offscreen/offscreen.html');
await new Promise((r) => setTimeout(r, 150));
_forwardToOffscreen({ type: 'OFFSCREEN_START', config });
```

The 150ms sleep is a heuristic. If the offscreen document loads slower (low-end hardware), `OFFSCREEN_START` arrives before the listener is registered and is silently dropped. The existing `OFFSCREEN_READY` / `offscreenReadyResolver` mechanism is a cleaner fix already present in the SW.

**Recommendation:** Remove the `setTimeout` and await the `offscreenReadyResolver` promise instead of forwarding immediately after the fixed delay.

---

### LOW-3: `_handleFetch` strips and re-adds Authorization header but doesn't strip cookies

**Files:** `background/service-worker.src.js:560-565`

The fetch proxy strips any inbound `Authorization` header (correct — prevents confused-deputy token injection) and adds its own. However, it does not strip `Cookie` headers. A content script could craft a `TOCAFICHADR_FETCH` with `Cookie: session=<victim>` targeting a proxied API path. In practice the API is same-origin JWT-authenticated and G-Hosp cookies are not sent to `api.tocafichadr.com.br`, but the defensive posture should strip all cookie-like headers.

**Recommendation:** Add `cookie` and `set-cookie` to the header strip list alongside `authorization`.

---

### LOW-4: `popup/popup.src.js` stores `authToken` in `chrome.storage.local` but never purges on session expiry

**Files:** `shared/user-config-client.js` (via `clerk-tap.js`, popup integration)

The storage fallback (`authToken` in `chrome.storage.local`) can persist an expired JWT between browser sessions. On next launch the SW will try the stored token, get a 401, log a `getToken: no token (SDK + storage both empty)` after the `clerk.session` is null — but the stored token was already transmitted. This is a minor information-exposure risk on shared machines.

**Recommendation:** On Clerk `signedOut` event (available via `clerk.addListener`), explicitly clear `authToken` and `refreshToken` from `chrome.storage.local`.

---

### LOW-5: `_swDebugLog` sends structured JSON to `/api/debug-log` without a rate limit

**Files:** `background/service-worker.src.js:148-172`

In error loops (e.g., repeated failed `_getAuthToken()` calls), `_swDebugLog` can fire on every message and flood the backend log endpoint. No debounce or per-session count cap is present.

**Recommendation:** Add a simple in-memory dedup or rate limiter (e.g., max 10 SW diagnostic POSTs per 60s) in `_swDebugLog`.

---

### LOW-6: `scripts/` contains many one-off extraction/diagnostic scripts without documentation

**Files:** `scripts/extract_emr_cids*.{js,py}`, `scripts/test-*.js`, `scripts/tail-console.mjs`

There are 8+ extraction scripts (multiple language variants of the same task) and test scripts mixed into `scripts/`. Without comments or README entries it's unclear which are current, which are deprecated, and which are safe to delete.

**Recommendation:** Add a `scripts/README.md` section listing each script's current status (active / deprecated / one-off) and the last date it was usefully run. Deprecate or delete scripts from CHRA-858 key-rotation era that are no longer needed.

---

## Nitpick / Info

### NIT-1: `package.json` `name` field is `pedbot-extension` — should be `tocafichadr-extension`

**Files:** `package.json:2`

Stale from the Phase 004 rebrand. Does not affect runtime but confuses `npm info` and some tooling.

---

### NIT-2: `manifest.json` includes both `popup` default_action AND `sidePanel` but popup is now fallback-only

The manifest's `action.default_popup` is absent (good — the SW sets `openPanelOnActionClick`), but the icon path is still referenced in `action.default_icon`. This is correct but worth documenting: the popup `popup.html` is now only opened programmatically; the side panel is the primary UI entry point.

---

### NIT-3: `CHANGELOG.md` is 88 KB — consider splitting

On a team/agent handoff, a single-file changelog this large is unwieldy. Consider splitting into per-phase files under `.planning/phases/`.

---

### NIT-4: `store/description.txt` references "PedBot" in the description body

**Files:** `store/description.txt`

Leftover from pre-rebrand. Will show in Chrome Web Store listing.

---

### NIT-5: `hud.css` loads `tokens.css` variables but `sidepanel.html` does not reference `tokens.css`

**Files:** `styles/tokens.css`, `sidepanel/sidepanel.html`

If the side panel's CSS references token variables without importing the token file, styles silently fall back to `initial`. Audit side panel CSS for unresolved token references.

---

## Code Strengths (do not regress)

1. **Confused-deputy mitigations** — sender allowlisting (`_isTrustedSender`), telemetry-only origin pattern (`_isTelemetrySender`), per-message-type gating. Industry-grade for a Chrome extension.
2. **API proxy URL allowlist** — `parsedTarget.origin !== parsedBase.origin || !parsedTarget.pathname.startsWith('/api/')` prevents SSRF-via-proxy.
3. **No PII in debug logs** — `api-client.js:reportError` explicitly documents never including patient data in `context`. Verified by selftest check [6/11].
4. **Single-flight transcription guard** — `_transcribeInFlight` prevents double-transcription on double-click.
5. **Offscreen document architecture** — correctly delegates audio capture to `offscreen.js` per MV3 constraints.
6. **Selftest suite** — 11 checks, 100 unit cases, runs in ~2s without external deps.
7. **Error normalization** — user-safe Portuguese messages everywhere; no raw stack traces exposed to the UI.

---

## Files Not Reviewed in Depth

- `backend/emr_automation/*.py` — Python backend (Flask, SQLite, Clerk JWT verify, OpenAI/Groq). Spot-checked for secret handling and auth patterns. Full backend review would be a separate phase.
- `tests/extension/e2e/` — Playwright test suite. Structure looks correct; not run end-to-end during this sweep.
- `landing/` — Static HTML landing page. Out of scope for extension code quality.
- `content/hud.js` — Very large file (>500 lines); only the architecture and DOM injection pattern were reviewed, not every interaction handler.
