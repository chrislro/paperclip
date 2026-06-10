# Security Audit — Toca Ficha Dr Chrome Extension
**Audit date:** 2026-05-29
**Auditor:** Reviewer agent (Paperclip CHRA-2080, run c4592826-6d9f-4c18-a080-359c697ab04f)
**Repo:** chrislro/tocafichadr-extension — main @ ea3bd2686682d9e29a90b92b4f64a712f729413d

---

## Summary

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 3 |
| MEDIUM | 4 |
| LOW | 4 |
| PASS | 21 |

---

## Findings

---

### [HIGH] Clerk JWT auth bypassed by default on AI inference endpoints

- **File:** `backend/emr_automation/auth.py:376-416` and `backend/emr_automation/dashboard/routes.py:3604,3670,3709,3743,3791`
- **Issue:** The `require_extension_or_user` decorator — applied to all billable AI endpoints (`/api/transcribe`, `/api/suggest-cid`, `/api/format-soap`, `/api/format-atestado-letter`, `/api/soap-stream`) — has a bypass path controlled by `TOCAFICHADR_AUTH_REQUIRED`. When that env var is **not** set to `true` (the documented default state during rollout), requests with no `Authorization` header are accepted and processed with `g.user_id = None`. The CHANGELOG explicitly says the gate "stays OFF" at deploy time. This means any host that can reach the Mac Mini API can make unlimited AI inference calls — no authentication required — consuming the operator's OpenAI/Groq API budget.
- **Fix:** Set `TOCAFICHADR_AUTH_REQUIRED=true` in the production Mac Mini launchd plist immediately. Add a startup assertion in `app.py` that logs a `CRITICAL` warning when this env var is absent. As a code-level hardening, invert the default so that auth is ON unless explicitly opted out with `TOCAFICHADR_AUTH_REQUIRED=false`.
- **Status:** OPEN

---

### [HIGH] CORS default allows all origins (`*`) unless env var is set

- **File:** `backend/emr_automation/dashboard/app.py:113` and `backend/emr_automation/dashboard/routes.py:3473`
- **Issue:** `cors_origins = os.environ.get("CORS_ORIGINS", "*").split(",")` — if `CORS_ORIGINS` is not set in the environment, Flask-CORS allows cross-origin requests from **any** website to all `/api/*` endpoints. Combined with `TOCAFICHADR_AUTH_REQUIRED=false` (the current default), an attacker on any webpage can call API endpoints from a victim's browser. The `allow_private_network=True` flag additionally enables Private Network Access from external origins to the local Mac Mini API port when running in developer mode, widening the attack surface.
- **Fix:** Set `CORS_ORIGINS=chrome-extension://dldnbfjpobloegmdockjpbmpmgaahgan,chrome-extension://ijmooblmcfkgocpjjcaipimgeofpammn,https://api.tocafichadr.com.br` in the production environment. Add a boot-time `CRITICAL` log warning when `CORS_ORIGINS` is unset or contains `*`. The `api_readiness` endpoint already surfaces `"cors_origins": {"ok": "*" not in cors_origins}` — also check this at startup.
- **Status:** OPEN

---

### [HIGH] Clerk JWT token cached in `chrome.storage.local` (persists across browser restarts)

- **File:** `background/service-worker.src.js:180,294` and `popup/popup.src.js:184,284`
- **Issue:** The Clerk JWT (`authToken` and `authTokenExpiry`) is stored in `chrome.storage.local`, which **persists across browser restarts and device reboots**. The audit checklist requirement is `chrome.storage.session` (wiped on browser close). Any user or extension with access to the extension's storage can read the persisted JWT after the user has closed the browser. In a shared hospital Chrome profile, a token minted at the end of Shift 1 remains readable at the start of Shift 2 by a different doctor using the same Chrome profile. `chrome.storage.local` is also readable by any JavaScript running in the extension's origin if the extension has an XSS vulnerability.
- **Fix:** Migrate `authToken` / `authTokenExpiry` writes to `chrome.storage.session`. If the MV3 service worker restarts and `storage.session` is wiped, the popup's `_refreshStoredAuthToken` re-mints a token via the Clerk SDK — this is the correct recovery path. During migration: read from both `local` and `session`, then stop writing to `local` and add a cleanup step to remove legacy `local` keys on extension startup.
- **Status:** OPEN

---

### [MEDIUM] Multiple sensitive API endpoints lack any authentication

