# Toca Ficha Dr. — SaaS strategy decision (Clerk + Stripe)

> **Status**: 2026-05-01 · Strategic memo · Read alongside `docs/ROADMAP-v2.6-to-v2.9.md`.
> **Question that triggered this**: "this is supposed to be a product to sell on the Chrome Web Store, not a product just for myself to use — should auth be Clerk and payments Stripe?"

## TL;DR

**Yes, migrate to Clerk for auth before Chrome Web Store submission.** Keep Stripe for payments — the existing 209 LOC Stripe integration in `Pediatrics/emr_automation/billing.py` + `routes_billing.py` works and you don't need Clerk Billing yet. Wrap the migration into a new milestone **v3.0** that lands *before* `2.6.9` (Web Store submit).

This memo explains why, with sources.

## Current state of the world (verified 2026-05-01)

| Layer | Today | Code size | Location |
|------|------|-----------|----------|
| Auth | Custom JWT (HS256, 24 h access + 30 d refresh) with werkzeug-hashed passwords | 164 LOC `auth.py` + 81 LOC `routes_auth.py` | `Pediatrics/emr_automation/` |
| Billing | Custom Stripe (Checkout, webhooks, free/trial/pro tiers) | 160 LOC `billing.py` + 49 LOC `routes_billing.py` | `Pediatrics/emr_automation/` |
| User store | PostgreSQL `users` table (`email`, `password_hash`, `plan`, `stripe_customer_id`, `trial_ends_at`) | 79 LOC `models.py` | `Pediatrics/emr_automation/` |
| Extension auth | Popup login → `chrome.storage.local.authToken` + `refreshToken`; SW reads `authToken`; v2.6.1 added auto-refresh | ~120 LOC across `popup.js`, `service-worker.js` | `tocafichadr-extension/` |
| Multi-tenant secrets | Per-key Mac Mini Keychain entries (`pedbot-stripe-secret-key`, `pedbot-stripe-pro-price-id`, etc.) | `keychain_helper.py` | `Pediatrics/` |

**Total custom auth + billing: ~534 LOC** that you maintain forever. Most of which Clerk does for free.

**Clerk is already in your stack** (verified — `Dev/conduta-rapida` has `@clerk/nextjs ^7.0.7` configured), so this isn't a new vendor — it's reusing one you already chose for another revenue product.

## Why Clerk *for a sellable Chrome extension specifically*

Three reasons that don't apply to a solo-use tool but do apply once you're selling licenses:

### 1. Chrome extension MV3 service workers + auth tokens is a known sharp edge — and Clerk has the official SDK for it

When the popup or side panel closes, normal Clerk session refresh stops. By configuring `createClerkClient()` to run in a background service worker, you ensure the session token stays fresh — that's what their `@clerk/chrome-extension` package is built for.

This is *exactly* the problem you just spent 2-3 hours solving in v2.6.10 (the auto-refresh-on-401 SW logic). Clerk's SDK obviates that code. You'd delete `_authedFetch`, `_refreshAccessToken`, and `_refreshInFlight` from `service-worker.js`.

### 2. Email verification + password reset + MFA are required for clinical SaaS, hard to build, easy to misbuild

A Brazilian doctor signs up → forgets password → email sent → reset link clicked → token validated → password updated → audit log entry written. That's ~6 endpoints + 3 email templates + a transactional email provider (Postmark/Resend) + token store + rate limiting on each step. Probably 500-1000 LOC and 2 weeks to do *securely*.

For a clinical product, you'll also need:

- **MFA / 2FA** — the LGPD applies to health data classified as "sensitive personal data" (Article 11), which raises the bar for access control. Practically, you want TOTP at minimum.
- **Email verification before access** — to prove the @hospital.gov.br address is real.
- **Account lockout on failed attempts** — Devise-style, which you already saw in the `check_emr.py` lockout incident memory.

Clerk gives you all of these with documented configurations and audit-ready logs.

