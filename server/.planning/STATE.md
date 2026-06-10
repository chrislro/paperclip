# Project State

## Project Reference

See: `.planning/ROADMAP.md` (v3.0 Clerk Migration milestone)

**Core value:** Pediatric EMR automation extension for G-Hosp (prbentogoncalves.g-hosp.com.br). Reduces 25-35 actions per patient to 4-6 via voice transcription, AI-generated SOAP notes, CID-10 suggestions, and DOM-driven prescription/discharge automation.
**Current focus:** Phase 005 — Production Clerk migration (v3.7.0). Complete.

## Current Position

Phase: 005 of 005 (production-clerk-migration) — **COMPLETE 2026-05-11**
Status: Manifest bumped to `v3.7.0`. Production Clerk instance live on `clerk.tocafichadr.com.br` + `accounts.tocafichadr.com.br` (DNS + SSL verified). Backend deployed to Mini at `a551ea9` with `sk_live_` secret and `CLERK_AUTHORIZED_PARTIES=` (empty, REQUIRED for chrome-extension/background SDK). Extension code pushed to `origin/main` at `a551ea9`. The atestado_print_not_found selector regression from G-Hosp DOM drift was also fixed in this phase (`adf047a`, first session commit).

Last activity: 2026-05-11 — 13 commits in one session. The day started with a clean atestado fix (loose regex caught a relabeled G-Hosp link on first retry), then turned into a multi-hour chase of the Clerk auth chain. Five sequential gaps had to be closed: dev-tier OAuth incompatibility (fixed by full prod migration), SW pk_test_ stale, SW missing `background:true`, Clerk dashboard "Native API" toggle off, and finally `CLERK_AUTHORIZED_PARTIES` configured (any non-empty list rejects the no-azp tokens that @clerk/chrome-extension/background SDK mints). Each fix was correct against its evidence, but the chain compounded — telemetry (`shared/clerk-tap.js` + `_swDebugLog` + auth.py azp diagnostic) turned out to be the highest-leverage commit because it transformed "guess and push" into "decode the ground-truth claim and act".

Progress: [██████████] 100% — production Clerk migration verified end-to-end.

### Next milestone

Phase 004 — Internal rebrand `pedbot` → `tocafichadr`. Still queued. 24 in-repo references to rename (keychain entry names, logger namespaces, `package.json` name). The Postgres DB + role rename + the `automation.keychain-db` URL value updates were done in the phase 003 verification window; phase 004 catches up the codebase. See `.planning/phases/004-internal-rebrand-pedbot-to-tocafichadr/` for the 4-plan breakdown.

Also queued (lower urgency, post-phase-005):
- **Production Clerk webhook setup** (Clerk dashboard → Webhooks → Add Endpoint → `https://api.tocafichadr.com.br/api/clerk-webhook` → user.created/updated/deleted → paste `whsec_` secret into plist). Without it, new doctor sign-ups need a manual `INSERT INTO users (...)` SQL. Alternative: implement JIT user provisioning in Flask auth middleware (simpler long-term, no dashboard config to drift).
- **Friendly auth-success page** — `_CLERK_FALLBACK` in popup.src.js still points to `CLOUD_URL + "/api/health"` which returns raw JSON after sign-in. Now that production tier allows the chrome-extension scheme, swap to `chrome.runtime.getURL("auth-success.html")` (already in `web_accessible_resources`).
- **Cleanup of DIAG/CLERKTAP telemetry** — commits `7870053`, `6c33002`, `0bc4c4b`, `6c32944` (the auth-debug-only logging on popup/SW). Leave the auth.py `azp/iss/sub` diagnostic in `a551ea9` permanently — it's the lowest-overhead Clerk-issue postmortem tool.

### Previous milestones

- Phase 002 (Clerk Migration v3.0): completed 2026-05-01. Replaced ~534 LOC custom auth with Clerk JWKS. `clerk_user_id` UNIQUE INDEX migration. Webhook endpoint. v3.0.0 release.
- Phase 001 (Security Review Remediation): completed 2026-04-22, 5/5 plans + 6/6 UAT (1 with minor limitation).

## Performance Metrics

