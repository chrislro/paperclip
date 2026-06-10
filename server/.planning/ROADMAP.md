# Roadmap: Toca Ficha Dr.

## Overview

Pediatric EMR automation extension for G-Hosp (`prbentogoncalves.g-hosp.com.br`). Active production use at v2.5.2. This roadmap covers the post-review hardening milestone — not the full product roadmap (that lives in `docs/superpowers/plans/`).

## Current Milestone: v3.0 Clerk Migration (SaaS foundation)

Strategic pivot recorded in `docs/STRATEGY-saas.md` (commit `cb0c2a8`). Goal: replace ~534 LOC of custom auth with Clerk-issued JWTs before Chrome Web Store submission, so we don't pay two review cycles (custom auth → Clerk auth) for the same product.

Previous milestone (v2.5.x Security & Quality Hardening) closed 2026-04-22 with phase 001 complete. v2.6.x productivity work continued in parallel and is summarized in `docs/ROADMAP-v2.6-to-v2.9.md`.

## Phases

- [x] **Phase 001: Security Review Remediation** — in-repo P0-3 + P1 items from the 2026-04-22 review shipped across commits `02f3ab3`, `add93de`, `f3bf0d8`, `1d22cce`, `fe17eee`. Flask-side items remain in BACKLOG.
- [ ] **Phase 002: Clerk Migration (v3.0)** — open 2026-05-01. See `.planning/phases/002-clerk-migration/PLAN.md`. Cross-repo (Pediatrics + extension); blocks Web Store submission.

## Phase Details

### Phase 001: Security Review Remediation
**Goal**: Close P0-3 (SW URL allowlist) and five P1 correctness findings that are fully self-contained in the extension repo. Remaining items (P0-1 Flask, P0-4 discharge verification, P0-5 SOAP plaintext, P1-6 SPA observer, P1-11/P1-12 popup UX) are tracked but deferred to future phases or a different repo.
**Depends on**: Nothing (this is the first GSD phase for this milestone)
**Requirements**: P0-3, P1-1, P1-2, P1-4, P1-5, P1-7 (finding IDs from REVIEW.md serve as requirement IDs for this milestone)
**Success Criteria** (what must be TRUE):
  1. `TOCAFICHADR_FETCH` rejects URLs outside the configured `apiBaseUrl` origin + `/api/` path allowlist, and always attaches the stored bearer token server-side (never trusting caller-supplied Authorization).
  2. `_handleTranscribe` returns an `ok` field derived from `resp.ok`, so content-script callers can check success without depending on Flask's JSON shape.
  3. `waitFor` and `_waitForDialogContent` cancel their timeouts when they resolve — no more orphan rejections polluting `/api/error-log`.
  4. An `ended` event on the audio track triggers an immediate `stop()` when recording, so mic-death is surfaced fast instead of producing silent bad recordings.
  5. "Finalizar Receita" cannot be double-submitted by rapid clicks; the `chrome.storage.onChanged` listener is removed when the HUD is torn down.
**Plans**: 5 plans

Plans:
- [x] 01-01: Service-worker URL allowlist in `_handleFetch` + normalize `_handleTranscribe` return shape (P0-3 + P1-2) — commit `02f3ab3`
- [x] 01-02: Cancel `waitFor` / `_waitForDialogContent` timeouts on resolve (P1-1) — commit `add93de`
- [x] 01-03: Observe audio `track.ended` to fail fast on mic stream death (P1-4) — commit `f3bf0d8`
- [x] 01-04: Mutex on Finalizar Receita + prescription-template click paths, cleanup storage.onChanged listener (P1-5 + P1-7) — commit `1d22cce`
- [x] 01-05: Popup storage.sync error surfacing + id-keyed template input handlers (P1-11 + P1-12) — commit `fe17eee`

### Phase 002: Clerk Migration (v3.0)
**Goal**: Replace custom HS256 JWT auth with Clerk-issued JWTs verified against Clerk JWKS, before Chrome Web Store submission. Eliminates ~534 LOC of custom auth code, gains email verification + password reset + MFA + LGPD-grade audit log "for free."
**Depends on**: USER does Clerk dashboard setup (`docs/v3.0-CLERK-DASHBOARD-SETUP.md`) — yields publishable key, secret key, JWKS URL, Frontend API URL.
**Requirements**: from `docs/STRATEGY-saas.md` decision matrix — Clerk auth, Stripe ↔ Clerk linkage, privacy policy revision, no Web Store submission until Clerk-backed listing is ready.
**Success Criteria** (what must be TRUE):
  1. Flask `/api/*` accepts only Clerk-issued JWTs (RS256 verified against Clerk JWKS); `g.user_id` populated from JWT `sub`.
  2. Extension popup uses Clerk hosted UI for sign-in; no custom email/password form.
  3. SW `_authedFetch` + `_refreshAccessToken` (the v2.6.1 work) deleted; replaced by `createClerkClient({ background: true }).session.getToken()`.
  4. Stripe customer linked to Clerk user via `clerk_user_id` column on `User`, populated by `/clerk/webhook` on `user.created`.
  5. Privacy policy lists Clerk as data sub-processor and cites Brazil-EU adequacy (2026-01-26).
  6. Live-shift smoke 6/6 with Clerk auth.
**Plans**: 9 plans (02-00 through 02-08; 4 in this repo, 2 in Pediatrics, 3 USER-driven)

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 001. Security Review Remediation | 5/5 | Execution complete | 2026-04-22 |
| 002. Clerk Migration | 0/9 | 02-00 in-progress (USER) | — |

## Already shipped (pre-phase)

- **`66f0f7a`** — Extension-side hardening: SW sender validation (P0-2), gist-discovered URL hostname allowlist (P0-1 ext side), tightened `host_permissions`/`content_scripts` to `prbentogoncalves.g-hosp.com.br`, dropped `version_name`, bumped to 2.5.2.

## Out of scope for this milestone

- Flask-side items (P0-1 backend auth, P1-8 token rotation, P1-9 PII scrub, P1-3 server error translation) — tracked in `.planning/phases/001-security-review-remediation/BACKLOG.md`. Live in `/Users/admin/Dev/Pediatrics/`, not this repo.
- P0-4 (discharge verify rework), P0-5 (SOAP plaintext DOM reconstruction), P1-6 (observer URL gate) — deferred because they need careful live-shift verification or coordinated Flask changes. Tracked in BACKLOG.md for a follow-up phase.
- Cloud-side product work (billing, teams, Stripe) — unrelated to this milestone.
- Named Cloudflare tunnel / custom domain — infra task tracked in `docs/MVP-STATUS.md`.

## Exit criteria for the milestone

1. All 5 phase-001 plans complete with commits referencing the finding IDs.
2. Flask backend requires Bearer auth on `/api/transcribe`, `/api/health`, `/api/selectors`, `/api/audit/*`, `/api/error-log` (P0-1 Flask — done in the Pediatrics repo, documented in BACKLOG).
3. A manual smoke test on live G-Hosp confirms: voice-record → SOAP → prescription template flow works end-to-end.
4. `scripts/build-package.sh` produces a valid Chrome Web Store zip.