### 3. Free tier covers everything you'll do for years

Clerk's free tier is **50,000 MAU as of 2026** (raised from 10K). You will not hit this. Marginal cost of adding Clerk: $0.

Comparison context: Auth0 charges from the first user beyond 7K, and most teams hit billing within 3 months of launch.

## What stays the same

- **All EMR automation logic** (`dom-engine.js`, `hud.js`, content scripts, audio capture, VAD, CID database) — Clerk doesn't touch any of it.
- **The Stripe account itself** — keep using it. The question of whether to use Clerk Billing or your existing custom Stripe code is *separate* (see next section).
- **The Flask backend for `/api/transcribe`, `/api/suggest-cid`, `/api/format-soap`** — they just verify Clerk-issued JWTs against Clerk's JWKS instead of your own HS256 secret.
- **Whisper / SOAP / CID pipeline** — untouched.
- **Selectors, BUNDLED config, atestado flow, prescription flows** — untouched.

## What migrates

| File | Today | After Clerk |
|------|-------|-------------|
| `auth.py` (164 LOC) | HS256 JWT encode/decode + 3 decorators | ~30 LOC: verify Clerk JWT against JWKS, populate `g.user_id` from `sub` claim |
| `routes_auth.py` (81 LOC) | `/auth/register`, `/auth/login`, `/auth/refresh` | DELETE — Clerk hosted UI handles all three |
| `popup.js` login section | Custom email/password form, fetch `/auth/login`, store `authToken` | Drop in `<SignIn />` from `@clerk/chrome-extension` |
| `service-worker.js` `_refreshAccessToken` + `_authedFetch` (just shipped 2.6.10) | Custom 401-catch + refresh + retry | DELETE — `createClerkClient().getToken()` returns a fresh token; Clerk handles rotation |
| `models.py` `User` | `password_hash`, `email`, `plan`, `stripe_customer_id`, `trial_ends_at`, `created_at` | Keep `User` table but `clerk_user_id` (string) becomes the primary identity link; drop `password_hash`. Sync via Clerk webhook (`user.created`, `user.deleted`). |
| `keychain_helper.py` JWT secret | `pedbot-secret-key` for HS256 signing | DELETE that entry — Clerk publishes JWKS publicly |

Net delta: **delete ~280 LOC of auth code**, write ~80 LOC of Clerk integration. Net repository simplification.

## Clerk Billing vs keep-existing-Stripe

This is a separate decision from auth. Two options:

### Option A — Keep your existing Stripe code (recommended for v3.0)
- 209 LOC of custom code in `billing.py` + `routes_billing.py` + the `Subscription` model is already working. You have the webhook plumbing, the trial logic, the usage metering.
- Your Mac Mini Keychain has `pedbot-stripe-*` entries already populated.
- Cost: just Stripe fees (no Clerk Billing 0.7% surcharge).
- Cost of leaving it: maintenance burden for a product surface (billing) that doesn't change often.

### Option B — Migrate to Clerk Billing (defer to v3.1+)
- Clerk Billing is built on top of Stripe — Clerk handles the upgrade/downgrade UI (`<PricingTable />`), free trials, annual billing, plan transitions; Stripe handles the actual payments.
- Cost: 0.7% per transaction *on top of* Stripe's normal fees (e.g., for R$49/mo Pro, that's ~R$0.34/mo extra per subscriber).
- Saves ~209 LOC of custom code.
- Trade-off: at low subscriber count, the engineering savings dwarf the 0.7%. At ~500+ subscribers, you may want to reconsider.

**Recommendation**: stay with Option A through v3.0/v3.1. Reconsider Clerk Billing when subscriber count crosses ~50 (when adding a new tier, plan change, or trial-extension feature would otherwise mean editing `billing.py`).

## LGPD considerations (verified 2026-05-01)

