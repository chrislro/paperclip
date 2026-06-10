# Code Review — 2026-04-22

Full multi-agent review run against Toca Ficha Dr. v2.5.0/2.5.1 (pre-security-hardening commit). Three specialized reviewers: security, correctness, and repo snapshot. This document preserves the findings verbatim so they survive session resets and can be referenced from the phase PLAN.md.

## Executive verdict

**Halt Chrome Web Store submission. Do not run another unsupervised live shift until the CRITICAL items are addressed.** Three CRITICAL, ten HIGH, nine MEDIUM, five LOW, three INFO findings across three agents. Root causes cluster around three patterns:

1. **Unauthenticated backend** — production Flask URL published in a world-readable GitHub gist; `/api/transcribe` has no auth gate. Open relay to OpenAI account and to SOAP/CID outputs derived from patient audio.
2. **Confused-deputy SW proxy** — the service worker's generic fetch relay accepts arbitrary URLs and messages from any frame on the G-Hosp domain, no sender validation. Any XSS, iframe, or third-party-script inclusion on that domain becomes an SSRF primitive against the backend with the doctor's bearer token.
3. **Silent-success / silent-failure paths** — discharge verification treats a Rails 500 as "success" and auto-navigates away (losing unsaved data); `waitFor` timeouts leak rejections that pollute error telemetry; the transcribe `.ok` check happens to work by accident.

Partial remediation shipped in commit `66f0f7a` on 2026-04-22 (P0-2 sender validation, extension-side P0-1 hostname allowlist, tightened manifest patterns, dropped version_name skew). Remaining items tracked in `./PLAN.md`.

---

## CRITICAL

### C1 — Backend URL published in public GitHub gist (not a secret)
`background/service-worker.js:15`. The gist at `gist.githubusercontent.com/chrislro/3abd7bec1b371681c4ab346bd642b8e6/raw/tocafichadr-api-url.json` returns `{"apiBaseUrl": "https://<current-trycloudflare-url>"}` to any unauthenticated request. `docs/DEPLOY-MVP.md:17` confirms the URL is treated as "ephemeral but in-band." No auth on `/api/transcribe`, `/api/health`, `/api/selectors`. **Attack:** adversary hits `/api/transcribe` with arbitrary audio → burns OpenAI quota, inflates billing, or exfiltrates SOAP/CID outputs. **Fix:** require `Authorization: Bearer` on every Flask endpoint; treat gist URL as discovery pointer, not credential.

**Status:** extension-side hostname allowlist shipped in `66f0f7a`. Flask-side auth still outstanding.

### C2 — SW message handlers accept messages from any content-script origin without sender validation
`background/service-worker.js:67` (pre-`66f0f7a`). Every handler destructured `(_sender)` and discarded it. Content scripts injected on `*://*.g-hosp.com.br/*` → any frame on that domain could call `TOCAFICHADR_FETCH` with the stored Bearer token. **Fix:** validate `sender.id === chrome.runtime.id` and `sender.url` prefix-matches the target G-Hosp subdomain or our extension pages.

**Status:** ✅ Resolved in `66f0f7a`.

### C3 — `TOCAFICHADR_FETCH` accepts an arbitrary URL — SSRF/CSRF primitive
`background/service-worker.js:105-121`. Reads `message.url` verbatim, no scheme/host/port validation. `host_permissions` whitelist still includes `https://*.trycloudflare.com/*`, `https://api.tocafichadr.com.br/*`, `https://gist.githubusercontent.com/chrislro/*`. **Fix:** inside `_handleFetch`, parse `new URL(message.url)`, reject anything not matching `apiBaseUrl + /api/*`; strip client-supplied `Authorization`.

**Status:** outstanding (P0-3 in PLAN.md).

---

## HIGH — Security