- **File:** `backend/emr_automation/dashboard/routes.py:2667,2691,2746,2810,2851,2865,2955,3003,3046,3444,3594`
- **Issue:** The following endpoints have no auth decorator (neither `@require_auth`, `@require_extension_or_user`, nor `@optional_auth`):
  - `GET /api/audit` — returns full audit log with `patient_id` values
  - `POST /api/audit/manual` — writes arbitrary entries to the audit log
  - `GET /api/audit/summary` — returns patient visit statistics
  - `GET /api/rx-stats` — returns prescription usage data
  - `POST /api/audit/export` — downloads the full SQLite audit log as JSON
  - `GET /api/config` — reads `config.ini` including EMR credentials
  - `POST /api/config` — rewrites `config.ini` with arbitrary values
  - `GET /api/readiness` — exposes configured-secrets status (Clerk, Stripe, OpenAI, DB)
  - `GET /api/selectors` — exposes DOM selector configs for G-Hosp automation
  - `POST /api/debug-log` — accepts arbitrary messages that may include patient names
  - `POST /api/error-log` — accepts extension telemetry
  
  With CORS set to `*` and the API exposed at `api.tocafichadr.com.br`, these are effectively publicly accessible to any HTTP client.
- **Fix:** Apply `@require_auth` to `/api/audit*`, `/api/rx-stats`, `/api/audit/export`, and `/api/config` (both verbs). Apply `@require_auth` to `/api/readiness` or restrict it to localhost. Add IP-based rate limiting to `/api/debug-log` and `/api/error-log`.
- **Status:** OPEN

---

### [MEDIUM] `/api/status` and `/api/patient` expose live patient PII with no authentication

- **File:** `backend/emr_automation/dashboard/routes.py:2025-2075` (status) and `2297-2322` (patient)
- **Issue:** `GET /api/status` returns `patient_name`, `patient_age`, `weight`, and `chief_complaint` of the currently loaded patient in real-time. `GET /api/patient` returns the same fields plus `intern_id` and full medication dosages. Neither endpoint has any authentication decorator. Anyone who can reach `api.tocafichadr.com.br/api/status` can observe the current patient's clinical data as the doctor navigates charts.
- **Fix:** Apply `@require_auth` to both endpoints. The dashboard frontend already sends the Clerk JWT cookie — this will not break the existing web UI.
- **Status:** OPEN

---

### [MEDIUM] `style-src 'unsafe-inline'` in extension CSP weakens XSS defense

- **File:** `manifest.json:28` and `manifest.prod.json:34` (documented as CSO-006)
- **Issue:** Both development and production manifests include `style-src 'self' 'unsafe-inline'` in the extension CSP. While `script-src` is locked to `'self'`, allowing unsafe inline styles weakens defense-in-depth. CSS injection via inline styles can enable data exfiltration through CSS attribute-selector + background-image techniques. The production `manifest.prod.json` acknowledges this in `_comments.content_security_policy_unsafe_inline`.
- **Fix:** Refactor popup and sidepanel components to use CSS class names instead of inline `style=""` attributes. Until completed, document this as a known risk and track it (already tracked as CSO-006 per `manifest.prod.json` comment and `NEXT_STEPS.md`).
- **Status:** OPEN (tracked as CSO-006)

---

### [MEDIUM] Debug log endpoint ships patient-context DOM snapshots without complete redaction

- **File:** `backend/emr_automation/dashboard/routes.py:2810-2848` and `sidepanel/sidepanel-prontuario.js:1962`
- **Issue:** `POST /api/debug-log` docstring explicitly states "payloads MAY include patient names (e.g., when the extractCompanionInfo diagnostic dumps an outerHTML snippet)." The `console.warn` in `sidepanel-prontuario.js:1962` ships `c._diag.outerHTML` (up to 400 chars) and `c._diag.bodyTextSnippet` (up to 2500 chars) — these can contain full patient names as rendered in G-Hosp. The `_scrubMessage()` in `console-shipper.js` redacts CID codes and URL params but does **not** redact patient names. The LGPD justification that "the log file lives only on the doctor's own Mac Mini" does not hold when the endpoint is reachable at `api.tocafichadr.com.br` with CORS `*`.
- **Fix:** (1) Remove `outerHTML` and `bodyTextSnippet` from the diagnostic `console.warn` in `sidepanel-prontuario.js`, or pass them through a function that strips patient-name-looking tokens. (2) Add patient name redaction to `_scrubMessage()` using the current `state.patientInfo.internId` and any displayed name. (3) Rate-limit `/api/debug-log` by IP.
- **Status:** OPEN

