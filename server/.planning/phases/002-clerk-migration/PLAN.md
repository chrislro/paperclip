# Phase 002 — Clerk Migration (v3.0)

> **Status**: 6 of 9 plans complete (2026-05-01) · 3 user-side plans (06/07/08) pending
> **Tagged**: `v3.0.0` (extension `088a052`), `e1c88e7` + `04b456f` on Pediatrics main
> **Strategic source**: `docs/STRATEGY-saas.md` (commit `cb0c2a8`)
> **User walkthrough**: `docs/v3.0-CLERK-DASHBOARD-SETUP.md`
> **Web Store submission walkthrough**: `docs/v3.0-WEB-STORE-SUBMIT.md`
> **Cross-repo**: `Pediatrics/` (Flask backend) — PRs #3 + #4 squash-merged to main; deployed to Mac Mini via SSH bootstrap.

## Status as of 2026-05-01

End-to-end Clerk auth chain verified through the Cloudflare Tunnel:

- Mac Mini Flask `e1c88e7` (Clerk JWKS) + `04b456f` (webhook) deployed and running
- `CLERK_SECRET_KEY` + `CLERK_AUTHORIZED_PARTIES` (incl. `chrome-extension://dldnbfjpobloegmdockjpbmpmgaahgan`) in plist
- `data/tocafichadr.db` migrated with `clerk_user_id` UNIQUE INDEX (idempotent script)
- Bot Sign-up Protection: OFF; Username: OFF (Clerk dashboard, 2026-05-01 PM)
- Backend API smoke: bad token + gate ON → 401 AUTH_REQUIRED ✅; valid health → 200 ✅; webhook unsigned → 401 ✅
- v2.6.1 SW refresh code (`_refreshInFlight`/`_refreshAccessToken`/`_authedFetch` 401-retry, 6 Node tests) deleted
- Privacy policy lists Clerk as sub-processor + cites Brazil-EU adequacy
- Web Store zip: `tocafichadr-v3.0.0.zip` (1.78 MB compressed, 23 files)

Remaining: 02-06 (live-shift smoke — needs real recording), 02-07 (5 screenshots — needs visual capture), 02-08 (Chrome Web Store dashboard submit — needs login).

## Goal

Replace ~534 LOC of custom auth (`auth.py` + `routes_auth.py` + extension popup login form + SW refresh logic + werkzeug password hashing) with Clerk-issued JWTs verified against Clerk JWKS. **Block Chrome Web Store submission** on completion of this phase to avoid re-submitting on a custom-auth listing that gets superseded immediately.

## Success criteria (what must be TRUE)

1. **Flask `/api/*` endpoints accept only Clerk-issued JWTs** verified against Clerk JWKS (RS256), with `g.user_id` populated from the `sub` claim. The shared `EXTENSION_API_KEY` path stays as an emergency lever for self-hosting but is no longer the primary auth mechanism.
2. **Extension popup uses Clerk hosted UI for sign-in** — no custom email/password form. Sign-in/sign-up/password-reset/email-verification all flow through Clerk.
3. **Service worker uses `createClerkClient({ background: true })`** — the v2.6.1 `_authedFetch` + `_refreshAccessToken` + `_refreshInFlight` block is deleted (~120 LOC + 6 Node tests).
4. **Stripe customer is created on Clerk `user.created` webhook** and linked via `clerk_user_id` column on `User`. Existing `User` rows (1, the developer) are migrated by signing up in Clerk and linking by email.
5. **Privacy policy lists Clerk as data sub-processor** and cites the Brazil-EU adequacy decision (2026-01-26) for cross-border transfer legality.
6. **Live shift smoke passes 6/6** with Clerk auth (`docs/NEXT-STEPS.md` Live-shift checklist).

## Plans