### H1 — Bearer token in `chrome.storage.local` with no rotation
`content/api-client.js:18`, `popup/popup.js:108-111`. Tokens written to `storage.local`, never rotated client-side; refresh path at `api-client.js:110-123` reuses the same refresh token forever. `storage.local` is **not** encrypted. **Fix:** short-lived access token (≤15 min) + rotating refresh token with server-side revocation.

### H2 — `updateWysihtml5Editor` assigns `innerHTML = htmlText` of LLM-generated SOAP
`content/dom-engine.js:266`. Comment claims "safe: controlled SOAP HTML from own backend" — false. SOAP is LLM-generated from doctor audio; prompt-injection in a dictation → script execution in G-Hosp's iframe context, which has access to patient session cookies. **Fix:** return plaintext from Flask; reconstruct paragraphs via `textContent` + `<br>` DOM nodes.

### H3 — Patient PII flows into telemetry/audit/error bodies with no filter
`content/hud.js:981` (`logAudit('finalize_patient', { internId })`); `background/service-worker.js:156-162` forwards `message.context` + `errorMessage` up to 500/2000 chars; `service-worker.js:218` posts `chief_complaint` inside `/api/transcribe`. No documented retention, no LGPD titular record, no unlink mechanism. **Impact:** Flask log breach exposes audio + patient-linked chief_complaint + SOAP = PHI under LGPD Art. 11. **Fix:** strip `intern_id` and free text from audit/error contexts; server-side scrub `chief_complaint`; retention ≤24h for raw audio; document the DPA.

### H4 — Credentials over tunnel URL with no cert pinning
`popup.js:94, 137, 180`. Login/register/billing over `*.trycloudflare.com`; TLS terminates at Cloudflare; if the URL leaks an attacker spins up a look-alike trycloudflare subdomain and phishes. **Fix:** hardcode the production host in `manifest.json` + popup; accept discovery only if `apiBaseUrl` matches `^https://api\.tocafichadr\.com\.br/`.

### H5 — `host_permissions` uses `*://*.g-hosp.com.br/*`
`manifest.json:13` (pre-`66f0f7a`). SW could fetch any URL on the domain with the doctor's cookies. **Fix:** tighten to `https://prbentogoncalves.g-hosp.com.br/*`.

**Status:** ✅ Resolved in `66f0f7a`.

## HIGH — Correctness

### CH1 — BLOCKER: `transcribe()` returns raw SW response; `.ok` check works by accident
`content/api-client.js:173-218` → `content/hud.js:706-713`. `_handleTranscribe` bypasses `_handleFetch` wrapper and returns Flask's JSON directly — does not set `ok`. Consumer checks `if (!result || !result.ok)`. Currently works because Flask happens to return `ok: true`. **Fix:** in `_handleTranscribe`, wrap as `{ ok: resp.ok, ...json }`.

### CH2 — BLOCKER: `waitFor` never clears its timeout on resolve
`content/dom-engine.js:135-155` + `:510-541`. Timer keeps running after resolve, eventually calls `reject()` — swallowed because the promise is already resolved, but the SW's `unhandledrejection` handler POSTs false errors to `/api/error-log`. Memory pressure accumulates. **Fix:** `const t = setTimeout(...)` + `clearTimeout(t)` in the resolve path.

### CH3 — BLOCKER: Discharge "trust-the-submit" treats Rails 500 / network-error as SUCCESS
`content/dom-engine.js:890-954`. "No validation error after 4s = success" returns `true` even when Rails never came back. Triggers `goToMainList()` → navigates away, **losing unsaved data**. Fast Rails 500 with `.alert-danger` at 300ms slips past (validation check starts at i≥1). **Fix:** check `looksLikeValidationError()` on every tick including i=0; drop timeout-as-success fallback; return inconclusive → HUD surfaces manual-verify banner; skip `goToMainList()`.