---

### [LOW] Clerk publishable key hardcoded in source files (informational)

- **File:** `background/service-worker.src.js:14` and `popup/popup.src.js:47`
- **Issue:** `pk_live_Y2xlcmsudG9jYWZpY2hhZHIuY29tLmJyJA` is hardcoded in source files committed to the repository. Clerk publishable keys are designed to be public (they identify the Clerk instance, not authenticate to it). However, a dev key is also mentioned in a comment at `popup/popup.src.js:44` (`pk_test_d29ya2luZy1jaG93LTAuY2xlcmsuYWNjb3VudHMuZGV2JA`), which exposes the development Clerk instance identifier.
- **Fix:** Low risk — publishable keys are intentionally public. Consider moving to build-time env substitution (`__CLERK_PUBLISHABLE_KEY__`) to avoid source changes when rotating instances. Remove the dev `pk_test_` key from the comment in `popup.src.js`.
- **Status:** OPEN (informational)

---

### [LOW] `chrome.storage.sync` used for `apiBaseUrl` — syncs across Google accounts

- **File:** `background/service-worker.src.js:40-70`
- **Issue:** `apiBaseUrl` is stored in `chrome.storage.sync`, which syncs to all Chrome browsers signed into the same Google account. An attacker with access to the user's Google account could set `apiBaseUrl` to an attacker-controlled server, causing all extension API calls (including audio recordings of patient consultations) to be sent to the attacker. The `API_HOSTS_ALLOWLIST` regex (`/^(?:api\.tocafichadr\.com\.br|[a-z0-9-]+\.trycloudflare\.com)$/i`) provides mitigation, but `*.trycloudflare.com` is a broad wildcard (any free Cloudflare tunnel URL).
- **Fix:** Validate `apiBaseUrl` against `API_HOSTS_ALLOWLIST` at **read** time on every fetch (not just at storage-write time). Remove `*.trycloudflare.com` from the allowlist in the production build — restrict it to `api.tocafichadr.com.br` only. The production manifest already removes `trycloudflare` host permissions; the runtime allowlist regex should match.
- **Status:** OPEN

---

### [LOW] `web_accessible_resources` allows any `*.clerk.accounts.dev` page to load extension resources

- **File:** `manifest.json:49-53`
- **Issue:** `auth-success.html` and `auth-success.js` are listed as web-accessible to `https://*.clerk.accounts.dev/*` — a wildcard that covers all Clerk development instances, not just the production tenant. Any Clerk user can create a dev instance at `something.clerk.accounts.dev` and load the extension's `auth-success.html` in an iframe.
- **Fix:** Restrict `web_accessible_resources` `matches` to the production Clerk domains only: `https://clerk.tocafichadr.com.br/*` and `https://accounts.tocafichadr.com.br/*`. Verify `manifest.prod.json` uses the narrower scope (the production manifest already removes dev `host_permissions`; confirm `web_accessible_resources` follows suit).
- **Status:** OPEN (may only affect dev manifest; verify production manifest)

---

### [LOW] `POST /api/config` accepts arbitrary INI section names (no auth, no allowlist)

- **File:** `backend/emr_automation/dashboard/routes.py:3046-3160`
- **Issue:** `api_config_save()` creates new `configparser` sections for any key in the submitted JSON that doesn't start with `_`. An unauthenticated caller can inject arbitrary INI content including a `[DEFAULT]` section that shadows other sections, or keys consumed by other config readers. Severity is limited because `config.ini` is only read by the local EMR process and the file is written atomically.
- **Fix:** Apply `@require_auth` (addressed by the unauthenticated endpoint finding). As defense-in-depth, add a section allowlist restricting accepted section names to known values (`emr`, `config`, `openai`, `rx_templates`, etc.).
- **Status:** OPEN

---

## Passed Checks

1. **No hardcoded API secrets in source files** — No `sk_live_`, `sk_test_`, OpenAI API keys, Supabase service keys, or Stripe secrets found in `.ts`, `.js`, `.py`, or `.json` source files. All secrets are loaded from macOS Keychain via `keychain_helper.py` or environment variables.

