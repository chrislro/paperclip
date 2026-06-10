# Auth Edge Cases — Toca Ficha Dr. (Clerk Chrome extension)

| | |
|---|---|
| **Date** | 2026-05-29 (authored 2026-06-02) |
| **Auditor** | Engineer (Paperclip) — CHRA-2103 |
| **Parent epic** | CHRA-2082 |
| **Provider** | Clerk — extension `@clerk/chrome-extension ^3.1.21` (`package.json`); backend `clerk-backend-api` JWKS verify (`backend/emr_automation/auth.py`) |
| **App** | `tocafichadr-extension` — Chrome MV3 extension + Flask cloud API. Live on the Chrome Web Store. |
| **Branch** | `chra-2082/tocafichadr-extension-auth-edge-cases` |
| **Audited at** | `origin/main` HEAD `3f218f8` (static, this commit) |
| **Method** | Static analysis (this commit) + delegated runtime/dashboard verification (Rule #1) |

## Stack confirmation (matches parent issue)

Unlike the other CHRA-2082 children, the parent's stack label for this repo is **correct**: it is **Clerk**. Evidence:

- `package.json` → `"@clerk/chrome-extension": "^3.1.21"`
- Extension SW: `background/service-worker.src.js:6` → `import { createClerkClient } from '@clerk/chrome-extension/background';`, mounted `:115-125` with `background:true` + `syncHost`.
- Popup/sidepanel: `popup/popup.src.js:130-132` → Clerk hosted-UI sign-in (`buildSignInUrl`, `afterSignOutUrl`).
- Backend: `backend/emr_automation/auth.py:140-232` → `clerk_backend_api` `authenticate_request` (JWKS signature + issuer + exp/nbf + active-session validation).

This audit runs the **Clerk** 6-case matrix, adapted to the MV3-extension + Flask topology (no Next.js middleware; auth lives in the service worker + the Flask decorators).

## Architecture in one paragraph (why the matrix maps differently than the web apps)

Clerk's **hosted UI** (`accounts.tocafichadr.com.br`) owns sign-in/up. After sign-in, Clerk sets the `__client` cookie on the `syncHost` (`DEFAULT_API_BASE_URL`); the extension's `cookies` permission (`manifest.prod.json` CSO-005 note) lets the SDK mirror that session into extension storage. The short-lived **session JWT** is then mirrored to **`chrome.storage.local.authToken`** (+ `authTokenExpiry`) by two refreshers — the popup's `_refreshStoredAuthToken` (`popup.src.js:287`, every 30 s) and the SW alarm `_swRefreshStoredAuthToken` (`service-worker.src.js:279-308`). Every API call attaches `Authorization: Bearer <token>`; the Flask backend re-verifies it against Clerk JWKS on **every request** (`auth.py:140-232`). There is no app-managed refresh token — Clerk's SDK rotates the JWT.

---

## Summary matrix

| # | Case | Verdict | Severity | Disposition |
|---|------|---------|----------|-------------|
| 1 | Account-method conflict / account linking | ⚠️ VERIFY (Clerk Dashboard) | MED (conditional) | Delegated runtime/console (V1) |
| 2 | Session expiry | ✅ PASS — client surfaces re-login on 401; refresh machinery robust · ⚠️ gate-off caveat | LOW | Documented (gate-off) |
| 3 | Clear cookies/storage + relogin | ✅ PASS — identity + config are server-backed by `clerk_user_id` | — | — |
| 4 | Multi-tab / multi-context (popup ↔ sidepanel ↔ SW) | ✅ PASS (shared Clerk session) · ⚠️ SW session-sync is self-described flaky on prod tier | LOW | Delegated runtime (V1) |
| 5 | Token refresh | ✅ PASS — SDK rotation + storage-first read + clock-skew fix (`b5774e2` / #54) | — | — |
| 6 | Multi-device revocation / sign-out-everywhere | ⚠️ VERIFY (Clerk Dashboard) · gate-off ⇒ no hard server-side enforcement during cutover | MED (conditional) | Delegated runtime/console (V1) |

**No confirmed HIGH-severity code FAIL** (data loss / account lockout) was found. The one change that *would* have been a HIGH break — every Bearer request 401ing on `TOKEN_NOT_ACTIVE_YET` due to NTP drift — is already **fixed and shipped** (Case 5, `clock_skew_in_ms=30000`, commit `b5774e2`). So **no fix PR is opened from this audit.** The LOW code-hardening items get one consolidated follow-up issue (F1, F3). The conditional-MED items are Clerk **Dashboard** settings that cannot be read from code → delegated runtime/console (V1).

---

## Auth surface inventory

| Concern | Where | Notes |
|---|---|---|
| Extension Clerk client (UI) | `popup/popup.src.js:130-132`, `:263-264` | Hosted-UI sign-in; `addListener(_renderAuthState)` re-renders on auth change |
| Extension Clerk client (SW) | `background/service-worker.src.js:6,107-134` | `createClerkClient({ background:true, syncHost })` — `background:true` REQUIRED for DOM-less SW token issuance |
| Token mirror (storage) | `chrome.storage.local.authToken` + `authTokenExpiry` | Written by `popup.src.js:184,284` and `service-worker.src.js:304`; read storage-first by `_getAuthToken` `:189-216` |
| Token refresh (UI) | `popup.src.js:277-287` | `_refreshStoredAuthToken` every 30 s; clears storage if `!_clerk.session` (`:280`) |
| Token refresh (SW) | `service-worker.src.js:260-308` | `TOKEN_REFRESH_ALARM` keeps storage fresh when no UI open; no-op when SW session not synced |
| Token read preference | `service-worker.src.js:_getAuthToken` | **storage-first**, SDK fallback; 5 s pre-expiry buffer (`:204`) — see Case 5 |
| Bearer attach | `service-worker.src.js:149-152,788-790,825-827` | Every authed fetch sources the token from `_getAuthToken` (enforced by tripwire test) |
| Backend JWT verify | `backend/emr_automation/auth.py:140-232` | JWKS signature + issuer (`clerk.tocafichadr.com.br`) + exp/nbf + `is_signed_in`; 5 s JWKS-fetch timeout `:184-189` |
| `azp` validation | `auth.py:115-137,164-167` | Intentionally **disabled** (`authorized_parties=None`) — the chrome-extension background SDK mints tokens with **no `azp` claim**; enabling it 401s every request (verified 2026-05-11) |
| Clock skew | `auth.py:164` | `clock_skew_in_ms=30000` — Case 5, commit `b5774e2` (#54) |
| Auth decorators | `auth.py:347-422` | `require_auth` → 401; `optional_auth`; `require_extension_or_user` (gated) |
| Auth gate | `SECURITY.md:67`; `auth.py:413-421` | `TOCAFICHADR_AUTH_REQUIRED` **off** during v3 cutover → invalid/missing auth falls through to anonymous (no 401) |
| Sign-out cleanup | `popup.src.js:235` | `chrome.storage.local.remove(["authToken","authTokenExpiry","refreshToken","authUser"])` + `_clerk.signOut()` |
| User data store | `shared/user-config-client.js` | Server-backed `/api/me/config` (keyed to the authed user); `hydrate()` `:144`; migrates legacy `chrome.storage.sync` templates → server `:125-135` |
| Manifest | `manifest.prod.json:13-34` | `storage` + `cookies` perms; host perms to `api/clerk/accounts.tocafichadr.com.br`; locked CSP; no dev hosts (CSO-007) |
| Tests | `backend/tests/test_auth.py` (gate + provisioning + verify mocks; CI `pytest -q` `.github/workflows/backend.yml:39`); `scripts/test-auth-token-preference.js` (SW storage-first tripwire) | |

---

## Case 1 — Account-method conflict / account linking

**Scenario:** user signs up with email/password, later signs in with Google (or vice-versa) using the same email. Does Clerk link them into one account, or create a conflict / duplicate / lockout?

**Code findings:**
- Sign-in/up is delegated entirely to Clerk's **hosted UI** at `accounts.tocafichadr.com.br` (`popup.src.js:130-132` builds the hosted sign-in URL; the extension never renders its own credential form). Whatever identifiers / SSO connections the Clerk instance enables are what the user sees → **the conflict scenario is reachable.**
- Account-linking behavior (merge same-email accounts vs. block) is governed by **Clerk Dashboard → Configure → Account linking** ("Automatically link accounts with the same email") — **not** expressible in code.
- Backend impact if linking is OFF: the backend keys its `User` row on `clerk_user_id` (`auth.py:285`, `_resolve_user_id`). Two unlinked Clerk identities for the same person = **two distinct `clerk_user_id`s = two backend users**, so a doctor's plan/usage history would split across accounts (lazy-provisioned `free` on the second identity — `auth.py:312-321`). This is the concrete downside of linking-off here.

**Verdict:** ⚠️ **VERIFY (Clerk Dashboard).** Not determinable from code.
**Severity:** MEDIUM *if* account linking is disabled (duplicate accounts + plan/usage split) — conditional on dashboard state.
**Repro (for the runtime agent):**
1. On the Clerk **dev** instance, sign up `test+link@…` via email/password through the extension popup; trigger one authed API call so the backend lazy-provisions the user.
2. Sign out. Sign in with Google using the **same** email.
3. Observe: same `clerk_user_id` (linking ON, desired) vs. a new identity → a second backend `User` row (linking OFF, finding).

---

## Case 2 — Session expiry

**Scenario:** the Clerk session JWT expires; what happens to the extension UI and to in-flight API calls?

**Code findings — client (correct):**
- The popup's status mapper surfaces an explicit re-login prompt on a 401: `popup.src.js:31` → `if (status === 401) return 'Sessão expirada. Faça login novamente.'` (and 403 → "Acesso negado."). This is a **real, user-visible** expiry path — notably better than the silent/stuck states found in the conduta-rapida audit (CHRA-2102).
- Token freshness is actively maintained: popup `_refreshStoredAuthToken` every 30 s (`popup.src.js:287`) and the SW `TOKEN_REFRESH_ALARM` (`service-worker.src.js:277-308`) when no UI is open. Clerk's default session-JWT lifetime is ~60 s, so a 30 s refresh cadence keeps storage well inside the window.
- `_getAuthToken` rejects a stored token within 5 s of `authTokenExpiry` (`service-worker.src.js:204`) and falls back to the SDK, so an about-to-expire token isn't shipped mid-flight.

**Code findings — server (gate-off caveat):**
- With `TOCAFICHADR_AUTH_REQUIRED` **off** (current cutover default — `SECURITY.md:67`), `require_extension_or_user` does **not** 401 an expired/absent token; it falls through to anonymous (`g.user_id=None`, `auth.py:413-421`). The core EMR-automation endpoints therefore keep working after expiry; only per-user attribution/usage-limiting (`g.user_id`) is lost until the next sign-in. This is the intended "old installs keep working" behavior, not a bug.
- When the gate flips ON (post-cutover), the same expiry returns a 401 `AUTH_REQUIRED` (`auth.py:414-418`) → the popup's `:31` mapper shows the re-login message. So the client is **already wired** for the gate-on future.

**Verdict:** ✅ **PASS.** Client handles 401 gracefully; refresh machinery is robust; the gate-off behavior is documented/accepted.
**Severity:** LOW (no data loss; during cutover, expiry is largely invisible by design).
**Note (not a FAIL):** see Case 6 for the security implication of gate-off on revocation. Flipping `TOCAFICHADR_AUTH_REQUIRED` is the single switch that makes Cases 2 & 6 server-enforced; ensure it is tracked in the v3 cutover plan.

---

## Case 3 — Clear cookies / storage + relogin

**Scenario:** user clears cookies / extension storage, logs back in. Is their data restored?

**Code findings:**
- **Identity** is server-side: re-login through Clerk yields the same `clerk_user_id`; `_resolve_user_id` (`auth.py:272-344`) looks up the existing `User` by `clerk_user_id` (no duplicate created on relogin — covered by `test_auth.py::test_idempotent_on_second_call`).
- **User config / personal templates** are **server-backed**, not local-only: `shared/user-config-client.js` reads via `hydrate()` (`:144`) from `/api/me/config` and even **migrates** legacy `chrome.storage.sync` templates up to the server (`:125-135`). The popup re-hydrates personal fields on sign-in and subscribes to `onChange` (`popup.src.js:576-578`). → After a storage clear + relogin, config comes back from the server. This is the cloud-sync gap that conduta-rapida (CHRA-2102, finding F1) was **missing** — here it is actually wired.
- Sign-out deliberately clears the token mirror (`popup.src.js:235`); a subsequent relogin re-populates it via the refreshers.

**Verdict:** ✅ **PASS.** Both identity and user config survive a cookie/storage clear because they are keyed to / stored against the server-side `clerk_user_id`.
**Severity:** — (no finding).
**Caveat:** clearing storage logs the user out (token mirror + Clerk session gone) — they must re-authenticate via the popup, which is expected and non-destructive.

---

## Case 4 — Multi-tab / multi-context (popup ↔ sidepanel ↔ service worker)

**Scenario:** the extension runs three Clerk-aware contexts (popup, sidepanel, background SW). Signing in/out in one — does the others reflect it?

**Code findings:**
- All contexts share one Clerk session via `syncHost` + `chrome.storage`. The SW comment is explicit: *"The popup-side Clerk instance shares session state via chrome.storage, so signing out from the popup terminates SW-side session too"* (`service-worker.src.js:103-104`).
- UI reacts to auth-state changes through `_clerk.addListener(_renderAuthState)` (`popup.src.js:263-264`); `_renderAuthState` writes/refreshes the token mirror on every render (`:184`) and clears the avatar/usage chip on sign-out (`:234-236`).
- **Known weak spot (self-documented):** session propagation **into the SW** is flaky on the production tier — `service-worker.src.js:266-271` notes "SW Clerk session sync is the known-flaky piece (production tier has been observed not propagating session into the SW); when `clerk.session` is null this is a no-op and we rely on the popup as the canonical refresh point." The storage-first design (Case 5) is precisely what makes this survivable: even when the SW's own SDK session is null, it serves the popup-refreshed `chrome.storage.local.authToken`.

**Verdict:** ✅ **PASS** by design (shared session + storage-first token). ⚠️ Runtime confirmation recommended specifically for SW propagation.
**Severity:** LOW (the flaky path is mitigated by storage-first; worst case is a transient unauthed SW call, which under gate-off is served anonymously anyway).
**Repro (for the runtime agent):** sign in via the popup; open the sidepanel and trigger a transcription (SW-driven authed call) → expect 200. Sign out in the popup → the sidepanel/SW should stop attaching a Bearer and the popup avatar should reset. Record whether the SW picks up sign-out within one refresh cycle (≤30 s).

---

## Case 5 — Token refresh

**Scenario:** does the session token refresh transparently, and stay valid across the verify path?

**Code findings:**
- **SDK rotation:** Clerk (`background:true`) rotates the session JWT natively; v3.0.3 dropped the old custom `_refreshAccessToken` dance (`service-worker.src.js:3-4,97-101`).
- **Storage-first read (the 2026-05-25 fix):** `_getAuthToken` reads `chrome.storage.local.authToken` **before** the SDK (`service-worker.src.js:176-216`). This fixed a live regression where the SW's cached SDK token returned 401 on `/api/soap-stream` in the same second the sidepanel's freshly-refreshed storage token returned 200 (`/api/transcribe`). Guarded by tripwire test `scripts/test-auth-token-preference.js` ("storage path MUST be tried before SDK path").
- **Clock-skew fix (the headline shipped item):** `auth.py:164` → `clock_skew_in_ms=30000`. Commit **`b5774e2`** — `fix(auth): bump Clerk JWT clock_skew_in_ms from default 5s to 30s (#54)`, dated 2026-05-25. The SDK default of 5 s rejected every freshly-minted token with `TOKEN_NOT_ACTIVE_YET` when the Mac Mini host was ~6.8 s behind `time.apple.com` (the JWT `nbf` claim sat in the host's future). 30 s is a 6× buffer on the measured drift.
  - **Pre-finding hash reconciliation:** the parent issue cited commit `0e43796` for this fix; the **actual shipped commit is `b5774e2`** (PR #54), confirmed via `git log -S 'clock_skew_in_ms' -- backend/emr_automation/auth.py`. Same change, corrected hash. → code-level **PASS**.
- **Fresh server-side validation:** the backend re-verifies signature/issuer/exp on **every** request (`auth.py:140-232`), so there is no stale-entitlement window of the kind the web apps have (no JWT-embedded entitlement claim is trusted at an edge here; usage/plan is read from the DB per request).

**Verdict:** ✅ **PASS.** Rotation + storage-first preference + clock-skew tolerance are all shipped and test-guarded.
**Severity:** — (no finding).

---

## Case 6 — Multi-device revocation / sign-out-everywhere on password change

**Scenario:** user is signed in on device A and B; on B they sign out everywhere / change password. Is device A revoked? Is access re-checked?

**Code findings:**
- "Sign out of all other sessions on password change" is a Clerk **Dashboard** setting (User & Authentication), **not** code. The extension uses the default `_clerk.signOut()` (`popup.src.js:70,235`) with **no** custom `signOut({ sessionId })` and **no** multi-session config (grep: none).
- **Server-side enforcement is gated by `TOCAFICHADR_AUTH_REQUIRED`.** With the gate **off** (current cutover default), a revoked session has **no hard server-side effect**: once the revoked token can no longer be refreshed (Clerk stops issuing), the SW/popup ship no Bearer (or a stale one that fails verify), and `require_extension_or_user` simply **falls through to anonymous** (`auth.py:413-421`) — so device A keeps using the core EMR-automation endpoints, just unattributed. Usage-limiting / billing are the only things that stop applying.
  - When the gate flips **on**, the same revoked/expired token returns 401 `AUTH_REQUIRED`, and the propagation delay is bounded by the token lifetime (≤ ~60 s) plus the verify-every-request model (`auth.py:140-232`).
- This is the **same gate-off tradeoff** as Case 2, surfaced on the revocation axis. It is documented and accepted for the cutover window (`SECURITY.md:67`), but it means **"sign out everywhere" is not currently a security control on the extension's data path** — only an attribution one. Worth stating plainly in the launch-readiness checklist.

**Verdict:** ⚠️ **VERIFY (Clerk Dashboard + live multi-device).** Server enforcement is correct in code but **neutralized while the gate is off**.
**Severity:** MEDIUM (conditional) — the data-path exposure exists only until the gate flips; core automation runs against the doctor's own G-Hosp session, so the blast radius is usage/billing attribution, not patient-data access.
**Repro (for the runtime agent):**
1. Sign in on two browser profiles (A, B) with the same Clerk account; confirm authed API calls 200 from both.
2. On B, change the password (or use Clerk "sign out of all devices").
3. On A, trigger an authed call. With the gate **on** → expect 401 + the popup re-login prompt within the propagation window; record the delay. With the gate **off** → expect the call to still succeed anonymously (documents the cutover gap).

---

## Findings & follow-ups

| ID | Case | Finding | Severity | Disposition |
|----|------|---------|----------|-------------|
| **F1** | 2, 5 | Session JWT is mirrored to **`chrome.storage.local`** (persists across browser restarts), not `chrome.storage.session` (in-memory). This is the discrepancy the parent issue / Rule-7 audit flagged. **Assessment: acceptable & deliberate** — it is the storage-first fix for the 2026-05-25 401 regression, the token is short-lived (≤60 s, refreshed every 30 s), other extensions cannot read it (per-extension isolation), and the durable credential is Clerk's own SDK storage anyway, so downgrading to `storage.session` reintroduces the 401 with negligible exposure gain. Optional hardening only. | LOW | Follow-up issue (consolidated) |
| **F2** | 2, 6 | Backend gate `TOCAFICHADR_AUTH_REQUIRED=false` during the v3 cutover → expiry/revocation are **not server-enforced** on the extension data path (attribution only). **Known & accepted** (`SECURITY.md:67`). | LOW (accepted) | Documented; flip tracked by the v3 cutover plan (not a new issue) |
| **F3** | 5 | Diagnostic block `auth.py:192-215` decodes & logs rejected tokens' `azp`/`iss`/`sub` (`sub` truncated to 30 chars) on every auth failure. Local-only per the LGPD note, and the code comment says "Remove once auth chain is stable." Minor log-hygiene item — strip before flipping the gate / at next auth touch. | LOW | Follow-up issue (consolidated) |
| **V1** | 1, 4, 6 | Clerk **Dashboard** config (account linking; "sign out of all sessions on password change") + live multi-device & SW-session-propagation timing require a Clerk dev instance + console. Unverifiable from code. | — | **Delegated runtime/console** (Jarvis/Hermes) |

No HIGH-severity code FAIL → **no fix PR from this audit.** F1+F3 → one consolidated LOW follow-up issue. V1 → one delegated runtime child issue.

---

## Delegated runtime checklist (Jarvis / Hermes — Clerk **dev** instance, seeded accounts)

Per Rule #1, runtime/console execution is delegated, not asked of a human. Use a Clerk **dev** instance (`pk_test_…`) + a seeded test account, and the extension loaded unpacked against the dev manifest.

- [ ] **Case 1 — account linking:** confirm Dashboard → Account linking ("automatically link same-email accounts"); run the email↔Google same-email repro; confirm one `clerk_user_id` (and therefore one backend `User` row).
- [ ] **Case 4 — multi-context:** popup sign-in → sidepanel authed call 200; popup sign-out → SW stops attaching Bearer within ≤30 s. Specifically stress the **SW session-propagation** path called out as flaky (`service-worker.src.js:266-271`).
- [ ] **Case 6 — revocation:** confirm Dashboard "sign out of all sessions on password change"; run the two-device password-change repro; record propagation delay. Run **once with the gate off and once with `TOCAFICHADR_AUTH_REQUIRED=true`** to demonstrate the cutover difference.
- [ ] **Case 2/5 — timing:** observe real session-expiry + rotation across a popup-closed interval (SW alarm refresh) and confirm no 401 floor.

## App-Store-submission impact

**None.** This is the **web/extension** product (`tocafichadr-extension`, Chrome Web Store), entirely separate from the iOS app (`chrislro/PlantonistaPro`) whose App Store submission this does not touch.

## Routing note

CHRA-2092 routed Chrome-MV3 *feature* work (Sentry/Session-Replay) on this repo to the **Frontend Dev** agent. This task is a **static security audit** (read + one doc), which is squarely Engineer scope; the PR is routed to **Reviewer** because auth is security-sensitive. The MV3-build-specific concerns that motivated the Frontend-Dev routing (webpack DefinePlugin DSN injection, PHI-masked replay) do not apply to a read-only audit.
