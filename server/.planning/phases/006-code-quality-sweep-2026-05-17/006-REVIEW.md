---
skill: /gsd-code-review
phase: 006-code-quality-sweep-2026-05-17
depth: deep
date: 2026-05-17
scope: full codebase (all tracked .js/.ts/.json source files)
---

# Phase 006 Code Review — tocafichadr-extension

## Executive Summary

The codebase is **well-structured for a Chrome MV3 extension**. The architecture is clean (SW proxy pattern, content script IIFE namespacing, shared utilities), error handling is consistent (user-safe Portuguese error messages), and the CSP is explicit. The main quality debt is in a handful of areas: auth token lifecycle risks, side-effect coupling in user-config-client, a stale package.json name, and some content-script defensive-coding gaps.

**Finding counts by severity:**

| Severity | Count |
|---|---|
| High | 2 |
| Medium | 5 |
| Low | 6 |
| Info | 4 |
| **Total** | **17** |

---

## HIGH Findings

### H-001 — Auth tokens stored without expiry in chrome.storage.local

**File:** `content/api-client.js`, `background/service-worker.src.js`

`authToken` and `refreshToken` are written to `chrome.storage.local` and read back on script load with no expiry check on the extension side. While Clerk's SDK handles JWT rotation, the local cache could serve an expired token between rotation cycles if the SW is idle. If the SW fails to rotate silently, content scripts will keep re-using the stale token until a 401 forces a refresh.

**Recommendation:** Store `authTokenExpiry` alongside `authToken`. On load, if `Date.now() > authTokenExpiry - 60s`, treat token as absent and trigger a re-auth flow rather than silently sending.

---

### H-002 — BFG git history scrub still pending

**File:** git history (commit pre-8d6c2ab)

Commit message in PR #23 explicitly notes: *"Note: BFG history scrub still needed to purge the secret from git history."* The `.env.bak` file contained live EMR credentials, Flask `SECRET_KEY`, and an OpenAI token. These values are in the git object store and visible to anyone with repo access.

**Recommendation:** Run BFG Repo Cleaner immediately. Rotate all secrets that were in the file if not already done. This is the highest-urgency non-code finding in the sweep.

---

## MEDIUM Findings

### M-001 — `console-shipper.js` can leak PII / clinical data to backend

**File:** `shared/console-shipper.js`

The shipper intercepts `console.warn` and `console.error` calls and ships the message text to `/api/debug-log`. Several content scripts log G-Hosp page content (SOAP text, patient URLs, CID codes) at warn/error level. A patient's ICD-10 code or partial anamnesis showing up in backend logs is a LGPD compliance risk.

**Recommendation:** Add a PII scrubber before shipping: strip URL query params, truncate after 200 chars (currently 4000), redact anything matching CID patterns (`[A-Z]\d{2}(\.\d)?`) from shipped messages. Also log only from `warn`/`error` not from info/debug calls — this is already the case, but make it explicit in the comment.

---

### M-002 — `clerk-tap.js` logs full OAuth callback URLs including hash fragments

**File:** `shared/clerk-tap.js`

On page load, the script logs `location.href` up to 800 chars to `console.warn`, which gets picked up by `console-shipper.js` and shipped to `/api/debug-log`. Clerk's OAuth callback URLs often contain `code=`, `state=`, and `session_token` as URL fragments or query params. These are one-time-use but are still sensitive.

**Recommendation:** Strip `code=`, `state=`, and `session_token` from the logged URL: `url.replace(/[?#](code|state|session_token)=[^&]*/g, '[redacted]')`.

---

### M-003 — `user-config-client.js` fallback API base URL is a dev URL

**File:** `shared/user-config-client.js:_resolveApiBase()`

```js
resolve((data && data.apiBaseUrl) || "http://127.0.0.1:5050");
```

The fallback if `chrome.storage.sync` is unavailable or empty is `http://127.0.0.1:5050`. If the sync storage read fails in production, all config hydrations silently hit localhost (which returns connection refused) instead of the production API. Content scripts then render with no config.

**Recommendation:** Change the fallback to `"https://api.tocafichadr.com.br"` to match `service-worker.src.js:DEFAULT_API_BASE_URL`. Add a comment explaining why the two must stay in sync.

---

### M-004 — API Discovery URL points to a GitHub Gist

**File:** `background/service-worker.src.js:API_DISCOVERY_URL`

```js
const API_DISCOVERY_URL = 'https://gist.githubusercontent.com/chrislro/.../raw/tocafichadr-api-url.json';
```

A GitHub Gist controls the production API endpoint. If `chrislro` account is compromised or the Gist is accidentally deleted, the extension could be silently redirected to an attacker-controlled API or lose its backend entirely.

**Recommendation:** Mirror the discovery endpoint at `https://api.tocafichadr.com.br/config/api-url.json` as a primary, with the Gist as fallback only. Or move discovery entirely off GitHub.