2. **No hardcoded internal IP addresses in production code paths** — `127.0.0.1:5050` appears only as a legacy migration fallback immediately superseded by `apiBaseUrl`. No Mac Mini internal IPs found in production code paths.

3. **`host_permissions` is appropriately scoped (not `<all_urls>`)** — Extension requests permissions only for `prbentogoncalves.g-hosp.com.br`, `api.tocafichadr.com.br`, and Clerk domains. Production manifest removes all dev/tunnel host permissions.

4. **No `.env.example` with real values** — No `.env.example` file found in the repository.

5. **`onMessage` listener validates `sender.id`** — `_isTrustedSender()` at `service-worker.src.js:376` checks `sender.id !== chrome.runtime.id`. Internal messages are only accepted from the same extension.

6. **`onMessageExternal` listener validates sender URL** — External message handler checks `senderUrl.startsWith('https://api.tocafichadr.com.br/')` and only accepts the `TOCAFICHADR_AUTH_COMPLETED` message type.

7. **Clerk JWT verification uses JWKS (cryptographically sound)** — `auth.py` uses `clerk_backend_api.Clerk.authenticate_request()` with JWKS-based signature verification. The 30-second clock skew tolerance is documented and intentional.

8. **Stripe webhook signature verified before processing** — `billing.py:handle_webhook()` calls `stripe.Webhook.construct_event()` with the webhook secret, rejecting payloads with invalid signatures.

9. **Clerk webhook signature verified via Svix** — `routes_clerk.py` uses `svix.webhooks.Webhook.verify()` for all Clerk webhook events.

10. **No `eval()` or `innerHTML` on dynamic data in extension UI** — Content scripts, popup, and sidepanel JS use safe DOM construction (`createElementNS`, `createElement`, `textContent`). Comments in `hud.js` and `sidepanel-prontuario.js` explicitly enforce this pattern.

11. **No `<all_urls>` content script** — Content scripts match only `https://prbentogoncalves.g-hosp.com.br/*`.

12. **File upload has size limits and minimum size check** — `/api/transcribe` enforces `_MAX_AUDIO_BYTES` (default 20 MB) and rejects files smaller than 100 bytes.

13. **No shell command injection risk via API routes** — Subprocess calls in `keychain_helper.py` use a fixed argv list with no user-controlled interpolation. All other subprocess usage is in non-API scripts.

14. **Rate limiting on billable endpoints** — `_rate_limit_response()` enforces per-user and per-IP rate limits, configurable via environment variables.

15. **Short-lived JWT with automatic refresh** — Clerk tokens expire in ~60 seconds; the popup refreshes every 30 seconds.

16. **Billing endpoints are fully authenticated** — `/api/billing/checkout`, `/api/billing/portal`, `/api/me/usage`, `/api/me/config` (GET and PATCH) all use `@require_auth`.

17. **AI inference endpoints require authentication when gate is enabled** — `/api/transcribe`, `/api/suggest-cid`, `/api/format-soap`, `/api/format-atestado-letter`, `/api/soap-stream` use `@require_extension_or_user` (auth required when `TOCAFICHADR_AUTH_REQUIRED=true`).

18. **Webhook idempotency prevents replay attacks** — `_acquire_webhook_lock()` uses a UNIQUE DB constraint on `(external_event_id, source)` to prevent duplicate processing.

19. **No Supabase credentials or client references found** — Architecture uses Clerk + PostgreSQL via SQLAlchemy. No Supabase client or service keys present.

20. **`api_action` does not execute arbitrary actions** — User-supplied `action` URL param is matched against `TEMPLATE_ACTION_CODES` allowlist and named constants. Unknown actions return an error without executing.

21. **Console shipper scrubs CID codes and URL params** — `shared/console-shipper.js` `_scrubMessage()` strips ICD-10 codes and URL query params from debug payloads before shipping to the backend.

---

## Out of Scope

- **Penetration testing of G-Hosp EMR** (`prbentogoncalves.g-hosp.com.br`) — third-party system.
- **Clerk hosted UI and JWKS infrastructure** — managed by Clerk.
- **Cloudflare Tunnel configuration** — network-layer controls not in scope for a code review.
- **Physical security of the Mac Mini** — LGPD at-rest data compliance is an operational concern.
- **Compiled bundle files** (`*.bundle.js`, `dist/`) — derived artifacts; source files were audited instead.
- **Test files** (`backend/tests/`) — test mocks may contain dummy secrets that are intentional.