| # | Plan | Owner | Status | Commit |
|---|------|-------|--------|--------|
| 02-00 | Clerk dashboard setup (creates the app, retrieves keys) | USER | ✅ done | dashboard `working-chow-0` + keys delivered to session |
| 02-01 | Flask JWKS verify (rewrite `auth.py`, deprecate `routes_auth.py`) | CODE — Pediatrics | ✅ done | `e1c88e7` (PR #3) |
| 02-02 | Popup migration to Clerk SignIn (esbuild bundler) | CODE — extension | ✅ done | `230f507` + CSP fixes `4f4cb27` / `2f1f88f` |
| 02-03 | Drop SW `_authedFetch` + `_refreshAccessToken` | CODE — extension | ✅ done | `78a7b47` |
| 02-04 | Clerk → Stripe webhook (`/clerk/webhook`) | CODE — Pediatrics | ✅ done | `04b456f` (PR #4, admin merge) |
| 02-05 | Privacy policy revision (Clerk sub-processor + Brazil-EU adequacy) | USER + COPY | ✅ done | `3c6d1c4` |
| 02-06 | Live-shift smoke with Clerk | USER | ⏸ pending real recording | — |
| 02-07 | Web Store screenshots + listing copy | USER + autonomous prep | ⚠️ partial — listing copy + zip done (`bbd0a9b`, `088a052`); 5 screenshots pending | `tocafichadr-v3.0.0.zip` |
| 02-08 | Submit to Chrome Web Store | USER | ⏸ pending dashboard login | — |

Total CODE effort spent: ~6 h end-to-end (estimate was 9-13 h — Clerk SDK + dashboard already-configured saved time).
Total USER effort remaining: ~2-3 h (live shift + screenshots + submission).

## Decisions / open questions

### D1 — Bundler for popup (decided: esbuild)

`@clerk/chrome-extension/client` ships only as ESM. Today's popup is vanilla JS with no build. Three options considered:

| Option | Setup cost | Ongoing cost | Verdict |
|--------|-----------|--------------|---------|
| esbuild — single npm script | ~30 min | ~zero (single CLI) | **Chosen** |
| Vite | ~1 h | low (config file) | Overkill for one popup file |
| Vendored UMD bundle from `npm pack` | ~30 min | high (manual update each Clerk SDK release) | Rejected |
| Plasmo framework migration | ~1 day | medium (full framework) | Rejected — not justified |

**esbuild integration plan**:
1. `npm i -D esbuild`.
2. `package.json` script: `"build:popup": "esbuild popup/popup.src.js --bundle --outfile=popup/popup.bundle.js --format=iife --target=chrome120 --sourcemap"`.
3. Rename current `popup/popup.js` → `popup/popup.src.js`. Add Clerk imports.
4. `popup.html` script tag points to `popup.bundle.js`.
5. `scripts/build-package.sh` runs `npm run build:popup` before zipping.
6. `.gitignore` `popup/popup.bundle.js` (build artifact).

### D2 — Trial period: keep or drop (decided: drop for v3.0)

See dashboard walkthrough open question. Drop the 14-day Pro trial in v3.0; add Clerk-driven trial logic in v3.1 if conversion metrics demand it. Simpler migration; fewer edge cases at the user lifecycle boundary.

### D3 — `EXTENSION_API_KEY` shared-secret path: keep or drop (decided: keep, deprioritized)

`require_extension_or_user` accepts EITHER a per-user JWT OR a shared `EXTENSION_API_KEY`. After Clerk, the shared key path becomes vestigial — there's no reason for the extension to use it once Clerk SignIn is the only login path. But it's useful as an escape hatch for future self-hosted EMR integrations (where the customer hospital wants its own key, not per-doctor accounts).

**Decision**: keep the path, but document it as "self-hosting only — do not use in default flow." Drops to a single decorator branch instead of two co-equal paths.

### D4 — User table identity: int PK vs Clerk ID (decided: keep int PK, add `clerk_user_id` column)

Clerk user IDs look like `user_2abcDEF...` (string). Two options for the `User` table:

| Option | Pros | Cons |
|--------|------|------|
| Replace `id INTEGER PK` with `clerk_user_id VARCHAR PK` | Simpler — Clerk is the only identity system | Breaks every FK relationship (`Subscription.user_id`, `UsageLog.user_id`, etc.) |
| Keep `id INTEGER PK`, add `clerk_user_id VARCHAR UNIQUE` indexed column | Non-breaking; FKs unchanged | Two identifiers to remember |

**Decision**: option 2. Add `clerk_user_id VARCHAR(255) UNIQUE INDEX NULLABLE` (nullable during migration, set to `NOT NULL` after backfill). Drop `password_hash` in the same migration. Backfill: sign up in Clerk → manually `UPDATE users SET clerk_user_id = '...' WHERE email = '...'` (one row).

### D5 — JWT validation library (decided: Clerk SDK Python)

Three options for verifying Clerk-issued JWTs in Flask:

| Option | LOC | Cache | Verdict |
|--------|-----|-------|---------|
| `clerk_backend_api` SDK with `authenticate_request()` | ~5 | Built-in JWKS cache | **Chosen** |
| Manual `pyjwt` + `jwks_client` from `python-jose` | ~30 | Manual TTL cache | More flexible but error-prone |
| `flask-jwt-extended` with custom JWKS provider | ~20 | Built-in via lib | Adds dependency for marginal benefit |

The SDK does the right thing out of the box: fetches JWKS, caches with TTL, handles `kid` rotation, validates `iss`, `aud`, `exp`, `nbf`. Don't roll our own.

**Open question**: confirm SDK's `authorized_parties` parameter accepts `chrome-extension://...` origins or if we need to set it as `chrome-extension://<extension-id>` exactly. Test with a deliberately-mismatched origin and note the rejection mode.

### D6 — CSP for extension_pages (open — needs decision during 02-02)

Current CSP: `script-src 'self'; object-src 'self'; base-uri 'none'`.

Clerk Chrome Extension SDK requires:
- `'wasm-unsafe-eval'` (for crypto operations)
- `connect-src` allowing the Clerk Frontend API origin (`https://*.clerk.accounts.dev`) and the publishable key origin

**Decision**: relax CSP to `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; base-uri 'none'; connect-src 'self' https://*.clerk.accounts.dev`. Verify against Clerk SDK requirements during 02-02 implementation. Note that Phase 001's tightened CSP (commit `f05561a`, GSTACK P2-3) is the constraint we're loosening — re-tighten only the parts Clerk doesn't require.

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Clerk Chrome Extension SDK doesn't support vanilla JS (without React) | Low — docs confirm vanilla path with `createClerkClient` + `clerk.openSignIn()` | Validate during 02-02; fallback is to bundle React only for popup (~50 KB extra) |
| Extension ID changes between dev (unpacked) and Web Store, breaking Clerk allowed-origins config | Medium | Use a stable manifest `key` from start; document the dev → prod transition |
| `chrome.storage.local` doesn't survive popup close — Clerk session won't persist | Low | `createClerkClient({ background: true })` in SW handles session persistence per Clerk docs |
| LGPD-side: putting auth data in Clerk (US/EU) requires explicit user consent | Low — Brazil-EU adequacy adopted 2026-01-26 | Privacy policy revision (02-05) addresses; legal re-read recommended |
| Two-deploy coordination (extension + Flask) breaks mid-flight | Medium | Ship Flask 02-01 first with optional_auth fallback so old extension still works; cut over extension only after Flask is verified |

## Rollout sequence

```
Day 1 (USER):       02-00 Clerk dashboard setup
Day 1 (CODE):       02-01 Flask JWKS verify + deploy to Mac Mini (gate: TOCAFICHADR_CLERK_REQUIRED=false initially, falls back to optional_auth)
Day 1 (CODE):       02-02 Popup migration with esbuild + 02-03 SW cleanup
Day 1 (USER):       Smoke: sign up via popup, hit /api/transcribe, verify clerk_user_id appears in audit log
Day 2 (CODE):       02-04 Stripe webhook
Day 2 (USER):       02-05 Privacy policy
Day 3 (USER):       02-06 Live shift
Day 4 (USER):       02-07 Screenshots + 02-08 Submit
+ 1-3 days:         Chrome Web Store review
```

Total wall time: ~1 week, mostly user-driven cadence (live shift + Web Store review).

## Cross-repo coordination

Pediatrics phase to be opened with parallel structure:
- `Pediatrics/.planning/phases/00X-clerk-jwks-migration/PLAN.md`
- Plans 02-01 + 02-04 land in Pediatrics, not here.
- Tag both phases with `link: tocafichadr-002` / `link: pediatrics-00X` in front-matter for traceability.

## Out of scope

- **Clerk Billing**: stays separate per `STRATEGY-saas.md`. Custom Stripe integration in `routes_billing.py` continues unchanged. Reconsider in v3.1.
- **Organizations / B2B accounts**: Clerk supports `clerkClient.organizations` for multi-doctor clinic accounts. Defer to v3.2.
- **Multi-EMR support** (clínicas + hospitais beyond G-Hosp): defer to v3.3.