### CH4 — SW recycle mid-transcription; audio blob lost
`content/api-client.js:192-194` + `background/service-worker.js:207-246`. MV3 SW terminates after ~30s idle; `_handleTranscribe` awaits a 10-20s fetch. SW killed mid-`fetch` → `chrome.runtime.lastError.message === "The message port closed before a response was received"` — NOT the "context invalidated" substring the guard checks. User sees cryptic string; audio blob lost. **Fix:** translate the string; cache blob in `hud.js` closure; offer "Tentar novamente" resubmit.

### CH5 — Double-submit on "Finalizar Receita"
`content/hud.js:480-493` + `content/dom-engine.js:1127-1152`. `finalizeSimplesPrescription` has no mutex. Double-click on slow Cloudflare → two concurrent runs → two identical prescriptions saved and printed. **Fix:** `state.rxFinalizing` guard + button `disabled = true` before await.

### CH6 — Unbounded MutationObserver; `clearSoapFields` can fire mid-recording
`content/content.js:23-39`. Observer on `document.body` with `childList+subtree:true` fires thousands of times per consultation. `autoSetupPatientPage()` can call `clearSoapFields()` *after* user started recording on new patient. **Fix:** gate observer on URL-change via `popstate` + `history.pushState` wrapping; `if (state.recording || state.processing) return` in `autoSetupPatientPage`.

### CH7 — `storage.onChanged` listener never removed
`content/hud.js:472-477`. SPA re-navigation mounts new HUD, attaches fresh listener; old listener still fires against the detached HUD. **Fix:** track the listener reference; remove it in HUD `cleanup()`.

### CH8 — Template edit loses focus and in-flight input on sibling delete
`popup/popup.js:260-264`. `renderRxTemplates` blows away focus; input events fire synchronously during re-render; `rxTemplates[idx].body` reflects the pre-render state. **Fix:** key closures by `tpl.id` instead of index; preserve focus across re-render or use DOM diff.

### CH9 — `chrome.storage.sync` 8 KB per-key quota silently drops templates
`popup/popup.js:229` + `content/hud.js:461`. `sync.set({ prescriptionTemplates })` has no completion callback; quota exceeded → silent failure. **Fix:** add `(chrome.runtime.lastError)` handling; consider moving to `storage.local` (5 MB).

### CH10 — `audio-capture.js` doesn't observe track.ended
`content/audio-capture.js:124-136`. If mic permission revoked / tab suspended mid-recording, `MediaStreamTrack.ended` fires but nothing listens; HUD timer keeps ticking. **Fix:** `_stream.getAudioTracks()[0].addEventListener('ended', () => _recording && stop())`.

---

## MEDIUM

### M1 — Silent auto-rewrite of `apiBaseUrl` from public gist with no signature
`background/service-worker.js:29-36` (pre-`66f0f7a`). GitHub gist content is mutable; account compromise → every installed extension auto-pivots within 10 min. **Status:** partly resolved in `66f0f7a` (hostname allowlist); signed discovery is a stricter follow-up.

### M2 — 30s `_handleFetch` timeout abusable
`service-worker.js:109`. 100 concurrent `TOCAFICHADR_FETCH` calls hold SW busy. Combined with C2 (pre-`66f0f7a`) was a local DoS; post-fix less severe. **Fix:** semaphore (~4 concurrent); reduce non-transcribe timeout to 10s.

### M3 — No CSP declared in manifest
`manifest.json`. Falls back to MV3 defaults (safe today). **Fix:** add explicit `extension_pages: "script-src 'self'; object-src 'self'; base-uri 'none'"`.

### M4 — `clipboardWrite` auto-copies full SOAP to OS clipboard
`content/hud.js:723`. Every transcription writes PHI to OS-level clipboard with no TTL or consent. **Fix:** opt-in toggle (default off); clear after 30s.

### M5 — `/api/health` has no auth
`popup/popup.js`. "Test connection" succeeds without token → confirms endpoint is public. **Fix:** require auth or split into `/api/ping` (public liveness) + `/api/health` (authed).

