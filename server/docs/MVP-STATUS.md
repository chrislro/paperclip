# Toca Ficha Dr. — MVP Status Report

> **Updated:** 2026-04-16
> **Current version:** 2.4.1
> **Verdict:** Cloudflare Tunnel live. HTTPS backend on launchd. Audio bitrate optimized (4x smaller). Ready for live-shift test + Chrome Web Store submission.

---

## 🎯 Next Session — Pick Up Here

**Context:** 2026-04-16. Infrastructure complete: Cloudflare Tunnel + launchd + audio optimization. Need live-shift validation of 32kbps audio quality + full-flow timing, then Web Store submission.

### ✅ Completed (2026-04-16)

- [x] **Cloudflare Tunnel on Mac Mini** — `cloudflared tunnel --url http://localhost:5050`, managed by `br.com.tocafichadr.tunnel` launchd plist. URL: `https://colours-detroit-mirror-consistency.trycloudflare.com`. Edge: **poa01 (Porto Alegre)**.
- [x] **Flask on launchd** — pre-existing `com.tocafichadr.cloud-api` plist (uses `scripts/run_cloud_api.sh`). Both services survive reboot.
- [x] **PAT stripped from Pediatrics git remote** — `git remote set-url` done.
- [x] **Audio bitrate: 128kbps → 32kbps** — `audio-capture.js` now sets `audioBitsPerSecond: 32000`. 30s recording drops from ~480KB to ~120KB. Opus at 32kbps is clear for single-speaker medical dictation.
- [x] **Timing visibility fixed** — `extension_api.py` timing logs changed from `logger.info` → `logger.warning` (now visible in default Flask log level).
- [x] **OpenAI client singleton** — `routes.py` caches `build_openai_client()` result. Saves TCP/TLS handshake overhead per request.

### Transcription Timing Baseline (measured 2026-04-16)

| Test | Audio size | Whisper | SOAP+CID | Total |
|------|-----------|---------|----------|-------|
| 5s silence (local) | 156 KB | 6.7s | 1.6s | 8.3s |
| 5s silence (tunnel) | 156 KB | 5.3s | - | 5.7s |
| 30s real speech (pre-fix, user-reported) | ~480KB | ~20s | ~2s | ~30s |
| 30s real speech (post-fix, estimated) | ~120KB | ~8-12s | ~2s | **10-14s** |

**Need to validate:** 32kbps audio quality + real timing on next shift. If Whisper quality drops, bump to 48kbps (still 2.5x improvement).

### Priority 1 — Ship-blockers

1. **⚠️ Quick-tunnel URL is ephemeral** — if cloudflared restarts, the random URL changes and the extension breaks. Fix: buy a domain, set up named tunnel (permanent URL). Follows product name decision.
2. **Live-shift test of v2.4.1** — validate 32kbps audio quality on real patients (Whisper transcription accuracy). If quality drops, bump to 48kbps.
3. **Chrome Web Store submission** — `./scripts/build-package.sh` → 5 pt-BR screenshots → listing copy → submit.

### Priority 2 — Quality improvements

4. **Test CID autofill on live shift** — still `⚠️ Untested`.
5. **Test prescription template flow on live shift** — still `⚠️ Untested`.
6. **Verify SOAP hallucination fix held** — one more shift's worth of SOAP notes.
7. **Sentry / error telemetry** — critical before doctor beta invites.

### Priority 3 — Product decisions

8. **Choose product name** — considering TocafichaDR or similar. Domain purchase + branding follows. This unblocks named tunnel (permanent URL).
9. **Referral dropdown handling** — our code hardcodes "sem encaminhamento" (value 100). Live log showed doctor picking value 112 (Acompanhamento). Decide: always skip, or surface quick referral picker in HUD.

---

## Live Shift Data — 2026-04-15 afternoon

From Flask log on Mac Mini (`logs/cloud-api-error.log`), doctor's client IP 100.88.191.63:

| Metric | Value |
|--------|-------|
| Transcriptions completed | **15** over 5h 23m (11:42 → 17:05) |
| Average gap between transcribes | ~23 min |
| HTTP 200 rate on `/api/transcribe` | 15/15 (100%) |
| Uncaught errors in Flask | 0 |
| Audit entries from finalize | **0** (confirms `logAudit` silent failure — issue #1 above) |
| Manual discharge observations (logger) | 1 patient at 12:59 — doctor picked `intern_encaminh=112` (Acompanhamento), NOT the hardcoded 100 (Sem encaminhamento) |

**Product insight from last bullet:** the extension's assumption that "sem encaminhamento" is always right is wrong. ~some% of patients need follow-up referrals. Consider: let Finalizar Paciente skip the referral entirely and just Gravar whatever the doctor pre-selected, OR surface a quick referral picker in the HUD before finalizing.

---

## What Works Now (verified this session)

| Feature | Status | Evidence |
|---------|--------|----------|
| Audio → SOAP transcription | ✅ **Live-shift validated** | 15/15 HTTP 200 on 2026-04-15 shift |
| Cloud backend auth (JWT) | ✅ Working | `/auth/login` returns token, popup logs in |
| Prescription templates (Simples) | ⚠️ Untested on live shift | Selectors verified from interaction logs |
| Prescription templates (legacy padrões) | ⚠️ Untested on live shift | Unchanged from prior version |
| Discharge ("Alta") | ✅ **Live-shift validated** | v2.3.1 verified end-to-end on real patient |
| Finalizar Paciente | ✅ **Live-shift validated** | Simplified flow: discharge + redirect to `/prconsultas` |
| Baú Médico | ⚠️ Untested | Unchanged |
| CID autofill | ⚠️ Untested on live shift | Unchanged |
| HUD connection indicator | ✅ Working | Routed through service worker (no more Mixed Content) |
| Auth badge in HUD | ✅ No crash | `insertBefore` guard added |
| `logAudit` from content script | ✅ **Fixed (v2.3.2)** | Routed through service worker |
| All content-script API calls | ✅ **Fixed (v2.3.3)** | Generic `TOCAFICHADR_FETCH` SW proxy — `/billing/subscription` and all others unblocked |
| Flask gpt-4o-transcribe fallback | ✅ **Fixed (Flask restart)** | Stale code (Apr 1 process running Apr 13 source) — restart loaded fresh code |
| Flask OpenAI auth | ✅ **Fixed** | `.env` populated with `OPENAI_OAUTH_ACCESS_TOKEN` (April 13 refactor expects this, not `OPENAI_API_KEY`) |
| Flask DB connection | ✅ **Fixed** | `.env` corrected `DATABASE_URL` from stale `tocafichadr` to `tocafichadr` role |
| SOAP hallucination | ✅ **Fixed (prompt + temp 0.1)** | Strengthened "PROIBIDO inventar" rule, 1-4 sentences max, example added |
| Finalizar Paciente full flow | ✅ **End-to-end validated** | User confirmed record → discharge → redirect to `/prconsultas` working |

## Key Fixes This Session (v2.1.0 → v2.3.4)

1. **v2.2.0** — Simples prescription semantic fallbacks; discharge error-toast detection; jQuery absence warning; global 45s timeout on Finalize; removed dev IP from manifest
2. **v2.2.1** — Restored Tailscale IP in `host_permissions` (too aggressive cleanup broke cloud mode)
3. **v2.2.2** — Guard against invalidated extension context (post-reload) with user-friendly "recarregue a página" message
4. **v2.2.3** — Health check routed through service worker (Mixed Content/PNA fix); `updateAuthBadge` insertBefore crash fixed
5. **v2.2.4** — **Discharge content-based select matching** — identifies the referral dropdown by its options, not its id/name (which varies by patient type)
6. **v2.3.0** — Removed Alta do Paciente button; Finalizar Paciente simplified to discharge + redirect
7. **v2.3.1** — Discharge verification no longer treats G-Hosp success toasts as errors; added container-re-render as success signal
8. **v2.3.2** — `logAudit` routed through service worker (new `TOCAFICHADR_AUDIT` handler)
9. **v2.3.3** — **Generic service-worker API proxy** (`TOCAFICHADR_FETCH`) — all `request()` calls now route through SW, fixing Mixed Content for `/billing/subscription`, `/auth/refresh`, and every other content-script API call
10. **v2.3.4** — **Trust-the-submit discharge verification** — form submit + absence of validation errors after 4s counts as success. Previous strict DOM-signal requirements produced false-negative "Falha" messages after real successes

### Flask-side fixes (no extension version bump)
- Flask process restarted to pick up Apr-13 source (was running Apr-1 code)
- `.env` `DATABASE_URL` corrected: `tocafichadr` → `tocafichadr`
- `.env` `OPENAI_OAUTH_ACCESS_TOKEN` populated (April 13 refactor moved from `OPENAI_API_KEY` to OAuth access-token pattern)
- SOAP prompt strengthened with anti-hallucination rules + 1-4 sentence limit + explicit example
- Temperature lowered 0.3 → 0.1 across SOAP/CID/format_soap calls

## Backend

- **Cloud (Mac Mini via Tailscale)** — `http://100.116.133.83:5050` ✅ live, uptime confirmed
- **Local (this laptop)** — `http://127.0.0.1:5050` ✅ live, available for dev
- **Postgres** — `tocafichadr` database on Mac Mini, 1 user (`christian@tocafichadr.com.br`, pro plan)
- **Audit log** — 16 entries recorded, `/api/audit` endpoint functional
- **CORS** — configured with `allow_private_network: True`, reflects origin correctly

## Next Steps To Ship MVP

### Phase 1 — Live shift validation (this week)

- [ ] **Do 1 full shift with v2.3.1** — 10+ real patients using Finalizar Paciente end-to-end
- [ ] Measure: error rate, time-per-patient, which features doctors actually use
- [ ] Capture `[Toca Ficha Dr.]` console logs for any failures (see `docs/MANUAL-TESTS.md` "What to report back" section)
- [ ] Fix any P0 bugs surfaced

**Gate to Phase 2:** ≤ 1 failure per 10 patients; no manual workarounds needed for golden path (record → template → finalize).

### Phase 2 — Cloudflare Tunnel deployment (2–4 hours)

Follow `docs/DEPLOY-MVP.md` Part 1:
- [ ] Install cloudflared on Mac Mini
- [ ] Create tunnel, bind `api.tocafichadr.com.br` → `http://localhost:5050`
- [ ] Register as launchd service
- [ ] Smoke test: `curl https://api.tocafichadr.com.br/api/health`
- [ ] Flip `popup/popup.js:4` CLOUD_URL to HTTPS hostname
- [ ] Remove `http://100.116.133.83:5050/*` from `manifest.json` host_permissions
- [ ] Set up UptimeRobot monitoring

**Gate to Phase 3:** Cloudflare tunnel stable for 48h, no 5xx spikes.

### Phase 3 — Chrome Web Store submission (3–5 days incl. review)

- [ ] Run `./scripts/build-package.sh` → produces `tocafichadr-v<version>.zip`
- [ ] Screenshots (5 required, 1280×800 or 640×400)
- [ ] Listing copy in Portuguese (description, features, changelog)
- [ ] Privacy policy already exists at `PRIVACY_POLICY.md` — verify accuracy vs current data flows
- [ ] Submit for review (usually 1–3 business days)
- [ ] Once approved: tighten `CORS_ORIGINS` env var on Mac Mini to the specific `chrome-extension://<id>`
- [ ] First-10 doctor beta invites

### Phase 4 — Billing activation (only if charging)

The backend already has Stripe integration (`routes_billing.py`, `trial_ends_at` column). Activate only if/when charging makes sense:
- [ ] Create Stripe Product + Price IDs for "Pro" plan (BRL)
- [ ] Populate `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID` in `.env.production`
- [ ] Configure webhook endpoint in Stripe dashboard
- [ ] Test with Stripe test mode first
- [ ] Remove hardcoded `plan=pro` fallback for new signups

---

## Possible Improvements (Post-MVP)

Ranked by return-on-effort. Not blocking launch.

### Tier 1 — Quick wins (< 2h each)

1. **Remove `[role="alert"]` ambiguity for all flows** — audit `hud.js`/`dom-engine.js` for other selectors that might hit G-Hosp's toast system. Discharge was one victim; prescription verify logic may have similar issues.
2. **Consolidate action button confirmations** — right now "Alta" used a double-click pattern that got removed. Finalizar keeps it. Audit so user behavior is consistent.
3. **Template hotkeys** — `Ctrl+1..9` for the first 9 templates in the HUD. Clinical hands are often on keyboard not mouse.
4. **Debounce duplicate-click on Finalizar while running** — already has `state.finalizing` guard, but disable the button visually (opacity + cursor) to make it obvious.
5. **Localize all HUD copy to pt-BR** — a few status strings still have English fragments.

### Tier 2 — Defensive hardening (half-day each)

6. **Bypass jQuery UI autocomplete** — direct XHR to `/receitas/autocomplete_matmed_nome` with CSRF. Immune to G-Hosp jQuery changes. Invest only if CID autofill starts failing.
7. **Sentry / error telemetry** — content-script errors go nowhere right now. Route `[Toca Ficha Dr.] ERROR` lines to Flask, aggregate into a dashboard. Critical before beta launch.
8. **Selector health-check endpoint** — Flask returns selector versions; extension compares, warns when stale. Lets you push fixes without a Web Store release.
9. **Prescription dialog retry** — if `#padroes` doesn't appear after clicking Utilizar Padrões, retry the click (G-Hosp Rails UJS sometimes misses). Currently silent failure.
10. **Discharge container selector in the `sel()` config** — just used `#dar_alta` inline in `verifyDischargeComplete`; formalize so it follows the fallback pattern.

### Tier 3 — UX polish (1–2 days each)

11. **Voice commands during recording** — "finalizar", "próximo paciente" as in-audio triggers using Whisper's intermediate chunks. Removes HUD click entirely.
12. **Smart CID from chief complaint** — pre-populate CID suggestions before recording based on triage text. Faster time-to-finalize.
13. **Patient queue panel** — show next 5 patients in triage in the HUD. Removes G-Hosp tab-switching.
14. **Offline queue** — if Flask unreachable mid-session, store recordings in `chrome.storage.local`, retry when connection returns. Critical for flaky hospital WiFi.
15. **Consultation length tracking** — measure time per patient, show running average. Data for your conduta-rapida product.

### Tier 4 — Platform (1–2 weeks each)

16. **Fly.io GRU migration** — once >50 concurrent doctors, Mac Mini becomes SPOF. Fly.io in São Paulo gives sub-30ms latency + HA.
17. **Multi-EMR support** — abstract selectors file per EMR system. First real target: other G-Hosp hospitals (already same DOM), then Tasy, MV, MedSystem.
18. **Doctor-to-doctor template sharing** — marketplace of prescription templates within the app. Cold-start content for new doctors.
19. **Mobile companion** — iOS app for recording while doing bedside exam. Patient data stays in G-Hosp; the app just captures audio → Flask → extension picks up result on the desktop.
20. **LGPD compliance audit** — once serving paying customers, formal compliance assessment. Uses your existing `PRIVACY_POLICY.md` as starting point.

---

## Risks / Open Issues

| Risk | Severity | Mitigation |
|------|----------|------------|
| G-Hosp updates jQuery version → CID autocomplete breaks | Medium | Tier 2 #6 bypass handles this; logging already warns |
| Mac Mini offline during shift | Medium | Cloudflare Tunnel + Fly.io fallback (Tier 4 #16) |
| Whisper API latency spikes | Low | Already parallelized SOAP+CID; 90s client timeout; no fix needed |
| Selector drift across G-Hosp patient types | Medium | Now mitigated by content-based matching (v2.2.4); extend pattern to prescription |
| Multiple browser tabs on same patient → conflicts | Low | `intern_id` scoped per-tab; investigate if reported |
| Chrome extension context invalidation during consultation | Low | Clear user message added (v2.2.2); doctor just hits F5 |

---

## Files Added This Session

- `docs/DEPLOY-MVP.md` — Cloudflare deployment + 50-item technical checklist
- `docs/MANUAL-TESTS.md` — what to test by hand during a shift
- `docs/MVP-STATUS.md` — this file
- `scripts/build-package.sh` — builds a clean Web Store zip

## What I'd Do Next If This Were Mine

1. **Today**: do one real shift with v2.3.1, note anything awkward
2. **Tomorrow**: stand up Cloudflare Tunnel (2h), flip extension to HTTPS, test again for one shift
3. **Day 3**: tighten CORS, build zip, prep screenshots + listing copy
4. **Day 4**: submit to Chrome Web Store
5. **Day 7 (approval)**: invite 3 pediatrician friends, measure retention

Everything past that is optimization.