---

### M-005 — `package.json` name is stale (`pedbot-extension`)

**File:** `package.json`

```json
"name": "pedbot-extension"
```

The rebrand to `tocafichadr` (phase 004) renamed manifest, assets, and code but missed `package.json`. This is harmless at runtime but can confuse CI tools, npm scripts, and any tooling that reads the package name for reporting.

**Recommendation:** Change to `"name": "tocafichadr-extension"` and update `bugs.url` / `homepage` / `repository.url` from `pedbot-extension` to `tocafichadr-extension`.

---

## LOW Findings

### L-001 — `style-src 'unsafe-inline'` in extension CSP

**File:** `manifest.json:content_security_policy.extension_pages`

`style-src 'self' 'unsafe-inline'` allows injecting arbitrary inline styles into extension pages (popup, side panel). This is a common MV3 limitation (React inline styles) but widens the XSS surface if a future dependency introduces user-controlled CSS values.

**Recommendation:** Document why `'unsafe-inline'` is needed (which component), track a ticket to remove it when the component is refactored to use class-based styles.

---

### L-002 — `cookies` permission is broader than needed

**File:** `manifest.json:permissions`

The extension requests the `cookies` permission. This grants read/write access to all cookies on host-permission-matched domains. If only Clerk session cookies are needed, this permission is broader than necessary.

**Recommendation:** Audit which code paths use `chrome.cookies.*`. If only the Clerk SDK uses it internally (it does for background auth), add a comment. If no extension code directly calls `chrome.cookies.*`, consider removing the permission and filing an issue to verify the Clerk SDK requirement.

---

### L-003 — `content.js` not listed in tracked source files (may be empty/generated)

**File:** `content/content.js` — listed in `git ls-files` but not clearly referenced from `manifest.json` content scripts injection.

**Recommendation:** Verify that `content.js` is actively used. If it's an empty stub or was superseded by `bridge.js` / `dom-engine.js`, remove it.

---

### L-004 — No error boundary on SW message handler for unknown message types

**File:** `background/service-worker.src.js`

The SW's `chrome.runtime.onMessage.addListener` (implied by the TOCAFICHADR_FETCH and TOCAFICHADR_DEBUG_LOG protocols) likely returns `false` for unknown message types, which closes the response channel. If a future content script sends an unrecognized message, it may silently hang waiting for a response.

**Recommendation:** Add a default case that explicitly calls `sendResponse({ ok: false, error: 'unknown_message_type' })` and returns `true` (to indicate async response).

---

### L-005 — `offscreen.js` lifecycle is not guarded against orphaned contexts

**File:** `offscreen/offscreen.js`

Chrome MV3 offscreen documents have a lifecycle independent of content scripts. If the offscreen document is closed unexpectedly (SW restart, Chrome idle), audio capture will silently fail. There is no documented reconnect logic in the reviewed code.

**Recommendation:** Add a heartbeat or reconnect guard: before sending any message to the offscreen document, check `chrome.offscreen.hasDocument()` and recreate if needed.

---

### L-006 — VAD poll interval (`setInterval` at 50ms) is not cleared on script unload

**File:** `content/audio-capture.js`

The `_vadInterval = setInterval(...)` is cleared by `_vadTeardown()` when recording stops. However, if the content script is unloaded (navigation) while recording is active, the interval may persist and throw on next tick when `chrome.runtime` is gone.

**Recommendation:** Register a `window.addEventListener('beforeunload', _vadTeardown)` guard to ensure teardown on navigation.

---

## INFO Findings

### I-001 — No TypeScript — no compile-time type safety

All source files are vanilla `.js`. The codebase has grown to ~12k lines across 15+ files with complex message-passing protocols. Switching to TypeScript (with JSDoc types as an intermediate step) would catch message-shape mismatches at dev time.

### I-002 — `popup.bundle.js` is committed to the repo

**File:** `popup/popup.bundle.js`

The `.gitignore` lists `popup/popup.bundle.js` as ignored, but the file is in `git ls-files`. Either `.gitignore` is newer than the last `git add` or the file was force-added. Committed bundles cause noisy diffs and inflate repo size.

**Recommendation:** `git rm --cached popup/popup.bundle.js` to untrack it. Verify CI/build pipeline generates it from source.

### I-003 — `vercel.json` in a Chrome extension repo

**File:** `vercel.json`

Likely for the backend companion or a landing page deployment. If the Vercel config is for a different service, it should live in that repo, not the extension repo.

### I-004 — `_normalizeApiError` is duplicated in SW and api-client

Both `background/service-worker.src.js` and `content/api-client.js` define `_normalizeApiError()` with identical logic. This is a shared utility that belongs in one place.

**Recommendation:** Move to `shared/error-helpers.js` and import from both. (Or accept the duplication given the different bundling contexts — but document the intentional copy.)