- LGPD has been in force since 2020; administrative penalties since Aug 2021.
- **Brazil + EU mutual adequacy decision was adopted on Jan 26, 2026** — meaning data transfers between Brazil and the EU are now legally streamlined. This matters because Clerk's data centers are in the US/EU. Pre-adequacy, hosting Brazilian doctors' authentication data outside Brazil required SCCs and a DPIA. Post-adequacy, this is materially simpler.
- **Health data is "sensitive personal data" under LGPD Article 11**, which raises consent and access-control bars. MFA + audit logging + breach notification are practical requirements; Clerk provides all three.
- **Clinical raw data has additional restrictions on international transfer** — but Clerk only stores *authentication identity* (email, name, password hash), not clinical data. Your transcripts and SOAP notes stay in your Flask backend / your Mac Mini, where they're already classified as the data controller's responsibility.
- Clerk has a published DPA and SOC 2 Type II. Both will be required by hospitals when you sell into systems beyond UPA Bento Gonçalves.

## Decision matrix

| Concern | Custom JWT (today) | Clerk |
|---------|-------------------|-------|
| Solo developer time savings | — | ★★★★★ |
| Email verification / password reset | manual — not built yet | built-in |
| MFA / 2FA | not built; requires TOTP library + endpoint + UI | toggle on in Clerk dashboard |
| Account lockout | not built | toggle on |
| LGPD-ready audit | partial (your `audit.db`) | full (Clerk's audit log) |
| Brazilian SaaS legal posture | need DPA + privacy policy you wrote | Clerk DPA + Brazil-EU adequacy |
| Free tier cost | $0 (your hosting) | $0 (Clerk free <50K MAU) |
| Lock-in risk | none — your code | medium — JWT can be migrated later if needed |
| Time-to-launch for Web Store | now (v2.6.x) | +2-3 sessions for v3.0 migration |
| Long-term maintenance | you own all incidents | Clerk on-call |

## Recommended sequencing (revised)

The original `docs/ROADMAP-v2.6-to-v2.9.md` had Web Store submission at task **2.6.9** with custom auth. Revising to interpose a v3.0 SaaS-foundation milestone *before* the public launch:

```
✅ v2.6.0  Production-ready security    (shipped 2026-05-01, e3f22d3 + e7805bb)
✅ v2.6.1  SW auto-refresh-on-401       (shipped 2026-05-01, b44b7cb)
   v2.6.2  Live-shift smoke + Mac Mini  (manual: env-var flip + smoke test)
   v2.7.x  Productivity wins            (still useful for solo + future paid users)
   v2.8.x  Performance wins             (still useful for both)
   ─────────────── strategic pivot ───────────────
   v3.0.0  Clerk migration              (auth refactor — drop custom auth)
   v3.0.1  Clerk-issued JWT in Flask    (verify against JWKS)
   v3.0.2  popup.js → @clerk/chrome-extension SignIn
   v3.0.3  Drop SW _authedFetch + _refreshAccessToken
   v3.0.4  Stripe ↔ Clerk user-ID linkage (webhook on user.created)
   v3.0.5  Privacy policy revision (Clerk listed as sub-processor)
   v3.0.6  Live-shift smoke with Clerk
   v3.0.7  Web Store screenshots + listing copy with auth flow
   v3.0.8  Submit to Chrome Web Store
   ─────────────── then growth ───────────────
   v3.1.x  Clerk Billing (optional, decide based on subscriber count)
   v3.2.x  B2B / clinic accounts via Clerk Organizations
   v3.3.x  Multi-EMR support
```

## Effort estimate for v3.0 (auth-only migration)

| Task | File | Effort |
|------|------|--------|
| Set up Clerk app + Chrome extension SDK | Clerk dashboard | 30 min |
| Replace `auth.py` decorators with JWKS verify | `Pediatrics/emr_automation/auth.py` | 1-2 h |
| Delete `routes_auth.py`, route Flask `/auth/*` returns 404 | `Pediatrics/emr_automation/dashboard/routes_auth.py` | 15 min |
| Add `/clerk/webhook` endpoint for `user.created`, `user.deleted` | new `routes_clerk.py` | 1-2 h |
| Migrate `popup.js` from custom form to `<SignIn />` | `tocafichadr-extension/popup/` | 2-3 h |
| Drop SW `_authedFetch` and `_refreshAccessToken`, route through Clerk SDK | `background/service-worker.js` | 1 h |
| Migrate `models.py User` to use `clerk_user_id` (drop `password_hash`) | + alembic migration | 1-2 h |
| Update `chrome.storage` schema (drop `authToken`, `refreshToken`, `authUser`) | `popup.js`, `service-worker.js` | 30 min |
| Test JWKS verification end-to-end with a deliberately-expired token | new `scripts/test-clerk-verify.js` | 1 h |
| Update CHANGELOG, ROADMAP, README, privacy policy | docs | 1 h |
| **Total** | | **9-13 h (1-2 sessions)** |

Compare with continuing custom auth indefinitely: ~40-80 h to add MFA + email verification + password reset + account lockout + audit log to LGPD standard. Plus ongoing maintenance.

## What this means for v2.7-v2.9 work

The productivity (v2.7), performance (v2.8), and operational (v2.9) milestones from the original roadmap are still valid — they touch the EMR automation layer, not auth. They can ship before *or* after v3.0; they're orthogonal.

But: don't ship `2.6.7-2.6.9` (live-shift smoke + screenshots + Web Store submit) on custom auth if a Clerk migration is going to land soon. Submitting to the Web Store with custom auth then re-submitting after the Clerk migration means two review cycles (1-3 days each) for no user-visible improvement.

The decision tree:

```
Want users in the Web Store within 1 week?
├── YES — submit on custom auth (v2.6.x), migrate later (v3.x)
│         Risk: re-review when v3.0 ships, possible store-listing UX confusion
└── NO  — pivot now to v3.0 (Clerk), submit ~2 sessions later
          Reward: launch with the clean auth story you'll need anyway
```

Given you're not yet running ads / paid acquisition, and the existing extension is functional for the solo doctor (you), the patient path (v3.0 first) is safer.

## Open questions for the next planning session

1. **Clerk plan**: free tier or pro? At your stage, free is fine. Decide before integration.
2. **User schema**: keep `User` table or move *all* user state into Clerk's `publicMetadata`? Recommend keep the table for `plan`, `trial_ends_at`, `stripe_customer_id` — Clerk metadata isn't a substitute for an indexed relational store.
3. **Migration of existing JWT users**: you have 1 (yourself). Just sign up in Clerk; delete the old `users` row.
4. **Stripe integration**: keep the existing Checkout flow? Yes for v3.0 — link `clerk_user_id` to existing `stripe_customer_id` via webhook.
5. **Privacy policy revision**: list Clerk as a data sub-processor; mention LGPD-EU adequacy in the cross-border transfer section. Bilingual (PT-BR + EN) once selling outside UPA Bento Gonçalves.

---

Sources for facts in this memo:
- [Clerk Chrome Extension SDK overview](https://clerk.com/docs/reference/chrome-extension/overview)
- [Clerk `createClerkClient()` SDK Reference (Chrome Extension)](https://clerk.com/docs/reference/chrome-extension/create-clerk-client)
- [Clerk pricing — 50K free MAU as of 2026](https://clerk.com/pricing)
- [Clerk Billing overview (built on Stripe, 0.7% fee)](https://clerk.com/billing)
- [Clerk + Stripe — instant zero-integration SaaS billing](https://stripe.com/sessions/2025/instant-zero-integration-saas-billing-with-clerk-stripe)
- [Brazil LGPD — health data classified as sensitive personal data](https://complydog.com/blog/brazil-lgpd-complete-data-protection-compliance-guide-saas)
- [Brazil + EU mutual adequacy decision adopted Jan 26, 2026](https://practiceguides.chambers.com/practice-guides/data-protection-privacy-2026/brazil)