### CM1 — Manifest `version` vs `version_name` skew
`manifest.json:4,21`. `version: 2.5.0`, `version_name: 2.5.1-autodiscover`, CLAUDE.md says 2.4.1. **Status:** ✅ Resolved in `66f0f7a` (bumped to 2.5.2, dropped version_name).

### CM2 — Retry after 401 uses stale `Authorization` header
`content/api-client.js:98-101`. `_refreshToken` mutates `authToken` but `options.headers['Authorization']` still carries the old token. Guard at line 61-63 skips the update. **Fix:** `delete options.headers['Authorization']` before recursion.

### CM3 — SOAP HTML-entity sync between textarea and editor
`content/dom-engine.js:323`. Textarea has raw entities; editor renders decoded. Saved prontuário has `&amp;amp;` instead of `&amp;`. **Fix:** sync textarea with decoded text.

### CM4 — `isUsageLimitReached()` always returns `false`
`content/hud.js:1089-1092`. FREE_DAILY_LIMIT gate is cosmetic. **Fix:** wire server-side gating or remove the free-tier UI.

---

## LOW

- **L1 — Manifest version mismatch** — ✅ resolved in `66f0f7a`.
- **L2 — Unused `scripting` permission** — drop from `manifest.json:9`.
- **L3 — Templates in `storage.sync` = cross-border transfer to Google** — LGPD nuance for CFM 2.454/2026. Move to `storage.local` or encrypt.
- **L4 — Error telemetry ships full UA + stack paths** — truncate UA to major version; redact absolute paths.
- **L5 — `window.open(billingPortal)` without `noopener,noreferrer`** — append `'_blank','noopener,noreferrer'`.
- **CL1 — `getByXPath` swallows errors silently** — distinguish config-bug from not-present.
- **CL2 — `debounceTimer` leak in `content.js` across domain nav** — add `beforeunload` cleanup.

## INFO

- **I1 — Prompt injection via dictation is plausible** — add JSON-only schema response + CID allowlist cap in Flask.
- **I2 — No SAST/dep-scanning in CI** — add Semgrep (OWASP), Gitleaks, manifest-permission-diff job.
- **I3 — No LGPD data-subject-access mechanism** — add `/api/lgpd/delete-my-data` + popup link before beta.

---

## Structural "surprises" (for any future contributor)

1. **Every API call proxies through the SW** via `TOCAFICHADR_FETCH`. Content-script `fetch()` to the HTTP backend silently dies (Mixed Content + PNA).
2. **Two prescription flows coexist** in `dom-engine.js`: legacy `openPrescription()` + new `runSimplesPrescription()`. `#tiporec_0`/`#tiporec_1` invert meaning between them.
3. **`pedbotWideMode` and other `pedbot*` keys** persist in installed `chrome.storage` from before the rebrand.
4. **`popup.js:4` hardcodes tunnel URL**; SW auto-discovers from gist. They disagree after tunnel restart.
5. **Discharge verification favors false-positive over false-negative** — documented at `dom-engine.js:897-901`. P0-4 inverts this.
6. **`TOCAFICHADR_CID` is a global `const`**, not IIFE-scoped. Only unprotected global.
7. **32 kbps Opus is a medical-audio decision**, not a default.

---

## Agent attributions

Three agents ran in parallel against the repo at HEAD `37a953b`:

- **Security Engineer** — produced the CRITICAL/HIGH-security and MEDIUM-security findings above (C1–C3, H1–H5, M1–M5, L3–L5, I1–I3).
- **Code Reviewer** — produced the BLOCKER/HIGH-correctness and MEDIUM-correctness findings (CH1–CH10, CM1–CM4, CL1–CL2) plus the "structural surprises" list.
- **Explore / repo mapper** — produced the inventory, entry-point map, docs-accuracy audit, and git-state summary (not reproduced here; see session transcript).

All three confirmed the same version skew, the same SW-as-trust-boundary architecture, and the same lack of tests. Cross-agent corroboration on those points raises confidence in the findings that only one agent flagged.