**Velocity:**
- Total plans completed: 6 (phase 002 plans 02-00 through 02-05)
- Phase 002 elapsed: ~6 hours (single-day)
- Cross-repo coordination: 2 PRs in Pediatrics (#3 Clerk JWKS, #4 webhook), both squash-merged

**Phase 002 commit trail (extension)**: `a3b289a` planning → `8f2e665` popup → `78a7b47` SW → `80854a0` auth-section → `2f1f88f` CSP → `4f4cb27` CSP MV3 fix → `230f507` Fallback redirects → `3c6d1c4` privacy → `2fb289d` v3.0.0 release → `bbd0a9b` CHANGELOG → `088a052` submit walkthrough → `b60dd60` PLAN status update.

**Phase 002 commit trail (Pediatrics)**: `e1c88e7` Clerk JWKS (PR #3) → `04b456f` webhook (PR #4).

## Accumulated Context

### Decisions

- **2026-04-22** Extension-side hardening shipped pre-phase (`66f0f7a`): sender validation in SW, gist-discovered URL hostname allowlist, tightened manifest patterns to single G-Hosp subdomain, dropped `version_name` skew, manifest v2.5.2.
- **2026-04-22** Phase scope split: in-repo extension work stays in this phase; Flask-side auth / PII scrub / token rotation deferred to backlog (different repo, separate SSH-coordinated rollout).
- **2026-05-01** Strategic pivot to v3.0 Clerk migration before Chrome Web Store submission (`docs/STRATEGY-saas.md`). Held v2.6.9 Web Store submit; opened phase 002.
- **2026-05-01** v2.6.0-v2.6.3 productivity & security bundle shipped (CSP hardening, audio telemetry, retry-on-timeout, discharge date pre-fill, Bearer-auth gate on Flask). Documented in `docs/NEXT-STEPS.md`.
- **2026-05-01** Phase 002 D1: bundler decision — esbuild for popup only (single npm script, no config file). Rejected Vite (overkill), Plasmo (too heavy), vendored UMD (maintenance burden). Extended to SW too in 02-03 (same ESM constraint).
- **2026-05-01** Phase 002 D2: drop 14-day Pro trial in v3.0; reconsider in v3.1 if conversion metrics demand it.
- **2026-05-01** Phase 002 D4: keep `User.id` integer PK; add `clerk_user_id VARCHAR(255) UNIQUE` column. Non-breaking for FKs in `Subscription`, `UsageLog`, etc.
- **2026-05-01** Phase 002 D5: use `clerk_backend_api` Python SDK for JWKS verify (`authenticate_request()`); don't roll our own pyjwt + JWKS cache.
- **2026-05-01** Phase 002 D6: CSP for `extension_pages` — `script-src 'self' 'wasm-unsafe-eval'` only (MV3 rejects remote URLs in script-src). Cloudflare Turnstile + Clerk hosted UI go in `frame-src` and `connect-src` where remote IS allowed.
- **2026-05-01** Phase 002 D7 (post-implementation): use `signInFallbackRedirectUrl` not `signInForceRedirectUrl` in `clerk.load()` — Force variants require dashboard "Paths" allowlisting which Clerk dev tier doesn't expose; Fallback works without dashboard config.
- **2026-05-01** Phase 002 D8 (post-implementation): Mac Mini Clerk secret stored in `~/Library/LaunchAgents/com.pedbot.cloud-api.plist` `EnvironmentVariables` rather than Keychain. Reason: SSH context can't unlock login keychain (TCC restriction documented in 2026-04-24 OpenAI key incident); plist matches existing pattern (already holds `SECRET_KEY`); `sk_test_` blast radius is low; user can promote to Keychain on GUI later.
- **2026-05-01** Phase 002 D9 (post-implementation): Clerk Bot Sign-up Protection (Turnstile) MUST be OFF for chrome-extension origins. Turnstile's parent-origin check rejects `chrome-extension://` URLs in popup iframes. Disabled via Clerk dashboard. Auth gate is OFF on production through cutover window.
- **2026-05-11** Phase 005 D10: For chrome-extension auth via @clerk/chrome-extension/background SDK, `CLERK_AUTHORIZED_PARTIES` MUST be empty (env unset / blank / 'none'). Background-SDK tokens carry no `azp` claim, and Clerk Python SDK rejects no-azp tokens whenever ANY non-empty `authorized_parties` is configured (even with all known matching origins). Verified empirically by minting JWTs via Clerk admin API + curling backend with allowlist empty vs full. JWT signature, issuer (JWKS), exp/nbf, and session-status checks are sufficient defense.
- **2026-05-11** Phase 005 D11: Production Clerk OAuth providers (Apple, Google) deferred indefinitely. Email + magic-link suffices for this user base. Add later if a doctor explicitly requests it. The Clerk dashboard's "Setup checklist" nag is informational only — not blocking.
- **2026-05-11** Phase 005 D12: Production Clerk webhook NOT configured. New doctor sign-ups require manual SQL backfill for now. Acceptable for single-doctor deployment; revisit when onboarding 2nd doctor (configure webhook) or migrate to JIT provisioning in Flask auth middleware.
- **2026-05-11** Phase 005 D13: `@clerk/chrome-extension` SDK does NOT reliably share session state from popup/sidepanel context to service-worker context on production-tier instances. Verified via `_swDebugLog` telemetry: SW Clerk client loads (`clerkLoaded:true, clerkKeys:[session,user,...]`) but `clerk.session` stays null even after Native API enabled + background:true + syncHost set. Workaround: popup writes `chrome.storage.local.authToken` on each render (already did this), SW reads from there as fallback when its own SDK call returns null. Popup also added `setInterval(_refreshStoredAuthToken, 30000)` to keep storage fresh during long clinical sessions. This is the same explicit-bridge pattern v2.6.10 used pre-v3.0 SDK-only refactor.

### Pending Todos

None captured via `/gsd-add-todo` yet. Full in-repo task list lives in the five plan files under `.planning/phases/001-security-review-remediation/`.

### Blockers/Concerns

- **`P0-1-flask` (backend auth) is the highest-severity remaining exposure** and cannot be closed from this repo. Tracked in `.planning/phases/001-security-review-remediation/BACKLOG.md`. Until it ships, the Cloudflare Tunnel URL remains an open-relay risk for the production Flask backend on the Mac Mini.

## Deferred Items

None yet — this is the first milestone.

## Session Continuity

Last session: 2026-05-01 (full-day v3.0 release session)
Stopped at: 6/9 plans landed, tagged `v3.0.0`, deployed to Mac Mini, smoke-verified end-to-end through Cloudflare Tunnel. Three user-side plans remain: live-shift smoke, screenshots, Web Store submission.
Resume file: `docs/v3.0-WEB-STORE-SUBMIT.md` for the next steps.

### Ralph Loop cleanup (in flight)

`~/.claude/ralph-state.json` is engaged with task "v3.0 cleanup queue" (max 10 iterations, completion sentinel `RALPH_DONE_V3_CLEANUP`). Queue at `.planning/phases/002-clerk-migration/RALPH_TODO.md`. R-01 (this PLAN status block) and R-02 (this STATE update) shipped 2026-05-01 PM. Remaining items: R-03/R-04 Pediatrics tests, R-05 hostname allowlist centralization, R-06 NEXT-STEPS update, R-07 bundle-size measurement doc, R-08 phase 002 SUMMARY.md.
