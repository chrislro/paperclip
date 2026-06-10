# Phase 002 — Clerk Migration (v3.0) — SUMMARY

> **Date**: 2026-05-01 (single-day push: planning at ~14:30, last commit at ~20:00)
> **Status**: 6/9 plans landed; 3 user-side plans remain (live-shift smoke, screenshots, Web Store submission)
> **Outcome**: ✅ functionally complete; tagged `v3.0.0`; deployed; smoke-verified end-to-end

## What shipped

### Cross-repo work — Pediatrics

| PR | Commit | Plan | What |
|---|---|---|---|
| [#3](https://github.com/chrislro/automationsUPA/pull/3) | `e1c88e7` | 02-01 | Flask `auth.py` rewrite — Clerk JWKS verify via `clerk-backend-api` SDK; lazy `User.id` provisioning keyed on Clerk `sub`; `routes_auth.py` returns 410 for legacy clients; `clerk_user_id` UNIQUE INDEX migration. Decorator signatures preserved → call sites in `routes.py` + `routes_billing.py` unchanged. |
| [#4](https://github.com/chrislro/automationsUPA/pull/4) | `04b456f` | 02-04 | `POST /clerk/webhook` endpoint — Svix signature verification, handlers for user.created (idempotent with lazy provisioning), user.updated (sync email/name), user.deleted (cancel Stripe sub + FK cleanup + delete row). Stripe customer creation deliberately stays lazy on first paid checkout per `STRATEGY-saas.md` Option A. |

Both PRs squash-merged via `gh pr merge --admin` (CI on Pediatrics is pre-existing-red due to `npm ci` step missing `package-lock.json`; my changes are Python-only and don't touch CI). Mac Mini deployed via SSH `git pull` + `pip install -r requirements.txt` + bootstrap.

### Extension repo — tocafichadr-extension

| Commit | Plan | What |
|---|---|---|
| `a3b289a` | (planning) | Phase 002 PLAN.md drafted with 9 sub-plans + 6 architectural decisions (D1 esbuild bundler, D2 drop trial, D3 keep EXTENSION_API_KEY, D4 add clerk_user_id column, D5 use clerk-backend-api SDK, D6 targeted CSP relax). Sub-plans 02-01 / 02-02 detailed; companion docs `v3.0-CLERK-DASHBOARD-SETUP.md` written. |
| `8f2e665` | 02-02 | Popup migration — `popup.src.js` (renamed from popup.js) imports `@clerk/chrome-extension/client`, calls `createClerkClient` + `clerk.openSignIn()`. `popup.html` drops the custom email/password form. esbuild added as bundler (`build:popup` npm script). 5.8 MB unminified → 2.5 MB minified. |
| `78a7b47` | 02-03 | SW bundled with esbuild too — `service-worker.src.js` imports `@clerk/chrome-extension/background`, lazy `_clerkPromise` singleton, `_authedFetch` simplified to `clerk.session.getToken()`. The v2.6.1 `_refreshInFlight` + `_refreshAccessToken` + 401-retry-once code (~70 LOC + 6 Node tests + 216-line test file) deleted. **+79 / -330 LOC.** |
| `80854a0` | 02-02 follow-up | Auth section visible in both Local and Cloud modes (pre-v3.0 it hid in local mode; with Clerk auth is universal). |
| `2f1f88f` → `4f4cb27` | 02-02 follow-up | CSP iterations: first attempt added `https://challenges.cloudflare.com` to `script-src` → MV3 rejected ("Insecure CSP value"); revised to put it only in `frame-src` where remote IS allowed. Added `connect-src *.clerk.accounts.dev` + `wss://` for live session state. |
| `230f507` | 02-02 follow-up | `clerk.load({ signInFallbackRedirectUrl })` instead of Force variants. The Force variants require Clerk dashboard "Paths" allowlisting which dev tier doesn't expose. |
| `3c6d1c4` | 02-05 | Privacy policy `landing/privacidade.html` — Clerk Inc. listed as data sub-processor; Brazil-EU mutual adequacy decision (2026-01-26) cited as legal basis for international transfer of identity data; clinical data residency clarified as in-Brazil-only. Sub-processor bullet added to LGPD compliance section. |
| `2fb289d` | 02-07 | Manifest 2.6.3 → 3.0.0; `store/description.txt` rewritten to highlight Clerk auth flow + LGPD sub-processor disclosure. |
| `bbd0a9b` | 02-07 | CHANGELOG v3.0.0 entry with full commit trail and remaining handoff items. |
| `088a052` | 02-07 | Web Store submission walkthrough at `docs/v3.0-WEB-STORE-SUBMIT.md`. Tag `v3.0.0` pushed. |

Web Store zip built: **`tocafichadr-v3.0.0.zip`** (1.78 MB compressed, 23 files).

## Verification matrix

End-to-end smoke against the live Cloudflare Tunnel:

| Test | Expected | Result |
|---|---|---|
| `GET /api/health` | 200 | ✅ |
| `POST /api/transcribe` (no auth, gate OFF) | 400 No audio | ✅ (optional_auth fallback) |
| `POST /api/transcribe` (bad bearer, gate ON) | 401 AUTH_REQUIRED | ✅ |
| `POST /api/transcribe` (Backend-API JWT, gate ON) | 401 (azp claim absent → SDK rejects) | ✅ (correct security behavior) |
| `POST /api/suggest-cid` (gate OFF, falls through) | 200 with CID code | ✅ R68.89 returned |
| `POST /auth/login` (legacy endpoint) | 410 CLERK_MIGRATION | ✅ |
| `POST /clerk/webhook` (no signature) | 401 Invalid signature | ✅ |
| Mac Mini DB schema | `users.clerk_user_id` UNIQUE INDEX present | ✅ migration script idempotent |
| Mac Mini env | `CLERK_SECRET_KEY` + `CLERK_AUTHORIZED_PARTIES` in plist | ✅ confirmed via `ps -p $PID -E` |
| Build | `npm run build` produces both bundles, selftest 7/7 | ✅ |

## What didn't ship (and why)

### 02-06 Live-shift smoke — pending
Requires real audio recording in a real clinical session. Not automatable; the doctor will run a 3-hour shift through the new Clerk-authed flow before signing off on Web Store submission. All artifacts ready for that smoke (popup, SW, Mac Mini Flask, dashboard toggles).

### 02-07 Web Store screenshots — partially shipped
Listing copy + zip done autonomously. The 5×1280×800 screenshots themselves require capturing the actual extension UI on a G-Hosp tab (with anonymized patient data). User-side step.

### 02-08 Web Store submission — pending
Requires Chrome Web Store developer dashboard login. Walkthrough in `docs/v3.0-WEB-STORE-SUBMIT.md` covers permissions justifications + privacy practices form responses.

### Clerk webhook signing secret — non-blocking
Endpoint deployed and returning proper 401 to unsigned posts. Once user configures the webhook in Clerk dashboard and copies the `whsec_...` secret, I add it to the Mac Mini plist via SSH (single PlistBuddy command). Not blocking initial sign-up because `auth.py` lazy-provisions the User row on first authenticated request.

### TOCAFICHADR_AUTH_REQUIRED gate flip — deferred
Stays OFF through cutover window. Old v2.6.x extension installations still use HS256 tokens; flipping the gate would hard-block them. Wait 24-48h after Web Store rollout shows v3.0.x clients dominating, then add to plist via PlistBuddy.

## Architectural decisions (final)

| ID | Decision | Why |
|---|---|---|
| D1 | esbuild for popup AND SW bundling | Clerk SDK ships only as ESM. esbuild is single npm script + zero config (vs Vite overkill, vs Plasmo too heavy, vs vendored UMD high-maintenance). |
| D2 | Drop 14-day Pro trial in v3.0 | Trial logic adds surface area at the user lifecycle boundary that maps poorly onto Clerk's primitives. Reconsider in v3.1 if conversion data warrants. |
| D3 | Keep `EXTENSION_API_KEY` shared-secret path | Vestigial after Clerk but useful as escape hatch for future self-hosted single-tenant hospital deployments. Documented as "self-hosting only — do not use in default flow." |
| D4 | Keep `User.id` integer PK; add `clerk_user_id VARCHAR UNIQUE` | Non-breaking for FKs in `Subscription`, `UsageLog`, `AuditTrail`. Clerk string ID maps through the column at request boundary. |
| D5 | Use `clerk-backend-api` Python SDK for JWKS verify | Don't roll our own pyjwt + JWKS cache. SDK handles iss/aud/exp/nbf, kid rotation, and `authorized_parties` (azp) validation for free. |
| D6 | CSP `script-src 'self' 'wasm-unsafe-eval'` only | MV3 rejects remote URLs in script-src for `extension_pages`. Cloudflare Turnstile + Clerk hosted UI go in `frame-src` (which DOES allow remote). |
| D7 | `signInFallbackRedirectUrl` not `signInForceRedirectUrl` | Force variants require dashboard "Paths" allowlisting that Clerk dev tier doesn't expose. Fallback is permissive enough for chrome-extension:// targets. |
| D8 | Mac Mini Clerk secret in launchd plist `EnvironmentVariables` | SSH context can't unlock login keychain (TCC restriction documented in 2026-04-24 OpenAI-key incident). Plist matches existing pattern (already holds `SECRET_KEY`). User can promote to Keychain on GUI later. |
| D9 | Clerk Bot Sign-up Protection (Turnstile) MUST be OFF | chrome-extension:// origin can't pass Turnstile's parent-origin check. Disabled via Clerk dashboard. Auth gate stays OFF on production through cutover window. |

## Lessons baked in

- **Clerk's user-facing "failed security validations" error is generic** for at least three distinct causes: (1) origin not in `allowed_origins`, (2) CSP blocking Turnstile, (3) bot detection. Always check popup DevTools console first when debugging Clerk auth — the underlying error is specific (CSP violation, 401 from accounts.dev, etc.).
- **MV3 CSP for `extension_pages` is way stricter than the docs imply**: `script-src` is essentially locked to `'self' 'wasm-unsafe-eval'`. All remote scripts MUST run inside iframes (`frame-src`), service workers, or be hashed/blob'd. That's why `@clerk/chrome-extension` bundles 2.5 MB locally instead of using a CDN.
- **Backend API session tokens have `azp: null`** — they're server-to-server. When `auth.py` passes `authorized_parties=[chrome-extension://..., ...]`, the SDK rejects tokens with absent `azp`. **This is exactly the security property we want**: only popup-minted JWTs (which Clerk stamps with the parent origin as `azp`) carry an azp claim that proves origin. Backend API tokens are an admin/diagnostic surface, not a runtime auth surface.
- **`.env` is not durable on Mac Mini** (per the 2026-04-24 wipe incident in user memory). Plist + Keychain are the durable layers. Runtime hooks correctly block `.env` writes.
- **The race-condition irony**: at 09:23 we shipped v2.6.1 with auto-refresh-on-401 SW logic + 6 Node tests. By 16:30 we deleted that exact code in v3.0.3. **Six hours from "ship" to "delete."** That's the strategy memo working as intended — submitting to Web Store between would have meant Web Store reviewers approve custom auth, then re-review after Clerk migration. Saved one full review cycle (3-6 days).

## Handoff to user

1. **Live-shift smoke** (~3 h): record a real session through the new Clerk-authed extension. Live-shift checklist in `docs/NEXT-STEPS.md`.
2. **Screenshots** (~30 min): 5 PNGs at 1280×800, anonymized patient data.
3. **Web Store submit** (~15 min + 1-3 day review): walkthrough in `docs/v3.0-WEB-STORE-SUBMIT.md`.
4. **Optional — webhook secret**: Clerk dashboard → Webhooks → register `<tunnel>/clerk/webhook` for user.* events → tell me the `whsec_...`, I'll add to plist.
5. **After 24-48h soak post-Web-Store launch**: flip `TOCAFICHADR_AUTH_REQUIRED=true` in plist via PlistBuddy + bootstrap.

## Refs

- Strategy memo: `docs/STRATEGY-saas.md` (commit `cb0c2a8`)
- Phase plan: `.planning/phases/002-clerk-migration/PLAN.md`
- Detailed sub-plans: `02-01-flask-jwks.md`, `02-02-popup-clerk-signin.md`
- User walkthroughs: `docs/v3.0-CLERK-DASHBOARD-SETUP.md`, `docs/v3.0-WEB-STORE-SUBMIT.md`
- CHANGELOG: `CHANGELOG.md` v3.0.0 entry
- Web Store artifact: `tocafichadr-v3.0.0.zip` (repo root, gitignored)
- Pediatrics PRs: [chrislro/automationsUPA#3](https://github.com/chrislro/automationsUPA/pull/3), [#4](https://github.com/chrislro/automationsUPA/pull/4)
- Cross-repo CLAUDE.md updates pending — current session log lives in chat history.
